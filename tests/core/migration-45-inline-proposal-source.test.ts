import { randomBytes } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_MIGRATION, Database } from '../../src/core/database.ts';
import { createBead } from '../../src/core/substrate/beads.ts';

function tmpFile(): string {
  return join(tmpdir(), `inline-source-${randomBytes(8).toString('hex')}.db`);
}

function inlineBead(db: DatabaseSync, sourceMessagePk: number | null, title: string): void {
  createBead(db, {
    kind: 'task',
    status: 'proposed',
    title,
    ownerJid: 'owner-1',
    chatJid: 'chat-1',
    sourceMessagePk,
    proposalReason: 'inline imperative: schedule',
    actor: 'inline',
  });
}

describe('migration 45 inline proposal source uniqueness', () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const path of cleanup.splice(0)) {
      for (const suffix of ['', '-wal', '-shm']) {
        const candidate = `${path}${suffix}`;
        if (existsSync(candidate)) unlinkSync(candidate);
      }
    }
  });

  it('records migration 45 and creates the scoped partial unique index', () => {
    const db = new Database(':memory:');
    db.open();
    try {
      expect(CURRENT_SCHEMA_MIGRATION).toBe(45);
      expect(db.raw.prepare(
        'SELECT version FROM schema_migrations WHERE version = 45',
      ).get()).toEqual({ version: 45 });

      const index = db.raw.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_beads_inline_source_unique'",
      ).get() as { sql: string } | undefined;
      expect(index?.sql).toMatch(/CREATE UNIQUE INDEX/i);
      expect(index?.sql).toContain('source_message_pk');
      expect(index?.sql).toMatch(/source_message_pk IS NOT NULL/i);
      expect(index?.sql).toMatch(/proposal_reason LIKE 'inline imperative: %'/i);
    } finally {
      db.close();
    }
  });

  it('constrains only non-null inline-imperative source keys', () => {
    const db = new Database(':memory:');
    db.open();
    try {
      inlineBead(db.raw, null, 'null-source-a');
      inlineBead(db.raw, null, 'null-source-b');

      createBead(db.raw, {
        kind: 'task', status: 'proposed', title: 'manual-a', ownerJid: 'owner-1',
        sourceMessagePk: 501, proposalReason: 'manual proposal', actor: 'manual',
      });
      createBead(db.raw, {
        kind: 'task', status: 'proposed', title: 'manual-b', ownerJid: 'owner-1',
        sourceMessagePk: 501, proposalReason: 'manual proposal', actor: 'manual',
      });

      inlineBead(db.raw, 502, 'inline-a');
      expect(() => inlineBead(db.raw, 502, 'inline-b')).toThrow(/unique constraint/i);
      expect(() => inlineBead(db.raw, 503, 'inline-a')).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('fails closed before index creation when legacy inline sources collide', () => {
    const path = tmpFile();
    cleanup.push(path);

    const seed = new Database(path);
    seed.open();
    seed.raw.exec('DROP INDEX IF EXISTS idx_beads_inline_source_unique');
    seed.raw.prepare('DELETE FROM schema_migrations WHERE version = 45').run();
    inlineBead(seed.raw, 901, 'first legacy target');
    inlineBead(seed.raw, 901, 'second legacy target');
    seed.close();

    const migrating = new Database(path);
    let failure: unknown;
    try {
      migrating.open();
    } catch (err) {
      failure = err;
    } finally {
      migrating.close();
    }

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toMatch(/migration 45 failed/i);
    expect(String(failure)).not.toContain('901');
    expect(String(failure).length).toBeLessThan(200);

    const inspect = new DatabaseSync(path);
    try {
      expect(inspect.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_beads_inline_source_unique'",
      ).get()).toBeUndefined();
      expect(inspect.prepare(
        'SELECT version FROM schema_migrations WHERE version = 45',
      ).get()).toBeUndefined();
      expect(inspect.prepare(
        'SELECT COUNT(*) AS count FROM beads WHERE source_message_pk = 901',
      ).get()).toEqual({ count: 2 });
    } finally {
      inspect.close();
    }
  });
});
