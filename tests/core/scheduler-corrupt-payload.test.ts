/**
 * #2359 finding 1 — an undecodable scheduled payload is permanent, not transient.
 *
 * Before this, `executeSend` parsed `row.payload` bare. The throw was caught by
 * the tick loop and routed into `handleSendFailure`, which could not tell a
 * corrupt row from a bad minute on the transport: the message burned the whole
 * retry budget failing identically each time, then dropped with a generic
 * error. A recurring row was worse — it advanced to the next slot and re-failed
 * forever, because the corrupt bytes travel with the row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSchedulerLog = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => mockSchedulerLog,
}));

import { Database } from '../../src/core/database.ts';
import { MessageScheduler, ScheduledPayloadError } from '../../src/core/scheduler.ts';
import type { ConnectionManager } from '../../src/transport/connection.ts';

function makeDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

function mockConnection(): ConnectionManager {
  return {
    sendRaw: vi.fn().mockResolvedValue({ key: { id: 'msg1' } }),
    sendMedia: vi.fn().mockResolvedValue({ key: { id: 'msg2' } }),
  } as unknown as ConnectionManager;
}

type Row = { status: string; retry_count: number; error: string | null; next_run_at: number | null };

function readRow(db: Database): Row {
  return db.raw
    .prepare('SELECT status, retry_count, error, next_run_at FROM scheduled_messages WHERE id = 1')
    .get() as Row;
}

describe('scheduler: undecodable payload is dead-lettered (#2359)', () => {
  let db: Database;
  let conn: ConnectionManager;
  let scheduler: MessageScheduler;

  beforeEach(() => {
    db = makeDb();
    conn = mockConnection();
    scheduler = new MessageScheduler(db, conn, { intervalMs: 60_000, maxRetries: 3 });
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  function insert(payload: string, recurrence: string | null, retryCount = 0): number {
    const now = Math.floor(Date.now() / 1000);
    db.raw.prepare(
      `INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, recurrence, next_run_at, status, retry_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('123@s.whatsapp.net', 'text', payload, now - 120, recurrence, now - 60, 'pending', retryCount);
    return now;
  }

  it('fails a one-shot row on the FIRST tick without consuming the retry budget', async () => {
    insert('{not valid json', null);

    await scheduler.tick();

    const row = readRow(db);
    expect(row.status).toBe('failed');
    // The budget is untouched: the pre-fix path would have incremented toward
    // maxRetries and left the row pending for two more pointless attempts.
    expect(row.retry_count).toBe(0);
    // The transport is never reached — nothing is sent for a row that cannot be decoded.
    expect(conn.sendRaw).not.toHaveBeenCalled();
  });

  it('names the payload as the cause rather than a generic send error', async () => {
    insert('{not valid json', null);

    await scheduler.tick();

    expect(readRow(db).error).toMatch(/payload is not decodable/i);
  });

  it('fails a RECURRING row instead of advancing it to re-fail forever', async () => {
    const now = insert('{not valid json', '0 9 * * *');

    await scheduler.tick();

    const row = readRow(db);
    // The recurrence-preservation path is deliberately bypassed here: it exists
    // to protect a schedule from TRANSIENT per-occurrence failures, and a
    // corrupt payload is a property of the row that every future occurrence
    // would hit identically.
    expect(row.status).toBe('failed');
    expect(row.next_run_at ?? 0).toBeLessThanOrEqual(now);
  });

  // The discriminating case. Without it, "mark every failure permanent" passes
  // every test above while destroying the retry ladder for real outages.
  it('still RETRIES an ordinary transport failure — the dead-letter is payload-specific', async () => {
    insert('{"text":"fine"}', null);
    (conn.sendRaw as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('transient outage'));

    await scheduler.tick();

    const row = readRow(db);
    expect(row.status).toBe('pending');
    expect(row.retry_count).toBe(1);
  });

  it('exposes a distinguishable error type rather than a bare Error', () => {
    const err = new ScheduledPayloadError('Unexpected token');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ScheduledPayloadError');
    expect(err.message).toMatch(/not decodable/i);
  });
});
