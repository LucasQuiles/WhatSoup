export interface ProviderExecutionGateSnapshot {
  readonly active: boolean;
  readonly pending: number;
  readonly oldestWaitMs: number;
  readonly totalWaits: number;
  readonly maxPending: number;
  readonly lastWaitMs: number;
  readonly abortedWaits: number;
  readonly pressureActive: boolean;
}

export interface ProviderExecutionLease {
  readonly waitMs: number;
  release(): void;
}

interface GateWaiter {
  readonly enqueuedAt: number;
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
  private totalWaits = 0;
  private maxPending = 0;
  private lastWaitMs = 0;
  private abortedWaits = 0;
  private pressureActive = false;
  private pressureTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: ProviderExecutionGateOptions = {}) {
    this.now = options.now ?? Date.now;
    this.pressureAfterMs = Math.max(0, options.pressureAfterMs ?? 30_000);
    this.onPressure = options.onPressure;
    this.onRecovered = options.onRecovered;
  }

  acquire(options: { signal?: AbortSignal } = {}): Promise<ProviderExecutionLease> {
    if (options.signal?.aborted) {
      this.abortedWaits += 1;
      return Promise.reject(new Error('PROVIDER_EXECUTION_WAIT_ABORTED'));
    }
    if (!this.active && this.waiters.length === 0) {
      this.active = true;
      return Promise.resolve(this.createLease(0));
    }

    this.totalWaits += 1;
    return new Promise<ProviderExecutionLease>((resolve, reject) => {
      const waiter: GateWaiter = {
        enqueuedAt: this.now(),
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
    return {
      active: this.active,
      pending: this.waiters.length,
      oldestWaitMs: oldest ? Math.max(0, this.now() - oldest.enqueuedAt) : 0,
      totalWaits: this.totalWaits,
      maxPending: this.maxPending,
      lastWaitMs: this.lastWaitMs,
      abortedWaits: this.abortedWaits,
      pressureActive: this.pressureActive,
    };
  }

  private createLease(waitMs: number): ProviderExecutionLease {
    let released = false;
    return {
      waitMs,
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
      this.lastWaitMs = Math.max(0, this.now() - waiter.enqueuedAt);
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
    if (!this.pressureActive) return;
    this.pressureActive = false;
    this.onRecovered?.(this.snapshot());
  }
}
