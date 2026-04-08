import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { FleetDbReader } from '../../src/fleet/db-reader.ts';

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS metrics_hourly (
      bucket TEXT NOT NULL,
      metric TEXT NOT NULL,
      value REAL NOT NULL,
      PRIMARY KEY (bucket, metric)
    );

    CREATE TABLE IF NOT EXISTS messages (
      pk INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_jid TEXT NOT NULL DEFAULT '',
      conversation_key TEXT NOT NULL DEFAULT '',
      sender_jid TEXT NOT NULL DEFAULT '',
      content TEXT,
      content_type TEXT NOT NULL DEFAULT 'text',
      is_from_me INTEGER NOT NULL DEFAULT 0,
      timestamp INTEGER NOT NULL,
      deleted_at TEXT
    );
  `);
  return db;
}

function insertMessage(db: DatabaseSync, timestampUnix: number): void {
  db.prepare(`
    INSERT INTO messages (conversation_key, sender_jid, content, timestamp, is_from_me)
    VALUES ('chat@s.whatsapp.net', 'sender@s.whatsapp.net', 'hello', ?, 0)
  `).run(timestampUnix);
}

describe('FleetDbReader.getMetrics — activeHoursByDate', () => {
  let db: DatabaseSync;
  let reader: FleetDbReader;

  // Pin "now" to 2026-04-08T18:00:00Z so ranges are deterministic
  const NOW = new Date('2026-04-08T18:00:00.000Z').getTime();

  beforeEach(() => {
    db = setupDb();
    reader = new FleetDbReader('self', db);
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('30d range: activeHoursByDate is populated with per-date data', () => {
    // Insert two messages on two distinct dates within the 30d window
    // 2026-04-07T10:00:00Z
    const ts1 = Math.floor(new Date('2026-04-07T10:00:00Z').getTime() / 1000);
    // 2026-04-07T14:00:00Z
    const ts2 = Math.floor(new Date('2026-04-07T14:00:00Z').getTime() / 1000);
    // 2026-04-06T09:00:00Z
    const ts3 = Math.floor(new Date('2026-04-06T09:00:00Z').getTime() / 1000);

    insertMessage(db, ts1);
    insertMessage(db, ts2);
    insertMessage(db, ts3);

    const result = reader.getMetrics('self', '', { range: '30d' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { activeHoursByDate } = result.data;
    expect(activeHoursByDate.length).toBeGreaterThan(0);

    // Should have entries for both dates
    const apr7 = activeHoursByDate.find(d => d.date === '2026-04-07');
    const apr6 = activeHoursByDate.find(d => d.date === '2026-04-06');
    expect(apr7).toBeDefined();
    expect(apr6).toBeDefined();

    // Apr 7 has messages at hour 10 and 14
    expect(apr7!.hours[10]).toBe(1);
    expect(apr7!.hours[14]).toBe(1);
    // Apr 6 has message at hour 9
    expect(apr6!.hours[9]).toBe(1);
  });

  it('24h range: activeHoursByDate is empty', () => {
    const ts = Math.floor(new Date('2026-04-08T10:00:00Z').getTime() / 1000);
    insertMessage(db, ts);

    const result = reader.getMetrics('self', '', { range: '24h' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.activeHoursByDate).toEqual([]);
  });

  it('7d range: activeHoursByDate is empty', () => {
    const ts = Math.floor(new Date('2026-04-07T10:00:00Z').getTime() / 1000);
    insertMessage(db, ts);

    const result = reader.getMetrics('self', '', { range: '7d' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.activeHoursByDate).toEqual([]);
  });

  it('30d range: date format is YYYY-MM-DD', () => {
    const ts = Math.floor(new Date('2026-03-25T12:00:00Z').getTime() / 1000);
    insertMessage(db, ts);

    const result = reader.getMetrics('self', '', { range: '30d' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { activeHoursByDate } = result.data;
    for (const entry of activeHoursByDate) {
      expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('30d range: each date entry has exactly 24 hour slots', () => {
    const ts = Math.floor(new Date('2026-04-05T08:00:00Z').getTime() / 1000);
    insertMessage(db, ts);

    const result = reader.getMetrics('self', '', { range: '30d' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { activeHoursByDate } = result.data;
    expect(activeHoursByDate.length).toBeGreaterThan(0);

    for (const entry of activeHoursByDate) {
      expect(entry.hours).toHaveLength(24);
    }
  });

  it('30d range: messages outside the window are excluded', () => {
    // Insert message 31 days ago — outside the 30d window
    const oldTs = Math.floor((NOW - 31 * 24 * 60 * 60 * 1000) / 1000);
    insertMessage(db, oldTs);

    // Insert message within the 30d window
    const recentTs = Math.floor(new Date('2026-04-07T10:00:00Z').getTime() / 1000);
    insertMessage(db, recentTs);

    const result = reader.getMetrics('self', '', { range: '30d' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { activeHoursByDate } = result.data;
    // Only the recent message date should appear
    expect(activeHoursByDate).toHaveLength(1);
    expect(activeHoursByDate[0].date).toBe('2026-04-07');
  });

  it('30d range: deleted messages are excluded from activeHoursByDate', () => {
    // Insert a non-deleted message and a deleted message on the same date/hour
    const ts = Math.floor(new Date('2026-04-07T10:00:00Z').getTime() / 1000);
    insertMessage(db, ts);
    db.prepare(`
      INSERT INTO messages (conversation_key, sender_jid, content, timestamp, is_from_me, deleted_at)
      VALUES ('chat@s.whatsapp.net', 'sender@s.whatsapp.net', 'deleted', ?, 0, '2026-04-07T11:00:00Z')
    `).run(ts);

    const result = reader.getMetrics('self', '', { range: '30d' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const apr7 = result.data.activeHoursByDate.find(d => d.date === '2026-04-07');
    expect(apr7).toBeDefined();
    // Only 1 message (not the deleted one)
    expect(apr7!.hours[10]).toBe(1);
  });

  it('30d range: empty activeHoursByDate when no messages exist', () => {
    const result = reader.getMetrics('self', '', { range: '30d' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.activeHoursByDate).toEqual([]);
  });

  it('30d range: dates are ordered ascending', () => {
    const dates = ['2026-04-01', '2026-03-28', '2026-04-05', '2026-03-20'];
    for (const dateStr of dates) {
      const ts = Math.floor(new Date(`${dateStr}T10:00:00Z`).getTime() / 1000);
      insertMessage(db, ts);
    }

    const result = reader.getMetrics('self', '', { range: '30d' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { activeHoursByDate } = result.data;
    const returnedDates = activeHoursByDate.map(d => d.date);
    const sorted = [...returnedDates].sort();
    expect(returnedDates).toEqual(sorted);
  });
});
