/**
 * Production-reachability dead-code guard (invariant C) — issue #1871.
 *
 * COMPLEMENTS, does not replace, `tests/scripts/orphan-export-guard.test.ts`
 * (invariant A: a src export whose identifier appears NOWHERE else in the
 * src+tests corpus). Invariant A deliberately over-counts references (comments,
 * strings, and — critically — TEST imports all count), so a source module that
 * is imported ONLY by its own unit test passes A while being runtime-dead. That
 * false negative is the #1871 incident: 10 primitives merged green in a 24h
 * window with no path into the application runtime.
 *
 * Invariant C closes it: every `src/` non-test module must be REACHABLE, by
 * following import edges, from at least one DECLARED PRODUCTION ROOT — or be
 * listed in TRACKED_UNREACHABLE with an owning issue and a reason. Tests,
 * fixtures, comments, strings, and docs are never traversed (the graph starts
 * only at production roots), so test-only wiring can never make a module look
 * reachable.
 *
 * ROOTS (union of every declared entrypoint; see loadRoots):
 *   1. `deploy/source-runtime-manifest.json` entrypoints (importGraph !== false)
 *      — the authoritative "critical source entrypoints" the deploy staleness
 *      gate hashes.
 *   2. `package.json` scripts' `src/*.ts` targets (e.g. start→src/main.ts,
 *      fleet→src/fleet/standalone.ts). The manifest omits the fleet-server
 *      entry, so the union is required to avoid over-flagging src/fleet/*.
 *   3. `deploy/**` `.mjs`/`.ts` operational tooling that imports `src/`
 *      (e.g. deploy/lib/read-private-health-token.mjs → fleet/health-token-file).
 *   4. DYNAMIC_ROOTS — computed-import targets that cannot be resolved
 *      statically (see below). Empty today.
 *
 * ASSUMPTION (the guard's contract): imports are statically analyzable —
 * `ts.preProcessFile` sees static `import`, re-exports, and string-LITERAL
 * `import('...')`. A COMPUTED `import(expr)` is invisible to it. The only
 * computed import in src today is `src/bootstrap-common.ts` `import(targetModule)`,
 * whose two call-sites pass string literals `'./main.ts'` and
 * `'./transport/auth.ts'` — both already roots — so no subtree is hidden. If a
 * future computed import loads an otherwise-unreachable module, this guard will
 * false-flag it; the remedy is to register that target in DYNAMIC_ROOTS (that is
 * the acceptance criterion's "registered dynamic-loading surfaces").
 *
 * SCOPE: `src/` (the Node/TS runtime) only. `console/src` (.tsx) is a separate
 * tree not covered here, per the issue.
 *
 * FAIL MODE: this is a hard vitest assertion in the coverage suite (red CI),
 * not a warn-tier lint. A single false positive erodes trust, so the failure
 * message names the exact remedy and the file to edit.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, relative, join, dirname } from 'node:path';
import ts from 'typescript';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const SRC_DIR = resolve(REPO_ROOT, 'src');
const abs = (p: string): string => resolve(REPO_ROOT, p);
const repoRel = (p: string): string => relative(REPO_ROOT, p).replaceAll('\\', '/');

/** Excludes `src/**\/testing/**` — test-support harness modules that live under
 * src/ but are consumed only by tests (not production wiring, per acceptance
 * criteria). */
const TESTING_DIR_RE = /(^|\/)testing\//;

/**
 * Computed-import targets that cannot be resolved from a string literal and are
 * genuine runtime entrypoints. Format: repo-relative `src/...ts` path with a
 * justifying comment. EMPTY today (the one computed import in src passes
 * already-root literals — see file header). Add an entry only for a proven
 * dynamically-loaded runtime module, never to silence a real orphan.
 */
const DYNAMIC_ROOTS: readonly string[] = [
  // e.g. "src/plugins/foo.ts", // loaded via import(`./plugins/${name}.ts`)
];

interface TrackedEntry {
  path: string;
  issue: string;
  reason: string;
}

/**
 * Modules with NO path from any production root today, explicitly dispositioned
 * (the acceptance criterion's "separately track" option — non-silent). This is
 * an inventory + ratchet baseline: the guard fails on any NEW unreachable
 * module, and the stale-check (below) force-graduates an entry the moment its
 * owning issue wires it. Derived live from the reachability graph on main, not
 * hand-copied from the issue (the issue's list was already stale — e.g.
 * typing-start-guard has since been wired).
 */
