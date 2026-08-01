import { randomUUID } from 'node:crypto';
import { createChildLogger } from '../../logger.ts';
import { TurnRecoveryClaimFenceError } from '../../core/turn-recovery-store.ts';
import type {
  ClaimTurnRecoveryJobOptions,
  ClaimTurnRecoveryJobResult,
  ReassignTurnRecoveryJobResult,
  RenewTurnRecoveryClaimResult,
  RequeueTurnRecoveryJobResult,
  TurnRecoveryAssignmentFence,
  TurnRecoveryClaimFence,
  TurnRecoveryEnumerationPage,
  TurnRecoveryJobRow,
  TurnRecoveryJobTransitionResult,
  TurnRecoveryOwnerIdentity,
  TurnRecoverySupervisorCounts,
} from '../../core/turn-recovery-store.ts';

const log = createChildLogger('turn-recovery-supervisor');

/** Bounded per-scan page size, mirroring RETRY_BATCH_SIZE-style batching. */
const SCAN_PAGE_SIZE = 50;
const DEFAULT_LEASE_SECONDS = 120;
const DEFAULT_BACKOFF_SECONDS = 30;
const SCAN_INTERVAL_MS = 15_000;
const RECLAIM_STALE_LIMIT = 200;
const RENEWAL_RETRY_DELAY_MS = 250;

/**
 * The durability surface this supervisor needs. Narrower than
 * `DurabilityEngine` so unit tests can construct a real `DurabilityEngine`
 * (or a minimal fake) without pulling in unrelated methods.
 */
export interface TurnRecoverySupervisorDurability {
  getOutstandingTurnRecoveryJobsForSupervisor(
    options: { limit?: number; afterId?: number },
  ): TurnRecoveryEnumerationPage;
  claimTurnRecoveryJob(
    jobId: number,
    owner: TurnRecoveryOwnerIdentity,
    options: ClaimTurnRecoveryJobOptions,
  ): ClaimTurnRecoveryJobResult;
  renewTurnRecoveryClaim(
    jobId: number,
    owner: TurnRecoveryOwnerIdentity,
    fence: TurnRecoveryClaimFence,
    options: { leaseSeconds: number },
  ): RenewTurnRecoveryClaimResult;
  completeTurnRecoveryJob(
    jobId: number,
    owner: TurnRecoveryOwnerIdentity,
    fence: TurnRecoveryClaimFence,
  ): TurnRecoveryJobTransitionResult;
  requeueTurnRecoveryJob(
    jobId: number,
    owner: TurnRecoveryOwnerIdentity,
    fence: TurnRecoveryClaimFence,
    backoffSeconds: number,
  ): RequeueTurnRecoveryJobResult;
  reassignPendingTurnRecoveryJob(
    jobId: number,
    currentOwner: TurnRecoveryOwnerIdentity,
    newOwner: TurnRecoveryOwnerIdentity,
    fence: TurnRecoveryAssignmentFence,
  ): ReassignTurnRecoveryJobResult;
  getTurnRecoverySupervisorCounts(): TurnRecoverySupervisorCounts;
  recoverStaleTurnRecoveryJobs(limit?: number): { requeued: number; exhausted: number };
  getTurnRecoveryOriginalDeliveryStatus(jobId: number): { outboundStatus: string } | undefined;
  getTurnRecoverySourceProof(jobId: number): { processingStatus: string; outboundStatus: string } | undefined;
}

/**
 * Terminal outbound states for the ORIGINAL (pre-crash) selected delivery —
 * mirrors completeTurnRecoveryJob's own source-status gate exactly
 * (turn-recovery-store.ts). A job whose original delivery isn't here yet
 * (still `maybe_sent`, or a state this supervisor has never seen) is NOT
 * claimed: claiming and replaying it anyway would risk a real second send
 * before the predecessor reconciliation (#2079's periodic
 * reconcileLiveMaybeSent) has resolved the ambiguous first one, and
 * completeTurnRecoveryJob would refuse to close the job regardless —
 * leaving the claim to expire, get reassigned, and replay AGAIN next cycle.
 */
const ORIGINAL_DELIVERY_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'echoed', 'failed_permanent', 'quarantined',
]);

/**
 * Terminal inbound-processing states for the SOURCE inbound row — the other
 * half of the exact proof `completeTurnRecoveryJob` demands before it will
 * close a job (turn-recovery-store.ts). Paired with
 * `ORIGINAL_DELIVERY_TERMINAL_STATUSES` (reused unchanged — same accepted
 * outbound values) in the already-delivered-source pre-dispatch check below.
 */
const SOURCE_INBOUND_TERMINAL_STATUSES: ReadonlySet<string> = new Set(['complete', 'failed']);

