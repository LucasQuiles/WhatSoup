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
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface GateInputs {
  /** `package.json` scripts map — the source of `verify:push:branch`'s composition. */
  scripts: Record<string, string>;
  /** Raw text of `.github/workflows/quality.yml` — the server-side gate. */
  qualityWorkflow: string;
}

export function readGateInputs(repoRoot: string): GateInputs {
  const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  return {
    scripts: packageJson.scripts,
    qualityWorkflow: readFileSync(resolve(repoRoot, '.github/workflows/quality.yml'), 'utf8'),
  };
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
 * Can a server-side merge bypass this npm script?
 *
 * Reachable two ways, and only two:
 *   - `ci-step`             — named directly in quality.yml. Unbypassable.
 *   - `push-gate-exemption` — in `verify:push:branch` with an entry in
 *                             CI_EXEMPT_PUSH_GATE_GUARDS, i.e. a live-tree test carries the
 *                             same assertion inside the full suite, which CI runs via
 *                             `coverage:check`.
 *
 * Anything else is `none`: it runs from an advisory client-side hook and nothing else.
 */
export function scriptReachability(script: string, inputs: GateInputs): Reachability {
  if (namedInCi(script, inputs.qualityWorkflow)) {
    return { reachable: true, via: 'ci-step', detail: `named step in quality.yml` };
  }
  const exemption = CI_EXEMPT_PUSH_GATE_GUARDS[script];
  if (exemption && pushGateGuards(inputs.scripts).includes(script)) {
    return {
      reachable: true,
      via: 'push-gate-exemption',
      detail: `push-gate only, backed in the full suite by ${exemption.backedBy ?? 'a CI step'} — ${exemption.why}`,
    };
  }
  return {
    reachable: false,
    via: 'none',
    detail: `not a named step in quality.yml and not an exempted push-gate guard — any server-side merge bypasses it`,
  };
}
