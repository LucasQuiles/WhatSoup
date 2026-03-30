/**
 * Tests for DurabilityEngine startup recovery engine.
 *
 * Covers the 4 residual risks from the spec:
 *  1. Crash after `sending` but before receipt → promoted to `maybe_sent`
 *  2. `executing` tool call with `outbound_op_id` set → delegates to outbound reconciliation
 *  3. History-sync timeout → reconciliation proceeds after 15 s (modelled via direct call)
 *  4. Inbound in `turn_done` with terminal op in `submitted` → left for post-reconnect
 *
 * Plus full coverage of preConnectRecovery() and postConnectRecovery() phases.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

/** Insert a raw message into the messages table (simulating an ingest echo). */
function insertMessage(db: Database, messageId: string, chatJid = 'jid-1@s.whatsapp.net'): void {
  db.raw.prepare(
    `INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content_type, is_from_me, timestamp)
     VALUES (?, ?, ?, ?, 'text', 1, ?)`,
  ).run(chatJid, chatJid, 'bot@s.whatsapp.net', messageId, Date.now());
}

/** Read a single row from tool_calls by id. */
function getToolCall(db: Database, id: number): Record<string, unknown> {
  return db.raw.prepare('SELECT * FROM tool_calls WHERE id = ?').get(id) as Record<string, unknown>;
}

/** Read a single row from outbound_ops by id. */
function getOutbound(db: Database, id: number): Record<string, unknown> {
  return db.raw.prepare('SELECT * FROM outbound_ops WHERE id = ?').get(id) as Record<string, unknown>;
}

/** Read a single row from inbound_events by seq. */
function getInbound(db: Database, seq: number): Record<string, unknown> {
  return db.raw.prepare('SELECT * FROM inbound_events WHERE seq = ?').get(seq) as Record<string, unknown>;
}

