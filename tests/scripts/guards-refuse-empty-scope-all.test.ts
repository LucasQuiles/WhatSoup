/**
 * Every guard, classified — the vacuity ratchet across the WHOLE guard surface.
 *
 * `guards-refuse-empty-scope.test.ts` pins the FOUR guards named in the original finding.
 * This is the generalisation: it derives the guard list from package.json (the single source
 * of truth) and asserts that EVERY `guard:*` script is classified by how it takes scope, so a
 * 57th guard cannot land unclassified, and a guard cannot silently regress from "refuses an
 * empty tree" back to "certifies it" — the gap that existed from 2026-07-22 until #2102, and
 * that a hand-run sweep (run twice, then wrong once) never actually closed.
 *
 * BOTH FILES COEXIST BY DESIGN — do not fold one into the other. The two overlap only on the
 * bare "exit 2 on an empty tree" assertion for those four guards; their jobs differ. The
 * original is the DEEP behavioural spec for the four exemplars — it also pins the decoy-checkout
 * regression (dirs present but empty, which the reverted presence-proxy fix passed) and the
 * examined-count reporting, cases this file deliberately does not replicate. This file is the
 * BREADTH ratchet + resolver self-test across all 56 guards. Deep spec for the exemplars,
 * broad ratchet for the surface: the small overlap is the seam between them, not duplication.
 *
 * WHY SCOPE-INPUT, NOT "IS IT A SET-SCANNER". The empty-scope behaviour IS the check; there is
 * no need to adjudicate each guard's internals. Classification is mechanical — how does the
 * guard decide WHAT to examine — and the class decides how it is probed:
 *
 *   probe-refuse   scans the repo tree; MUST refuse an empty tree with exit 2 INCONCLUSIVE.
 *                  These are the guards with a genuine "scan a set, report clean on empty"
 *                  vacuity mode. Ten of them, incl. four fixed this session (grant-resolver,
 *                  publication --all/--release, transport-patterns, eslint-fitness's floor).
 *   probe-nonzero  reads cwd-relative required artifacts and FAILS CLOSED when they are
 *                  absent; MUST exit non-zero on an empty tree (it never certifies one).
 *   skip-*         no whole-tree vacuity mode, each with a specific verified reason:
 *                  diff-scoped (empty diff/index is legitimately nothing), host-state (roots
 *                  itself off $HOME / the script location, so cwd is irrelevant), immune
 *                  (import.meta-rooted with an internal floor + its own test), alias (delegates
 *                  to a base guard already classified), network, composite.
 *
 * THE RESOLVER. Each guard is reached through `resolveGuardCommand`, which returns the guard's
 * real entrypoint and THROWS on a pinned-node wrapper. That is the defect that produced a
 * false-green sweep this session (a regex grabbed `scripts/run-with-pinned-node.sh` and the
 * sweep spawned the wrapper, examining nothing). The self-test at the bottom runs a KNOWN
 * vacuous guard and a KNOWN refusing guard through this SAME resolver+runner, proving the
 * harness detects a false certification rather than merely proving a guard refuses.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import {
  assertRealEntrypoint,
  resolveGuardCommand,
  type Interpreter,
} from '../../scripts/lib/guard-command-resolver.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

type ScopeClass =
  | 'probe-refuse'
  | 'probe-nonzero'
  | 'skip-diff-scoped'
  | 'skip-host-state'
  | 'skip-repo-state'
  | 'skip-immune'
  | 'skip-alias'
  | 'skip-network'
  | 'skip-composite';

/** How a probed guard is pointed at an empty tree. */
type Probe = { via: 'cwd' } | { via: 'flag'; flag: '--repo' | '--root' };

interface ScopeEntry {
  class: ScopeClass;
  reason: string;
  /** Present iff class is probe-*. Defaults to cwd. */
  probe?: Probe;
}

/**
 * SSOT classification of every `guard:*` script. The `guard:` prefix is omitted from keys.
 * Reasons are anchored to observed empty-tree exits (correct sweep, 2026-07-23) so a reader
 * sees the evidence, not an assertion. A new guard MUST be added here or the ratchet fails.
 */
