import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { DurabilityEngine, sendTracked } from '../../src/core/durability.ts';
import type { OutboundOpParams } from '../../src/core/durability.ts';

const BASE_OP: OutboundOpParams = {
  conversationKey: 'key-1',
  chatJid: 'jid-1@s.whatsapp.net',
  opType: 'send_text',
  payload: '{"text":"hello"}',
  replayPolicy: 'safe',
};

describe('DurabilityEngine', () => {
  let db: Database;
  let engine: DurabilityEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
    engine = new DurabilityEngine(db);
  });

  afterEach(() => { db.close(); });

  describe('inbound_events', () => {
    it('journalInbound creates a row with processing status', () => {
      const seq = engine.journalInbound('msg-1', 'key-1', 'jid-1@s.whatsapp.net', 'agent');
      expect(seq).toBeGreaterThan(0);
      const row = db.raw.prepare('SELECT * FROM inbound_events WHERE seq = ?').get(seq) as any;
      expect(row.processing_status).toBe('processing');
      expect(row.routed_to).toBe('agent');
    });

    it('markTurnDone transitions processing → turn_done', () => {
      const seq = engine.journalInbound('msg-1', 'key-1', 'jid-1', 'agent');
      engine.markTurnDone(seq);
      const row = db.raw.prepare('SELECT processing_status FROM inbound_events WHERE seq = ?').get(seq) as any;
      expect(row.processing_status).toBe('turn_done');
    });

    it('getInboundStatus returns the current processing status', () => {
      const seq = engine.journalInbound('msg-status', 'key-1', 'jid-status', 'agent');
      expect(engine.getInboundStatus(seq)).toBe('processing');
      engine.markTurnDone(seq);
      expect(engine.getInboundStatus(seq)).toBe('turn_done');
    });

    it('markInboundComplete transitions turn_done → complete', () => {
      const seq = engine.journalInbound('msg-1', 'key-1', 'jid-1', 'agent');
      engine.markTurnDone(seq);
      engine.markInboundComplete(seq, 'response_sent');
      const row = db.raw.prepare('SELECT * FROM inbound_events WHERE seq = ?').get(seq) as any;
      expect(row.processing_status).toBe('complete');
      expect(row.terminal_reason).toBe('response_sent');
      expect(row.completed_at).not.toBeNull();
    });

    it('duplicate message_id is rejected', () => {
      engine.journalInbound('msg-1', 'key-1', 'jid-1', 'agent');
      expect(() => engine.journalInbound('msg-1', 'key-1', 'jid-1', 'agent')).toThrow();
    });

    it('markInboundFailed records the given failure_class and keeps terminal_reason=error', () => {
      const seq = engine.journalInbound('msg-fc-1', 'key-1', 'jid-1', 'agent');
      engine.markInboundFailed(seq, 'db_error');
      const row = db.raw.prepare('SELECT * FROM inbound_events WHERE seq = ?').get(seq) as any;
      expect(row.processing_status).toBe('failed');
      expect(row.failure_class).toBe('db_error');
      // Contract pin: terminal_reason must stay exactly 'error' (external matcher).
      expect(row.terminal_reason).toBe('error');
      expect(row.completed_at).not.toBeNull();
    });

    it('markInboundFailed with no class defaults failure_class to unknown', () => {
      const seq = engine.journalInbound('msg-fc-2', 'key-1', 'jid-1', 'agent');
      engine.markInboundFailed(seq);
      const row = db.raw.prepare('SELECT failure_class, terminal_reason FROM inbound_events WHERE seq = ?').get(seq) as any;
      expect(row.failure_class).toBe('unknown');
      expect(row.terminal_reason).toBe('error');
    });

    it('markInboundFailed coerces an out-of-vocabulary class to unknown', () => {
      const seq = engine.journalInbound('msg-fc-3', 'key-1', 'jid-1', 'agent');
      // Cast through unknown: callers are typed, but the DB gate must still hold.
      engine.markInboundFailed(seq, 'disk_on_fire' as unknown as Parameters<typeof engine.markInboundFailed>[1]);
      const row = db.raw.prepare('SELECT failure_class FROM inbound_events WHERE seq = ?').get(seq) as any;
      expect(row.failure_class).toBe('unknown');
    });
  });

  describe('outbound_ops', () => {
    it('createOutboundOp returns id with pending status', () => {
      const id = engine.createOutboundOp({
        conversationKey: 'key-1',
        chatJid: 'jid-1',
        opType: 'text',
        payload: '{"text":"hello"}',
        replayPolicy: 'unsafe',
      });
      expect(id).toBeGreaterThan(0);
      const row = db.raw.prepare('SELECT * FROM outbound_ops WHERE id = ?').get(id) as any;
      expect(row.status).toBe('pending');
      expect(row.replay_policy).toBe('unsafe');
    });

    it('markSending transitions pending → sending', () => {
      const id = engine.createOutboundOp({ conversationKey: 'k', chatJid: 'j', opType: 'text', payload: '{}', replayPolicy: 'unsafe' });
      engine.markSending(id);
      const row = db.raw.prepare('SELECT status FROM outbound_ops WHERE id = ?').get(id) as any;
      expect(row.status).toBe('sending');
    });

    it('markSubmitted records wa_message_id and transitions to submitted', () => {
      const id = engine.createOutboundOp({ conversationKey: 'k', chatJid: 'j', opType: 'text', payload: '{}', replayPolicy: 'unsafe' });
      engine.markSending(id);
      engine.markSubmitted(id, 'WA_MSG_123');
      const row = db.raw.prepare('SELECT * FROM outbound_ops WHERE id = ?').get(id) as any;
      expect(row.status).toBe('submitted');
      expect(row.wa_message_id).toBe('WA_MSG_123');
    });

    it('markEchoed transitions submitted → echoed and completes linked inbound', () => {
      const seq = engine.journalInbound('msg-1', 'key-1', 'jid-1', 'agent');
      const id = engine.createOutboundOp({ conversationKey: 'key-1', chatJid: 'jid-1', opType: 'text', payload: '{}', replayPolicy: 'unsafe', sourceInboundSeq: seq, isTerminal: true });
      engine.markSending(id);
      engine.markSubmitted(id, 'WA_MSG_1');
      engine.markTurnDone(seq);
      engine.markEchoed(id);
      const outRow = db.raw.prepare('SELECT status FROM outbound_ops WHERE id = ?').get(id) as any;
      expect(outRow.status).toBe('echoed');
      const inRow = db.raw.prepare('SELECT processing_status FROM inbound_events WHERE seq = ?').get(seq) as any;
      expect(inRow.processing_status).toBe('complete');
    });

    it('QR-102: markTerminal completes the linked inbound when the op was ALREADY echoed (echo-before-terminal)', () => {
      const seq = engine.journalInbound('msg-qr102', 'key-1', 'jid-1', 'agent');
      // Real ordering: markLastTerminal runs AFTER the reply is sent+echoed, so the op
      // is echoed while still non-terminal. markEchoed's completion (is_terminal at echo
      // time) is therefore missed — markTerminal must finalize the inbound.
      const id = engine.createOutboundOp({ conversationKey: 'key-1', chatJid: 'jid-1', opType: 'text', payload: '{}', replayPolicy: 'unsafe', sourceInboundSeq: seq, isTerminal: false });
      engine.markSending(id);
      engine.markSubmitted(id, 'WA_MSG_QR102');
      engine.markEchoed(id); // is_terminal=0 at echo time → markEchoed skips completion
      const midRow = db.raw.prepare('SELECT processing_status FROM inbound_events WHERE seq = ?').get(seq) as any;
      expect(midRow.processing_status).not.toBe('complete'); // not finalized yet

      engine.markTerminal(id); // QR-102 fix: op is already 'echoed' → complete the inbound now
      const inRow2 = db.raw.prepare('SELECT processing_status FROM inbound_events WHERE seq = ?').get(seq) as any;
      expect(inRow2.processing_status).toBe('complete');
    });

    it('markMaybeSent transitions sending → maybe_sent', () => {
      const id = engine.createOutboundOp({ conversationKey: 'k', chatJid: 'j', opType: 'text', payload: '{}', replayPolicy: 'unsafe' });
      engine.markSending(id);
      engine.markMaybeSent(id, 'EPIPE');
      const row = db.raw.prepare('SELECT * FROM outbound_ops WHERE id = ?').get(id) as any;
      expect(row.status).toBe('maybe_sent');
      expect(row.error).toBe('EPIPE');
    });

    it('getHealthStats surfaces the maybe_sent count and oldest submission age (#1865)', () => {
      expect(engine.getHealthStats().maybeSentOutbound).toBe(0);
      expect(engine.getHealthStats().oldestMaybeSentAt).toBeNull();

      const id = engine.createOutboundOp({ conversationKey: 'k', chatJid: 'j', opType: 'text', payload: '{}', replayPolicy: 'unsafe' });
      engine.markSending(id);
      engine.markSubmitted(id, 'WA_MSG_1865');
      engine.markMaybeSent(id, 'echo_timeout');
      // Back-date submission to one hour ago to simulate a long-unresolved ambiguous delivery.
      db.raw
        .prepare(`UPDATE outbound_ops SET submitted_at = datetime('now', '-3600 seconds') WHERE id = ?`)
        .run(id);

      const stats = engine.getHealthStats();
      expect(stats.maybeSentOutbound).toBe(1);
      expect(stats.oldestMaybeSentAt).not.toBeNull();
      const ageMs = Date.now() - Date.parse((stats.oldestMaybeSentAt as string).replace(' ', 'T') + 'Z');
      expect(ageMs).toBeGreaterThan(30 * 60 * 1000);
    });
  });

  describe('sweepStaleSubmitted()', () => {
    it('returns 0 when there are no outbound ops', () => {
      expect(engine.sweepStaleSubmitted()).toBe(0);
    });

    it('returns 0 when submitted ops are recent (< 30 s)', () => {
      const id = engine.createOutboundOp(BASE_OP);
      engine.markSending(id);
      engine.markSubmitted(id, 'wa-msg-recent');
      // submitted_at just set to now — should not be swept
      expect(engine.sweepStaleSubmitted()).toBe(0);
      const row = db.raw.prepare('SELECT status FROM outbound_ops WHERE id = ?').get(id) as any;
      expect(row.status).toBe('submitted');
    });

    it('promotes a stale submitted op (> 30 s) to maybe_sent with echo_timeout error', () => {
      const id = engine.createOutboundOp(BASE_OP);
      engine.markSending(id);
      // Back-date submitted_at to 60 s ago to simulate a stale echo
      db.raw
        .prepare(
          `UPDATE outbound_ops SET status = 'submitted', wa_message_id = 'wa-stale', submitted_at = datetime('now', '-60 seconds') WHERE id = ?`,
        )
        .run(id);

      expect(engine.sweepStaleSubmitted()).toBe(1);

      const row = db.raw.prepare('SELECT status, error FROM outbound_ops WHERE id = ?').get(id) as any;
      expect(row.status).toBe('maybe_sent');
      expect(row.error).toBe('echo_timeout');
    });

    it('sweeps multiple stale ops in one call', () => {
      const ids = [0, 1, 2].map(() => {
        const id = engine.createOutboundOp(BASE_OP);
        engine.markSending(id);
        db.raw
          .prepare(
            `UPDATE outbound_ops SET status = 'submitted', submitted_at = datetime('now', '-90 seconds') WHERE id = ?`,
          )
          .run(id);
        return id;
      });

      expect(engine.sweepStaleSubmitted()).toBe(3);
      for (const id of ids) {
        const row = db.raw.prepare('SELECT status FROM outbound_ops WHERE id = ?').get(id) as any;
        expect(row.status).toBe('maybe_sent');
      }
    });

    it('only sweeps ops older than 30 s and leaves recent ones untouched', () => {
      // Stale op
      const staleId = engine.createOutboundOp(BASE_OP);
      engine.markSending(staleId);
      db.raw
        .prepare(
          `UPDATE outbound_ops SET status = 'submitted', submitted_at = datetime('now', '-31 seconds') WHERE id = ?`,
        )
        .run(staleId);

      // Recent op — submitted just now
      const recentId = engine.createOutboundOp(BASE_OP);
      engine.markSending(recentId);
      engine.markSubmitted(recentId, 'wa-new');

      expect(engine.sweepStaleSubmitted()).toBe(1);

      const staleRow = db.raw.prepare('SELECT status FROM outbound_ops WHERE id = ?').get(staleId) as any;
      expect(staleRow.status).toBe('maybe_sent');

      const recentRow = db.raw.prepare('SELECT status FROM outbound_ops WHERE id = ?').get(recentId) as any;
      expect(recentRow.status).toBe('submitted');
    });

    it('does not touch pending, sending, echoed, or already-maybe_sent ops', () => {
      const pending = engine.createOutboundOp(BASE_OP);

      const sending = engine.createOutboundOp(BASE_OP);
      engine.markSending(sending);

      const echoed = engine.createOutboundOp(BASE_OP);
      engine.markSending(echoed);
      engine.markSubmitted(echoed, 'wa-echo');
      engine.markEchoed(echoed);

      const maybeSent = engine.createOutboundOp(BASE_OP);
      engine.markMaybeSent(maybeSent, 'prior_error');

      expect(engine.sweepStaleSubmitted()).toBe(0);

      const rows = [pending, sending, echoed, maybeSent].map((id) => {
        const r = db.raw.prepare('SELECT status FROM outbound_ops WHERE id = ?').get(id) as any;
        return r.status as string;
      });
      expect(rows).toEqual(['pending', 'sending', 'echoed', 'maybe_sent']);
    });
  });

  describe('completeInbound', () => {
    it('transitions processing → turn_done → complete', () => {
      const seq = engine.journalInbound('msg-1', 'key-1', 'jid-1', 'agent');
      engine.completeInbound(seq, 'response_sent');
      const row = db.raw.prepare('SELECT processing_status, terminal_reason FROM inbound_events WHERE seq = ?').get(seq) as any;
      expect(row.processing_status).toBe('complete');
      expect(row.terminal_reason).toBe('response_sent');
    });

    it('skips markTurnDone if already in turn_done', () => {
      const seq = engine.journalInbound('msg-2', 'key-1', 'jid-2', 'agent');
      engine.markTurnDone(seq);
      engine.completeInbound(seq, 'response_sent');
      const row = db.raw.prepare('SELECT processing_status FROM inbound_events WHERE seq = ?').get(seq) as any;
      expect(row.processing_status).toBe('complete');
    });

    it('is idempotent on already-complete events', () => {
      const seq = engine.journalInbound('msg-3', 'key-1', 'jid-3', 'agent');
      engine.completeInbound(seq, 'response_sent');
      // Calling again should not throw
      engine.completeInbound(seq, 'response_sent');
      const row = db.raw.prepare('SELECT processing_status FROM inbound_events WHERE seq = ?').get(seq) as any;
      expect(row.processing_status).toBe('complete');
    });
  });

  describe('completeTurn', () => {
    it('batches token, checkpoint, inbound, and terminal writes in one transaction', () => {
      const inboundSeq = engine.journalInbound('msg-turn-1', 'key-1', 'jid-1', 'agent');
      const outboundId = engine.createOutboundOp({
        conversationKey: 'key-1',
        chatJid: 'jid-1',
        opType: 'text',
        payload: '{"text":"done"}',
        replayPolicy: 'safe',
      });

      const sessionInsert = db.raw.prepare(
        `INSERT INTO agent_sessions (claude_pid, started_in_directory, started_at, status)
         VALUES (?, ?, datetime('now'), 'active')`,
      ).run(123, '/tmp/session');
      const sessionRowId = Number(sessionInsert.lastInsertRowid);

      const execSpy = vi.spyOn(db.raw, 'exec');

      engine.completeTurn({
        sessionTokens: {
          dbRowId: sessionRowId,
          inputTokens: 11,
          outputTokens: 7,
          cacheReadTokens: 0,
        },
        checkpoint: {
          conversationKey: 'key-1',
          fields: {
            activeTurnId: null,
            lastInboundSeq: inboundSeq,
            lastFlushedOutboundId: outboundId,
          },
        },
        inbound: {
          seq: inboundSeq,
          terminalReason: 'response_sent',
        },
        lastOpId: outboundId,
      });

      expect(execSpy.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN IMMEDIATE', 'COMMIT']);

      const sessionRow = db.raw.prepare(
        'SELECT total_input_tokens, total_output_tokens FROM agent_sessions WHERE id = ?',
      ).get(sessionRowId) as any;
      expect(sessionRow.total_input_tokens).toBe(11);
      expect(sessionRow.total_output_tokens).toBe(7);

      const checkpoint = db.raw.prepare(
        'SELECT active_turn_id, last_inbound_seq, last_flushed_outbound_id FROM session_checkpoints WHERE conversation_key = ?',
      ).get('key-1') as any;
      expect(checkpoint.active_turn_id).toBeNull();
      expect(checkpoint.last_inbound_seq).toBe(inboundSeq);
      expect(checkpoint.last_flushed_outbound_id).toBe(outboundId);

      const inboundRow = db.raw.prepare(
        'SELECT processing_status, terminal_reason FROM inbound_events WHERE seq = ?',
      ).get(inboundSeq) as any;
      expect(inboundRow.processing_status).toBe('complete');
      expect(inboundRow.terminal_reason).toBe('response_sent');

      const outboundRow = db.raw.prepare(
        'SELECT is_terminal FROM outbound_ops WHERE id = ?',
      ).get(outboundId) as any;
      expect(outboundRow.is_terminal).toBe(1);
    });

    it('rolls back and rethrows when a turn-completion write fails', () => {
      const sessionInsert = db.raw.prepare(
        `INSERT INTO agent_sessions (claude_pid, started_in_directory, started_at, status)
         VALUES (?, ?, datetime('now'), 'active')`,
      ).run(456, '/tmp/session');
      const sessionRowId = Number(sessionInsert.lastInsertRowid);

      db.raw.exec(`
        CREATE TRIGGER fail_agent_token_events_insert
        BEFORE INSERT ON agent_token_events
        BEGIN
          SELECT RAISE(ABORT, 'token event denied');
        END
      `);
      const execSpy = vi.spyOn(db.raw, 'exec');

      expect(() => engine.completeTurn({
        sessionTokens: {
          dbRowId: sessionRowId,
          inputTokens: 11,
          outputTokens: 7,
          cacheReadTokens: 0,
        },
      })).toThrow(/token event denied/);

      expect(execSpy.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK']);

      const sessionRow = db.raw.prepare(
        'SELECT total_input_tokens, total_output_tokens FROM agent_sessions WHERE id = ?',
      ).get(sessionRowId) as any;
      expect(sessionRow.total_input_tokens).toBe(0);
      expect(sessionRow.total_output_tokens).toBe(0);

      const tokenEvents = db.raw.prepare(
        'SELECT COUNT(*) as count FROM agent_token_events WHERE agent_session_id = ?',
      ).get(sessionRowId) as any;
      expect(tokenEvents.count).toBe(0);
    });
  });

  describe('sendTracked', () => {
    it('creates outbound op, marks sending, marks submitted on success', async () => {
      const mockMessenger = {
        sendMessage: vi.fn().mockResolvedValue({ waMessageId: 'WA_123' }),
        sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
      };
      await sendTracked(mockMessenger, 'jid@s.whatsapp.net', 'hello', engine, { replayPolicy: 'safe' });
      const op = db.raw.prepare('SELECT * FROM outbound_ops WHERE wa_message_id = ?').get('WA_123') as any;
      expect(op).toBeDefined();
      expect(op.status).toBe('submitted');
      expect(op.replay_policy).toBe('safe');
    });

    it('marks maybe_sent and rethrows on send failure', async () => {
      const mockMessenger = {
        sendMessage: vi.fn().mockRejectedValue(new Error('network down')),
        sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
      };
      await expect(sendTracked(mockMessenger, 'jid@s.whatsapp.net', 'hello', engine, { replayPolicy: 'unsafe' }))
        .rejects.toThrow('network down');
      const op = db.raw.prepare('SELECT * FROM outbound_ops ORDER BY id DESC LIMIT 1').get() as any;
      expect(op.status).toBe('maybe_sent');
      expect(op.error).toBe('network down');
    });

    it('works without durability engine (no-op tracking)', async () => {
      const mockMessenger = {
        sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
        sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
      };
      await sendTracked(mockMessenger, 'jid@s.whatsapp.net', 'hello', undefined, { replayPolicy: 'safe' });
      expect(mockMessenger.sendMessage).toHaveBeenCalledWith('jid@s.whatsapp.net', 'hello');
    });

    it('forwards an infra caller token to messenger.sendMessage (QR-086)', async () => {
      const mockMessenger = {
        sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
        sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
      };
      await sendTracked(mockMessenger, 'jid@s.whatsapp.net', 'hello', undefined, { replayPolicy: 'unsafe', caller: 'health' });
      // The health-server admin /send tags itself as a system caller so the
      // guard's spec §4.2-B exemption is reachable.
      expect(mockMessenger.sendMessage).toHaveBeenCalledWith('jid@s.whatsapp.net', 'hello', { caller: 'health' });
    });
  });
});

