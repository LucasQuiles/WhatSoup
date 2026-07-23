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
// table in the migrated-schema snapshot, PLUS every table discovered by a
// static scan for self-provisioned tables (check 1b), against a hand-curated
// registry (`scripts/lib/durability-status-registry.ts`).
//
// FOUR CHECKS, run in this order:
//
//   (1) COMPLETENESS. Every table in the snapshot must belong to EXACTLY ONE
//       of KNOWN_STATUS_TABLES / NON_STATUS_TABLES / RESERVED_TABLES. An
//       unclassified table forces the author touching schema to register it;
//       a table in more than one set is a registry bug in its own right.
//
//   (1b) SELF-PROVISIONED DISCOVERY. Check (1)'s completeness claim is scoped
//        to `migratedSchemaSnapshot()` — but six real, live tables are created
//        OUTSIDE that migration registry by their own self-managed
//        `ensureXSchema(db)` functions and are invisible to it. This check
//        closes that blind spot: a cheap, bounded static scan finds every
//        `CREATE TABLE (IF NOT EXISTS)? <name>` text occurrence under
//        `src/**/*.ts` (discovery, not parsing — comments stripped, no SQL
//        parser), and every discovered name must be in the snapshot,
//        `SELF_PROVISIONED`, or `DISCOVERY_EXCLUSIONS`, or the guard fails
//        closed naming the table and the module(s) it was found in. Each
//        `SELF_PROVISIONED` entry additionally gets its module's DDL text
//        scanned by the SAME anti-dodge regex check (2b) uses — a
//        status-shaped column with no `justification` field fails closed,
//        for the identical "don't let a status-bearing table hide" reason.
//        The scanned slice is the COLUMN-DEFINITION body only (opening `(`
//        to the closing `);`), deliberately excluding the table's own name —
//        `agent_fallback_state` legitimately ends in `_state` and would
//        otherwise self-trigger on its own identifier, not a real column.
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
//       exists, #1789). The guard's actual teeth are checks (1)/(1b)/(2)/(2b)/(3)'s
//       coverage requirement plus the synthetic red-green tests in the
//       companion test file; the two tables this invariant was built to FIX
//       (`recovery_runs`, `enrichment_runs`) additionally get real behavioral
//       proof via SQLite persistence tests (Tasks 1-2), which this guard does
//       not attempt to replace.
//
//   (4) NON-VACUITY. An empty schema snapshot, or a THROW anywhere inside the
//       scan itself (not just the async load), maps to INCONCLUSIVE (exit 2)
//       — never 0, and never an uncaught exception falling through to Node's
//       default exit 1. `evaluateDurabilityWriterInvariant` wraps the
//       empty-snapshot check and the call to `scanDurabilityWriterInvariant`
//       in ONE try/catch and returns a discriminated
//       `{status:'pass'|'violation'|'inconclusive', ...}` result — the same
//       function `main()` calls and tests call directly, so the exit-2
//       contract is unit-testable without spawning a CLI subprocess. `main()`
//       additionally carries a `.catch()` on its own invocation as a second,
//       belt-and-braces layer.
//
// Exit codes: 0 pass, 1 violation, 2 inconclusive (schema unreadable/empty/scan threw).

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  REGISTRY,
  TRACKED_RESERVED,
  TRACKED_UNWIRED_TERMINAL,
  SELF_PROVISIONED,
  DISCOVERY_EXCLUSIONS,
  KNOWN_STATUS_TABLES,
  NON_STATUS_TABLES,
  RESERVED_TABLES,
  NON_STATUS_JUSTIFICATIONS,
  type DurabilityStatusEntry,
  type ReservedEntry,
  type UnwiredTerminalEntry,
  type SelfProvisionedEntry,
  type DiscoveryExclusionEntry,
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
    | 'unwired-terminal-missing-metadata'
    | 'unregistered-self-provisioned-table'
    | 'self-provisioned-missing-metadata'
    | 'self-provisioned-module-missing'
    | 'self-provisioned-anti-dodge-unjustified'
    | 'discovery-exclusion-missing-metadata';
  table: string;
  detail: string;
}

