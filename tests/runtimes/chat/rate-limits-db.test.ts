import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Database } from '../../../src/core/database.ts';
import { ensureChatSchema } from '../../../src/runtimes/chat/runtime.ts';
import {
  recordResponse,
  getResponseCount,
  cleanupOldRateLimits,
} from '../../../src/runtimes/chat/rate-limits-db.ts';

function tempDbPath(): string {
  return join(tmpdir(), `whatsapp-bot-test-${randomBytes(4).toString('hex')}.db`);
}

const dbPath = tempDbPath();
const db = new Database(dbPath);
db.open();
ensureChatSchema(db);

afterAll(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const fp = dbPath + suffix;
    if (existsSync(fp)) unlinkSync(fp);
  }
});

describe('rate-limits', () => {
  beforeEach(() => {
    db.raw.prepare('DELETE FROM rate_limits').run();
  });

  // --- positive tests ---

  it('recordResponse + getResponseCount within window counts correctly', () => {
    recordResponse(db, 'alice@s.whatsapp.net');
    recordResponse(db, 'alice@s.whatsapp.net');
    recordResponse(db, 'alice@s.whatsapp.net');

    const count = getResponseCount(db, 'alice@s.whatsapp.net', 60_000); // 1-minute window
    expect(count).toBe(3);
  });

  it('multiple senders are tracked independently', () => {
    recordResponse(db, 'alice@s.whatsapp.net');
    recordResponse(db, 'alice@s.whatsapp.net');
    recordResponse(db, 'bob@s.whatsapp.net');

    expect(getResponseCount(db, 'alice@s.whatsapp.net', 60_000)).toBe(2);
    expect(getResponseCount(db, 'bob@s.whatsapp.net', 60_000)).toBe(1);
    expect(getResponseCount(db, 'carol@s.whatsapp.net', 60_000)).toBe(0);
  });

  // --- negative / edge-case tests ---

  it('getResponseCount returns 0 for records outside the window', () => {
    // Insert a row from 3 hours ago
    db.raw
      .prepare(
        `INSERT INTO rate_limits (sender_jid, response_at)
         VALUES ('alice@s.whatsapp.net', datetime('now', '-3 hours'))`
      )
      .run();

    // Window of 1 hour — the 3-hour-old record must not be counted
    const count = getResponseCount(db, 'alice@s.whatsapp.net', 60 * 60 * 1000);
    expect(count).toBe(0);
  });

  it('cleanupOldRateLimits removes rows older than 2 hours and preserves recent ones', () => {
    // Two old rows (3 h ago)
    db.raw
      .prepare(
        `INSERT INTO rate_limits (sender_jid, response_at)
         VALUES ('alice@s.whatsapp.net', datetime('now', '-3 hours'))`
      )
      .run();
    db.raw
      .prepare(
        `INSERT INTO rate_limits (sender_jid, response_at)
         VALUES ('bob@s.whatsapp.net', datetime('now', '-3 hours'))`
      )
      .run();
    // One recent row
    recordResponse(db, 'carol@s.whatsapp.net');

    const deleted = cleanupOldRateLimits(db);
    expect(deleted).toBe(2);

    // Recent row must survive
    expect(getResponseCount(db, 'carol@s.whatsapp.net', 60_000)).toBe(1);
  });
});
