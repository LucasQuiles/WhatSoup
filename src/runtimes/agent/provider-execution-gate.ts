import { clearAlertSourceChecked, emitAlertChecked } from '../../lib/emit-alert.ts';
import {
  clearRecoveryMarker,
  loadRecoveryMarkers,
  setRecoveryMarker,
} from '../../lib/recovery-authority-store.ts';
import { createChildLogger } from '../../logger.ts';

const log = createChildLogger('provider-execution-gate');

const ALERT_SOURCE = 'provider_execution_queue_pressure';

export interface ProviderExecutionGateSnapshot {
  readonly active: boolean;
  readonly activeWorkKind: ProviderExecutionWorkKind | null;
  readonly activeScopeHash: string | null;
  /** #2340: content-free holder freshness — age of the active hold (0 when idle). */
  readonly activeAgeMs: number;
  /** #2340: coarse lifecycle phase of the active hold ('executing' when idle — the documented idle sentinel). */
  readonly activePhase: ProviderExecutionPhase;
  /** #2340: ms since the holder last reported progress (0 when idle). */
  readonly progressAgeMs: number;
  readonly pending: number;
  readonly oldestPendingWorkKind: ProviderExecutionWorkKind | null;
  readonly oldestPendingScopeHash: string | null;
  readonly oldestWaitMs: number;
  readonly totalWaits: number;
  readonly maxPending: number;
  readonly lastWaitMs: number;
  readonly abortedWaits: number;
  readonly pressureActive: boolean;
}

export type ProviderExecutionWorkKind = 'turn' | 'probe';

/**
 * #2340: coarse content-free lifecycle phase of the active hold. Starts at
 * 'queued_to_spawn' on admit; the holder advances it via lease.setPhase().
 */
export type ProviderExecutionPhase = 'queued_to_spawn' | 'executing' | 'terminalizing' | 'cleanup';

export interface ProviderExecutionWorkIdentity {
  readonly kind: ProviderExecutionWorkKind;
  readonly scopeHash: string;
}

export interface ProviderExecutionLease {
  readonly waitMs: number;
  /**
   * #2340: report holder progress (resets progressAgeMs). No-op once this
   * lease's generation has been superseded (released or handed off).
   */
  markProgress(): void;
  /**
   * #2340: advance the holder's lifecycle phase. No-op once this lease's
   * generation has been superseded.
   */
  setPhase(phase: ProviderExecutionPhase): void;
  release(): void;
}

interface GateWaiter {
  readonly enqueuedAt: number;
  readonly work: ProviderExecutionWorkIdentity | null;
  readonly resolve: (lease: ProviderExecutionLease) => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  abortListener?: () => void;
}

export interface ProviderExecutionGateOptions {
  readonly now?: () => number;
  readonly pressureAfterMs?: number;
  readonly onPressure?: (snapshot: ProviderExecutionGateSnapshot) => void;
  readonly onRecovered?: (snapshot: ProviderExecutionGateSnapshot) => void;
}

