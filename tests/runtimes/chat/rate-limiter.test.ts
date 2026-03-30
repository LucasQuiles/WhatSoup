import { describe, it, expect, beforeEach } from 'vitest';
import { Database } from '../../../src/core/database.ts';
import { ensureChatSchema } from '../../../src/runtimes/chat/runtime.ts';
import { recordResponse } from '../../../src/runtimes/chat/rate-limits-db.ts';
import { checkRateLimit } from '../../../src/runtimes/chat/rate-limiter.ts';
import { config } from '../../../src/config.ts';

// Helper: open a fresh in-memory database for each test
function openDb(): Database {
  const db = new Database(':memory:');
  db.open();
  ensureChatSchema(db);
  return db;
}

describe('checkRateLimit', () => {
  let db: Database;

  beforeEach(() => {
    db = openDb();
  });

  // --- Positive: under the limit ---

  it('returns allowed=true and remaining=45 when there are 0 responses', () => {
    const result = checkRateLimit(db, 'alice@s.whatsapp.net');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(45);
  });

  it('returns allowed=true and remaining=1 after 44 responses', () => {
    const sender = 'alice@s.whatsapp.net';
    for (let i = 0; i < 44; i++) {
      recordResponse(db, sender);
    }
    const result = checkRateLimit(db, sender);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(1);
  });

  it('counts responses inserted at the window boundary (just inside)', () => {
    // Insert a row timestamped exactly at the boundary (1 second inside window)
    const sender = 'boundary@s.whatsapp.net';
    const windowSec = config.rateLimitNoticeWindowMs / 1000;
    // datetime('now', '-X seconds') is the cutoff; inserting at '-X+1 seconds' is inside
    db.raw
      .prepare(
        `INSERT INTO rate_limits (sender_jid, response_at)
         VALUES (@sender_jid, datetime('now', @offset))`,
      )
      .run({ sender_jid: sender, offset: `-${windowSec - 1} seconds` });

    const result = checkRateLimit(db, sender);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(44);
  });

  it('does NOT count responses outside the window', () => {
    const sender = 'outside@s.whatsapp.net';
    const windowSec = config.rateLimitNoticeWindowMs / 1000;
    // Insert a row 1 second OLDER than the window cutoff
    db.raw
      .prepare(
        `INSERT INTO rate_limits (sender_jid, response_at)
         VALUES (@sender_jid, datetime('now', @offset))`,
      )
      .run({ sender_jid: sender, offset: `-${windowSec + 1} seconds` });

    const result = checkRateLimit(db, sender);
    // The stale row must not be counted
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(45);
  });

  // --- Negative: at or over the limit ---

  it('returns allowed=false and remaining=0 after exactly 45 responses', () => {
    const sender = 'alice@s.whatsapp.net';
    for (let i = 0; i < 45; i++) {
      recordResponse(db, sender);
    }
    const result = checkRateLimit(db, sender);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('returns allowed=false after 46 responses (remaining stays 0, not negative)', () => {
    const sender = 'alice@s.whatsapp.net';
    for (let i = 0; i < 46; i++) {
      recordResponse(db, sender);
    }
    const result = checkRateLimit(db, sender);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('different senders do not interfere with each other', () => {
    const senderA = 'alice@s.whatsapp.net';
    const senderB = 'bob@s.whatsapp.net';

    // Exhaust A's limit
    for (let i = 0; i < 45; i++) {
      recordResponse(db, senderA);
    }

    const resultA = checkRateLimit(db, senderA);
    const resultB = checkRateLimit(db, senderB);

    expect(resultA.allowed).toBe(false);
    expect(resultA.remaining).toBe(0);
    expect(resultB.allowed).toBe(true);
    expect(resultB.remaining).toBe(45);
  });

  it('counter persists when a new checkRateLimit call is made (no in-memory state reset)', () => {
    const sender = 'persistent@s.whatsapp.net';
    for (let i = 0; i < 45; i++) {
      recordResponse(db, sender);
    }

    // Simulate "new instance" by calling checkRateLimit again with the same DB
    // The function is stateless; state lives in SQLite, so re-calling it must
    // reflect the same count.
    const first = checkRateLimit(db, sender);
    const second = checkRateLimit(db, sender);

    expect(first.allowed).toBe(false);
    expect(second.allowed).toBe(false);
    expect(second.remaining).toBe(0);
  });

  it('remaining is always >= 0 even when count greatly exceeds limit', () => {
    const sender = 'spam@s.whatsapp.net';
    for (let i = 0; i < 100; i++) {
      recordResponse(db, sender);
    }
    const result = checkRateLimit(db, sender);
    expect(result.remaining).toBeGreaterThanOrEqual(0);
  });

  it('remaining counts down correctly across multiple calls', () => {
    const sender = 'countdown@s.whatsapp.net';
    for (let i = 0; i < 40; i++) {
      recordResponse(db, sender);
    }
    expect(checkRateLimit(db, sender).remaining).toBe(5);

    recordResponse(db, sender);
    expect(checkRateLimit(db, sender).remaining).toBe(4);

    recordResponse(db, sender);
    expect(checkRateLimit(db, sender).remaining).toBe(3);
  });

  it('sender JIDs with special characters are handled correctly', () => {
    const sender = '1234567890@s.whatsapp.net';
    for (let i = 0; i < 10; i++) {
      recordResponse(db, sender);
    }
    const result = checkRateLimit(db, sender);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(35);
  });

  it('a fresh sender on a shared DB with other exhausted senders gets full quota', () => {
    const exhausted = 'exhausted@s.whatsapp.net';
    const fresh = 'fresh@s.whatsapp.net';

    for (let i = 0; i < 45; i++) {
      recordResponse(db, exhausted);
    }

    const result = checkRateLimit(db, fresh);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(45);
  });

  it('the config limit constant (45) matches expected rateLimitPerHour value', () => {
    // Verify that our tests are aligned with the actual config
    expect(config.rateLimitPerHour).toBe(45);
  });
});
