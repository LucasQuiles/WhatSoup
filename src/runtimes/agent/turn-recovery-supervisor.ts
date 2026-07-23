import { randomUUID } from 'node:crypto';
import { createChildLogger } from '../../logger.ts';
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

export type TurnRecoveryReplayDispatchResult =
  | { readonly kind: 'delivered' }
  | { readonly kind: 'retryable_failure' }
  /** Newly-discovered unsafe condition; the store's blocked_unsafe path owns this, not a requeue. */
  | { readonly kind: 'blocked_unsafe_detected' };

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
  readonly lastScanAt: number | null;
  readonly scans: number;
  readonly claims: number;
  readonly completions: number;
  readonly requeues: number;
  readonly exhaustions: number;
  readonly reassignments: number;
  readonly dispatchFailures: number;
  readonly processingErrors: number;
  readonly storeCounts: TurnRecoverySupervisorCounts | null;
}

export interface TurnRecoverySupervisorDeps {
  readonly instanceName: string;
  readonly durability: () => TurnRecoverySupervisorDurability | null;
  readonly dispatchReplay: TurnRecoveryReplayDispatcher;
  /** Fresh supervisor identity for a claim/reassignment; must vary per call (epoch fencing). */
  readonly freshOwnerIdentity: () => TurnRecoveryOwnerIdentity;
  readonly leaseSeconds?: number;
  readonly backoffSeconds?: number;
  readonly scanIntervalMs?: number;
}

function emptyScanResult(): TurnRecoveryScanResult {
  return {
    scanned: 0, claimed: 0, completed: 0, requeued: 0,
    exhausted: 0, reassigned: 0, skippedBlockedUnsafe: 0,
    skippedOriginalDeliveryPending: 0, processingErrors: 0,
  };
}

function mergeScanResult(
  into: {
    scanned: number; claimed: number; completed: number; requeued: number;
    exhausted: number; reassigned: number; skippedBlockedUnsafe: number;
    skippedOriginalDeliveryPending: number; processingErrors: number;
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
  private lastScanAt: number | null = null;

  constructor(deps: TurnRecoverySupervisorDeps) {
    this.instanceName = deps.instanceName;
    this.durability = deps.durability;
    this.dispatchReplay = deps.dispatchReplay;
    this.freshOwnerIdentity = deps.freshOwnerIdentity;
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
      scans: this.scans,
      claims: this.claims,
      completions: this.completions,
      requeues: this.requeues,
      exhaustions: this.exhaustions,
      reassignments: this.reassignments,
      dispatchFailures: this.dispatchFailures,
      processingErrors: this.processingErrors,
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
    if (!durability || this.closed) return emptyScanResult();

    // Sweep expired claims back to pending/exhausted first so this cycle's
    // enumeration can see freshly-reclaimable rows (store-owned transition).
    try {
      durability.recoverStaleTurnRecoveryJobs(RECLAIM_STALE_LIMIT);
    } catch (err) {
      log.warn({ err }, 'turn recovery supervisor stale-claim sweep failed');
    }

    const page = durability.getOutstandingTurnRecoveryJobsForSupervisor({
      limit: SCAN_PAGE_SIZE,
      afterId: this.cursor,
    });
    this.cursor = page.scanComplete ? 0 : (page.nextCursor ?? 0);

    const totals = {
      scanned: page.jobs.length, claimed: 0, completed: 0, requeued: 0,
      exhausted: 0, reassigned: 0, skippedBlockedUnsafe: 0,
      skippedOriginalDeliveryPending: 0, processingErrors: 0,
    };

    for (const job of page.jobs) {
      // eslint-disable-next-line no-await-in-loop -- bounded batch, intentionally sequential per PRESTAGE-T4 fair-scheduling requirement; expires 2026-12-31
      const delta = await this.processJob(durability, job);
      mergeScanResult(totals, delta);
    }

    return totals;
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
      return this.claimAndReplay(durability, job, newOwner, { reassigned: 1 });
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
      return this.claimAndReplay(durability, job, owner, {});
    }

    return {};
  }

  private async claimAndReplay(
    durability: TurnRecoverySupervisorDurability,
    job: TurnRecoveryJobRow,
    owner: TurnRecoveryOwnerIdentity,
    baseDelta: Partial<TurnRecoveryScanResult>,
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
    // `getOutstandingTurnRecoveryJobsForSupervisor` deliberately hides live
    // (non-expired) claims, so the just-claimed row can no longer be
    // re-fetched through it — thread the pre-claim row through instead; its
    // replay-relevant fields (sender/text/scope/conversation) are immutable.
    let outcome: TurnRecoveryReplayDispatchResult;
    try {
      outcome = await this.dispatchReplay(job, fence);
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
}

function isoNow(): string {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

export interface TurnRecoverySupervisorHeartbeatVerdict {
  readonly healthy: boolean;
  readonly reason: 'ok' | 'never_scanned' | 'stale_scan';
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
 * Wiring this to an actual `emitAlertChecked`/typed-clear call site is
 * separate follow-up (main.ts/health.ts), not done here.
 */
export function evaluateTurnRecoverySupervisorHeartbeat(
  health: TurnRecoverySupervisorHealth,
  opts: { nowMs: number; staleAfterMs: number },
): TurnRecoverySupervisorHeartbeatVerdict {
  if (health.lastScanAt === null) {
    return { healthy: false, reason: 'never_scanned' };
  }
  const age = opts.nowMs - health.lastScanAt;
  if (age > opts.staleAfterMs) {
    return { healthy: false, reason: 'stale_scan' };
  }
  return { healthy: true, reason: 'ok' };
}
