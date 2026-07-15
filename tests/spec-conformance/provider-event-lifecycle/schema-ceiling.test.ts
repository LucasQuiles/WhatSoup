import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  CURRENT_SCHEMA_MIGRATION,
  Database,
  DatabaseCompatibilityError,
} from '../../../src/core/database.ts';

const repoRoot = resolve(import.meta.dirname, '../../..');
const specFiles = ['requirements.md', 'design.md', 'tasks.md'];
const allocationPattern = /Schema allocation:\*{0,2}\s+current canonical schema is migration (?<current>\d+); bounded terminal recovery\/canonical `not_sent` is forward migration (?<terminal>\d+); the provider-event lifecycle ledger is migration (?<ledger>\d+)\./i;
const bodyAllocationExpectations = [
  {
    file: 'design.md',
    pattern: /Migration (?<migration>\d+) adds one empty activation marker table plus nine\s+content-free lifecycle tables/,
    migrationOffset: 2,
  },
  {
    file: 'design.md',
    pattern: /Migration (?<migration>\d+) enables aggregate no-send only for proved\s+single-op answers/,
    migrationOffset: 1,
  },
  {
    file: 'design.md',
    pattern: /Migration (?<migration>\d+) may prove multi-op no-send only from an immutable\s+complete effect plan/,
    migrationOffset: 2,
  },
  {
    file: 'requirements.md',
    pattern: /Migration (?<migration>\d+) permits aggregate `not_sent` only for\s+an immutable singleton answer-set seal/,
    migrationOffset: 1,
  },
  {
    file: 'requirements.md',
    pattern: /CON-002\.AC-07:\*\* Migration (?<migration>\d+) replaces the singleton seal with immutable fields on\s+the final attempt/,
    migrationOffset: 2,
  },
] as const;

describe('provider-event lifecycle schema allocation', () => {
  // @check CHK-071
  // @traces CON-005.AC-05
  it('rejects a future SQLite schema and keeps all canonical specs aligned with code', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'whatsoup-provider-schema-ceiling-')));
    const dbPath = join(dir, 'future.db');
    const futureVersion = CURRENT_SCHEMA_MIGRATION + 1;
    const seed = new DatabaseSync(dbPath);
    seed.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    const insert = seed.prepare('INSERT INTO schema_migrations (version) VALUES (?)');
    for (let version = 1; version <= futureVersion; version += 1) insert.run(version);
    seed.close();

    const db = new Database(dbPath);
    let rejection: unknown;
    try {
      db.open();
    } catch (error) {
      rejection = error;
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
    expect(rejection).toBeInstanceOf(DatabaseCompatibilityError);
    expect(rejection).toMatchObject({
      reason: 'future_schema',
      observedMigration: futureVersion,
      requiredMigration: CURRENT_SCHEMA_MIGRATION,
    });

    const expected = {
      current: String(CURRENT_SCHEMA_MIGRATION),
      terminal: String(CURRENT_SCHEMA_MIGRATION + 1),
      ledger: String(CURRENT_SCHEMA_MIGRATION + 2),
    };
    const allocations = specFiles.map((file) => {
      const text = readFileSync(
        join(repoRoot, 'docs/superpowers/specs/provider-event-lifecycle', file),
        'utf8',
      );
      const groups = text.match(allocationPattern)?.groups;
      return { file, allocation: groups ?? null };
    });

    expect(allocations).toEqual(specFiles.map((file) => ({ file, allocation: expected })));
  });

  // @check CHK-001
  // @traces CON-005.AC-01
  it('keeps normative body allocations aligned with the canonical migration sequence', () => {
    const allocations = bodyAllocationExpectations.map(({ file, pattern, migrationOffset }) => {
      const text = readFileSync(
        join(repoRoot, 'docs/superpowers/specs/provider-event-lifecycle', file),
        'utf8',
      );
      return {
        file,
        migration: text.match(pattern)?.groups?.migration ?? null,
        expectedMigration: String(CURRENT_SCHEMA_MIGRATION + migrationOffset),
      };
    });

    expect(allocations).toEqual(allocations.map(({ file, expectedMigration }) => ({
      file,
      migration: expectedMigration,
      expectedMigration,
    })));
  });
});
