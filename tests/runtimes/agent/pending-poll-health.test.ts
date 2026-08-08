import { describe, expect, it, vi } from 'vitest';

import { Database } from '../../../src/core/database.ts';
import {
  ConsumptionReceiptRecorder,
  QueuedDecisionConsumer,
  OfflineDecisionRetryScheduler,
} from '../../../src/runtimes/agent/pending-poll-health.ts';

/**
 * CAR-20 (#2539) — pending-poll-health extracted module characterization.
 *
 * Covers every edge branch of the three exported classes so the new module
 * ships fully covered (NEW-MODULE RULE): retry scheduling/coalescing/backoff/
 * exhaustion/clear, receipt recording/counting/best-effort disablement, and the
 * queued-decision consumer's drop/retain/retry semantics.
 */

function makeDb(): Database {
  const db = new Database(':memory:');
  db.open();
  db.raw.exec(`
    CREATE TABLE IF NOT EXISTS pending_poll_decisions (
      map_key TEXT NOT NULL,
      question_index INTEGER NOT NULL,
      selected_options TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      via TEXT NOT NULL,
      PRIMARY KEY (map_key, question_index)
    );
  `);
  return db;
}

function queueRow(db: Database, mapKey: string, options: string[], via = 'console'): void {
  db.raw
    .prepare(
      `INSERT OR REPLACE INTO pending_poll_decisions (map_key, question_index, selected_options, via)
       VALUES (?, 0, ?, ?)`,
    )
    .run(mapKey, JSON.stringify(options), via);
}

// ── OfflineDecisionRetryScheduler ──────────────────────────────────────────

describe('OfflineDecisionRetryScheduler', () => {
  it('reports a baseline healthy state', () => {
    const s = new OfflineDecisionRetryScheduler();
    expect(s.healthDetails()).toEqual({ pending: false, attempts: 0, exhausted: false, nextRetryAt: null });
    expect(s.pendingRetry).toBe(false);
  });

  it('arms a deferred retry with exponential backoff', () => {
    let now = 1_000_000;
    const captured: Array<{ fn: () => void; ms: number }> = [];
    const s = new OfflineDecisionRetryScheduler({
      baseDelayMs: 1_000,
      maxDelayMs: 60_000,
      scheduler: (fn, ms) => { captured.push({ fn, ms }); return {}; },
      clearer: () => {},
      now: () => now,
    });

    s.scheduleRetry(() => {});
    expect(s.pendingRetry).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.ms).toBe(1_000); // baseDelay * 2^0
    expect(s.healthDetails().nextRetryAt).toBe(now + 1_000);
  });

  it('coalesces a second scheduleRetry while one is armed (no-op)', () => {
    const captured: Array<{ fn: () => void; ms: number }> = [];
    const s = new OfflineDecisionRetryScheduler({ scheduler: (fn, ms) => { captured.push({ fn, ms }); return {}; } });
    s.scheduleRetry(() => {});
    s.scheduleRetry(() => {}); // armed → no-op
    expect(captured).toHaveLength(1);
    expect(s.pendingRetry).toBe(true);
  });

  it('increments attempts and invokes the callback when the timer fires', () => {
    let timer: (() => void) | null = null;
    let fired: string | null = null;
    const s = new OfflineDecisionRetryScheduler({ scheduler: (fn) => { timer = fn as () => void; return {}; } });
    s.scheduleRetry(() => { fired = 'ran'; });
    expect(s.pendingRetry).toBe(true); // armed (handle = {})
    timer!(); // fire the deferred callback
    expect(s.attempts).toBe(1);
    expect(s.pendingRetry).toBe(false); // handle cleared by the fired callback
    expect(fired).toBe('ran');
  });

  it('swallows a throwing retry callback (never rejects)', () => {
    const s = new OfflineDecisionRetryScheduler({ scheduler: (fn) => { (fn as () => void)(); return {}; } });
    expect(() => s.scheduleRetry(() => { throw new Error('boom'); })).not.toThrow();
    expect(s.attempts).toBe(1);
  });

  it('swallows a rejecting async retry callback', async () => {
    const s = new OfflineDecisionRetryScheduler({ scheduler: (fn) => { (fn as () => void)(); return {}; } });
    await expect(Promise.resolve(s.scheduleRetry(() => Promise.reject(new Error('async boom'))))).resolves.toBeUndefined();
    expect(s.attempts).toBe(1);
  });

  it('stops (exhausted) after maxAttempts and refuses further retries', () => {
    let timer: (() => void) | null = null;
    const s = new OfflineDecisionRetryScheduler({
      maxAttempts: 2,
      baseDelayMs: 1,
      scheduler: (fn) => { timer = fn as () => void; return {}; },
    });
    // attempt 1
    s.scheduleRetry(() => {});
    timer!();
    // attempt 2
    s.scheduleRetry(() => {});
    timer!();
    expect(s.attempts).toBe(2);
    // 3rd scheduleRetry → at maxAttempts → exhausted, no timer armed
    timer = null;
    s.scheduleRetry(() => {});
    expect(timer).toBeNull();
    expect(s.exhausted).toBe(true);
    expect(s.healthDetails().exhausted).toBe(true);
    // a further call is a no-op once exhausted — pin the full terminal state
    s.scheduleRetry(() => {});
    expect(timer).toBeNull();
    expect(s.healthDetails()).toEqual({
      pending: false,
      attempts: 2,
      exhausted: true,
      nextRetryAt: null,
    });
  });

  it('clear() cancels an armed retry without resetting attempts/exhaustion', () => {
    let cleared = 0;
    const s = new OfflineDecisionRetryScheduler({ scheduler: () => ({}), clearer: () => { cleared += 1; } });
    s.scheduleRetry(() => {});
    expect(s.pendingRetry).toBe(true);
    s.clear();
    expect(s.pendingRetry).toBe(false);
    expect(cleared).toBe(1);
  });
});

