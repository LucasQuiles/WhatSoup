/**
 * Tests for the shared schedule-enqueue helper (Sprint 5E-0).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from '../../src/core/database.ts';
import { enqueueScheduledMessage } from '../../src/core/schedule-enqueue.ts';

function makeDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

interface Row {
  chat_jid: string; chat_name: string | null; content_type: string; payload: string;
  scheduled_at: number; recurrence: string | null; timezone: string | null;
  next_run_at: number | null; status: string; media_blob: Uint8Array | null;
}

function getRow(db: Database, id: number): Row | undefined {
  return db.raw.prepare('SELECT * FROM scheduled_messages WHERE id = ?').get(id) as Row | undefined;
}

function countRows(db: Database): number {
  return (db.raw.prepare('SELECT COUNT(*) AS n FROM scheduled_messages').get() as { n: number }).n;
}

const CHAT = 'fixture-schedule@g.us';
const NOW = 1_800_000_000;

describe('enqueueScheduledMessage', () => {
  let db: Database;
  let root: string;

  beforeEach(() => {
    db = makeDb();
    root = realpathSync(mkdtempSync(join(tmpdir(), 'sched-')));
  });
  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('enqueues a text message as pending with no media_blob', () => {
    const r = enqueueScheduledMessage(db, { chatJid: CHAT, scheduled_at: NOW + 10, text: 'hi' }, { allowedRoot: root, now: NOW });
    expect(r.status).toBe('pending');
    expect(r.contentType).toBe('text');
    const row = getRow(db, r.id)!;
    expect(row.content_type).toBe('text');
    expect(row.media_blob).toBeNull();
    expect(JSON.parse(row.payload)).toEqual({ text: 'hi' });
    expect(row.scheduled_at).toBe(NOW + 10);
  });

  it('enqueues a document with media_blob and filename/mimetype payload', () => {
    const pdf = join(root, 'issue.pdf');
    writeFileSync(pdf, Buffer.from('%PDF-1.4 test'));
    const r = enqueueScheduledMessage(db, { chatJid: CHAT, scheduled_at: NOW + 10, filePath: pdf, caption: 'synopsis' }, { allowedRoot: root, now: NOW });
    expect(r.contentType).toBe('document');
    const row = getRow(db, r.id)!;
    expect(row.media_blob).not.toBeNull();
    const payload = JSON.parse(row.payload);
    expect(payload.type).toBe('document');
    expect(payload.filename).toBe('issue.pdf');
    expect(payload.caption).toBe('synopsis');
  });

  it('rejects a filePath outside allowedRoot and inserts nothing', () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'other-')));
    const pdf = join(outside, 'x.pdf');
    writeFileSync(pdf, Buffer.from('%PDF-1.4'));
    expect(() => enqueueScheduledMessage(db, { chatJid: CHAT, scheduled_at: NOW + 10, filePath: pdf }, { allowedRoot: root, now: NOW }))
      .toThrow(/Path outside workspace/);
    expect(countRows(db)).toBe(0);
    rmSync(outside, { recursive: true, force: true });
  });

  it('rejects an unsupported file extension and inserts nothing', () => {
    const bad = join(root, 'notes.xyz');
    writeFileSync(bad, Buffer.from('data'));
    expect(() => enqueueScheduledMessage(db, { chatJid: CHAT, scheduled_at: NOW + 10, filePath: bad }, { allowedRoot: root, now: NOW }))
      .toThrow(/Unsupported file extension/);
    expect(countRows(db)).toBe(0);
  });

  it('rejects scheduled_at <= now with the exact MCP error message and inserts nothing', () => {
    expect(() => enqueueScheduledMessage(db, { chatJid: CHAT, scheduled_at: NOW, text: 'hi' }, { allowedRoot: root, now: NOW }))
      .toThrow('scheduled_at must be a future UTC unix timestamp');
    expect(countRows(db)).toBe(0);
  });

  it('sets next_run_at = scheduled_at for a recurring message', () => {
    const r = enqueueScheduledMessage(db, { chatJid: CHAT, scheduled_at: NOW + 10, text: 'hi', recurrence: '0 9 * * *' }, { allowedRoot: root, now: NOW });
    const row = getRow(db, r.id)!;
    expect(row.next_run_at).toBe(NOW + 10);
    expect(row.recurrence).toBe('0 9 * * *');
  });

  it('fails closed when allowedRoot is undefined and a media filePath is given', () => {
    const pdf = join(root, 'issue.pdf');
    writeFileSync(pdf, Buffer.from('%PDF-1.4'));
    expect(() => enqueueScheduledMessage(db, { chatJid: CHAT, scheduled_at: NOW + 10, filePath: pdf }, { allowedRoot: undefined, now: NOW }))
      .toThrow(/Path outside workspace/);
    expect(countRows(db)).toBe(0);
  });
});