const SCOPE_MAP: Record<string, ScopeEntry> = {
  // ---- probe-refuse: tree-scanners that must exit 2 INCONCLUSIVE on an empty tree ----
  'fail-closed-gate': { class: 'probe-refuse', reason: 'scans shell files under cwd; refuses "no scan root"', probe: { via: 'cwd' } },
  'insecure-tempfile': { class: 'probe-refuse', reason: 'scans cwd (argv2 ?? cwd); refuses "examined 0 files" (#2102)', probe: { via: 'cwd' } },
  'no-destructive-git': { class: 'probe-refuse', reason: 'scans cwd (argv2 ?? cwd); refuses "examined 0 files" (#2102)', probe: { via: 'cwd' } },
  boundaries: { class: 'probe-refuse', reason: 'import-boundary walks cwd src; refuses "examined 0 source file(s)" (#2102)', probe: { via: 'cwd' } },
  'grant-resolver': { class: 'probe-refuse', reason: 'walks cwd/src; floor added this session — refuses "examined 0 source file(s)"', probe: { via: 'cwd' } },
  publication: { class: 'probe-refuse', reason: 'default mode all audits git ls-files; floor added this session — refuses 0 tracked files', probe: { via: 'cwd' } },
  'baseline-growth': { class: 'probe-refuse', reason: 'import.meta-rooted but takes --repo; refuses "could not resolve a merge base"', probe: { via: 'flag', flag: '--repo' } },
  'import-cycle': { class: 'probe-refuse', reason: 'import.meta-rooted but takes --repo; refuses "no tsconfig.json"', probe: { via: 'flag', flag: '--repo' } },
  'phantom-deps': { class: 'probe-refuse', reason: 'import.meta-rooted but takes --repo; refuses "implausibly small" (floors 200/300)', probe: { via: 'flag', flag: '--repo' } },
  'hooks-installed': { class: 'probe-refuse', reason: 'resolves cwd git config core.hooksPath and the checked-out hook objects; refuses ci.hooks.evidence-unavailable (exit 2) when neither a repo nor hooks resolve', probe: { via: 'cwd' } },
  'transport-patterns': { class: 'probe-refuse', reason: 'walks glob roots; takes --root; floor added this session — refuses "matched 0 files"', probe: { via: 'flag', flag: '--root' } },

  // ---- probe-nonzero: cwd-relative fixed-artifact guards that fail closed on an empty tree ----
  'doc-drift': { class: 'probe-nonzero', reason: 'reads cwd docs/ manifests; ENOENT -> non-zero', probe: { via: 'cwd' } },
  'doc-tally': { class: 'probe-nonzero', reason: 'reads cwd docs/ index; missing -> non-zero', probe: { via: 'cwd' } },
  'public-surface-drift': { class: 'probe-nonzero', reason: 'reads cwd docs/public-surface.md; ENOENT -> non-zero', probe: { via: 'cwd' } },
  'work-index': { class: 'probe-nonzero', reason: 'reads cwd work-index; ENOENT -> non-zero', probe: { via: 'cwd' } },
  'harness-maintenance': { class: 'probe-nonzero', reason: 'reads cwd deploy/managed-components.json; ENOENT -> non-zero', probe: { via: 'cwd' } },
  'agent-iteration-review': { class: 'probe-nonzero', reason: 'requires an artifact path; absent -> non-zero usage error', probe: { via: 'cwd' } },
  'pr-metadata': { class: 'probe-nonzero', reason: 'requires exactly one explicit PR body/event source plus authoritative full-OID range inputs; no source exits 2 INCONCLUSIVE', probe: { via: 'cwd' } },
  'worker-artifacts': { class: 'probe-nonzero', reason: 'reads cwd artifacts/opencode-workers; ENOENT -> non-zero', probe: { via: 'cwd' } },
  'source-runtime-drift': { class: 'probe-nonzero', reason: 'reads cwd runtime manifest; ENOENT -> non-zero', probe: { via: 'cwd' } },
  'arc-binding-drift': { class: 'probe-nonzero', reason: 'reads cwd .arc/ binding; drift/absent -> non-zero', probe: { via: 'cwd' } },
  'fleet-bot-hardening-parity': { class: 'probe-nonzero', reason: 'reads cwd fleet config; parity fail/absent -> non-zero', probe: { via: 'cwd' } },
  'bot-errors-runtime-manifest': { class: 'probe-nonzero', reason: 'reads cwd runtime manifest; absent -> non-zero', probe: { via: 'cwd' } },
  'bot-errors-critical-surface': { class: 'probe-nonzero', reason: 'reads cwd surface files; ENOENT -> non-zero', probe: { via: 'cwd' } },
  'node-pin-consistency': { class: 'probe-nonzero', reason: 'reads cwd .nvmrc/package.json pins; ENOENT -> non-zero', probe: { via: 'cwd' } },
  'instance-config': { class: 'probe-nonzero', reason: 'reads cwd instance config; absent -> non-zero (crashes ungracefully — non-vacuous but future cleanup)', probe: { via: 'cwd' } },
  'service-units': { class: 'probe-nonzero', reason: 'reads cwd service definitions; ENOENT -> non-zero', probe: { via: 'cwd' } },
  'claude-settings': { class: 'probe-nonzero', reason: 'reads cwd .claude/settings.json; absent -> drift non-zero', probe: { via: 'cwd' } },
  'agent-decision-polls': { class: 'probe-nonzero', reason: 'scans cwd; guard fails on empty -> non-zero', probe: { via: 'cwd' } },
  'safeguard-diagnostics': { class: 'probe-nonzero', reason: 'reads cwd package.json; missing -> non-zero', probe: { via: 'cwd' } },
  'guard-test-coverage': { class: 'probe-nonzero', reason: 'reads cwd guard/test inventory; ENOENT -> non-zero', probe: { via: 'cwd' } },
  'ssot-patterns': { class: 'probe-nonzero', reason: 'scans cwd tree; crashes on empty (node:fs) -> non-zero (non-vacuous but ungraceful — future cleanup)', probe: { via: 'cwd' } },
  'ring-boundary-ratchet': { class: 'probe-nonzero', reason: 'reads cwd ring config; "FAILED to run" ENOENT -> non-zero', probe: { via: 'cwd' } },
  'coverage-headroom': { class: 'probe-nonzero', reason: 'reads cwd coverage summary; ENOENT -> non-zero', probe: { via: 'cwd' } },
  'bot-errors-simulation-matrix': { class: 'probe-nonzero', reason: 'reads cwd simulation matrix; absent -> non-zero', probe: { via: 'cwd' } },
  'branch-retirement': { class: 'probe-nonzero', reason: 'no live collector wired yet; predicate always refuses -> non-zero exit, no INCONCLUSIVE token', probe: { via: 'cwd' } },

  // ---- skip-diff-scoped: empty diff/index is legitimately nothing (not a whole-tree scan) ----
  'design-system-hygiene': { class: 'skip-diff-scoped', reason: 'scans STAGED files; empty index -> legitimately clean (exit 0), not vacuity' },
  repo: { class: 'skip-diff-scoped', reason: 'default mode staged scans ADDED lines; empty index -> legitimately clean. Its whole-tree release-hygiene mode is floored + covered by MODE_PROBES below' },
  'pre-push': { class: 'skip-diff-scoped', reason: 'consumes stdin ref updates; no push context -> "delete-only" no-op, not a tree scan' },
  'semantic-quality': { class: 'skip-diff-scoped', reason: 'evaluates a push CANDIDATE receipt; candidate-unavailable -> no-op, not a tree scan' },

  // ---- skip-repo-state: scans Git topology/refs/status, not files in the tracked tree ----
  'git-estate': { class: 'skip-repo-state', reason: 'explicit snapshot/guard/baseline subcommands inspect registered Git worktrees, refs, status, and stashes; an empty tracked tree still has a real one-worktree estate, and fixture tests cover missing-baseline fail-closed behavior' },

  // ---- skip-host-state: roots off $HOME / the script location; cwd is irrelevant ----
  'unit-drift': { class: 'skip-host-state', reason: 'BASH_SOURCE-rooted; compares $HOME/.config systemd units to repo templates — empty cwd changes nothing' },
  'launchd-drift': { class: 'skip-host-state', reason: 'BASH_SOURCE-rooted; compares $HOME/Library launchd plists to templates — empty cwd changes nothing' },

  // ---- skip-immune: import.meta-rooted, CLI cannot be pointed elsewhere ----
  'lint:src': { class: 'skip-immune', reason: 'eslint-fitness CLI is locked to repoRoot (ignores argv); internal filesLinted===0 floor added this session + own unit test covers it' },
  'catch-ratchet': { class: 'skip-immune', reason: 'generator is import.meta-rooted and ignores cwd; its zero-file scan fails closed and is covered by generate-catch-ratchet.test.ts' },
  'durability-writer': { class: 'skip-immune', reason: 'SCRIPT_DIR/REPO_ROOT-rooted (REPO_ROOT = SCRIPT_DIR/..); scans the real repo regardless of cwd (verified empty-cwd exit 0). Its discoveredTableCount===0 -> exit 2 non-vacuity floor + the paired durability-writer-guard.test.ts cover the empty/inconclusive case (#1789)' },

  // ---- skip-network: needs a live API, not offline-judgeable ----
  'branch-protection-drift': { class: 'skip-network', reason: 'pipes `gh api` branch protection into the check; cannot be judged against an offline empty tree' },

  // ---- skip-composite: delegates to a non-guard script / plugin / deploy verifier ----
  'drift-coverage': { class: 'skip-composite', reason: 'npm run drift:classify --self-check — a self-test, not a repo-tree scan' },
  'restart-preflight': { class: 'skip-composite', reason: 'deploy/preflight-check.sh — deploy preflight, not a guard-tree scan' },
  'deployer-static': { class: 'skip-composite', reason: 'deploy verifier with a verify subcommand and "$PWD" arg; not a single literal tree scan' },
  'test-integrity': { class: 'skip-composite', reason: 'delegates to the test-integrity plugin (skips clean locally, hard-fails in CI via env); plugin-dependent, not a repo-tree scan' },

  // ---- skip-alias: delegates to a base guard already classified above ----
  'publication:all': { class: 'skip-alias', reason: 'alias -> guard:publication (all mode floored + tested this session)' },
  'publication:release': { class: 'skip-alias', reason: 'alias -> guard:publication (release mode floored + tested in publication-guard.test.ts)' },
  'publication:staged': { class: 'skip-alias', reason: 'alias -> guard:publication (staged is diff-scoped; empty index legitimately clean)' },
  'publication:write': {
    class: 'skip-alias',
    reason:
      'alias -> guard:publication --write. NOT a validator: it rewrites docs/publication-audit.md and returns before every validation branch, so the empty-scope vacuity floor does not apply. Its output is proven valid by publication-guard.test.ts, which asserts --all passes on a freshly written document',
  },
  'repo:release-hygiene': { class: 'skip-alias', reason: 'alias -> guard:repo --release-hygiene (whole-tree mode; floored this session, probed in MODE_PROBES)' },
  'repo:commit-msg': { class: 'skip-alias', reason: 'alias -> guard:repo (commit-msg mode; message-scoped)' },
  'repo:commit-authors': { class: 'skip-alias', reason: 'alias -> guard:repo (commit-range-scoped)' },
  'repo:staged': { class: 'skip-alias', reason: 'alias -> guard:repo (staged; empty index legitimately clean)' },
  'repo:branch-diff': { class: 'skip-alias', reason: 'alias -> guard:repo (branch-diff-scoped)' },
  'repo:scan-history': { class: 'skip-alias', reason: 'alias -> guard:repo (history-scoped)' },
  'ring-boundaries': { class: 'skip-alias', reason: 'alias -> guard:boundaries (probe-refuse)' },
  'test-integrity:required': { class: 'skip-alias', reason: 'alias -> guard:test-integrity with WHATSOUP_REQUIRE_TEST_INTEGRITY=1' },
};

