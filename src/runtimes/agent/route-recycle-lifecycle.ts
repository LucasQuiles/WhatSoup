/**
 * Exact ownership and shutdown bookkeeping for live route recycles.
 *
 * The runtime owns one instance and exposes its raw collections only for
 * compatibility with the existing characterization surface. Lifecycle
 * mutations stay here so promise identity, compare-and-swap cleanup, and the
 * shared shutdown deadline cannot drift across call sites.
 */

export interface RouteRecycleFailure<TSession> {
  readonly session: TSession;
  readonly error: unknown;
}

interface RouteRecycleLifecycleCollections<TSession> {
  pending?: Set<string>;
  promises?: Map<string, Promise<void>>;
  owners?: Map<string, TSession>;
  failures?: Map<string, RouteRecycleFailure<TSession>>;
  commandWork?: Set<Promise<void>>;
  publicationWork?: Map<Promise<void>, string>;
}

export class RouteRecycleLifecycle<TSession> {
  readonly pending: Set<string>;
  readonly promises: Map<string, Promise<void>>;
  readonly owners: Map<string, TSession>;
  readonly failures: Map<string, RouteRecycleFailure<TSession>>;
  readonly commandWork: Set<Promise<void>>;
  readonly publicationWork: Map<Promise<void>, string>;

  constructor(collections: RouteRecycleLifecycleCollections<TSession> = {}) {
    this.pending = collections.pending ?? new Set();
    this.promises = collections.promises ?? new Map();
    this.owners = collections.owners ?? new Map();
    this.failures = collections.failures ?? new Map();
    this.commandWork = collections.commandWork ?? new Set();
    this.publicationWork = collections.publicationWork ?? new Map();
  }

  isPendingOrRunning(scopeKey: string): boolean {
    return this.pending.has(scopeKey) || this.promises.has(scopeKey);
  }

  rekeyScope(from: string, to: string): void {
    if (this.pending.delete(from)) this.pending.add(to);
    for (const [work, scopeKey] of this.publicationWork) {
      if (scopeKey === from) this.publicationWork.set(work, to);
    }
  }

  trackRouteCommand(work: Promise<void>, scopeKey: string): void {
    this.commandWork.add(work);
    this.publicationWork.set(work, scopeKey);
  }

  untrackRouteCommand(work: Promise<void>): void {
    this.commandWork.delete(work);
    this.publicationWork.delete(work);
  }

  trackPublication(work: Promise<void>, scopeKey: string): void {
    this.publicationWork.set(work, scopeKey);
    void work.finally(() => {
      this.publicationWork.delete(work);
    }).catch(() => {});
  }

  runOwned(
    scopeKey: string,
    session: TSession,
    operation: () => Promise<void>,
    shouldRecordFailure: (error: unknown) => boolean,
  ): Promise<void> {
    const existing = this.promises.get(scopeKey);
    if (existing) return existing;
    this.failures.delete(scopeKey);
    this.owners.set(scopeKey, session);
    const lifecycle = operation()
      .then(() => {
        this.failures.delete(scopeKey);
      })
      .catch((error: unknown) => {
        if (shouldRecordFailure(error)) {
          this.failures.set(scopeKey, { session, error });
        }
        throw error;
      })
      .finally(() => {
        if (this.promises.get(scopeKey) === lifecycle) {
          this.promises.delete(scopeKey);
        }
        if (this.owners.get(scopeKey) === session) {
          this.owners.delete(scopeKey);
        }
      });
    this.promises.set(scopeKey, lifecycle);
    return lifecycle;
  }

  async awaitForShutdown(deadlineAt: number): Promise<void> {
    while (true) {
      const publicationWork = [...this.publicationWork.keys()];
      const lifecycles = [...this.promises.values()];
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled([...publicationWork, ...lifecycles]),
          new Promise<never>((_, reject) => {
            deadlineTimer = setTimeout(
              () => reject(new Error('Route recycle shutdown join deadline expired')),
              Math.max(0, deadlineAt - Date.now()),
            );
            deadlineTimer.unref?.();
          }),
        ]);
      } finally {
        clearTimeout(deadlineTimer);
      }
      // Accepted queued work can publish its recycle after the first snapshot.
      await Promise.resolve();
      if (this.publicationWork.size === 0 && this.promises.size === 0) return;
    }
  }

  retainedOwners(resolveSession: (scopeKey: string) => TSession | undefined): Set<TSession> {
    const retained = new Set(this.owners.values());
    for (const scopeKey of this.publicationWork.values()) {
      const session = resolveSession(scopeKey);
      if (session !== undefined) retained.add(session);
    }
    return retained;
  }

  takeFailures(): RouteRecycleFailure<TSession>[] {
    const failures = [...this.failures.values()];
    this.failures.clear();
    return failures;
  }
}
