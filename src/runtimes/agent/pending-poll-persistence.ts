/**
 * PendingPollPersistence — best-effort SQLite durability for pending AskUserQuestion
 * polls (the pending_polls table).
 *
 * Third slice of the pending-poll subsystem decomposition. Owns the database I/O for
 * pending polls: the upsert (save), the row delete (remove), the startup SELECT
 * (loadRows), and the swallowed-error counter surfaced in /health. In-memory state
 * stays authoritative — every operation is wrapped so a persistence failure only
 * bumps `errors` and logs, never throws.
 *
 * The orchestration that consumes these stays in AgentRuntime: rehydratePendingPolls
 * calls loadRows() then per row decides expire-vs-restore (driving the store, the
 * expiry timers, and the downtime notification — all AgentRuntime concerns); settle /
 * delete / expiry call save/remove. Behavior is identical to the previous inline
 * methods — see the persistence characterization coverage (poll-persistence.test.ts,
 * runtime.test.ts persist-failure-counter, health-snapshot.test.ts).
 *
 * CAR-20 (#2539): in addition to the cumulative `errors` counter, every operation
 * tracks a CURRENT-vs-HISTORICAL failure surface. `healthDetails()` exposes whether
 * an unrecovered failure streak is active right now (degraded) versus when the last
 * recovery happened (lastRecoveredAt / totalRecoveries) — the bare counter could not
 * tell "failing now" apart from "failed earlier and has since recovered."
 */
import type { Database } from '../../core/database.ts';
import { systemClock } from '../../lib/clock.ts';
import { createChildLogger } from '../../logger.ts';
import {
  normalizePendingPollTimeoutMs,
  serializePendingPoll,
  type PendingPollQuestion,
} from './poll-resolution.ts';

// Same component name as AgentRuntime: the persistence error lines keep their existing
// `component: 'agent-runtime'` log binding (no observable change).
const log = createChildLogger('agent-runtime');

/** A pending_polls row as read by rehydration. */
export interface PendingPollRow {
  map_key: string;
  chat_jid: string;
  payload: string;
  hard_closes_at: number | null;
}

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
  /** Current failure streak; resets to 0 on the next successful operation. */
  consecutiveFailures: number;
  /** Epoch-ms of the most recent failure, or null if none has occurred. */
  lastFailureAt: number | null;
  /** Sanitized message of the most recent failure (truncated; never the raw err object). */
  lastFailureErr: string | null;
  /** Epoch-ms of the most recent recovery (a success that ended a failure streak), or null. */
  lastRecoveredAt: number | null;
  /** Lifetime count of failure→success recoveries (increments once per recovered streak). */
  totalRecoveries: number;
}

/** Reduce an arbitrary thrown value to a bounded, log-safe string (never the raw err). */
function sanitizeErrMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > 200 ? `${msg.slice(0, 197)}...` : msg;
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

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Mark a successful operation. If it ends an active failure streak, record a single
   * recovery (lastRecoveredAt / totalRecoveries) and reset the streak. A success with no
   * prior failure is a no-op — a healthy process does not accumulate "recoveries".
   */
  private recordSuccess(): void {
    if (this.consecutiveFailures > 0) {
      this.lastRecoveredAt = systemClock.now();
      this.totalRecoveries += 1;
      this.consecutiveFailures = 0;
    }
  }

  /** Mark a swallowed failure: bumps the cumulative `errors` counter AND the active streak. */
  private recordFailure(err: unknown): void {
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
      degraded: this.consecutiveFailures > 0,
      consecutiveFailures: this.consecutiveFailures,
      lastFailureAt: this.lastFailureAt,
      lastFailureErr: this.lastFailureErr,
      lastRecoveredAt: this.lastRecoveredAt,
      totalRecoveries: this.totalRecoveries,
    };
  }

  /**
   * Upsert a pending poll's current state. Normalizes the timeout in place (mirrors
   * the prior inline behavior) before serializing. Best-effort: on failure the
   * in-memory state remains authoritative and the error counter is bumped.
   */
  save(mapKey: string, pending: PendingPollQuestion): void {
    try {
      const timeoutMs = normalizePendingPollTimeoutMs(pending.timeoutMs);
      pending.timeoutMs = timeoutMs;
      const serialized = serializePendingPoll(pending);
      const payload = JSON.stringify(serialized);
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
             closes_at = excluded.closes_at,
             hard_closes_at = excluded.hard_closes_at`,
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
      this.recordSuccess();
    } catch (err) {
      this.recordFailure(err);
      log.error({ err, mapKey }, 'persistPendingPoll failed; in-memory state remains authoritative');
    }
  }

  /** Delete a pending poll row. Called when the in-memory entry is removed. */
  remove(mapKey: string): void {
    try {
      this.db.raw.prepare('DELETE FROM pending_polls WHERE map_key = ?').run(mapKey);
      this.recordSuccess();
    } catch (err) {
      this.recordFailure(err);
      log.error({ err, mapKey }, 'removePendingPoll failed');
    }
  }

  /**
   * Read all persisted pending-poll rows on startup. Returns an empty array on a
   * SELECT failure (logged), so rehydration always proceeds structurally.
   */
  loadRows(): PendingPollRow[] {
    try {
      const rows = this.db.raw
        .prepare('SELECT map_key, chat_jid, payload, hard_closes_at FROM pending_polls')
        .all() as unknown as PendingPollRow[];
      this.recordSuccess();
      return rows;
    } catch (err) {
      this.recordFailure(err);
      log.error({ err }, 'rehydratePendingPolls: SELECT failed; skipping');
      return [];
    }
  }
}
