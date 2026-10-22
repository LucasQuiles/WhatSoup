/**
 * A10 — every supported scheduled-message writer refuses a payload the
 * scheduler could never send, BEFORE a row exists (or before an existing row
 * changes), and still accepts every valid form.
 *
 * Writers exercised here through their public entry points:
 *   - enqueueScheduledMessage (the only INSERT; shared by MCP schedule_message,
 *     HTTP POST /schedule and the fleet POST proxy)
 *   - MCP schedule_message
 *   - MCP update_scheduled (the only payload UPDATE; also behind the fleet PUT proxy)
 * HTTP POST /schedule is covered in health-schedule.test.ts, which owns that harness.
 *
 * Real SQLite (in-memory node:sqlite through Database), real files on disk.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from '../../src/core/database.ts';
import { enqueueScheduledMessage } from '../../src/core/schedule-enqueue.ts';
import { registerSchedulingTools } from '../../src/mcp/tools/scheduling.ts';
import type { SessionContext } from '../../src/mcp/types.ts';
import { ToolRegistry } from '../helpers/resolved-tool-registry.ts';

const CHAT = 'fixture-schedule@g.us';
const NOW = 1_800_000_000;
const FUTURE = 4_000_000_000;

type Row = { id: number; content_type: string; payload: string; scheduled_at: number; status: string; media_blob: Uint8Array | null };

function makeDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

function rows(db: Database): Row[] {
  return db.raw.prepare('SELECT id, content_type, payload, scheduled_at, status, media_blob FROM scheduled_messages ORDER BY id').all() as Row[];
}

/** One real file per media type, named so extension inference picks that type. */
const MEDIA_FILES: Array<{ type: string; name: string }> = [
  { type: 'image', name: 'a.png' },
  { type: 'video', name: 'a.mp4' },
  { type: 'audio', name: 'a.ogg' },
  { type: 'document', name: 'a.pdf' },
  { type: 'sticker', name: 'a.webp' },
];

describe('A10 writers: enqueueScheduledMessage', () => {
  let db: Database;
  let root: string;

  beforeEach(() => {
    db = makeDb();
    root = realpathSync(mkdtempSync(join(tmpdir(), 'a10-writers-')));
  });
  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  for (const { type, name } of MEDIA_FILES) {
    it(`refuses an empty ${type} file (missing_media) and inserts nothing`, () => {
      const file = join(root, name);
      writeFileSync(file, Buffer.alloc(0));
      expect(() => enqueueScheduledMessage(db, { chatJid: CHAT, scheduled_at: NOW + 60, filePath: file }, { allowedRoot: root, now: NOW }))
        .toThrow(/payload_undecodable shape=missing_media/);
      expect(rows(db)).toEqual([]);
    });

    it(`accepts a non-empty ${type} file and stores a ${type} row with its bytes`, () => {
      const file = join(root, name);
      writeFileSync(file, Buffer.from('bytes'));
      const r = enqueueScheduledMessage(db, { chatJid: CHAT, scheduled_at: NOW + 60, filePath: file, caption: 'c' }, { allowedRoot: root, now: NOW });
      expect(r.contentType).toBe(type);
      const [row] = rows(db);
      expect(row!.content_type).toBe(type);
      expect(JSON.parse(row!.payload).type).toBe(type);
      expect(Buffer.from(row!.media_blob!).toString()).toBe('bytes');
    });
  }

  it('accepts a text message', () => {
    enqueueScheduledMessage(db, { chatJid: CHAT, scheduled_at: NOW + 60, text: 'hi' }, { allowedRoot: root, now: NOW });
    const [row] = rows(db);
    expect(JSON.parse(row!.payload)).toEqual({ text: 'hi' });
  });
});

describe('A10 writers: MCP schedule_message and update_scheduled', () => {
  let db: Database;
  let root: string;
  let registry: ToolRegistry;
  const session = (): SessionContext => ({ tier: 'global', allowedRoot: root });

  beforeEach(() => {
    db = makeDb();
    root = realpathSync(mkdtempSync(join(tmpdir(), 'a10-mcp-')));
    registry = new ToolRegistry();
    registerSchedulingTools(registry, { db });
  });
  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  function insertRaw(contentType: string, payload: string, mediaBlob: Uint8Array | null = null): number {
    return Number(db.raw.prepare(
      `INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, status, media_blob)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
    ).run(CHAT, contentType, payload, FUTURE, mediaBlob).lastInsertRowid);
  }

  it('schedule_message refuses an empty media file and inserts nothing', async () => {
    const file = join(root, 'empty.png');
    writeFileSync(file, Buffer.alloc(0));
    const result = await registry.call('schedule_message', { chatJid: CHAT, scheduled_at: FUTURE, filePath: file }, session());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/payload_undecodable shape=missing_media/);
    expect(rows(db)).toEqual([]);
  });

  it('schedule_message accepts a valid text message', async () => {
    const result = await registry.call('schedule_message', { chatJid: CHAT, scheduled_at: FUTURE, text: 'hi' }, session());
    expect(result.isError).toBeUndefined();
    expect(rows(db)).toHaveLength(1);
  });

  it('update_scheduled refuses empty text and leaves the row unchanged', async () => {
    const id = insertRaw('text', JSON.stringify({ text: 'original' }));
    const before = rows(db);
    const result = await registry.call('update_scheduled', { id, text: '' }, session());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/payload_undecodable shape=wrong_shape/);
    expect(rows(db)).toEqual(before);
  });

  // An update that touches only the time would re-arm a row the scheduler can
  // never send. The effective post-update row is what gets validated.
  for (const [label, contentType, payload] of [
    ['plain text (not_json)', 'text', 'Reminder: call the office on Friday'],
    ['a JSON primitive', 'text', '"hello"'],
    ['JSON null', 'text', 'null'],
    ['a JSON array', 'text', '["hello"]'],
    ['a wrong shape', 'text', '{"message":"hi"}'],
    ['media with no bytes', 'image', '{"type":"image","mimetype":"image/png"}'],
  ] as const) {
    it(`update_scheduled refuses a time-only update on a row holding ${label} and leaves it unchanged`, async () => {
      const id = insertRaw(contentType, payload);
      const before = rows(db);
      const result = await registry.call('update_scheduled', { id, scheduled_at: FUTURE + 60 }, session());
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/payload_undecodable shape=/);
      expect(rows(db)).toEqual(before);
    });
  }

  it('update_scheduled replacing the text of an invalid row with valid text is accepted', async () => {
    const id = insertRaw('text', 'null');
    const result = await registry.call('update_scheduled', { id, text: 'fixed' }, session());
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(rows(db)[0]!.payload)).toEqual({ text: 'fixed' });
  });

  it('update_scheduled on a valid media row changing only the time is accepted', async () => {
    const id = insertRaw('image', JSON.stringify({ type: 'image', mimetype: 'image/png' }), new Uint8Array([1]));
    const result = await registry.call('update_scheduled', { id, scheduled_at: FUTURE + 60 }, session());
    expect(result.isError).toBeUndefined();
    expect(rows(db)[0]!.scheduled_at).toBe(FUTURE + 60);
  });
});