const TRACKED_UNREACHABLE: readonly TrackedEntry[] = [
  // 24h-window primitives (#1871 inventory): landed test-only-wired, pending
  // wiring or removal per each owning issue. Wiring is out of scope for #1871.
  { path: 'src/core/retry-runner.ts', issue: '#1817', reason: 'test-only-wired primitive; no runtime importer' },
  { path: 'src/lib/bounded-timeout.ts', issue: '#1816', reason: 'test-only-wired primitive; no runtime importer' },
  { path: 'src/lib/credential-diagnostics.ts', issue: '#1813', reason: 'test-only-wired primitive; no runtime importer' },
  { path: 'src/lib/fallback-transition.ts', issue: '#1820', reason: 'test-only-wired primitive; no runtime importer' },
  { path: 'src/lib/inbound-debouncer.ts', issue: '#1822', reason: 'test-only-wired primitive; no runtime importer' },
  { path: 'src/lib/keyed-async-queue.ts', issue: '#1815', reason: 'test-only-wired primitive; no runtime importer' },
  { path: 'src/lib/status-reaction-controller.ts', issue: '#1823', reason: 'test-only-wired primitive; no runtime importer' },
  { path: 'src/lib/text-chunking.ts', issue: '#1821', reason: 'test-only-wired primitive; no runtime importer' },
  // auth-loss durability signal modules: the store now has a production writer —
  // HealthPoller records the durable row on a confirmed logged_out (#1786) — so it
  // graduated out of this list. The transition-controller/resolver subtree and the
  // mode-bucket modules remain unwired; nothing production imports them yet.
  // Tracked by the durability-writer-invariant work (#1789); graduate each when wired.
  { path: 'src/fleet/auth-loss-mode-bucket-artifact-contract.ts', issue: '#1786/#1789', reason: 'auth-loss durability module; no runtime importer' },
  { path: 'src/fleet/auth-loss-mode-bucket-contract.ts', issue: '#1786/#1789', reason: 'auth-loss durability module; no runtime importer' },
  { path: 'src/fleet/auth-loss-mode-bucket-mapper.ts', issue: '#1786/#1789', reason: 'auth-loss durability module; no runtime importer' },
  { path: 'src/fleet/auth-loss-mode-bucket-producer-artifact.ts', issue: '#1786/#1789', reason: 'auth-loss durability module; no runtime importer' },
  { path: 'src/fleet/auth-loss-mode-bucket-producer.ts', issue: '#1786/#1789', reason: 'auth-loss durability module; no runtime importer' },
  { path: 'src/fleet/auth-loss-signal-resolver.ts', issue: '#1786/#1789', reason: 'auth-loss durability module; no runtime importer' },
  { path: 'src/fleet/auth-loss-signal-transition-controller.ts', issue: '#1786/#1789', reason: 'auth-loss transition controller; no runtime importer (terminal-logout path never calls it)' },
  // Other unwired modules surfaced by this guard's first run:
  { path: 'src/fleet/provider-parity.ts', issue: '#1867', reason: 'provider-parity report module is test-only-wired; parity guard undeployed (#1867)' },
  { path: 'src/core/recovery-catchup-closure.ts', issue: '#1871', reason: 'recovery-catchup closure is test-only-wired; not imported by any runtime recovery root — needs wiring or removal (surfaced by this guard)' },
  // Durable background work (Work Ledger + Results Outbox). PR1a lands the schema
  // and store DELIBERATELY unwired so it can be reviewed and verified on its own;
  // PR1b adds the registration write-path at the worker spawn sites and the
  // delivery daemon, and graduates this entry in the same PR.
  { path: 'src/core/background-work-store.ts', issue: '#2279', reason: 'PR1a lands schema+store unwired by design; registration write-path and delivery daemon land in PR1b (#2279)' },
  { path: 'src/runtimes/chat/enrichment/contradiction.ts', issue: '#1871', reason: 'enrichment pipeline ported but never wired into a runtime chat root; unreachable island with upserter.ts' },
  { path: 'src/runtimes/chat/enrichment/upserter.ts', issue: '#1871', reason: 'enrichment pipeline ported but never wired into a runtime chat root; island head (imports contradiction.ts)' },
  // command-surface (/config) feature cluster in runtimes/agent: built but never
  // wired into any runtime agent root; no production importer of any member
  // (surfaced by this guard). Dead-until-wired island.
  { path: 'src/runtimes/agent/command-surface-config.ts', issue: '#1871', reason: 'command-surface config module; no production importer (imports command-registry + command-surface-prefs-db); unwired island — surfaced by this guard' },
  { path: 'src/runtimes/agent/command-surface-prefs-db.ts', issue: '#1871', reason: 'command-surface prefs store; imported only (type-only) by the also-unreachable command-surface-config; no runtime path — surfaced by this guard' },
  // Signal + iMessage transport foundation (PR #1975): adapter contracts + types +
  // port interfaces land first; factory.ts has stub case arms that throw until the
  // Signal adapter, port, and types are reachable through the live factory
  // composition root and no longer belong in this exception inventory.
  // imessage adapter/port/types graduated out of TRACKED_UNREACHABLE: the
  // factory now constructs the imsg/bluebubbles ports (this branch), so all
  // three are reachable from a production root.
];

