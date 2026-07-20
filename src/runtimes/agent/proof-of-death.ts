import { createChildLogger } from '../../logger.ts';

const log = createChildLogger('proof-of-death');

/**
 * A session whose process tree may still be alive after a refused teardown.
 * The only capability the registry needs is the ability to re-attempt a proving
 * shutdown; `shutdown(false)` resolves iff the tree is provably empty and
 * rejects (at the process-tree fail-closed guard) otherwise.
 */
export interface ProvableSession {
  shutdown(suspend: boolean): Promise<void>;
}

interface ProofOfDeathRecord {
  readonly session: ProvableSession;
  reason: string;
  /** Optional caller-side key (e.g. a per-chat mapKey) for the stall surface. */
  label: string | undefined;
  readonly since: number;
  attempts: number;
  lastAttemptAt: number | null;
  /** Every subsystem waiting on this one tree's death; all fire on proof. */
  readonly callbacks: Set<() => void>;
}

export interface StalledProofRow {
  readonly reason: string;
  readonly label: string | undefined;
  readonly ageMs: number;
  readonly attempts: number;
}

/**
 * One place that answers "is this SessionManager's process tree provably empty?"
 * and fans the answer out to every subsystem that was blocked on it.
 *
 * Before this existed, each subsystem that refused-then-needed-to-retry a
 * teardown ran its own timer racing to prove the same fact about the same
 * process (the per-chat bind quarantine, the system-turn dispatch quarantine,
 * the blocking system-result lease). That is an N² interaction surface with N
 * separate release-bookkeeping paths, and convergence depended on interleaving.
 * Centralizing gives one retry per session per tick and a single release
 * fan-out, so a proven-dead tree releases every blocked subsystem atomically.
 *
 * The safety invariant is unchanged and load-bearing: a record is retired ONLY
 * when a retried `shutdown(false)` resolves — i.e. the tree is proven empty.
 * It is never retired on a timer. A permanently-unprovable tree stays
 * registered and surfaces through {@link stalled} so an operator is paged.
 */
export class ProofOfDeathRegistry {
  private readonly records = new Map<ProvableSession, ProofOfDeathRecord>();

  /**
   * Register a proof-of-death subscriber. Idempotent per (session, callback):
   * a second registration for the same session adds another release callback
   * rather than resetting the retry state, so two subsystems blocked on one
   * tree share a single retry loop and both release together.
   */
  register(
    session: ProvableSession,
    reason: string,
    onProven: () => void,
    now: number,
    label?: string,
  ): void {
    const existing = this.records.get(session);
    if (existing) {
      existing.callbacks.add(onProven);
      if (existing.label === undefined && label !== undefined) existing.label = label;
      return;
    }
    this.records.set(session, {
      session,
      reason,
      label,
      since: now,
      attempts: 0,
      lastAttemptAt: null,
      callbacks: new Set([onProven]),
    });
  }

  has(session: ProvableSession): boolean {
    return this.records.has(session);
  }

  get size(): number {
    return this.records.size;
  }

  /**
   * Retry proof-of-death on every registered session. On proof (shutdown
   * resolves), retire the record and fire every release callback; on refusal,
   * hold and count the attempt. A callback that throws is logged and does not
   * block the other subscribers of the same tree.
   */
  async sweep(now: number): Promise<void> {
    for (const record of [...this.records.values()]) {
      record.attempts += 1;
      record.lastAttemptAt = now;
      try {
        await record.session.shutdown(false);
      } catch (err) {
        log.warn(
          { err, reason: record.reason, attempts: record.attempts },
          'proof-of-death still unprovable — holding closed',
        );
        continue;
      }
      // Proven empty. Retire first so a callback that re-registers (a fresh
      // wedge) is not immediately clobbered by this deletion.
      this.records.delete(record.session);
      for (const cb of record.callbacks) {
        try {
          cb();
        } catch (err) {
          log.error({ err, reason: record.reason }, 'proof-of-death release callback threw');
        }
      }
      log.info(
        { reason: record.reason, attempts: record.attempts, closedForMs: now - record.since },
        'proof-of-death confirmed — released blocked subsystems',
      );
    }
  }

  /**
   * Sessions whose tree has been unprovable for longer than the alert
   * threshold — the health surface pages an operator on these instead of the
   * user discovering a silent chat days later.
   */
  stalled(now: number, thresholdMs: number): StalledProofRow[] {
    const rows: StalledProofRow[] = [];
    for (const record of this.records.values()) {
      const ageMs = now - record.since;
      if (ageMs < thresholdMs) continue;
      rows.push({ reason: record.reason, label: record.label, ageMs, attempts: record.attempts });
    }
    return rows;
  }
}