export type TurnRecoveryReplayDispatchResult =
  | { readonly kind: 'delivered' }
  | { readonly kind: 'retryable_failure' }
  /** Newly-discovered unsafe condition; the store's blocked_unsafe path owns this, not a requeue. */
  | { readonly kind: 'blocked_unsafe_detected' };

export interface TurnRecoveryDispatchTarget {
  readonly scope: 'per_chat';
  readonly mapKey: string;
  readonly managerId: string;
  readonly generation: number;
  /** Exact in-memory target; intentionally opaque to the supervisor. */
  readonly session: object;
}

export type TurnRecoveryReplayAbortReason =
  | 'claim_fence_lost'
  | 'renewal_unavailable';

export interface TurnRecoveryReplayAbortControl {
  readonly signal: AbortSignal;
  registerAbort(handler: (reason: TurnRecoveryReplayAbortReason) => Promise<boolean>): void;
}

class ReplayAbortController implements TurnRecoveryReplayAbortControl {
  private readonly controller = new AbortController();
  private handler: ((reason: TurnRecoveryReplayAbortReason) => Promise<boolean>) | null = null;
  private abortPromise: Promise<boolean> | null = null;

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  registerAbort(handler: (reason: TurnRecoveryReplayAbortReason) => Promise<boolean>): void {
    if (this.handler) throw new Error('Turn-recovery replay abort handler is already registered');
    this.handler = handler;
  }

  requestAbort(reason: TurnRecoveryReplayAbortReason): Promise<boolean> {
    if (this.abortPromise) return this.abortPromise;
    this.controller.abort(reason);
    this.abortPromise = this.handler
      ? this.handler(reason).then(
          (proven) => proven,
          () => false,
        )
      : Promise.resolve(false);
    return this.abortPromise;
  }
}

type LeaseGuardResult<T> =
  | { readonly kind: 'settled'; readonly value: T }
  | {
      readonly kind: 'aborted';
      readonly reason: TurnRecoveryReplayAbortReason;
      readonly proven: boolean;
    };

/**
 * Dispatches one claimed job's replay through the *normal* per-chat
 * provider/session/outbound-durability path (never raw SQL, never a
 * synthetic short-circuit). Resolves once the replay's own delivery has
 * reached a proven terminal outcome (echoed) or a retryable/unsafe verdict.
 * The real implementation lives in runtime.ts's wiring; tests inject a fake.
 */
export type TurnRecoveryReplayDispatcher = (
  job: TurnRecoveryJobRow,
  fence: TurnRecoveryClaimFence,
  target?: TurnRecoveryDispatchTarget,
  abortControl?: TurnRecoveryReplayAbortControl,
) => Promise<TurnRecoveryReplayDispatchResult>;

export interface TurnRecoveryScanResult {
  readonly scanned: number;
  readonly claimed: number;
  readonly completed: number;
  readonly requeued: number;
  readonly exhausted: number;
  readonly reassigned: number;
  readonly skippedBlockedUnsafe: number;
  /**
   * Due, replay-safe, and otherwise claimable, but skipped because the
   * ORIGINAL selected delivery hasn't reached a terminal outcome yet — see
   * `ORIGINAL_DELIVERY_TERMINAL_STATUSES`. Left for the predecessor
   * reconciler; re-checked next scan, not requeued (no claim was taken).
   */
  readonly skippedOriginalDeliveryPending: number;
  /**
   * A job whose `scope` is not in `supportedScopes` (when the dependency is
   * supplied) — a PERMANENT skip, not requeued. Wiring a real dispatcher for
   * every scope's session-lifecycle machinery is scoped independently per
   * scope (shared/singleton differ materially from per_chat); an unsupported
   * scope's jobs stay exactly as wedged as they are today (no regression),
   * now visible here instead of silently invisible or churning to exhausted
   * via repeated dispatch failures.
   */
  readonly skippedUnsupportedScope: number;
  /**
   * A job that is otherwise claimable but whose target is not currently
   * dispatchable (when `isDispatchable` is supplied and returns false) — a
   * TRANSIENT skip, not requeued (no claim was taken, so no attempt is
   * consumed and no backoff clock starts). Distinguishing this from
   * `retryable_failure` matters: 5 retryable failures at 30s backoff
   * exhausts a job in minutes, which would durably discard perfectly
   * recoverable work if the only reason it can't run yet is "no live
   * session for this chat" — a condition a cold-restarted instance can take
   * far longer than minutes to resolve (a user has to re-engage the chat).
   */
  readonly skippedNotDispatchable: number;
  /**
   * Store-call exceptions caught and logged during this scan (reassign,
   * claim, complete, or requeue failing) that did NOT abort the scan for
   * other jobs. A scanner that swallows these and reports plain zero
   * progress fails open — a systemic failure (DB issue, a real bug) would
   * look identical to "nothing due yet." Surfaced here so callers/tests/
   * future alert wiring can distinguish the two.
   */
  readonly processingErrors: number;
}