// ── ConsumptionReceiptRecorder ─────────────────────────────────────────────

describe('ConsumptionReceiptRecorder', () => {
  it('records consumed/moot/failed receipts and counts them by outcome', () => {
    const db = makeDb();
    const now = vi.fn(() => 5_000);
    const rec = new ConsumptionReceiptRecorder(db, now);

    rec.recordConsumed('k1', 0);
    rec.recordMoot('k2', 0, 'poll_not_pending');
    rec.recordFailed('k3', 0, 'invalid');

    expect(rec.countSince('consumed', 0)).toBe(1);
    expect(rec.countSince('moot', 0)).toBe(1);
    expect(rec.countSince('failed', 0)).toBe(1); // only k3 (failed outcome)
    expect(rec.countSince('consumed', 6_000)).toBe(0); // cutoff after consumed_at_ms=5000
  });

  it('pendingCount reflects rows still queued in pending_poll_decisions', () => {
    const db = makeDb();
    const rec = new ConsumptionReceiptRecorder(db);
    queueRow(db, 'a', ['x']);
    queueRow(db, 'b', ['y']);
    expect(rec.pendingCount()).toBe(2);
  });

  it('latches ensureTable failure: disables receipts (record/count become no-ops, never throw)', () => {
    const failingDb = {
      raw: {
        exec: () => { throw new Error('disk locked'); },
        prepare: () => { throw new Error('should not reach'); },
      },
    } as unknown as Database;
    const rec = new ConsumptionReceiptRecorder(failingDb);
    expect(() => rec.recordConsumed('k', 0)).not.toThrow();
    expect(rec.countSince('consumed', 0)).toBe(0); // table unavailable → 0
  });

  it('swallows a record failure after the table was ensured (best-effort)', () => {
    // Table ensures fine, but the INSERT prepare throws.
    let call = 0;
    const db = {
      raw: {
        exec: () => {},
        prepare: () => {
          call += 1;
          if (call === 1) return { all: () => [] }; // sqlite_master read (not used by recorder)
          throw new Error('insert failed');
        },
      },
    } as unknown as Database;
    const rec = new ConsumptionReceiptRecorder(db);
    expect(() => rec.recordConsumed('k', 0)).not.toThrow();
  });
});

// ── QueuedDecisionConsumer ─────────────────────────────────────────────────

