#!/usr/bin/env node
// scripts/durability-writer-guard.ts
//
// The #1789 durability-writer invariant guard.
//
// THE DEFECT CLASS (docs/proposals/2026-07-20-durability-writer-invariant.md):
// a status-bearing durability table can be structurally incapable of reporting
// bad news — the row exists, its vocabulary DECLARES a terminal-failure value,
// but nothing in production `src/` ever writes it. `auth_loss_signal` was
// exactly this until #1786 wired a writer: the store, the controller, and the
// terminal-logout decision all existed, and none of them were connected. No
// test caught it because no test asserted the surface could FAIL. This guard
// makes that class of gap impossible to reship silently by checking every
// table `migratedSchemaSnapshot()` returns against a hand-curated registry
// (`scripts/lib/durability-status-registry.ts`).
//
// FOUR CHECKS, run in this order:
//
//   (1) COMPLETENESS. Every table in the snapshot must belong to EXACTLY ONE
//       of KNOWN_STATUS_TABLES / NON_STATUS_TABLES / RESERVED_TABLES. An
//       unclassified table forces the author touching schema to register it;
//       a table in more than one set is a registry bug in its own right.
//
//   (2) RESERVED METADATA. Every TRACKED_RESERVED entry must carry a
//       non-empty `reason` and `issue`. A bare reserved entry (the "declare an
//       exemption and never explain it" shape) fails the guard even though the
//       table itself is otherwise exempt.
//
//   (2b) ANTI-DODGE. Nothing in NON_STATUS_TABLES may have a column whose name
//        matches /status|state|error|outcome|failed/i without a truthful,
//        per-table justification in NON_STATUS_JUSTIFICATIONS — otherwise a
//        future author could hide a genuinely status-bearing table in the
//        "not our problem" bucket and this guard would never see it again.
//
//   (3) PER-TABLE WRITER-COVERAGE CHECK, for every KNOWN_STATUS_TABLES entry:
//       `terminalFailureValues` must be non-empty, and EVERY declared
//       terminal-failure value must be COVERED — either (a) found as text in
//       at least one declared, non-test, on-disk `src/` writer site, or
//       (b) explicitly named by a well-formed `TRACKED_UNWIRED_TERMINAL`
//       entry (non-empty `reason` + `issue`, same fail-closed rule as
//       TRACKED_RESERVED). An uncovered value fails the guard; a value with a
//       malformed unwired-terminal entry (empty reason/issue) fails on BOTH
//       counts, deliberately, rather than silently passing on a technicality.
//
//       HONESTY NOTE, stated plainly because it is easy to over-claim: path
//       (a) is DECLARATION-EXISTENCE, not runtime proof. It answers "does a
//       plausible writer module exist and mention the failure value", not
//       "does a live code path actually reach that write". It fails OPEN if
//       the literal survives only in a comment, a doc string, a type
//       declaration, or a dead branch — which is exactly why a value whose
//       only "writer" is that kind of technicality must NOT be declared as a
//       writer site at all; it must go through path (b) instead, as a
//       reviewed, tracked, DECLARED gap. Two such declared exceptions exist
//       today, and both are named here rather than left to be rediscovered:
//       `sweep_runs` (TRACKED_RESERVED — whole table, 0-ref reserved
//       substrate table, #1789) and `beads`' `'failed'` value
//       (TRACKED_UNWIRED_TERMINAL — `update_bead` is status-protected,
//       `transition()` callers are complete/cancel only, no `fail_bead` tool
//       exists, #1789). The guard's actual teeth are checks (1)/(2)/(2b)/(3)'s
//       coverage requirement plus the synthetic red-green tests in the
//       companion test file; the two tables this invariant was built to FIX
//       (`recovery_runs`, `enrichment_runs`) additionally get real behavioral
//       proof via SQLite persistence tests (Tasks 1-2), which this guard does
//       not attempt to replace.
//
//   (4) NON-VACUITY. If the schema snapshot cannot be loaded, or loads with
//       zero tables, the guard exits 2 (INCONCLUSIVE) — never 0. An empty or
//       failed scan must never read as "clean".
//
// Exit codes: 0 pass, 1 violation, 2 inconclusive (schema unreadable/empty).

