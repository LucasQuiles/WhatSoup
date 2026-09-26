/**
 * Open inbound behind a FINAL terminal record: evaluator, close, and the
 * report-only sweep bucket.
 *
 * An inbound row left 'pending'/'processing'/'turn_done' while its
 * turn_terminal_records row already says finalized_replied,
 * finalized_no_reply_policy or failed_terminal was skipped by every
 * reconciler. Current finalization writes record and inbound atomically, so
 * fixtures are produced by a REAL finalize followed by reopening the inbound
 * row — the state an older release left behind.
 *
 * Each close needs its own operator decision, so the sweep only REPORTS such
 * rows and writes nothing. TerminalRecordInboundCloser (used by the operator
 * CLI) applies exactly the status live finalization applied, and refuses
 * transferred records, disposition links, recovery jobs, conflicting records,
 * identity mismatches, broken delivery proof and contract-invalid records.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';
import { withTransaction } from '../../src/core/db-tx.ts';
import { TerminalRecordInboundCloser } from '../../src/core/terminal-record-inbound-close.ts';
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

describe('open inbound behind a final terminal record', () => {
  let db: Database;
  let engine: DurabilityEngine;
  let closer: TerminalRecordInboundCloser;
  let counter: number;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
    engine = new DurabilityEngine(db);
    closer = new TerminalRecordInboundCloser(db.raw);
    counter = 0;
  });
  afterEach(() => { db.close(); });

  const inboundState = (seq: number): InboundState =>
    db.raw.prepare(
      'SELECT processing_status, terminal_reason, failure_class FROM inbound_events WHERE seq = ?',
    ).get(seq) as unknown as InboundState;

  const evidenceRowCount = (): number =>
    (db.raw.prepare(
      'SELECT (SELECT COUNT(*) FROM recovery_plans) + (SELECT COUNT(*) FROM recovery_runs) AS n',
    ).get() as { n: number }).n;

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

  const close = (seq: number) => {
    const evaluation = closer.evaluate(seq);
    if (evaluation.verdict === 'eligible') {
      withTransaction(db, () => closer.applyWithinCallerTransaction(evaluation.mutation));
    }
    return evaluation;
  };

  function journal(receivedAt = '-10 minutes'): number {
    counter += 1;
    const seq = engine.journalInbound(`wamid-close-${counter}`, CONVERSATION_KEY, DELIVERY_JID, 'agent');
    backdate(seq, receivedAt);
    return seq;
  }

  function echoedOp(seq: number): number {
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
    return opId;
  }

  function finalize(
    seq: number,
    disposition: FinalDisposition,
    options: { attempt?: AttemptOutcome; logicalTurnId?: string } = {},
  ): void {
    const deliveryEvidence: TurnTerminalResult['deliveryEvidence'] = disposition === 'finalized_replied'
      ? { kind: 'echoed', opId: echoedOp(seq) }
      : { kind: 'none' };
    const attemptOutcome: AttemptOutcome = options.attempt ?? (
      disposition === 'finalized_replied' ? { kind: 'completed' }
        : disposition === 'finalized_no_reply_policy' ? { kind: 'suppressed_by_policy' }
          : { kind: 'failed', class: 'crash' }
    );
    engine.finalizeTurnTerminal(toTurnFinalizationPersistence({
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
    }));
  }

  function finalizeTransferred(seq: number): void {
    const opId = engine.createOutboundOp({
      conversationKey: CONVERSATION_KEY,
      chatJid: DELIVERY_JID,
      opType: 'text',
      payload: JSON.stringify({ text: 'selected delivery' }),
      replayPolicy: 'unsafe',
      sourceInboundSeq: seq,
    });
    const owner: RecoveryOwnerIdentity = { logicalTurnId: `turn-owner-${seq}`, managerId: 'manager-owner', generation: 2 };
    const result: TurnTerminalResult = {
      identity: {
        scope: 'per_chat',
        conversationKey: CONVERSATION_KEY,
        deliveryJid: DELIVERY_JID,
        inboundSeq: seq,
        logicalTurnId: `turn-transferred-${seq}`,
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
      it(`${label}: the sweep reports it, and the close applies exactly the status finalization applied`, () => {
        const seq = journal();
        finalize(seq, disposition, attempt ? { attempt } : {});
        const finalized = inboundState(seq);
        expect(['complete', 'failed']).toContain(finalized.processing_status);
        reopen(seq, openStatus);

        expect(engine.sweepStuckInbound()).toEqual({
          completedEchoed: 0,
          completedTurnDone: 0,
          failedStale: 0,
          reclaimedRecoveryOwned: 0,
          terminalRecordCloseCandidates: 1,
        });
        expect(inboundState(seq).processing_status).toBe(openStatus);

        expect(close(seq)).toMatchObject({ verdict: 'eligible', disposition, fromStatus: openStatus });
        expect(inboundState(seq)).toEqual(finalized);
      });
    }
  }

  it('the sweep writes nothing for a candidate: no close and no recovery evidence, sweep after sweep', () => {
    const seq = journal();
    finalize(seq, 'finalized_no_reply_policy');
    reopen(seq, 'pending');
    const before = evidenceRowCount();

    expect(engine.sweepStuckInbound().terminalRecordCloseCandidates).toBe(1);
    expect(engine.sweepStuckInbound().terminalRecordCloseCandidates).toBe(1);

    expect(inboundState(seq).processing_status).toBe('pending');
    expect(evidenceRowCount()).toBe(before);
  });

  it('an ineligible row is not a candidate and costs no recovery evidence across sweeps', () => {
    const seq = journal();
    finalize(seq, 'finalized_no_reply_policy');
    reopen(seq, 'processing');
    db.raw.prepare(
      `UPDATE turn_terminal_records SET conversation_key = '15550109990' WHERE inbound_seq = ?`,
    ).run(seq);
    const before = evidenceRowCount();

    expect(closer.candidates()).toEqual([]);
    expect(engine.sweepStuckInbound().terminalRecordCloseCandidates).toBe(0);
    expect(engine.sweepStuckInbound().terminalRecordCloseCandidates).toBe(0);

    expect(evidenceRowCount()).toBe(before);
    expect(closer.evaluate(seq)).toMatchObject({ verdict: 'refused', reason: 'identity_mismatch' });
  });

  it('a close is idempotent: the second evaluation reports already_closed', () => {
    const seq = journal();
    finalize(seq, 'finalized_no_reply_policy');
    reopen(seq, 'pending');
    expect(close(seq).verdict).toBe('eligible');
    const after = inboundState(seq);
    expect(close(seq)).toMatchObject({ verdict: 'already_closed' });
    expect(inboundState(seq)).toEqual(after);
  });

  it('the sweep respects the 5-minute grace window', () => {
    const seq = journal('-1 minutes');
    finalize(seq, 'finalized_no_reply_policy');
    reopen(seq, 'pending');
    expect(engine.sweepStuckInbound().terminalRecordCloseCandidates).toBe(0);
  });

  it('refuses an inbound whose record transferred to a recovery owner', () => {
    const seq = journal();
    finalizeTransferred(seq);
    expect(inboundState(seq).processing_status).toBe('processing');

    const sweep = engine.sweepStuckInbound();
    expect(sweep.terminalRecordCloseCandidates).toBe(0);
    expect(sweep.reclaimedRecoveryOwned).toBe(0);
    expect(close(seq)).toMatchObject({ verdict: 'refused', reason: 'non_final_disposition' });
    expect(inboundState(seq).processing_status).toBe('processing');
  });

  it('refuses a row with a disposition link', () => {
    const seq = journal();
    finalize(seq, 'finalized_no_reply_policy');
    reopen(seq, 'processing');
    db.raw.prepare(
      `INSERT INTO recovery_plans (plan_id, origin, actor, summary) VALUES ('plan-close-test', 'operator', 'test', 'fixture')`,
    ).run();
    db.raw.prepare(
      `INSERT INTO inbound_disposition_links (inbound_seq, recovery_plan_id, disposition, reason, actor)
       VALUES (?, 'plan-close-test', 'recovery_pending_operator_catchup', 'fixture', 'test')`,
    ).run(seq);

    expect(engine.sweepStuckInbound().terminalRecordCloseCandidates).toBe(0);
    expect(close(seq)).toMatchObject({ verdict: 'refused', reason: 'disposition_link' });
    expect(inboundState(seq).processing_status).toBe('processing');
  });

  it('refuses a row referenced by a recovery job', () => {
    const seq = journal();
    finalize(seq, 'finalized_no_reply_policy');
    reopen(seq, 'processing');
    // A pending job sourced from this row but owned by another row's
    // transferred record: the only record on THIS row stays the final one.
    const other = journal();
    finalizeTransferred(other);
    const spare = journal();
    finalizeTransferred(spare);
    const spareRecord = (db.raw.prepare(
      'SELECT id FROM turn_terminal_records WHERE inbound_seq = ?',
    ).get(spare) as { id: number }).id;
    db.raw.prepare('DELETE FROM turn_recovery_jobs WHERE source_inbound_seq = ?').run(spare);
    const columns = (db.raw.prepare('PRAGMA table_info(turn_recovery_jobs)').all() as Array<{ name: string }>)
      .map((c) => c.name)
      .filter((name) => name !== 'id');
    const projected = columns.map((name) => (
      name === 'terminal_record_id' ? '?'
        : name === 'source_inbound_seq' || name === 'source_inbound_seq_key' ? '?'
          : name
    ));
    const params = columns.flatMap((name) => (
      name === 'terminal_record_id' ? [spareRecord]
        : name === 'source_inbound_seq' || name === 'source_inbound_seq_key' ? [seq]
          : []
    ));
    db.raw.prepare(
      `INSERT INTO turn_recovery_jobs (${columns.join(', ')})
       SELECT ${projected.join(', ')} FROM turn_recovery_jobs WHERE source_inbound_seq = ?`,
    ).run(...params, other);

    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM turn_terminal_records WHERE inbound_seq = ?').get(seq))
      .toEqual({ n: 1 });
    expect(engine.sweepStuckInbound().terminalRecordCloseCandidates).toBe(0);
    expect(close(seq)).toMatchObject({ verdict: 'refused', reason: 'recovery_job' });
    expect(inboundState(seq).processing_status).toBe('processing');
  });

  it('refuses a row whose terminal records disagree', () => {
    const seq = journal();
    finalize(seq, 'finalized_no_reply_policy', { logicalTurnId: 'turn-a' });
    reopen(seq, 'processing');
    finalize(seq, 'failed_terminal', { logicalTurnId: 'turn-b' });
    reopen(seq, 'processing');

    expect(engine.sweepStuckInbound().terminalRecordCloseCandidates).toBe(0);
    expect(close(seq)).toMatchObject({ verdict: 'refused', reason: 'multiple_terminal_records' });
  });

  it('refuses a record whose identity does not match the inbound', () => {
    const seq = journal();
    finalize(seq, 'finalized_no_reply_policy');
    reopen(seq, 'processing');
    db.raw.prepare(
      `UPDATE turn_terminal_records SET delivery_jid = '15550109991@s.whatsapp.net' WHERE inbound_seq = ?`,
    ).run(seq);

    expect(close(seq)).toMatchObject({ verdict: 'refused', reason: 'identity_mismatch' });
    expect(inboundState(seq).processing_status).toBe('processing');
  });

  it('refuses a replied record whose delivery op is no longer echoed', () => {
    const seq = journal();
    finalize(seq, 'finalized_replied');
    reopen(seq, 'processing');
    db.raw.prepare(
      `UPDATE outbound_ops SET status = 'failed_permanent'
       WHERE id = (SELECT delivery_op_id FROM turn_terminal_records WHERE inbound_seq = ?)`,
    ).run(seq);

    expect(engine.sweepStuckInbound().terminalRecordCloseCandidates).toBe(0);
    expect(close(seq)).toMatchObject({ verdict: 'refused', reason: 'delivery_proof_invalid' });
    expect(inboundState(seq).processing_status).toBe('processing');
  });

  it("refuses a replied record whose delivery op belongs to another inbound", () => {
    const seq = journal();
    finalize(seq, 'finalized_replied');
    reopen(seq, 'processing');
    const foreignOp = echoedOp(journal());
    db.raw.prepare(
      'UPDATE turn_terminal_records SET delivery_op_id = ? WHERE inbound_seq = ?',
    ).run(foreignOp, seq);

    expect(engine.sweepStuckInbound().terminalRecordCloseCandidates).toBe(0);
    expect(close(seq)).toMatchObject({ verdict: 'refused', reason: 'delivery_proof_invalid' });
    expect(inboundState(seq).processing_status).toBe('processing');
  });

  it('refuses a final record whose persisted axes break the finalize contract', () => {
    const seq = journal();
    finalize(seq, 'failed_terminal', { attempt: { kind: 'failed', class: 'crash' } });
    reopen(seq, 'processing');
    // An older release could persist an attempt class the contract no longer accepts.
    db.raw.prepare(
      `UPDATE turn_terminal_records SET attempt_failure_class = 'retired-class' WHERE inbound_seq = ?`,
    ).run(seq);

    expect(close(seq)).toMatchObject({ verdict: 'refused', reason: 'record_contract_invalid' });
    expect(inboundState(seq).processing_status).toBe('processing');
  });
});