export interface TurnRecoverySupervisorHealth {
  /** Compatibility alias for `lastScanAttemptAt`; never use as proof of successful work. */
  readonly lastScanAt: number | null;
  readonly lastScanAttemptAt: number | null;
  readonly lastSuccessfulScanAt: number | null;
  readonly consecutiveScanFailures: number;
  readonly lastScanFailureReason: TurnRecoveryScanFailureReason | null;
  readonly scans: number;
  readonly claims: number;
  readonly completions: number;
  readonly requeues: number;
  readonly exhaustions: number;
  readonly reassignments: number;
  readonly dispatchFailures: number;
  readonly processingErrors: number;
  readonly leaseRenewals: number;
  readonly leaseRenewalFailures: number;
  readonly renewalRetryableFailures: number;
  readonly renewalOwnershipLosses: number;
  readonly renewalFailClosedAborts: number;
  readonly renewalAbortFailures: number;
  readonly storeCounts: TurnRecoverySupervisorCounts | null;
}

export type TurnRecoveryScanFailureReason =
  | 'durability_unavailable'
  | 'stale_claim_recovery_failed'
  | 'enumeration_failed'
  | 'processing_failed';

export interface TurnRecoverySupervisorDeps {
  readonly instanceName: string;
  readonly durability: () => TurnRecoverySupervisorDurability | null;
  readonly dispatchReplay: TurnRecoveryReplayDispatcher;
  /** Fresh supervisor identity for a claim/reassignment; must vary per call (epoch fencing). */
  readonly freshOwnerIdentity: () => TurnRecoveryOwnerIdentity;
  /**
   * Scopes this instance's `dispatchReplay` actually knows how to run.
   * Omitted means every scope is treated as supported (existing default —
   * matches every current test, which only ever uses 'per_chat'). Wiring a
   * production dispatcher for only a subset of scopes should supply this so
   * unsupported-scope jobs are skipped before claiming rather than churning
   * to exhausted.
   */
  readonly supportedScopes?: ReadonlySet<TurnRecoveryJobRow['scope']>;
  /**
   * Optional pre-claim dispatchability check (e.g. "does a live session
   * exist for this job's chat right now"). Omitted means every due job is
   * treated as dispatchable — existing default. Returning false skips the
   * job for this cycle without claiming it (see `skippedNotDispatchable`).
   */
  readonly isDispatchable?: (job: TurnRecoveryJobRow) => boolean;
  /**
   * Production admission resolver. A non-null result is captured before the
   * claim and threaded unchanged to exact-boundary dispatch validation.
   */
  readonly resolveDispatchTarget?: (
    job: TurnRecoveryJobRow,
  ) => TurnRecoveryDispatchTarget | null;
  readonly leaseSeconds?: number;
  readonly backoffSeconds?: number;
  readonly scanIntervalMs?: number;
}

function emptyScanResult(): TurnRecoveryScanResult {
  return {
    scanned: 0, claimed: 0, completed: 0, requeued: 0,
    exhausted: 0, reassigned: 0, skippedBlockedUnsafe: 0,
    skippedOriginalDeliveryPending: 0, skippedUnsupportedScope: 0,
    skippedNotDispatchable: 0, processingErrors: 0,
  };
}

function mergeScanResult(
  into: {
    scanned: number; claimed: number; completed: number; requeued: number;
    exhausted: number; reassigned: number; skippedBlockedUnsafe: number;
    skippedOriginalDeliveryPending: number; skippedUnsupportedScope: number;
    skippedNotDispatchable: number; processingErrors: number;
  },
  delta: Partial<TurnRecoveryScanResult>,
): void {
  into.scanned += delta.scanned ?? 0;
  into.claimed += delta.claimed ?? 0;
  into.completed += delta.completed ?? 0;
  into.requeued += delta.requeued ?? 0;
  into.exhausted += delta.exhausted ?? 0;
  into.reassigned += delta.reassigned ?? 0;
  into.skippedBlockedUnsafe += delta.skippedBlockedUnsafe ?? 0;
  into.skippedOriginalDeliveryPending += delta.skippedOriginalDeliveryPending ?? 0;
  into.skippedUnsupportedScope += delta.skippedUnsupportedScope ?? 0;
  into.skippedNotDispatchable += delta.skippedNotDispatchable ?? 0;
  into.processingErrors += delta.processingErrors ?? 0;
}

/**
 * Durable turn-recovery execution consumer. Enumerates outstanding
 * `turn_recovery_jobs`, reassigns stale owners with an epoch fence, claims
 * due replay-safe work with a lease, dispatches the exact immutable replay
 * envelope through the normal per-chat pipeline (via the injected
 * dispatcher), and completes/requeues/exhausts strictly through the
 * existing `TurnRecoveryStore` API — never raw SQL, never a second
 * completion path.
 *
 * `blocked_unsafe` jobs are never claimed or auto-replayed here; they
 * remain visible via `health()`/store counts for the operator decision
 * path (PRESTAGE-T4 point 10), which is separate follow-up wiring.
 */