import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  REGISTRY,
  TRACKED_RESERVED,
  TRACKED_UNWIRED_TERMINAL,
  KNOWN_STATUS_TABLES,
  NON_STATUS_TABLES,
  RESERVED_TABLES,
  NON_STATUS_JUSTIFICATIONS,
  type DurabilityStatusEntry,
  type ReservedEntry,
  type UnwiredTerminalEntry,
} from './lib/durability-status-registry.ts';

export type SchemaSnapshot = Map<string, { createSql: string; indexes: string[] }>;

export interface DurabilityWriterFinding {
  kind:
    | 'unclassified-table'
    | 'overlapping-classification'
    | 'reserved-missing-metadata'
    | 'anti-dodge-unjustified'
    | 'missing-terminal-values'
    | 'missing-writer-sites'
    | 'writer-site-not-src'
    | 'writer-site-missing'
    | 'writer-literal-not-found'
    | 'unwired-terminal-missing-metadata';
  table: string;
  detail: string;
}

export interface DurabilityWriterRegistryInput {
  registry?: readonly DurabilityStatusEntry[];
  trackedReserved?: readonly ReservedEntry[];
  trackedUnwiredTerminal?: readonly UnwiredTerminalEntry[];
  knownStatusTables?: ReadonlySet<string>;
  nonStatusTables?: ReadonlySet<string>;
  reservedTables?: ReadonlySet<string>;
  nonStatusJustifications?: Readonly<Record<string, string>>;
}

export interface DurabilityWriterScanResult {
  findings: DurabilityWriterFinding[];
  tablesScanned: number;
  registryTablesChecked: number;
}

const STATUS_LIKE_COLUMN_RE = /status|state|error|outcome|failed/i;

/**
 * Column names per table, derived by replaying each table's own `CREATE TABLE`
 * DDL against a throwaway in-memory database and reading `PRAGMA table_info`.
 * This is the ground truth used by the anti-dodge check (2b) — real column
 * names, not a regex over the DDL text, which would be fragile against
 * multi-line CHECK constraints and the trailing `ALTER TABLE ADD COLUMN`
 * fragments this schema accumulates.
 *
 * A handful of tables (the FTS5 shadow tables `messages_fts_data/idx/docsize/
 * config`) use reserved internal names that `node:sqlite` refuses to
 * `CREATE TABLE` directly outside the fts5 module's own bookkeeping; those
 * fail closed to an empty column list rather than aborting the whole scan —
 * safe here because none of them are anti-dodge candidates (their real columns
 * are `id`/`block`, `id`/`sz`, `segid`/`term`/`pgno`, `k`/`v`).
 */
function columnsByTable(snapshot: SchemaSnapshot): Map<string, string[]> {
  const db = new DatabaseSync(':memory:');
  const columns = new Map<string, string[]>();
  try {
    for (const [table, { createSql }] of snapshot) {
      try {
        db.exec(createSql);
        const rows = db.prepare(`PRAGMA table_info("${table.replaceAll('"', '""')}")`).all() as Array<{
          name: string;
        }>;
        columns.set(
          table,
          rows.map((row) => row.name),
        );
      } catch {
        columns.set(table, []);
      }
    }
  } finally {
    db.close();
  }
  return columns;
}

/** A writer site must be a non-test path under `src/` — the invariant is about production writers. */
function isNonTestSrcFile(relPath: string): boolean {
  const normalized = relPath.split(path.sep).join('/');
  if (!normalized.startsWith('src/')) return false;
  if (normalized.endsWith('.test.ts')) return false;
  if (normalized.split('/').includes('tests')) return false;
  return true;
}

/**
 * Run all four checks against a schema snapshot and a (possibly synthetic)
 * registry. The registry defaults to the real one; tests inject synthetic
 * entries to prove the red/green teeth without touching production data.
 */
