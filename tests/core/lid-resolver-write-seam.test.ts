/**
 * Direct tests for the writeLidMapping seam (#251 PR-1).
 *
 * Covers the three modes (skip-if-exists / overwrite / freshness-gated),
 * the history-row contract (written on flip, NOT on no-op or first-seen-skip),
 * and the retention cleanup bounds (1000 rows OR 90 days, whichever first).
 *
 * The L5 importLidMappings batch path is exercised end-to-end here too,
 * including conflict reporting.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { Database } from '../../src/core/database.ts';
import {
  writeLidMapping,
  importLidMappings,
  type FleetMappingInput,
} from '../../src/core/lid-resolver.ts';

const PHONE_A = '15551112222@s.whatsapp.net';
const PHONE_B = '15553334444@s.whatsapp.net';
const PHONE_C = '15555556666@s.whatsapp.net';

function freshDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

function historyCount(db: Database, lid: string): number {
  return (
    db.raw
      .prepare('SELECT COUNT(*) AS c FROM lid_mappings_history WHERE lid = ?')
      .get(lid) as { c: number }
  ).c;
}

function currentPhone(db: Database, lid: string): string | undefined {
  return (
    db.raw
      .prepare('SELECT phone_jid FROM lid_mappings WHERE lid = ?')
      .get(lid) as { phone_jid: string } | undefined
  )?.phone_jid;
}

function currentUpdatedAt(db: Database, lid: string): string | undefined {
  return (
    db.raw
      .prepare('SELECT updated_at FROM lid_mappings WHERE lid = ?')
      .get(lid) as { updated_at: string } | undefined
  )?.updated_at;
}

function recentTimestamp(): string {
  return new Date(Date.now() - 60 * 1000).toISOString();
}

// ─── writeLidMapping — basic semantics ───────────────────────────────────────

describe('writeLidMapping — first-seen insert', () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => { db.close(); });

  it('inserts a new row, writes a history row with prev=NULL, and reports written=true flipped=false', () => {
    const result = writeLidMapping(db.raw, '12345', PHONE_A, 'L2', 'overwrite');

    expect(result).toEqual({ written: true, flipped: false });
    expect(currentPhone(db, '12345')).toBe(PHONE_A);

    const history = db.raw
      .prepare('SELECT * FROM lid_mappings_history WHERE lid = ? ORDER BY id')
      .all('12345') as Array<{
        prev_phone_jid: string | null;
        new_phone_jid: string;
        source: string;
      }>;
    expect(history).toHaveLength(1);
    expect(history[0].prev_phone_jid).toBeNull();
    expect(history[0].new_phone_jid).toBe(PHONE_A);
    expect(history[0].source).toBe('L2');
  });
});

describe('writeLidMapping — no-op when phone unchanged', () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => { db.close(); });

  it('does not write history when the new phone matches the existing phone', () => {
    writeLidMapping(db.raw, '12345', PHONE_A, 'L2', 'overwrite');
    expect(historyCount(db, '12345')).toBe(1);

    const result = writeLidMapping(db.raw, '12345', PHONE_A, 'L2', 'overwrite');
    expect(result).toEqual({ written: false, flipped: false });

    // History row count is unchanged — the no-op did NOT write to history.
    expect(historyCount(db, '12345')).toBe(1);

    // updated_at was also not touched on no-op (we never re-ran the UPDATE).
    const row = db.raw
      .prepare('SELECT phone_jid FROM lid_mappings WHERE lid = ?')
      .get('12345') as { phone_jid: string };
    expect(row.phone_jid).toBe(PHONE_A);
  });
});

describe('writeLidMapping — flip writes history + updates phone', () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => { db.close(); });

  it('records prev_phone_jid and new_phone_jid on a real flip', () => {
    writeLidMapping(db.raw, '12345', PHONE_A, 'L2', 'overwrite');
    const result = writeLidMapping(db.raw, '12345', PHONE_B, 'L2', 'overwrite');

    expect(result).toEqual({ written: true, flipped: true });
    expect(currentPhone(db, '12345')).toBe(PHONE_B);

    const history = db.raw
      .prepare('SELECT prev_phone_jid, new_phone_jid FROM lid_mappings_history WHERE lid = ? ORDER BY id')
      .all('12345') as Array<{ prev_phone_jid: string | null; new_phone_jid: string }>;
    expect(history).toEqual([
      { prev_phone_jid: null, new_phone_jid: PHONE_A },
      { prev_phone_jid: PHONE_A, new_phone_jid: PHONE_B },
    ]);
  });
});

// ─── mode: skip-if-exists (L1) ───────────────────────────────────────────────

describe('writeLidMapping — skip-if-exists mode (L1 hydration semantics)', () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => { db.close(); });

  it('inserts when no row exists', () => {
    const result = writeLidMapping(db.raw, '12345', PHONE_A, 'L1', 'skip-if-exists');
    expect(result).toEqual({ written: true, flipped: false });
    expect(currentPhone(db, '12345')).toBe(PHONE_A);
  });

  it('does NOT overwrite an existing row even if the phone differs', () => {
    writeLidMapping(db.raw, '12345', PHONE_A, 'L2', 'overwrite');
    const result = writeLidMapping(db.raw, '12345', PHONE_B, 'L1', 'skip-if-exists');

    expect(result).toEqual({ written: false, flipped: false });
    expect(currentPhone(db, '12345')).toBe(PHONE_A);
    // No history row written for the skipped attempt.
    expect(historyCount(db, '12345')).toBe(1);
  });
});

// ─── mode: freshness-gated (L5) ──────────────────────────────────────────────

describe('writeLidMapping — freshness-gated mode (L5 import)', () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => { db.close(); });

  it('writes when incoming observed_updated_at is strictly newer', () => {
    // Seed with an older row by inserting a known timestamp.
    db.raw
      .prepare('INSERT INTO lid_mappings (lid, phone_jid, updated_at) VALUES (?, ?, ?)')
      .run('12345', PHONE_A, '2026-01-01T00:00:00Z');

    const result = writeLidMapping(db.raw, '12345', PHONE_B, 'L5', 'freshness-gated', {
      observedUpdatedAt: '2026-05-01T00:00:00Z',
      sourceInstance: 'instance-b',
    });

    expect(result.written).toBe(true);
    expect(result.flipped).toBe(true);
    expect(result.conflict).toBeUndefined();
    expect(currentPhone(db, '12345')).toBe(PHONE_B);

    // The new row's updated_at persists the incoming observation time so
    // future cross-instance comparisons remain meaningful.
    const row = db.raw
      .prepare('SELECT updated_at FROM lid_mappings WHERE lid = ?')
      .get('12345') as { updated_at: string };
    expect(row.updated_at).toBe('2026-05-01T00:00:00Z');

    // Source instance landed in history.
    const h = db.raw
      .prepare('SELECT source_instance, observed_updated_at FROM lid_mappings_history WHERE lid = ?')
      .get('12345') as { source_instance: string; observed_updated_at: string };
    expect(h.source_instance).toBe('instance-b');
    expect(h.observed_updated_at).toBe('2026-05-01T00:00:00Z');
  });

  it('refuses the write and returns a populated conflict when incoming is older', () => {
    db.raw
      .prepare('INSERT INTO lid_mappings (lid, phone_jid, updated_at) VALUES (?, ?, ?)')
      .run('12345', PHONE_A, '2026-05-01T00:00:00Z');

    const result = writeLidMapping(db.raw, '12345', PHONE_B, 'L5', 'freshness-gated', {
      observedUpdatedAt: '2026-01-01T00:00:00Z',
      sourceInstance: 'instance-stale',
    });

    expect(result.written).toBe(false);
    expect(result.flipped).toBe(false);
    expect(result.conflict).toEqual({
      prevPhoneJid: PHONE_A,
      prevUpdatedAt: '2026-05-01T00:00:00Z',
    });
    expect(currentPhone(db, '12345')).toBe(PHONE_A);
    expect(historyCount(db, '12345')).toBe(0);
  });

  it('refuses the write when incoming is equal (strict greater-than)', () => {
    db.raw
      .prepare('INSERT INTO lid_mappings (lid, phone_jid, updated_at) VALUES (?, ?, ?)')
      .run('12345', PHONE_A, '2026-05-01T00:00:00Z');

    const result = writeLidMapping(db.raw, '12345', PHONE_B, 'L5', 'freshness-gated', {
      observedUpdatedAt: '2026-05-01T00:00:00Z',
    });

    expect(result.written).toBe(false);
    expect(result.conflict?.prevUpdatedAt).toBe('2026-05-01T00:00:00Z');
  });

  it('compares SQLite and ISO timestamps by instant instead of raw string ordering', () => {
    db.raw
      .prepare('INSERT INTO lid_mappings (lid, phone_jid, updated_at) VALUES (?, ?, ?)')
      .run('12345', PHONE_A, '2026-05-01 23:59:59');

    const result = writeLidMapping(db.raw, '12345', PHONE_B, 'L5', 'freshness-gated', {
      observedUpdatedAt: '2026-05-01T00:00:00Z',
      sourceInstance: 'stale-iso-instance',
    });

    expect(result.written).toBe(false);
    expect(result.conflict).toEqual({
      prevPhoneJid: PHONE_A,
      prevUpdatedAt: '2026-05-01 23:59:59',
    });
    expect(currentPhone(db, '12345')).toBe(PHONE_A);
    expect(historyCount(db, '12345')).toBe(0);
  });

  it('advances updated_at for fresher same-phone L5 observations without writing history', () => {
    db.raw
      .prepare('INSERT INTO lid_mappings (lid, phone_jid, updated_at) VALUES (?, ?, ?)')
      .run('12345', PHONE_A, '2026-01-01 00:00:00');

    const result = writeLidMapping(db.raw, '12345', PHONE_A, 'L5', 'freshness-gated', {
      observedUpdatedAt: '2026-05-01T00:00:00Z',
      sourceInstance: 'fresh-same-phone-instance',
    });

    expect(result).toEqual({ written: false, flipped: false });
    expect(currentPhone(db, '12345')).toBe(PHONE_A);
    expect(currentUpdatedAt(db, '12345')).toBe('2026-05-01T00:00:00Z');
    expect(historyCount(db, '12345')).toBe(0);
  });

  it('inserts a new LID freely (no existing row → no freshness check)', () => {
    const result = writeLidMapping(db.raw, '99999', PHONE_A, 'L5', 'freshness-gated', {
      observedUpdatedAt: '2026-01-01T00:00:00Z',
    });
    expect(result).toEqual({ written: true, flipped: false });
    expect(currentPhone(db, '99999')).toBe(PHONE_A);
  });
});

// ─── retention cleanup ──────────────────────────────────────────────────────

describe('writeLidMapping — retention cleanup', () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => { db.close(); });

  it('keeps at most 1000 history rows per LID (newest wins)', () => {
    const insertHist = db.raw.prepare(
      `INSERT INTO lid_mappings_history (lid, prev_phone_jid, new_phone_jid, source, changed_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    // Backfill 1100 rows directly. Use a recent timestamp so the age bound
    // doesn't prune them — the row-count cap should do the work.
    const recentTs = recentTimestamp();
    for (let i = 0; i < 1100; i++) {
      insertHist.run('99999', PHONE_A, PHONE_B, 'L2', recentTs);
    }
    // Seed a current row so writeLidMapping triggers a flip and the cleanup
    // runs.
    db.raw
      .prepare("INSERT INTO lid_mappings (lid, phone_jid, updated_at) VALUES (?, ?, datetime('now'))")
      .run('99999', PHONE_A);

    // Trigger a flip — retention runs after the new history row is written.
    writeLidMapping(db.raw, '99999', PHONE_C, 'L2', 'overwrite');

    const after = historyCount(db, '99999');
    expect(after).toBe(1000);
  });

  it('prunes history rows older than 90 days', () => {
    const insertHist = db.raw.prepare(
      `INSERT INTO lid_mappings_history (lid, prev_phone_jid, new_phone_jid, source, changed_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    // Insert 5 ancient rows + 3 recent rows.
    for (let i = 0; i < 5; i++) {
      insertHist.run('77777', PHONE_A, PHONE_B, 'L2', '2020-01-01T00:00:00Z');
    }
    const recentTs = recentTimestamp();
    for (let i = 0; i < 3; i++) {
      insertHist.run('77777', PHONE_A, PHONE_B, 'L2', recentTs);
    }
    expect(historyCount(db, '77777')).toBe(8);

    db.raw
      .prepare("INSERT INTO lid_mappings (lid, phone_jid, updated_at) VALUES (?, ?, datetime('now'))")
      .run('77777', PHONE_A);
    writeLidMapping(db.raw, '77777', PHONE_C, 'L2', 'overwrite');

    // After cleanup: 3 recent + 1 from the flip = 4 (the 5 ancients are pruned).
    expect(historyCount(db, '77777')).toBe(4);
  });

  it('retention is per-LID — does not touch other LIDs', () => {
    const insertHist = db.raw.prepare(
      `INSERT INTO lid_mappings_history (lid, prev_phone_jid, new_phone_jid, source, changed_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const recentTs = recentTimestamp();
    for (let i = 0; i < 1100; i++) {
      insertHist.run('AAA', PHONE_A, PHONE_B, 'L2', recentTs);
    }
    for (let i = 0; i < 5; i++) {
      insertHist.run('BBB', PHONE_A, PHONE_B, 'L2', recentTs);
    }

    db.raw
      .prepare("INSERT INTO lid_mappings (lid, phone_jid, updated_at) VALUES (?, ?, datetime('now'))")
      .run('AAA', PHONE_A);
    writeLidMapping(db.raw, 'AAA', PHONE_C, 'L2', 'overwrite');

    expect(historyCount(db, 'AAA')).toBe(1000);
    expect(historyCount(db, 'BBB')).toBe(5);
  });
});

// ─── importLidMappings — batch entry point ──────────────────────────────────

describe('importLidMappings — batch fleet-sync semantics', () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => { db.close(); });

  it('imports new mappings as new rows', () => {
    const input: FleetMappingInput[] = [
      { lid: '111', phone_jid: PHONE_A, updated_at: '2026-05-01T00:00:00Z', source_instance: 'a' },
      { lid: '222', phone_jid: PHONE_B, updated_at: '2026-05-01T00:00:00Z', source_instance: 'a' },
    ];
    const result = importLidMappings(db, input);

    expect(result.imported).toBe(2);
    expect(result.flipped).toBe(0);
    expect(result.noop).toBe(0);
    expect(result.conflicts).toHaveLength(0);
  });

  it('reports conflicts when stale rows are presented and does not overwrite', () => {
    db.raw
      .prepare('INSERT INTO lid_mappings (lid, phone_jid, updated_at) VALUES (?, ?, ?)')
      .run('111', PHONE_A, '2026-05-10T00:00:00Z');

    const result = importLidMappings(db, [
      { lid: '111', phone_jid: PHONE_B, updated_at: '2026-01-01T00:00:00Z', source_instance: 'stale-instance' },
    ]);

    expect(result.imported).toBe(0);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      lid: '111',
      incoming_phone_jid: PHONE_B,
      existing_phone_jid: PHONE_A,
      source_instance: 'stale-instance',
    });
    expect(currentPhone(db, '111')).toBe(PHONE_A);
  });

  it('flips when an incoming observation is strictly newer', () => {
    db.raw
      .prepare('INSERT INTO lid_mappings (lid, phone_jid, updated_at) VALUES (?, ?, ?)')
      .run('111', PHONE_A, '2026-01-01T00:00:00Z');

    const result = importLidMappings(db, [
      { lid: '111', phone_jid: PHONE_B, updated_at: '2026-05-01T00:00:00Z', source_instance: 'fresh-instance' },
    ]);

    expect(result.imported).toBe(1);
    expect(result.flipped).toBe(1);
    expect(currentPhone(db, '111')).toBe(PHONE_B);
  });

  it('skips malformed inputs (missing phone_jid or wrong domain)', () => {
    const result = importLidMappings(db, [
      { lid: '111', phone_jid: '' as string, updated_at: '2026-05-01T00:00:00Z' },
      { lid: '222', phone_jid: '15551234567@lid', updated_at: '2026-05-01T00:00:00Z' }, // wrong domain
      { lid: '', phone_jid: PHONE_A, updated_at: '2026-05-01T00:00:00Z' },
    ]);
    expect(result.imported).toBe(0);
    expect(result.conflicts).toHaveLength(0);
  });

  it('counts no-op rows (same phone) as noop, not imported', () => {
    db.raw
      .prepare('INSERT INTO lid_mappings (lid, phone_jid, updated_at) VALUES (?, ?, ?)')
      .run('111', PHONE_A, '2026-01-01T00:00:00Z');

    const result = importLidMappings(db, [
      { lid: '111', phone_jid: PHONE_A, updated_at: '2026-05-01T00:00:00Z' },
    ]);
    expect(result.imported).toBe(0);
    expect(result.flipped).toBe(0);
    expect(result.noop).toBe(1);
    expect(result.conflicts).toHaveLength(0);
  });

  it('uses refreshed same-phone freshness to reject later stale conflicts', () => {
    db.raw
      .prepare('INSERT INTO lid_mappings (lid, phone_jid, updated_at) VALUES (?, ?, ?)')
      .run('111', PHONE_A, '2026-01-01 00:00:00');

    const result = importLidMappings(db, [
      { lid: '111', phone_jid: PHONE_A, updated_at: '2026-05-01T00:00:00Z', source_instance: 'fresh-same-phone' },
      { lid: '111', phone_jid: PHONE_B, updated_at: '2026-03-01T00:00:00Z', source_instance: 'stale-conflict' },
    ]);

    expect(result.imported).toBe(0);
    expect(result.flipped).toBe(0);
    expect(result.noop).toBe(1);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      incoming_phone_jid: PHONE_B,
      existing_phone_jid: PHONE_A,
      source_instance: 'stale-conflict',
    });
    expect(currentPhone(db, '111')).toBe(PHONE_A);
    expect(currentUpdatedAt(db, '111')).toBe('2026-05-01T00:00:00Z');
  });
});

// ─── L5 fleet-sync convergence — 2-instance scenario ────────────────────────

describe('importLidMappings — 2-instance fleet convergence', () => {
  let dbA: Database;
  let dbB: Database;

  beforeEach(() => {
    dbA = freshDb();
    dbB = freshDb();
  });

  afterEach(() => {
    dbA.close();
    dbB.close();
  });

  it('converges to the freshest observation across diverged instances', () => {
    // Instance A saw lid=X→phoneA at T1
    dbA.raw
      .prepare('INSERT INTO lid_mappings (lid, phone_jid, updated_at) VALUES (?, ?, ?)')
      .run('X', PHONE_A, '2026-01-01T00:00:00Z');

    // Instance B saw lid=X→phoneB at T2 > T1
    dbB.raw
      .prepare('INSERT INTO lid_mappings (lid, phone_jid, updated_at) VALUES (?, ?, ?)')
      .run('X', PHONE_B, '2026-05-01T00:00:00Z');

    // Build the union with source_instance markers (what the fleet handler does).
    const observations: FleetMappingInput[] = [
      { lid: 'X', phone_jid: PHONE_A, updated_at: '2026-01-01T00:00:00Z', source_instance: 'A' },
      { lid: 'X', phone_jid: PHONE_B, updated_at: '2026-05-01T00:00:00Z', source_instance: 'B' },
    ];

    // Apply union to A: A's stale row is overwritten by B's fresher observation.
    // The "import A's own row back into A" is reported as a conflict (stale)
    // or no-op depending on input order, but the FRESH row from B always wins.
    const resA = importLidMappings(dbA, observations);
    expect(currentPhone(dbA, 'X')).toBe(PHONE_B);
    expect(resA.flipped).toBe(1);

    // Apply union to B: B's row is already the fresh winner. A's stale row
    // is reported as a conflict.
    const resB = importLidMappings(dbB, observations);
    expect(currentPhone(dbB, 'X')).toBe(PHONE_B);
    expect(resB.conflicts.some((c) => c.source_instance === 'A')).toBe(true);

    // Both instances now agree on the winner.
    expect(currentPhone(dbA, 'X')).toBe(currentPhone(dbB, 'X'));
  });
});