// ---------------------------------------------------------------------------
// Pure core: BFS reachability closure over an abstract module graph.
// Extracted so the four acceptance fixtures below can test it against synthetic
// in-memory maps with no filesystem dependency.
// ---------------------------------------------------------------------------
function computeReachability(rootIds: string[], edgesOf: (id: string) => string[]): Set<string> {
  const reachable = new Set<string>();
  const queue: string[] = [];
  for (const r of rootIds) {
    if (!reachable.has(r)) {
      reachable.add(r);
      queue.push(r);
    }
  }
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    for (const next of edgesOf(cur)) {
      if (!reachable.has(next)) {
        reachable.add(next);
        queue.push(next);
      }
    }
  }
  return reachable;
}

// ---------------------------------------------------------------------------
// Real-graph wiring.
// ---------------------------------------------------------------------------

/** Resolve a RELATIVE import specifier from `fromFile` to a concrete .ts file,
 * honouring NodeNext (explicit extensions, `.js`→`.ts`, `/index.ts`). Bare
 * specifiers (npm / node:) return null — external, not part of src reachability. */
function resolveRelative(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), spec);
  const candidates: string[] = [];
  if (base.endsWith('.ts')) candidates.push(base);
  if (base.endsWith('.js')) candidates.push(`${base.slice(0, -3)}.ts`);
  candidates.push(`${base}.ts`);
  candidates.push(join(base, 'index.ts'));
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

/** Import edges out of a file: static imports, re-exports, and string-literal
 * dynamic imports, resolved to concrete .ts files. */
function edgesOfFile(file: string): string[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const info = ts.preProcessFile(text, /*readImportFiles*/ true, /*detectJavaScriptImports*/ true);
  const edges: string[] = [];
  for (const imported of info.importedFiles) {
    const target = resolveRelative(file, imported.fileName);
    if (target) edges.push(target);
  }
  return edges;
}

/** Recursively collect files with any of `exts` under `dir` (skips node_modules). */
function collectFiles(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFiles(full, exts));
    } else if (entry.isFile() && exts.some((e) => entry.name.endsWith(e)) && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Every declared production root (see file header, categories 1–4). */
function loadRoots(): string[] {
  const roots = new Set<string>();

  // 1. deploy/source-runtime-manifest.json entrypoints
  const manifestPath = abs('deploy/source-runtime-manifest.json');
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      entrypoints?: Array<{ path: string; importGraph?: boolean }>;
    };
    for (const e of manifest.entrypoints ?? []) {
      if (e.importGraph !== false) roots.add(abs(e.path));
    }
  }

  // 2. package.json script src/*.ts targets
  const pkg = JSON.parse(readFileSync(abs('package.json'), 'utf8')) as { scripts?: Record<string, string> };
  for (const cmd of Object.values(pkg.scripts ?? {})) {
    for (const m of String(cmd).matchAll(/\b(src\/[A-Za-z0-9/_-]+\.ts)\b/g)) {
      roots.add(abs(m[1]));
    }
  }

  // 3. deploy/ operational tooling (.mjs/.ts) that imports src/
  for (const f of collectFiles(abs('deploy'), ['.mjs', '.ts'])) {
    if (f.endsWith('.d.ts')) continue;
    if (edgesOfFile(f).some((e) => e.startsWith(`${SRC_DIR}/`))) roots.add(f);
  }

  // 4. registered dynamic-loading surfaces
  for (const p of DYNAMIC_ROOTS) roots.add(abs(p));

  return [...roots].filter((r) => existsSync(r));
}

/** All src/ non-test, non-.d.ts, non-`testing/` modules — the population that
 * must be reachable-or-tracked. */