export function scanDurabilityWriterInvariant(
  snapshot: SchemaSnapshot,
  repoRoot: string,
  input: DurabilityWriterRegistryInput = {},
): DurabilityWriterScanResult {
  const registry = input.registry ?? REGISTRY;
  const trackedReserved = input.trackedReserved ?? TRACKED_RESERVED;
  const trackedUnwiredTerminal = input.trackedUnwiredTerminal ?? TRACKED_UNWIRED_TERMINAL;
  const knownStatusTables = input.knownStatusTables ?? KNOWN_STATUS_TABLES;
  const nonStatusTables = input.nonStatusTables ?? NON_STATUS_TABLES;
  const reservedTables = input.reservedTables ?? RESERVED_TABLES;
  const nonStatusJustifications = input.nonStatusJustifications ?? NON_STATUS_JUSTIFICATIONS;

  const findings: DurabilityWriterFinding[] = [];

  // (1) completeness — every table in exactly one set.
  for (const table of snapshot.keys()) {
    const memberships = [knownStatusTables.has(table), nonStatusTables.has(table), reservedTables.has(table)].filter(
      Boolean,
    ).length;
    if (memberships === 0) {
      findings.push({
        kind: 'unclassified-table',
        table,
        detail: `'${table}' is not in KNOWN_STATUS_TABLES, NON_STATUS_TABLES, or RESERVED_TABLES — register it in scripts/lib/durability-status-registry.ts`,
      });
    } else if (memberships > 1) {
      findings.push({
        kind: 'overlapping-classification',
        table,
        detail: `'${table}' appears in more than one of KNOWN_STATUS_TABLES/NON_STATUS_TABLES/RESERVED_TABLES`,
      });
    }
  }

  // (2) reserved metadata — non-empty reason + issue.
  for (const entry of trackedReserved) {
    if (!entry.reason?.trim() || !entry.issue?.trim()) {
      findings.push({
        kind: 'reserved-missing-metadata',
        table: entry.table,
        detail: `TRACKED_RESERVED entry for '${entry.table}' is missing a non-empty reason and/or issue`,
      });
    }
  }

  // (2b) anti-dodge — a suspicious column in NON_STATUS_TABLES needs a justification.
  const columns = columnsByTable(snapshot);
  for (const table of nonStatusTables) {
    const tableColumns = columns.get(table) ?? [];
    const suspicious = tableColumns.filter((c) => STATUS_LIKE_COLUMN_RE.test(c));
    if (suspicious.length === 0) continue;
    if (!nonStatusJustifications[table]?.trim()) {
      findings.push({
        kind: 'anti-dodge-unjustified',
        table,
        detail: `NON_STATUS table '${table}' has column(s) [${suspicious.join(', ')}] matching /status|state|error|outcome|failed/i with no entry in NON_STATUS_JUSTIFICATIONS`,
      });
    }
  }

  // (2c) unwired-terminal metadata — same fail-closed rule as (2): every
  // TRACKED_UNWIRED_TERMINAL entry needs a non-empty reason and issue,
  // checked independently of whether it ends up covering anything below.
  for (const entry of trackedUnwiredTerminal) {
    if (!entry.reason?.trim() || !entry.issue?.trim()) {
      findings.push({
        kind: 'unwired-terminal-missing-metadata',
        table: entry.table,
        detail: `TRACKED_UNWIRED_TERMINAL entry for '${entry.table}' (terminalValue='${entry.terminalValue}') is missing a non-empty reason and/or issue`,
      });
    }
  }
  // Only WELL-FORMED entries count as a declared exception — a malformed one
  // must not silently grant coverage just because check (2c) already flagged it.
  const declaredUnwiredValues = new Map<string, Set<string>>();
  for (const entry of trackedUnwiredTerminal) {
    if (!entry.reason?.trim() || !entry.issue?.trim()) continue;
    const set = declaredUnwiredValues.get(entry.table) ?? new Set<string>();
    set.add(entry.terminalValue);
    declaredUnwiredValues.set(entry.table, set);
  }

  // (3) per-registered-status-table writer-COVERAGE check. Every declared
  // terminalFailureValue must be either found in a real writer site or
  // explicitly named by a declared TRACKED_UNWIRED_TERMINAL entry — an
  // uncovered value is a violation, undeclared or not.
  let registryTablesChecked = 0;
  for (const entry of registry) {
    registryTablesChecked += 1;

    if (!entry.terminalFailureValues || entry.terminalFailureValues.length === 0) {
      findings.push({
        kind: 'missing-terminal-values',
        table: entry.table,
        detail: `registry entry for '${entry.table}' declares no terminalFailureValues`,
      });
      continue;
    }

    const foundValues = new Set<string>();
    for (const site of entry.writerSites ?? []) {
      if (!isNonTestSrcFile(site)) {
        findings.push({
          kind: 'writer-site-not-src',
          table: entry.table,
          detail: `writer site '${site}' for '${entry.table}' is not a non-test path under src/`,
        });
        continue;
      }
      let content: string;
      try {
        content = readFileSync(path.join(repoRoot, site), 'utf8');
      } catch {
        findings.push({
          kind: 'writer-site-missing',
          table: entry.table,
          detail: `writer site '${site}' for '${entry.table}' does not exist under ${repoRoot}`,
        });
        continue;
      }
      for (const value of entry.terminalFailureValues) {
        if (content.includes(value)) foundValues.add(value);
      }
    }

    const declaredValues = declaredUnwiredValues.get(entry.table) ?? new Set<string>();
    const uncovered = entry.terminalFailureValues.filter(
      (value) => !foundValues.has(value) && !declaredValues.has(value),
    );
    if (uncovered.length === 0) continue;

    if (!entry.writerSites || entry.writerSites.length === 0) {
      findings.push({
        kind: 'missing-writer-sites',
        table: entry.table,
        detail: `registry entry for '${entry.table}' declares no writerSites, and terminal-failure value(s) [${uncovered.join(', ')}] have no declared TRACKED_UNWIRED_TERMINAL exception either`,
      });
    } else {
      findings.push({
        kind: 'writer-literal-not-found',
        table: entry.table,
        detail: `terminal-failure value(s) [${uncovered.join(', ')}] for '${entry.table}' do not appear as text in any declared writer site (${entry.writerSites.join(', ')}) and have no declared TRACKED_UNWIRED_TERMINAL exception`,
      });
    }
  }

  return { findings, tablesScanned: snapshot.size, registryTablesChecked };
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(SCRIPT_DIR, '..');

async function loadSnapshot(): Promise<SchemaSnapshot> {
  const mod = (await import(pathToFileURL(path.join(REPO_ROOT, 'src/core/database.ts')).href)) as {
    migratedSchemaSnapshot: () => SchemaSnapshot;
  };
  return mod.migratedSchemaSnapshot();
}

async function main(): Promise<void> {
  let snapshot: SchemaSnapshot;
  try {
    snapshot = await loadSnapshot();
  } catch (err) {
    console.error(
      `durability-writer-guard: INCONCLUSIVE — failed to load migratedSchemaSnapshot(): ${(err as Error).message}`,
    );
    process.exitCode = 2;
    return;
  }

  if (snapshot.size === 0) {
    console.error('durability-writer-guard: INCONCLUSIVE — migratedSchemaSnapshot() returned zero tables; nothing was scanned');
    process.exitCode = 2;
    return;
  }

  const result = scanDurabilityWriterInvariant(snapshot, REPO_ROOT);

  if (result.findings.length === 0) {
    console.log(
      `durability-writer-guard: PASS — ${result.tablesScanned} table(s) classified, ${result.registryTablesChecked} status table(s) writer-checked (invariant #1789)`,
    );
    return;
  }

  console.error(`durability-writer-guard: FAIL — ${result.findings.length} violation(s) (invariant #1789):`);
  for (const finding of result.findings) {
    console.error(`  [${finding.kind}] ${finding.table}: ${finding.detail}`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
