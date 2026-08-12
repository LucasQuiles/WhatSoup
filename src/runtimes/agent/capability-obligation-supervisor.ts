/**
 * Capability-obligation supervisor (capability-obligation replay, D5/D6/D7).
 *
 * Drains capability debt through the NORMAL journaled turn pipeline once — and
 * only once — the exact-bound gates pass. Mirrors the turn-recovery-supervisor
 * idiom (scan → admission → claim/lease/fence → dispatch → settle/requeue) with
 * narrow injected ports so real SQLite unit tests can drive every branch
 * without the full runtime:
 *
 *  - ATTESTATION admission (D5): `findAdmissibleAttestation` against the
 *    binding the runtime port derives from live facts + the obligation's
 *    contract. Any skip consumes zero attempts.
 *  - MEDIA admission (D3): retained bytes are reopened and re-hashed BEFORE
 *    claiming; missing/mismatch → `blocked_media` without consuming an attempt.
 *  - CLAIM (D7): the database CAS is the single admission point; readiness
 *    flapping only wakes the scanner.
 *  - DISPATCH: the port journals a NEW minted inbound (`obl:<id>:<attempt>`)
 *    and enters `createRuntimeTurnForDispatch`/`processPerChatTurn`. A
 *    retryable outcome (cold/superseded session) requeues under bounded
 *    backoff via the fence.
 *  - SETTLEMENT (D6): a claimed obligation completes ONLY on the full typed
 *    evidence chain (execution receipt + worker terminal + delivery proof);
 *    conclusive pre-accept failure requeues bounded; ambiguity quarantines
 *    (`blocked_ambiguous`) and is never auto-retried.
 *  - RECLAIM (D7): expired leases requeue only when the durable acceptance
 *    marker proves the provider never began; otherwise quarantine.
 *
 * Group obligations never reach this path while `waiting_approval` (the store
 * scan selects `waiting_capability` only; the approval transition is guarded in
 * the schema itself).
 */
import { createChildLogger } from '../../logger.ts';
import {
  findAdmissibleAttestation,
  type AttestationAdmission,
  type CapabilityAttestationBinding,
} from '../../core/capability-attestation.ts';
import type {
  CapabilityObligationDueRow,
  CapabilityObligationClaimFence,
  CapabilityObligationStore,
} from '../../core/capability-obligation-store.ts';
import type { Database } from '../../core/database.ts';
import { verifyRetainedMedia } from '../../core/obligation-media-retention.ts';

const log = createChildLogger('agent:capability-obligation-supervisor');

export const OBLIGATION_LEASE_SECONDS = 300;
export const OBLIGATION_BACKOFF_SECONDS = 60;
const SCAN_LIMIT = 10;

export type ObligationDispatchOutcome = 'dispatched' | 'retryable';

export interface ObligationDispatchPort {
  /**
   * Journal the minted inbound and enter the normal turn pipeline. Must NOT
   * send through transport directly. 'retryable' = target/session not current;
   * the obligation requeues under bounded backoff.
   */
  dispatch(
    obligation: CapabilityObligationDueRow,
    mintedMessageId: string,
    fence: CapabilityObligationClaimFence,
  ): Promise<ObligationDispatchOutcome>;
}

export interface ObligationAttestationPort {
  /** Live runtime facts + the obligation's contract → the exact D5 binding. */
  binding(obligation: CapabilityObligationDueRow): CapabilityAttestationBinding;
}

export type ObligationSettlementEvidence =
  | { kind: 'completed'; executionReceiptId: number; completionProofId: string }
  | { kind: 'pre_accept_failure' }
  | { kind: 'ambiguous' };

export interface ObligationEvidencePort {
  /**
   * Durable markers that the provider MAY have begun executing an obligation's
   * current attempt (e.g. its minted inbound was journaled). Used by lease
   * reclaim to choose requeue vs quarantine — fail closed toward quarantine.
   */
  providerAcceptedIds(): ReadonlySet<number>;
  /** Durable settlement evidence for a claimed obligation; undefined = still running. */
  settlementEvidence(obligationId: number): ObligationSettlementEvidence | undefined;
}

export interface CapabilityObligationSupervisorOptions {
  db: Database;
  store: CapabilityObligationStore;
  dispatchPort: ObligationDispatchPort;
  attestationPort: ObligationAttestationPort;
  evidencePort: ObligationEvidencePort;
  leaseSeconds?: number;
  backoffSeconds?: number;
}

export interface ObligationTickReport {
  reclaimed: { requeued: number[]; quarantined: number[] };
  settled: number[];
  requeuedAfterPreAcceptFailure: number[];
  quarantinedAmbiguous: number[];
  attestationSkips: Array<{ id: number; reason: string }>;
  mediaBlocked: number[];
  claimed: number[];
  dispatched: number[];
  requeuedRetryable: number[];
}