export class TurnRecoverySupervisor {
  private readonly instanceName: string;
  private readonly durability: () => TurnRecoverySupervisorDurability | null;
  private readonly dispatchReplay: TurnRecoveryReplayDispatcher;
  private readonly freshOwnerIdentity: () => TurnRecoveryOwnerIdentity;
  private readonly supportedScopes: ReadonlySet<TurnRecoveryJobRow['scope']> | null;
  private readonly isDispatchable: ((job: TurnRecoveryJobRow) => boolean) | null;
  private readonly resolveDispatchTarget:
    ((job: TurnRecoveryJobRow) => TurnRecoveryDispatchTarget | null) | null;
  private readonly leaseSeconds: number;
  private readonly backoffSeconds: number;
  private readonly scanIntervalMs: number;

  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  private scanInFlight: Promise<TurnRecoveryScanResult> | null = null;
  private cursor = 0;
  private closed = false;

  private scans = 0;
  private claims = 0;
  private completions = 0;
  private requeues = 0;
  private exhaustions = 0;
  private reassignments = 0;
  private dispatchFailures = 0;
  private processingErrors = 0;
  private leaseRenewals = 0;
  private leaseRenewalFailures = 0;
  private renewalRetryableFailures = 0;
  private renewalOwnershipLosses = 0;
  private renewalFailClosedAborts = 0;
  private renewalAbortFailures = 0;
  private lastScanAt: number | null = null;
  private lastSuccessfulScanAt: number | null = null;
  private consecutiveScanFailures = 0;
  private lastScanFailureReason: TurnRecoveryScanFailureReason | null = null;

  constructor(deps: TurnRecoverySupervisorDeps) {
    this.instanceName = deps.instanceName;
    this.durability = deps.durability;
    this.dispatchReplay = deps.dispatchReplay;
    this.freshOwnerIdentity = deps.freshOwnerIdentity;
    this.supportedScopes = deps.supportedScopes ?? null;
    this.isDispatchable = deps.isDispatchable ?? null;
    this.resolveDispatchTarget = deps.resolveDispatchTarget ?? null;
    this.leaseSeconds = deps.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
    this.backoffSeconds = deps.backoffSeconds ?? DEFAULT_BACKOFF_SECONDS;
    this.scanIntervalMs = deps.scanIntervalMs ?? SCAN_INTERVAL_MS;
  }

  /** Start the bounded steady-state scan loop (unref'd; never blocks process exit). */
  start(): void {
    if (this.closed) return;
    this.scheduleScan();
  }

  stop(): void {
    this.closed = true;
    this.clearScanTimer();
  }

  async shutdown(): Promise<void> {
    this.clearScanTimer();
    this.closed = true;
    if (this.scanInFlight) {
      try {
        await this.scanInFlight;
      } catch (err) {
        log.warn({ err }, 'turn recovery supervisor scan in flight during shutdown failed');
      }
    }
  }

  health(): TurnRecoverySupervisorHealth {
    const durability = this.durability();
    return {
      lastScanAt: this.lastScanAt,
      lastScanAttemptAt: this.lastScanAt,
      lastSuccessfulScanAt: this.lastSuccessfulScanAt,
      consecutiveScanFailures: this.consecutiveScanFailures,
      lastScanFailureReason: this.lastScanFailureReason,
      scans: this.scans,
      claims: this.claims,
      completions: this.completions,
      requeues: this.requeues,
      exhaustions: this.exhaustions,
      reassignments: this.reassignments,
      dispatchFailures: this.dispatchFailures,
      processingErrors: this.processingErrors,
      leaseRenewals: this.leaseRenewals,
      leaseRenewalFailures: this.leaseRenewalFailures,
      renewalRetryableFailures: this.renewalRetryableFailures,
      renewalOwnershipLosses: this.renewalOwnershipLosses,
      renewalFailClosedAborts: this.renewalFailClosedAborts,
      renewalAbortFailures: this.renewalAbortFailures,
      storeCounts: durability ? durability.getTurnRecoverySupervisorCounts() : null,
    };
  }

  /** Single-flight: a scan already in progress is returned instead of re-entered. */
  scanOnce(): Promise<TurnRecoveryScanResult> {
    if (this.scanInFlight) return this.scanInFlight;
    const run = this.runScan().finally(() => {
      this.scanInFlight = null;
    });
    this.scanInFlight = run;
    return run;
  }

