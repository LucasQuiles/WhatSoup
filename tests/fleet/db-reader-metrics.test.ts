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
    CREATE INDEX IF NOT EXISTS idx_metrics_hourly_bucket ON metrics_hourly(bucket);

    CREATE TABLE IF NOT EXISTS messages (
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

function insertMetric(db: DatabaseSync, bucket: string, metric: string, value: number) {
  db.prepare(`
    INSERT INTO metrics_hourly (bucket, metric, value) VALUES (?, ?, ?)
    ON CONFLICT(bucket, metric) DO UPDATE SET value = excluded.value
  `).run(bucket, metric, value);
}

describe('FleetDbReader.getMetrics — densification', () => {
  let db: DatabaseSync;
  let reader: FleetDbReader;

  beforeEach(() => {
    db = setupDb();
    reader = new FleetDbReader('self', db);
  });

  afterEach(() => {
    db.close();
  });

  it('returns zero-filled messageVolume for 24h range with sparse data', () => {
    insertMetric(db, '2026-04-05T10:00:00.000Z', 'messages_in', 5);
    insertMetric(db, '2026-04-05T10:00:00.000Z', 'messages_out', 3);
    insertMetric(db, '2026-04-05T10:00:00.000Z', 'messages_media', 1);
    insertMetric(db, '2026-04-05T15:00:00.000Z', 'messages_in', 8);
    insertMetric(db, '2026-04-05T15:00:00.000Z', 'messages_out', 2);
    insertMetric(db, '2026-04-05T15:00:00.000Z', 'messages_media', 0);

    const now = new Date('2026-04-05T18:30:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const result = reader.getMetrics('self', '', { range: '24h' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.messageVolume).toHaveLength(24);

    const hour10 = result.data.messageVolume.find(b => b.bucket.includes('T10:00'));
    expect(hour10?.inbound).toBe(5);
    expect(hour10?.outbound).toBe(3);
    expect(hour10?.media).toBe(1);

    const hour12 = result.data.messageVolume.find(b => b.bucket.includes('T12:00'));
    expect(hour12?.inbound).toBe(0);
    expect(hour12?.outbound).toBe(0);
    expect(hour12?.media).toBe(0);
  });

  it('returns tokenUsage and sessionActivity arrays with correct length', () => {
    insertMetric(db, '2026-04-05T15:00:00.000Z', 'agent_tokens_in', 100);
    insertMetric(db, '2026-04-05T15:00:00.000Z', 'agent_tokens_out', 50);
    insertMetric(db, '2026-04-05T15:00:00.000Z', 'chat_tokens_in', 80);
    insertMetric(db, '2026-04-05T15:00:00.000Z', 'chat_tokens_out', 40);
    insertMetric(db, '2026-04-05T15:00:00.000Z', 'sessions_started', 2);
    insertMetric(db, '2026-04-05T15:00:00.000Z', 'sessions_active', 3);

    const now = new Date('2026-04-05T18:30:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const result = reader.getMetrics('self', '', { range: '24h' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.tokenUsage).toHaveLength(24);
    expect(result.data.sessionActivity).toHaveLength(24);

    const tokBucket = result.data.tokenUsage.find(b => b.bucket.includes('T15:00'));
    expect(tokBucket?.input).toBe(180);  // 100 + 80
    expect(tokBucket?.output).toBe(90);  // 50 + 40

    const sesBucket = result.data.sessionActivity.find(b => b.bucket.includes('T15:00'));
    expect(sesBucket?.started).toBe(2);
    expect(sesBucket?.active).toBe(3);
  });

  it('returns hasMessageData/hasTokenData/hasSessionData flags', () => {
    insertMetric(db, '2026-04-05T15:00:00.000Z', 'messages_in', 5);

    const now = new Date('2026-04-05T18:30:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const result = reader.getMetrics('self', '', { range: '24h' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.hasMessageData).toBe(true);
    expect(result.data.hasTokenData).toBe(false);
    expect(result.data.hasSessionData).toBe(false);
  });

  it('7d range produces 168 buckets', () => {
    const now = new Date('2026-04-05T18:30:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const result = reader.getMetrics('self', '', { range: '7d' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.messageVolume).toHaveLength(168);
    expect(result.data.tokenUsage).toHaveLength(168);
    expect(result.data.sessionActivity).toHaveLength(168);
  });

  it('30d range produces 720 buckets', () => {
    const now = new Date('2026-04-05T18:30:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const result = reader.getMetrics('self', '', { range: '30d' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.messageVolume).toHaveLength(720);
    expect(result.data.tokenUsage).toHaveLength(720);
    expect(result.data.sessionActivity).toHaveLength(720);
  });

  it('returns tokenUsageByProvider with per-provider densified buckets', () => {
    insertMetric(db, '2026-04-05T15:00:00.000Z', 'agent_tokens_in:claude-cli', 100);
    insertMetric(db, '2026-04-05T15:00:00.000Z', 'agent_tokens_out:claude-cli', 50);
    insertMetric(db, '2026-04-05T15:00:00.000Z', 'agent_tokens_in:codex-cli', 200);
    insertMetric(db, '2026-04-05T15:00:00.000Z', 'agent_tokens_out:codex-cli', 75);

    const now = new Date('2026-04-05T18:30:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const result = reader.getMetrics('self', '', { range: '24h' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.tokenUsageByProvider).toBeDefined();
    expect(result.data.tokenUsageByProvider['claude-cli']).toHaveLength(24);
    expect(result.data.tokenUsageByProvider['codex-cli']).toHaveLength(24);

    const claudeBucket = result.data.tokenUsageByProvider['claude-cli']!.find(b => b.bucket.includes('T15:00'));
    expect(claudeBucket?.input).toBe(100);
    expect(claudeBucket?.output).toBe(50);

    const codexBucket = result.data.tokenUsageByProvider['codex-cli']!.find(b => b.bucket.includes('T15:00'));
    expect(codexBucket?.input).toBe(200);
    expect(codexBucket?.output).toBe(75);
  });

  it('returns sessionActivityByProvider with per-provider densified buckets', () => {
    insertMetric(db, '2026-04-05T15:00:00.000Z', 'sessions_started:claude-cli', 1);
    insertMetric(db, '2026-04-05T15:00:00.000Z', 'sessions_active:claude-cli', 2);
    insertMetric(db, '2026-04-05T15:00:00.000Z', 'sessions_started:codex-cli', 3);
    insertMetric(db, '2026-04-05T15:00:00.000Z', 'sessions_active:codex-cli', 1);

    const now = new Date('2026-04-05T18:30:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const result = reader.getMetrics('self', '', { range: '24h' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.sessionActivityByProvider).toBeDefined();
    const claudeSes = result.data.sessionActivityByProvider['claude-cli']!.find(b => b.bucket.includes('T15:00'));
    expect(claudeSes?.started).toBe(1);
    expect(claudeSes?.active).toBe(2);

    const codexSes = result.data.sessionActivityByProvider['codex-cli']!.find(b => b.bucket.includes('T15:00'));
    expect(codexSes?.started).toBe(3);
    expect(codexSes?.active).toBe(1);
  });

  it('returns providers list', () => {
    insertMetric(db, '2026-04-05T15:00:00.000Z', 'agent_tokens_in:claude-cli', 100);
    insertMetric(db, '2026-04-05T15:00:00.000Z', 'sessions_active:codex-cli', 1);

    const now = new Date('2026-04-05T18:30:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const result = reader.getMetrics('self', '', { range: '24h' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.providers.sort()).toEqual(['claude-cli', 'codex-cli']);
  });
});
