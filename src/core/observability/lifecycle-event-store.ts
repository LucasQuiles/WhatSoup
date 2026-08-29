// src/core/observability/lifecycle-event-store.ts
// Fleet Lifecycle Observability Standard — Contract B: the private, bounded,
// per-instance event store (design §10).
//
// Real SQLite (node:sqlite), one file per instance. Budgets are enforced at
// write and sweep time: 14-day / 100k-row retention, a byte budget (64 MiB
// default) compacted at 80% by dropping the OLDEST NON-ROOT evidence
// (counted), and a hard ceiling (default 8× budget) past which non-root
// writes stop entirely (counted, saturating) while settlement roots continue.
// Protected roots — the newest `released`/`finalized` event per
// (instance, lane, work_id) scope — are exempt from drop-oldest, row caps,
// AND time-based expiry. Silent truncation of any kind is nonconformant:
// every dropped or refused write increments a persisted, saturating counter
// (`m1_evidence_dropped_total{kind}` feeds from these in Stage 2).
//
// This is the raw-id PRIVATE surface (design §2 privacy): it never leaves the
// host and carries no message content — the envelope validator already
// rejects free-form text at parse time, and append re-validates fail-closed.
//
// Dark by default: nothing imports this until emission is gated behind the
// `observability.fleetLifecycle` phase (see ./fleet-lifecycle-flag.ts).

import { DatabaseSync } from 'node:sqlite';

import { parseLifecycleEvent, type LifecycleEvent } from './lifecycle-event.ts';

const DAY_MS = 86_400_000;
const COUNTER_SATURATION = 2 ** 31 - 1;
const ROOT_PHASES = "('released','finalized')";

export interface LifecycleEventStoreOptions {
  /** SQLite file path (tests use a temp file). */
  path: string;
  /** Byte budget before compaction pressure. Default 64 MiB. */
  budgetBytes?: number;
  /** Hard ceiling = budget × this multiple (F16). Default 8. */
  hardCeilingMultiple?: number;
  /** Event retention window in days. Default 14. */
  retentionDays?: number;
  /** Event row cap. Default 100_000. */
  maxRows?: number;
  /** Injectable clock (epoch ms). Default Date.now. */
  nowEpochMs?: () => number;
}

export type DropReason =
  | 'invalid_envelope'
  | 'over_hard_ceiling'
  | 'row_cap'
  | 'budget_compaction'
  | (string & {});

export interface AppendResult {
  accepted: boolean;
  dropped_reason?: DropReason;
}

export interface SweepResult {
  expired_rows: number;
  compacted_rows: number;
}

export interface StoreCounters {
  dropped: Record<string, number>;
  storage_bytes: number;
  rows: number;
}

export interface ReadFilter {
  instance?: string;
  lane?: string;
  work_id?: string;
  limit?: number;
}

export interface LifecycleEventStore {
  append(event: LifecycleEvent): AppendResult;
  sweep(): SweepResult;
  counters(): StoreCounters;
  readEvents(filter: ReadFilter): LifecycleEvent[];
  /** Increment a persisted, saturating drop counter. */
  recordDrop(kind: DropReason, count?: number): void;
  close(): void;
}

function isRootPhase(phase: LifecycleEvent['phase']): boolean {
  return phase === 'released' || phase === 'finalized';
}

