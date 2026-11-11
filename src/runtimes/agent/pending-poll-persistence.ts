/**
 * Verified SQLite durability for pending polls. Terminal effects require a confirmed
 * generation or durable terminal marker; failed writes remain owned by the bounded
 * retry scheduler. A readable table alone cannot clear an unresolved record.
 * Startup reads distinguish unavailable state from an empty table so queued answers
 * survive read and decoding failures. Health retains historical counts separately
 * from current durability debt.
 */
import type { Database } from '../../core/database.ts';
import { systemClock } from '../../lib/clock.ts';
import { createChildLogger } from '../../logger.ts';
import {
  deserializePendingPoll,
  normalizePendingPollTimeoutMs,
  serializePendingPoll,
  type PendingPollQuestion,
} from './poll-resolution.ts';
import { OfflineDecisionRetryScheduler, type OfflineDecisionRetryHealth } from './pending-poll-health.ts';

// Same component name as AgentRuntime: the persistence error lines keep their existing
// `component: 'agent-runtime'` log binding (no observable change).
const log = createChildLogger('agent-runtime');

/** A pending_polls row as read by rehydration. */
export interface PendingPollRow {
  map_key: string;
  chat_jid: string;
  payload: string;
  hard_closes_at: number | null;
  created_at: number;
  tool_id: string;
}

export type PollPersistenceWriteResult =
  | { status: 'confirmed'; durable: true }
  | { status: 'superseded'; durable: false }
  | { status: 'pending'; durable: boolean };

export type PollPersistenceReadResult =
  | { status: 'available'; rows: PendingPollRow[] }
  | { status: 'unavailable' };

/**
 * Structured poll-persistence health surface. Distinguishes a CURRENT active failure
 * (degraded=true, consecutiveFailures>0, not yet recovered) from a HISTORICAL recovery
 * (lastRecoveredAt / totalRecoveries). The bare cumulative `errors` counter cannot
 * express this distinction on its own — a process that failed 50 times an hour ago and
 * has been healthy since looks identical to one failing right now.
 */
export interface PollPersistenceHealth {
  /** Cumulative swallowed failures (back-compat with the pre-car health surface). */
  errors: number;
  /** True only while an active, unrecovered failure streak is in progress. */
  degraded: boolean;
  /** Current failure streak; resets only when every outstanding failure is resolved. */
  consecutiveFailures: number;
  /** Epoch-ms of the most recent failure, or null if none has occurred. */
  lastFailureAt: number | null;
  /** Fixed diagnostic or allowlisted SQLite code; never arbitrary error text. */
  lastFailureErr: string | null;
  /** Epoch-ms of the most recent recovery (a success that ended a failure streak), or null. */
  lastRecoveredAt: number | null;
  /** Lifetime count of failure→success recoveries (increments once per recovered streak). */
  totalRecoveries: number;
  retry?: OfflineDecisionRetryHealth;
}

/** SQLite errors can include SQL values, so expose only known codes. */
function sanitizeErrMessage(err: unknown): string {
  const code = err instanceof Error && 'code' in err ? err.code : undefined;
  return typeof code === 'string'
    && /^(SQLITE_(BUSY|LOCKED|FULL|READONLY|CORRUPT|NOTADB|IOERR|CANTOPEN|CONSTRAINT)|ERR_SQLITE_ERROR)$/.test(code)
    ? code : 'pending poll persistence failed';
}

export class PendingPollPersistence {
  /** Count of swallowed pending_polls persistence failures (save/remove/rehydrate). Surfaced in health. */
  errors = 0;
  // ── CAR-20 (#2539): current-vs-historical failure tracking ────────────────────
  consecutiveFailures = 0;
  lastFailureAt: number | null = null;
  lastFailureErr: string | null = null;
  lastRecoveredAt: number | null = null;
  totalRecoveries = 0;

  private readonly db: Database;
  private readonly unresolvedRecords = new Set<string>();
  private readFailed = false;
  private readonly retry = new OfflineDecisionRetryScheduler();
  private readonly pendingWrites = new Map<string, {
    generation: Pick<PendingPollQuestion, 'createdAt' | 'toolId'>;
    run: () => PollPersistenceWriteResult;
  }>();
  private readonly saveWaiters = new Map<string, {
    onDurable: () => void;
    finish: (result: PollPersistenceWriteResult) => void;
    createdAt: number;
    toolId: string;
  }>();
  private stopped = false;