/** Backdate submitted_at on an outbound op to simulate a stale submission. */
function makeSubmittedStale(db: Database, id: number): void {
  db.raw.prepare(
    `UPDATE outbound_ops SET submitted_at = datetime('now', '-60 seconds') WHERE id = ?`,
  ).run(id);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

describe('DurabilityEngine — preConnectRecovery()', () => {
  let db: Database;
  let engine: DurabilityEngine;

  beforeEach(() => {
    db = makeDb();
    engine = new DurabilityEngine(db);
  });

  afterEach(() => { db.close(); });

  // ── Risk 1: crash-in-flight (sending → maybe_sent) ─────────────────────

  it('Risk 1: promotes all `sending` outbound ops to `maybe_sent`', () => {
    const id1 = engine.createOutboundOp({
      conversationKey: 'k1', chatJid: 'j1', opType: 'text',
      payload: '{"text":"hello"}', replayPolicy: 'safe',
    });
    engine.markSending(id1);

    const id2 = engine.createOutboundOp({
      conversationKey: 'k2', chatJid: 'j2', opType: 'text',
      payload: '{"text":"world"}', replayPolicy: 'unsafe',
    });
    engine.markSending(id2);

    const stats = engine.preConnectRecovery();

    expect(getOutbound(db, id1)['status']).toBe('maybe_sent');
    expect(getOutbound(db, id2)['status']).toBe('maybe_sent');
    expect(stats.outboundReconciled).toBe(2);
  });

  it('Risk 1: does not touch ops that are not in `sending` status', () => {
    const id = engine.createOutboundOp({
      conversationKey: 'k1', chatJid: 'j1', opType: 'text',
      payload: '{}', replayPolicy: 'unsafe',
    });
    // stays in pending
    engine.preConnectRecovery();
    expect(getOutbound(db, id)['status']).toBe('pending');
  });

  it('Risk 1: sets error to crash-in-flight on promoted ops', () => {
    const id = engine.createOutboundOp({
      conversationKey: 'k1', chatJid: 'j1', opType: 'text',
      payload: '{}', replayPolicy: 'safe',
    });
    engine.markSending(id);
    engine.preConnectRecovery();
    expect(getOutbound(db, id)['error']).toBe('crash-in-flight');
  });

  // ── Risk 2: executing tool call with outbound_op_id ────────────────────

  it('Risk 2: executing tool call with outbound_op_id is left for outbound reconciliation', () => {
    const inSeq = engine.journalInbound('msg-1', 'k1', 'j1@s.whatsapp.net', 'agent');
    const opId = engine.createOutboundOp({
      conversationKey: 'k1', chatJid: 'j1', opType: 'text',
      payload: '{}', replayPolicy: 'unsafe', sourceInboundSeq: inSeq,
    });
    engine.markSending(opId);

    const tcId = engine.recordToolCall('k1', 'send_message', '{}', 'unsafe');
    engine.markToolExecuting(tcId);
    // Manually set the outbound_op_id link (simulating markToolComplete called with opId)
    db.raw.prepare('UPDATE tool_calls SET outbound_op_id = ? WHERE id = ?').run(opId, tcId);

    engine.preConnectRecovery();

    // The outbound op gets promoted to maybe_sent (crash-in-flight)
    expect(getOutbound(db, opId)['status']).toBe('maybe_sent');
    // The tool call itself is still in 'executing' — the outbound op handles reconciliation
    // (not quarantined, not replayed)
    const tc = getToolCall(db, tcId);
    expect(tc['status']).toBe('executing');
    expect(tc['status']).not.toBe('quarantined');
    expect(tc['status']).not.toBe('replayed');
  });

  it('Risk 2: stats count tool calls with outbound_op_id as recovered', () => {
    const tcId = engine.recordToolCall('k1', 'send_message', '{}', 'unsafe');
    engine.markToolExecuting(tcId);
    db.raw.prepare('UPDATE tool_calls SET outbound_op_id = 999 WHERE id = ?').run(tcId);

    const stats = engine.preConnectRecovery();
    expect(stats.toolCallsRecovered).toBe(1);
    // Not counted as replayed or quarantined — delegated
    expect(stats.toolCallsReplayed).toBe(0);
    expect(stats.toolCallsQuarantined).toBe(0);
  });

  // ── Tool call recovery — safe vs unsafe ────────────────────────────────

  it('safe executing tool call (no outbound_op_id) is marked replayed', () => {
    const tcId = engine.recordToolCall('k1', 'safe_tool', '{}', 'safe');
    engine.markToolExecuting(tcId);

    const stats = engine.preConnectRecovery();

    expect(getToolCall(db, tcId)['status']).toBe('replayed');
    expect(stats.toolCallsReplayed).toBe(1);
    expect(stats.toolCallsQuarantined).toBe(0);
  });

  it('unsafe executing tool call (no outbound_op_id) is quarantined', () => {
    const tcId = engine.recordToolCall('k1', 'unsafe_tool', '{}', 'unsafe');
    engine.markToolExecuting(tcId);

    const stats = engine.preConnectRecovery();

    expect(getToolCall(db, tcId)['status']).toBe('quarantined');
    expect(stats.toolCallsQuarantined).toBe(1);
    expect(stats.toolCallsReplayed).toBe(0);
  });

  it('read_only executing tool call (no outbound_op_id) is replayed (same as safe)', () => {
    const tcId = engine.recordToolCall('k1', 'ro_tool', '{}', 'read_only');
    engine.markToolExecuting(tcId);

    const stats = engine.preConnectRecovery();

    expect(getToolCall(db, tcId)['status']).toBe('replayed');
    expect(stats.toolCallsReplayed).toBe(1);
    expect(stats.toolCallsQuarantined).toBe(0);
  });

  it('completed tool calls are not touched by recovery', () => {
    const tcId = engine.recordToolCall('k1', 'completed_tool', '{}', 'unsafe');
    engine.markToolExecuting(tcId);
    engine.markToolComplete(tcId, '{"ok":true}');

    engine.preConnectRecovery();
    expect(getToolCall(db, tcId)['status']).toBe('complete');
  });

  // ── Inbound events recovery ────────────────────────────────────────────

  it('inbound in `processing` with no terminal outbound op is marked failed', () => {
    const seq = engine.journalInbound('msg-1', 'k1', 'j1@s.whatsapp.net', 'agent');
    // processing status set by journalInbound

    engine.preConnectRecovery();

    expect(getInbound(db, seq)['processing_status']).toBe('failed');
  });

  it('inbound in `processing` with a live terminal outbound op is left untouched', () => {
    const seq = engine.journalInbound('msg-2', 'k1', 'j1@s.whatsapp.net', 'agent');
    // Create a terminal outbound op linked to this inbound (simulating mid-flight)
    engine.createOutboundOp({
      conversationKey: 'k1', chatJid: 'j1', opType: 'text',
      payload: '{}', replayPolicy: 'safe',
      sourceInboundSeq: seq, isTerminal: true,
    });

    engine.preConnectRecovery();

    // Inbound should still be in processing (the outbound is now maybe_sent, not quarantined)
    expect(getInbound(db, seq)['processing_status']).toBe('processing');
  });

  it('inbound in `turn_done` is not touched by preConnect (Risk 4: left for post-reconnect)', () => {
    const seq = engine.journalInbound('msg-3', 'k1', 'j1@s.whatsapp.net', 'agent');
    engine.markTurnDone(seq);

    // Also set up a terminal op in `submitted`
    const opId = engine.createOutboundOp({
      conversationKey: 'k1', chatJid: 'j1', opType: 'text',
      payload: '{}', replayPolicy: 'safe',
      sourceInboundSeq: seq, isTerminal: true,
    });
    engine.markSending(opId);
    engine.markSubmitted(opId, 'WA_MSG_999');

    engine.preConnectRecovery();

    // turn_done inbound is not processed by preConnect
    expect(getInbound(db, seq)['processing_status']).toBe('turn_done');
    // The submitted op gets promoted to maybe_sent (it was not in sending, so actually left as submitted)
    // Actually: markSubmitted was called after markSending, so status = 'submitted' at preConnect time
    expect(getOutbound(db, opId)['status']).toBe('submitted');
  });

  // ── Orphan detection ───────────────────────────────────────────────────

  it('marks session orphaned when claude_pid is dead', () => {
    // Use PID 1 (init/systemd) — always running, but we need a definitely dead PID.
    // Use a very high PID that almost certainly doesn't exist.
    const deadPid = 9_999_999;
    engine.upsertSessionCheckpoint('conv-1', { claudePid: deadPid, sessionStatus: 'active' });

    engine.preConnectRecovery();

    const row = engine.getSessionCheckpoint('conv-1');
    expect(row!.session_status).toBe('orphaned');
  });

  it('does not orphan session when claude_pid is alive (current process)', () => {
    engine.upsertSessionCheckpoint('conv-1', { claudePid: process.pid, sessionStatus: 'active' });

    engine.preConnectRecovery();

    const row = engine.getSessionCheckpoint('conv-1');
    expect(row!.session_status).toBe('active');
  });

  it('does not orphan session when claude_pid is null', () => {
    engine.upsertSessionCheckpoint('conv-1', { sessionStatus: 'active' }); // no pid
    engine.preConnectRecovery();
    const row = engine.getSessionCheckpoint('conv-1');
    expect(row!.session_status).toBe('active');
  });

  // ── Returns stats ──────────────────────────────────────────────────────

  it('returns zeroed stats when nothing to recover', () => {
    const stats = engine.preConnectRecovery();
    expect(stats.outboundReconciled).toBe(0);
    expect(stats.outboundReplayed).toBe(0);
    expect(stats.outboundQuarantined).toBe(0);
    expect(stats.toolCallsRecovered).toBe(0);
    expect(stats.toolCallsReplayed).toBe(0);
    expect(stats.toolCallsQuarantined).toBe(0);
    expect(stats.sessionsRestored).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('DurabilityEngine — postConnectRecovery()', () => {
  let db: Database;
  let engine: DurabilityEngine;

  beforeEach(() => {
    db = makeDb();
    engine = new DurabilityEngine(db);
  });

  afterEach(() => { db.close(); });

  // ── maybe_sent reconciliation via messages table ───────────────────────

  it('maybe_sent op with wa_message_id found in messages table → echoed', () => {
    const seq = engine.journalInbound('msg-in-1', 'k1', 'j1@s.whatsapp.net', 'agent');
    engine.markTurnDone(seq);
    const opId = engine.createOutboundOp({
      conversationKey: 'k1', chatJid: 'j1', opType: 'text',
      payload: '{}', replayPolicy: 'unsafe',
      sourceInboundSeq: seq, isTerminal: true,
    });
    engine.markSending(opId);
    engine.markSubmitted(opId, 'WA_MSG_FOUND_1');
    engine.markMaybeSent(opId, 'crash-in-flight');

    // Simulate the echo arriving via normal ingest
    insertMessage(db, 'WA_MSG_FOUND_1');

    const stats = engine.postConnectRecovery();

    expect(getOutbound(db, opId)['status']).toBe('echoed');
    expect(stats.outboundReconciled).toBeGreaterThanOrEqual(1);
    // The terminal op echoed → inbound should be complete
    expect(getInbound(db, seq)['processing_status']).toBe('complete');
  });

  it('maybe_sent op with wa_message_id NOT found + safe → reset to pending for replay', () => {
    const opId = engine.createOutboundOp({
      conversationKey: 'k1', chatJid: 'j1', opType: 'text',
      payload: '{}', replayPolicy: 'safe',
    });
    engine.markSending(opId);
    engine.markSubmitted(opId, 'WA_MSG_NOT_FOUND');
    engine.markMaybeSent(opId, 'crash');

    const stats = engine.postConnectRecovery();

    expect(getOutbound(db, opId)['status']).toBe('pending');
    expect(stats.outboundReplayed).toBe(1);
    expect(stats.outboundQuarantined).toBe(0);
  });

  it('maybe_sent op with wa_message_id NOT found + unsafe → quarantined', () => {
    const opId = engine.createOutboundOp({
      conversationKey: 'k1', chatJid: 'j1', opType: 'text',
      payload: '{}', replayPolicy: 'unsafe',
    });
    engine.markSending(opId);
    engine.markSubmitted(opId, 'WA_MSG_UNSAFE');
    engine.markMaybeSent(opId, 'crash');

    const stats = engine.postConnectRecovery();

    expect(getOutbound(db, opId)['status']).toBe('quarantined');
    expect(stats.outboundQuarantined).toBe(1);
    expect(stats.outboundReplayed).toBe(0);
  });

  // ── maybe_sent with no wa_message_id ──────────────────────────────────

  it('maybe_sent op with no wa_message_id + safe → reset to pending', () => {
    const opId = engine.createOutboundOp({
      conversationKey: 'k1', chatJid: 'j1', opType: 'text',
      payload: '{}', replayPolicy: 'safe',
    });
    engine.markSending(opId);
    engine.markMaybeSent(opId, 'crash-in-flight');
    // no wa_message_id was set

    const stats = engine.postConnectRecovery();

    expect(getOutbound(db, opId)['status']).toBe('pending');
    expect(stats.outboundReplayed).toBe(1);
  });

  it('maybe_sent op with no wa_message_id + unsafe → quarantined', () => {
    const opId = engine.createOutboundOp({
      conversationKey: 'k1', chatJid: 'j1', opType: 'text',
      payload: '{}', replayPolicy: 'unsafe',
    });
    engine.markSending(opId);
    engine.markMaybeSent(opId, 'crash-in-flight');

    const stats = engine.postConnectRecovery();

    expect(getOutbound(db, opId)['status']).toBe('quarantined');
    expect(stats.outboundQuarantined).toBe(1);
  });

  // ── Risk 3: history-sync timeout scenario ─────────────────────────────

  it('Risk 3: postConnect runs correctly even when called immediately (no history sync)', () => {
    // This test models the 15s timeout path — history sync never fires,
    // so postConnectRecovery() is called. It should still reconcile correctly.
    const opId = engine.createOutboundOp({
      conversationKey: 'k1', chatJid: 'j1', opType: 'text',
      payload: '{}', replayPolicy: 'safe',
    });
    engine.markSending(opId);
    engine.markSubmitted(opId, 'WA_TIMEOUT_MSG');
    engine.markMaybeSent(opId, 'crash');
    // No matching message inserted (history didn't sync before timeout)

    // Should not throw; should gracefully handle the not-found case
    expect(() => engine.postConnectRecovery()).not.toThrow();
    expect(getOutbound(db, opId)['status']).toBe('pending'); // safe → replayed
  });

  // ── Risk 4: turn_done with submitted terminal op ───────────────────────

  it('Risk 4: inbound in turn_done with terminal op in submitted → postConnect promotes and reconciles in one pass', () => {
    const seq = engine.journalInbound('msg-td-1', 'k1', 'j1@s.whatsapp.net', 'agent');
    engine.markTurnDone(seq);
    const opId = engine.createOutboundOp({
      conversationKey: 'k1', chatJid: 'j1', opType: 'text',
      payload: '{}', replayPolicy: 'safe',
      sourceInboundSeq: seq, isTerminal: true,
    });
    engine.markSending(opId);
    engine.markSubmitted(opId, 'WA_STALE_1');
    makeSubmittedStale(db, opId);

    // postConnect promotes stale submitted → maybe_sent (Step 1), then reconciles
    // immediately in the same pass (Step 2): safe + wa_message_id not in messages → pending
    engine.postConnectRecovery();

    expect(getOutbound(db, opId)['status']).toBe('pending');
    // inbound is still turn_done — it's left for next cycle
    expect(getInbound(db, seq)['processing_status']).toBe('turn_done');
  });

  // ── Stale submitted promotion ──────────────────────────────────────────

  it('promotes stale `submitted` ops and immediately reconciles them in the same pass', () => {
    // id1: unsafe + has wa_message_id → promoted to maybe_sent then quarantined (not in messages)
    const id1 = engine.createOutboundOp({
      conversationKey: 'k1', chatJid: 'j1', opType: 'text',
      payload: '{"text":"a"}', replayPolicy: 'unsafe',
    });
    engine.markSending(id1);
    engine.markSubmitted(id1, 'WA_STALE_A');
    makeSubmittedStale(db, id1);

    // id2: safe + no wa_message_id → promoted to maybe_sent then reset to pending
    const id2 = engine.createOutboundOp({
      conversationKey: 'k2', chatJid: 'j2', opType: 'text',
      payload: '{"text":"b"}', replayPolicy: 'safe',
    });
    engine.markSending(id2);
    engine.markSubmitted(id2, null);
    makeSubmittedStale(db, id2);

    engine.postConnectRecovery();

    expect(getOutbound(db, id1)['status']).toBe('quarantined');
    expect(getOutbound(db, id2)['status']).toBe('pending');
  });

  it('does not touch echoed or failed_permanent ops', () => {
    const id = engine.createOutboundOp({
      conversationKey: 'k1', chatJid: 'j1', opType: 'text',
      payload: '{}', replayPolicy: 'unsafe',
    });
    engine.markSending(id);
    engine.markSubmitted(id, 'WA_ECHOED');
    engine.markEchoed(id);

    engine.postConnectRecovery();
    expect(getOutbound(db, id)['status']).toBe('echoed');
  });

  // ── recovery_runs logging ──────────────────────────────────────────────

  it('inserts a recovery_runs row after postConnectRecovery', () => {
    engine.postConnectRecovery();

    const row = db.raw.prepare('SELECT * FROM recovery_runs ORDER BY id DESC LIMIT 1').get() as any;
    expect(row).toBeDefined();
    expect(row.trigger).toBe('post_connect');
    expect(row.completed_at).not.toBeNull();
  });

  it('returns zeroed stats when nothing to reconcile', () => {
    const stats = engine.postConnectRecovery();
    expect(stats.outboundReconciled).toBe(0);
    expect(stats.outboundReplayed).toBe(0);
    expect(stats.outboundQuarantined).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('DurabilityEngine — logRecoveryRun()', () => {
  let db: Database;
  let engine: DurabilityEngine;

  beforeEach(() => {
    db = makeDb();
    engine = new DurabilityEngine(db);
  });

  afterEach(() => { db.close(); });

  it('inserts a row with all stat columns', () => {
    const stats = {
      inboundReplayed: 1,
      outboundReconciled: 2,
      outboundReplayed: 3,
      outboundQuarantined: 4,
      toolCallsRecovered: 5,
      toolCallsReplayed: 6,
      toolCallsQuarantined: 7,
      sessionsRestored: 8,
    };

    engine.logRecoveryRun('pre_connect', stats);

    const row = db.raw.prepare('SELECT * FROM recovery_runs WHERE trigger = ?').get('pre_connect') as any;
    expect(row).toBeDefined();
    expect(row.inbound_replayed).toBe(1);
    expect(row.outbound_reconciled).toBe(2);
    expect(row.outbound_replayed).toBe(3);
    expect(row.outbound_quarantined).toBe(4);
    expect(row.tool_calls_recovered).toBe(5);
    expect(row.tool_calls_replayed).toBe(6);
    expect(row.tool_calls_quarantined).toBe(7);
    expect(row.sessions_restored).toBe(8);
    expect(row.completed_at).not.toBeNull();
  });

  it('supports multiple recovery run logs', () => {
    const zeroStats = {
      inboundReplayed: 0, outboundReconciled: 0, outboundReplayed: 0,
      outboundQuarantined: 0, toolCallsRecovered: 0, toolCallsReplayed: 0,
      toolCallsQuarantined: 0, sessionsRestored: 0,
    };
    engine.logRecoveryRun('startup', zeroStats);
    engine.logRecoveryRun('startup', zeroStats);

    const rows = db.raw.prepare('SELECT * FROM recovery_runs').all() as any[];
    expect(rows).toHaveLength(2);
  });

  it('does not throw on arbitrary trigger strings', () => {
    const zeroStats = {
      inboundReplayed: 0, outboundReconciled: 0, outboundReplayed: 0,
      outboundQuarantined: 0, toolCallsRecovered: 0, toolCallsReplayed: 0,
      toolCallsQuarantined: 0, sessionsRestored: 0,
    };
    expect(() => engine.logRecoveryRun('manual_admin_trigger', zeroStats)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Full end-to-end recovery scenario
// ---------------------------------------------------------------------------

describe('DurabilityEngine — end-to-end recovery scenario', () => {
  let db: Database;
  let engine: DurabilityEngine;

  beforeEach(() => {
    db = makeDb();
    engine = new DurabilityEngine(db);
  });

  afterEach(() => { db.close(); });

  it('full crash-and-recovery cycle: sending → maybe_sent → echoed via messages table', () => {
    // Simulate: inbound arrived, outbound created, sending state, then crash
    const seq = engine.journalInbound('msg-full-1', 'k1', 'j1@s.whatsapp.net', 'agent');
    engine.markTurnDone(seq);
    const opId = engine.createOutboundOp({
      conversationKey: 'k1', chatJid: 'j1', opType: 'text',
      payload: '{"text":"reply"}', replayPolicy: 'unsafe',
      sourceInboundSeq: seq, isTerminal: true,
    });
    engine.markSending(opId);
    // ↑ crash here — op is stuck in `sending`

    // --- Restart ---
    // Phase 1: preConnectRecovery
    const preStats = engine.preConnectRecovery();
    expect(getOutbound(db, opId)['status']).toBe('maybe_sent');
    expect(preStats.outboundReconciled).toBe(1);

    // Simulate the message arriving via history sync (echo)
    insertMessage(db, 'wa-msg-reply-1');
    // Fix: the op needs a wa_message_id to be matched — simulate markSubmitted happened before crash
    db.raw.prepare('UPDATE outbound_ops SET wa_message_id = ? WHERE id = ?').run('wa-msg-reply-1', opId);

    // Phase 2: postConnectRecovery (after history sync + grace period)
    const postStats = engine.postConnectRecovery();

    expect(getOutbound(db, opId)['status']).toBe('echoed');
    // Terminal op echoed → inbound complete
    expect(getInbound(db, seq)['processing_status']).toBe('complete');
    // Recovery run logged
    const runRow = db.raw.prepare('SELECT * FROM recovery_runs WHERE trigger = ?').get('post_connect') as any;
    expect(runRow).toBeDefined();
    expect(postStats.outboundReconciled).toBeGreaterThanOrEqual(1);
  });

  it('mixed scenario: one echoed, one quarantined, one replayed', () => {
    // Op 1: safe, no wa_message_id → pending (replay)
    const op1 = engine.createOutboundOp({
      conversationKey: 'k1', chatJid: 'j1', opType: 'text',
      payload: '{"text":"safe"}', replayPolicy: 'safe',
    });
    engine.markSending(op1);
    engine.markMaybeSent(op1, 'crash');

    // Op 2: unsafe, wa_message_id found in messages → echoed
    const op2 = engine.createOutboundOp({
      conversationKey: 'k1', chatJid: 'j1', opType: 'text',
      payload: '{"text":"unsafe-sent"}', replayPolicy: 'unsafe',
    });
    engine.markSending(op2);
    db.raw.prepare('UPDATE outbound_ops SET status = ?, wa_message_id = ? WHERE id = ?')
      .run('maybe_sent', 'WA_CONFIRMED', op2);
    insertMessage(db, 'WA_CONFIRMED');

    // Op 3: unsafe, wa_message_id not found → quarantined
    const op3 = engine.createOutboundOp({
      conversationKey: 'k2', chatJid: 'j2', opType: 'text',
      payload: '{"text":"unsafe-lost"}', replayPolicy: 'unsafe',
    });
    engine.markSending(op3);
    db.raw.prepare('UPDATE outbound_ops SET status = ?, wa_message_id = ? WHERE id = ?')
      .run('maybe_sent', 'WA_LOST', op3);
    // WA_LOST not inserted into messages

    const stats = engine.postConnectRecovery();

    expect(getOutbound(db, op1)['status']).toBe('pending');   // safe → replayed
    expect(getOutbound(db, op2)['status']).toBe('echoed');     // confirmed
    expect(getOutbound(db, op3)['status']).toBe('quarantined'); // lost

    expect(stats.outboundReplayed).toBe(1);
    expect(stats.outboundQuarantined).toBe(1);
    expect(stats.outboundReconciled).toBe(3);
  });
});
