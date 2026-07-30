// tests/scripts/durability-writer-guard.test.ts
//
// Companion test for scripts/durability-writer-guard.ts (#1789 durability-writer
// invariant). Cases (a)-(e) per .superpowers/sdd/task-4-brief.md:
//   (a) the registry classifies every migrated table into exactly one set
//   (b) each registered status table has a terminal-failure value AND a
//       resolvable production writer
//   (c) RED-GREEN teeth: a synthetic "ok-only" status table FAILS, and a
//       synthetic reserved table without issue+reason FAILS
//   (d) recovery_runs / enrichment_runs specifically assert-pass
//   (e) sweep_runs passes as the one declared TRACKED_RESERVED exception
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  scanDurabilityWriterInvariant,
  evaluateDurabilityWriterInvariant,
  type SchemaSnapshot,
} from '../../scripts/durability-writer-guard.ts';
import {
  KNOWN_STATUS_TABLES,
  NON_STATUS_TABLES,
  RESERVED_TABLES,
  REGISTRY,
  TRACKED_RESERVED,
  TRACKED_UNWIRED_TERMINAL,
  SELF_PROVISIONED,
  DISCOVERY_EXCLUSIONS,
} from '../../scripts/lib/durability-status-registry.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const guardPath = resolve(repoRoot, 'scripts/durability-writer-guard.ts');

// Memoized: migratedSchemaSnapshot() replays all migrations against a fresh
// in-memory DB (~25ms). 9 `it`s across this file need the real schema and
// none of them mutate the returned Map (read-only consumers), so compute it
// once and reuse the same Map instead of replaying 45 migrations 9 times.
let realSnapshotPromise: Promise<SchemaSnapshot> | null = null;
function loadRealSnapshot(): Promise<SchemaSnapshot> {
  if (!realSnapshotPromise) {
    realSnapshotPromise = (async () => {
      const mod = (await import(pathToFileURL(resolve(repoRoot, 'src/core/database.ts')).href)) as {
        migratedSchemaSnapshot: () => SchemaSnapshot;
      };
      return mod.migratedSchemaSnapshot();
    })();
  }
  return realSnapshotPromise;
}

describe('durability-writer-guard — registry completeness (case a)', () => {
  it('classifies every migrated table into exactly one of KNOWN_STATUS/NON_STATUS/RESERVED via the guard scan', async () => {
    const snapshot = await loadRealSnapshot();
    expect(snapshot.size).toBeGreaterThan(0);
    const result = scanDurabilityWriterInvariant(snapshot, repoRoot);
    const completenessFindings = result.findings.filter(
      (f) => f.kind === 'unclassified-table' || f.kind === 'overlapping-classification',
    );
    expect(completenessFindings).toHaveLength(0);
  });

  it('has no table with membership count other than exactly 1 (direct set check)', async () => {
    const snapshot = await loadRealSnapshot();
    for (const table of snapshot.keys()) {
      const memberships = [
        KNOWN_STATUS_TABLES.has(table),
        NON_STATUS_TABLES.has(table),
        RESERVED_TABLES.has(table),
      ].filter(Boolean).length;
      expect(memberships, `table '${table}' should belong to exactly one set, saw ${memberships}`).toBe(1);
    }
  });
});

describe('durability-writer-guard — per-table writer resolution (case b)', () => {
  it('every REGISTRY entry has a non-empty terminalFailureValues and a resolvable writer', async () => {
    const snapshot = await loadRealSnapshot();
    const result = scanDurabilityWriterInvariant(snapshot, repoRoot);
    const perTableFindings = result.findings.filter((f) =>
      [
        'missing-terminal-values',
        'missing-writer-sites',
        'writer-site-not-src',
        'writer-site-missing',
        'writer-literal-not-found',
      ].includes(f.kind),
    );
    expect(perTableFindings).toHaveLength(0);
    expect(result.registryTablesChecked).toBe(REGISTRY.length);
  });
});

