/**
 * Direct unit coverage for src/core/substrate/events.ts.
 *
 * Single exported helper `writeBeadEvent(db, args)` inserts an audit-log row
 * into `bead_events` and returns the new row's id. No test mirror existed.
 *
 * Setup mirrors the existing substrate test pattern (tmp-file SQLite +
 * Database.open() + afterEach unlink) and creates a parent bead row to
 * satisfy the bead_events.bead_id FK.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { unlinkSync, existsSync } from 'node:fs';
import { Database } from '../../../src/core/database.ts';
import { writeBeadEvent } from '../../../src/core/substrate/events.ts';

function tmpFile(): string {
  return join(tmpdir(), `whatsoup-events-${randomBytes(8).toString('hex')}.db`);
}

function insertParentBead(db: Database, opts: Partial<{ title: string; owner: string }> = {}): number {
  const now = Math.floor(Date.now() / 1000);
  const info = db.raw
    .prepare(
      `INSERT INTO beads (kind, title, owner_jid, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run('task', opts.title ?? 'parent', opts.owner ?? '15551234567@s.whatsapp.net', now, now);
  return Number(info.lastInsertRowid);
}

describe('writeBeadEvent', () => {
  let path: string;
  let db: Database;
  beforeEach(() => {
    path = tmpFile();
    db = new Database(path);
    db.open();
  });
  afterEach(() => {
    db.close();
    if (existsSync(path)) unlinkSync(path);
  });

  it('inserts a row with the supplied bead_id + event_type + actor and returns its id', () => {
    const beadId = insertParentBead(db);
    const rowId = writeBeadEvent(db.raw, {
      beadId,
      eventType: 'proposed',
      actor: 'sweep',
    });
    expect(typeof rowId).toBe('number');
    expect(rowId).toBeGreaterThan(0);

    const row = db.raw
      .prepare('SELECT bead_id, event_type, actor FROM bead_events WHERE id = ?')
      .get(rowId) as { bead_id: number; event_type: string; actor: string };
    expect(row.bead_id).toBe(beadId);
    expect(row.event_type).toBe('proposed');
    expect(row.actor).toBe('sweep');
  });

  it('serializes the payload as JSON, defaulting to an empty object', () => {
    const beadId = insertParentBead(db);
    const noPayloadId = writeBeadEvent(db.raw, {
      beadId,
      eventType: 'noted',
      actor: 'tester',
    });
    const withPayloadId = writeBeadEvent(db.raw, {
      beadId,
      eventType: 'tagged',
      actor: 'tester',
      payload: { tag: 'urgent', priority: 2 },
    });

    const noPayloadJson = db.raw
      .prepare('SELECT payload_json FROM bead_events WHERE id = ?')
      .get(noPayloadId) as { payload_json: string };
    const withPayloadJson = db.raw
      .prepare('SELECT payload_json FROM bead_events WHERE id = ?')
      .get(withPayloadId) as { payload_json: string };

    expect(JSON.parse(noPayloadJson.payload_json)).toEqual({});
    expect(JSON.parse(withPayloadJson.payload_json)).toEqual({ tag: 'urgent', priority: 2 });
  });

  it('writes source_message_pk when provided and null otherwise', () => {
    const beadId = insertParentBead(db);
    const withSourceId = writeBeadEvent(db.raw, {
      beadId,
      eventType: 'noted',
      actor: 'tester',
      sourceMessagePk: 12345,
    });
    const withoutSourceId = writeBeadEvent(db.raw, {
      beadId,
      eventType: 'noted',
      actor: 'tester',
    });

    const withSource = db.raw
      .prepare('SELECT source_message_pk FROM bead_events WHERE id = ?')
      .get(withSourceId) as { source_message_pk: number | null };
    const withoutSource = db.raw
      .prepare('SELECT source_message_pk FROM bead_events WHERE id = ?')
      .get(withoutSourceId) as { source_message_pk: number | null };

    expect(withSource.source_message_pk).toBe(12345);
    expect(withoutSource.source_message_pk).toBeNull();
    // Verify NULL via SQL semantics, not just JS null: an `IS NULL` filter
    // should match exactly the no-source row.
    const nullCount = db.raw
      .prepare('SELECT COUNT(*) AS c FROM bead_events WHERE source_message_pk IS NULL')
      .get() as { c: number };
    expect(nullCount.c).toBe(1);
  });

  it('honors a caller-supplied `at` timestamp', () => {
    const beadId = insertParentBead(db);
    const customAt = 1_700_000_000;
    const rowId = writeBeadEvent(db.raw, {
      beadId,
      eventType: 'backdated',
      actor: 'tester',
      at: customAt,
    });
    const row = db.raw
      .prepare('SELECT created_at FROM bead_events WHERE id = ?')
      .get(rowId) as { created_at: number };
    expect(row.created_at).toBe(customAt);
  });

  it('defaults `at` to the current unix-seconds value when not provided', () => {
    const beadId = insertParentBead(db);
    const before = Math.floor(Date.now() / 1000);
    const rowId = writeBeadEvent(db.raw, {
      beadId,
      eventType: 'proposed',
      actor: 'tester',
    });
    const after = Math.floor(Date.now() / 1000);
    const row = db.raw
      .prepare('SELECT created_at FROM bead_events WHERE id = ?')
      .get(rowId) as { created_at: number };
    // Inserted at should be within [before, after] window
    expect(row.created_at).toBeGreaterThanOrEqual(before);
    expect(row.created_at).toBeLessThanOrEqual(after);
  });

  it('explicit null sourceMessagePk is stored as NULL (matches the absent case)', () => {
    const beadId = insertParentBead(db);
    const rowId = writeBeadEvent(db.raw, {
      beadId,
      eventType: 'noted',
      actor: 'tester',
      sourceMessagePk: null,
    });
    const row = db.raw
      .prepare('SELECT source_message_pk FROM bead_events WHERE id = ?')
      .get(rowId) as { source_message_pk: number | null };
    expect(row.source_message_pk).toBeNull();
  });

  it('returns monotonically-increasing ids for successive inserts', () => {
    const beadId = insertParentBead(db);
    const id1 = writeBeadEvent(db.raw, { beadId, eventType: 'a', actor: 'tester' });
    const id2 = writeBeadEvent(db.raw, { beadId, eventType: 'b', actor: 'tester' });
    const id3 = writeBeadEvent(db.raw, { beadId, eventType: 'c', actor: 'tester' });
    expect(id2).toBeGreaterThan(id1);
    expect(id3).toBeGreaterThan(id2);
  });
});