export class CapabilityObligationSupervisor {
  private readonly db: Database;
  private readonly store: CapabilityObligationStore;
  private readonly dispatchPort: ObligationDispatchPort;
  private readonly attestationPort: ObligationAttestationPort;
  private readonly evidencePort: ObligationEvidencePort;
  private readonly leaseSeconds: number;
  private readonly backoffSeconds: number;
  private claimCounter = 0;

  constructor(options: CapabilityObligationSupervisorOptions) {
    this.db = options.db;
    this.store = options.store;
    this.dispatchPort = options.dispatchPort;
    this.attestationPort = options.attestationPort;
    this.evidencePort = options.evidencePort;
    this.leaseSeconds = options.leaseSeconds ?? OBLIGATION_LEASE_SECONDS;
    this.backoffSeconds = options.backoffSeconds ?? OBLIGATION_BACKOFF_SECONDS;
  }

  /** One full pass: reclaim → settle → scan/admit/claim/dispatch. */
  async tick(): Promise<ObligationTickReport> {
    const report: ObligationTickReport = {
      reclaimed: { requeued: [], quarantined: [] },
      settled: [],
      requeuedAfterPreAcceptFailure: [],
      quarantinedAmbiguous: [],
      attestationSkips: [],
      mediaBlocked: [],
      claimed: [],
      dispatched: [],
      requeuedRetryable: [],
    };

    report.reclaimed = this.store.reclaimExpiredClaims({
      providerAcceptedIds: this.evidencePort.providerAcceptedIds(),
    });

    this.settleClaimed(report);
    await this.scanAndDispatch(report);
    return report;
  }

  private settleClaimed(report: ObligationTickReport): void {
    for (const claimed of this.store.listClaimedObligations()) {
      const evidence = this.evidencePort.settlementEvidence(claimed.id);
      if (evidence === undefined) continue; // still running under a live lease
      const fence: CapabilityObligationClaimFence = {
        claimToken: claimed.claimToken,
        claimEpoch: claimed.claimEpoch,
      };
      switch (evidence.kind) {
        case 'completed': {
          const settled = this.store.settleCompleted(claimed.id, fence, {
            executionReceiptId: evidence.executionReceiptId,
            completionProofId: evidence.completionProofId,
          });
          if (settled.applied) report.settled.push(claimed.id);
          break;
        }
        case 'pre_accept_failure': {
          const requeued = this.store.requeueObligation(claimed.id, fence, {
            backoffSeconds: this.backoffSeconds,
          });
          if (requeued.applied) report.requeuedAfterPreAcceptFailure.push(claimed.id);
          break;
        }
        case 'ambiguous': {
          const blocked = this.store.blockObligation(
            claimed.id,
            fence,
            'blocked_ambiguous',
            'execution_outcome_ambiguous',
          );
          if (blocked.applied) report.quarantinedAmbiguous.push(claimed.id);
          break;
        }
      }
    }
  }

  private async scanAndDispatch(report: ObligationTickReport): Promise<void> {
    for (const due of this.store.listDueObligations(SCAN_LIMIT)) {
      // D5 — exact-bound attestation; skips consume zero attempts.
      const admission: AttestationAdmission = findAdmissibleAttestation(
        this.db,
        this.attestationPort.binding(due),
      );
      if (admission.outcome === 'skip') {
        report.attestationSkips.push({ id: due.id, reason: admission.reason });
        continue;
      }

      // D3 — media integrity BEFORE claim; block without consuming an attempt.
      if (due.retainedMediaPath !== null) {
        const verdict = await verifyRetainedMedia({
          path: due.retainedMediaPath,
          sha256: due.mediaSha256!,
          bytes: due.mediaBytes!,
        });
        if (verdict !== 'ok') {
          const blocked = this.store.blockWaitingObligation(due.id, `media_${verdict}`);
          if (blocked.applied) report.mediaBlocked.push(due.id);
          continue;
        }
      }

      // D7 — the transactional claim is the sole admission point.
      const claimToken = `obl-claim-${Date.now()}-${++this.claimCounter}`;
      const claim = this.store.claimObligation(due.id, {
        claimToken,
        leaseSeconds: this.leaseSeconds,
      });
      if (!claim.applied) continue; // lost the race — another scanner owns it
      report.claimed.push(due.id);
      const fence: CapabilityObligationClaimFence = {
        claimToken,
        claimEpoch: claim.claimEpoch,
      };

      const mintedMessageId = `obl:${due.id}:${claim.attemptCount}`;
      let outcome: ObligationDispatchOutcome;
      try {
        outcome = await this.dispatchPort.dispatch(due, mintedMessageId, fence);
      } catch (err) {
        log.warn({ err, obligationId: due.id }, 'obligation dispatch threw; requeueing under fence');
        outcome = 'retryable';
      }
      if (outcome === 'dispatched') {
        report.dispatched.push(due.id);
      } else {
        const requeued = this.store.requeueObligation(due.id, fence, {
          backoffSeconds: this.backoffSeconds,
        });
        if (requeued.applied) report.requeuedRetryable.push(due.id);
      }
    }
  }
}
