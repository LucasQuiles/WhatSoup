/**
 * A10 — execution-side payload validation.
 *
 * A row can reach scheduled_messages without passing a writer: a raw SQL insert,
 * a restored backup, or a release that predates the validator. The scheduler is
 * the last gate, so it applies the same shared contract before the transport:
 *   - valid JSON that is the wrong shape is never sent, not merely "not JSON";
 *   - the row ends `failed` with `payload_undecodable shape=<class>` on the FIRST
 *     tick and never re-enters the due query (no retry ladder, no recurrence
 *     advance);
 *   - the payload column is left byte-identical, so the row stays truthful;
 *   - legacy media rows (JSON Buffer forms, no media_blob) still send real bytes.
 *
 * Real SQLite (in-memory node:sqlite through Database).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/logger.ts', async () => {
  const { loggerMock } = await import('../helpers/logger-mock.ts');
  return loggerMock();
});

import { Database } from '../../src/core/database.ts';
import { MessageScheduler } from '../../src/core/scheduler.ts';
import type { ConnectionManager } from '../../src/transport/connection.ts';

const CHAT = '123@g.us';

type Row = {
  status: string;
  retry_count: number;
  error: string | null;
  payload: string;
  next_run_at: number | null;
  run_count: number;
};

function makeDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

function mockConnection() {
  const sendRaw = vi.fn().mockResolvedValue({ waMessageId: 'r1' });
  const sendMedia = vi.fn().mockResolvedValue({ waMessageId: 'm1' });
  return { conn: { sendRaw, sendMedia } as unknown as ConnectionManager, sendRaw, sendMedia };
}

describe('A10 execution: invalid rows are dead-lettered with a shape class', () => {
  let db: Database;
  let scheduler: MessageScheduler;
  let sendRaw: ReturnType<typeof vi.fn>;
  let sendMedia: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = makeDb();
    const m = mockConnection();
    sendRaw = m.sendRaw;
    sendMedia = m.sendMedia;
    scheduler = new MessageScheduler(db, m.conn, { intervalMs: 60_000, maxRetries: 3 });
  });

  afterEach(() => {
    db.close();
  });

  function insert(opts: {
    contentType: string;
    payload: string;
    mediaBlob?: Uint8Array | null;
    recurrence?: string | null;
    timezone?: string | null;
  }): number {
    const now = Math.floor(Date.now() / 1000);
    return Number(db.raw.prepare(
      `INSERT INTO scheduled_messages
         (chat_jid, content_type, payload, scheduled_at, recurrence, timezone, next_run_at, status, retry_count, media_blob)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
    ).run(
      CHAT,
      opts.contentType,
      opts.payload,
      now - 120,
      opts.recurrence ?? null,
      opts.timezone ?? null,
      opts.recurrence ? now - 60 : null,
      opts.mediaBlob ?? null,
    ).lastInsertRowid);
  }

  function readRow(id: number): Row {
    return db.raw
      .prepare('SELECT status, retry_count, error, payload, next_run_at, run_count FROM scheduled_messages WHERE id = ?')
      .get(id) as Row;
  }

  const BLOB = new Uint8Array([1, 2, 3]);

  const INVALID: Array<{ label: string; shape: string; contentType: string; payload: string; mediaBlob?: Uint8Array | null }> = [
    { label: 'plain text in a text row', shape: 'not_json', contentType: 'text', payload: 'Remember the meeting moved to Friday.' },
    { label: 'JSON null', shape: 'json_null', contentType: 'text', payload: 'null' },
    { label: 'a JSON string', shape: 'json_primitive', contentType: 'text', payload: '"hello"' },
    { label: 'a JSON number', shape: 'json_primitive', contentType: 'text', payload: '42' },
    { label: 'a JSON boolean', shape: 'json_primitive', contentType: 'text', payload: 'true' },
    { label: 'a JSON array', shape: 'json_array', contentType: 'text', payload: '["hello"]' },
    { label: 'an empty object in a text row', shape: 'wrong_shape', contentType: 'text', payload: '{}' },
    { label: 'a text row with a non-string text', shape: 'wrong_shape', contentType: 'text', payload: '{"text":5}' },
    { label: 'a text row with an extra transport key', shape: 'wrong_shape', contentType: 'text', payload: '{"text":"hi","delete":{"id":"x"}}' },
    { label: 'an unknown content_type', shape: 'unknown_content_type', contentType: 'poll', payload: '{"type":"poll"}', mediaBlob: BLOB },
    { label: 'a payload type that disagrees with content_type', shape: 'type_mismatch', contentType: 'image', payload: '{"type":"video","mimetype":"video/mp4"}', mediaBlob: BLOB },
    { label: 'a media row with no bytes anywhere', shape: 'missing_media', contentType: 'video', payload: '{"type":"video","mimetype":"video/mp4"}' },
    { label: 'a legacy buffer with an out-of-range byte', shape: 'invalid_legacy_buffer', contentType: 'image', payload: '{"type":"image","buffer":[1,256]}' },
    { label: 'a media row with an array payload', shape: 'json_array', contentType: 'sticker', payload: '[]', mediaBlob: BLOB },
    { label: 'a document row missing its filename', shape: 'wrong_shape', contentType: 'document', payload: '{"type":"document","mimetype":"application/pdf"}', mediaBlob: BLOB },
    { label: 'an audio row with a string seconds', shape: 'wrong_shape', contentType: 'audio', payload: '{"type":"audio","mimetype":"audio/ogg","seconds":"3"}', mediaBlob: BLOB },
  ];

  for (const c of INVALID) {
    it(`${c.label}: failed on the first tick as ${c.shape}, never sent, never retried, payload untouched`, async () => {
      const id = insert({ contentType: c.contentType, payload: c.payload, mediaBlob: c.mediaBlob ?? null });

      await scheduler.tick();
      const first = readRow(id);
      expect(first.status).toBe('failed');
      expect(first.error).toContain(`payload_undecodable shape=${c.shape}`);
      expect(first.retry_count).toBe(0);
      expect(first.payload).toBe(c.payload);

      // A second tick must not select the row again.
      await scheduler.tick();
      expect(readRow(id)).toEqual(first);
      expect(sendRaw).not.toHaveBeenCalled();
      expect(sendMedia).not.toHaveBeenCalled();
    });
  }

  it('a row shaped like the ml-bot row 40 incident (plain text, timezone, no recurrence) is dead-lettered as not_json', async () => {
    const payload = 'x'.repeat(201);
    const id = insert({ contentType: 'text', payload, timezone: 'America/New_York' });

    await scheduler.tick();

    const row = readRow(id);
    expect(row.status).toBe('failed');
    expect(row.error).toContain('payload_undecodable shape=not_json');
    expect(row.payload).toBe(payload);
    expect(sendRaw).not.toHaveBeenCalled();
  });

  it('a RECURRING row with a valid-JSON wrong shape is failed, not advanced to re-fail forever', async () => {
    const id = insert({ contentType: 'text', payload: 'null', recurrence: '0 9 * * *' });
    const before = readRow(id);

    await scheduler.tick();

    const row = readRow(id);
    expect(row.status).toBe('failed');
    expect(row.error).toContain('payload_undecodable shape=json_null');
    expect(row.next_run_at).toBe(before.next_run_at);
    expect(row.run_count).toBe(0);
    expect(sendRaw).not.toHaveBeenCalled();
  });

  it('a RECURRING media row with no bytes is failed rather than skipped forward each occurrence', async () => {
    const id = insert({ contentType: 'image', payload: '{"type":"image","mimetype":"image/png"}', recurrence: '0 9 * * *' });

    await scheduler.tick();

    expect(readRow(id).status).toBe('failed');
    expect(readRow(id).error).toContain('payload_undecodable shape=missing_media');
    expect(sendMedia).not.toHaveBeenCalled();
  });
});

describe('A10 execution: valid and legacy rows still send', () => {
  let db: Database;
  let scheduler: MessageScheduler;
  let sendRaw: ReturnType<typeof vi.fn>;
  let sendMedia: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = makeDb();
    const m = mockConnection();
    sendRaw = m.sendRaw;
    sendMedia = m.sendMedia;
    scheduler = new MessageScheduler(db, m.conn, { intervalMs: 60_000, maxRetries: 3 });
  });

  afterEach(() => {
    db.close();
  });

  function insert(contentType: string, payload: string, mediaBlob: Uint8Array | null): number {
    return Number(db.raw.prepare(
      `INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, status, retry_count, media_blob)
       VALUES (?, ?, ?, ?, 'pending', 0, ?)`,
    ).run(CHAT, contentType, payload, Math.floor(Date.now() / 1000) - 10, mediaBlob).lastInsertRowid);
  }

  function status(id: number): string {
    return (db.raw.prepare('SELECT status FROM scheduled_messages WHERE id = ?').get(id) as { status: string }).status;
  }

  it('sends a text row as exactly { text }', async () => {
    const id = insert('text', '{"text":"hello"}', null);
    await scheduler.tick();
    expect(sendRaw).toHaveBeenCalledWith(CHAT, { text: 'hello' });
    expect(status(id)).toBe('sent');
  });

  const MEDIA: Array<[string, Record<string, unknown>]> = [
    ['image', { type: 'image', caption: 'c', mimetype: 'image/png', viewOnce: true }],
    ['video', { type: 'video', caption: 'c', mimetype: 'video/mp4', ptv: false, gifPlayback: true }],
    ['audio', { type: 'audio', mimetype: 'audio/ogg; codecs=opus', ptt: true, seconds: 4 }],
    ['document', { type: 'document', filename: 'a.pdf', mimetype: 'application/pdf', caption: 'c' }],
    ['sticker', { type: 'sticker', mimetype: 'image/webp', isAnimated: false }],
  ];

  for (const [type, payload] of MEDIA) {
    it(`sends a ${type} row from media_blob with exactly its stored fields`, async () => {
      const id = insert(type, JSON.stringify(payload), new Uint8Array([7, 7]));
      await scheduler.tick();
      expect(sendMedia).toHaveBeenCalledTimes(1);
      const [jid, media] = sendMedia.mock.calls[0] as [string, Record<string, unknown>];
      expect(jid).toBe(CHAT);
      const { buffer, ...fields } = media;
      expect(Buffer.isBuffer(buffer)).toBe(true);
      expect([...(buffer as Buffer)]).toEqual([7, 7]);
      expect(fields).toEqual(payload);
      expect(status(id)).toBe('sent');
    });
  }

  it('legacy { type: "Buffer", data } row with no media_blob sends a real Buffer of those bytes', async () => {
    const id = insert('image', JSON.stringify({ type: 'image', caption: 'legacy', buffer: { type: 'Buffer', data: [104, 105] } }), null);
    await scheduler.tick();
    expect(sendMedia).toHaveBeenCalledTimes(1);
    const media = sendMedia.mock.calls[0]![1] as Record<string, unknown>;
    expect(Buffer.isBuffer(media['buffer'])).toBe(true);
    expect([...(media['buffer'] as Buffer)]).toEqual([104, 105]);
    expect(media['caption']).toBe('legacy');
    expect(status(id)).toBe('sent');
  });

  it('legacy bare number[] row with no media_blob sends a real Buffer of those bytes', async () => {
    const id = insert('document', JSON.stringify({ type: 'document', filename: 'd.bin', mimetype: 'application/octet-stream', buffer: [65, 66, 67] }), null);
    await scheduler.tick();
    const media = sendMedia.mock.calls[0]![1] as Record<string, unknown>;
    expect(Buffer.isBuffer(media['buffer'])).toBe(true);
    expect([...(media['buffer'] as Buffer)]).toEqual([65, 66, 67]);
    expect(media['filename']).toBe('d.bin');
    expect(status(id)).toBe('sent');
  });
});
