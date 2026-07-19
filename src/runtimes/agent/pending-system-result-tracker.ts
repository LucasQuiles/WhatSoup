/** Runtime policy carried by an in-flight non-user provider request. */
export type SystemTurnPurpose =
  | 'auto_compact_silent'
  | 'proactive_resume_context'
  | 'proactive_resume_continuation'
  | 'fresh_session_context'
  | 'poll_answer_continuation'
  | 'manual_compact_silent'
  | 'manual_compact_notice'
  | 'respawn_context'
  | 'respawn_continuation'
  | 'resume_failure_context';

export interface PendingSystemTurnOwner {
  readonly managerId: string;
  readonly generation: number;
  readonly toolScopeKey: string;
}

export interface SystemTurnLeaseToken {
  readonly id: number;
  readonly scopeKey: string;
}

export interface PendingSystemTurnSnapshot {
  readonly lease: SystemTurnLeaseToken;
  readonly purpose: SystemTurnPurpose;
  readonly owner: PendingSystemTurnOwner | null;
  readonly routeChatJid?: string;
  readonly blocking: boolean;
}

export interface MarkSystemTurnInput {
  readonly scopeKey: string;
  readonly purpose: SystemTurnPurpose;
  readonly owner: PendingSystemTurnOwner;
  readonly routeChatJid?: string;
  /** Absolute wall deadline measured from mark(), independent of later activity. */
  readonly timeoutMs?: number;
  /**
   * Deadline verdict: true only after the timed-out provider request has been
   * torn down (cancels the exact lease); 'retry' re-arms the same deadline slot
   * for one more window without teardown; false retains the lease fail-closed.
   */
  readonly onTimeout?: (lease: SystemTurnLeaseToken) => Promise<boolean | 'retry'>;
}

interface MutableSystemTurnLease {
  readonly lease: SystemTurnLeaseToken;
  readonly purpose: SystemTurnPurpose;
  readonly owner: PendingSystemTurnOwner | null;
  readonly routeChatJid?: string;
  blocking: boolean;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
}

interface Waiter {
  readonly ownLeaseId: number | null;
  readonly maxPending: number | null;
  readonly requireEmpty: boolean;
  readonly resolve: () => void;
}

/**
 * Per-scope FIFO of provider results belonging to explicit system requests.
 * Every live lease remains both dispatch-blocking and result-classifying. A
 * deadline cancels its exact lease only after provider teardown is proven.
 */
export class PendingSystemResultTracker {
  /** Compatibility/read-only count view. Event admission never trusts it. */
  readonly counts = new Map<string, number>();
  private readonly leases = new Map<string, MutableSystemTurnLease[]>();
  /** Current scope for each exact token; survives a LID-to-canonical rekey. */
  private readonly leaseScopes = new Map<number, string>();
  private readonly waiters = new Map<string, Set<Waiter>>();
  private nextLeaseId = 1;

  mark(input: MarkSystemTurnInput): SystemTurnLeaseToken;
  /** Compatibility overload for characterization tests; it carries no owner. */
  mark(scopeKey: string | undefined, purpose?: SystemTurnPurpose): SystemTurnLeaseToken | null;
  mark(
    inputOrScopeKey: MarkSystemTurnInput | string | undefined,
    compatibilityPurpose: SystemTurnPurpose = 'fresh_session_context',
  ): SystemTurnLeaseToken | null {
    if (inputOrScopeKey === undefined) return null;
    const input: MarkSystemTurnInput | null = typeof inputOrScopeKey === 'string'
      ? null
      : inputOrScopeKey;
    const scopeKey = typeof inputOrScopeKey === 'string'
      ? inputOrScopeKey
      : inputOrScopeKey.scopeKey;
    const lease = Object.freeze({ id: this.nextLeaseId++, scopeKey });
    const queue = this.leases.get(scopeKey) ?? [];
    const entry: MutableSystemTurnLease = {
      lease,
      purpose: input?.purpose ?? compatibilityPurpose,
      owner: input?.owner ? Object.freeze({ ...input.owner }) : null,
      ...(input?.routeChatJid !== undefined ? { routeChatJid: input.routeChatJid } : {}),
      blocking: true,
      deadlineTimer: null,
    };
    queue.push(entry);
    this.leases.set(scopeKey, queue);
    this.leaseScopes.set(lease.id, scopeKey);
    this.counts.set(scopeKey, queue.length);
    if (input?.timeoutMs !== undefined && input.onTimeout !== undefined) {
      this.armDeadline(entry, input.timeoutMs, input.onTimeout);
    }
    return lease;
  }

  count(scopeKey: string): number {
    return this.counts.get(scopeKey) ?? 0;
  }

  blockingCount(scopeKey: string): number {
    return this.leases.get(scopeKey)?.filter((lease) => lease.blocking).length ?? 0;
  }

  peek(scopeKey: string): PendingSystemTurnSnapshot | null {
    const current = this.leases.get(scopeKey)?.[0];
    return current ? this.snapshot(current) : null;
  }