describe('durability.ts uncovered-branch coverage', () => {
  let db: Database;
  let engine: DurabilityEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
    engine = new DurabilityEngine(db);
  });

  afterEach(() => { db.close(); });

  // ── matchEcho: no-row branch (line 477) ──
  it('matchEcho returns false when no submitted op matches the wa_message_id', () => {
    expect(engine.matchEcho('WA_DOES_NOT_EXIST')).toBe(false);
  });

  // ── markEchoed: terminal + source_inbound_seq branch (lines 449-451) ──
  it('markEchoed completes the linked inbound when op is terminal and has source_inbound_seq', () => {
    const seq = engine.journalInbound('msg-echo', 'key-echo', '15550000001@s.whatsapp.net', 'agent');
    const opId = engine.createOutboundOp({
      conversationKey: 'key-echo', chatJid: '15550000001@s.whatsapp.net', opType: 'text',
      payload: '{"text":"hi"}', replayPolicy: 'safe', sourceInboundSeq: seq, isTerminal: true,
    });
    engine.markSubmitted(opId, 'WA_ECHO_1');
    engine.markEchoed(opId);
    const inbound = db.raw.prepare('SELECT processing_status, terminal_reason FROM inbound_events WHERE seq = ?').get(seq) as any;
    expect(inbound.processing_status).toBe('complete');
    expect(inbound.terminal_reason).toBe('response_sent');
  });

  it('markEchoed does not complete inbound when op is non-terminal', () => {
    const seq = engine.journalInbound('msg-echo-nt', 'key-echo-nt', '15550000002@s.whatsapp.net', 'agent');
    const opId = engine.createOutboundOp({
      conversationKey: 'key-echo-nt', chatJid: '15550000002@s.whatsapp.net', opType: 'text',
      payload: '{"text":"hi"}', replayPolicy: 'safe', sourceInboundSeq: seq, isTerminal: false,
    });
    engine.markSubmitted(opId, 'WA_ECHO_2');
    engine.markEchoed(opId);
    const inbound = db.raw.prepare('SELECT processing_status FROM inbound_events WHERE seq = ?').get(seq) as any;
    expect(inbound.processing_status).toBe('processing');
  });

  // ── completeTurn: transaction success with all write kinds (lines 381-401) ──
  it('completeTurn applies token accumulation, checkpoint, inbound completion, and terminal marking in one transaction', () => {
    db.raw.exec(
      `INSERT INTO agent_sessions (session_id, started_at, status, total_input_tokens, total_output_tokens)
       VALUES ('sess-1', datetime('now'), 'active', 0, 0)`,
    );
    const sessRow = db.raw.prepare('SELECT id FROM agent_sessions WHERE session_id = ?').get('sess-1') as any;
    const dbRowId = sessRow.id;

    const seq = engine.journalInbound('msg-ct', 'key-ct', '15550000003@s.whatsapp.net', 'agent');
    const opId = engine.createOutboundOp({
      conversationKey: 'key-ct', chatJid: '15550000003@s.whatsapp.net', opType: 'text',
      payload: '{"text":"hi"}', replayPolicy: 'safe', sourceInboundSeq: seq, isTerminal: true,
    });

    engine.completeTurn({
      sessionTokens: { dbRowId, inputTokens: 123, outputTokens: 456, cacheReadTokens: 0 },
      checkpoint: {
        conversationKey: 'key-ct',
        fields: { sessionId: 'sess-1', claudePid: 4242, sessionStatus: 'active' },
      },
      inbound: { seq, terminalReason: 'response_sent' },
      lastOpId: opId,
    });

    const sess = db.raw.prepare('SELECT total_input_tokens, total_output_tokens FROM agent_sessions WHERE id = ?').get(dbRowId) as any;
    expect(sess.total_input_tokens).toBe(123);
    expect(sess.total_output_tokens).toBe(456);

    const tokEv = db.raw.prepare('SELECT input_tokens, output_tokens FROM agent_token_events WHERE agent_session_id = ?').get(dbRowId) as any;
    expect(tokEv.input_tokens).toBe(123);
    expect(tokEv.output_tokens).toBe(456);

    const cp = db.raw.prepare('SELECT claude_pid, session_status FROM session_checkpoints WHERE conversation_key = ?').get('key-ct') as any;
    expect(cp.claude_pid).toBe(4242);
    expect(cp.session_status).toBe('active');

    const inbound = db.raw.prepare('SELECT processing_status FROM inbound_events WHERE seq = ?').get(seq) as any;
    expect(inbound.processing_status).toBe('complete');

    const op = db.raw.prepare('SELECT is_terminal FROM outbound_ops WHERE id = ?').get(opId) as any;
    expect(op.is_terminal).toBe(1);
  });

  it('completeTurn is a no-op when no write params are provided (early return)', () => {
    // No exceptions thrown, no transaction opened.
    expect(() => engine.completeTurn({})).not.toThrow();
    // Verify no recovery_runs side-effect or stray writes — checkpoint table empty.
    const cps = db.raw.prepare('SELECT COUNT(*) AS c FROM session_checkpoints').get() as any;
    expect(cps.c).toBe(0);
  });

  it('completeTurn rolls back and rethrows when a write fails mid-transaction', () => {
    db.raw.exec(
      `INSERT INTO agent_sessions (session_id, started_at, status, total_input_tokens, total_output_tokens)
       VALUES ('sess-rb', datetime('now'), 'active', 0, 0)`,
    );
    const sessRow = db.raw.prepare('SELECT id FROM agent_sessions WHERE session_id = ?').get('sess-rb') as any;
    const dbRowId = sessRow.id;

    // Drop the session_checkpoints table so the checkpoint upsert inside the txn fails,
    // forcing the catch+rollback path (lines 405-421).
    db.raw.exec('DROP TABLE session_checkpoints');

    expect(() => engine.completeTurn({
      sessionTokens: { dbRowId, inputTokens: 1, outputTokens: 2, cacheReadTokens: 0 },
      checkpoint: { conversationKey: 'key-rb', fields: { sessionStatus: 'active' } },
    })).toThrow();

    // Token accumulation must have been rolled back.
    const sess = db.raw.prepare('SELECT total_input_tokens FROM agent_sessions WHERE id = ?').get(dbRowId) as any;
    expect(sess.total_input_tokens).toBe(0);
  });

  // ── getResumableCheckpoints: active & suspended with session_id ──
  it('getResumableCheckpoints returns only active/suspended rows with a session_id', () => {
    engine.upsertSessionCheckpoint('key-resume-a', { sessionId: 's-a', sessionStatus: 'active' });
    engine.upsertSessionCheckpoint('key-resume-s', { sessionId: 's-s', sessionStatus: 'suspended' });
    engine.upsertSessionCheckpoint('key-resume-orphan', { sessionId: 's-o', sessionStatus: 'orphaned' });
    engine.upsertSessionCheckpoint('key-resume-nosession', { sessionStatus: 'active' });
    const rows = engine.getResumableCheckpoints();
    const keys = rows.map(r => r.conversation_key).sort();
    expect(keys).toEqual(['key-resume-a', 'key-resume-s']);
  });

  // ── preConnectRecovery: orphan session with dead pid (lines 563-584) ──
  it('preConnectRecovery marks an active checkpoint with a dead pid as orphaned', () => {
    // Use an impossibly-large PID that is guaranteed not to exist.
    engine.upsertSessionCheckpoint('key-orphan', { sessionId: 's-orphan', claudePid: 999_999_999, sessionStatus: 'active' });
    const stats = engine.preConnectRecovery();
    const cp = db.raw.prepare('SELECT session_status FROM session_checkpoints WHERE conversation_key = ?').get('key-orphan') as any;
    expect(cp.session_status).toBe('orphaned');
    expect(stats.outboundReconciled).toBe(0);
  });

  it('preConnectRecovery leaves an active checkpoint with a live pid as active', () => {
    // Current process PID is alive, so the checkpoint should not be orphaned.
    engine.upsertSessionCheckpoint('key-alive', { sessionId: 's-alive', claudePid: process.pid, sessionStatus: 'active' });
    engine.preConnectRecovery();
    const cp = db.raw.prepare('SELECT session_status FROM session_checkpoints WHERE conversation_key = ?').get('key-alive') as any;
    expect(cp.session_status).toBe('active');
  });

  it('preConnectRecovery skips orphan check when claude_pid is null', () => {
    engine.upsertSessionCheckpoint('key-nullpid', { sessionId: 's-null', claudePid: undefined, sessionStatus: 'active' });
    engine.preConnectRecovery();
    const cp = db.raw.prepare('SELECT session_status FROM session_checkpoints WHERE conversation_key = ?').get('key-nullpid') as any;
    expect(cp.session_status).toBe('active');
  });

  // ── preConnectRecovery: promote sending → maybe_sent (lines 587-596) ──
  it('preConnectRecovery promotes sending ops to maybe_sent', () => {
    const opId = engine.createOutboundOp({
      conversationKey: 'key-send', chatJid: '15550000004@s.whatsapp.net', opType: 'text',
      payload: '{"text":"a"}', replayPolicy: 'safe',
    });
    engine.markSending(opId);
    const stats = engine.preConnectRecovery();
    const op = db.raw.prepare('SELECT status, error FROM outbound_ops WHERE id = ?').get(opId) as any;
    expect(op.status).toBe('maybe_sent');
    expect(op.error).toBe('crash-in-flight');
    expect(stats.outboundReconciled).toBe(1);
  });

  // ── preConnectRecovery: tool-call recovery branches (lines 598-637) ──
  it('preConnectRecovery marks safe tool call (no outbound_op_id) as replayed', () => {
    db.raw.exec(
      `INSERT INTO tool_calls (conversation_key, tool_name, tool_input, status, replay_policy)
       VALUES ('key-tc-safe', 'read_file', '{}', 'executing', 'safe')`,
    );
    const stats = engine.preConnectRecovery();
    const tc = db.raw.prepare('SELECT status FROM tool_calls WHERE conversation_key = ?').get('key-tc-safe') as any;
    expect(tc.status).toBe('replayed');
    expect(stats.toolCallsRecovered).toBe(1);
    expect(stats.toolCallsReplayed).toBe(1);
  });

  it('preConnectRecovery marks read_only tool call as replayed', () => {
    db.raw.exec(
      `INSERT INTO tool_calls (conversation_key, tool_name, tool_input, status, replay_policy)
       VALUES ('key-tc-ro', 'list_files', '{}', 'executing', 'read_only')`,
    );
    engine.preConnectRecovery();
    const tc = db.raw.prepare('SELECT status FROM tool_calls WHERE conversation_key = ?').get('key-tc-ro') as any;
    expect(tc.status).toBe('replayed');
  });

  it('preConnectRecovery quarantines unsafe tool call with no outbound_op_id', () => {
    db.raw.exec(
      `INSERT INTO tool_calls (conversation_key, tool_name, tool_input, status, replay_policy)
       VALUES ('key-tc-uns', 'send_message', '{}', 'executing', 'unsafe')`,
    );
    const stats = engine.preConnectRecovery();
    const tc = db.raw.prepare('SELECT status FROM tool_calls WHERE conversation_key = ?').get('key-tc-uns') as any;
    expect(tc.status).toBe('quarantined');
    expect(stats.toolCallsQuarantined).toBe(1);
  });

  it('preConnectRecovery delegates tool call with outbound_op_id to outbound reconciliation', () => {
    const opId = engine.createOutboundOp({
      conversationKey: 'key-tc-op', chatJid: '15550000005@s.whatsapp.net', opType: 'text',
      payload: '{"text":"x"}', replayPolicy: 'unsafe',
    });
    db.raw.exec(
      `INSERT INTO tool_calls (conversation_key, tool_name, tool_input, status, replay_policy, outbound_op_id)
       VALUES ('key-tc-op', 'send_message', '{}', 'executing', 'unsafe', ${opId})`,
    );
    const stats = engine.preConnectRecovery();
    // Tool call is NOT replayed or quarantined — left for outbound reconciliation.
    const tc = db.raw.prepare('SELECT status FROM tool_calls WHERE conversation_key = ?').get('key-tc-op') as any;
    expect(tc.status).toBe('executing');
    expect(stats.toolCallsRecovered).toBe(1);
    expect(stats.toolCallsReplayed).toBe(0);
    expect(stats.toolCallsQuarantined).toBe(0);
  });

  // ── preConnectRecovery: processing-inbound branches (lines 639-662) ──
  it('preConnectRecovery marks processing inbound failed when no terminal op exists', () => {
    const seq = engine.journalInbound('msg-proc-noop', 'key-proc-noop', '15550000006@s.whatsapp.net', 'agent');
    // status is 'processing' as journalInbound inserts it that way
    engine.preConnectRecovery();
    const inbound = db.raw.prepare('SELECT processing_status FROM inbound_events WHERE seq = ?').get(seq) as any;
    expect(inbound.processing_status).toBe('failed');
  });

  it('preConnectRecovery leaves processing inbound when a terminal op exists', () => {
    const seq = engine.journalInbound('msg-proc-op', 'key-proc-op', '15550000007@s.whatsapp.net', 'agent');
    const opId = engine.createOutboundOp({
      conversationKey: 'key-proc-op', chatJid: '15550000007@s.whatsapp.net', opType: 'text',
      payload: '{"text":"r"}', replayPolicy: 'safe', sourceInboundSeq: seq, isTerminal: true,
    });
    engine.markTerminal(opId);
    engine.preConnectRecovery();
    const inbound = db.raw.prepare('SELECT processing_status FROM inbound_events WHERE seq = ?').get(seq) as any;
    expect(inbound.processing_status).toBe('processing');
  });

  // ── postConnectRecovery: stale submitted → maybe_sent (lines 696-708) ──
  // The stale op has no wa_message_id in `messages`, so within the same postConnect
  // pass Step 2 reconciles the just-promoted maybe_sent via its safe policy and
  // resets it to pending for replay. We assert the full observable outcome.
  it('postConnectRecovery promotes stale submitted ops then reconciles them in the same pass', () => {
    const opId = engine.createOutboundOp({
      conversationKey: 'key-stale', chatJid: '15550000008@s.whatsapp.net', opType: 'text',
      payload: '{"text":"s"}', replayPolicy: 'safe',
    });
    db.raw.exec(
      `UPDATE outbound_ops SET status='submitted', wa_message_id='WA_STALE_1', submitted_at=datetime('now','-60 seconds') WHERE id=${opId}`,
    );
    const stats = engine.postConnectRecovery();
    // BEAD-060: Step 2 (maybe_sent reconciliation) is the single counting site —
    // the stale-submitted promotion in Step 1 is no longer double-counted.
    expect(stats.outboundReconciled).toBe(1);
    expect(stats.outboundReplayed).toBe(1);
    const op = db.raw.prepare('SELECT status, error FROM outbound_ops WHERE id = ?').get(opId) as any;
    // Final state after safe reconciliation: reset to pending, error cleared.
    expect(op).toMatchObject({ status: 'pending', error: null });
  });

  // ── postConnectRecovery: maybe_sent with wa_message_id found in messages → echoed (lines 722-727) ──
  it('postConnectRecovery confirms maybe_sent when its wa_message_id is present in messages', () => {
    const opId = engine.createOutboundOp({
      conversationKey: 'key-found', chatJid: '15550000009@s.whatsapp.net', opType: 'text',
      payload: '{"text":"f"}', replayPolicy: 'safe',
    });
    db.raw.exec(
      `UPDATE outbound_ops SET status='maybe_sent', wa_message_id='WA_FOUND_1' WHERE id=${opId}`,
    );
    db.raw.exec(
      `INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, timestamp)
       VALUES ('15550000009@s.whatsapp.net', 'key-found', '15550000009@s.whatsapp.net', 'WA_FOUND_1', 1)`,
    );
    engine.postConnectRecovery();
    const op = db.raw.prepare('SELECT status FROM outbound_ops WHERE id = ?').get(opId) as any;
    expect(op.status).toBe('echoed');
  });

  // ── postConnectRecovery: maybe_sent with wa_id not found + safe → reset to pending (lines 728-735) ──
  it('postConnectRecovery resets maybe_sent (with wa_message_id, safe) to pending when not found', () => {
    const opId = engine.createOutboundOp({
      conversationKey: 'key-nf-safe', chatJid: '15550000010@s.whatsapp.net', opType: 'text',
      payload: '{"text":"n"}', replayPolicy: 'safe',
    });
    db.raw.exec(
      `UPDATE outbound_ops SET status='maybe_sent', wa_message_id='WA_NF_SAFE_1' WHERE id=${opId}`,
    );
    const stats = engine.postConnectRecovery();
    const op = db.raw.prepare('SELECT status, error FROM outbound_ops WHERE id = ?').get(opId) as any;
    expect(op.status).toBe('pending');
    expect(op.error).toBeNull();
    expect(stats.outboundReplayed).toBe(1);
  });

  // ── postConnectRecovery: maybe_sent with wa_id not found + unsafe → quarantined (lines 736-749) ──
  it('postConnectRecovery quarantines maybe_sent (with wa_message_id, unsafe) when not found', () => {
    const opId = engine.createOutboundOp({
      conversationKey: 'key-nf-uns', chatJid: '15550000011@s.whatsapp.net', opType: 'text',
      payload: '{"text":"u"}', replayPolicy: 'unsafe',
    });
    db.raw.exec(
      `UPDATE outbound_ops SET status='maybe_sent', wa_message_id='WA_NF_UNS_1' WHERE id=${opId}`,
    );
    const stats = engine.postConnectRecovery();
    const op = db.raw.prepare('SELECT status FROM outbound_ops WHERE id = ?').get(opId) as any;
    expect(op.status).toBe('quarantined');
    expect(stats.outboundQuarantined).toBe(1);
  });

  // ── postConnectRecovery: maybe_sent without wa_id + safe/read_only → reset pending (lines 750-758) ──
  it('postConnectRecovery resets maybe_sent (no wa_message_id, safe) to pending', () => {
    const opId = engine.createOutboundOp({
      conversationKey: 'key-nowa-safe', chatJid: '15550000012@s.whatsapp.net', opType: 'text',
      payload: '{"text":"p"}', replayPolicy: 'safe',
    });
    db.raw.exec(`UPDATE outbound_ops SET status='maybe_sent', wa_message_id=NULL WHERE id=${opId}`);
    const stats = engine.postConnectRecovery();
    const op = db.raw.prepare('SELECT status FROM outbound_ops WHERE id = ?').get(opId) as any;
    expect(op.status).toBe('pending');
    expect(stats.outboundReplayed).toBe(1);
  });

  it('postConnectRecovery resets maybe_sent (no wa_message_id, read_only) to pending', () => {
    const opId = engine.createOutboundOp({
      conversationKey: 'key-nowa-ro', chatJid: '15550000013@s.whatsapp.net', opType: 'text',
      payload: '{"text":"q"}', replayPolicy: 'read_only',
    });
    db.raw.exec(`UPDATE outbound_ops SET status='maybe_sent', wa_message_id=NULL WHERE id=${opId}`);
    engine.postConnectRecovery();
    const op = db.raw.prepare('SELECT status FROM outbound_ops WHERE id = ?').get(opId) as any;
    expect(op.status).toBe('pending');
  });

  // ── postConnectRecovery: maybe_sent without wa_id + unsafe → quarantined (lines 759-772) ──
  it('postConnectRecovery quarantines maybe_sent (no wa_message_id, unsafe)', () => {
    const opId = engine.createOutboundOp({
      conversationKey: 'key-nowa-uns', chatJid: '15550000014@s.whatsapp.net', opType: 'text',
      payload: '{"text":"v"}', replayPolicy: 'unsafe',
    });
    db.raw.exec(`UPDATE outbound_ops SET status='maybe_sent', wa_message_id=NULL WHERE id=${opId}`);
    const stats = engine.postConnectRecovery();
    const op = db.raw.prepare('SELECT status FROM outbound_ops WHERE id = ?').get(opId) as any;
    expect(op.status).toBe('quarantined');
    expect(stats.outboundQuarantined).toBe(1);
  });

  // ── sweepStaleSubmitted: count > 0 branch (lines 800-803) ──
  it('sweepStaleSubmitted promotes stale submitted ops and returns the count', () => {
    const opId = engine.createOutboundOp({
      conversationKey: 'key-sweep', chatJid: '15550000015@s.whatsapp.net', opType: 'text',
      payload: '{"text":"sw"}', replayPolicy: 'safe',
    });
    db.raw.exec(
      `UPDATE outbound_ops SET status='submitted', submitted_at=datetime('now','-60 seconds') WHERE id=${opId}`,
    );
    const count = engine.sweepStaleSubmitted();
    expect(count).toBe(1);
    const op = db.raw.prepare('SELECT status, error FROM outbound_ops WHERE id = ?').get(opId) as any;
    expect(op.status).toBe('maybe_sent');
    expect(op.error).toBe('echo_timeout');
  });

  it('sweepStaleSubmitted returns 0 when no stale ops exist', () => {
    expect(engine.sweepStaleSubmitted()).toBe(0);
  });

  // ── getHealthStats (lines 806-817) ──
  it('getHealthStats reports pending/quarantined counts and null lastRecoveryAt when no runs exist', () => {
    // One pending op (the active states counted: pending, sending, submitted, maybe_sent)
    engine.createOutboundOp({
      conversationKey: 'key-health-p', chatJid: '15550000016@s.whatsapp.net', opType: 'text',
      payload: '{"text":"hp"}', replayPolicy: 'safe',
    });
    // A separate op for quarantine.
    const quarantinedId = engine.createOutboundOp({
      conversationKey: 'key-health-q', chatJid: '15550000017@s.whatsapp.net', opType: 'text',
      payload: '{"text":"hq"}', replayPolicy: 'safe',
    });
    engine.markQuarantined(quarantinedId);
    const stats = engine.getHealthStats();
    // only pendingId remains in active set; quarantined op removed; no recovery run yet
    expect(stats).toMatchObject({ pendingOutbound: 1, quarantinedOutbound: 1, lastRecoveryAt: null });
  });

  it('getHealthStats reports lastRecoveryAt after postConnectRecovery logs a run', () => {
    engine.postConnectRecovery();
    const stats = engine.getHealthStats();
    expect(stats.lastRecoveryAt).not.toBeNull();
    expect(typeof stats.lastRecoveryAt).toBe('string');
  });

  // ── logRecoveryRun: success insert (lines 823-835) ──
  it('logRecoveryRun inserts a recovery_runs row with the provided stats', () => {
    engine.logRecoveryRun('unit_test', {
      inboundReplayed: 1, outboundReconciled: 2, outboundReplayed: 3, outboundQuarantined: 4,
      toolCallsRecovered: 5, toolCallsReplayed: 6, toolCallsQuarantined: 7, sessionsRestored: 8,
    });
    const row = db.raw.prepare(
      'SELECT trigger, inbound_replayed, outbound_quarantined, sessions_restored FROM recovery_runs ORDER BY id DESC LIMIT 1',
    ).get() as any;
    expect(row.trigger).toBe('unit_test');
    expect(row.inbound_replayed).toBe(1);
    expect(row.outbound_quarantined).toBe(4);
    expect(row.sessions_restored).toBe(8);
  });
});
