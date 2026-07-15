import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { Database } from '../../src/core/database.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';
import { ToolRegistry } from '../../src/mcp/registry.ts';
import { errorResult } from '../../src/mcp/types.ts';
import type { ToolDeclaration, SessionContext } from '../../src/mcp/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

function makeSession(overrides: Partial<SessionContext> = {}): SessionContext {
  return { tier: 'global', conversationKey: 'conv-test-1', ...overrides };
}

function chatSession(conversationKey: string, deliveryJid: string): SessionContext {
  return { tier: 'chat-scoped', conversationKey, deliveryJid };
}

function makeTool(overrides: Partial<ToolDeclaration> = {}): ToolDeclaration {
  return {
    name: 'test_tool',
    description: 'A test tool',
    schema: z.object({ message: z.string() }),
    scope: 'chat',
    targetMode: 'caller-supplied',
    handler: async (params) => ({ echo: params['message'] }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// DurabilityEngine — tool call methods
// ---------------------------------------------------------------------------

describe('DurabilityEngine tool_calls', () => {
  let db: Database;
  let engine: DurabilityEngine;

  beforeEach(() => {
    db = makeDb();
    engine = new DurabilityEngine(db);
  });

  afterEach(() => { db.close(); });

  it('recordToolCall inserts a pending row and returns an id', () => {
    const id = engine.recordToolCall('conv-1', 'send_message', '{"text":"hi"}', 'unsafe');
    expect(id).toBeGreaterThan(0);
    const row = db.raw.prepare(
      `SELECT conversation_key,
              tool_name,
              tool_input,
              status,
              replay_policy,
              typeof(session_checkpoint_id) AS session_checkpoint_id_type
         FROM tool_calls
        WHERE id = ?`,
    ).get(id) as any;
    expect(row).toEqual({
      conversation_key: 'conv-1',
      tool_name: 'send_message',
      tool_input: '{"text":"hi"}',
      status: 'pending',
      replay_policy: 'unsafe',
      session_checkpoint_id_type: 'null',
    });
  });

  it('recordToolCall stores an optional checkpointId', () => {
    const id = engine.recordToolCall('conv-1', 'get_info', '{}', 'read_only', 42);
    const row = db.raw.prepare('SELECT session_checkpoint_id FROM tool_calls WHERE id = ?').get(id) as any;
    expect(row.session_checkpoint_id).toBe(42);
  });

  it('markToolExecuting transitions pending → executing', () => {
    const id = engine.recordToolCall('conv-1', 'send_message', '{}', 'unsafe');
    engine.markToolExecuting(id);
    const row = db.raw.prepare('SELECT status FROM tool_calls WHERE id = ?').get(id) as any;
    expect(row.status).toBe('executing');
  });

  it('markToolComplete transitions to complete with result and timestamp', () => {
    const id = engine.recordToolCall('conv-1', 'send_message', '{}', 'unsafe');
    engine.markToolExecuting(id);
    const startedAt = db.raw.prepare(`SELECT unixepoch('now') AS value`).get() as { value: number };
    engine.markToolComplete(id, '{"sent":true}', false);
    const finishedAt = db.raw.prepare(`SELECT unixepoch('now') AS value`).get() as { value: number };
    const row = db.raw.prepare(
      `SELECT status,
              result,
              typeof(completed_at) AS completed_at_type,
              strftime('%Y-%m-%d %H:%M:%S', completed_at) = completed_at AS completed_at_has_sql_format,
              unixepoch(completed_at) BETWEEN ? AND ? AS completed_at_recorded_during_call,
              typeof(outbound_op_id) AS outbound_op_id_type
         FROM tool_calls
        WHERE id = ?`,
    ).get(startedAt.value, finishedAt.value, id) as any;
    expect(row).toEqual({
      status: 'complete',
      result: '{"sent":true}',
      completed_at_type: 'text',
      completed_at_has_sql_format: 1,
      completed_at_recorded_during_call: 1,
      outbound_op_id_type: 'null',
    });
  });

  it('markToolComplete stores optional outboundOpId', () => {
    const id = engine.recordToolCall('conv-1', 'send_message', '{}', 'unsafe');
    engine.markToolExecuting(id);
    engine.markToolComplete(id, 'ok', false, 99);
    const row = db.raw.prepare('SELECT outbound_op_id FROM tool_calls WHERE id = ?').get(id) as any;
    expect(row.outbound_op_id).toBe(99);
  });

  it('records multiple tool calls independently', () => {
    const id1 = engine.recordToolCall('conv-1', 'tool_a', '{}', 'safe');
    const id2 = engine.recordToolCall('conv-1', 'tool_b', '{}', 'read_only');
    expect(id1).not.toBe(id2);
    engine.markToolComplete(id1, 'result-a', false);
    const row1 = db.raw.prepare('SELECT status FROM tool_calls WHERE id = ?').get(id1) as any;
    const row2 = db.raw.prepare('SELECT status FROM tool_calls WHERE id = ?').get(id2) as any;
    expect(row1.status).toBe('complete');
    expect(row2.status).toBe('pending');
  });

  // #1787: a failed tool call must persist a distinct terminal status, not
  // 'complete' — otherwise a status-only failure metric reads 0% forever.
  it('markToolComplete persists status=error when isError is true', () => {
    const id = engine.recordToolCall('conv-1', 'send_message', '{}', 'unsafe');
    engine.markToolExecuting(id);
    engine.markToolComplete(id, 'error: boom', true);
    const row = db.raw.prepare('SELECT status, result FROM tool_calls WHERE id = ?').get(id) as any;
    expect(row.status).toBe('error');
    expect(row.result).toBe('error: boom');
  });

  // #1787 recovery-neutrality: getRecoverableToolCalls only ever selects
  // 'executing'/'pending' — a terminal 'error' row must never be re-selected
  // for replay, exactly like an existing 'complete' row.
  it('a tool call marked error is not re-selected by getRecoverableToolCalls', () => {
    const id = engine.recordToolCall('conv-1', 'send_message', '{}', 'safe');
    engine.markToolExecuting(id);
    engine.markToolComplete(id, 'error: boom', true);
    const recoverable = db.raw
      .prepare(`SELECT id FROM tool_calls WHERE status IN ('executing', 'pending')`)
      .all() as Array<{ id: number }>;
    expect(recoverable.find((r) => r.id === id)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ToolRegistry — durability integration
// ---------------------------------------------------------------------------

describe('ToolRegistry durability integration', () => {
  let db: Database;
  let engine: DurabilityEngine;
  let registry: ToolRegistry;

  beforeEach(() => {
    db = makeDb();
    engine = new DurabilityEngine(db);
    registry = new ToolRegistry();
    registry.setDurability(engine);
  });

  afterEach(() => { db.close(); });

  it('records a tool call in tool_calls when durability is set and session has conversationKey', async () => {
    registry.register(makeTool({
      name: 'echo_tool',
      schema: z.object({ message: z.string() }),
      handler: async (params) => `echo: ${params['message']}`,
    }));

    const session = makeSession({ conversationKey: 'conv-1' });
    const result = await registry.call('echo_tool', { message: 'hello' }, session);

    expect(result.isError).toBeUndefined();
    const rows = db.raw.prepare(
      `SELECT * FROM tool_calls WHERE conversation_key = 'conv-1' AND tool_name = 'echo_tool'`,
    ).all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('complete');
    expect(rows[0].result).toContain('echo: hello');
    expect(rows[0].replay_policy).toBe('unsafe');
  });

  it('uses replayPolicy from tool declaration', async () => {
    registry.register(makeTool({
      name: 'safe_tool',
      replayPolicy: 'safe',
      schema: z.object({ message: z.string() }),
      handler: async () => 'ok',
    }));

    await registry.call('safe_tool', { message: 'test' }, makeSession({ conversationKey: 'conv-2' }));

    const row = db.raw.prepare(
      `SELECT replay_policy FROM tool_calls WHERE conversation_key = 'conv-2' AND tool_name = 'safe_tool'`,
    ).get() as any;
    expect(row.replay_policy).toBe('safe');
  });

  // #1787: previously persisted status='complete' even though the handler
  // threw — a failed tool call must be distinguishable from a successful one.
  it('records tool call as error (not complete) when handler throws', async () => {
    registry.register(makeTool({
      name: 'failing_tool',
      schema: z.object({}),
      handler: async () => { throw new Error('boom'); },
    }));

    const result = await registry.call('failing_tool', {}, makeSession({ conversationKey: 'conv-3' }));

    expect(result.isError).toBe(true);
    const row = db.raw.prepare(
      `SELECT status, result FROM tool_calls WHERE conversation_key = 'conv-3' AND tool_name = 'failing_tool'`,
    ).get() as any;
    expect(row.status).toBe('error');
    expect(row.result).toContain('boom');
  });

  // #1787: the success path can still fail "softly" — the handler resolves
  // normally but returns an isError-tagged payload (errorResult/toolError).
  // isToolErrorPayload's computed `isError` must drive the persisted status
  // the same way a thrown error does.
  it('records tool call as error when handler resolves with an isError payload', async () => {
    registry.register(makeTool({
      name: 'soft_failing_tool',
      schema: z.object({}),
      handler: async () => errorResult('nope, denied by policy'),
    }));

    const result = await registry.call('soft_failing_tool', {}, makeSession({ conversationKey: 'conv-6' }));

    expect(result.isError).toBe(true);
    const row = db.raw.prepare(
      `SELECT status, result FROM tool_calls WHERE conversation_key = 'conv-6' AND tool_name = 'soft_failing_tool'`,
    ).get() as any;
    expect(row.status).toBe('error');
    expect(row.result).toContain('nope, denied by policy');
  });

  // #1787: the deny path (R1 sensitive-tool gate) writes its own forensic
  // record via the same markToolComplete chokepoint — it must label 'error'
  // too, not just the main success/throw paths.
  it('records tool call as error on the sensitive-tool deny path', async () => {
    registry.register(makeTool({
      name: 'sensitive_tool',
      sensitive: true,
      schema: z.object({}),
      handler: async () => 'should never run',
    }));
    // No authorizer installed → sensitiveAllowed() fails closed, denying
    // every call regardless of actorJid.

    const result = await registry.call('sensitive_tool', {}, makeSession({ conversationKey: 'conv-7' }));

    expect(result.isError).toBe(true);
    const row = db.raw.prepare(
      `SELECT status, result FROM tool_calls WHERE conversation_key = 'conv-7' AND tool_name = 'sensitive_tool'`,
    ).get() as any;
    expect(row.status).toBe('error');
    expect(row.result).toContain('denied');
  });

  it('records tool call under the __global__ sentinel when a global-tier session has no conversationKey', async () => {
    registry.register(makeTool({
      name: 'global_tool',
      scope: 'global',
      schema: z.object({ message: z.string() }),
      handler: async () => 'ok',
    }));

    const session: SessionContext = { tier: 'global' }; // no conversationKey → sentinel
    await registry.call('global_tool', { message: 'hi' }, session);

    const rows = db.raw.prepare(`SELECT * FROM tool_calls`).all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].conversation_key).toBe('__global__');
    expect(rows[0].tool_name).toBe('global_tool');
    expect(rows[0].status).toBe('complete');
  });

  it('does not record tool call when durability is not set', async () => {
    const plainRegistry = new ToolRegistry(); // no durability
    plainRegistry.register(makeTool({
      name: 'plain_tool',
      schema: z.object({ message: z.string() }),
      handler: async () => 'ok',
    }));

    const result = await plainRegistry.call(
      'plain_tool',
      { message: 'hi' },
      makeSession({ conversationKey: 'conv-4' }),
    );

    expect(result.isError).toBeUndefined();
    // No DB to check — just verifying no error thrown
  });

  it('records tool call in chat-scoped session with conversationKey', async () => {
    registry.register(makeTool({
      name: 'chat_tool',
      scope: 'chat',
      targetMode: 'caller-supplied',
      schema: z.object({ message: z.string() }),
      handler: async () => 'sent',
    }));

    const session = chatSession('conv-chat-1', '18001234567@s.whatsapp.net');
    await registry.call('chat_tool', { message: 'hey' }, session);

    const row = db.raw.prepare(
      `SELECT conversation_key, status FROM tool_calls WHERE tool_name = 'chat_tool'`,
    ).get() as any;
    expect(row.conversation_key).toBe('conv-chat-1');
    expect(row.status).toBe('complete');
  });
});