describe('QueuedDecisionConsumer', () => {
  it('returns zeros and schedules no retry when pending_poll_decisions is absent', async () => {
    const db = new Database(':memory:');
    db.open(); // no pending_poll_decisions table
    const retry = vi.fn();
    const rec = new ConsumptionReceiptRecorder(db);
    const consumer = new QueuedDecisionConsumer(db, rec, retry);
    const res = await consumer.consume({ hasPending: () => false, resolve: vi.fn() });
    expect(res).toEqual({ consumed: 0, moot: 0, retained: 0, hadError: false });
    expect(retry).not.toHaveBeenCalled();
  });

  it('returns zeros when the table exists but is empty', async () => {
    const db = makeDb();
    const retry = vi.fn();
    const rec = new ConsumptionReceiptRecorder(db);
    const consumer = new QueuedDecisionConsumer(db, rec, retry);
    const res = await consumer.consume({ hasPending: () => false, resolve: vi.fn() });
    expect(res).toEqual({ consumed: 0, moot: 0, retained: 0, hadError: false });
    expect(retry).not.toHaveBeenCalled();
  });

  it('drops a moot row (poll not pending) and records a moot receipt', async () => {
    const db = makeDb();
    queueRow(db, 'gone', ['x']);
    const retry = vi.fn();
    const rec = new ConsumptionReceiptRecorder(db);
    const consumer = new QueuedDecisionConsumer(db, rec, retry);
    const res = await consumer.consume({ hasPending: () => false, resolve: vi.fn() });
    expect(res.moot).toBe(1);
    expect(res.retained).toBe(0);
    expect(rec.pendingCount()).toBe(0); // deleted
    expect(rec.countSince('moot', 0)).toBe(1);
    expect(retry).not.toHaveBeenCalled();
  });

  it('drops a row with unparseable options as moot', async () => {
    const db = makeDb();
    db.raw
      .prepare(`INSERT INTO pending_poll_decisions (map_key, question_index, selected_options, via) VALUES (?, 0, ?, 'console')`)
      .run('bad', '{not json');
    const rec = new ConsumptionReceiptRecorder(db);
    const consumer = new QueuedDecisionConsumer(db, rec, vi.fn());
    const res = await consumer.consume({ hasPending: () => true, resolve: vi.fn() });
    expect(res.moot).toBe(1);
    expect(rec.pendingCount()).toBe(0);
    expect(rec.countSince('moot', 0)).toBe(1);
  });

  it('consumes an ok decision, deletes the row, records a consumed receipt, no retry', async () => {
    const db = makeDb();
    queueRow(db, 'live', ['a']);
    const rec = new ConsumptionReceiptRecorder(db);
    const retry = vi.fn();
    const consumer = new QueuedDecisionConsumer(db, rec, retry);
    const resolve = vi.fn().mockResolvedValue({ ok: true });
    const res = await consumer.consume({ hasPending: () => true, resolve });
    expect(res.consumed).toBe(1);
    expect(rec.pendingCount()).toBe(0);
    expect(rec.countSince('consumed', 0)).toBe(1);
    expect(retry).not.toHaveBeenCalled();
  });

  it('treats stale / not_found as terminal (deleted, moot receipt)', async () => {
    const db = makeDb();
    queueRow(db, 's', ['a']);
    queueRow(db, 'n', ['a']);
    const rec = new ConsumptionReceiptRecorder(db);
    const consumer = new QueuedDecisionConsumer(db, rec, vi.fn());
    const resolve = vi.fn()
      .mockResolvedValueOnce({ ok: false, code: 'stale' })
      .mockResolvedValueOnce({ ok: false, code: 'not_found' });
    const res = await consumer.consume({ hasPending: () => true, resolve });
    expect(res.moot).toBe(2);
    expect(rec.pendingCount()).toBe(0);
  });

  it('retains an invalid decision, records a failed receipt, and schedules a retry', async () => {
    const db = makeDb();
    queueRow(db, 'inv', ['a']);
    const rec = new ConsumptionReceiptRecorder(db);
    const retry = vi.fn();
    const consumer = new QueuedDecisionConsumer(db, rec, retry);
    const resolve = vi.fn().mockResolvedValue({ ok: false, code: 'invalid' });
    const res = await consumer.consume({ hasPending: () => true, resolve });
    expect(res.retained).toBe(1);
    expect(rec.pendingCount()).toBe(1); // NOT deleted — retained for retry
    expect(rec.countSince('failed', 0)).toBe(1);
    expect(retry).toHaveBeenCalledTimes(1); // [DISCRIMINATING: scheduled retry]
  });

  it('schedules a retry when the top-level read path throws (hadError)', async () => {
    // pending_poll_decisions absent from the table list → but force a throw on the
    // master read by using a db whose raw.prepare throws for the sqlite_master query.
    const calls: string[] = [];
    const db = {
      raw: {
        prepare: (sql: string) => {
          calls.push(sql);
          throw new Error('transient read failure');
        },
      },
    } as unknown as Database;
    const rec = new ConsumptionReceiptRecorder(db);
    const retry = vi.fn();
    const consumer = new QueuedDecisionConsumer(db, rec, retry);
    const res = await consumer.consume({ hasPending: () => true, resolve: vi.fn() });
    expect(res.hadError).toBe(true);
    expect(retry).toHaveBeenCalledTimes(1); // [DISCRIMINATING: scheduled retry on read failure]
  });
});