describe('durability-writer-guard — RED-GREEN teeth (case c)', () => {
  it('FAILS a synthetic "ok-only" status table with no declared terminal-failure value', () => {
    const snapshot: SchemaSnapshot = new Map([
      ['synthetic_ok_only', { createSql: "CREATE TABLE synthetic_ok_only (id INTEGER PRIMARY KEY, status TEXT NOT NULL DEFAULT 'ok')", indexes: [] }],
    ]);
    const result = scanDurabilityWriterInvariant(snapshot, repoRoot, {
      registry: [
        {
          table: 'synthetic_ok_only',
          statusColumn: 'status',
          vocabulary: ['ok'],
          vocabularySource: 'literal',
          terminalFailureValues: [], // the defect: no failure value declared at all
          writerSites: ['src/core/durability.ts'],
        },
      ],
      trackedReserved: [],
      knownStatusTables: new Set(['synthetic_ok_only']),
      nonStatusTables: new Set(),
      reservedTables: new Set(),
      nonStatusJustifications: {},
    });
    expect(result.findings.filter((f) => f.table === 'synthetic_ok_only' && f.kind === 'missing-terminal-values')).toHaveLength(1);
  });

  it('FAILS a synthetic reserved table declared without issue and reason', () => {
    const snapshot: SchemaSnapshot = new Map([
      ['synthetic_reserved', { createSql: 'CREATE TABLE synthetic_reserved (id INTEGER PRIMARY KEY)', indexes: [] }],
    ]);
    const result = scanDurabilityWriterInvariant(snapshot, repoRoot, {
      registry: [],
      trackedReserved: [{ table: 'synthetic_reserved', reason: '', issue: '' }],
      knownStatusTables: new Set(),
      nonStatusTables: new Set(),
      reservedTables: new Set(['synthetic_reserved']),
      nonStatusJustifications: {},
    });
    expect(result.findings.filter((f) => f.table === 'synthetic_reserved' && f.kind === 'reserved-missing-metadata')).toHaveLength(1);
  });

  it('control: the GREEN counterpart of both synthetic cases produces no findings', () => {
    const snapshot: SchemaSnapshot = new Map([
      ['synthetic_ok_only', { createSql: "CREATE TABLE synthetic_ok_only (id INTEGER PRIMARY KEY, status TEXT NOT NULL DEFAULT 'ok')", indexes: [] }],
      ['synthetic_reserved', { createSql: 'CREATE TABLE synthetic_reserved (id INTEGER PRIMARY KEY)', indexes: [] }],
    ]);
    const result = scanDurabilityWriterInvariant(snapshot, repoRoot, {
      registry: [
        {
          table: 'synthetic_ok_only',
          statusColumn: 'status',
          vocabulary: ['ok', 'error'],
          vocabularySource: 'literal',
          terminalFailureValues: ['error'],
          writerSites: ['src/core/durability.ts'], // contains the literal 'error'
        },
      ],
      trackedReserved: [{ table: 'synthetic_reserved', reason: 'exercised only by this test', issue: '#0000' }],
      knownStatusTables: new Set(['synthetic_ok_only']),
      nonStatusTables: new Set(),
      reservedTables: new Set(['synthetic_reserved']),
      nonStatusJustifications: {},
      // This test asserts the WHOLE findings array is empty, so the
      // self-provisioned discovery check (1b) — which otherwise defaults to
      // a REAL scan of this repo's actual src/ tree, regardless of the tiny
      // synthetic snapshot above — must be suppressed here, or every real
      // table the synthetic snapshot doesn't mention would spuriously report
      // as "unregistered". selfProvisioned/discoveryExclusions are left at
      // their real defaults deliberately: those still read the real (clean)
      // module files, proving this override doesn't silently hide a genuine
      // self-provisioned-entry problem, only the unrelated discovery noise.
      discovered: new Map(),
    });
    expect(result.findings).toHaveLength(0);
  });

  it('FAILS an unclassified table absent from all three sets', () => {
    const snapshot: SchemaSnapshot = new Map([
      ['synthetic_unregistered', { createSql: 'CREATE TABLE synthetic_unregistered (id INTEGER PRIMARY KEY)', indexes: [] }],
    ]);
    const result = scanDurabilityWriterInvariant(snapshot, repoRoot, {
      registry: [],
      trackedReserved: [],
      knownStatusTables: new Set(),
      nonStatusTables: new Set(),
      reservedTables: new Set(),
      nonStatusJustifications: {},
    });
    expect(result.findings.filter((f) => f.table === 'synthetic_unregistered' && f.kind === 'unclassified-table')).toHaveLength(1);
  });

  it('FAILS (anti-dodge) a NON_STATUS table with a status-shaped column and no justification', () => {
    const snapshot: SchemaSnapshot = new Map([
      ['synthetic_hidden_status', { createSql: "CREATE TABLE synthetic_hidden_status (id INTEGER PRIMARY KEY, state TEXT NOT NULL DEFAULT 'ok')", indexes: [] }],
    ]);
    const result = scanDurabilityWriterInvariant(snapshot, repoRoot, {
      registry: [],
      trackedReserved: [],
      knownStatusTables: new Set(),
      nonStatusTables: new Set(['synthetic_hidden_status']),
      reservedTables: new Set(),
      nonStatusJustifications: {}, // the defect: no justification for the 'state' column
    });
    expect(result.findings.filter((f) => f.table === 'synthetic_hidden_status' && f.kind === 'anti-dodge-unjustified')).toHaveLength(1);
  });

  it('FAILS (anti-dodge fail-closed fallback) a NON_STATUS table whose createSql cannot be standalone-replayed but whose DDL text has a status-shaped column and no justification', () => {
    // Gap-analysis finding: columnsByTable's replay-failure catch used to set
    // columns.set(table, []) unconditionally, so a migrated table that fails
    // standalone replay (today only the 4 FTS5 shadow tables, via node:sqlite's
    // reserved-name rejection) looked column-less to check (2b) and silently
    // skipped anti-dodge — exactly the "let a status-bearing table hide" hole
    // (2b) exists to close. A `sqlite_`-prefixed name reproduces the identical
    // "object name reserved for internal use" replay failure deterministically,
    // without depending on the FTS5 module.
    const snapshot: SchemaSnapshot = new Map([
      [
        'sqlite_synthetic_unreplayable',
        {
          createSql:
            "CREATE TABLE sqlite_synthetic_unreplayable (id INTEGER PRIMARY KEY, status TEXT NOT NULL DEFAULT 'ok')",
          indexes: [],
        },
      ],
    ]);
    const result = scanDurabilityWriterInvariant(snapshot, repoRoot, {
      registry: [],
      trackedReserved: [],
      knownStatusTables: new Set(),
      nonStatusTables: new Set(['sqlite_synthetic_unreplayable']),
      reservedTables: new Set(),
      nonStatusJustifications: {}, // the defect: no justification, even though replay failed
      discovered: new Map(), // isolate from the real repo's discovery scan
    });
    expect(
      result.findings.filter((f) => f.table === 'sqlite_synthetic_unreplayable' && f.kind === 'anti-dodge-unjustified'),
    ).toHaveLength(1);
  });

  it('control: a justified NON_STATUS table whose createSql cannot be standalone-replayed produces no anti-dodge finding', () => {
    const snapshot: SchemaSnapshot = new Map([
      [
        'sqlite_synthetic_unreplayable_justified',
        {
          createSql:
            "CREATE TABLE sqlite_synthetic_unreplayable_justified (id INTEGER PRIMARY KEY, status TEXT NOT NULL DEFAULT 'ok')",
          indexes: [],
        },
      ],
    ]);
    const result = scanDurabilityWriterInvariant(snapshot, repoRoot, {
      registry: [],
      trackedReserved: [],
      knownStatusTables: new Set(),
      nonStatusTables: new Set(['sqlite_synthetic_unreplayable_justified']),
      reservedTables: new Set(),
      nonStatusJustifications: { sqlite_synthetic_unreplayable_justified: 'exercised only by this test' },
      discovered: new Map(),
    });
    expect(
      result.findings.filter((f) => f.table === 'sqlite_synthetic_unreplayable_justified'),
    ).toHaveLength(0);
  });

  it('the real repo (the 4 FTS5 shadow tables) still passes anti-dodge with the fallback in place', async () => {
    // Regression guard for the fallback itself: the 4 FTS5 shadow tables
    // (messages_fts_data/idx/docsize/config) are NON_STATUS and fail
    // standalone replay in the real schema too — their DDL text (id/block,
    // id/sz, segid/term/pgno, k/v) must not match the status-shaped-column
    // regex, so they must not regress into anti-dodge findings now that the
    // fallback actually scans their DDL text instead of skipping them.
    const snapshot = await loadRealSnapshot();
    const result = scanDurabilityWriterInvariant(snapshot, repoRoot);
    const ftsShadowTables = ['messages_fts_data', 'messages_fts_idx', 'messages_fts_docsize', 'messages_fts_config'];
    for (const table of ftsShadowTables) {
      expect(snapshot.has(table), `expected '${table}' to be present in the real migrated snapshot`).toBe(true);
    }
    expect(result.findings.filter((f) => ftsShadowTables.includes(f.table) && f.kind === 'anti-dodge-unjustified')).toHaveLength(0);
  });
});

