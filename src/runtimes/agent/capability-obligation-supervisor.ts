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
import { systemClock } from '../../lib/clock.ts';
import { createChildLogger } from '../../logger.ts';
import {
  attestationBindingDigest,
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

export type ObligationDispatchOutcome = 'dispatched' | 'retryable' | 'ambiguous';

/**
 * The single dispatch-preparation result (r14 F3). The serving target is
 * resolved ONCE; both the D5 admission binding and the dispatch derive from that
 * one resolution, so a session that recycles onto a different provider/generation
 * between admission and dispatch can no longer run a replay on a never-attested
 * harness (the prior split ports each resolved independently — the TOCTOU).
 */
export interface PreparedObligationDispatch {
  /** The exact D5 binding — carries the provider ACTUALLY serving this chat now. */
  binding: CapabilityAttestationBinding;
  /**
   * Journal the minted inbound and enter the normal turn pipeline against the
   * SAME resolved target the binding came from (re-verified at the provider
   * boundary). Must NOT send through transport directly. 'retryable' = the
   * target was not current at the boundary (nothing crossed it) → requeue under
   * bounded backoff. 'ambiguous' = the turn crossed the provider boundary and
   * then failed, so the side effect may or may not have happened → quarantine
   * `blocked_ambiguous`, NEVER auto-retried. `null` when the target is not
   * dispatchable (cold/not-current) — `binding` then carries the fail-closed
   * sentinel provider, so admission skips before dispatch is ever reached.
   */
  dispatch:
    | ((
        mintedMessageId: string,
        fence: CapabilityObligationClaimFence,
        /** The claimed attempt this dispatch executes (mintedMessageId embeds it too). */
        attemptNumber: number,
      ) => Promise<ObligationDispatchOutcome>)
    | null;
}

export interface ObligationDispatchPort {
  /**
   * Resolve the serving target for the obligation's chat ONCE and return the D5
   * binding plus a dispatch bound to that exact resolution (r14 F3). Called once
   * per due obligation at the top of the scan iteration.
   */
  prepare(obligation: CapabilityObligationDueRow): PreparedObligationDispatch;
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
  /**
   * Durable settlement evidence for a claimed obligation's CURRENT attempt;
   * undefined = still running. Implementations must correlate through the
   * supplied claim identity (claim epoch + attempt number) — evidence from a
   * prior attempt must never settle the current one (D6).
   */
  settlementEvidence(
    obligationId: number,
    attempt: { claimEpoch: number; attemptCount: number },
  ): ObligationSettlementEvidence | undefined;
}

export interface CapabilityObligationSupervisorOptions {
  db: Database;
  store: CapabilityObligationStore;
  dispatchPort: ObligationDispatchPort;
  evidencePort: ObligationEvidencePort;
  leaseSeconds?: number;
  backoffSeconds?: number;
  /** A-08: finite retained-media horizon in seconds; expired media never claims. */
  mediaMaxAgeSeconds?: number;
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
  private readonly evidencePort: ObligationEvidencePort;
  private readonly leaseSeconds: number;
  private readonly backoffSeconds: number;
  private readonly mediaMaxAgeSeconds: number | undefined;
  private claimCounter = 0;

  constructor(options: CapabilityObligationSupervisorOptions) {
    this.db = options.db;
    this.store = options.store;
    this.dispatchPort = options.dispatchPort;
    this.evidencePort = options.evidencePort;
    this.leaseSeconds = options.leaseSeconds ?? OBLIGATION_LEASE_SECONDS;
    this.backoffSeconds = options.backoffSeconds ?? OBLIGATION_BACKOFF_SECONDS;
    this.mediaMaxAgeSeconds = options.mediaMaxAgeSeconds;
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
      const evidence = this.evidencePort.settlementEvidence(claimed.id, {
        claimEpoch: claimed.claimEpoch,
        attemptCount: claimed.attemptCount,
      });
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
    const dueRows = this.store.listDueObligations(SCAN_LIMIT, {
      mediaMaxAgeSeconds: this.mediaMaxAgeSeconds,
    });
    for (const due of dueRows) {
      // r14 F3 — resolve the serving target ONCE; the admission binding and the
      // dispatch below both come from this single resolution (no second resolve
      // that could pick a recycled provider/generation after admission).
      const prepared = this.dispatchPort.prepare(due);

      // D5 — exact-bound attestation; skips consume zero attempts.
      const admission: AttestationAdmission = findAdmissibleAttestation(this.db, prepared.binding);
      if (admission.outcome === 'skip') {
        report.attestationSkips.push({ id: due.id, reason: admission.reason });
        continue;
      }

      // A-08 — retained media past the finite horizon never claims.
      if (due.mediaExpired) {
        const blocked = this.store.blockWaitingObligation(due.id, 'media_retention_expired');
        if (blocked.applied) report.mediaBlocked.push(due.id);
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

      // D7 — the transactional claim is the sole admission point. r14 F1 — bind
      // the claim to the attestation that ACTUALLY admitted: its binding-identity
      // digest must equal the group approval's drain_attestation_digest, or a
      // drain approved under one release/attestation could run under a different
      // release-new attestation that admits here. Non-group claims ignore it.
      const claimToken = `obl-claim-${systemClock.now()}-${++this.claimCounter}`;
      const claim = this.store.claimObligation(due.id, {
        claimToken,
        leaseSeconds: this.leaseSeconds,
        // r15 F4 — the EXACT admitted attestation row must still be admissible in
        // the claim transaction (revocation/expiry during the media-verify await).
        admissionAttestationId: admission.attestationId,
        admissionAttestationDigest: attestationBindingDigest(prepared.binding),
      });
      if (!claim.applied) continue; // lost the race — another scanner owns it
      report.claimed.push(due.id);
      const fence: CapabilityObligationClaimFence = {
        claimToken,
        claimEpoch: claim.claimEpoch,
      };

      // A real attestation admitted, so the target resolved and `dispatch` is
      // non-null; guard fail-closed if it somehow became undispatchable.
      if (prepared.dispatch === null) {
        const requeued = this.store.requeueObligation(due.id, fence, {
          backoffSeconds: this.backoffSeconds,
        });
        if (requeued.applied) report.requeuedRetryable.push(due.id);
        continue;
      }

      const mintedMessageId = `obl:${due.id}:${claim.attemptCount}`;
      let outcome: ObligationDispatchOutcome;
      try {
        outcome = await prepared.dispatch(mintedMessageId, fence, claim.attemptCount);
      } catch (err) {
        // The dispatch port converts every post-boundary failure to 'ambiguous'
        // itself, so a THROW that escapes to here cannot be proven pre-boundary.
        // Fail closed: quarantine rather than auto-retry a possibly-effected turn.
        log.warn({ err, obligationId: due.id }, 'obligation dispatch threw; quarantining fail-closed under fence');
        outcome = 'ambiguous';
      }
      if (outcome === 'dispatched') {
        report.dispatched.push(due.id);
      } else if (outcome === 'ambiguous') {
        // Crossed the provider boundary then failed — the side effect is
        // unprovable, so the obligation is quarantined and NEVER auto-retried.
        const blocked = this.store.blockObligation(due.id, fence, 'blocked_ambiguous', 'dispatch_outcome_ambiguous');
        if (blocked.applied) report.quarantinedAmbiguous.push(due.id);
      } else {
        const requeued = this.store.requeueObligation(due.id, fence, {
          backoffSeconds: this.backoffSeconds,
        });
        if (requeued.applied) report.requeuedRetryable.push(due.id);
      }
    }
  }
}
