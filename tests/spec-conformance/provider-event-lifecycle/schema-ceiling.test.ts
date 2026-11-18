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
// Every other statement that names a schema number, one pattern each, unique in its file, so
// renumbering or dropping any single statement fails. `current` follows the code.
const roles: Record<string, string> = { ...planned, current: String(CURRENT_SCHEMA_MIGRATION) };
const statementPins: Readonly<Record<(typeof specFiles)[number], readonly RegExp[]>> = {
  'requirements.md': [
    /audited at schema 66; the current canonical schema is (?<current>\d+)\./g,
    /Migration (?<reserved>\d+) is reserved for another pending migration batch, so the still-unpublished forward allocations move to migrations (?<terminal>\d+) and (?<ledger>\d+)\./g,
    /reserved (?<reserved>\d+) and the forward (?<terminal>\d+)\/(?<ledger>\d+) allocations are planning numbers/g,
    /migration (?<terminal>\d+) backfills legacy transfers/g,
    /for migration-(?<ledger>\d+) turns, the final attempt/g,
    /included in migration-(?<terminal>\d+) storage\/retention accounting/g,
    /and migration (?<reserved>\d+) is reserved for another pending migration batch\. Historical lineage/g,
    /Migration (?<ledger>\d+) may leave its immutable/g,
    /The migration-(?<ledger>\d+)\s+marker may exist in the pre-restore source/g,
    /the sole permitted removal of that v(?<ledger>\d+) row/g,
    /leave v(?<ledger>\d+) drained\/read-only and roll forward/g,
  ],
  'design.md': [
    /audited at schema 66; the current canonical schema is (?<current>\d+)\./g,
    /lifecycle ledger as (?<ledger>\d+); migration (?<reserved>\d+) is reserved for another pending batch; recheck before implementation/g,
    /and migration (?<reserved>\d+) is reserved for another pending migration batch\. The terminal-recovery prerequisite uses migration (?<terminal>\d+) for/g,
    /Migration (?<terminal>\d+) does not alter historical 37-53/g,
    /deletes it last\. Migration-(?<terminal>\d+)\s+storage accounting includes these rows/g,
    /After the migration-(?<terminal>\d+) prerequisite merges, the lifecycle branch rebases/g,
    /and allocates provider-event lifecycle\s+migration (?<ledger>\d+)\. It extends terminal\/job\/closure ownership/g,
    /registered history through (?<terminal>\d+); deployed v42 databases/g,
    /deployed v42 databases apply 43-(?<terminal>\d+), v40 databases/g,
    /apply 41-(?<terminal>\d+), and the audited v66 baseline/g,
    /the audited v66 baseline applies 67-(?<terminal>\d+)\./g,
    /Migration (?<ledger>\d+) creates an\s+empty `provider_lifecycle_activation` table/g,
    /and migration (?<reserved>\d+) is reserved for another pending migration batch\. Land the terminal recovery prerequisite on migration (?<terminal>\d+),/g,
    /Migration (?<ledger>\d+) creates this singleton table empty/g,
    /migration-(?<terminal>\d+) proof is single-op only, while migration-(?<ledger>\d+) multi-op proof requires/g,
    /current fleet compatibility before any schema-(?<terminal>\d+)\s+writer; missing evidence remains open/g,
    /recovery-owner prerequisite as\s+migration (?<terminal>\d+)\./g,
    /onto that canonical main and implement migration (?<ledger>\d+)\./g,
    /source v(?<ledger>\d+) marker occurs only as part of that whole-database restore/g,
    /immutable migration-(?<ledger>\d+) schema marker may exist in the pre-restore source/g,
    /backup restore returns schema history to (?<terminal>\d+)/g,
  ],
  'tasks.md': [
    /audited at schema 66; the current canonical schema is (?<current>\d+)\./g,
    /lifecycle ledger as (?<ledger>\d+); migration (?<reserved>\d+) is reserved for another pending batch; recheck before implementation/g,
    /forward migration (?<terminal>\d+) on current\s+canonical source \(schema (?<current>\d+) here; migration (?<reserved>\d+) is reserved for another pending\s+batch\); do not alter/g,
    /permits the immutable migration-(?<ledger>\d+) marker/g,
    /removes the source\s+v(?<ledger>\d+) row as part of that atomic state replacement/g,
    /canonical source is at schema (?<current>\d+); the specified canonical.*forward allocation (?<terminal>\d+) \(migration (?<reserved>\d+) is reserved for another pending batch\)/g,
    /deliveryKind=not_sent`\. Migration (?<terminal>\d+) permits/g,
    /until migration (?<ledger>\d+)\S* immutable sealed expected set/g,
    /Base this work on current canonical source \(schema (?<current>\d+) here; migration (?<reserved>\d+) is\s+reserved for another pending batch\) and allocate forward migration (?<terminal>\d+) for/g,
    /closure-eligibility index and migration-(?<terminal>\d+) storage accounting/g,
    /current canonical source is at schema (?<current>\d+), where protected-delivery.*the failed-terminal reply-debt index occupies migration 69; migration (?<reserved>\d+) is reserved for another pending migration batch/g,
    /the shared (?<current>\d+)\/(?<reserved>\d+)\/(?<terminal>\d+)\/(?<ledger>\d+) allocation/g,
    /After TSK-010 merges migration (?<terminal>\d+), rebase this lifecycle branch/g,
    /the migration-(?<ledger>\d+) marker may exist in the source;/g,
  ],
};
const statementExpectations = specFiles.flatMap((file) => statementPins[file].map((pattern) => ({ file, pattern })));

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
    const results = [...bodyAllocationExpectations, ...statementExpectations].map(({ file, pattern }) => {
      const text = file === 'all' ? [...texts.values()].join('\n') : texts.get(file) ?? '';
      const matches = [...text.matchAll(pattern)].map((match) => ({ ...match.groups }));
      return { file, pattern: pattern.source, matches };
    });

    // The reserved and planned numbers are still unallocated in code.
    expect(Object.values(planned).filter((migration) => Number(migration) <= CURRENT_SCHEMA_MIGRATION))
      .toEqual([]);
    expect(results.filter(({ matches }) => matches.length === 0)).toEqual([]);
    expect(results.flatMap(({ file, pattern, matches }) => matches
      .filter((groups) => Object.entries(groups).some(([role, migration]) => migration !== roles[role]))
      .map((groups) => ({ file, pattern, groups })))).toEqual([]);
  });
});