describe('durability-writer-guard — recovery_runs / enrichment_runs assert-pass (case d)', () => {
  it('recovery_runs (migration 45 status column) passes with no findings', async () => {
    const snapshot = await loadRealSnapshot();
    const entry = REGISTRY.find((e) => e.table === 'recovery_runs');
    expect(entry).toBeDefined();
    const result = scanDurabilityWriterInvariant(snapshot, repoRoot, { registry: entry ? [entry] : [] });
    expect(result.findings.filter((f) => f.table === 'recovery_runs')).toHaveLength(0);
  });

  it('enrichment_runs (error-column failure catch) passes with no findings', async () => {
    const snapshot = await loadRealSnapshot();
    const entry = REGISTRY.find((e) => e.table === 'enrichment_runs');
    expect(entry).toBeDefined();
    const result = scanDurabilityWriterInvariant(snapshot, repoRoot, { registry: entry ? [entry] : [] });
    expect(result.findings.filter((f) => f.table === 'enrichment_runs')).toHaveLength(0);
  });
});

describe('durability-writer-guard — sweep_runs reserved exception (case e)', () => {
  it('TRACKED_RESERVED declares exactly sweep_runs with issue #1789 and a non-empty reason', () => {
    expect(TRACKED_RESERVED).toHaveLength(1);
    expect(TRACKED_RESERVED[0]?.table).toBe('sweep_runs');
    expect(TRACKED_RESERVED[0]?.issue).toBe('#1789');
    expect((TRACKED_RESERVED[0]?.reason ?? '').trim().length).toBeGreaterThan(0);
  });

  it('sweep_runs passes the guard as the declared reserved exception', async () => {
    const snapshot = await loadRealSnapshot();
    const result = scanDurabilityWriterInvariant(snapshot, repoRoot);
    expect(result.findings.filter((f) => f.table === 'sweep_runs')).toHaveLength(0);
  });
});

