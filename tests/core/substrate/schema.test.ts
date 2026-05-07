import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { unlinkSync, existsSync } from 'node:fs';
import { Database } from '../../../src/core/database.ts';

function tmpFile(): string {
  return join(tmpdir(), `whatsoup-substrate-${randomBytes(8).toString('hex')}.db`);
}

const SUBSTRATE_TABLES = [
  'beads', 'bead_triggers', 'trigger_runs', 'bead_events',
  'entities', 'entity_aliases', 'entity_observations',
  'bead_entity_refs', 'sweep_runs',
] as const;

describe('substrate schema (MIGRATION_23)', () => {
  let path: string;
  let db: Database;
  beforeEach(() => { path = tmpFile(); db = new Database(path); db.open(); });
  afterEach(() => { db.close(); if (existsSync(path)) unlinkSync(path); });

  it('creates all 9 substrate tables', () => {
    for (const t of SUBSTRATE_TABLES) {
      const row = db.raw
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(t) as { name: string } | undefined;
      expect(row?.name).toBe(t);
    }
  });

  it('is idempotent — re-opening the DB does not throw', () => {
    db.close();
    expect(() => { const d2 = new Database(path); d2.open(); d2.close(); }).not.toThrow();
  });

  it('records schema_migrations version 23', () => {
    const row = db.raw.prepare('SELECT version FROM schema_migrations WHERE version = 23').get() as { version: number } | undefined;
    expect(row?.version).toBe(23);
  });

  it('beads has required indexes', () => {
    const names = (db.raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='beads'").all() as Array<{ name: string }>).map(r => r.name);
    expect(names).toContain('idx_beads_owner_status');
    expect(names).toContain('idx_beads_kind_status');
    expect(names).toContain('idx_beads_status_due');
    expect(names).toContain('idx_beads_source_message_pk');
    expect(names).toContain('idx_beads_chat_jid_updated');
  });

  it('bead_triggers has partial index on active status', () => {
    const row = db.raw.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_triggers_due'").get() as { sql: string } | undefined;
    expect(row?.sql).toMatch(/WHERE status = 'active'/);
  });

  it('entity_observations tombstone columns exist', () => {
    const cols = db.raw.prepare("PRAGMA table_info('entity_observations')").all() as Array<{ name: string }>;
    const names = cols.map(c => c.name);
    expect(names).toContain('forgotten');
    expect(names).toContain('forgotten_reason');
    expect(names).toContain('supersedes_observation_id');
  });

  it('bead_entity_refs role CHECK lists all 7 roles', () => {
    const row = db.raw.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='bead_entity_refs'").get() as { sql: string };
    expect(row.sql).toMatch(/role .*CHECK/);
    for (const role of ['subject','owner','stakeholder','mentioned','source','blocked_by','project']) {
      expect(row.sql).toContain(`'${role}'`);
    }
  });

  it('entity_observations.kind rejects unknown kinds', () => {
    db.raw.prepare("INSERT INTO entities (kind, canonical_name, created_at, updated_at) VALUES ('person', 'X', 1, 1)").run();
    expect(() => db.raw.prepare(
      `INSERT INTO entity_observations (entity_id, kind, text, confidence, source_kind, created_at)
       VALUES (1, 'bogus_kind', 't', 0.5, 'manual', 1)`
    ).run()).toThrow(/CHECK/i);
  });

  it('entity_observations.kind accepts all 7 documented kinds', () => {
    db.raw.prepare("INSERT INTO entities (kind, canonical_name, created_at, updated_at) VALUES ('person', 'X', 1, 1)").run();
    for (const k of ['preference','fact','relation','status','contact_info','note','other']) {
      expect(() => db.raw.prepare(
        `INSERT INTO entity_observations (entity_id, kind, text, confidence, source_kind, created_at)
         VALUES (1, ?, 't', 0.5, 'manual', 1)`
      ).run(k)).not.toThrow();
    }
  });

  it('beads.priority rejects values outside -2..+2', () => {
    expect(() => db.raw.prepare(
      `INSERT INTO beads (kind, title, owner_jid, priority, created_at, updated_at)
       VALUES ('task', 't', 'u', 99, 1, 1)`
    ).run()).toThrow(/CHECK/i);
    expect(() => db.raw.prepare(
      `INSERT INTO beads (kind, title, owner_jid, priority, created_at, updated_at)
       VALUES ('task', 't', 'u', -3, 1, 1)`
    ).run()).toThrow(/CHECK/i);
  });

  it('beads.priority accepts -2..+2', () => {
    for (const p of [-2, -1, 0, 1, 2]) {
      expect(() => db.raw.prepare(
        `INSERT INTO beads (kind, title, owner_jid, priority, created_at, updated_at)
         VALUES ('task', 't', 'u', ?, 1, 1)`
      ).run(p)).not.toThrow();
    }
  });

  it('entity_observations.confidence rejects values outside 0..1', () => {
    db.raw.prepare("INSERT INTO entities (kind, canonical_name, created_at, updated_at) VALUES ('person', 'X', 1, 1)").run();
    expect(() => db.raw.prepare(
      `INSERT INTO entity_observations (entity_id, kind, text, confidence, source_kind, created_at)
       VALUES (1, 'fact', 't', 1.5, 'manual', 1)`
    ).run()).toThrow(/CHECK/i);
    expect(() => db.raw.prepare(
      `INSERT INTO entity_observations (entity_id, kind, text, confidence, source_kind, created_at)
       VALUES (1, 'fact', 't', -0.1, 'manual', 1)`
    ).run()).toThrow(/CHECK/i);
  });
});
