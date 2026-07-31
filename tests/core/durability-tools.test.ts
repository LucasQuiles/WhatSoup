import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { Database } from '../../src/core/database.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';
import {
  TOOL_INPUT_MARKER,
  TOOL_RESULT_MARKERS,
} from '../../src/core/durability-evidence-contract.ts';
import { ToolRegistry } from '../../src/mcp/registry.ts';
import { errorResult, makeConversationBinding, toolError } from '../../src/mcp/types.ts';
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

  it('recordToolCall inserts metadata-only pending evidence and returns an id', () => {
    const id = engine.recordToolCall('conv-1', 'send_message', 'messaging', 'unsafe');
    expect(id).toBeGreaterThan(0);
    const row = db.raw.prepare(
      `SELECT conversation_key,
              tool_name,
              tool_group,
              tool_input,
              status,
              outcome_code,
              evidence_coverage,
              replay_policy,
              typeof(session_checkpoint_id) AS session_checkpoint_id_type
         FROM tool_calls
        WHERE id = ?`,
    ).get(id) as any;
    expect(row).toEqual({
      conversation_key: 'conv-1',
      tool_name: 'send_message',
      tool_group: 'messaging',
      tool_input: TOOL_INPUT_MARKER,
      status: 'pending',
      outcome_code: 'not_terminal',
      evidence_coverage: 'complete',
      replay_policy: 'unsafe',
      session_checkpoint_id_type: 'null',
    });
  });

  it('recordToolCall stores an optional checkpointId', () => {
    const id = engine.recordToolCall('conv-1', 'get_info', 'other', 'read_only', 42);
    const row = db.raw.prepare('SELECT session_checkpoint_id FROM tool_calls WHERE id = ?').get(id) as any;
    expect(row.session_checkpoint_id).toBe(42);
  });

  it('markToolExecuting transitions pending → executing', () => {
    const id = engine.recordToolCall('conv-1', 'send_message', 'messaging', 'unsafe');
    engine.markToolExecuting(id);
    const row = db.raw.prepare(
      'SELECT status, outcome_code, tool_input, result FROM tool_calls WHERE id = ?',
    ).get(id) as any;
    expect(row).toEqual({
      status: 'executing',
      outcome_code: 'not_terminal',
      tool_input: TOOL_INPUT_MARKER,
      result: null,
    });
  });

  it('markToolComplete transitions to metadata-only success evidence', () => {
    const id = engine.recordToolCall('conv-1', 'send_message', 'messaging', 'unsafe');
    engine.markToolExecuting(id);
    const startedAt = db.raw.prepare(`SELECT unixepoch('now') AS value`).get() as { value: number };
    engine.markToolComplete(id, { isError: false, durationMs: 17 });
    const finishedAt = db.raw.prepare(`SELECT unixepoch('now') AS value`).get() as { value: number };
    const row = db.raw.prepare(
      `SELECT status,
              result,
              outcome_code,
              failure_code,
              duration_ms,
              typeof(completed_at) AS completed_at_type,
              strftime('%Y-%m-%d %H:%M:%S', completed_at) = completed_at AS completed_at_has_sql_format,
              unixepoch(completed_at) BETWEEN ? AND ? AS completed_at_recorded_during_call,
              typeof(outbound_op_id) AS outbound_op_id_type
         FROM tool_calls
        WHERE id = ?`,
    ).get(startedAt.value, finishedAt.value, id) as any;
    expect(row).toEqual({
      status: 'complete',
      result: TOOL_RESULT_MARKERS.success,
      outcome_code: 'success',
      failure_code: null,
      duration_ms: 17,
      completed_at_type: 'text',
      completed_at_has_sql_format: 1,
      completed_at_recorded_during_call: 1,
      outbound_op_id_type: 'null',
    });
  });

  it('markToolComplete stores optional outboundOpId', () => {
    const id = engine.recordToolCall('conv-1', 'send_message', 'messaging', 'unsafe');
    engine.markToolExecuting(id);
    engine.markToolComplete(id, { isError: false, durationMs: 1 }, 99);
    const row = db.raw.prepare('SELECT outbound_op_id FROM tool_calls WHERE id = ?').get(id) as any;
    expect(row.outbound_op_id).toBe(99);
  });

  it('records multiple tool calls independently', () => {
    const id1 = engine.recordToolCall('conv-1', 'tool_a', 'other', 'safe');
    const id2 = engine.recordToolCall('conv-1', 'tool_b', 'other', 'read_only');
    expect(id1).not.toBe(id2);
    engine.markToolComplete(id1, { isError: false, durationMs: 0 });
    const row1 = db.raw.prepare('SELECT status FROM tool_calls WHERE id = ?').get(id1) as any;
    const row2 = db.raw.prepare('SELECT status FROM tool_calls WHERE id = ?').get(id2) as any;
    expect(row1.status).toBe('complete');
    expect(row2.status).toBe('pending');
  });

  // #1787: a failed tool call must persist a distinct terminal status, not
  // 'complete' — otherwise a status-only failure metric reads 0% forever.
  it('markToolComplete persists bounded failure evidence when isError is true', () => {
    const id = engine.recordToolCall('conv-1', 'send_message', 'messaging', 'unsafe');
    engine.markToolExecuting(id);
    engine.markToolComplete(id, {
      isError: true,
      durationMs: 12,
      failure: {
        failureCode: 'handler_failed',
        failureStage: 'handler',
        retryDisposition: 'not_retryable',
        operatorAction: 'inspect',
        evidenceCoverage: 'complete',
      },
    });
    const row = db.raw.prepare(`
      SELECT status, result, outcome_code, failure_code, failure_stage,
             retry_disposition, operator_action, evidence_coverage, duration_ms
      FROM tool_calls WHERE id = ?
    `).get(id) as any;
    expect(row).toEqual({
      status: 'error',
      result: TOOL_RESULT_MARKERS.error,
      outcome_code: 'failure',
      failure_code: 'handler_failed',
      failure_stage: 'handler',
      retry_disposition: 'not_retryable',
      operator_action: 'inspect',
      evidence_coverage: 'complete',
      duration_ms: 12,
    });
  });

  // #1787 recovery-neutrality: getRecoverableToolCalls only ever selects
  // 'executing'/'pending' — a terminal 'error' row must never be re-selected
  // for replay, exactly like an existing 'complete' row.
  it('a tool call marked error is not re-selected by getRecoverableToolCalls', () => {
    const id = engine.recordToolCall('conv-1', 'send_message', 'messaging', 'safe');
    engine.markToolExecuting(id);
    engine.markToolComplete(id, {
      isError: true,
      durationMs: 1,
      failure: {
        failureCode: 'unknown',
        failureStage: 'unknown',
        retryDisposition: 'unknown',
        operatorAction: 'inspect',
        evidenceCoverage: 'partial',
      },
    });
    const recoverable = db.raw
      .prepare(`SELECT id FROM tool_calls WHERE status IN ('executing', 'pending')`)
      .all() as Array<{ id: number }>;
    expect(recoverable.find((r) => r.id === id)).toBeUndefined();
  });

  it('recovery replay and quarantine transitions keep the metadata-only contract', () => {
    const replayedId = engine.recordToolCall('conv-1', 'safe_tool', 'other', 'safe');
    const quarantinedId = engine.recordToolCall('conv-1', 'unsafe_tool', 'other', 'unsafe');

    engine.preConnectRecovery();

    const rows = db.raw.prepare(`
      SELECT id, status, result, outcome_code, failure_code, failure_stage,
             retry_disposition, operator_action
      FROM tool_calls ORDER BY id
    `).all() as Array<Record<string, unknown>>;
    expect(rows).toEqual([
      {
        id: replayedId,
        status: 'replayed',
        result: TOOL_RESULT_MARKERS.recovery,
        outcome_code: 'recovered_replayed',
        failure_code: null,
        failure_stage: null,
        retry_disposition: 'not_applicable',
        operator_action: 'none',
      },
      {
        id: quarantinedId,
        status: 'quarantined',
        result: TOOL_RESULT_MARKERS.recovery,
        outcome_code: 'recovery_quarantined',
        failure_code: 'unknown',
        failure_stage: 'recovery',
        retry_disposition: 'not_retryable',
        operator_action: 'inspect',
      },
    ]);
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
    expect(rows[0].tool_input).toBe(TOOL_INPUT_MARKER);
    expect(rows[0].result).toBe(TOOL_RESULT_MARKERS.success);
    expect(rows[0].outcome_code).toBe('success');
    expect(rows[0].replay_policy).toBe('unsafe');
    expect(JSON.stringify(rows[0])).not.toContain('hello');
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
  it('records bounded handler failure without persisting thrown prose', async () => {
    registry.register(makeTool({
      name: 'failing_tool',
      schema: z.object({}),
      handler: async () => { throw new Error('CANARY-THROWN-HANDLER-PROSE'); },
    }));

    const result = await registry.call('failing_tool', {}, makeSession({ conversationKey: 'conv-3' }));

    expect(result.isError).toBe(true);
    const row = db.raw.prepare(
      `SELECT status, result, failure_code, failure_stage, evidence_coverage
       FROM tool_calls
       WHERE conversation_key = 'conv-3' AND tool_name = 'failing_tool'`,
    ).get() as any;
    expect(row).toEqual({
      status: 'error',
      result: TOOL_RESULT_MARKERS.error,
      failure_code: 'handler_failed',
      failure_stage: 'handler',
      evidence_coverage: 'complete',
    });
    expect(JSON.stringify(row)).not.toContain('CANARY-THROWN-HANDLER-PROSE');
  });

  it('records validation rejection before handler admission without raw parameters', async () => {
    registry.register(makeTool({
      name: 'validated_tool',
      schema: z.object({ message: z.number() }),
    }));

    const result = await registry.call(
      'validated_tool',
      { message: 'CANARY-INVALID-PARAMETER' },
      makeSession({ conversationKey: 'conv-validation' }),
    );

    expect(result.isError).toBe(true);
    const row = db.raw.prepare(`
      SELECT status, tool_input, result, failure_code, failure_stage
      FROM tool_calls WHERE conversation_key = 'conv-validation'
    `).get() as Record<string, unknown>;
    expect(row).toEqual({
      status: 'error',
      tool_input: TOOL_INPUT_MARKER,
      result: TOOL_RESULT_MARKERS.error,
      failure_code: 'validation_rejected',
      failure_stage: 'validation',
    });
    expect(JSON.stringify(row)).not.toContain('CANARY-INVALID-PARAMETER');
  });

  it('records central authorization denial as bounded evidence', async () => {
    registry.setSensitiveToolAuthorizer(() => false);
    registry.register(makeTool({
      name: 'sensitive_tool',
      sensitive: true,
      schema: z.object({ message: z.string() }),
    }));

    const result = await registry.call(
      'sensitive_tool',
      { message: 'CANARY-DENIED-PARAMETER' },
      makeSession({ conversationKey: 'conv-denied', actorJid: 'actor@example.invalid' }),
    );

    expect(result.isError).toBe(true);
    const row = db.raw.prepare(`
      SELECT status, result, failure_code, failure_stage
      FROM tool_calls WHERE conversation_key = 'conv-denied'
    `).get() as Record<string, unknown>;
    expect(row).toEqual({
      status: 'error',
      result: TOOL_RESULT_MARKERS.error,
      failure_code: 'authorization_denied',
      failure_stage: 'authorization',
    });
  });

  it('records ordinary toolError results as returned_error', async () => {
    registry.register(makeTool({
      name: 'returned_error_tool',
      handler: async () => errorResult('CANARY-RETURNED-ERROR'),
    }));

    const result = await registry.call(
      'returned_error_tool',
      { message: 'input' },
      makeSession({ conversationKey: 'conv-returned' }),
    );

    expect(result.isError).toBe(true);
    const row = db.raw.prepare(`
      SELECT status, result, failure_code, failure_stage
      FROM tool_calls WHERE conversation_key = 'conv-returned'
    `).get() as Record<string, unknown>;
    expect(row).toEqual({
      status: 'error',
      result: TOOL_RESULT_MARKERS.error,
      failure_code: 'returned_error',
      failure_stage: 'handler',
    });
    expect(JSON.stringify(row)).not.toContain('CANARY-RETURNED-ERROR');
  });

  it('records hidden typed tool-error evidence without changing the returned payload', async () => {
    registry.register(makeTool({
      name: 'policy_error_tool',
      handler: async () => toolError(
        { error: 'CANARY-POLICY-ERROR' },
        {
          failureCode: 'policy_or_hook_blocked',
          failureStage: 'policy',
        },
      ),
    }));

    const result = await registry.call(
      'policy_error_tool',
      { message: 'input' },
      makeSession({ conversationKey: 'conv-policy-error' }),
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({ error: 'CANARY-POLICY-ERROR' });
    const row = db.raw.prepare(`
      SELECT failure_code, failure_stage, retry_disposition, operator_action
      FROM tool_calls WHERE conversation_key = 'conv-policy-error'
    `).get() as Record<string, unknown>;
    expect(row).toEqual({
      failure_code: 'policy_or_hook_blocked',
      failure_stage: 'policy',
      retry_disposition: 'not_retryable',
      operator_action: 'inspect',
    });
  });

  it('records scope denials as authorization evidence', async () => {
    registry.register(makeTool({
      name: 'global_scope_tool',
      scope: 'global',
    }));

    const result = await registry.call(
      'global_scope_tool',
      { message: 'input' },
      chatSession('conv-scope-denied', 'scope-denied@example.invalid'),
    );

    expect(result.isError).toBe(true);
    const row = db.raw.prepare(`
      SELECT failure_code, failure_stage, retry_disposition, operator_action
      FROM tool_calls WHERE conversation_key = 'conv-scope-denied'
    `).get() as Record<string, unknown>;
    expect(row).toEqual({
      failure_code: 'authorization_denied',
      failure_stage: 'authorization',
      retry_disposition: 'not_retryable',
      operator_action: 'recover',
    });
  });

  it('records conversation-bound visibility denials as authorization evidence', async () => {
    registry.register(makeTool({
      name: 'bound_denied_tool',
      scope: 'global',
    }));
    const conversationKey = 'conv-bound-denied';
    const deliveryJid = 'bound-denied@example.invalid';

    const result = await registry.call(
      'bound_denied_tool',
      { message: 'input' },
      makeSession({
        tier: 'global',
        conversationKey,
        deliveryJid,
        binding: makeConversationBinding(conversationKey, deliveryJid),
      }),
    );

    expect(result.isError).toBe(true);
    const row = db.raw.prepare(`
      SELECT failure_code, failure_stage, retry_disposition, operator_action
      FROM tool_calls WHERE conversation_key = 'conv-bound-denied'
    `).get() as Record<string, unknown>;
    expect(row).toEqual({
      failure_code: 'authorization_denied',
      failure_stage: 'authorization',
      retry_disposition: 'not_retryable',
      operator_action: 'recover',
    });
  });

  it('keeps tool outcomes unchanged while counting bounded telemetry-write loss', async () => {
    let callNumber = 0;
    const fakeDurability = {
      recordToolCall: () => {
        callNumber += 1;
        if (callNumber === 1) throw new Error('CANARY-RECORD-WRITE-LOSS');
        return callNumber;
      },
      markToolExecuting: () => {
        if (callNumber === 2) throw new Error('CANARY-EXECUTE-WRITE-LOSS');
      },
      markToolComplete: () => {
        if (callNumber === 3) throw new Error('CANARY-COMPLETE-WRITE-LOSS');
      },
    };
    registry.setDurability(fakeDurability as unknown as DurabilityEngine);
    registry.register(makeTool({ name: 'loss_tool', scope: 'global' }));

    for (let index = 0; index < 3; index += 1) {
      const result = await registry.call(
        'loss_tool',
        { message: `still-runs-${index}` },
        makeSession({ tier: 'global', conversationKey: `conv-loss-${index}` }),
      );
      expect(result.isError).toBeUndefined();
    }

    expect(registry.getDurabilityTelemetrySnapshot()).toMatchObject({
      observed: true,
      totalWriteLosses: 3,
      byStage: {
        record: 1,
        execute: 1,
        complete: 1,
        deny: 0,
      },
      firstLossAt: expect.any(Number),
      lastLossAt: expect.any(Number),
    });
  });

  it('keeps returned tool-error prose out of durable evidence', async () => {
    registry.register(makeTool({
      name: 'soft_failing_tool',
      schema: z.object({}),
      handler: async () => errorResult('CANARY-SOFT-FAILURE-PROSE'),
    }));

    const result = await registry.call('soft_failing_tool', {}, makeSession({ conversationKey: 'conv-6' }));

    expect(result.isError).toBe(true);
    const row = db.raw.prepare(
      `SELECT status, result FROM tool_calls WHERE conversation_key = 'conv-6' AND tool_name = 'soft_failing_tool'`,
    ).get() as any;
    expect(row.status).toBe('error');
    expect(row.result).toBe(TOOL_RESULT_MARKERS.error);
    expect(JSON.stringify(row)).not.toContain('CANARY-SOFT-FAILURE-PROSE');
  });

  it('keeps sensitive-tool denial prose out of durable evidence', async () => {
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
    expect(row.result).toBe(TOOL_RESULT_MARKERS.error);
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
