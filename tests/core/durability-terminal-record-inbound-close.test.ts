/**
 * sweepStuckInbound — open inbound behind a FINAL terminal record.
 *
 * An inbound row left 'pending'/'processing'/'turn_done' while its
 * turn_terminal_records row already says finalized_replied,
 * finalized_no_reply_policy or failed_terminal was skipped by every
 * reconciler: the stuck-inbound buckets require NOT EXISTS terminal record and
 * the recovery-owner bucket requires a transferred disposition. Current
 * finalization writes record and inbound atomically, so fixtures are produced
 * by a REAL finalize followed by reopening the inbound row — the state an
 * older release left behind.
 *
 * The sweep must apply exactly the status live finalization applied (same
 * mapping), and must leave alone: transferred records, rows with disposition
 * links, rows with conflicting records, invalid records, and fresh rows.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';
import {
  toTurnFinalizationPersistence,
  toTurnRecoveryJobPersistence,
  type AttemptOutcome,
  type RecoveryOwnerIdentity,
  type TurnTerminalResult,
} from '../../src/runtimes/agent/turn-terminal.ts';

const CONVERSATION_KEY = '15550107777';
const DELIVERY_JID = '15550107777@s.whatsapp.net';
const OPEN_STATUSES = ['pending', 'processing', 'turn_done'] as const;
type FinalDisposition = 'finalized_replied' | 'finalized_no_reply_policy' | 'failed_terminal';

interface InboundState {
  processing_status: string;
  terminal_reason: string | null;
  failure_class: string | null;
}

describe('sweepStuckInbound — open inbound behind a final terminal record', () => {
  let db: Database;
  let engine: DurabilityEngine;
  let counter: number;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
    engine = new DurabilityEngine(db);
    counter = 0;
  });
  afterEach(() => { db.close(); });

  const inboundState = (seq: number): InboundState =>
    db.raw.prepare(
      'SELECT processing_status, terminal_reason, failure_class FROM inbound_events WHERE seq = ?',
    ).get(seq) as unknown as InboundState;

  const backdate = (seq: number, interval: string): void => {
    db.raw.prepare(`UPDATE inbound_events SET received_at = datetime('now', ?) WHERE seq = ?`).run(interval, seq);
  };

  /** The state an older release left: terminal record present, inbound reopened. */
  const reopen = (seq: number, status: string): void => {
    db.raw.prepare(
      `UPDATE inbound_events
       SET processing_status = ?, completed_at = NULL, terminal_reason = NULL, failure_class = NULL
       WHERE seq = ?`,
    ).run(status, seq);
  };

  function journal(receivedAt = '-10 minutes'): number {
    counter += 1;
    const seq = engine.journalInbound(`wamid-close-${counter}`, CONVERSATION_KEY, DELIVERY_JID, 'agent');
    backdate(seq, receivedAt);
    return seq;
  }

  function finalize(
    seq: number,
    disposition: FinalDisposition,
    options: { attempt?: AttemptOutcome; logicalTurnId?: string } = {},
  ): void {
    let deliveryEvidence: TurnTerminalResult['deliveryEvidence'] = { kind: 'none' };
    if (disposition === 'finalized_replied') {
      const opId = engine.createOutboundOp({
        conversationKey: CONVERSATION_KEY,
        chatJid: DELIVERY_JID,
        opType: 'text',
        payload: JSON.stringify({ text: 'reply' }),
        replayPolicy: 'safe',
        sourceInboundSeq: seq,
        isTerminal: true,
      });
      db.raw.prepare(`UPDATE outbound_ops SET status = 'echoed', echoed_at = datetime('now') WHERE id = ?`).run(opId);
      deliveryEvidence = { kind: 'echoed', opId };
    }
    const attemptOutcome: AttemptOutcome = options.attempt ?? (
      disposition === 'finalized_replied' ? { kind: 'completed' }
        : disposition === 'finalized_no_reply_policy' ? { kind: 'suppressed_by_policy' }
          : { kind: 'failed', class: 'crash' }
    );
    const result: TurnTerminalResult = {
      identity: {
        scope: 'per_chat',
        conversationKey: CONVERSATION_KEY,
        deliveryJid: DELIVERY_JID,
        inboundSeq: seq,
        logicalTurnId: options.logicalTurnId ?? `turn-${seq}`,
        managerId: 'manager-close',
        generation: 1,
      },
      attemptOutcome,
      inboundDisposition: disposition,
      deliveryEvidence,
    };
    engine.finalizeTurnTerminal(toTurnFinalizationPersistence(result));
  }

  const CASES: Array<{ disposition: FinalDisposition; attempt?: AttemptOutcome }> = [
    { disposition: 'finalized_replied' },
    { disposition: 'finalized_no_reply_policy' },
    { disposition: 'failed_terminal', attempt: { kind: 'failed', class: 'crash' } },
    { disposition: 'failed_terminal', attempt: { kind: 'admission_rejected', class: 'queue_full' } },
  ];

  for (const { disposition, attempt } of CASES) {
    for (const openStatus of OPEN_STATUSES) {
      const label = `${disposition}${attempt ? ` (${attempt.kind})` : ''} left ${openStatus}`;
      it(`${label}: closes with exactly the status live finalization applied`, () => {
        const seq = journal();
        finalize(seq, disposition, attempt ? { attempt } : {});
        const finalized = inboundState(seq);
        expect(['complete', 'failed']).toContain(finalized.processing_status);
        reopen(seq, openStatus);

        const result = engine.sweepStuckInbound();

        expect(result).toEqual({
          completedEchoed: 0,
          completedTurnDone: 0,
          failedStale: 0,
          reclaimedRecoveryOwned: 0,
          closedFromTerminalRecord: 1,
        });
        expect(inboundState(seq)).toEqual(finalized);
      });
    }
  }

  it('is idempotent: a second sweep changes nothing', () => {
    const seq = journal();
    finalize(seq, 'finalized_no_reply_policy');
    reopen(seq, 'pending');
    expect(engine.sweepStuckInbound().closedFromTerminalRecord).toBe(1);
    const after = inboundState(seq);
    expect(engine.sweepStuckInbound().closedFromTerminalRecord).toBe(0);
    expect(inboundState(seq)).toEqual(after);
  });

  it('respects the 5-minute grace window', () => {
    const seq = journal('-1 minutes');
    finalize(seq, 'finalized_no_reply_policy');
    reopen(seq, 'pending');
    expect(engine.sweepStuckInbound().closedFromTerminalRecord).toBe(0);
    expect(inboundState(seq).processing_status).toBe('pending');
  });

  it('never touches an inbound whose record transferred to a recovery owner', () => {
    const seq = journal();
    const opId = engine.createOutboundOp({
      conversationKey: CONVERSATION_KEY,
      chatJid: DELIVERY_JID,
      opType: 'text',
      payload: JSON.stringify({ text: 'selected delivery' }),
      replayPolicy: 'unsafe',
      sourceInboundSeq: seq,
    });
    const owner: RecoveryOwnerIdentity = { logicalTurnId: 'turn-owner', managerId: 'manager-owner', generation: 2 };
    const result: TurnTerminalResult = {
      identity: {
        scope: 'per_chat',
        conversationKey: CONVERSATION_KEY,
        deliveryJid: DELIVERY_JID,
        inboundSeq: seq,
        logicalTurnId: 'turn-transferred',
        managerId: 'manager-close',
        generation: 1,
      },
      attemptOutcome: { kind: 'failed', class: 'transient-network' },
      inboundDisposition: 'transferred_to_recovery_owner',
      // A pending op and a pending job keep the #1749 reclaim bucket out too.
      deliveryEvidence: { kind: 'enqueued', opId },
    };
    engine.finalizeTurnTerminal({
      ...toTurnFinalizationPersistence(result, owner),
      recoveryJob: toTurnRecoveryJobPersistence(result, owner, {
        sourceMessageId: `wamid-close-${counter}`,
        receivedAtUnixSeconds: 1_780_000_000,
        replaySafe: true,
        senderJid: '15550107778@s.whatsapp.net',
        senderName: null,
        text: 'replay text',
        isGroup: false,
      }),
    });
    expect(inboundState(seq).processing_status).toBe('processing');

    const sweep = engine.sweepStuckInbound();

    expect(sweep.closedFromTerminalRecord).toBe(0);
    expect(sweep.reclaimedRecoveryOwned).toBe(0);
    expect(inboundState(seq).processing_status).toBe('processing');
    expect(engine.closeInboundFromTerminalRecord(seq, { apply: true })).toMatchObject({
      applied: false,
      evaluation: { verdict: 'refused', reason: 'non_final_disposition' },
    });
  });

  it('never touches a row with a disposition link, and still closes the rest of the batch', () => {
    const linked = journal();
    finalize(linked, 'finalized_no_reply_policy');
    reopen(linked, 'processing');
    db.raw.prepare(
      `INSERT INTO recovery_plans (plan_id, origin, actor, summary) VALUES ('plan-close-test', 'operator', 'test', 'fixture')`,
    ).run();
    db.raw.prepare(
      `INSERT INTO inbound_disposition_links (inbound_seq, recovery_plan_id, disposition, reason, actor)
       VALUES (?, 'plan-close-test', 'recovery_pending_operator_catchup', 'fixture', 'test')`,
    ).run(linked);
    const eligible = journal();
    finalize(eligible, 'finalized_no_reply_policy');
    reopen(eligible, 'processing');

    const sweep = engine.sweepStuckInbound();

    expect(sweep.closedFromTerminalRecord).toBe(1);
    expect(inboundState(linked).processing_status).toBe('processing');
    expect(inboundState(eligible).processing_status).toBe('complete');
    expect(engine.closeInboundFromTerminalRecord(linked, { apply: true })).toMatchObject({
      applied: false,
      evaluation: { verdict: 'refused', reason: 'disposition_link' },
    });
  });

  it('never touches a row whose terminal records disagree', () => {
    const seq = journal();
    finalize(seq, 'finalized_no_reply_policy', { logicalTurnId: 'turn-a' });
    reopen(seq, 'processing');
    finalize(seq, 'failed_terminal', { logicalTurnId: 'turn-b' });
    reopen(seq, 'processing');

    expect(engine.sweepStuckInbound().closedFromTerminalRecord).toBe(0);
    expect(inboundState(seq).processing_status).toBe('processing');
    expect(engine.closeInboundFromTerminalRecord(seq, { apply: true })).toMatchObject({
      applied: false,
      evaluation: { verdict: 'refused', reason: 'multiple_terminal_records' },
    });
  });

  it('refuses a final record whose persisted axes break the finalize contract', () => {
    const seq = journal();
    finalize(seq, 'failed_terminal', { attempt: { kind: 'failed', class: 'crash' } });
    reopen(seq, 'processing');
    // An older release could persist an attempt class the contract no longer accepts.
    db.raw.prepare(
      `UPDATE turn_terminal_records SET attempt_failure_class = 'retired-class' WHERE inbound_seq = ?`,
    ).run(seq);

    expect(engine.sweepStuckInbound().closedFromTerminalRecord).toBe(0);
    expect(inboundState(seq).processing_status).toBe('processing');
    expect(engine.closeInboundFromTerminalRecord(seq, { apply: true })).toMatchObject({
      applied: false,
      evaluation: { verdict: 'refused', reason: 'record_contract_invalid' },
    });
  });
});
