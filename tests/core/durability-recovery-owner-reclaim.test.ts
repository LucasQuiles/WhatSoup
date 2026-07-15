/**
 * #1749 remediation 2/3(b) — bounded reclaim for the recovery-owner trap.
 *
 * An inbound turn finalized `transferred_to_recovery_owner` writes a
 * `turn_terminal_records` row plus a recovery job. That terminal record trips the
 * shared `NOT EXISTS turn_terminal_records` guard in every stuck-inbound sweep
 * bucket and in preConnectRecovery, so the inbound is excluded from every reclaim
 * path. The only close path (`completeEchoedTurnRecoveryInbound`) fires only when
 * the owning op reaches `echoed`. When that op instead reaches a terminal
 * non-echoed state (`failed_permanent`/`quarantined`) — or the recovery job is
 * `exhausted` — the inbound stays `processing` forever and the pending/claimed job
 * pins admission on the scope indefinitely.
 *
 * rem-1 (#1748, `not_sent`) closed the FUTURE trigger path. This suite proves the
 * reclaim path for ALREADY-pinned rows: `sweepStuckInbound` now fails such an
 * inbound (`recovery_owner_reclaimed`) and drives its pending/claimed recovery job
 * to `exhausted`, so the scope becomes admissible again instead of a dead end.
 *
 * rem-3(b) invariant: no `processing` inbound row may be excluded from every sweep
 * bucket while its owning op is in a terminal non-echoed state.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';
import {
  toTurnFinalizationPersistence,
  toTurnRecoveryJobPersistence,
  type RecoveryOwnerIdentity,
  type TurnRecoveryReplayEnvelope,
  type TurnTerminalResult,
} from '../../src/runtimes/agent/turn-terminal.ts';

const OWNER: RecoveryOwnerIdentity = {
  logicalTurnId: 'turn-recovery-owner',
  managerId: 'manager-recovery',
  generation: 7,
};

const SCOPE = 'per_chat' as const;
const CONVERSATION_KEY = '15550109999';
const DELIVERY_JID = '15550109999:5@s.whatsapp.net';

describe('sweepStuckInbound — recovery-owner reclaim (#1749 rem-2/3b)', () => {
  let db: Database;
  let engine: DurabilityEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
    engine = new DurabilityEngine(db);
  });
  afterEach(() => { db.close(); });

  const failureClass = (seq: number) =>
    (db.raw.prepare('SELECT failure_class FROM inbound_events WHERE seq = ?').get(seq) as
      { failure_class: string | null }).failure_class;
  const jobState = (jobId: number) =>
    engine.getTurnRecoveryJob(jobId)!.state;
  // Age an inbound's received_at, mirroring the sweep-test harness. The reclaim
  // bucket now shares bucket 1's min-age grace window (#1833), so a row must be
  // pushed past that window before the sweep will reclaim it.
  const backdate = (seq: number, interval: string) =>
    db.raw.prepare(`UPDATE inbound_events SET received_at = datetime('now', ?) WHERE seq = ?`).run(interval, seq);

  /**
   * Persist a transferred_to_recovery_owner terminal record + pending job for a
   * given inbound. Distinct (suffix, generation) let one inbound own several
   * such records (turn_terminal_records is UNIQUE per inbound_seq_key/
   * logical_turn_id/generation).
   */
  function finalizeTransferFor(
    inboundSeq: number,
    messageId: string,
    suffix: string,
    generation = 3,
  ): { opId: number; jobId: number } {
    const opId = engine.createOutboundOp({
      conversationKey: CONVERSATION_KEY,
      chatJid: DELIVERY_JID,
      opType: 'text',
      payload: JSON.stringify({ text: `selected delivery ${suffix}` }),
      sourceInboundSeq: inboundSeq,
      replayPolicy: 'unsafe',
      isTerminal: true,
    });
    // maybe_sent is the ambiguity that legitimately transfers to a recovery owner.
    engine.markMaybeSent(opId, 'outbound governor ceiling exceeded');

    const result: TurnTerminalResult = {
      identity: {
        scope: SCOPE,
        conversationKey: CONVERSATION_KEY,
        deliveryJid: DELIVERY_JID,
        inboundSeq,
        logicalTurnId: `turn-source-${suffix}`,
        managerId: 'manager-source',
        generation,
      },
      attemptOutcome: { kind: 'failed', class: 'transient-network' },
      inboundDisposition: 'transferred_to_recovery_owner',
      deliveryEvidence: { kind: 'delivery_unknown', opId },
    };
    const envelope: TurnRecoveryReplayEnvelope = {
      sourceMessageId: messageId,
      replaySafe: true,
      senderJid: '15550109998:9@s.whatsapp.net',
      senderName: 'Pinned Sender',
      text: `[voice transcript ${suffix}]\nexact transformed text`,
      isGroup: false,
    };
    const receipt = engine.finalizeTurnTerminal({
      ...toTurnFinalizationPersistence(result, OWNER),
      recoveryJob: toTurnRecoveryJobPersistence(result, OWNER, envelope),
    });
    return { opId, jobId: receipt.recoveryJob!.jobId };
  }

  /** Persist a real transferred_to_recovery_owner terminal record + pending job. */
  function buildTransfer(suffix: string): { inboundSeq: number; opId: number; jobId: number } {
    const messageId = `wamid-${suffix}`;
    const inboundSeq = engine.journalInbound(messageId, CONVERSATION_KEY, DELIVERY_JID, 'agent');
    const { opId, jobId } = finalizeTransferFor(inboundSeq, messageId, suffix);
    return { inboundSeq, opId, jobId };
  }

  it('reclaims a pending-owned inbound whose owning op is failed_permanent and releases the scope', () => {
    const { inboundSeq, opId, jobId } = buildTransfer('fp');

    // Pre-state: the trap. Inbound pinned processing; scope blocked; job pending.
    expect(engine.getInboundStatus(inboundSeq)).toBe('processing');
    expect(engine.hasOutstandingTurnRecoveryForScope(SCOPE, CONVERSATION_KEY)).toBe(true);
    expect(jobState(jobId)).toBe('pending');

    // The owning op reaches a terminal non-echoed state — it can never echo.
    engine.markFailedPermanent(opId, 'outbound governor ceiling exceeded');
    // Age past the grace window: no late echo arrived, so the reclaim may fire.
    backdate(inboundSeq, '-10 minutes');

    const res = engine.sweepStuckInbound();

    // Inbound reclaimed to a terminal failed disposition (retention can collect it).
    expect(engine.getInboundStatus(inboundSeq)).toBe('failed');
    expect(failureClass(inboundSeq)).toBe('recovery_owner_reclaimed');
    // The job is driven to a terminal state so it no longer pins admission.
    expect(jobState(jobId)).toBe('exhausted');
    // Scope is admissible again — recovery ownership is no longer a dead end.
    expect(engine.hasOutstandingTurnRecoveryForScope(SCOPE, CONVERSATION_KEY)).toBe(false);
    expect(res.reclaimedRecoveryOwned).toBe(1);
  });

  it('does NOT reclaim within the 5-minute grace window so a late echo can still settle (#1833)', () => {
    const { inboundSeq, opId, jobId } = buildTransfer('grace-in');
    // failed_permanent/quarantined ops are NOT terminal for echo:
    // selectOutboundForEchoMatch still treats them as valid late-echo candidates,
    // and markEcho re-flips the op to `echoed` without re-settling an inbound the
    // reclaim already failed. Firing the reclaim on the very next sweep records a
    // delivered turn as a reclaim-failure. received_at defaults to now → inside the
    // grace window, so this sweep must hold off.
    engine.markFailedPermanent(opId, 'dead');

    const res = engine.sweepStuckInbound();

    expect(engine.getInboundStatus(inboundSeq)).toBe('processing');
    expect(jobState(jobId)).toBe('pending');
    expect(engine.hasOutstandingTurnRecoveryForScope(SCOPE, CONVERSATION_KEY)).toBe(true);
    expect(res.reclaimedRecoveryOwned).toBe(0);
  });

  it('reclaims once the inbound ages past the 5-minute grace window (#1833)', () => {
    const { inboundSeq, opId, jobId } = buildTransfer('grace-out');
    engine.markFailedPermanent(opId, 'dead');
    // The grace window elapsed and no late echo arrived — the reclaim may fire.
    backdate(inboundSeq, '-10 minutes');

    const res = engine.sweepStuckInbound();

    expect(engine.getInboundStatus(inboundSeq)).toBe('failed');
    expect(failureClass(inboundSeq)).toBe('recovery_owner_reclaimed');
    expect(jobState(jobId)).toBe('exhausted');
    expect(res.reclaimedRecoveryOwned).toBe(1);
  });

  it('reclaims a pending-owned inbound whose owning op is quarantined', () => {
    const { inboundSeq, opId, jobId } = buildTransfer('qn');
    engine.markQuarantined(opId);
    backdate(inboundSeq, '-10 minutes');

    const res = engine.sweepStuckInbound();

    expect(engine.getInboundStatus(inboundSeq)).toBe('failed');
    expect(failureClass(inboundSeq)).toBe('recovery_owner_reclaimed');
    expect(jobState(jobId)).toBe('exhausted');
    expect(engine.hasOutstandingTurnRecoveryForScope(SCOPE, CONVERSATION_KEY)).toBe(false);
    expect(res.reclaimedRecoveryOwned).toBe(1);
  });

  it('reclaims the inbound of an already-exhausted job even if its op is still maybe_sent', () => {
    const { inboundSeq, jobId } = buildTransfer('ex');
    // Drive the job to a genuine exhausted precondition (5 attempts spent).
    db.raw.prepare(`
      UPDATE turn_recovery_jobs
      SET state = 'exhausted', attempt_count = 5, claim_epoch = 5,
          claim_token = NULL, claimed_at = NULL, claim_expires_at = NULL
      WHERE id = ?
    `).run(jobId);
    expect(jobState(jobId)).toBe('exhausted');
    // An exhausted job already does not block admission, but the inbound leaks.
    expect(engine.getInboundStatus(inboundSeq)).toBe('processing');
    backdate(inboundSeq, '-10 minutes');

    const res = engine.sweepStuckInbound();

    expect(engine.getInboundStatus(inboundSeq)).toBe('failed');
    expect(failureClass(inboundSeq)).toBe('recovery_owner_reclaimed');
    expect(jobState(jobId)).toBe('exhausted'); // unchanged — no job mutation needed
    expect(res.reclaimedRecoveryOwned).toBe(1);
  });

  it('rem-3(b): no processing inbound stays excluded from every bucket while its op is terminal non-echoed', () => {
    const { inboundSeq, opId } = buildTransfer('inv');
    engine.markFailedPermanent(opId, 'dead');
    backdate(inboundSeq, '-10 minutes');

    engine.sweepStuckInbound();

    // The invariant: the row must NOT remain stranded in a non-terminal status.
    expect(engine.getInboundStatus(inboundSeq)).not.toBe('processing');
  });

  it('does NOT reclaim a recoverable transfer whose owning op is still maybe_sent', () => {
    const { inboundSeq, jobId } = buildTransfer('live');
    // op left maybe_sent; job pending — a late echo could still settle this.
    // Age past the grace window so the ONLY reason this holds is the op-state
    // guard, not the min-age window (#1833).
    backdate(inboundSeq, '-10 minutes');

    const res = engine.sweepStuckInbound();

    expect(engine.getInboundStatus(inboundSeq)).toBe('processing');
    expect(jobState(jobId)).toBe('pending');
    expect(engine.hasOutstandingTurnRecoveryForScope(SCOPE, CONVERSATION_KEY)).toBe(true);
    expect(res.reclaimedRecoveryOwned).toBe(0);
  });

  it('fails the inbound once when one seq owns two reclaimable transferred records', () => {
    // turn_terminal_records is UNIQUE per (inbound_seq_key, logical_turn_id,
    // generation), so a single inbound can own two transferred records — two
    // reclaimable jobs → the same seq appears twice in the candidate set. Failing
    // it twice would trip disposition_inbound_proof_immutable and abort the whole
    // sweep; the reclaim must fail each inbound exactly once while exhausting both.
    const messageId = 'wamid-dup';
    const inboundSeq = engine.journalInbound(messageId, CONVERSATION_KEY, DELIVERY_JID, 'agent');
    const a = finalizeTransferFor(inboundSeq, messageId, 'dup-a', 3);
    const b = finalizeTransferFor(inboundSeq, messageId, 'dup-b', 4);
    engine.markFailedPermanent(a.opId, 'dead');
    engine.markFailedPermanent(b.opId, 'dead');
    backdate(inboundSeq, '-10 minutes');

    const res = engine.sweepStuckInbound();

    expect(engine.getInboundStatus(inboundSeq)).toBe('failed');
    expect(failureClass(inboundSeq)).toBe('recovery_owner_reclaimed');
    // Both owning jobs are driven to exhausted; the inbound is counted once.
    expect(jobState(a.jobId)).toBe('exhausted');
    expect(jobState(b.jobId)).toBe('exhausted');
    expect(res.reclaimedRecoveryOwned).toBe(1);
    expect(engine.hasOutstandingTurnRecoveryForScope(SCOPE, CONVERSATION_KEY)).toBe(false);
  });

  it('reclaims a claimed (leased) owning job whose op is failed_permanent', () => {
    const { inboundSeq, opId, jobId } = buildTransfer('claimed');
    // Move the pending job into a live claim, mirroring an in-flight worker lease.
    engine.claimTurnRecoveryJob(
      jobId,
      { logicalTurnId: OWNER.logicalTurnId, managerId: OWNER.managerId, generation: OWNER.generation },
      { claimToken: 'lease-token-claimed', leaseSeconds: 300 },
    );
    expect(jobState(jobId)).toBe('claimed');
    engine.markFailedPermanent(opId, 'dead'); // the leased op can never echo
    backdate(inboundSeq, '-10 minutes');

    const res = engine.sweepStuckInbound();

    expect(engine.getInboundStatus(inboundSeq)).toBe('failed');
    expect(jobState(jobId)).toBe('exhausted');
    expect(engine.hasOutstandingTurnRecoveryForScope(SCOPE, CONVERSATION_KEY)).toBe(false);
    expect(res.reclaimedRecoveryOwned).toBe(1);
  });

  it('is idempotent — a second sweep reclaims nothing further', () => {
    const { inboundSeq, opId } = buildTransfer('idem');
    engine.markFailedPermanent(opId, 'dead');
    backdate(inboundSeq, '-10 minutes');

    const first = engine.sweepStuckInbound();
    expect(first.reclaimedRecoveryOwned).toBe(1);

    const second = engine.sweepStuckInbound();
    expect(second.reclaimedRecoveryOwned).toBe(0);
  });
});
