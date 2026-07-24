/**
 * One definition of "this check actually runs on a merge nobody can bypass".
 *
 * Two suites need that answer and they must not compute it separately:
 *
 *   - `tests/scripts/pre-push-guard.test.ts` asks it of GUARDS  — is every guard in the
 *     local push gate also enforced server-side?
 *   - `tests/scripts/fitness-registry-backing.test.ts` asks it of RULES — does every
 *     `severity: 'block'` fitness rule name a backstop that is enforced server-side?
 *
 * A second, drifting copy of "gate-reachable" is exactly the failure both suites exist to
 * prevent, so the computation lives here once and both import it.
 *
 * WHY server-side matters (2026-07-22): `verify:push:branch` runs from a husky pre-push
 * hook, and client-side hooks are advisory. `gh pr merge`, the GitHub merge button,
 * `--no-verify`, and any clone where husky was never installed all bypass it entirely.
 * A check that lives ONLY in the push gate is therefore not enforcement — it is a
 * courtesy. `guard:transport-patterns` was in exactly that state while backing three
 * block-severity rules.
 *
 * WHICH GATE, not just "the gate" (2026-07-22, second pass). The first version of this
 * helper read `quality.yml` alone and answered "gate-reachable" without saying which gate
 * it meant. There are two independent server-side paths and they are NOT equivalent:
 * `tag-release-gate.yml` runs fifteen discrete guard steps and **no unit suite at all**
 * (`grep -c "npm run coverage:check"` → 0). Every reachability answer is therefore
 * per-path, and the caller must choose. See `GatePath`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The independent server-side gates. Neither subsumes the other:
 *   - `pull-request` (`quality.yml`) runs the full suite via `coverage:check`, so a
 *     live-tree test can carry a guard that has no named step of its own.
 *   - `tag-release` (`tag-release-gate.yml`) runs NO unit suite, so on that path a named
 *     step is the ONLY way a check runs. The exemption route does not exist there.
 */
export const GATE_PATHS = ['pull-request', 'tag-release'] as const;
export type GatePath = (typeof GATE_PATHS)[number];

export interface GateInputs {
  /** `package.json` scripts map — the source of `verify:push:branch`'s composition. */
  scripts: Record<string, string>;
  /** Raw text of `.github/workflows/quality.yml` — the pull-request gate. */
  qualityWorkflow: string;
  /** Raw text of `.github/workflows/tag-release-gate.yml` — the tag/release gate. */
  tagReleaseWorkflow: string;
}

export function readGateInputs(repoRoot: string): GateInputs {
  const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  return {
    scripts: packageJson.scripts,
    qualityWorkflow: readFileSync(resolve(repoRoot, '.github/workflows/quality.yml'), 'utf8'),
    tagReleaseWorkflow: readFileSync(
      resolve(repoRoot, '.github/workflows/tag-release-gate.yml'),
      'utf8',
    ),
  };
}

/** The workflow text for a given path. */
export function workflowFor(path: GatePath, inputs: GateInputs): string {
  return path === 'pull-request' ? inputs.qualityWorkflow : inputs.tagReleaseWorkflow;
}

/**
 * Does this path run the full vitest suite?
 *
 * This is the single fact that makes the two paths behave differently, so it is derived
 * from the workflow text rather than hardcoded per path — if `tag-release-gate.yml` ever
 * gains `coverage:check`, every dependent answer updates without editing this file.
 */
export function runsFullSuite(path: GatePath, inputs: GateInputs): boolean {
  return /npm run coverage:check/.test(workflowFor(path, inputs));
}

/**
 * `backedBy` is a PATH, not prose, and is asserted to exist and to be collected by vitest.
 *
 * The first version of this map held free-text reasons. That is a false-green waiting to
 * happen: delete or rename `ssot-pattern-guard.test.ts` and the map would still cheerfully
 * claim the guard was covered, because nothing connected the sentence to a file. An
 * exemption is a protection claim, and a protection claim has to derive from something on
 * disk rather than from a sentence someone wrote once.
 *
 * `backedBy: null` means the exemption does not rest on a test at all — spell out in `why`
 * what does carry it.
 */
export const CI_EXEMPT_PUSH_GATE_GUARDS: Readonly<
  Record<string, { backedBy: string | null; why: string }>
