import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../src/core/database.ts';
import {
  runDatabaseRetention,
  DEFAULT_DATABASE_RETENTION,
} from '../../src/core/database-retention.ts';

// #2567 slice 2 — bounded retention for terminal fact-export rows.
// Exported rows were already pruned; quarantined / retry_exhausted /
// legacy_unclassified rows carried full payloads FOREVER. Terminal-only:
// pending / leased / retry_wait are recoverable work and are never pruned.

function seedRow(
  db: Database,
  factId: string,
  state: string,
  createdDaysAgo: number,
): void {
  db.raw.prepare(
    `INSERT INTO fact_export_queue (fact_uid, fact_id, chat_jid, payload_json, state, created_at)
     VALUES (?, ?, 'seed-chat@g.us', '{"secret":"payload"}', ?, datetime('now', ?))`,
  ).run(`fe_${factId.replace(/[^a-z0-9]/gi, '').padEnd(24, '0').slice(0, 24)}`, factId, state, `-${createdDaysAgo} days`);
}

describe('fact export terminal retention (#2567 slice 2)', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => db.close());

  function states(): Record<string, number> {
    return Object.fromEntries(
      (db.raw.prepare('SELECT state, COUNT(*) AS n FROM fact_export_queue GROUP BY state').all() as Array<{ state: string; n: number }>)
        .map(r => [r.state, r.n]),
    );
  }

  it('prunes old quarantined, retry_exhausted, and legacy_unclassified rows past the window', () => {
    seedRow(db, 'q-old', 'quarantined', 45);
    seedRow(db, 'x-old', 'retry_exhausted', 45);
    seedRow(db, 'l-old', 'legacy_unclassified', 45);
    seedRow(db, 'q-young', 'quarantined', 5);
    seedRow(db, 'x-young', 'retry_exhausted', 5);

    const result = runDatabaseRetention(db, {
      ...DEFAULT_DATABASE_RETENTION,
      factTerminalDays: 30,
    });

    expect(result.factExportTerminal).toBe(3);
    expect(states()).toEqual({ quarantined: 1, retry_exhausted: 1 });
  });

  it('NEVER prunes recoverable states regardless of age', () => {
    seedRow(db, 'p-ancient', 'pending', 400);
    seedRow(db, 'r-ancient', 'retry_wait', 400);
    db.raw.prepare(
      `INSERT INTO fact_export_queue (fact_uid, fact_id, chat_jid, payload_json, state, lease_owner, lease_expires_at, created_at)
       VALUES ('fe_leasedancient000000000', 'lease-ancient', 'seed-chat@g.us', '{}', 'leased', 'w', 1, datetime('now', '-400 days'))`,
    ).run();

    const result = runDatabaseRetention(db, DEFAULT_DATABASE_RETENTION);

    expect(result.factExportTerminal).toBe(0);
    expect(states()).toEqual({ pending: 1, retry_wait: 1, leased: 1 });
  });

  it('default window is present in the retention config', () => {
    expect(DEFAULT_DATABASE_RETENTION.factTerminalDays).toBe(30);
  });
});