export function createLifecycleEventStore(options: LifecycleEventStoreOptions): LifecycleEventStore {
  const budgetBytes = options.budgetBytes ?? 64 * 1024 * 1024;
  const hardCeilingBytes = budgetBytes * (options.hardCeilingMultiple ?? 8);
  const retentionMs = (options.retentionDays ?? 14) * DAY_MS;
  const maxRows = options.maxRows ?? 100_000;
  const now = options.nowEpochMs ?? Date.now;

  const db = new DatabaseSync(options.path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA auto_vacuum = FULL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance TEXT NOT NULL,
      host TEXT NOT NULL,
      lane TEXT NOT NULL,
      origin_lane TEXT,
      work_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      at_utc TEXT NOT NULL,
      boot_id TEXT NOT NULL,
      mono_ms INTEGER NOT NULL,
      correlation_json TEXT NOT NULL,
      attrs_json TEXT NOT NULL,
      inserted_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_scope ON events (instance, lane, work_id, id);
    CREATE INDEX IF NOT EXISTS idx_events_inserted ON events (inserted_at_ms);
    CREATE TABLE IF NOT EXISTS drop_counters (
      kind TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    );
  `);
  // auto_vacuum takes effect for pre-existing pages only after a VACUUM.
  db.exec('VACUUM');

  const insertEvent = db.prepare(`
    INSERT INTO events (instance, host, lane, origin_lane, work_id, phase, at_utc, boot_id, mono_ms, correlation_json, attrs_json, inserted_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const upsertCounter = db.prepare(`
    INSERT INTO drop_counters (kind, value) VALUES (?, ?)
    ON CONFLICT(kind) DO UPDATE SET value = MIN(${COUNTER_SATURATION}, drop_counters.value + excluded.value)
  `);

  function storageBytes(): number {
    const pageCount = db.prepare('PRAGMA page_count').get() as { page_count?: number } | undefined;
    const pageSize = db.prepare('PRAGMA page_size').get() as { page_size?: number } | undefined;
    return (pageCount?.page_count ?? 0) * (pageSize?.page_size ?? 0);
  }

  function rowCount(): number {
    const row = db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n?: number } | undefined;
    return row?.n ?? 0;
  }

  function recordDrop(kind: DropReason, count = 1): void {
    upsertCounter.run(kind, Math.min(count, COUNTER_SATURATION));
  }

  /** Delete up to `limit` oldest non-root rows; returns rows deleted. */
  function deleteOldestNonRoot(limit: number): number {
    const result = db.prepare(`
      DELETE FROM events WHERE id IN (
        SELECT id FROM events
        WHERE id NOT IN (
          SELECT MAX(id) FROM events WHERE phase IN ${ROOT_PHASES} GROUP BY instance, lane, work_id
        )
        ORDER BY id ASC LIMIT ?
      )
    `).run(limit);
    return Number(result.changes ?? 0);
  }

  return {
    append(event) {
      const parsed = parseLifecycleEvent(event);
      if (!parsed.ok) {
        recordDrop('invalid_envelope');
        return { accepted: false, dropped_reason: 'invalid_envelope' };
      }
      const root = isRootPhase(parsed.event.phase);
      if (!root && storageBytes() >= hardCeilingBytes) {
        // F16: the store must never be the reason a runtime exhausts its
        // disk. Non-root evidence stops (counted); roots continue.
        recordDrop('over_hard_ceiling');
        return { accepted: false, dropped_reason: 'over_hard_ceiling' };
      }
      const e = parsed.event;
      insertEvent.run(
        e.instance, e.host, e.lane, e.origin_lane, e.work_id, e.phase, e.at_utc,
        e.boot_id, e.mono_ms, JSON.stringify(e.correlation), JSON.stringify(e.attrs), now(),
      );
      return { accepted: true };
    },

    sweep() {
      // 1. Time-based expiry — never touches protected roots.
      const cutoff = now() - retentionMs;
      const expired = db.prepare(`
        DELETE FROM events
        WHERE inserted_at_ms < ?
          AND id NOT IN (
            SELECT MAX(id) FROM events WHERE phase IN ${ROOT_PHASES} GROUP BY instance, lane, work_id
          )
      `).run(cutoff);
      const expiredRows = Number(expired.changes ?? 0);
      if (expiredRows > 0) recordDrop('retention_expiry', expiredRows);

      // 2. Row cap — drop-oldest non-root, counted.
      let capDropped = 0;
      let excess = rowCount() - maxRows;
      while (excess > 0) {
        const deleted = deleteOldestNonRoot(Math.min(excess, 200));
        if (deleted === 0) break; // only roots remain — roots are never dropped
        capDropped += deleted;
        excess = rowCount() - maxRows;
      }
      if (capDropped > 0) recordDrop('row_cap', capDropped);

      // 3. Byte budget — compact non-root at ≥80% of budget, counted.
      let compacted = 0;
      while (storageBytes() >= budgetBytes * 0.8) {
        const deleted = deleteOldestNonRoot(200);
        if (deleted === 0) break; // roots alone over budget: kept (V8 raise lands in Stage 2)
        compacted += deleted;
      }
      if (compacted > 0) recordDrop('budget_compaction', compacted);

      return { expired_rows: expiredRows, compacted_rows: compacted };
    },

    counters() {
      const dropped: Record<string, number> = {};
      const rows = db.prepare('SELECT kind, value FROM drop_counters').all() as Array<{ kind: string; value: number }>;
      for (const row of rows) dropped[row.kind] = row.value;
      return { dropped, storage_bytes: storageBytes(), rows: rowCount() };
    },

    readEvents(filter) {
      const clauses: string[] = [];
      const params: Array<string | number> = [];
      if (filter.instance !== undefined) { clauses.push('instance = ?'); params.push(filter.instance); }
      if (filter.lane !== undefined) { clauses.push('lane = ?'); params.push(filter.lane); }
      if (filter.work_id !== undefined) { clauses.push('work_id = ?'); params.push(filter.work_id); }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      params.push(filter.limit ?? 1000);
      const rows = db.prepare(`SELECT * FROM events ${where} ORDER BY id ASC LIMIT ?`).all(...params) as Array<Record<string, unknown>>;
      const events: LifecycleEvent[] = [];
      for (const row of rows) {
        const candidate = {
          schema: 'whatsoup.lifecycle.event.v1',
          instance: row['instance'],
          host: row['host'],
          lane: row['lane'],
          origin_lane: row['origin_lane'] ?? null,
          work_id: row['work_id'],
          phase: row['phase'],
          at_utc: row['at_utc'],
          boot_id: row['boot_id'],
          mono_ms: row['mono_ms'],
          correlation: JSON.parse(String(row['correlation_json'])),
          attrs: JSON.parse(String(row['attrs_json'])),
        };
        const parsed = parseLifecycleEvent(candidate);
        if (parsed.ok) events.push(parsed.event); // a corrupt row is skipped, never thrown
      }
      return events;
    },

    recordDrop,

    close() {
      db.close();
    },
  };
}
