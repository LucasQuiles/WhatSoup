import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Database } from '../../src/core/database.ts';
import {
  DurabilityEngine,
  drainPendingOutbound,
  makeConfirmedOutboundProbe,
  sendTracked,
} from '../../src/core/durability.ts';
import type { Messenger, SubmissionReceipt } from '../../src/core/types.ts';

const emitAlert = vi.hoisted(() => vi.fn(() => true));
const clearAlertSource = vi.hoisted(() => vi.fn(() => true));
const gateQuarantineClear = vi.hoisted(() => vi.fn());

vi.mock('../../src/lib/emit-alert.ts', () => ({
  emitAlert,
  emitAlertChecked: emitAlert,
  clearAlertSource,
  clearAlertSourceChecked: clearAlertSource,
}));

vi.mock('../../src/lib/fleet-health-gate.ts', () => ({
  gateQuarantineClear,
}));

function makeDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

function getOutbound(db: Database, id: number): Record<string, unknown> {
  return db.raw.prepare('SELECT * FROM outbound_ops WHERE id = ?').get(id) as Record<string, unknown>;
}

function makeMessenger(
  sendImpl: (chatJid: string, text: string) => Promise<SubmissionReceipt>,
): Messenger {
  return {
    sendMessage: vi.fn(sendImpl),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
  } as unknown as Messenger;
}