  private scheduleScan(): void {
    if (this.closed || this.scanTimer || this.scanInFlight) return;
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null;
      void this.scanOnce()
        .catch((err) => {
          log.error({ err }, 'turn recovery supervisor scan failed');
        })
        .finally(() => {
          if (!this.closed) this.scheduleScan();
        });
    }, this.scanIntervalMs);
    this.scanTimer.unref?.();
  }

  private clearScanTimer(): void {
    if (!this.scanTimer) return;
    clearTimeout(this.scanTimer);
    this.scanTimer = null;
  }

  private async runScan(): Promise<TurnRecoveryScanResult> {
    const durability = this.durability();
    this.scans += 1;
    this.lastScanAt = Date.now();
    if (this.closed) return emptyScanResult();
    if (!durability) {
      this.recordScanFailure('durability_unavailable');
      return emptyScanResult();
    }

    // Sweep expired claims back to pending/exhausted first so this cycle's
    // enumeration can see freshly-reclaimable rows (store-owned transition).
    let failureReason: TurnRecoveryScanFailureReason | null = null;
    try {
      durability.recoverStaleTurnRecoveryJobs(RECLAIM_STALE_LIMIT);
    } catch (err) {
      failureReason = 'stale_claim_recovery_failed';
      log.warn({ err }, 'turn recovery supervisor stale-claim sweep failed');
    }

    let page: TurnRecoveryEnumerationPage;
    try {
      page = durability.getOutstandingTurnRecoveryJobsForSupervisor({
        limit: SCAN_PAGE_SIZE,
        afterId: this.cursor,
      });
    } catch (err) {
      this.recordScanFailure('enumeration_failed');
      throw err;
    }
    this.cursor = page.scanComplete ? 0 : (page.nextCursor ?? 0);

    const totals = {
      scanned: page.jobs.length, claimed: 0, completed: 0, requeued: 0,
      exhausted: 0, reassigned: 0, skippedBlockedUnsafe: 0,
      skippedOriginalDeliveryPending: 0, skippedUnsupportedScope: 0,
      skippedNotDispatchable: 0, processingErrors: 0,
    };

    try {
      for (const job of page.jobs) {
        // eslint-disable-next-line no-await-in-loop -- bounded batch, intentionally sequential per PRESTAGE-T4 fair-scheduling requirement; expires 2026-12-31
        const delta = await this.processJob(durability, job);
        mergeScanResult(totals, delta);
      }
    } catch (err) {
      this.recordScanFailure('processing_failed');
      throw err;
    }

    if (totals.processingErrors > 0) {
      failureReason = failureReason ?? 'processing_failed';
    }
    if (failureReason) this.recordScanFailure(failureReason);
    else this.recordScanSuccess();
    return totals;
  }

  private recordScanFailure(reason: TurnRecoveryScanFailureReason): void {
    this.consecutiveScanFailures += 1;
    this.lastScanFailureReason = reason;
  }

  private recordScanSuccess(): void {
    this.lastSuccessfulScanAt = Date.now();
    this.consecutiveScanFailures = 0;
    this.lastScanFailureReason = null;
  }

  private async processJob(
    durability: TurnRecoverySupervisorDurability,
    job: TurnRecoveryJobRow,
  ): Promise<Partial<TurnRecoveryScanResult>> {
    if (job.state === 'blocked_unsafe') {
      return { skippedBlockedUnsafe: 1 };
    }
    if (job.state === 'exhausted' || job.state === 'completed') {
      return {};
    }
    // Both pre-claim: neither consumes an attempt or starts a backoff clock.
    // Unsupported scope is permanent (this dispatcher never handles it);
    // not-dispatchable is transient (e.g. no live session yet) — conflating
    // either with retryable_failure would churn the job to exhausted in
    // minutes over a condition dispatchReplay was never going to resolve.
    if (this.supportedScopes && !this.supportedScopes.has(job.scope)) {
      return { skippedUnsupportedScope: 1 };
    }
    let dispatchTarget: TurnRecoveryDispatchTarget | undefined;
    if (this.resolveDispatchTarget) {
      const resolved = this.resolveDispatchTarget(job);
      if (!resolved) return { skippedNotDispatchable: 1 };
      dispatchTarget = resolved;
    } else if (this.isDispatchable && !this.isDispatchable(job)) {
      return { skippedNotDispatchable: 1 };
    }

    if (job.state === 'claimed') {
      const expired = job.claim_expires_at !== null && job.claim_expires_at <= isoNow();
      if (!expired) return {};
      const currentOwner: TurnRecoveryOwnerIdentity = {
        logicalTurnId: job.assigned_owner_logical_turn_id,
        managerId: job.assigned_owner_manager_id,
        generation: job.assigned_owner_generation,
      };
      const newOwner = this.freshOwnerIdentity();
      try {
        const reassigned = durability.reassignPendingTurnRecoveryJob(
          job.id,
          currentOwner,
          newOwner,
          { claimEpoch: job.claim_epoch, assignmentEpoch: job.assignment_epoch },
        );
        this.reassignments += 1;
        if (!reassigned.applied) return {};
      } catch (err) {
        this.processingErrors += 1;
        log.warn({ err, jobId: job.id }, 'turn recovery supervisor reassignment failed');
        return { processingErrors: 1 };
      }
      return this.claimAndReplay(
        durability,
        job,
        newOwner,
        { reassigned: 1 },
        dispatchTarget,
      );
    }

    if (job.state === 'pending') {
      if (job.next_attempt_at > isoNow()) return {};
      if (job.replay_safe !== 1) return { skippedBlockedUnsafe: 1 };
      // A never-reassigned job's assigned owner still equals its
      // creation-time recovery-owner identity — that IS the "current
      // assigned owner" the store's ownership check (getOwnedTurnRecoveryJob)
      // requires. A fresh identity is only meaningful once there is a PRIOR
      // claimant to distinguish from (the expired-claim/reassignment branch
      // above); inventing one here throws "may only be changed by its
      // assigned recovery owner" — self-caught via the first real test run.
      const owner: TurnRecoveryOwnerIdentity = {
        logicalTurnId: job.assigned_owner_logical_turn_id,
        managerId: job.assigned_owner_manager_id,
        generation: job.assigned_owner_generation,
      };
      return this.claimAndReplay(durability, job, owner, {}, dispatchTarget);
    }

    return {};
  }

  private async claimAndReplay(
    durability: TurnRecoverySupervisorDurability,
    job: TurnRecoveryJobRow,
    owner: TurnRecoveryOwnerIdentity,
    baseDelta: Partial<TurnRecoveryScanResult>,
    dispatchTarget?: TurnRecoveryDispatchTarget,
  ): Promise<Partial<TurnRecoveryScanResult>> {
    const jobId = job.id;

    // Duplicate-send guard: completeTurnRecoveryJob will refuse to close
    // this job while its ORIGINAL selected delivery is still ambiguous
    // (maybe_sent), regardless of how the replay dispatch turns out. Check
    // BEFORE claiming — claiming and dispatching anyway would mean a real
    // second send goes out, then the claim just sits until its lease
    // expires and the job gets reassigned+replayed again next cycle. Left
    // for the predecessor reconciler (#2079's reconcileLiveMaybeSent); no
    // claim is taken, so this is a true no-op, safely retried next scan.
    let originalDeliveryStatus: { outboundStatus: string } | undefined;
    try {
      originalDeliveryStatus = durability.getTurnRecoveryOriginalDeliveryStatus(jobId);
    } catch (err) {
      this.processingErrors += 1;
      log.warn({ err, jobId }, 'turn recovery supervisor original-delivery status check failed');
      return { ...baseDelta, processingErrors: 1 };
    }
    if (
      !originalDeliveryStatus
      || !ORIGINAL_DELIVERY_TERMINAL_STATUSES.has(originalDeliveryStatus.outboundStatus)
    ) {
      return { ...baseDelta, skippedOriginalDeliveryPending: 1 };
    }

    const claimToken = randomUUID();
    let claim: ClaimTurnRecoveryJobResult;
    try {
      claim = durability.claimTurnRecoveryJob(jobId, owner, {
        claimToken,
        leaseSeconds: this.leaseSeconds,
      });
    } catch (err) {
      this.processingErrors += 1;
      log.warn({ err, jobId }, 'turn recovery supervisor claim failed');
      return { ...baseDelta, processingErrors: 1 };
    }
    if (!claim.applied) return baseDelta;
    this.claims += 1;

    const fence: TurnRecoveryClaimFence = { claimToken: claim.claimToken, claimEpoch: claim.claimEpoch };

    // Already-delivered-source pre-dispatch guard (boterr-lead ruling): a
    // job's source can become proven WITHOUT this job's own dispatch ever
    // running — e.g. an EARLIER replay of this same job itself deferred to
    // a NEW recovery job (see dispatchTurnRecoveryReplayForJob's post-check,
    // turn-recovery-dispatch.ts), that successor has since completed for
    // real, and this job is only now being reclaimed after backoff. At that
    // point the successor is no longer outstanding, so the excludeJobId
    // admission check no longer blocks this claim — but dispatching again
    // would re-invoke the session for content that ALREADY went out. Check
    // the SAME proof completeTurnRecoveryJob demands BEFORE ever calling
    // dispatchReplay; if it already holds, this job's fate is decided —
    // close it directly and never dispatch.
    let sourceProof: { processingStatus: string; outboundStatus: string } | undefined;
    try {
      sourceProof = durability.getTurnRecoverySourceProof(jobId);
    } catch (err) {
      this.processingErrors += 1;
      log.warn({ err, jobId }, 'turn recovery supervisor pre-dispatch source-proof check failed');
      return { ...baseDelta, claimed: 1, processingErrors: 1 };
    }
    if (
      sourceProof
      && SOURCE_INBOUND_TERMINAL_STATUSES.has(sourceProof.processingStatus)
      && ORIGINAL_DELIVERY_TERMINAL_STATUSES.has(sourceProof.outboundStatus)
    ) {
      try {
        const result = durability.completeTurnRecoveryJob(jobId, owner, fence);
        this.completions += 1;
        return { ...baseDelta, claimed: 1, completed: result.applied ? 1 : 0 };
      } catch (err) {
        this.processingErrors += 1;
        log.error({ err, jobId }, 'turn recovery supervisor completion failed after already-proven pre-dispatch check');
        return { ...baseDelta, claimed: 1, processingErrors: 1 };
      }
    }

    // `getOutstandingTurnRecoveryJobsForSupervisor` deliberately hides live
    // (non-expired) claims, so the just-claimed row can no longer be
    // re-fetched through it — thread the pre-claim row through instead; its
    // replay-relevant fields (sender/text/scope/conversation) are immutable.
    let outcome: TurnRecoveryReplayDispatchResult;
    try {
      const abortControl = new ReplayAbortController();
      const guarded = await this.renewLeaseWhilePending(
        durability,
        jobId,
        owner,
        fence,
        claim.claimExpiresAt,
        this.dispatchReplay(job, fence, dispatchTarget, abortControl),
        abortControl,
      );
      if (guarded.kind === 'aborted') {
        if (!guarded.proven || guarded.reason === 'claim_fence_lost') {
          return { ...baseDelta, claimed: 1 };
        }
        outcome = { kind: 'retryable_failure' };
      } else {
        outcome = guarded.value;
      }
    } catch (err) {
      this.dispatchFailures += 1;
      log.warn({ err, jobId }, 'turn recovery supervisor replay dispatch threw');
      outcome = { kind: 'retryable_failure' };
    }

    if (outcome.kind === 'delivered') {
      try {
        const result = durability.completeTurnRecoveryJob(jobId, owner, fence);
        this.completions += 1;
        return { ...baseDelta, claimed: 1, completed: result.applied ? 1 : 0 };
      } catch (err) {
        this.processingErrors += 1;
        log.error({ err, jobId }, 'turn recovery supervisor completion failed after delivered replay');
        return { ...baseDelta, claimed: 1, processingErrors: 1 };
      }
    }

    if (outcome.kind === 'retryable_failure') {
      try {
        const result = durability.requeueTurnRecoveryJob(jobId, owner, fence, this.backoffSeconds);
        if (result.state === 'exhausted') {
          this.exhaustions += 1;
          return { ...baseDelta, claimed: 1, exhausted: 1 };
        }
        this.requeues += 1;
        return { ...baseDelta, claimed: 1, requeued: 1 };
      } catch (err) {
        this.processingErrors += 1;
        log.error({ err, jobId }, 'turn recovery supervisor requeue failed after retryable dispatch failure');
        return { ...baseDelta, claimed: 1, processingErrors: 1 };
      }
    }

    // blocked_unsafe_detected: leave the job claimed-then-expired to fall
    // back into the reassignment path next scan rather than inventing a
    // second unsafe transition here; the store owns blocked_unsafe writes.
    log.warn(
      { instanceName: this.instanceName, jobId },
      'turn recovery supervisor replay dispatch reported a newly-unsafe job',
    );
    return { ...baseDelta, claimed: 1 };
  }

  /**
   * PRESTAGE-T4 point 7: renew the lease during a long provider turn. A
   * replay runs through the full normal provider/session pipeline, which can
   * take far longer than `leaseSeconds`; without renewal an in-flight replay
   * would have its own claim expire and get reassigned to a fresh owner
   * mid-flight, producing two concurrent replays of the same job. Renews at
   * half the lease duration so a single transient renewal failure still
   * leaves margin before the lease actually lapses. Semantic fence loss or
   * transient failures that consume the safety margin reserve settlement for
   * cooperative abort: a concurrently settling dispatch cannot win while the
   * exact provider-generation termination proof is still pending.
   */
  private renewLeaseWhilePending<T>(
    durability: TurnRecoverySupervisorDurability,
    jobId: number,
    owner: TurnRecoveryOwnerIdentity,
    fence: TurnRecoveryClaimFence,
    initialClaimExpiresAt: string,
    pending: Promise<T>,
    abortControl: ReplayAbortController,
  ): Promise<LeaseGuardResult<T>> {
    return new Promise<LeaseGuardResult<T>>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let settled = false;
      let aborting = false;
      let claimExpiresAtMs = parseRecoveryTimestamp(initialClaimExpiresAt);
      const leaseMs = this.leaseSeconds * 1_000;
      const abortMarginMs = Math.min(15_000, Math.max(250, Math.floor(leaseMs / 4)));

      const clearTimer = (): void => {
        if (timer) clearTimeout(timer);
        timer = null;
      };
      const settle = (result: LeaseGuardResult<T>): void => {
        if (settled) return;
        settled = true;
        clearTimer();
        resolve(result);
      };
      const finishPending = (result: LeaseGuardResult<T>): void => {
        if (aborting) return;
        settle(result);
      };
      const abortReplay = async (reason: TurnRecoveryReplayAbortReason): Promise<void> => {
        if (settled || aborting) return;
        aborting = true;
        clearTimer();
        const proven = await abortControl.requestAbort(reason);
        if (proven) this.renewalFailClosedAborts += 1;
        else this.renewalAbortFailures += 1;
        settle({ kind: 'aborted', reason, proven });
      };
      const schedule = (delayMs: number): void => {
        clearTimer();
        timer = setTimeout(() => {
          timer = null;
          void renewOrAbort();
        }, Math.max(1, Math.floor(delayMs)));
        timer.unref?.();
      };
      const scheduleNormalRenewal = (): void => {
        const remainingMs = claimExpiresAtMs - Date.now();
        const safetyDeadlineMs = claimExpiresAtMs - abortMarginMs;
        if (Date.now() >= safetyDeadlineMs) {
          void abortReplay('renewal_unavailable');
          return;
        }
        schedule(Math.min(
          Math.max(1, Math.floor(remainingMs / 2)),
          Math.max(1, safetyDeadlineMs - Date.now()),
        ));
      };
      const renewOrAbort = async (): Promise<void> => {
        if (settled) return;
        const safetyDeadlineMs = claimExpiresAtMs - abortMarginMs;
        if (Date.now() >= safetyDeadlineMs) {
          await abortReplay('renewal_unavailable');
          return;
        }
        try {
          const renewed = durability.renewTurnRecoveryClaim(
            jobId,
            owner,
            fence,
            { leaseSeconds: this.leaseSeconds },
          );
          this.leaseRenewals += 1;
          claimExpiresAtMs = parseRecoveryTimestamp(renewed.claimExpiresAt);
          scheduleNormalRenewal();
        } catch (err) {
          this.leaseRenewalFailures += 1;
          if (err instanceof TurnRecoveryClaimFenceError) {
            this.renewalOwnershipLosses += 1;
            await abortReplay('claim_fence_lost');
            return;
          }
          this.renewalRetryableFailures += 1;
          log.warn({ err, jobId }, 'turn recovery supervisor lease renewal failed; retrying within lease margin');
          const retryWindowMs = safetyDeadlineMs - Date.now();
          if (retryWindowMs <= 0) {
            await abortReplay('renewal_unavailable');
            return;
          }
          schedule(Math.min(RENEWAL_RETRY_DELAY_MS, retryWindowMs));
        }
      };

      pending.then(
        (value) => finishPending({ kind: 'settled', value }),
        (err) => {
          if (settled || aborting) return;
          settled = true;
          clearTimer();
          reject(err);
        },
      );
      scheduleNormalRenewal();
    });
  }
}