export class ProviderExecutionGate {
  private readonly now: () => number;
  private readonly pressureAfterMs: number;
  private readonly onPressure?: (snapshot: ProviderExecutionGateSnapshot) => void;
  private readonly onRecovered?: (snapshot: ProviderExecutionGateSnapshot) => void;
  private readonly waiters: GateWaiter[] = [];
  private active = false;
  private activeWork: ProviderExecutionWorkIdentity | null = null;
  // #2340: holder freshness state. Generation guards stale lease writes;
  // 'executing' is both the construction default and the idle sentinel.
  private activeGeneration = 0;
  private activeStartedAt = 0;
  private activePhase: ProviderExecutionPhase = 'executing';
  private lastProgressAt = 0;
  private totalWaits = 0;
  private maxPending = 0;
  private lastWaitMs = 0;
  private abortedWaits = 0;
  private pressureActive = false;
  private pressureTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: ProviderExecutionGateOptions = {}) {
    // Late-bind the default clock: capturing `Date.now` by reference here freezes
    // the real-timer function at construction, so vitest fake timers (which swap
    // globalThis.Date afterward) never reach it — the gate's clock stays real
    // while its pressure setTimeout is faked, flaking any fake-timer test that
    // relies on the pressure threshold. An arrow re-reads Date.now at call time;
    // behavior is identical under real timers, so production is unchanged.
    this.now = options.now ?? (() => Date.now());
    this.pressureAfterMs = Math.max(0, options.pressureAfterMs ?? 30_000);
    this.onPressure = options.onPressure;
    this.onRecovered = options.onRecovered;
  }

  acquire(options: { signal?: AbortSignal; work?: ProviderExecutionWorkIdentity } = {}): Promise<ProviderExecutionLease> {
    if (options.signal?.aborted) {
      this.abortedWaits += 1;
      return Promise.reject(new Error('PROVIDER_EXECUTION_WAIT_ABORTED'));
    }
    if (!this.active && this.waiters.length === 0) {
      this.active = true;
      this.activeWork = normalizeWorkIdentity(options.work);
      this.beginHold();
      return Promise.resolve(this.createLease(0));
    }

    this.totalWaits += 1;
    return new Promise<ProviderExecutionLease>((resolve, reject) => {
      const waiter: GateWaiter = {
        enqueuedAt: this.now(),
        work: normalizeWorkIdentity(options.work),
        resolve,
        reject,
        ...(options.signal ? { signal: options.signal } : {}),
      };
      if (options.signal) {
        waiter.abortListener = () => this.abortWaiter(waiter);
        options.signal.addEventListener('abort', waiter.abortListener, { once: true });
      }
      this.waiters.push(waiter);
      this.maxPending = Math.max(this.maxPending, this.waiters.length);
      this.armPressureTimer();
    });
  }

  snapshot(): ProviderExecutionGateSnapshot {
    const oldest = this.waiters[0];
    const now = this.now();
    return {
      active: this.active,
      activeWorkKind: this.activeWork?.kind ?? null,
      activeScopeHash: this.activeWork?.scopeHash ?? null,
      activeAgeMs: this.active ? Math.max(0, now - this.activeStartedAt) : 0,
      activePhase: this.active ? this.activePhase : 'executing',
      progressAgeMs: this.active ? Math.max(0, now - this.lastProgressAt) : 0,
      pending: this.waiters.length,
      oldestPendingWorkKind: oldest?.work?.kind ?? null,
      oldestPendingScopeHash: oldest?.work?.scopeHash ?? null,
      oldestWaitMs: oldest ? Math.max(0, now - oldest.enqueuedAt) : 0,
      totalWaits: this.totalWaits,
      maxPending: this.maxPending,
      lastWaitMs: this.lastWaitMs,
      abortedWaits: this.abortedWaits,
      pressureActive: this.pressureActive,
    };
  }

  /**
   * #2340: atomically reset holder freshness for a newly admitted hold —
   * bumping the generation first invalidates any prior lease's phase/progress
   * writes before the new epoch starts.
   */
  private beginHold(): void {
    this.activeGeneration += 1;
    this.activeStartedAt = this.now();
    this.lastProgressAt = this.activeStartedAt;
    this.activePhase = 'queued_to_spawn';
  }

  private createLease(waitMs: number): ProviderExecutionLease {
    let released = false;
    const generation = this.activeGeneration;
    const isCurrent = (): boolean =>
      !released && generation === this.activeGeneration && this.active;
    return {
      waitMs,
      markProgress: () => {
        if (!isCurrent()) return;
        this.lastProgressAt = this.now();
      },
      setPhase: (phase: ProviderExecutionPhase) => {
        if (!isCurrent()) return;
        this.activePhase = phase;
      },
      release: () => {
        if (released) return;
        released = true;
        this.releaseActive();
      },
    };
  }

  private releaseActive(): void {
    if (!this.active) return;
    this.active = false;
    this.activeWork = null;
    this.activeStartedAt = 0;
    this.lastProgressAt = 0;
    this.activePhase = 'executing';
    this.grantNext();
    if (!this.active && this.waiters.length === 0) this.finishPressureEpisode();
  }

  private grantNext(): void {
    while (!this.active && this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      this.removeAbortListener(waiter);
      if (waiter.signal?.aborted) {
        this.abortedWaits += 1;
        waiter.reject(new Error('PROVIDER_EXECUTION_WAIT_ABORTED'));
        continue;
      }
      this.active = true;
      this.activeWork = waiter.work;
      this.lastWaitMs = Math.max(0, this.now() - waiter.enqueuedAt);
      this.beginHold();
      waiter.resolve(this.createLease(this.lastWaitMs));
    }
    this.armPressureTimer();
  }

  private abortWaiter(waiter: GateWaiter): void {
    const index = this.waiters.indexOf(waiter);
    if (index < 0) return;
    this.waiters.splice(index, 1);
    this.removeAbortListener(waiter);
    this.abortedWaits += 1;
    waiter.reject(new Error('PROVIDER_EXECUTION_WAIT_ABORTED'));
    this.armPressureTimer();
    if (!this.active && this.waiters.length === 0) this.finishPressureEpisode();
  }

  private removeAbortListener(waiter: GateWaiter): void {
    if (waiter.signal && waiter.abortListener) {
      waiter.signal.removeEventListener('abort', waiter.abortListener);
    }
  }

  private armPressureTimer(): void {
    if (this.pressureTimer !== null) clearTimeout(this.pressureTimer);
    this.pressureTimer = null;
    if (this.pressureActive || this.waiters.length === 0) return;
    const remaining = Math.max(0, this.pressureAfterMs - this.snapshot().oldestWaitMs);
    this.pressureTimer = setTimeout(() => {
      this.pressureTimer = null;
      if (this.waiters.length === 0 || this.pressureActive) return;
      this.pressureActive = true;
      this.onPressure?.(this.snapshot());
    }, remaining);
    this.pressureTimer.unref?.();
  }

  private finishPressureEpisode(): void {
    if (this.pressureTimer !== null) clearTimeout(this.pressureTimer);
    this.pressureTimer = null;
    this.pressureActive = false;
    this.onRecovered?.(this.snapshot());
    // Remove-the-gate: onRecovered -> clearAlertSourceChecked is idempotent
    // (#2394) — a prior-process pressure incident must still be cleared.
  }
}

