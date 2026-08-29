// FLOS Stage 1 — Contract B: the private, bounded, per-instance event store.
// Real SQLite (temp file per repo convention), injectable clock. Budgets per
// design §10: 14d/100k retention, 64 MiB budget with 80% compaction
// (drop-oldest NON-ROOT, counted), 8× hard ceiling (non-root writes stop,
// counted, saturating; root writes continue), protected roots exempt from
// both drop-oldest and expiry. Silent truncation is nonconformant — every
// drop is counted.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createLifecycleEventStore } from '../../../src/core/observability/lifecycle-event-store.ts';
import type { LifecycleEvent } from '../../../src/core/observability/lifecycle-event.ts';

const AT = '2026-08-29T03:00:00Z';
const AT_MS = Date.parse(AT);
const DAY_MS = 86_400_000;

let dirs: string[] = [];
function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'flos-store-'));
  dirs.push(dir);
  return join(dir, 'events.sqlite3');
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function ev(overrides: Partial<LifecycleEvent> & { work_id: string; phase: LifecycleEvent['phase'] }): LifecycleEvent {
  return {
    schema: 'whatsoup.lifecycle.event.v1',
    instance: 'instance-alpha',
    host: 'host-1',
    lane: 'L-SCH',
    origin_lane: null,
    correlation: {},
    at_utc: AT,
    boot_id: 'boot-1',
    mono_ms: 1,
    attrs: {},
    ...overrides,
  } as LifecycleEvent;
}

describe('lifecycle event store (FLOS Contract B)', () => {
  it('appends a valid event and reads it back typed', () => {
    const store = createLifecycleEventStore({ path: tempDb(), nowEpochMs: () => AT_MS });
    const result = store.append(ev({ work_id: 'w1', phase: 'admitted' }));
    expect(result.accepted).toBe(true);
    const rows = store.readEvents({ work_id: 'w1' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.phase).toBe('admitted');
    expect(rows[0]?.correlation).toEqual({});
    store.close();
  });

  it('rejects an invalid envelope fail-closed (counted, not thrown)', () => {
    const store = createLifecycleEventStore({ path: tempDb(), nowEpochMs: () => AT_MS });
    const bad = { ...ev({ work_id: 'w1', phase: 'admitted' }), phase: 'nope' } as unknown as LifecycleEvent;
    const result = store.append(bad);
    expect(result.accepted).toBe(false);
    expect(result.dropped_reason).toBe('invalid_envelope');
    expect(store.counters().dropped['invalid_envelope']).toBe(1);
    expect(store.readEvents({})).toHaveLength(0);
    store.close();
  });

  it('expires rows past the retention window but never protected roots', () => {
    let now = AT_MS;
    const store = createLifecycleEventStore({ path: tempDb(), retentionDays: 14, nowEpochMs: () => now });
    store.append(ev({ work_id: 'w-old', phase: 'progress' }));
    store.append(ev({ work_id: 'w-old', phase: 'released' })); // newest released per scope = root
    now = AT_MS + 15 * DAY_MS;
    store.append(ev({ work_id: 'w-new', phase: 'admitted', at_utc: '2026-09-13T03:00:00Z' }));
    const sweep = store.sweep();
    expect(sweep.expired_rows).toBe(1); // the progress row only
    const remaining = store.readEvents({});
    expect(remaining.map((r) => r.phase).sort()).toEqual(['admitted', 'released']);
    store.close();
  });

  it('drop-oldest at maxRows spares protected roots and counts drops', () => {
    const store = createLifecycleEventStore({ path: tempDb(), maxRows: 4, nowEpochMs: () => AT_MS });
    store.append(ev({ work_id: 'w1', phase: 'released' })); // root (oldest row)
    store.append(ev({ work_id: 'w2', phase: 'progress' }));
    store.append(ev({ work_id: 'w3', phase: 'progress' }));
    store.append(ev({ work_id: 'w4', phase: 'progress' }));
    store.append(ev({ work_id: 'w5', phase: 'progress' })); // over maxRows
    store.sweep();
    const rows = store.readEvents({});
    expect(rows.length).toBeLessThanOrEqual(4);
    // The root released event survives even though it is the oldest.
    expect(rows.some((r) => r.work_id === 'w1' && r.phase === 'released')).toBe(true);
    expect(store.counters().dropped['row_cap']).toBeGreaterThanOrEqual(1);
    store.close();
  });

  it('stops non-root appends at the hard ceiling but keeps accepting roots', () => {
    // Tiny budget so the ceiling (budget × multiple) is reachable in-test.
    const store = createLifecycleEventStore({
      path: tempDb(),
      budgetBytes: 4096,
      hardCeilingMultiple: 1,
      nowEpochMs: () => AT_MS,
    });
    let rejected = 0;
    for (let i = 0; i < 500; i += 1) {
      const r = store.append(ev({ work_id: `w${i}`, phase: 'progress', attrs: { seq: i } }));
      if (!r.accepted) { rejected += 1; if (rejected > 3) break; }
    }
    expect(rejected).toBeGreaterThan(0);
    expect(store.counters().dropped['over_hard_ceiling']).toBeGreaterThan(0);
    // A settlement root still lands after the ceiling closed non-root writes.
    const root = store.append(ev({ work_id: 'w-root', phase: 'finalized' }));
    expect(root.accepted).toBe(true);
    store.close();
  });

  it('compacts non-root evidence at 80% of budget, drop-oldest, counted', () => {
    const store = createLifecycleEventStore({
      path: tempDb(),
      budgetBytes: 16_384,
      hardCeilingMultiple: 100, // keep the ceiling far away; exercise compaction only
      nowEpochMs: () => AT_MS,
    });
    for (let i = 0; i < 400; i += 1) {
      store.append(ev({ work_id: `w${i}`, phase: 'progress', attrs: { seq: i } }));
    }
    store.append(ev({ work_id: 'w-root', phase: 'released' }));
    const sweep = store.sweep();
    expect(sweep.compacted_rows).toBeGreaterThan(0);
    expect(store.counters().dropped['budget_compaction']).toBe(sweep.compacted_rows);
    expect(store.counters().storage_bytes).toBeGreaterThan(0);
    // Root survived compaction.
    expect(store.readEvents({ work_id: 'w-root' })).toHaveLength(1);
    store.close();
  });

  it('drop counters saturate instead of overflowing', () => {
    const store = createLifecycleEventStore({ path: tempDb(), nowEpochMs: () => AT_MS });
    store.recordDrop('test_kind', 2 ** 31 - 2);
    store.recordDrop('test_kind', 5);
    expect(store.counters().dropped['test_kind']).toBe(2 ** 31 - 1);
    store.close();
  });

  it('reopens an existing store file with counters and rows intact', () => {
    const path = tempDb();
    const a = createLifecycleEventStore({ path, nowEpochMs: () => AT_MS });
    a.append(ev({ work_id: 'w1', phase: 'admitted' }));
    a.recordDrop('test_kind', 3);
    a.close();
    const b = createLifecycleEventStore({ path, nowEpochMs: () => AT_MS });
    expect(b.readEvents({ work_id: 'w1' })).toHaveLength(1);
    expect(b.counters().dropped['test_kind']).toBe(3);
    b.close();
  });
});
