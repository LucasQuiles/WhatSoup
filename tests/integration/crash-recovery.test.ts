/**
 * Integration Tests — Crash Recovery Scenarios
 *
 * These tests simulate realistic crash/restart sequences using real in-memory
 * SQLite. Each scenario covers a multi-step state machine transition that spans
 * both preConnectRecovery() and postConnectRecovery() phases.
 *
 * Focus: end-to-end story coverage, not individual method behavior. Unit-level
 * recovery tests live in tests/core/durability-recovery.test.ts.
 *
 * Scenarios:
 *   1. Crash after `sending` — preConnect promotes to maybe_sent
 *   2. Executing tool call with outbound_op_id — delegates to outbound path
 *   3. History sync timeout — postConnect works without history sync signal
 *   4. turn_done with submitted terminal op — pre leaves it, post promotes it
 *   5. Full round-trip — happy path journal → send → submit → echo → complete
 *   6. maybe_sent with wa_message_id match — postConnect reconciles to echoed
 *   7. historySyncComplete race — timeout vs. event (fake timers)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Database } from '../../src/core/database.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEngine(): { db: Database; engine: DurabilityEngine } {
  const db = new Database(':memory:');
  db.open();
  const engine = new DurabilityEngine(db);
  return { db, engine };
}

/** Insert a row into the messages table simulating an echo arriving via ingest. */
function ingestEcho(db: Database, messageId: string, chatJid = 'g1@g.us'): void {
  db.raw.prepare(
    `INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content_type, is_from_me, timestamp)
     VALUES (?, ?, ?, ?, 'text', 1, ?)`,
  ).run(chatJid, chatJid, 'bot@s.whatsapp.net', messageId, Date.now());
}

function getOutbound(db: Database, id: number): Record<string, unknown> {
  return db.raw.prepare('SELECT * FROM outbound_ops WHERE id = ?').get(id) as Record<string, unknown>;
}

function getInbound(db: Database, seq: number): Record<string, unknown> {
  return db.raw.prepare('SELECT * FROM inbound_events WHERE seq = ?').get(seq) as Record<string, unknown>;
}

/** Backdate submitted_at to simulate a stale op from before the current session window. */
function makeSubmittedStale(db: Database, id: number): void {
  db.raw.prepare(
    `UPDATE outbound_ops SET submitted_at = datetime('now', '-60 seconds') WHERE id = ?`,
  ).run(id);
}