  constructor(db: Database) {
    this.db = db;
  }

  stop(): void {
    this.stopped = true;
    this.retry.clear();
    for (const waiter of this.saveWaiters.values()) waiter.finish({ status: 'pending', durable: false });
  }

  private isSupersededWrite(mapKey: string, generation: Pick<PendingPollQuestion, 'createdAt' | 'toolId'>): boolean {
    const active = this.pendingWrites.get(mapKey)?.generation;
    return active !== undefined && (active.createdAt > generation.createdAt
      || (active.createdAt === generation.createdAt && active.toolId !== generation.toolId));
  }

  private retryWrite(mapKey: string, generation: Pick<PendingPollQuestion, 'createdAt' | 'toolId'>, operation: () => PollPersistenceWriteResult): void {
    if (this.isSupersededWrite(mapKey, generation)) return;
    this.pendingWrites.set(mapKey, { generation: { createdAt: generation.createdAt, toolId: generation.toolId }, run: operation });
    if (this.stopped) {
      this.saveWaiters.get(mapKey)?.finish({ status: 'pending', durable: false });
      return;
    }
    this.retry.scheduleRetry(() => {
      for (const [key, pending] of Array.from(this.pendingWrites)) {
        if (this.pendingWrites.get(key) === pending) pending.run();
      }
    });
    if (this.retry.exhausted) this.saveWaiters.get(mapKey)?.finish({ status: 'pending', durable: false });
  }

