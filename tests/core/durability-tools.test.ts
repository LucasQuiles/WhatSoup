import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { Database } from '../../src/core/database.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';
import { ToolRegistry } from '../../src/mcp/registry.ts';
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
    const row = db.raw.prepare('SELECT * FROM tool_calls WHERE id = ?').get(id) as any;
    expect(row.conversation_key).toBe('conv-1');
    expect(row.tool_name).toBe('send_message');
    expect(row.tool_input).toBe('{"text":"hi"}');
    expect(row.status).toBe('pending');
    expect(row.replay_policy).toBe('unsafe');
    expect(row.session_checkpoint_id).toBeNull();
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
    engine.markToolComplete(id, '{"sent":true}');
    const row = db.raw.prepare('SELECT * FROM tool_calls WHERE id = ?').get(id) as any;
    expect(row.status).toBe('complete');
    expect(row.result).toBe('{"sent":true}');
    expect(row.completed_at).not.toBeNull();
    expect(row.outbound_op_id).toBeNull();
  });

  it('markToolComplete stores optional outboundOpId', () => {
    const id = engine.recordToolCall('conv-1', 'send_message', '{}', 'unsafe');
    engine.markToolExecuting(id);
    engine.markToolComplete(id, 'ok', 99);
    const row = db.raw.prepare('SELECT outbound_op_id FROM tool_calls WHERE id = ?').get(id) as any;
    expect(row.outbound_op_id).toBe(99);
  });

  it('records multiple tool calls independently', () => {
    const id1 = engine.recordToolCall('conv-1', 'tool_a', '{}', 'safe');
    const id2 = engine.recordToolCall('conv-1', 'tool_b', '{}', 'read_only');
    expect(id1).not.toBe(id2);
    engine.markToolComplete(id1, 'result-a');
    const row1 = db.raw.prepare('SELECT status FROM tool_calls WHERE id = ?').get(id1) as any;
    const row2 = db.raw.prepare('SELECT status FROM tool_calls WHERE id = ?').get(id2) as any;
    expect(row1.status).toBe('complete');
    expect(row2.status).toBe('pending');
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

  it('records tool call as complete even when handler throws', async () => {
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
    expect(row.status).toBe('complete');
    expect(row.result).toContain('boom');
  });

  it('does not record tool call when session has no conversationKey', async () => {
    registry.register(makeTool({
      name: 'global_tool',
      scope: 'global',
      schema: z.object({ message: z.string() }),
      handler: async () => 'ok',
    }));

    const session: SessionContext = { tier: 'global' }; // no conversationKey
    await registry.call('global_tool', { message: 'hi' }, session);

    const rows = db.raw.prepare(`SELECT * FROM tool_calls`).all() as any[];
    expect(rows).toHaveLength(0);
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