function getToolCall(db: Database, id: number): Record<string, unknown> {
  return db.raw.prepare('SELECT * FROM tool_calls WHERE id = ?').get(id) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------

describe('Crash Recovery — Scenario 1: crash after `sending`', () => {
  let db: Database;
  let engine: DurabilityEngine;

  beforeEach(() => { ({ db, engine } = makeEngine()); });
  afterEach(() => { db.close(); });

  it('sending op is promoted to maybe_sent with crash-in-flight error on preConnectRecovery', () => {
    // Simulate: agent started a send, marked the op `sending`, then process died
    const seq = engine.journalInbound('msg-crash-1', 'chat-A', 'chat-A@s.whatsapp.net', 'agent');
    engine.markTurnDone(seq);
    const opId = engine.createOutboundOp({
      conversationKey: 'chat-A', chatJid: 'chat-A@s.whatsapp.net', opType: 'text',
      payload: '{"text":"reply to user"}', replayPolicy: 'unsafe',
      sourceInboundSeq: seq, isTerminal: true,
    });
    engine.markSending(opId);
    // ↑ crash here — process dies before markSubmitted

    // --- Restart: Phase 1 ---
    const stats = engine.preConnectRecovery();

    const op = getOutbound(db, opId);
    expect(op['status']).toBe('maybe_sent');
    expect(op['error']).toBe('crash-in-flight');
    expect(stats.outboundReconciled).toBe(1);

    // The inbound is still turn_done — it has a terminal op that is now maybe_sent,
    // so preConnect leaves it for post-connect resolution
    const inbound = getInbound(db, seq);
    expect(inbound['processing_status']).toBe('turn_done');
  });

  it('two concurrent sends both promoted on preConnect', () => {
    const op1 = engine.createOutboundOp({
      conversationKey: 'chat-B', chatJid: 'chat-B@s.whatsapp.net', opType: 'text',
      payload: '{"text":"first"}', replayPolicy: 'safe',
    });
    const op2 = engine.createOutboundOp({
      conversationKey: 'chat-C', chatJid: 'chat-C@s.whatsapp.net', opType: 'text',
      payload: '{"text":"second"}', replayPolicy: 'unsafe',
    });
    engine.markSending(op1);
    engine.markSending(op2);

    const stats = engine.preConnectRecovery();

    expect(getOutbound(db, op1)['status']).toBe('maybe_sent');
    expect(getOutbound(db, op2)['status']).toBe('maybe_sent');
    expect(stats.outboundReconciled).toBe(2);
  });
});

// ---------------------------------------------------------------------------

describe('Crash Recovery — Scenario 2: executing tool call with outbound_op_id', () => {
  let db: Database;
  let engine: DurabilityEngine;

  beforeEach(() => { ({ db, engine } = makeEngine()); });
  afterEach(() => { db.close(); });

  it('executing tool call linked to sending op delegates to outbound reconciliation', () => {
    // Simulate: tool_call was executing (in-flight), op was in sending state
    const seq = engine.journalInbound('msg-tool-1', 'chat-D', 'chat-D@s.whatsapp.net', 'agent');
    const opId = engine.createOutboundOp({
      conversationKey: 'chat-D', chatJid: 'chat-D@s.whatsapp.net', opType: 'text',
      payload: '{"text":"tool result"}', replayPolicy: 'unsafe',
      sourceInboundSeq: seq, isTerminal: true,
    });
    engine.markSending(opId);

    const tcId = engine.recordToolCall('chat-D', 'send_whatsapp_message', '{"text":"tool result"}', 'unsafe');
    engine.markToolExecuting(tcId);
    // Link the tool call to the outbound op (as markToolComplete would do)
    db.raw.prepare('UPDATE tool_calls SET outbound_op_id = ? WHERE id = ?').run(opId, tcId);
    // ↑ crash here — op in `sending`, tool_call in `executing` with outbound_op_id

    const stats = engine.preConnectRecovery();

    // The outbound op is promoted (crash-in-flight reconciliation)
    expect(getOutbound(db, opId)['status']).toBe('maybe_sent');

    // The tool call is still `executing` — not quarantined, not replayed.
    // Its fate is determined by the outbound op reconciliation, not standalone.
    const tc = getToolCall(db, tcId);
    expect(tc['status']).toBe('executing');
    expect(tc['status']).not.toBe('quarantined');
    expect(tc['status']).not.toBe('replayed');

    // Recovery counts the tool call as recovered (handled via delegation)
    expect(stats.toolCallsRecovered).toBe(1);
    expect(stats.toolCallsReplayed).toBe(0);
    expect(stats.toolCallsQuarantined).toBe(0);
  });

  it('executing tool call WITHOUT outbound_op_id + unsafe is quarantined independently', () => {
    // Contrast: a bare unsafe tool call with no linked outbound op is quarantined directly
    const tcId = engine.recordToolCall('chat-E', 'delete_message', '{"id":"X"}', 'unsafe');
    engine.markToolExecuting(tcId);
    // No outbound_op_id linkage

    const stats = engine.preConnectRecovery();

    expect(getToolCall(db, tcId)['status']).toBe('quarantined');
    expect(stats.toolCallsQuarantined).toBe(1);
    expect(stats.toolCallsRecovered).toBe(1); // still counted as recovered (via quarantine)
  });
});

// ---------------------------------------------------------------------------

describe('Crash Recovery — Scenario 3: history sync timeout', () => {
  let db: Database;
  let engine: DurabilityEngine;

  beforeEach(() => { ({ db, engine } = makeEngine()); });
  afterEach(() => { db.close(); });

  it('postConnectRecovery runs correctly when history never synced (timeout path)', () => {
    // Simulate: op went maybe_sent, but 15s history-sync timeout fired before any
    // echo arrived — postConnectRecovery called directly without waiting further.
    const seq = engine.journalInbound('msg-timeout-1', 'chat-F', 'chat-F@s.whatsapp.net', 'agent');
    engine.markTurnDone(seq);
    const opId = engine.createOutboundOp({
      conversationKey: 'chat-F', chatJid: 'chat-F@s.whatsapp.net', opType: 'text',
      payload: '{"text":"safe to replay"}', replayPolicy: 'safe',
      sourceInboundSeq: seq, isTerminal: true,
    });
    engine.markSending(opId);
    engine.markSubmitted(opId, 'WA-TIMEOUT-MSG-1');
    engine.markMaybeSent(opId, 'history-sync-timeout');
    // No echo arrived — messages table has no matching row

    // Should not throw; safely handles the not-found case
    let stats: ReturnType<typeof engine.postConnectRecovery> | undefined;
    expect(() => { stats = engine.postConnectRecovery(); }).not.toThrow();

    // Safe op with no match is replayed (reset to pending)
    expect(getOutbound(db, opId)['status']).toBe('pending');
    expect(stats!.outboundReplayed).toBe(1);
    expect(stats!.outboundQuarantined).toBe(0);
  });

  it('postConnectRecovery correctly reconciles multiple ops regardless of history sync', () => {
    // Mixed bag: one safe (replay), one unsafe (quarantine), one with echo match
    const op1 = engine.createOutboundOp({
      conversationKey: 'chat-G', chatJid: 'chat-G@s.whatsapp.net', opType: 'text',
      payload: '{"text":"safe-no-echo"}', replayPolicy: 'safe',
    });
    engine.markSending(op1);
    engine.markMaybeSent(op1, 'history-sync-timeout');

    const op2 = engine.createOutboundOp({
      conversationKey: 'chat-G', chatJid: 'chat-G@s.whatsapp.net', opType: 'text',
      payload: '{"text":"unsafe-no-echo"}', replayPolicy: 'unsafe',
    });
    engine.markSending(op2);
    db.raw.prepare("UPDATE outbound_ops SET status='maybe_sent', wa_message_id='WA-LOST' WHERE id=?").run(op2);
    // WA-LOST never arrives in messages

    const op3 = engine.createOutboundOp({
      conversationKey: 'chat-H', chatJid: 'chat-H@s.whatsapp.net', opType: 'text',
      payload: '{"text":"confirmed"}', replayPolicy: 'unsafe',
    });
    engine.markSending(op3);
    db.raw.prepare("UPDATE outbound_ops SET status='maybe_sent', wa_message_id='WA-CONFIRMED' WHERE id=?").run(op3);
    ingestEcho(db, 'WA-CONFIRMED', 'chat-H@s.whatsapp.net');

    const stats = engine.postConnectRecovery();

    expect(getOutbound(db, op1)['status']).toBe('pending');       // safe → replayed
    expect(getOutbound(db, op2)['status']).toBe('quarantined');   // unsafe, no echo
    expect(getOutbound(db, op3)['status']).toBe('echoed');         // confirmed via messages
    expect(stats.outboundReplayed).toBe(1);
    expect(stats.outboundQuarantined).toBe(1);
    expect(stats.outboundReconciled).toBe(3);
  });
});

// ---------------------------------------------------------------------------

describe('Crash Recovery — Scenario 4: turn_done with submitted terminal op', () => {
  let db: Database;
  let engine: DurabilityEngine;

  beforeEach(() => { ({ db, engine } = makeEngine()); });
  afterEach(() => { db.close(); });

  it('preConnect leaves turn_done inbound; first postConnect promotes submitted and reconciles in one pass', () => {
    // Simulate: agent finished its turn (markTurnDone), terminal op submitted,
    // then crash before echo arrived.
    //
    // postConnectRecovery() runs in two phases internally:
    //   Step 1 — promote stale submitted → maybe_sent
    //   Step 2 — reconcile all maybe_sent ops (including those just promoted)
    // Ops that are `submitted` at call time get promoted AND reconciled in the same
    // pass: safe + wa_message_id not in messages → reset to pending for replay.
    const seq = engine.journalInbound('msg-td-crash-1', 'chat-I', 'chat-I@s.whatsapp.net', 'agent');
    engine.markTurnDone(seq);
    const opId = engine.createOutboundOp({
      conversationKey: 'chat-I', chatJid: 'chat-I@s.whatsapp.net', opType: 'text',
      payload: '{"text":"final answer"}', replayPolicy: 'safe',
      sourceInboundSeq: seq, isTerminal: true,
    });
    engine.markSending(opId);
    engine.markSubmitted(opId, 'WA-TD-SAFE-1');
    makeSubmittedStale(db, opId);
    // ↑ crash here — op in `submitted`, inbound in `turn_done`

    // Phase 1: preConnect — turn_done inbound is untouched; submitted op stays submitted
    engine.preConnectRecovery();

    expect(getInbound(db, seq)['processing_status']).toBe('turn_done');
    expect(getOutbound(db, opId)['status']).toBe('submitted');

    // Phase 2: first postConnect — promotes stale submitted and reconciles in same pass.
    // safe + wa_message_id not in messages → pending for replay (single cycle).
    const firstPostStats = engine.postConnectRecovery();
    expect(getOutbound(db, opId)['status']).toBe('pending');
    expect(firstPostStats.outboundReconciled).toBeGreaterThanOrEqual(1);
    expect(firstPostStats.outboundReplayed).toBe(1);
  });

  it('single-pass recovery: submitted unsafe op with echo → echoes on first postConnect', () => {
    // postConnectRecovery steps: (1) promote submitted→maybe_sent, (2) reconcile maybe_sent.
    // An op that is `submitted` at postConnect call time gets promoted AND reconciled in
    // the same pass. If the echo is already in the messages table, it transitions to echoed.
    const seq = engine.journalInbound('msg-td-crash-2', 'chat-J', 'chat-J@s.whatsapp.net', 'agent');
    engine.markTurnDone(seq);
    const opId = engine.createOutboundOp({
      conversationKey: 'chat-J', chatJid: 'chat-J@s.whatsapp.net', opType: 'text',
      payload: '{"text":"important unsafe reply"}', replayPolicy: 'unsafe',
      sourceInboundSeq: seq, isTerminal: true,
    });
    engine.markSending(opId);
    engine.markSubmitted(opId, 'WA-TD-UNSAFE-ECHOED');
    makeSubmittedStale(db, opId);
    // ↑ crash here

    engine.preConnectRecovery();
    // Submitted stays submitted through preConnect
    expect(getOutbound(db, opId)['status']).toBe('submitted');

    // Echo arrives during history sync window
    ingestEcho(db, 'WA-TD-UNSAFE-ECHOED', 'chat-J@s.whatsapp.net');

    // First postConnect: submitted → maybe_sent (Step 1), then maybe_sent + echo → echoed (Step 2)
    engine.postConnectRecovery();
    expect(getOutbound(db, opId)['status']).toBe('echoed');
    expect(getInbound(db, seq)['processing_status']).toBe('complete');
  });
});

// ---------------------------------------------------------------------------

describe('Crash Recovery — Scenario 5: full round-trip happy path', () => {
  let db: Database;
  let engine: DurabilityEngine;

  beforeEach(() => { ({ db, engine } = makeEngine()); });
  afterEach(() => { db.close(); });

  it('journal → create op → send → submit → match echo → inbound complete', () => {
    // Full happy path: no crash, normal operation flow
    const seq = engine.journalInbound('msg-happy-1', 'chat-K', 'chat-K@s.whatsapp.net', 'agent');
    expect(getInbound(db, seq)['processing_status']).toBe('processing');

    const opId = engine.createOutboundOp({
      conversationKey: 'chat-K', chatJid: 'chat-K@s.whatsapp.net', opType: 'text',
      payload: '{"text":"hello from bot"}', replayPolicy: 'unsafe',
      sourceInboundSeq: seq, isTerminal: true,
    });
    expect(getOutbound(db, opId)['status']).toBe('pending');

    engine.markSending(opId);
    expect(getOutbound(db, opId)['status']).toBe('sending');

    engine.markTurnDone(seq);
    expect(getInbound(db, seq)['processing_status']).toBe('turn_done');

    engine.markSubmitted(opId, 'WA-HAPPY-1');
    expect(getOutbound(db, opId)['status']).toBe('submitted');

    // Echo arrives normally (before any crash or recovery needed)
    const matched = engine.matchEcho('WA-HAPPY-1');
    expect(matched).toBe(true);

    expect(getOutbound(db, opId)['status']).toBe('echoed');
    // Terminal op echoed → inbound auto-completes
    expect(getInbound(db, seq)['processing_status']).toBe('complete');
    expect(getInbound(db, seq)['terminal_reason']).toBe('response_sent');
  });

  it('happy path with tool call + outbound op linked', () => {
    const seq = engine.journalInbound('msg-happy-2', 'chat-L', 'chat-L@s.whatsapp.net', 'agent');

    // Tool call recorded and executing
    const tcId = engine.recordToolCall('chat-L', 'send_whatsapp_message', '{"text":"hi"}', 'unsafe');
    engine.markToolExecuting(tcId);

    const opId = engine.createOutboundOp({
      conversationKey: 'chat-L', chatJid: 'chat-L@s.whatsapp.net', opType: 'text',
      payload: '{"text":"hi"}', replayPolicy: 'unsafe',
      sourceInboundSeq: seq, isTerminal: true,
    });
    engine.markSending(opId);
    engine.markTurnDone(seq);
    engine.markSubmitted(opId, 'WA-HAPPY-2');

    // Tool call completes with outbound op linkage
    engine.markToolComplete(tcId, '{"ok":true}', opId);
    expect(getToolCall(db, tcId)['status']).toBe('complete');
    expect(getToolCall(db, tcId)['outbound_op_id']).toBe(opId);

    // Echo arrives
    const matched = engine.matchEcho('WA-HAPPY-2');
    expect(matched).toBe(true);

    expect(getOutbound(db, opId)['status']).toBe('echoed');
    expect(getInbound(db, seq)['processing_status']).toBe('complete');
  });
});

// ---------------------------------------------------------------------------

describe('Crash Recovery — Scenario 6: maybe_sent reconciliation with wa_message_id', () => {
  let db: Database;
  let engine: DurabilityEngine;

  beforeEach(() => { ({ db, engine } = makeEngine()); });
  afterEach(() => { db.close(); });

  it('maybe_sent op with wa_message_id found in messages → transitions to echoed', () => {
    // Simulate: op was promoted to maybe_sent (crash-in-flight) but message was
    // actually delivered. History sync brings the echo in before postConnectRecovery.
    const seq = engine.journalInbound('msg-maybe-1', 'chat-M', 'chat-M@s.whatsapp.net', 'agent');
    engine.markTurnDone(seq);
    const opId = engine.createOutboundOp({
      conversationKey: 'chat-M', chatJid: 'chat-M@s.whatsapp.net', opType: 'text',
      payload: '{"text":"was it sent?"}', replayPolicy: 'unsafe',
      sourceInboundSeq: seq, isTerminal: true,
    });
    engine.markSending(opId);
    engine.markSubmitted(opId, 'WA-MAYBE-FOUND-1');
    engine.markMaybeSent(opId, 'crash-in-flight');

    // Message arrived via history sync before postConnectRecovery
    ingestEcho(db, 'WA-MAYBE-FOUND-1', 'chat-M@s.whatsapp.net');

    const stats = engine.postConnectRecovery();

    expect(getOutbound(db, opId)['status']).toBe('echoed');
    expect(stats.outboundReconciled).toBeGreaterThanOrEqual(1);

    // Terminal op echoed → inbound completes
    expect(getInbound(db, seq)['processing_status']).toBe('complete');
    expect(getInbound(db, seq)['terminal_reason']).toBe('response_sent');
  });

  it('maybe_sent op with wa_message_id NOT in messages + unsafe → quarantined', () => {
    const opId = engine.createOutboundOp({
      conversationKey: 'chat-N', chatJid: 'chat-N@s.whatsapp.net', opType: 'text',
      payload: '{"text":"unsafe unconfirmed"}', replayPolicy: 'unsafe',
    });
    engine.markSending(opId);
    engine.markSubmitted(opId, 'WA-MAYBE-LOST');
    engine.markMaybeSent(opId, 'crash-in-flight');
    // No echo inserted — message delivery unconfirmed

    const stats = engine.postConnectRecovery();

    expect(getOutbound(db, opId)['status']).toBe('quarantined');
    expect(stats.outboundQuarantined).toBe(1);
    expect(stats.outboundReplayed).toBe(0);
  });

  it('maybe_sent op with wa_message_id found transitions inbound to complete — two postConnect cycles', () => {
    // Full state machine:
    //   processing → turn_done → sending → submitted
    //   [crash]
    //   preConnect: submitted stays submitted, turn_done stays turn_done
    //   postConnect #1: submitted → maybe_sent (stale promotion in Step 2)
    //   postConnect #2: maybe_sent + echo in messages → echoed → inbound complete
    const seq = engine.journalInbound('msg-maybe-full', 'chat-O', 'chat-O@s.whatsapp.net', 'agent');
    expect(getInbound(db, seq)['processing_status']).toBe('processing');

    const opId = engine.createOutboundOp({
      conversationKey: 'chat-O', chatJid: 'chat-O@s.whatsapp.net', opType: 'text',
      payload: '{"text":"reply"}', replayPolicy: 'unsafe',
      sourceInboundSeq: seq, isTerminal: true,
    });
    engine.markSending(opId);
    engine.markTurnDone(seq);
    engine.markSubmitted(opId, 'WA-FULL-CYCLE-1');
    makeSubmittedStale(db, opId);
    // ↑ crash here — op in `submitted`, inbound in `turn_done`

    // Restart Phase 1: preConnect
    engine.preConnectRecovery();
    expect(getInbound(db, seq)['processing_status']).toBe('turn_done');
    expect(getOutbound(db, opId)['status']).toBe('submitted');

    // History sync delivers the echo into the messages table
    ingestEcho(db, 'WA-FULL-CYCLE-1', 'chat-O@s.whatsapp.net');

    // Restart Phase 2: postConnect — stale submitted → maybe_sent (Step 1) then
    // maybe_sent + echo found → echoed (Step 2), all in a single pass
    engine.postConnectRecovery();
    expect(getOutbound(db, opId)['status']).toBe('echoed');
    expect(getInbound(db, seq)['processing_status']).toBe('complete');
    // Recovery run was logged
    const runRow1 = db.raw.prepare("SELECT * FROM recovery_runs WHERE trigger='post_connect' ORDER BY id DESC LIMIT 1").get() as any;
    expect(runRow1).toBeDefined();
    expect(runRow1.completed_at).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('Crash Recovery — Scenario 7: historySyncComplete race (fake timers)', () => {
  /**
   * These tests replicate the Promise.race pattern from main.ts startup:
   *
   *   await Promise.race([
   *     new Promise<void>((resolve) => connectionManager.once('historySyncComplete', resolve)),
   *     new Promise<void>((resolve) => setTimeout(resolve, 15_000)),
   *   ]);
   *   await new Promise<void>((resolve) => setTimeout(resolve, 10_000));
   *   durability.postConnectRecovery();
   *
   * They do NOT import main.ts; they inline the same logic to keep the test
   * self-contained and avoid side effects from real I/O initialization.
   */

  let db: Database;
  let engine: DurabilityEngine;

  beforeEach(() => {
    ({ db, engine } = makeEngine());
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  it('timeout path: race resolves via 15s timeout when historySyncComplete never fires', async () => {
    const connectionManager = new EventEmitter();
    let postConnectCalled = false;

    // Mirror the startup sequence from main.ts (lines 272-277)
    const startupSequence = (async () => {
      await Promise.race([
        new Promise<void>((resolve) => connectionManager.once('historySyncComplete', resolve)),
        new Promise<void>((resolve) => setTimeout(resolve, 15_000)),
      ]);
      await new Promise<void>((resolve) => setTimeout(resolve, 10_000));
      engine.postConnectRecovery();
      postConnectCalled = true;
    })();

    // Neither historySyncComplete nor the timeout have fired yet
    expect(postConnectCalled).toBe(false);

    // Advance past the 15s timeout — race should resolve
    await vi.advanceTimersByTimeAsync(15_000);

    // Race resolved but echo grace (10s) not yet elapsed
    expect(postConnectCalled).toBe(false);

    // Advance past the 10s echo grace period
    await vi.advanceTimersByTimeAsync(10_000);

    await startupSequence;

    expect(postConnectCalled).toBe(true);
  });

  it('event path: race resolves immediately when historySyncComplete fires before 15s', async () => {
    const connectionManager = new EventEmitter();
    let postConnectCalled = false;

    const startupSequence = (async () => {
      await Promise.race([
        new Promise<void>((resolve) => connectionManager.once('historySyncComplete', resolve)),
        new Promise<void>((resolve) => setTimeout(resolve, 15_000)),
      ]);
      await new Promise<void>((resolve) => setTimeout(resolve, 10_000));
      engine.postConnectRecovery();
      postConnectCalled = true;
    })();

    // Emit historySyncComplete early (e.g. at 3s into startup)
    await vi.advanceTimersByTimeAsync(3_000);
    connectionManager.emit('historySyncComplete');

    // Race is now resolved; let microtasks drain so the await chain advances
    await Promise.resolve();

    // Still in the 10s echo grace window — postConnect not yet called
    expect(postConnectCalled).toBe(false);

    // Advance through echo grace period (only 10s needed, not the remaining 12s of the 15s timer)
    await vi.advanceTimersByTimeAsync(10_000);

    await startupSequence;

    expect(postConnectCalled).toBe(true);
  });

  it('event path: 15s timer is cancelled implicitly — total elapsed well under 25s', async () => {
    // Verify that firing historySyncComplete at t=1s means postConnect runs at ~11s
    // (1s race wait + 10s echo grace), not at 15s+10s=25s.
    const connectionManager = new EventEmitter();
    const elapsed: number[] = [];

    const startupSequence = (async () => {
      await Promise.race([
        new Promise<void>((resolve) => connectionManager.once('historySyncComplete', resolve)),
        new Promise<void>((resolve) => setTimeout(resolve, 15_000)),
      ]);
      elapsed.push(Date.now()); // checkpoint A: race resolved
      await new Promise<void>((resolve) => setTimeout(resolve, 10_000));
      elapsed.push(Date.now()); // checkpoint B: postConnect called
      engine.postConnectRecovery();
    })();

    const t0 = Date.now();

    // historySyncComplete fires at t=1s
    await vi.advanceTimersByTimeAsync(1_000);
    connectionManager.emit('historySyncComplete');
    await Promise.resolve();

    // Echo grace expires
    await vi.advanceTimersByTimeAsync(10_000);
    await startupSequence;

    // Race resolved at ~1s, postConnect at ~11s — both well under 25s
    expect(elapsed[0]! - t0).toBeLessThan(15_000);
    expect(elapsed[1]! - t0).toBeLessThan(15_000);
  });
});