  /** Compatibility projection. New admission uses peek() and verifies owner. */
  peekPurpose(scopeKey: string): SystemTurnPurpose | null {
    return this.peek(scopeKey)?.purpose ?? null;
  }

  /** Consume only when the supplied exact lease is still the FIFO head. */
  consumeResult(lease: SystemTurnLeaseToken): PendingSystemTurnSnapshot | null {
    const scopeKey = this.leaseScopes.get(lease.id) ?? lease.scopeKey;
    const queue = this.leases.get(scopeKey);
    const current = queue?.[0];
    if (!current || current.lease.id !== lease.id) return null;
    this.clearDeadline(current);
    queue!.shift();
    this.leaseScopes.delete(lease.id);
    this.updateScopeAfterMutation(scopeKey, queue!);
    return this.snapshot(current);
  }

  /** Compatibility consumer used by older result-handler tests. */
  consumePurposeIfPending(scopeKey: string): SystemTurnPurpose | null {
    const current = this.peek(scopeKey);
    if (!current) return null;
    return this.consumeResult(current.lease)?.purpose ?? null;
  }

  /** Compatibility boolean wrapper; direct counter mutation grants no typed owner. */
  consumeIfPending(scopeKey: string): boolean {
    const current = this.peek(scopeKey);
    if (current) return this.consumeResult(current.lease) !== null;
    const compatibilityCount = this.counts.get(scopeKey) ?? 0;
    if (compatibilityCount === 0) return false;
    this.counts.set(scopeKey, compatibilityCount - 1);
    this.settleEligibleWaiters(scopeKey);
    return true;
  }

  /** Remove one exact request whether it is blocking or timeout-released. */
  cancel(lease: SystemTurnLeaseToken | null | undefined): boolean {
    if (!lease) return false;
    const scopeKey = this.leaseScopes.get(lease.id) ?? lease.scopeKey;
    const queue = this.leases.get(scopeKey);
    const index = queue?.findIndex((candidate) => candidate.lease.id === lease.id) ?? -1;
    if (index < 0) return false;
    this.clearDeadline(queue![index]!);
    queue!.splice(index, 1);
    this.leaseScopes.delete(lease.id);
    this.updateScopeAfterMutation(scopeKey, queue!);
    return true;
  }