export interface DurabilityWriterRegistryInput {
  registry?: readonly DurabilityStatusEntry[];
  trackedReserved?: readonly ReservedEntry[];
  trackedUnwiredTerminal?: readonly UnwiredTerminalEntry[];
  selfProvisioned?: readonly SelfProvisionedEntry[];
  discoveryExclusions?: readonly DiscoveryExclusionEntry[];
  /**
   * Precomputed `CREATE TABLE` name -> discovering-file(s) map, for tests.
   * Defaults to a real scan of `repoRoot/src`. Production (`main()`) always
   * uses the default; a test overriding OTHER inputs with a small synthetic
   * `snapshot` should pass `discovered: new Map()` too, or the real scan
   * (against the real repo's `src/`) will report those real tables as
   * uncovered by the test's tiny synthetic snapshot.
   */
  discovered?: ReadonlyMap<string, readonly string[]>;
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

/**
 * Discriminated outcome of the injectable evaluation path (see
 * `evaluateDurabilityWriterInvariant`). `'inconclusive'` carries a `reason`
 * instead of a `result` — there is no scan result to report when the scan
 * itself never completed.
 */
export type DurabilityWriterOutcome =
  | { status: 'pass'; result: DurabilityWriterScanResult }
  | { status: 'violation'; result: DurabilityWriterScanResult }
  | { status: 'inconclusive'; reason: string };

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

/**
 * Non-empty `reason` AND `issue` — the single fail-closed metadata rule
 * shared by `TRACKED_RESERVED` (check 2) and `TRACKED_UNWIRED_TERMINAL`
 * (checks 2c and its coverage-granting filter). A bare declared exception
 * (the "declare it and never explain it" shape) does not count as declared.
 */
function hasReasonAndIssue(entry: { reason: string; issue: string }): boolean {
  return Boolean(entry.reason?.trim()) && Boolean(entry.issue?.trim());
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
 * Blank out `//` line comments and block comments so prose that MENTIONS
 * "CREATE TABLE" (like this guard's own docs, or a module's header comment)
 * is not misread as a real DDL statement. Newlines are preserved so any
 * downstream line-number math would stay accurate. Mirrors the identical
 * helper in grant-resolver-inventory-guard.ts.
 */
function stripComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

const CREATE_TABLE_RE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?([A-Za-z_][A-Za-z0-9_]*)/gi;

/** Non-test `.ts` files under `dir`, recursively, skipping the usual noise directories. */
function walkTsFiles(root: string, dir: string, acc: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // a missing src/ (e.g. a test repoRoot fixture) is not a scan failure — see (1b)'s doc note
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
    const full = path.join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkTsFiles(root, full, acc);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      acc.push(path.relative(root, full).split(path.sep).join('/'));
    }
  }
}

/**
 * Cheap, bounded discovery (check 1b): every `CREATE TABLE (IF NOT EXISTS)?
 * <name>` TEXT occurrence under `src/**\/*.ts` (comments stripped first).
 * This is discovery, not parsing — it finds NAMES, not full schemas; the
 * table's actual columns/behavior are validated elsewhere (registry writer
 * checks, the self-provisioned anti-dodge DDL scan below). Bounded to `src/`
 * only, matching the invariant's "production writer" scope everywhere else
 * in this guard.
 */
function discoverCreateTableNames(repoRoot: string): Map<string, string[]> {
  const files: string[] = [];
  walkTsFiles(path.join(repoRoot, 'src'), path.join(repoRoot, 'src'), files);
  const discovered = new Map<string, string[]>();
  for (const rel of files) {
    let content: string;
    try {
      content = stripComments(readFileSync(path.join(repoRoot, 'src', rel), 'utf8'));
    } catch {
      continue;
    }
    CREATE_TABLE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CREATE_TABLE_RE.exec(content)) !== null) {
      const table = match[1];
      if (!table) continue;
      const moduleRel = `src/${rel}`;
      const list = discovered.get(table) ?? [];
      if (!list.includes(moduleRel)) list.push(moduleRel);
      discovered.set(table, list);
    }
  }
  return discovered;
}

