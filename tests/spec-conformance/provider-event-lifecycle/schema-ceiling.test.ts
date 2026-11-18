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
const specDir = join(repoRoot, 'docs/superpowers/specs/provider-event-lifecycle');
const specFiles = ['requirements.md', 'design.md', 'tasks.md'] as const;
// Planning numbers; the migration register assigns final numbers at landing, in batch order.
// Migration 70 is reserved for another pending batch, so the two planned items keep 71 and 72
// whichever pending batch lands first. Only the current schema follows the code.
const planned: Record<string, string> = { reserved: '70', terminal: '71', ledger: '72' };
const allocationPattern = /Schema allocation:\*{0,2}\s+current canonical schema is migration (?<current>\d+); bounded terminal recovery\/canonical `not_sent` is forward migration (?<terminal>\d+); the provider-event lifecycle ledger is migration (?<ledger>\d+)\./i;
const allocationPointerPattern = /Schema allocation:\*{0,2}\s+see \[[^\]]+\]\(requirements\.md#schema-allocation\)\. At the audited schema-(?<current>\d+) base, terminal recovery is planned as (?<terminal>\d+) and the provider lifecycle ledger as (?<ledger>\d+);/i;
// Normative statements that name a reserved or planned number. Each named group is a role in
// `planned`: every match must name that role's number, and every pattern must match. The
// patterns after the first five cover the statements that kept an old number after a renumber.
const bodyAllocationExpectations: ReadonlyArray<{
  file: (typeof specFiles)[number] | 'all';
  pattern: RegExp;
}> = [
  { file: 'design.md', pattern: /Migration (?<ledger>\d+) adds one empty activation marker table plus nine\s+content-free lifecycle tables/g },
  { file: 'design.md', pattern: /Migration (?<terminal>\d+) enables aggregate no-send only for proved\s+single-op answers/g },
  { file: 'design.md', pattern: /Migration (?<ledger>\d+) may prove multi-op no-send only from an immutable\s+complete effect plan/g },
  { file: 'requirements.md', pattern: /Migration (?<terminal>\d+) permits aggregate `not_sent` only for\s+an immutable singleton answer-set seal/g },
  { file: 'requirements.md', pattern: /CON-002\.AC-07:\*\* Migration (?<ledger>\d+) replaces the singleton seal with immutable fields on\s+the final attempt/g },
  { file: 'requirements.md', pattern: /\*\*Note:\*\* Migration (?<reserved>\d+) is reserved for other pending work;/g },
  { file: 'requirements.md', pattern: /terminal recovery\/canonical\s+`not_sent` to migration (?<terminal>\d+) and the provider-event lifecycle ledger to migration\s+(?<ledger>\d+)\./g },
  { file: 'design.md', pattern: /terminal[- ]recovery prerequisite (?:uses|on) migration (?<terminal>\d+)/g },
  { file: 'design.md', pattern: /then provider-event lifecycle on migration (?<ledger>\d+)\./g },
  { file: 'design.md', pattern: /recovery-v(?<terminal>\d+), and\s+lifecycle-v(?<ledger>\d+) migration fixtures/g },
  { file: 'tasks.md', pattern: /TSK-010: Land migration-(?<terminal>\d+) /g },
  { file: 'tasks.md', pattern: /TSK-003: Add migration (?<ledger>\d+) /g },
  { file: 'tasks.md', pattern: /`src\/core\/database-migration-(?<ledger>\d+)\.ts`/g },
  { file: 'all', pattern: /schema-(?<terminal>\d+) \(pre-v(?<ledger>\d+)\)/g },
  { file: 'all', pattern: /schema-(?<terminal>\d+) (?:backup )?fingerprint/g },
  { file: 'all', pattern: /schema-(?<terminal>\d+)\/(?<ledger>\d+) writer/g },
  { file: 'all', pattern: /schema_migrations\(version=(?<ledger>\d+)\)/g },
  { file: 'all', pattern: /\bv(?<ledger>\d+) write(?:-\s*| )compatib/g },
];

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
      terminal: planned.terminal,
      ledger: planned.ledger,
    };
    const allocations = specFiles.map((file) => {
      const text = readFileSync(join(specDir, file), 'utf8');
      const pattern = file === 'requirements.md' ? allocationPattern : allocationPointerPattern;
      const groups = text.match(pattern)?.groups;
      return { file, allocation: groups ?? null };
    });

    expect(allocations).toEqual(specFiles.map((file) => ({ file, allocation: expected })));
  });

  // @check CHK-001
  // @traces CON-005.AC-01
  it('keeps normative body allocations aligned with the canonical migration sequence', () => {
    const texts = new Map(specFiles.map((file) => [file, readFileSync(join(specDir, file), 'utf8')] as const));
    const results = bodyAllocationExpectations.map(({ file, pattern }) => {
      const text = file === 'all' ? [...texts.values()].join('\n') : texts.get(file) ?? '';
      const matches = [...text.matchAll(pattern)].map((match) => ({ ...match.groups }));
      return { file, pattern: pattern.source, matches };
    });

    // The reserved and planned numbers are still unallocated in code.
    expect(Object.values(planned).filter((migration) => Number(migration) <= CURRENT_SCHEMA_MIGRATION))
      .toEqual([]);
    expect(results.filter(({ matches }) => matches.length === 0)).toEqual([]);
    expect(results.flatMap(({ file, pattern, matches }) => matches
      .filter((groups) => Object.entries(groups).some(([role, migration]) => migration !== planned[role]))
      .map((groups) => ({ file, pattern, groups })))).toEqual([]);
  });
});