describe('durability-writer-guard — beads unwired-terminal declared exception', () => {
  // Coordinator-confirmed finding (independently verified): beads.status='failed'
  // is declared (SQL CHECK schema.ts:10 + BeadStatus union + TERMINAL beads.ts:18)
  // but has NO production writer — update_bead is status-protected, transition()
  // callers are complete/cancel/active only. Fail-closed doctrine: an undeclared
  // violation must FAIL; a known one must be a DECLARED exception
  // (TRACKED_UNWIRED_TERMINAL), not a pass-by-technicality.

  it('(i) beads WITHOUT its TRACKED_UNWIRED_TERMINAL entry FAILS the guard', async () => {
    const snapshot = await loadRealSnapshot();
    const beadsEntry = REGISTRY.find((e) => e.table === 'beads');
    expect(beadsEntry).toBeDefined();
    const result = scanDurabilityWriterInvariant(snapshot, repoRoot, {
      registry: beadsEntry ? [beadsEntry] : [],
      trackedReserved: [],
      trackedUnwiredTerminal: [], // the defect: no declared exception for beads' 'failed'
    });
    expect(
      result.findings.filter(
        (f) => f.table === 'beads' && (f.kind === 'missing-writer-sites' || f.kind === 'writer-literal-not-found'),
      ),
    ).toHaveLength(1);
  });

  it('(ii) beads WITH the real TRACKED_UNWIRED_TERMINAL entry passes with no findings', async () => {
    const snapshot = await loadRealSnapshot();
    const beadsEntry = REGISTRY.find((e) => e.table === 'beads');
    expect(beadsEntry).toBeDefined();
    const result = scanDurabilityWriterInvariant(snapshot, repoRoot, {
      registry: beadsEntry ? [beadsEntry] : [],
      trackedReserved: [],
      trackedUnwiredTerminal: TRACKED_UNWIRED_TERMINAL, // the real, declared exception
    });
    expect(result.findings.filter((f) => f.table === 'beads')).toHaveLength(0);
  });

  it('(iii) a TRACKED_UNWIRED_TERMINAL entry missing issue or reason FAILS', () => {
    const snapshot: SchemaSnapshot = new Map([
      ['synthetic_unwired', { createSql: "CREATE TABLE synthetic_unwired (id INTEGER PRIMARY KEY, status TEXT NOT NULL DEFAULT 'ok')", indexes: [] }],
    ]);
    const result = scanDurabilityWriterInvariant(snapshot, repoRoot, {
      registry: [],
      trackedReserved: [],
      trackedUnwiredTerminal: [{ table: 'synthetic_unwired', terminalValue: 'failed', reason: '', issue: '' }],
      knownStatusTables: new Set(),
      nonStatusTables: new Set(['synthetic_unwired']),
      reservedTables: new Set(),
      nonStatusJustifications: { synthetic_unwired: 'exercised only by this test' },
    });
    expect(
      result.findings.filter((f) => f.table === 'synthetic_unwired' && f.kind === 'unwired-terminal-missing-metadata'),
    ).toHaveLength(1);
  });

  it('the real registry declares exactly one TRACKED_UNWIRED_TERMINAL entry: beads/failed, issue #1789', () => {
    expect(TRACKED_UNWIRED_TERMINAL).toHaveLength(1);
    expect(TRACKED_UNWIRED_TERMINAL[0]?.table).toBe('beads');
    expect(TRACKED_UNWIRED_TERMINAL[0]?.terminalValue).toBe('failed');
    expect(TRACKED_UNWIRED_TERMINAL[0]?.issue).toBe('#1789');
    expect((TRACKED_UNWIRED_TERMINAL[0]?.reason ?? '').trim().length).toBeGreaterThan(0);
  });
});

