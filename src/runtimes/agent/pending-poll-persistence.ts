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
 */
import type { Database } from '../../core/database.ts';
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

export class PendingPollPersistence {
  /** Count of swallowed pending_polls persistence failures (save/remove/rehydrate). Surfaced in health. */
  errors = 0;

  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
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
    } catch (err) {
      this.errors += 1;
      log.error({ err, mapKey }, 'persistPendingPoll failed; in-memory state remains authoritative');
    }
  }

  /** Delete a pending poll row. Called when the in-memory entry is removed. */
  remove(mapKey: string): void {
    try {
      this.db.raw.prepare('DELETE FROM pending_polls WHERE map_key = ?').run(mapKey);
    } catch (err) {
      this.errors += 1;
      log.error({ err, mapKey }, 'removePendingPoll failed');
    }
  }

  /**
   * Read all persisted pending-poll rows on startup. Returns an empty array on a
   * SELECT failure (logged), so rehydration always proceeds structurally.
   */
  loadRows(): PendingPollRow[] {
    try {
      return this.db.raw
        .prepare('SELECT map_key, chat_jid, payload, hard_closes_at FROM pending_polls')
        .all() as unknown as PendingPollRow[];
    } catch (err) {
      this.errors += 1;
      log.error({ err }, 'rehydratePendingPolls: SELECT failed; skipping');
      return [];
    }
  }
}
