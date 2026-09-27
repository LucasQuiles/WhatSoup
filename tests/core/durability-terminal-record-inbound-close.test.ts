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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

// Only the durability component's logger is captured, so bucket-5 log lines
// can be asserted without other components' calls polluting the mocks.
const durabilityLogger = vi.hoisted(() => ({}) as Record<string, ReturnType<typeof vi.fn>>);
vi.mock('../../src/logger.ts', async () => {
  const { componentLoggerMock, loggerMock } = await import('../helpers/logger-mock.ts');
  const { log, createChildLogger } = componentLoggerMock('durability', () =>
    loggerMock().createChildLogger(),
  );
  Object.assign(durabilityLogger, log);
  return { createChildLogger };
});

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
      withTransaction(db, () => closer.applyWithinCallerTransaction(evaluation));
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

  it('a replied close also marks the selected delivery op terminal, as live finalization does', () => {
    const seq = journal();
    finalize(seq, 'finalized_replied');
    reopen(seq, 'processing');
    // An older release could leave the selected op without its terminal mark.
    const opId = (db.raw.prepare(
      'SELECT delivery_op_id AS id FROM turn_terminal_records WHERE inbound_seq = ?',
    ).get(seq) as { id: number }).id;
    db.raw.prepare('UPDATE outbound_ops SET is_terminal = 0 WHERE id = ?').run(opId);

    expect(close(seq).verdict).toBe('eligible');

    expect(db.raw.prepare('SELECT is_terminal FROM outbound_ops WHERE id = ?').get(opId))
      .toEqual({ is_terminal: 1 });
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

  /** A replied row whose delivery proof no longer holds: refused, but SQL-prefiltered as a candidate. */
  const proofBroken = (): number => {
    const seq = journal();
    finalize(seq, 'finalized_replied');
    reopen(seq, 'processing');
    db.raw.prepare(
      `UPDATE outbound_ops SET status = 'failed_permanent'
       WHERE id = (SELECT delivery_op_id FROM turn_terminal_records WHERE inbound_seq = ?)`,
    ).run(seq);
    return seq;
  };

  /** A reopened row with a valid record: eligible. */
  const eligible = (): number => {
    const seq = journal();
    finalize(seq, 'finalized_no_reply_policy');
    reopen(seq, 'pending');
    return seq;
  };

  it('a refused prefix longer than one scan page does not hide a later eligible row', () => {
    const refused = Array.from({ length: 200 }, () => proofBroken());
    const last = eligible();
    expect(closer.evaluate(refused[0]!)).toMatchObject({ verdict: 'refused', reason: 'delivery_proof_invalid' });

    expect(closer.eligibleCandidates()).toEqual([last]);
    expect(engine.sweepStuckInbound().terminalRecordCloseCandidates).toBe(1);
    expect(engine.sweepStuckInbound().terminalRecordCloseCandidates).toBe(1);
    expect(inboundState(last).processing_status).toBe('pending');
  }, 30_000);

  describe('bounded scan cycle', () => {
    const smallCloser = (): TerminalRecordInboundCloser =>
      new TerminalRecordInboundCloser(db.raw, { pageSize: 2, scanCap: 3 });

    const restoreProof = (seq: number): void => {
      db.raw.prepare(
        `UPDATE outbound_ops SET status = 'echoed'
         WHERE id = (SELECT delivery_op_id FROM turn_terminal_records WHERE inbound_seq = ?)`,
      ).run(seq);
    };

    it('pages past a refused prefix longer than the scan cap and reaches the eligible row on the next call', () => {
      const [r1, , r3] = [proofBroken(), proofBroken(), proofBroken(), proofBroken()];
      const e5 = eligible();
      const scanner = smallCloser();

      expect(scanner.scan()).toMatchObject({ eligible: [], scanned: 3, complete: false, nextAfterSeq: r3 });
      expect(scanner.scan()).toMatchObject({ eligible: [e5], scanned: 2, complete: true, nextAfterSeq: 0 });
      // The next call starts a new cycle at the oldest candidate.
      expect(scanner.scan()).toMatchObject({ eligible: [], scanned: 3, complete: false, nextAfterSeq: r3 });
      expect(r1).toBeLessThan(r3!);
    });

    it('a row repaired behind the cursor is found on the next cycle', () => {
      const [r1] = [proofBroken(), proofBroken(), proofBroken(), proofBroken()];
      const e5 = eligible();
      const scanner = smallCloser();

      expect(scanner.scan().complete).toBe(false);
      restoreProof(r1!);
      expect(scanner.scan()).toMatchObject({ eligible: [e5], complete: true });
      expect(scanner.scan().eligible).toEqual([r1]);
    });

    it('rows arriving during a cycle wait for the next cycle, so arrivals cannot postpone the wrap', () => {
      const [r1] = [proofBroken(), proofBroken(), proofBroken(), proofBroken()];
      const scanner = smallCloser();

      const first = scanner.scan();
      expect(first.complete).toBe(false);
      restoreProof(r1!);
      const late = eligible();
      expect(late).toBeGreaterThan(first.cycleUpperSeq);

      expect(scanner.scan()).toMatchObject({ eligible: [], scanned: 1, complete: true });
      const next = scanner.scan();
      expect(next.eligible).toEqual([r1]);
      expect(next.cycleUpperSeq).toBeGreaterThanOrEqual(late);
      expect(scanner.scan()).toMatchObject({ eligible: [late], complete: true });
    });

    it('handles the empty, exact-page, exact-cap and cap-plus-one boundaries without skipping the lookahead row', () => {
      const scanner = new TerminalRecordInboundCloser(db.raw, { pageSize: 2, scanCap: 4 });
      expect(scanner.scan()).toMatchObject({ eligible: [], scanned: 0, complete: true, nextAfterSeq: 0 });

      const rows = [eligible(), eligible()];
      expect(scanner.scan()).toMatchObject({ eligible: rows, scanned: 2, complete: true });

      rows.push(eligible());
      expect(scanner.scan()).toMatchObject({ eligible: rows, scanned: 3, complete: true });

      rows.push(eligible());
      expect(scanner.scan()).toMatchObject({ eligible: rows, scanned: 4, complete: true });

      rows.push(eligible());
      const capped = scanner.scan();
      expect(capped).toMatchObject({ eligible: rows.slice(0, 4), scanned: 4, complete: false, nextAfterSeq: rows[3] });
      expect(scanner.scan()).toMatchObject({ eligible: [rows[4]], scanned: 1, complete: true });
    });

    it('counts refusals by the evaluator reason without changing any rule', () => {
      const proof = proofBroken();
      const contract = journal();
      finalize(contract, 'failed_terminal', { attempt: { kind: 'failed', class: 'crash' } });
      reopen(contract, 'processing');
      db.raw.prepare(
        `UPDATE turn_terminal_records SET attempt_failure_class = 'retired-class' WHERE inbound_seq = ?`,
      ).run(contract);
      const ok = eligible();

      expect(closer.scan()).toEqual({
        eligible: [ok],
        refusedByReason: { delivery_proof_invalid: 1, record_contract_invalid: 1 },
        scanned: 3,
        complete: true,
        cycleUpperSeq: ok,
        nextAfterSeq: 0,
      });
      expect(closer.evaluate(proof)).toMatchObject({ verdict: 'refused', reason: 'delivery_proof_invalid' });
    });

    it('a scan that throws commits no cursor progress, so the next call re-reads the same rows', () => {
      const rows = [proofBroken(), proofBroken(), proofBroken(), proofBroken(), proofBroken()];
      const scanner = smallCloser();
      expect(scanner.scan()).toMatchObject({ scanned: 3, nextAfterSeq: rows[2] });

      const original = scanner.evaluate.bind(scanner);
      const spy = vi.spyOn(scanner, 'evaluate').mockImplementation((seq: number) => {
        if (seq === rows[4]) throw new Error('evaluator failed');
        return original(seq);
      });
      expect(() => scanner.scan()).toThrow('evaluator failed');
      spy.mockRestore();

      expect(scanner.scan()).toMatchObject({ scanned: 2, complete: true, refusedByReason: { delivery_proof_invalid: 2 } });
    });

    it('a deleted cursor row does not break the keyset resume', () => {
      const rows = [proofBroken(), proofBroken(), proofBroken(), proofBroken()];
      const e5 = eligible();
      const scanner = smallCloser();
      expect(scanner.scan().nextAfterSeq).toBe(rows[2]);
      db.raw.prepare('DELETE FROM turn_terminal_records WHERE inbound_seq = ?').run(rows[2]);

      expect(scanner.scan()).toMatchObject({ eligible: [e5], complete: true });
    });

    it('rejects a page size or scan cap that is not a positive integer, or a cap below the page size', () => {
      expect(() => new TerminalRecordInboundCloser(db.raw, { pageSize: 0 })).toThrow(RangeError);
      expect(() => new TerminalRecordInboundCloser(db.raw, { scanCap: 1.5 })).toThrow(RangeError);
      expect(() => new TerminalRecordInboundCloser(db.raw, { pageSize: 5, scanCap: 4 })).toThrow(RangeError);
    });

    it('the sweep reads bucket 5 before its own transaction and still writes nothing for it', () => {
      const seq = eligible();
      const before = evidenceRowCount();
      expect(db.raw.isTransaction).toBe(false);
      expect(engine.sweepStuckInbound().terminalRecordCloseCandidates).toBe(1);
      expect(db.raw.isTransaction).toBe(false);
      expect(inboundState(seq).processing_status).toBe('pending');
      expect(evidenceRowCount()).toBe(before);
    });

    const bucket5Calls = (level: 'info' | 'warn'): Array<Record<string, unknown>> =>
      durabilityLogger[level]!.mock.calls
        .filter((call) => String(call[1]).includes('behind a final terminal record'))
        .map((call) => call[0] as Record<string, unknown>);

    it('logs a refused-only window at info, so a refused backlog never reads as zero', () => {
      durabilityLogger.info!.mockClear();
      durabilityLogger.warn!.mockClear();
      proofBroken();
      proofBroken();
      expect(engine.sweepStuckInbound().terminalRecordCloseCandidates).toBe(0);
      expect(bucket5Calls('warn')).toEqual([]);
      expect(bucket5Calls('info')).toEqual([
        expect.objectContaining({
          count: 0,
          inboundSeqs: [],
          inboundSeqsTruncated: false,
          scanned: 2,
          complete: true,
          refusedByReason: { delivery_proof_invalid: 2 },
        }),
      ]);
    });

    it('logs at most 200 eligible seqs and flags the truncation; count stays exact', () => {
      durabilityLogger.warn!.mockClear();
      const seqs = Array.from({ length: 201 }, () => eligible());
      expect(engine.sweepStuckInbound().terminalRecordCloseCandidates).toBe(201);
      const [fields] = bucket5Calls('warn');
      expect(fields).toMatchObject({ count: 201, inboundSeqsTruncated: true, scanned: 201, complete: true });
      expect(fields!.inboundSeqs).toEqual(seqs.slice(0, 200));
    }, 30_000);
  });
});