  /**
   * A user dispatch waits for every blocking lease. A system sender carrying its
   * own lease waits only for blocking entries ahead of that exact lease.
   */
  waitUntilDispatchable(
    scopeKey: string,
    ownLease?: SystemTurnLeaseToken,
  ): Promise<void> {
    if (this.isDispatchable(scopeKey, ownLease?.id ?? null)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const scopeWaiters = this.waiters.get(scopeKey) ?? new Set<Waiter>();
      scopeWaiters.add({
        ownLeaseId: ownLease?.id ?? null,
        maxPending: null,
        requireEmpty: false,
        resolve,
      });
      this.waiters.set(scopeKey, scopeWaiters);
    });
  }

  /** Compatibility wait used by existing collaborators. */
  waitForDrain(scopeKey: string): Promise<void> {
    return this.waitUntilDispatchable(scopeKey);
  }

  /** Wait until no classification lease remains, including nonblocking leases. */
  waitUntilEmpty(scopeKey: string): Promise<void> {
    if (this.count(scopeKey) === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const scopeWaiters = this.waiters.get(scopeKey) ?? new Set<Waiter>();
      scopeWaiters.add({
        ownLeaseId: null,
        maxPending: null,
        requireEmpty: true,
        resolve,
      });
      this.waiters.set(scopeKey, scopeWaiters);
    });
  }

  /** Compatibility count threshold used only while callers migrate to leases. */
  waitForCountAtMost(scopeKey: string, maxPending: number): Promise<void> {
    if (this.blockingCount(scopeKey) <= maxPending) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const scopeWaiters = this.waiters.get(scopeKey) ?? new Set<Waiter>();
      scopeWaiters.add({ ownLeaseId: null, maxPending, requireEmpty: false, resolve });
      this.waiters.set(scopeKey, scopeWaiters);
    });
  }

  clearScope(scopeKey: string): void {
    for (const entry of this.leases.get(scopeKey) ?? []) {
      this.clearDeadline(entry);
      this.leaseScopes.delete(entry.lease.id);
    }
    this.leases.delete(scopeKey);
    this.counts.delete(scopeKey);
    const scopeWaiters = this.waiters.get(scopeKey);
    this.waiters.delete(scopeKey);
    for (const waiter of scopeWaiters ?? []) waiter.resolve();
  }

  clear(): void {
    for (const scopeKey of new Set([
      ...this.leases.keys(),
      ...this.counts.keys(),
      ...this.waiters.keys(),
    ])) {
      this.clearScope(scopeKey);
    }
  }

  /**
   * Atomically move one serialized provider lane to its canonical scope while
   * retaining exact token identity for senders that still hold pre-rekey leases.
   */
  rekeyScope(fromScopeKey: string, toScopeKey: string): void {
    if (fromScopeKey === toScopeKey) return;
    const source = this.leases.get(fromScopeKey);
    const sourceWaiters = this.waiters.get(fromScopeKey);
    const hasSourceState = source !== undefined
      || this.counts.has(fromScopeKey)
      || sourceWaiters !== undefined;
    if (!hasSourceState) return;
    if (
      this.leases.has(toScopeKey)
      || this.counts.has(toScopeKey)
      || this.waiters.has(toScopeKey)
    ) {
      throw new Error(`Cannot rekey system turns onto occupied scope "${toScopeKey}"`);
    }
    this.leases.delete(fromScopeKey);
    this.counts.delete(fromScopeKey);
    this.waiters.delete(fromScopeKey);
    if (source !== undefined) {
      this.leases.set(toScopeKey, source);
      this.counts.set(toScopeKey, source.length);
      for (const entry of source) this.leaseScopes.set(entry.lease.id, toScopeKey);
    }
    if (sourceWaiters !== undefined) this.waiters.set(toScopeKey, sourceWaiters);
    this.settleEligibleWaiters(toScopeKey);
  }

  private isDispatchable(scopeKey: string, ownLeaseId: number | null): boolean {
    const queue = this.leases.get(scopeKey) ?? [];
    if (ownLeaseId === null) return queue.every((lease) => !lease.blocking);
    const ownIndex = queue.findIndex((lease) => lease.lease.id === ownLeaseId);
    if (ownIndex < 0) return queue.every((lease) => !lease.blocking);
    return queue.slice(0, ownIndex).every((lease) => !lease.blocking);
  }

  private settleEligibleWaiters(scopeKey: string): void {
    const scopeWaiters = this.waiters.get(scopeKey);
    if (!scopeWaiters) return;
    for (const waiter of [...scopeWaiters]) {
      const eligible = waiter.requireEmpty
        ? this.count(scopeKey) === 0
        : waiter.maxPending === null
          ? this.isDispatchable(scopeKey, waiter.ownLeaseId)
          : this.blockingCount(scopeKey) <= waiter.maxPending;
      if (!eligible) continue;
      scopeWaiters.delete(waiter);
      waiter.resolve();
    }
    if (scopeWaiters.size === 0) this.waiters.delete(scopeKey);
  }

  private updateScopeAfterMutation(
    scopeKey: string,
    queue: MutableSystemTurnLease[],
  ): void {
    if (queue.length === 0) {
      this.leases.delete(scopeKey);
      this.counts.set(scopeKey, 0);
    } else {
      this.counts.set(scopeKey, queue.length);
    }
    this.settleEligibleWaiters(scopeKey);
  }

  private armDeadline(
    entry: MutableSystemTurnLease,
    timeoutMs: number,
    onTimeout: (lease: SystemTurnLeaseToken) => Promise<boolean | 'retry'>,
  ): void {
    const timer = setTimeout(() => {
      entry.deadlineTimer = null;
      void this.handleDeadline(entry, timeoutMs, onTimeout);
    }, timeoutMs);
    timer.unref?.();
    entry.deadlineTimer = timer;
  }

  private async handleDeadline(
    entry: MutableSystemTurnLease,
    timeoutMs: number,
    onTimeout: (lease: SystemTurnLeaseToken) => Promise<boolean | 'retry'>,
  ): Promise<void> {
    if (!this.isLive(entry)) return;
    try {
      const verdict = await onTimeout(entry.lease);
      if (verdict === 'retry') {
        // Single-slot re-arm: the fired timer already nulled deadlineTimer, so
        // this never stacks. A lease consumed or cancelled during the verdict
        // await stays dead — consumption/cancellation cleared its timer slot.
        if (this.isLive(entry) && entry.deadlineTimer === null) {
          this.armDeadline(entry, timeoutMs, onTimeout);
        }
        return;
      }
      if (verdict) this.cancel(entry.lease);
    } catch {
      // Fail closed: an unproven teardown retains both classification and blocking.
    }
  }

  private isLive(entry: MutableSystemTurnLease): boolean {
    const scopeKey = this.leaseScopes.get(entry.lease.id);
    return scopeKey !== undefined && this.leases.get(scopeKey)?.includes(entry) === true;
  }

  private clearDeadline(entry: MutableSystemTurnLease): void {
    if (entry.deadlineTimer === null) return;
    clearTimeout(entry.deadlineTimer);
    entry.deadlineTimer = null;
  }

  private snapshot(lease: MutableSystemTurnLease): PendingSystemTurnSnapshot {
    return Object.freeze({
      lease: lease.lease,
      purpose: lease.purpose,
      owner: lease.owner ? Object.freeze({ ...lease.owner }) : null,
      ...(lease.routeChatJid !== undefined ? { routeChatJid: lease.routeChatJid } : {}),
      blocking: lease.blocking,
    });
  }
}
