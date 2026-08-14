// #2566 slice 4 — trigger history retention rides the shared database
// retention engine. Terminal trigger_runs and terminal/stale
// trigger_occurrences past their windows are pruned; active evidence
// (running occurrences, however old) is NEVER touched — an unfinalized row is
// crash evidence, not history.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../src/core/database.ts';
import {
  DEFAULT_DATABASE_RETENTION,
  runDatabaseRetention,
} from '../../src/core/database-retention.ts';
import { createBead } from '../../src/core/substrate/beads.ts';
import { createTrigger } from '../../src/core/substrate/triggers.ts';

const NOW = () => Math.floor(Date.now() / 1000);
const DAY = 86_400;

describe('database retention — trigger history (#2566 slice 4)', () => {
  let db: Database;
  beforeEach(() => { db = new Database(':memory:'); db.open(); });
  afterEach(() => { db.close(); });

  function seedTrigger() {
    const bead = createBead(db.raw, { kind: 'watch', title: 'w', ownerJid: 'mw', actor: 'u' });
    return createTrigger(db.raw, {
      beadId: bead.id, kind: 'schedule.cron', spec: { expr: '0 8 * * *' },
      reportChatJid: 'report@g.us', nextFireAt: NOW() + 3600, actor: 'u',
    });
  }

  function insertRun(triggerId: number, beadId: number, status: string, ageDays: number): number {
    const at = NOW() - ageDays * DAY;
    const info = db.raw.prepare(
      `INSERT INTO trigger_runs (trigger_id, bead_id, status, started_at, finished_at, attempt, metadata_json)
       VALUES (?, ?, ?, ?, ?, 1, '{}')`,
    ).run(triggerId, beadId, status, at, at);
    return Number(info.lastInsertRowid);
  }

  function insertOccurrence(
    triggerId: number, beadId: number, state: string, ageDays: number, scheduledFor: number,
  ): number {
    const at = NOW() - ageDays * DAY;
    const info = db.raw.prepare(
      `INSERT INTO trigger_occurrences
         (trigger_id, bead_id, scheduled_for, attempt, state, lease_owner, lease_generation, lease_expires_at, claimed_at, started_at, finished_at)
       VALUES (?, ?, ?, 1, ?, 'pid:old:aaaa', 1, ?, ?, ?, ?)`,
    ).run(triggerId, beadId, scheduledFor, state, at + 900, at, at, at);
    return Number(info.lastInsertRowid);
  }

  it('prunes old terminal runs and occurrences, keeps young ones', () => {
    const t = seedTrigger();
    const oldRun = insertRun(t.id, t.bead_id, 'ok', 40);
    const youngRun = insertRun(t.id, t.bead_id, 'failed', 5);
    const oldOcc = insertOccurrence(t.id, t.bead_id, 'ok', 40, 1_000);
    const oldStale = insertOccurrence(t.id, t.bead_id, 'stale', 40, 2_000);
    const youngOcc = insertOccurrence(t.id, t.bead_id, 'failed', 5, 3_000);

    runDatabaseRetention(db, DEFAULT_DATABASE_RETENTION);

    const runIds = (db.raw.prepare(`SELECT id FROM trigger_runs`).all() as Array<{ id: number }>).map((r) => r.id);
    expect(runIds).not.toContain(oldRun);
    expect(runIds).toContain(youngRun);
    const occIds = (db.raw.prepare(`SELECT id FROM trigger_occurrences`).all() as Array<{ id: number }>).map((r) => r.id);
    expect(occIds).not.toContain(oldOcc);
    expect(occIds).not.toContain(oldStale);
    expect(occIds).toContain(youngOcc);
  });

  it('never prunes running occurrences or running runs, regardless of age', () => {
    const t = seedTrigger();
    const ancientRunningRun = insertRun(t.id, t.bead_id, 'running', 400);
    const ancientRunningOcc = insertOccurrence(t.id, t.bead_id, 'running', 400, 4_000);
    const ancientClaimedOcc = insertOccurrence(t.id, t.bead_id, 'claimed', 400, 5_000);

    runDatabaseRetention(db, DEFAULT_DATABASE_RETENTION);

    const runIds = (db.raw.prepare(`SELECT id FROM trigger_runs`).all() as Array<{ id: number }>).map((r) => r.id);
    expect(runIds).toContain(ancientRunningRun);
    const occIds = (db.raw.prepare(`SELECT id FROM trigger_occurrences`).all() as Array<{ id: number }>).map((r) => r.id);
    expect(occIds).toContain(ancientRunningOcc);
    expect(occIds).toContain(ancientClaimedOcc);
  });

  it('reports pruned trigger-history counts in the retention result', () => {
    const t = seedTrigger();
    insertRun(t.id, t.bead_id, 'ok', 40);
    insertOccurrence(t.id, t.bead_id, 'noop', 40, 6_000);

    const result = runDatabaseRetention(db, DEFAULT_DATABASE_RETENTION);
    expect(result.triggerRuns).toBe(1);
    expect(result.triggerOccurrences).toBe(1);
  });
});