describe('DurabilityEngine edge coverage', () => {
  let db: Database;
  let engine: DurabilityEngine;

  beforeEach(() => {
    db = makeDb();
    engine = new DurabilityEngine(db);
    emitAlert.mockClear();
    clearAlertSource.mockClear();
    gateQuarantineClear.mockReset();
    gateQuarantineClear.mockImplementation((_botName: string, opts: { now: () => string }) => {
      opts.now();
      return { action: 'clear' };
    });
  });

  afterEach(() => { db.close(); });

  it('marks inbound skipped and exposes pending inbound rows', () => {
    const first = engine.journalInbound('msg-pending-1', 'key-pending-1', 'jid-1', 'agent');
    const skipped = engine.journalInbound('msg-skipped', 'key-skipped', 'jid-2', 'agent');

    engine.markInboundSkipped(skipped, 'duplicate');

    expect(engine.getPendingInbound()).toEqual([
      expect.objectContaining({
        seq: first,
        message_id: 'msg-pending-1',
        processing_status: 'processing',
        routed_to: 'agent',
      }),
    ]);
    const skippedRow = db.raw.prepare(
      'SELECT processing_status, terminal_reason FROM inbound_events WHERE seq = ?',
    ).get(skipped) as Record<string, unknown>;
    expect(skippedRow).toMatchObject({ processing_status: 'complete', terminal_reason: 'duplicate' });
  });

  it('marks failed permanent and records null maybe_sent errors when no error is provided', () => {
    const failed = engine.createOutboundOp({
      conversationKey: 'key-failed',
      chatJid: 'jid-failed',
      opType: 'text',
      payload: '{"text":"failed"}',
      replayPolicy: 'unsafe',
    });
    engine.markFailedPermanent(failed, 'not retriable');
    expect(getOutbound(db, failed)).toMatchObject({ status: 'failed_permanent', error: 'not retriable' });

    const maybe = engine.createOutboundOp({
      conversationKey: 'key-maybe',
      chatJid: 'jid-maybe',
      opType: 'text',
      payload: '{"text":"maybe"}',
      replayPolicy: 'safe',
    });
    engine.markMaybeSent(maybe);
    expect(getOutbound(db, maybe)).toMatchObject({ status: 'maybe_sent', error: null });
  });

  it('matchEcho returns true and marks the matching submitted outbound echoed', () => {
    const id = engine.createOutboundOp({
      conversationKey: 'key-echo-match',
      chatJid: 'jid-echo',
      opType: 'text',
      payload: '{"text":"echo"}',
      replayPolicy: 'safe',
    });
    engine.markSending(id);
    engine.markSubmitted(id, 'WA_MATCHED');

    expect(engine.matchEcho('WA_MATCHED')).toBe(true);
    expect(getOutbound(db, id)['status']).toBe('echoed');
  });

  it('completeTurn commits single-purpose writes without optional siblings', () => {
    const seq = engine.journalInbound('msg-only-inbound', 'key-only-inbound', 'jid-inbound', 'agent');
    engine.completeTurn({ inbound: { seq, terminalReason: 'no_reply_needed' } });
    expect(engine.getInboundStatus(seq)).toBe('complete');

    engine.completeTurn({
      checkpoint: {
        conversationKey: 'key-only-checkpoint',
        fields: { sessionId: 'sess-only', sessionStatus: 'active' },
      },
    });
    expect(engine.getSessionCheckpoint('key-only-checkpoint')).toMatchObject({
      session_id: 'sess-only',
      session_status: 'active',
    });
  });

  it('completeTurn rethrows begin failures without attempting rollback', () => {
    const realExec = db.raw.exec.bind(db.raw);
    const execSpy = vi.spyOn(db.raw, 'exec').mockImplementation((sql: string) => {
      if (sql === 'BEGIN IMMEDIATE') throw new Error('begin denied');
      return realExec(sql);
    });

    expect(() => engine.completeTurn({ lastOpId: 123 })).toThrow('begin denied');
    expect(execSpy).not.toHaveBeenCalledWith('ROLLBACK');
    execSpy.mockRestore();
  });

  it('completeTurn logs rollback failures but rethrows the original write error', () => {
    db.raw.exec(
      `INSERT INTO agent_sessions (session_id, started_at, status, total_input_tokens, total_output_tokens)
       VALUES ('sess-rollback-fails', datetime('now'), 'active', 0, 0)`,
    );
    const session = db.raw.prepare(
      'SELECT id FROM agent_sessions WHERE session_id = ?',
    ).get('sess-rollback-fails') as { id: number };

    db.raw.exec(`
      CREATE TRIGGER deny_token_event_insert
      BEFORE INSERT ON agent_token_events
      BEGIN
        SELECT RAISE(ABORT, 'token event denied');
      END
    `);

    const realExec = db.raw.exec.bind(db.raw);
    const execSpy = vi.spyOn(db.raw, 'exec').mockImplementation((sql: string) => {
      if (sql === 'ROLLBACK') throw new Error('rollback denied');
      return realExec(sql);
    });

    try {
      expect(() => engine.completeTurn({
        sessionTokens: { dbRowId: session.id, inputTokens: 1, outputTokens: 2, cacheReadTokens: 0 },
      })).toThrow(/token event denied/);
      expect(execSpy).toHaveBeenCalledWith('ROLLBACK');
    } finally {
      execSpy.mockRestore();
      try {
        db.raw.exec('ROLLBACK');
      } catch {
        // The transaction may already be closed if SQLite aborted it.
      }
    }
  });

  it('preConnectRecovery fails closed after an isolated recovery phase failure', () => {
    db.raw.exec('DROP TABLE session_checkpoints');
    expect(() => engine.preConnectRecovery()).toThrow('no such table: session_checkpoints');
  });

  it('preConnectRecovery fails closed when outbound recovery state is unavailable', () => {
    engine.journalInbound('msg-processing-catch', 'key-processing-catch', 'jid-catch', 'agent');
    db.raw.exec('DROP TABLE outbound_ops');

    expect(() => engine.preConnectRecovery()).toThrow('no such table: outbound_ops');
  });

  it('preConnectRecovery fails closed after tool-call recovery failures', () => {
    db.raw.exec('DROP TABLE tool_calls');
    expect(() => engine.preConnectRecovery()).toThrow('no such table: tool_calls');
  });

  it('postConnectRecovery fails closed before the clear gate when outbound state is unavailable', () => {
    db.raw.exec('DROP TABLE outbound_ops');

    expect(() => engine.postConnectRecovery()).toThrow('no such table: outbound_ops');
    expect(gateQuarantineClear).not.toHaveBeenCalled();
  });

  it('postConnectRecovery wires gate callbacks to alert and clear emitters', () => {
    gateQuarantineClear.mockImplementationOnce((
      _botName: string,
      opts: {
        now: () => string;
        emitClear: () => void;
        emitEscalation: (evidence: string) => void;
        emitGateFailure: (evidence: string) => void;
      },
    ) => {
      expect(opts.now()).toEqual(expect.any(String));
      opts.emitEscalation('auth evidence');
      opts.emitGateFailure('gate evidence');
      opts.emitClear();
      return { action: 'escalated' };
    });

    engine.postConnectRecovery();

    expect(emitAlert).toHaveBeenCalledWith(
      'Loops',
      'auth_terminal',
      expect.any(String),
      expect.stringContaining('auth evidence'),
      'critical',
    );
    expect(emitAlert).toHaveBeenCalledWith(
      'Loops',
      'fleet_health_verify_gate_failed',
      expect.any(String),
      expect.stringContaining('gate evidence; clear_suppressed=true'),
      'warning',
    );
    expect(clearAlertSource).toHaveBeenCalledWith('Loops', 'outbound_quarantined');
  });

  it('postConnectRecovery records gate failure without committing a staged clear', () => {
    gateQuarantineClear.mockImplementationOnce((
      _botName: string,
      opts: { emitClear: () => void },
    ) => {
      opts.emitClear();
      throw new Error('gate failed');
    });

    expect(() => engine.postConnectRecovery()).toThrow('gate failed');
    expect(clearAlertSource).not.toHaveBeenCalled();
    const run = db.raw.prepare(`
      SELECT completed_at, notes
      FROM recovery_runs
      WHERE trigger = 'post_connect'
      ORDER BY id DESC
      LIMIT 1
    `).get() as { completed_at: string | null; notes: string | null };
    expect(run.completed_at).toBeNull();
    expect(JSON.parse(run.notes ?? 'null')).toEqual({
      status: 'incomplete',
      failedPhases: ['verify_quarantine_clear'],
      openRecoveries: 0,
    });
  });

  it('postConnectRecovery remains incomplete when the approved clear cannot be queued', () => {
    gateQuarantineClear.mockImplementationOnce((
      _botName: string,
      opts: { emitClear: () => void },
    ) => {
      opts.emitClear();
      return { action: 'clear' };
    });
    clearAlertSource.mockReturnValueOnce(false);

    expect(() => engine.postConnectRecovery()).toThrow(
      'quarantine clear could not be durably queued',
    );
    const run = db.raw.prepare(`
      SELECT completed_at, notes
      FROM recovery_runs
      WHERE trigger = 'post_connect'
      ORDER BY id DESC
      LIMIT 1
    `).get() as { completed_at: string | null; notes: string | null };
    expect(run.completed_at).toBeNull();
    expect(JSON.parse(run.notes ?? 'null')).toEqual({
      status: 'incomplete',
      failedPhases: ['verify_quarantine_clear'],
      openRecoveries: 0,
    });
  });

  it('postConnectRecovery remains incomplete when a required escalation cannot be queued', () => {
    gateQuarantineClear.mockImplementationOnce((
      _botName: string,
      opts: { emitEscalation: (evidence: string) => void },
    ) => {
      opts.emitEscalation('required escalation');
      return { action: 'suppress_and_escalate' };
    });
    emitAlert.mockReturnValueOnce(false);

    expect(() => engine.postConnectRecovery()).toThrow(
      'quarantine escalation could not be durably queued',
    );
    const run = db.raw.prepare(`
      SELECT completed_at, notes
      FROM recovery_runs
      WHERE trigger = 'post_connect'
      ORDER BY id DESC
      LIMIT 1
    `).get() as { completed_at: string | null; notes: string | null };
    expect(run.completed_at).toBeNull();
    expect(JSON.parse(run.notes ?? 'null')).toEqual({
      status: 'incomplete',
      failedPhases: ['verify_quarantine_clear'],
      openRecoveries: 0,
    });
  });

  it('postConnectRecovery remains incomplete when gate-failure evidence cannot be queued', () => {
    gateQuarantineClear.mockImplementationOnce((
      _botName: string,
      opts: { emitGateFailure: (evidence: string) => void },
    ) => {
      opts.emitGateFailure('required gate failure');
      return { action: 'suppress_and_escalate' };
    });
    emitAlert.mockReturnValueOnce(false);

    expect(() => engine.postConnectRecovery()).toThrow(
      'quarantine gate-failure evidence could not be durably queued',
    );
    const run = db.raw.prepare(`
      SELECT completed_at, notes
      FROM recovery_runs
      WHERE trigger = 'post_connect'
      ORDER BY id DESC
      LIMIT 1
    `).get() as { completed_at: string | null; notes: string | null };
    expect(run.completed_at).toBeNull();
    expect(JSON.parse(run.notes ?? 'null')).toEqual({
      status: 'incomplete',
      failedPhases: ['verify_quarantine_clear'],
      openRecoveries: 0,
    });
  });

  it.each([
    ['with a WhatsApp message id', true],
    ['without a WhatsApp message id', false],
  ] as const)(
    'postConnectRecovery remains incomplete when an outbound quarantine alert %s cannot be queued',
    (_case, hasWaMessageId) => {
      const id = engine.createOutboundOp({
        conversationKey: `quarantine-alert-${hasWaMessageId ? 'wa' : 'no-wa'}`,
        chatJid: 'quarantine-alert@g.us',
        opType: 'text',
        payload: '{"text":"delivery uncertain"}',
        replayPolicy: 'unsafe',
      });
      if (hasWaMessageId) {
        engine.markSending(id);
        engine.markSubmitted(id, 'WA_UNCONFIRMED');
      }
      engine.markMaybeSent(id, 'crash-in-flight');
      emitAlert.mockReturnValueOnce(false);

      expect(() => engine.postConnectRecovery()).toThrow(
        `outbound quarantine alert could not be durably queued for op ${id}`,
      );
      expect(getOutbound(db, id)['status']).toBe('quarantined');
      expect(gateQuarantineClear).not.toHaveBeenCalled();
      expect(clearAlertSource).not.toHaveBeenCalled();
      const run = db.raw.prepare(`
        SELECT completed_at, notes
        FROM recovery_runs
        WHERE trigger = 'post_connect'
        ORDER BY id DESC
        LIMIT 1
      `).get() as { completed_at: string | null; notes: string | null };
      expect(run.completed_at).toBeNull();
      expect(JSON.parse(run.notes ?? 'null')).toEqual({
        status: 'incomplete',
        failedPhases: ['emit_outbound_quarantine_alert'],
        openRecoveries: 0,
      });
    },
  );

  it('deduplicates repeated per-op alert failures in incomplete recovery notes', () => {
    const ids = ['first', 'second'].map((suffix) => {
      const id = engine.createOutboundOp({
        conversationKey: `quarantine-alert-dedup-${suffix}`,
        chatJid: 'quarantine-alert-dedup@g.us',
        opType: 'text',
        payload: '{"text":"delivery uncertain"}',
        replayPolicy: 'unsafe',
      });
      engine.markMaybeSent(id, 'crash-in-flight');
      return id;
    });
    emitAlert.mockReturnValueOnce(false).mockReturnValueOnce(false);

    expect(() => engine.postConnectRecovery()).toThrow(
      `outbound quarantine alert could not be durably queued for op ${ids[0]}`,
    );
    expect(ids.map((id) => getOutbound(db, id)['status'])).toEqual([
      'quarantined',
      'quarantined',
    ]);
    const run = db.raw.prepare(`
      SELECT completed_at, notes
      FROM recovery_runs
      WHERE trigger = 'post_connect'
      ORDER BY id DESC
      LIMIT 1
    `).get() as { completed_at: string | null; notes: string | null };
    expect(run.completed_at).toBeNull();
    expect(JSON.parse(run.notes ?? 'null')).toEqual({
      status: 'incomplete',
      failedPhases: ['emit_outbound_quarantine_alert'],
      openRecoveries: 0,
    });
  });

  it('logRecoveryRun swallows insertion failures', () => {
    db.raw.exec('DROP TABLE recovery_runs');

    expect(() => engine.logRecoveryRun('unit_test', {
      inboundReplayed: 0,
      outboundReconciled: 0,
      outboundReplayed: 0,
      outboundQuarantined: 0,
      toolCallsRecovered: 0,
      toolCallsReplayed: 0,
      toolCallsQuarantined: 0,
      sessionsRestored: 0,
    })).not.toThrow();
  });

  it('sendTracked records send_failed when a rejected value has no message', async () => {
    const messenger = makeMessenger(async () => Promise.reject(null));

    await sendTracked(messenger, 'jid-fallback@s.whatsapp.net', 'hello', engine, { replayPolicy: 'safe' })
      .then(
        () => { throw new Error('sendTracked should reject'); },
        (err) => { expect(err).toBeNull(); },
      );

    const row = db.raw.prepare('SELECT status, error FROM outbound_ops ORDER BY id DESC LIMIT 1').get() as Record<string, unknown>;
    expect(row).toMatchObject({ status: 'maybe_sent', error: 'send_failed' });
  });

  it('sendTracked rethrows send failures when durability tracking is disabled', async () => {
    const messenger = makeMessenger(async () => { throw new Error('offline'); });

    await expect(sendTracked(
      messenger,
      'jid-no-durability@s.whatsapp.net',
      'hello',
      undefined,
      { replayPolicy: 'safe' },
    )).rejects.toThrow('offline');
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM outbound_ops').get()).toMatchObject({ count: 0 });
  });

  it('drainPendingOutbound quarantines malformed JSON payloads', async () => {
    const id = engine.createOutboundOp({
      conversationKey: 'key-bad-json',
      chatJid: 'jid-bad-json',
      opType: 'text',
      payload: '{not valid json',
      replayPolicy: 'safe',
    });
    const messenger = makeMessenger(async () => ({ waMessageId: 'WA_UNUSED' }));

    expect((await drainPendingOutbound(messenger, engine)).resent).toBe(0);
    expect(messenger.sendMessage).not.toHaveBeenCalled();
    expect(getOutbound(db, id)['status']).toBe('quarantined');
  });

  it('drainPendingOutbound records replay_failed when a rejected value has no message', async () => {
    const id = engine.createOutboundOp({
      conversationKey: 'key-replay-fallback',
      chatJid: 'jid-replay-fallback',
      opType: 'text',
      payload: '{"text":"retry"}',
      replayPolicy: 'safe',
    });
    const messenger = makeMessenger(async () => Promise.reject(null));

    expect((await drainPendingOutbound(messenger, engine)).resent).toBe(0);
    expect(getOutbound(db, id)).toMatchObject({ status: 'maybe_sent', error: 'replay_failed' });
  });

  it('drainPendingOutbound keeps draining after an unexpected per-op failure', async () => {
    const badId = engine.createOutboundOp({
      conversationKey: 'key-outer-catch',
      chatJid: 'jid-outer-catch',
      opType: 'text',
      payload: '{"text":"first"}',
      replayPolicy: 'safe',
    });
    const goodId = engine.createOutboundOp({
      conversationKey: 'key-after-catch',
      chatJid: 'jid-after-catch',
      opType: 'text',
      payload: '{"text":"second"}',
      replayPolicy: 'safe',
    });
    const realMarkSending = engine.markSending.bind(engine);
    vi.spyOn(engine, 'markSending')
      .mockImplementationOnce(() => { throw new Error('claim failed'); })
      .mockImplementation((id: number) => realMarkSending(id));
    const messenger = makeMessenger(async () => ({ waMessageId: 'WA_AFTER_CATCH' }));

    expect((await drainPendingOutbound(messenger, engine)).resent).toBe(1);
    expect(getOutbound(db, badId)['status']).toBe('pending');
    expect(getOutbound(db, goodId)['status']).toBe('submitted');
  });

  it('makeConfirmedOutboundProbe reports recent echoed outbound proof only when present', () => {
    const probe = makeConfirmedOutboundProbe(db.raw);

    expect(probe(900)).toBe(false);

    const id = engine.createOutboundOp({
      conversationKey: 'key-probe',
      chatJid: 'jid-probe',
      opType: 'text',
      payload: '{"text":"probe"}',
      replayPolicy: 'safe',
    });
    engine.markSending(id);
    engine.markSubmitted(id, 'WA_PROBE');
    engine.markEchoed(id);

    expect(probe(900)).toBe(true);
  });
});