describe('durability-writer-guard — self-provisioned discovery (completeness blind-spot fix)', () => {
  // Gap-analysis finding: six real, live tables (agent_fallback_state,
  // agent_handoff_artifacts, chat_model_preference, command_surface_prefs,
  // pending_poll_decisions, standby_notice) are created OUTSIDE the migration
  // registry by self-managed ensureXSchema() functions and are invisible to
  // migratedSchemaSnapshot() — while the registry/guard used to claim
  // completeness over "every table". Check (1b) closes the blind spot with a
  // static CREATE TABLE discovery scan across src/**/*.ts.

  it('FAILS a synthetic discovered-but-unregistered table', () => {
    const result = scanDurabilityWriterInvariant(new Map(), repoRoot, {
      registry: [],
      trackedReserved: [],
      trackedUnwiredTerminal: [],
      knownStatusTables: new Set(),
      nonStatusTables: new Set(),
      reservedTables: new Set(),
      nonStatusJustifications: {},
      selfProvisioned: [],
      discoveryExclusions: [],
      // Injected discovery result — proves the check independent of a real
      // disk scan: this table is discovered (as if a real `CREATE TABLE`
      // were found under src/) but is nowhere in the snapshot, SELF_PROVISIONED,
      // or DISCOVERY_EXCLUSIONS.
      discovered: new Map([['synthetic_discovered_unregistered', ['src/fake/module.ts']]]),
    });
    expect(
      result.findings.filter(
        (f) => f.table === 'synthetic_discovered_unregistered' && f.kind === 'unregistered-self-provisioned-table',
      ),
    ).toHaveLength(1);
  });

  it('FAILS a synthetic self-provisioned entry whose DDL has a status-shaped column and no justification', () => {
    // Points a synthetic SELF_PROVISIONED entry at a REAL, existing module
    // (src/core/durability.ts) under a table name that does NOT literally
    // appear as `CREATE TABLE <name>` there, so DDL extraction falls back to
    // scanning the whole file — which genuinely contains status-shaped text
    // (e.g. ToolCallStatus), exercising the anti-dodge path without needing
    // a throwaway fixture file on disk.
    const result = scanDurabilityWriterInvariant(new Map(), repoRoot, {
      registry: [],
      trackedReserved: [],
      trackedUnwiredTerminal: [],
      knownStatusTables: new Set(),
      nonStatusTables: new Set(),
      reservedTables: new Set(),
      nonStatusJustifications: {},
      discovered: new Map(),
      selfProvisioned: [
        {
          table: 'synthetic_self_provisioned_no_justification',
          module: 'src/core/durability.ts',
          reason: 'exercised only by this test',
          // the defect: no justification, even though the module's text is status-shaped
        },
      ],
      discoveryExclusions: [],
    });
    expect(
      result.findings.filter(
        (f) =>
          f.table === 'synthetic_self_provisioned_no_justification' &&
          f.kind === 'self-provisioned-anti-dodge-unjustified',
      ),
    ).toHaveLength(1);
  });

  it('control: a justified self-provisioned status-shaped column produces no anti-dodge finding', () => {
    const result = scanDurabilityWriterInvariant(new Map(), repoRoot, {
      registry: [],
      trackedReserved: [],
      trackedUnwiredTerminal: [],
      knownStatusTables: new Set(),
      nonStatusTables: new Set(),
      reservedTables: new Set(),
      nonStatusJustifications: {},
      discovered: new Map(),
      selfProvisioned: [
        {
          table: 'synthetic_self_provisioned_justified',
          module: 'src/core/durability.ts',
          reason: 'exercised only by this test',
          justification: 'exercised only by this test — the status-shaped text is not a real column of this synthetic table',
        },
      ],
      discoveryExclusions: [],
    });
    expect(
      result.findings.filter((f) => f.table === 'synthetic_self_provisioned_justified'),
    ).toHaveLength(0);
  });

  it('the real SELF_PROVISIONED registry (all 11 tables) passes clean against the real repo', async () => {
    const snapshot = await loadRealSnapshot();
    const result = scanDurabilityWriterInvariant(snapshot, repoRoot, { registry: [], trackedReserved: [], trackedUnwiredTerminal: [] });
    const selfProvisionedFindings = result.findings.filter((f) =>
      SELF_PROVISIONED.some((entry) => entry.table === f.table),
    );
    expect(selfProvisionedFindings).toHaveLength(0);
  });

  it('the real discovery scan against the real repo produces no unregistered-self-provisioned-table findings', async () => {
    const snapshot = await loadRealSnapshot();
    const result = scanDurabilityWriterInvariant(snapshot, repoRoot, { registry: [], trackedReserved: [], trackedUnwiredTerminal: [] });
    expect(result.findings.filter((f) => f.kind === 'unregistered-self-provisioned-table')).toHaveLength(0);
  });

  it('the real discovery scan reports a non-zero discoveredTableCount (non-vacuity precondition)', async () => {
    // A real checkout has dozens of CREATE TABLE occurrences under src/
    // (migrated tables plus the 6 self-provisioned ones); this pins that the
    // scan genuinely ran, so evaluateDurabilityWriterInvariant's discovery
    // floor (see the exit-code contract suite below) never misfires against
    // the real repo.
    const snapshot = await loadRealSnapshot();
    const result = scanDurabilityWriterInvariant(snapshot, repoRoot, { registry: [], trackedReserved: [], trackedUnwiredTerminal: [] });
    expect(result.discoveredTableCount).toBeGreaterThan(0);
  });

  it('SELF_PROVISIONED declares exactly the eleven known self-provisioned tables', () => {
    const tables = SELF_PROVISIONED.map((e) => e.table).sort();
    expect(tables).toEqual(
      [
        'agent_fallback_state',
        'agent_handoff_artifacts',
        'chat_model_preference',
        'command_surface_prefs',
        'events',
        'incidents',
        'meta',
        'pending_poll_decisions',
        'producers',
        'standby_notice',
        'transitions',
      ].sort(),
    );
    for (const entry of SELF_PROVISIONED) {
      expect(entry.table.trim().length, `${entry.table} needs a non-empty table`).toBeGreaterThan(0);
      expect(entry.module.trim().length, `${entry.table} needs a non-empty module`).toBeGreaterThan(0);
      expect(entry.reason.trim().length, `${entry.table} needs a non-empty reason`).toBeGreaterThan(0);
    }
  });

  it('DISCOVERY_EXCLUSIONS declares only transient migration rebuild tables with reasons', () => {
    expect(DISCOVERY_EXCLUSIONS.map(({ table }) => table)).toEqual([
      'tool_calls_v50',
      'outbound_sends_v26',
      'outbound_sends_v51',
    ]);
    for (const entry of DISCOVERY_EXCLUSIONS) {
      expect(entry.reason.trim().length, `${entry.table} needs a reason`).toBeGreaterThan(0);
    }
  });
});