export function createProviderExecutionGate(instanceName: string): ProviderExecutionGate {
  const markerKey = `${ALERT_SOURCE}:${instanceName}`;
  const gate = new ProviderExecutionGate({
    pressureAfterMs: 30_000,
    onPressure: (snapshot) => {
      const emitted = emitAlertChecked(
        instanceName,
        ALERT_SOURCE,
        'OpenCode execution queue has waited at least 30 seconds',
        [
          'provider=opencode-cli',
          'scope=whatsoup_process',
          `active=${snapshot.active}`,
          `active_work_kind=${snapshot.activeWorkKind ?? 'unknown'}`,
          `active_scope_hash=${snapshot.activeScopeHash ?? 'unknown'}`,
          `active_age_ms=${snapshot.activeAgeMs}`,
          `active_phase=${snapshot.activePhase}`,
          `progress_age_ms=${snapshot.progressAgeMs}`,
          `pending=${snapshot.pending}`,
          `oldest_pending_work_kind=${snapshot.oldestPendingWorkKind ?? 'unknown'}`,
          `oldest_pending_scope_hash=${snapshot.oldestPendingScopeHash ?? 'unknown'}`,
          `oldest_wait_ms=${snapshot.oldestWaitMs}`,
          `total_waits=${snapshot.totalWaits}`,
          `max_pending=${snapshot.maxPending}`,
          `aborted_waits=${snapshot.abortedWaits}`,
          'recovery=automatic_when_execution_lane_idle',
          'limitation=external_opencode_processes_are_not_serialized',
        ].join('\n'),
        'warning',
      );
      if (emitted) {
        try {
          setRecoveryMarker(markerKey);
        } catch {
          // intentional: marker write is best-effort — the alert itself was
          // already durably queued above; a missing marker only means the next
          // cold-start reconcile cannot clear this source without a drain.
        }
      }
    },
    onRecovered: (snapshot) => {
      log.info({
        instance: instanceName,
        provider: 'opencode-cli',
        totalWaits: snapshot.totalWaits,
        maxPending: snapshot.maxPending,
        lastWaitMs: snapshot.lastWaitMs,
        abortedWaits: snapshot.abortedWaits,
      }, 'OpenCode execution queue pressure recovered');
      if (clearAlertSourceChecked(instanceName, ALERT_SOURCE)) {
        try {
          clearRecoveryMarker(markerKey);
        } catch {
          // intentional: marker removal is best-effort — a stale marker only
          // causes a redundant idempotent clear on the next cold-start
          // reconcile.
        }
      }
    },
  });
  // #2394 (source 4): a just-constructed gate is verifiably idle (no holder,
  // no waiters), which the issue contract treats as recovery authority for a
  // prior-process pressure incident. Reconcile any marker left by process A —
  // without this, a restart into an idle lane that never receives another
  // turn would leave the durable incident open forever. Positive-proof rule:
  // clear only on a present marker, and keep the marker when the clear is not
  // durably accepted so the next startup retries the idempotent clear.
  try {
    if (loadRecoveryMarkers().has(markerKey)
      && clearAlertSourceChecked(instanceName, ALERT_SOURCE, 'startup idle-gate reconcile (#2394 source 4)')) {
      clearRecoveryMarker(markerKey);
    }
  } catch {
    // intentional: marker file unreadable — skip reconcile; the first
    // same-process drain still clears via onRecovered above.
  }
  return gate;
}

function normalizeWorkIdentity(
  work: ProviderExecutionWorkIdentity | undefined,
): ProviderExecutionWorkIdentity | null {
  if (!work || !/^[0-9a-f]{12}$/.test(work.scopeHash)) return null;
  return { kind: work.kind, scopeHash: work.scopeHash };
}