// ---------------------------------------------------------------------------
// package.json is the source of truth for which guards exist.
// ---------------------------------------------------------------------------

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};
const guardScripts = Object.entries(pkg.scripts)
  .filter(([name]) => name.startsWith('guard:'))
  .map(([name, command]) => ({ key: name.slice('guard:'.length), name, command }));

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const temps: string[] = [];
afterAll(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

function freshEmptyGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'guard-vac-all-'));
  temps.push(dir);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'v@t.invalid'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'v'], { cwd: dir });
  return dir;
}

function argvFor(interpreter: Interpreter, scriptAbs: string, args: string[]): [string, string[]] {
  if (interpreter === 'bash') return ['bash', [scriptAbs, ...args]];
  if (interpreter === 'node-strip') {
    return [process.execPath, ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', scriptAbs, ...args]];
  }
  return [process.execPath, [scriptAbs, ...args]];
}

/** Run one guard against an empty tree per its probe, returning exit status + combined output. */
function probeGuardAgainstEmptyTree(command: string, entry: ScopeEntry): { status: number; output: string } {
  const resolved = resolveGuardCommand(command);
  assertRealEntrypoint(resolved, command); // never the pinned-node wrapper
  const scriptAbs = join(repoRoot, resolved.script);
  const emptyTree = freshEmptyGitRepo();

  const probe = entry.probe ?? { via: 'cwd' };
  let cwd: string;
  let args: string[];
  if (probe.via === 'cwd') {
    cwd = emptyTree;
    args = resolved.trailingArgs;
  } else {
    cwd = repoRoot;
    args = [...resolved.trailingArgs, probe.flag, emptyTree];
  }

  const [cmd, argv] = argvFor(resolved.interpreter, scriptAbs, args);
  const r = spawnSync(cmd, argv, { cwd, encoding: 'utf8', timeout: 120_000 });
  return { status: r.status ?? -1, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

// ---------------------------------------------------------------------------
// The ratchet: every guard is classified.
// ---------------------------------------------------------------------------

describe('every guard:* script is classified by scope input', () => {
  it('has no unclassified guard (a new guard must be added to SCOPE_MAP)', () => {
    const unclassified = guardScripts.filter(({ key }) => !(key in SCOPE_MAP)).map(({ name }) => name);
    expect(
      unclassified,
      `these guard:* scripts are not in SCOPE_MAP — classify each by how it takes scope:\n${unclassified.join('\n')}`,
    ).toEqual([]);
  });

  it('has no stale SCOPE_MAP entry (every classified guard still exists)', () => {
    const live = new Set(guardScripts.map(({ key }) => key));
    const stale = Object.keys(SCOPE_MAP).filter((key) => !live.has(key));
    expect(stale, `SCOPE_MAP names guards that no longer exist:\n${stale.join('\n')}`).toEqual([]);
  });

  it('every entry carries a non-trivial reason', () => {
    for (const [key, entry] of Object.entries(SCOPE_MAP)) {
      expect(entry.reason.length, `guard:${key} needs a real reason`).toBeGreaterThan(20);
    }
  });
});

// ---------------------------------------------------------------------------
// The resolver never hands back a wrapper (the line-2755 defect, across the real command set).
// ---------------------------------------------------------------------------

describe('every guard command resolves to a real entrypoint, never a wrapper', () => {
  it.each(guardScripts)('$name does not resolve to the pinned-node wrapper', ({ command }) => {
    const resolved = resolveGuardCommand(command);
    if (resolved.kind === 'entrypoint') {
      expect(resolved.script).not.toMatch(/run-with-pinned-(node|npm)\.sh$/);
    }
  });
});

// ---------------------------------------------------------------------------
// Behavioural probes.
// ---------------------------------------------------------------------------

const probeRefuse = guardScripts.filter(({ key }) => SCOPE_MAP[key]?.class === 'probe-refuse');
const probeNonzero = guardScripts.filter(({ key }) => SCOPE_MAP[key]?.class === 'probe-nonzero');

describe('tree-scanners refuse an empty tree with exit 2 INCONCLUSIVE', () => {
  it.each(probeRefuse)('$name exits 2 INCONCLUSIVE on an empty tree', ({ command, key }) => {
    const { status, output } = probeGuardAgainstEmptyTree(command, SCOPE_MAP[key]!);
    expect(status, `guard:${key} exited ${status} on an empty tree; output:\n${output}`).toBe(2);
    expect(output).toMatch(/INCONCLUSIVE/i);
  }, 120_000);
});

describe('fixed-artifact guards fail closed (never certify) an empty tree', () => {
  it.each(probeNonzero)('$name exits non-zero on an empty tree', ({ command, key }) => {
    const { status, output } = probeGuardAgainstEmptyTree(command, SCOPE_MAP[key]!);
    expect(status, `guard:${key} exited 0 (certified an empty tree!); output:\n${output}`).not.toBe(0);
  }, 120_000);
});

/**
 * Multi-mode guards. The base-command probe above tests only a guard's DEFAULT mode, so a
 * whole-tree mode reachable through a flag (via the `:release`/`:release-hygiene` aliases wired
 * into verify:release) can hide a vacuity the base probe never exercises. `publication`'s
 * default is `all` (already whole-tree, covered above); `repo`'s default is `staged`
 * (diff-scoped), so its whole-tree `release-hygiene` mode needs its own probe. Both must refuse
 * an empty tree — an independent classification pass found `repo --release-hygiene` silently
 * certifying one before this floor landed.
 */
const MODE_PROBES = [
  { label: 'repo --release-hygiene', script: 'scripts/repo-hygiene-guard.ts', args: ['--release-hygiene'] },
  { label: 'publication --release', script: 'scripts/publication-guard.ts', args: ['--release'] },
] as const;

describe('multi-mode guards refuse an empty tree in their whole-tree modes', () => {
  it.each(MODE_PROBES)('$label exits 2 INCONCLUSIVE on an empty tree', ({ script, args }) => {
    const [cmd, argv] = argvFor('node-strip', join(repoRoot, script), [...args]);
    const r = spawnSync(cmd, argv, { cwd: freshEmptyGitRepo(), encoding: 'utf8', timeout: 120_000 });
    const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    expect(r.status, `${script} ${args.join(' ')} on an empty tree; output:\n${output}`).toBe(2);
    expect(output).toMatch(/INCONCLUSIVE/i);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Self-test: prove the harness DETECTS a false certification, through its own resolver+runner.
// A known-vacuous synthetic guard must be caught; a known-refusing one must pass. This is the
// control the retracted 2026-07-23 sweep lacked — it ran guards directly, never through the
// resolver, so it proved "the guard refuses" but never "the sweep detects a refusal".
// ---------------------------------------------------------------------------

describe('the harness detects a false certification (self-test through the resolver)', () => {
  const VACUOUS = `#!/usr/bin/env node
// A deliberately vacuous guard: always prints clean and exits 0, examining nothing.
console.log('synthetic guard passed (clean, 0 findings)');
process.exit(0);
`;
  const REFUSING = `#!/usr/bin/env node
// A correct guard: refuses when it has nothing to examine.
console.error('synthetic guard: INCONCLUSIVE — examined 0 files');
process.exit(2);
`;

  function syntheticDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'guard-selftest-'));
    temps.push(dir);
    writeFileSync(join(dir, 'vacuous.mjs'), VACUOUS);
    writeFileSync(join(dir, 'refusing.mjs'), REFUSING);
    return dir;
  }

  /** The detector under test: did the guard falsely certify (pass a tree it never examined)? */
  function falselyCertifies(status: number, output: string): boolean {
    return (
      status === 0 &&
      /\b(clean|passed|no .*(found|violations))\b/i.test(output) &&
      !/INCONCLUSIVE/i.test(output)
    );
  }

  function runSynthetic(scriptAbs: string): { status: number; output: string } {
    // Route through the SAME resolver the real guards use, via a wrapper-prefixed command.
    const command = `bash scripts/run-with-pinned-node.sh ${scriptAbs}`;
    const resolved = resolveGuardCommand(command);
    assertRealEntrypoint(resolved, command);
    // The resolver must have picked the synthetic script, NOT the wrapper.
    expect(resolved.script).toBe(scriptAbs);
    const [cmd, argv] = argvFor(resolved.interpreter, scriptAbs, resolved.trailingArgs);
    const r = spawnSync(cmd, argv, { cwd: freshEmptyGitRepo(), encoding: 'utf8', timeout: 60_000 });
    return { status: r.status ?? -1, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  }

  it('flags a KNOWN-vacuous guard as a false certification', () => {
    const dir = syntheticDir();
    const result = runSynthetic(join(dir, 'vacuous.mjs'));
    expect(result.status).toBe(0);
    expect(falselyCertifies(result.status, result.output)).toBe(true);
  });

  it('does NOT flag a KNOWN-refusing guard', () => {
    const dir = syntheticDir();
    const result = runSynthetic(join(dir, 'refusing.mjs'));
    expect(result.status).toBe(2);
    expect(falselyCertifies(result.status, result.output)).toBe(false);
  });
});