describe('durability-writer-guard — exit-code contract (evaluateDurabilityWriterInvariant)', () => {
  // Coordinator review finding: main() only wrapped the async loadSnapshot()
  // in try/catch; a throw inside the synchronous scan (e.g. a DatabaseSync
  // failure in columnsByTable) fell through to Node's unhandled-rejection
  // default, exit 1 — not the contracted exit 2 (inconclusive). Fail-closed
  // was preserved (never a false 0), but the exit-CODE contract was violated:
  // "I could not examine this" must read differently from "I examined it and
  // found a violation". These tests exercise the fix directly, at the
  // injectable evaluation layer, without spawning a CLI subprocess.

  it('(i) an empty snapshot is INCONCLUSIVE, not pass and not violation', () => {
    const outcome = evaluateDurabilityWriterInvariant(new Map(), repoRoot);
    expect(outcome.status).toBe('inconclusive');
    if (outcome.status === 'inconclusive') {
      expect(outcome.reason).toMatch(/zero tables/i);
    }
  });

  it('(ii) a throw inside the scan maps to INCONCLUSIVE, never a silent pass', () => {
    // A snapshot whose .keys() throws forces an exception at the very first
    // line of scanDurabilityWriterInvariant's check (1) — proving the wrapper
    // catches a throw from *inside* the scan, not just the async load.
    const throwingSnapshot = {
      size: 1,
      keys(): IterableIterator<string> {
        throw new Error('boom: simulated scan-time failure');
      },
    } as unknown as SchemaSnapshot;
    const outcome = evaluateDurabilityWriterInvariant(throwingSnapshot, repoRoot);
    expect(outcome.status).toBe('inconclusive');
    if (outcome.status === 'inconclusive') {
      expect(outcome.reason).toMatch(/scan threw/i);
      expect(outcome.reason).toMatch(/boom: simulated scan-time failure/);
    }
  });

  it('(iii) a discovery scan that found zero CREATE TABLE occurrences is INCONCLUSIVE, not pass', () => {
    // Gap-analysis finding: check (1b)'s only non-vacuity gate floored the
    // SNAPSHOT (case i above), not DISCOVERY. A missing/unreadable src/ (or,
    // as simulated here, an empty injected discovery map) makes
    // discoverCreateTableNames() return zero names — check (1b) then finds
    // zero unregistered tables and, before this fix, the guard would read
    // that as "pass" instead of "the scan never actually ran". Everything
    // else about this snapshot/registry is deliberately clean (no other
    // findings possible) so this test isolates the discovery floor: without
    // it, this would be 'pass'.
    const snapshot: SchemaSnapshot = new Map([
      ['synthetic_clean', { createSql: 'CREATE TABLE synthetic_clean (id INTEGER PRIMARY KEY)', indexes: [] }],
    ]);
    const outcome = evaluateDurabilityWriterInvariant(snapshot, repoRoot, {
      registry: [],
      trackedReserved: [],
      trackedUnwiredTerminal: [],
      knownStatusTables: new Set(['synthetic_clean']),
      nonStatusTables: new Set(),
      reservedTables: new Set(),
      nonStatusJustifications: {},
      selfProvisioned: [],
      discoveryExclusions: [],
      discovered: new Map(), // the defect being floored: nothing discovered
    });
    expect(outcome.status).toBe('inconclusive');
    if (outcome.status === 'inconclusive') {
      expect(outcome.reason).toMatch(/zero CREATE TABLE/i);
    }
  });

  it('a clean real-repo scan through the evaluation wrapper is "pass", not "violation" or "inconclusive"', async () => {
    const snapshot = await loadRealSnapshot();
    const outcome = evaluateDurabilityWriterInvariant(snapshot, repoRoot);
    expect(outcome.status).toBe('pass');
  });

  it('a real violation through the evaluation wrapper is "violation", not "inconclusive"', () => {
    const snapshot: SchemaSnapshot = new Map([
      ['synthetic_violation', { createSql: 'CREATE TABLE synthetic_violation (id INTEGER PRIMARY KEY)', indexes: [] }],
    ]);
    const outcome = evaluateDurabilityWriterInvariant(snapshot, repoRoot, {
      registry: [],
      trackedReserved: [],
      knownStatusTables: new Set(),
      nonStatusTables: new Set(),
      reservedTables: new Set(),
      nonStatusJustifications: {},
    });
    expect(outcome.status).toBe('violation');
  });
});

describe('durability-writer-guard — CLI end-to-end', () => {
  // Both assertions below need the guard's real CLI behavior on the real
  // repo; spawning the subprocess is the expensive part, so spawn once in
  // beforeAll and assert both expectations against the single result rather
  // than launching the identical process twice.
  let cli: { status: number | null; output: string };

  beforeAll(() => {
    const r = spawnSync(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', guardPath],
      { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 },
    );
    cli = { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  });

  it('exits 0 on this repo (real registry, real schema)', () => {
    expect(cli.status, `guard exited ${cli.status}; output:\n${cli.output}`).toBe(0);
  });

  it('reports how many tables it examined, so a pass is checkable', () => {
    expect(cli.output).toMatch(/\d+[^\n]{0,32}table/i);
  });
});
