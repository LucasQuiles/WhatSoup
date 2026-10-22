/**
 * #2200 (src/fleet slice): FleetDbReader.getMetrics derives its window and
 * its hour buckets from an injected Clock, not the raw wall clock.
 *
 * The fake clock sits months before the real one. Data in the fake day is
 * inside a 24h window by the injected clock and far outside it by the wall
 * clock, so a reader that still reads the wall clock returns empty buckets
 * that end at the real current hour.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { FleetDbReader } from '../../src/fleet/db-reader.ts';
import { fakeClock } from '../../src/lib/clock.ts';

vi.mock('../../src/logger.ts', async () => (await import('../helpers/logger-mock.ts')).loggerMock());

const FAKE_NOW_MS = Date.parse('2026-04-05T18:30:00.000Z');

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE metrics_hourly (
      bucket TEXT NOT NULL,
      metric TEXT NOT NULL,
      value REAL NOT NULL,
      PRIMARY KEY (bucket, metric)
    );
    CREATE TABLE messages (
      pk INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_jid TEXT NOT NULL,
      conversation_key TEXT NOT NULL,
      sender_jid TEXT NOT NULL,
      content TEXT,
      content_type TEXT NOT NULL DEFAULT 'text',
      is_from_me INTEGER NOT NULL DEFAULT 0,
      timestamp INTEGER NOT NULL,
      deleted_at TEXT
    );
  `);
  return db;
}

describe('#2200 FleetDbReader.getMetrics reads time through its injected clock', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = setupDb();
  });

  afterEach(() => {
    db.close();
  });

  it('builds the 24h window and its last bucket from the injected clock', () => {
    db.prepare('INSERT INTO metrics_hourly (bucket, metric, value) VALUES (?, ?, ?)')
      .run('2026-04-05T10:00:00.000Z', 'messages_in', 5);
    const reader = new FleetDbReader('self', db, fakeClock(FAKE_NOW_MS));

    const result = reader.getMetrics('self', '', { range: '24h' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.messageVolume).toHaveLength(24);
    expect(result.data.messageVolume.at(-1)?.bucket).toBe('2026-04-05T18:00:00.000Z');
    expect(result.data.messageVolume.find((b) => b.bucket === '2026-04-05T10:00:00.000Z')?.inbound).toBe(5);
    expect(result.data.hasMessageData).toBe(true);
  });
});