  /** Keep the caller's inbound owner until this write succeeds or bounded recovery ends. */
  saveAndWait(mapKey: string, pending: PendingPollQuestion): Promise<PollPersistenceWriteResult> {
    if (this.stopped) return Promise.resolve({ status: 'pending', durable: false });
    if (this.isSupersededWrite(mapKey, pending)) return Promise.resolve({ status: 'superseded', durable: false });
    this.saveWaiters.get(mapKey)?.finish({ status: 'superseded', durable: false });
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: PollPersistenceWriteResult): void => {
        if (settled) return;
        settled = true;
        if (this.saveWaiters.get(mapKey)?.finish === finish) this.saveWaiters.delete(mapKey);
        resolve(result);
      };
      const onDurable = (): void => finish({ status: 'confirmed', durable: true });
      this.saveWaiters.set(mapKey, { onDurable, finish, createdAt: pending.createdAt, toolId: pending.toolId });
      const result = this.save(mapKey, pending, onDurable);
      if (result.status !== 'pending' || result.durable) finish(result);
    });
  }

  isPending(mapKey: string): boolean {
    return this.unresolvedRecords.has(mapKey);
  }

  private resumeAfterWrite(result: PollPersistenceWriteResult, onDurable?: () => void): PollPersistenceWriteResult {
    if (result.durable) onDurable?.();
    return result;
  }

  /**
   * Mark a successful operation. If it ends an active failure streak, record a single
   * recovery (lastRecoveredAt / totalRecoveries) and reset the streak. A success with no
   * prior failure is a no-op — a healthy process does not accumulate "recoveries".
   */
  private recordSuccess(mapKey?: string): void {
    if (mapKey === undefined) this.readFailed = false;
    else {
      this.unresolvedRecords.delete(mapKey);
      this.pendingWrites.delete(mapKey);
      if (this.pendingWrites.size === 0) this.retry.clear();
    }
    if (this.consecutiveFailures > 0 && this.unresolvedRecords.size === 0 && !this.readFailed) {
      this.lastRecoveredAt = systemClock.now();
      this.totalRecoveries += 1;
      this.consecutiveFailures = 0;
    }
  }

  /** Mark a swallowed failure: bumps the cumulative `errors` counter AND the active streak. */
  private recordFailure(err: unknown, mapKey?: string): void {
    if (mapKey === undefined) this.readFailed = true;
    else this.unresolvedRecords.add(mapKey);
    this.errors += 1;
    this.consecutiveFailures += 1;
    this.lastFailureAt = systemClock.now();
    this.lastFailureErr = sanitizeErrMessage(err);
  }

  /**
   * Structured health surface distinguishing current failure from historical recovery.
   * `degraded` is true only while an unrecovered failure streak is active — the cumulative
   * `errors` counter alone cannot express this. Surfaced in the runtime health snapshot.
   */
  healthDetails(): PollPersistenceHealth {
    return {
      errors: this.errors,
      degraded: this.consecutiveFailures > 0 || this.unresolvedRecords.size > 0,
      consecutiveFailures: this.consecutiveFailures,
      lastFailureAt: this.lastFailureAt,
      lastFailureErr: this.lastFailureErr,
      lastRecoveredAt: this.lastRecoveredAt,
      totalRecoveries: this.totalRecoveries,
      retry: this.retry.healthDetails(),
    };
  }

  /**
   * Upsert a pending poll's current state. Normalizes the timeout in place (mirrors
   * the prior inline behavior) before serializing. A failed write retains its
   * snapshot for bounded retry; callers must inspect durability before continuing.
   */
  save(mapKey: string, pending: PendingPollQuestion, onDurable?: () => void): PollPersistenceWriteResult {
    if (this.isSupersededWrite(mapKey, pending)) return { status: 'superseded', durable: false };
    const waiter = this.saveWaiters.get(mapKey);
    if (waiter && waiter.onDurable !== onDurable) waiter.finish({ status: 'superseded', durable: false });
    let payload: string | undefined;
    try {
      const timeoutMs = normalizePendingPollTimeoutMs(pending.timeoutMs);
      pending.timeoutMs = timeoutMs;
      payload = JSON.stringify(serializePendingPoll(pending));
      const closesAt = pending.createdAt + timeoutMs;
      const hardClosesAt = pending.createdAt + timeoutMs * 2;
      this.db.raw
        .prepare(
          `INSERT INTO pending_polls (map_key, chat_jid, tool_id, source, resolution, payload, created_at, closes_at, hard_closes_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(map_key) DO UPDATE SET
             chat_jid = excluded.chat_jid,
             tool_id = excluded.tool_id,
             source = excluded.source,
             resolution = excluded.resolution,
             payload = excluded.payload,
             created_at = excluded.created_at,
             closes_at = excluded.closes_at,
             hard_closes_at = excluded.hard_closes_at
           WHERE pending_polls.created_at < excluded.created_at
              OR (pending_polls.created_at = excluded.created_at AND pending_polls.tool_id = excluded.tool_id)`,
        )
        .run(
          mapKey,
          pending.chatJid,
          pending.toolId,
          pending.source,
          pending.resolution,
          payload,
          pending.createdAt,
          closesAt,
          hardClosesAt,
        );
      const stored = this.db.raw.prepare('SELECT payload, created_at, tool_id, hard_closes_at FROM pending_polls WHERE map_key = ?').get(mapKey);
      if (stored && (Number(stored.created_at) > pending.createdAt
          || (stored.created_at === pending.createdAt && stored.tool_id !== pending.toolId))) {
        this.recordSuccess(mapKey);
        this.saveWaiters.get(mapKey)?.finish({ status: 'superseded', durable: false });
        return { status: 'superseded', durable: false };
      }
      if (stored?.payload !== payload || stored.created_at !== pending.createdAt
          || stored.tool_id !== pending.toolId || stored.hard_closes_at !== hardClosesAt) {
        throw new Error('pending poll write was not verified');
      }
      this.recordSuccess(mapKey);
      return { status: 'confirmed', durable: true };
    } catch (err) {
      this.recordFailure(err, mapKey);
      if (payload !== undefined) {
        const snapshot = payload;
        this.retryWrite(mapKey, pending, () => this.resumeAfterWrite(
          this.save(mapKey, deserializePendingPoll(JSON.parse(snapshot)), onDurable), onDurable,
        ));
      } else {
        this.pendingWrites.delete(mapKey);
        if (this.pendingWrites.size === 0) this.retry.clear();
        this.saveWaiters.get(mapKey)?.finish({ status: 'pending', durable: false });
      }
      log.error({ cause: this.lastFailureErr }, 'persistPendingPoll failed; durability unavailable');
      return { status: 'pending', durable: false };
    }
  }

  /** Delete a pending poll row. Called when the in-memory entry is removed. */
  remove(mapKey: string, generation?: Pick<PendingPollQuestion, 'createdAt' | 'toolId'>, onDurable?: () => void): PollPersistenceWriteResult {
    if (generation && this.isSupersededWrite(mapKey, generation)) return { status: 'superseded', durable: false };
    const waiter = this.saveWaiters.get(mapKey);
    if (waiter && (!generation || (waiter.createdAt === generation.createdAt && waiter.toolId === generation.toolId))) {
      waiter.finish({ status: 'superseded', durable: false });
    }
    let durable = false;
    let expected = generation;
    try {
      const before = this.db.raw.prepare('SELECT created_at, tool_id FROM pending_polls WHERE map_key = ?').get(mapKey);
      if (before === undefined) {
        this.recordSuccess(mapKey);
        return { status: 'confirmed', durable: true };
      }
      expected ??= { createdAt: Number(before.created_at), toolId: String(before.tool_id) };
      if (before.created_at !== expected.createdAt || before.tool_id !== expected.toolId) {
        this.recordSuccess(mapKey);
        return { status: 'superseded', durable: false };
      }
      // Old releases already skip expired rows, so a failed DELETE cannot restore this poll.
      const args = [mapKey, expected.createdAt, expected.toolId] as const;
      this.db.raw.prepare('UPDATE pending_polls SET hard_closes_at = 0 WHERE map_key = ? AND created_at = ? AND tool_id = ?').run(...args);
      const marked = this.db.raw.prepare('SELECT hard_closes_at FROM pending_polls WHERE map_key = ? AND created_at = ? AND tool_id = ?').get(...args);
      durable = marked === undefined || marked.hard_closes_at === 0;
      if (!durable) throw new Error('pending poll terminal marker was not verified');
      this.db.raw.prepare('DELETE FROM pending_polls WHERE map_key = ? AND created_at = ? AND tool_id = ?').run(...args);
      const stored = this.db.raw.prepare('SELECT map_key FROM pending_polls WHERE map_key = ? AND created_at = ? AND tool_id = ?').get(...args);
      if (stored !== undefined) throw new Error('pending poll deletion was not verified');
      this.recordSuccess(mapKey);
      return { status: 'confirmed', durable: true };
    } catch (err) {
      this.recordFailure(err, mapKey);
      // A failed initial read cannot establish which generation is safe to delete.
      if (expected) {
        const captured = { ...expected };
        this.retryWrite(mapKey, captured, () => this.resumeAfterWrite(this.remove(mapKey, captured, onDurable), onDurable));
      }
      log.error({ cause: this.lastFailureErr }, 'removePendingPoll failed');
      return { status: 'pending', durable };
    }
  }

  /**
   * Compatibility accessor for observational callers. Startup uses readRows() to
   * distinguish an unavailable snapshot from an empty table.
   */
  loadRows(): PendingPollRow[] {
    const result = this.readRows();
    return result.status === 'available' ? result.rows : [];
  }

  readRows(): PollPersistenceReadResult {
    try {
      const rows = this.db.raw
        .prepare('SELECT map_key, chat_jid, payload, hard_closes_at, created_at, tool_id FROM pending_polls')
        .all() as unknown as PendingPollRow[];
      // Validate before restoring any row or consuming queued decisions. A partial
      // snapshot could otherwise discard an answer for a poll we failed to decode.
      for (const row of rows) {
        if (row.hard_closes_at !== null && row.hard_closes_at <= systemClock.now()) continue;
        deserializePendingPoll(JSON.parse(row.payload));
      }
      for (const row of rows) {
        if (row.hard_closes_at === 0) {
          this.unresolvedRecords.add(row.map_key);
          const generation = { createdAt: row.created_at, toolId: row.tool_id };
          this.retryWrite(row.map_key, generation, () => this.remove(row.map_key, generation));
        }
      }
      this.recordSuccess();
      return { status: 'available', rows: rows.filter((row) => row.hard_closes_at !== 0) };
    } catch (err) {
      this.recordFailure(err);
      log.error({ cause: this.lastFailureErr }, 'rehydratePendingPolls: snapshot unavailable');
      return { status: 'unavailable' };
    }
  }
}