> = {
  'guard:ssot-patterns': {
    backedBy: 'tests/scripts/ssot-pattern-guard.test.ts',
    why: 'asserts every rule count equals BOTH baseline twins against REPO_ROOT — an exact-count ratchet, not a smoke test.',
  },
  'guard:ring-boundary-ratchet': {
    backedBy: 'tests/scripts/ring-boundary-guard.test.ts',
    why: 'asserts verdict.count === baseline against the live REPO_ROOT.',
  },
  'guard:doc-tally': {
    backedBy: 'tests/scripts/guard-doc-tally.test.ts',
    why: 'runs validateDocTally + runDocTallyGuard against REPO_ROOT.',
  },
  'guard:guard-test-coverage': {
    backedBy: 'tests/scripts/guard-test-coverage-check.test.ts',
    why: 'runs findGuardsMissingTests against the live repo root.',
  },
  'guard:deployer-static': {
    backedBy: 'tests/scripts/deployer-static-parity.test.ts',
    why: 'reads the deploy script and package.json from the live repoRoot.',
  },
  'guard:publication:staged': {
    backedBy: null,
    why: 'quality.yml runs guard:publication:all (--all), which scans every tracked doc and is a strict superset of the --staged subset. No test backs this; the CI step does.',
  },
};

/** Every `guard:*` npm script that `verify:push:branch` invokes, deduped and sorted. */
export function pushGateGuards(scripts: Record<string, string>): string[] {
  return [
    ...new Set(
      [...(scripts['verify:push:branch'] ?? '').matchAll(/npm run (guard:[a-z0-9:._-]+)/g)].map(
        (m) => m[1],
      ),
    ),
  ].sort();
}

/**
 * Is `script` a named step in quality.yml?
 *
 * The negative lookahead is load-bearing: without it `npm run guard:repo` would match the
 * line `npm run guard:repo:commit-authors`, so a guard absent from CI would report as
 * present because a longer-named sibling happens to run.
 */
export function namedInCi(script: string, qualityWorkflow: string): boolean {
  return new RegExp(
    `npm run ${script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9:._-])`,
  ).test(qualityWorkflow);
}

export type ReachabilityVia = 'ci-step' | 'push-gate-exemption' | 'none';

export interface Reachability {
  reachable: boolean;
  via: ReachabilityVia;
  /** Human-readable justification, for use in assertion messages. */
  detail: string;
}

/**
 * Can a server-side merge on `path` bypass this npm script?
 *
 * Reachable two ways, and only two:
 *   - `ci-step`             — named directly in that path's workflow. Unbypassable.
 *   - `push-gate-exemption` — in `verify:push:branch` with an entry in
 *                             CI_EXEMPT_PUSH_GATE_GUARDS, i.e. a live-tree test carries the
 *                             same assertion inside the full suite.
 *
 * The exemption route is conditional on the path actually running the full suite, which is
 * why `runsFullSuite` is consulted rather than assumed. On `tag-release` it is false, so an
 * exempted guard is genuinely unreachable there even though it is reachable on
 * `pull-request` — the asymmetry that made the first, path-blind version of this function
 * overstate its answer.
 *
 * Anything else is `none`: on that path it runs from an advisory client-side hook, or not
 * at all.
 */
export function scriptReachability(
  script: string,
  inputs: GateInputs,
  path: GatePath = 'pull-request',
): Reachability {
  const workflow = workflowFor(path, inputs);
  if (namedInCi(script, workflow)) {
    return { reachable: true, via: 'ci-step', detail: `named step in the ${path} workflow` };
  }
  const exemption = CI_EXEMPT_PUSH_GATE_GUARDS[script];
  if (exemption && pushGateGuards(inputs.scripts).includes(script)) {
    if (runsFullSuite(path, inputs)) {
      return {
        reachable: true,
        via: 'push-gate-exemption',
        detail: `push-gate only, backed in the full suite by ${exemption.backedBy ?? 'a CI step'} — ${exemption.why}`,
      };
    }
    return {
      reachable: false,
      via: 'none',
      detail:
        `exempted as push-gate-only on the strength of a live-tree test, but the ${path} ` +
        `workflow does not run the full suite (no coverage:check), so nothing executes it there`,
    };
  }
  return {
    reachable: false,
    via: 'none',
    detail: `not a named step in the ${path} workflow and not an exempted push-gate guard — that path does not run it`,
  };
}

/** An `implementedBy` entry is a test path if it looks like one; otherwise an npm script. */
export function isTestPathBackstop(entry: string): boolean {
  return entry.endsWith('.test.ts');
}

/**
 * Reachability of a single `implementedBy` entry, of either kind, on one gate path.
 *
 * A test-file backstop runs only inside the full suite, so its reachability IS
 * `runsFullSuite`. Keeping that rule here rather than in the calling suite is what stops
 * the two kinds drifting apart — the first version handled npm scripts in the helper and
 * test files inline in the test, and only the npm-script half became path-aware.
 */
export function backstopReachability(
  entry: string,
  inputs: GateInputs,
  path: GatePath = 'pull-request',
): Reachability {
  if (!isTestPathBackstop(entry)) return scriptReachability(entry, inputs, path);
  if (runsFullSuite(path, inputs)) {
    return {
      reachable: true,
      via: 'ci-step',
      detail: `run by npm run coverage:check in the ${path} workflow`,
    };
  }
  return {
    reachable: false,
    via: 'none',
    detail: `a test-file backstop, but the ${path} workflow does not run the full suite (no coverage:check)`,
  };
}