function collectSrcModules(): string[] {
  return collectFiles(SRC_DIR, ['.ts'])
    .filter((f) => !f.endsWith('.test.ts'))
    .filter((f) => !TESTING_DIR_RE.test(repoRel(f)));
}

// Memoise the (moderately expensive) real-graph closure — reused by 3 specs.
let cachedReachable: Set<string> | null = null;
function reachableSet(): Set<string> {
  if (cachedReachable === null) {
    cachedReachable = computeReachability(loadRoots(), edgesOfFile);
  }
  return cachedReachable;
}

// ---------------------------------------------------------------------------
// Acceptance fixtures — pure core against synthetic graphs (the four cases the
// issue enumerates).
// ---------------------------------------------------------------------------
describe('computeReachability (pure) — #1871 acceptance fixtures', () => {
  const graph: Record<string, string[]> = {
    root: ['wired'],
    wired: ['deep'],
    deep: [],
    testOnlyModule: [], // only a (non-root) test node would point here
    testNode: ['testOnlyModule'],
    islandA: ['islandB'],
    islandB: ['islandA'],
    dynRoot: ['dynTarget'],
    dynTarget: [],
  };
  const edges = (id: string): string[] => graph[id] ?? [];

  it('rejects a module reached only from a test, not from a production root', () => {
    const r = computeReachability(['root'], edges);
    expect(r.has('testOnlyModule')).toBe(false);
  });

  it('rejects an unreachable island (A↔B, neither reachable from a root)', () => {
    const r = computeReachability(['root'], edges);
    expect(r.has('islandA')).toBe(false);
    expect(r.has('islandB')).toBe(false);
  });

  it('accepts a module reachable via a real production path (root→wired→deep)', () => {
    const r = computeReachability(['root'], edges);
    expect(r.has('wired')).toBe(true);
    expect(r.has('deep')).toBe(true);
  });

  it('accepts a module reachable via a registered dynamic-loading root', () => {
    const r = computeReachability(['dynRoot'], edges);
    expect(r.has('dynTarget')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Real-graph invariant.
// ---------------------------------------------------------------------------
describe('Production-reachability dead-code guard (invariant C, #1871)', () => {
  it('resolves at least the manifest + fleet-server production roots', () => {
    const roots = loadRoots().map(repoRel);
    // Sanity: the two process entrypoints must be present, else the graph is bogus.
    expect(roots).toContain('src/main.ts');
    expect(roots).toContain('src/fleet/standalone.ts');
  }, 60_000);

  it('every src/ non-test module is reachable from a declared production root, or explicitly tracked', () => {
    const reachable = reachableSet();
    const tracked = new Set(TRACKED_UNREACHABLE.map((t) => abs(t.path)));
    const orphans = collectSrcModules()
      .filter((f) => !reachable.has(f) && !tracked.has(f))
      .map(repoRel)
      .sort();

    expect(
      orphans,
      `Unreachable src module(s) — no import path from any declared production ` +
        `root (deploy/source-runtime-manifest.json entrypoints, package.json ` +
        `script targets, or deploy/ tooling). Each is dead-until-wired. Fix each: ` +
        `wire it into a runtime path, remove it, or — if intentionally unwired — ` +
        `add it to TRACKED_UNREACHABLE in ` +
        `tests/scripts/orphan-reachability-guard.test.ts with an issue and reason:\n` +
        orphans.map((o) => `  • ${o}`).join('\n'),
    ).toEqual([]);
  }, 60_000);

  it('positive control: a genuinely-wired module (self-mention-strip.ts) is reachable', () => {
    // Regression for the issue's positive control (#1854, imported by core/ingest.ts).
    expect(reachableSet().has(abs('src/lib/self-mention-strip.ts'))).toBe(true);
  }, 60_000);

  it('TRACKED_UNREACHABLE has no stale entries (each path exists AND is still unreachable)', () => {
    const reachable = reachableSet();
    const stale: string[] = [];
    for (const t of TRACKED_UNREACHABLE) {
      const p = abs(t.path);
      if (!existsSync(p)) {
        stale.push(`${t.path} — file no longer exists; remove this tracked entry`);
      } else if (reachable.has(p)) {
        stale.push(
          `${t.path} — now reachable from a production root (${t.issue} likely wired it); ` +
            `graduate it: remove from TRACKED_UNREACHABLE`,
        );
      }
    }
    expect(stale, `Stale TRACKED_UNREACHABLE entries:\n${stale.map((s) => `  • ${s}`).join('\n')}`).toEqual([]);
  }, 60_000);
});