/**
 * A bounded slice of the COLUMN-DEFINITION body for the self-provisioned
 * anti-dodge scan: from the `(` that opens the table's column list, up to
 * the next `);` (the closing pattern every self-provisioned DDL in this
 * codebase uses), or a generous fallback window if that terminator isn't
 * found. Deliberately starts AFTER `CREATE TABLE <name> (`, not at the match
 * itself — several of these table names legitimately end in `_state` (e.g.
 * `agent_fallback_state`), and scanning the table's own name would produce
 * exactly the kind of false positive the real anti-dodge check (2b) avoids
 * by checking real COLUMN names (via PRAGMA), not raw DDL text. `null` when
 * the table's `CREATE TABLE` text (or its opening paren) isn't found at all,
 * in which case the caller falls back to scanning the whole file — still a
 * cheap, conservative (never a false negative on genuine columns) text scan,
 * not a parser.
 */
function extractCreateTableDdl(strippedContent: string, table: string): string | null {
  const re = new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?[\`"']?${table}\\b`, 'i');
  const match = re.exec(strippedContent);
  if (!match) return null;
  const openParen = strippedContent.indexOf('(', match.index + match[0].length);
  if (openParen === -1) return null;
  const terminator = strippedContent.indexOf(');', openParen);
  const end = terminator === -1 ? Math.min(strippedContent.length, openParen + 2000) : terminator + 2;
  return strippedContent.slice(openParen, end);
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
  const selfProvisioned = input.selfProvisioned ?? SELF_PROVISIONED;
  const discoveryExclusions = input.discoveryExclusions ?? DISCOVERY_EXCLUSIONS;
  const discovered = input.discovered ?? discoverCreateTableNames(repoRoot);
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

  // (1b) self-provisioned discovery — every CREATE TABLE text occurrence
  // under src/ must be accounted for: a real migrated table (the snapshot
  // passed in), a declared self-provisioned table, or a declared discovery
  // exclusion. An uncovered discovery means a table was created outside both
  // the migration registry AND this registry file — register it.
  const selfProvisionedTableNames = new Set(selfProvisioned.map((entry) => entry.table));
  const discoveryExclusionTableNames = new Set(discoveryExclusions.map((entry) => entry.table));
  for (const [table, files] of discovered) {
    const covered =
      snapshot.has(table) || selfProvisionedTableNames.has(table) || discoveryExclusionTableNames.has(table);
    if (!covered) {
      findings.push({
        kind: 'unregistered-self-provisioned-table',
        table,
        detail: `CREATE TABLE '${table}' discovered in ${files.join(', ')} but is not in the migrated schema snapshot, SELF_PROVISIONED, or DISCOVERY_EXCLUSIONS — register it in scripts/lib/durability-status-registry.ts`,
      });
    }
  }

  // self-provisioned entry metadata + anti-dodge DDL scan: every entry needs
  // a non-empty table/module/reason, its module must exist under repoRoot,
  // and its DDL text must not match the status-shaped-column regex without
  // an explicit justification — the same anti-dodge rule (2b) applies to
  // NON_STATUS_TABLES, applied here to self-provisioned ones.
  for (const entry of selfProvisioned) {
    if (!entry.table?.trim() || !entry.module?.trim() || !entry.reason?.trim()) {
      findings.push({
        kind: 'self-provisioned-missing-metadata',
        table: entry.table || '(unnamed)',
        detail: `SELF_PROVISIONED entry is missing a non-empty table, module, and/or reason`,
      });
      continue;
    }
    let moduleContent: string;
    try {
      moduleContent = readFileSync(path.join(repoRoot, entry.module), 'utf8');
    } catch {
      findings.push({
        kind: 'self-provisioned-module-missing',
        table: entry.table,
        detail: `SELF_PROVISIONED module '${entry.module}' for '${entry.table}' does not exist under ${repoRoot}`,
      });
      continue;
    }
    const strippedModule = stripComments(moduleContent);
    const ddl = extractCreateTableDdl(strippedModule, entry.table) ?? strippedModule;
    if (STATUS_LIKE_COLUMN_RE.test(ddl) && !entry.justification?.trim()) {
      findings.push({
        kind: 'self-provisioned-anti-dodge-unjustified',
        table: entry.table,
        detail: `SELF_PROVISIONED table '${entry.table}' (${entry.module}) has DDL text matching /status|state|error|outcome|failed/i with no justification field on the entry`,
      });
    }
  }

  // discovery-exclusion metadata — same fail-closed shape as every other
  // declared-exception array in this registry: a bare exclusion (no reason)
  // is not a declared one.
  for (const entry of discoveryExclusions) {
    if (!entry.table?.trim() || !entry.reason?.trim()) {
      findings.push({
        kind: 'discovery-exclusion-missing-metadata',
        table: entry.table || '(unnamed)',
        detail: `DISCOVERY_EXCLUSIONS entry is missing a non-empty table and/or reason`,
      });
    }
  }

  // (2) reserved metadata — non-empty reason + issue.
  for (const entry of trackedReserved) {
    if (!hasReasonAndIssue(entry)) {
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
    if (!hasReasonAndIssue(entry)) {
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
    if (!hasReasonAndIssue(entry)) continue;
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

/**
 * The injectable, synchronous evaluation path. Wraps the empty-snapshot
 * check AND the call to `scanDurabilityWriterInvariant` in ONE try/catch, so
 * a throw ANYWHERE in the scan — a malformed snapshot, a `DatabaseSync`
 * failure inside `columnsByTable`, or anything else — maps to
 * `'inconclusive'` rather than propagating as an uncaught exception (which
 * Node would otherwise turn into a plain exit 1, indistinguishable from a
 * genuine violation). This is what `main()` calls, and what tests call
 * directly to prove the exit-2 contract without spawning a CLI subprocess.
 */
export function evaluateDurabilityWriterInvariant(
  snapshot: SchemaSnapshot,
  repoRoot: string,
  input: DurabilityWriterRegistryInput = {},
): DurabilityWriterOutcome {
  try {
    if (snapshot.size === 0) {
      return {
        status: 'inconclusive',
        reason: 'migratedSchemaSnapshot() returned zero tables; nothing was scanned',
      };
    }
    const result = scanDurabilityWriterInvariant(snapshot, repoRoot, input);
    return result.findings.length === 0 ? { status: 'pass', result } : { status: 'violation', result };
  } catch (err) {
    return {
      status: 'inconclusive',
      reason: `scan threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(SCRIPT_DIR, '..');

async function loadSnapshot(): Promise<SchemaSnapshot> {
  const mod = (await import(pathToFileURL(path.join(REPO_ROOT, 'src/core/database.ts')).href)) as {
    migratedSchemaSnapshot: () => SchemaSnapshot;
  };
  return mod.migratedSchemaSnapshot();
}

/** Thin CLI mapping: outcome -> stdout/stderr text + process.exitCode. All the logic lives above. */
function reportOutcome(outcome: DurabilityWriterOutcome): void {
  if (outcome.status === 'inconclusive') {
    console.error(`durability-writer-guard: INCONCLUSIVE — ${outcome.reason}`);
    process.exitCode = 2;
    return;
  }
  if (outcome.status === 'pass') {
    console.log(
      `durability-writer-guard: PASS — ${outcome.result.tablesScanned} table(s) classified, ${outcome.result.registryTablesChecked} status table(s) writer-checked (invariant #1789)`,
    );
    return;
  }
  console.error(`durability-writer-guard: FAIL — ${outcome.result.findings.length} violation(s) (invariant #1789):`);
  for (const finding of outcome.result.findings) {
    console.error(`  [${finding.kind}] ${finding.table}: ${finding.detail}`);
  }
  process.exitCode = 1;
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

  reportOutcome(evaluateDurabilityWriterInvariant(snapshot, REPO_ROOT));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Belt-and-braces: main() itself should never throw (loadSnapshot and
  // evaluateDurabilityWriterInvariant both catch internally), but a bare,
  // uncaught rejection here would hit Node's unhandled-rejection default
  // (exit 1) instead of the contracted exit 2 — so catch defensively too.
  main().catch((err) => {
    console.error(
      `durability-writer-guard: INCONCLUSIVE — unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 2;
  });
}