function parseRecoveryTimestamp(value: string): number {
  const parsed = Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  if (!Number.isFinite(parsed)) throw new Error('Invalid turn-recovery claim expiry');
  return parsed;
}

function isoNow(): string {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

export interface TurnRecoverySupervisorHeartbeatVerdict {
  readonly healthy: boolean;
  readonly reason: 'ok' | 'never_succeeded' | 'stale_success' | 'repeated_failures';
}

/**
 * Evaluates whether the supervisor's own scan loop is alive, from OUTSIDE
 * the supervisor: a crashed or stalled scan timer cannot page on its own
 * behalf, so this is a pure function of a `health()` snapshot the caller
 * captured on its own periodic timer (mirrors the existing degradation-
 * interval pattern in main.ts) — never invoked by the supervisor itself.
 * A supervisor that stops cycling is a dormant consumer at one more remove
 * (PRESTAGE-T4's own missing-consumer defect, rebuilt); this is the
 * required `turn_recovery_supervisor_unavailable` typed-alert predicate.
 * `TurnRecoveryDeadman` evaluates this snapshot on its own timer and owns
 * the checked alert/clear lifecycle.
 */
export function evaluateTurnRecoverySupervisorHeartbeat(
  health: TurnRecoverySupervisorHealth,
  opts: { nowMs: number; staleAfterMs: number; maxConsecutiveFailures?: number },
): TurnRecoverySupervisorHeartbeatVerdict {
  const maxConsecutiveFailures = opts.maxConsecutiveFailures ?? 3;
  if (health.consecutiveScanFailures >= maxConsecutiveFailures) {
    return { healthy: false, reason: 'repeated_failures' };
  }
  if (health.lastSuccessfulScanAt === null) {
    return { healthy: false, reason: 'never_succeeded' };
  }
  const age = opts.nowMs - health.lastSuccessfulScanAt;
  if (age > opts.staleAfterMs) {
    return { healthy: false, reason: 'stale_success' };
  }
  return { healthy: true, reason: 'ok' };
}
