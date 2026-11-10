/**
 * One definition of full-profile check reachability in the committed workflows.
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
 * A local-only check cannot establish server-side enforcement.
 * `guard:transport-patterns` was in exactly that state while backing three
 * block-severity rules.
 *
 * WHICH GATE, not just "the gate" (2026-07-22, second pass). The first version of this
 * helper read `quality.yml` alone and answered "gate-reachable" without saying which gate
 * it meant. There are two server-side paths. A v* tag starts Quality directly; the
 * tag-release consumer waits for that Quality completion and validates its
 * trusted private-integrity receipt before this helper credits the full path. See `GatePath`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { BRANCH_STEPS } from '../../scripts/push-gate.ts';
import { privateTestIntegrityFailures } from '../../scripts/safeguard-diagnostics.ts';

/**
 * The independent server-side gates:
 *   - `pull-request` (`quality.yml`) has a full profile that runs `coverage:check`, so a
 *     live-tree test can carry a guard that has no named step of its own. This helper does
 *     not claim that eligible docs/affected fast paths execute every full-profile backstop.
 *   - `tag-release` starts Quality's non-PR full profile directly. Its trusted completion
 *     consumer is verified before this path receives Quality's coverage.
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
  /** Trusted scanner is a separate workflow; Quality must not acquire its credentials. */
  privateIntegrityWorkflow?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : [];
}

function workflowRoot(text: string): Record<string, unknown> | null {
  const document = parseDocument(text);
  if (document.errors.length > 0) return null;
  return asRecord(document.toJSON());
}

/** The raw text of one top-level workflow job, or null when the job is absent. */
function workflowJob(workflow: string, id: string): string | null {
  const header = new RegExp(`^ {2}${id}:\\s*\\n`, 'm').exec(workflow);
  if (!header || header.index === undefined) return null;
  const start = header.index + header[0].length;
  const followingJob = /^ {2}[A-Za-z0-9_-]+:\s*(?:#.*)?$/m.exec(workflow.slice(start));
  return workflow.slice(start, followingJob ? start + followingJob.index : undefined);
}

/** Structural counterpart of the selection step's executable contract tests. */
function forcedFullSelection(root: Record<string, unknown> | null): boolean {
  const selection = asRecord(asRecord(root?.jobs)?.selection);
  if (asRecord(selection?.outputs)?.profile !== '${{ steps.plan.outputs.profile }}'
    || !Array.isArray(selection?.steps)) return false;
  const step = selection.steps.map(asRecord).find((entry) => entry?.id === 'plan');
  return typeof step?.run === 'string'
    && /^\s*const isPr = process\.env\.GITHUB_EVENT_NAME === 'pull_request';\s*$/m.test(step.run)
    && /^\s*const plan = !isPr \|\| controlsChanged \? \{\s*profile: 'full'/m.test(step.run);
}

/**
 * The tag path reaches this exact full job, not every command that happens to appear in
 * an otherwise unused Quality workflow. All facts below are required for a callable path.
 */
function callableTagFullJob(inputs: GateInputs): string | null {
  const qualityRoot = workflowRoot(inputs.qualityWorkflow);
  const tagRoot = workflowRoot(inputs.tagReleaseWorkflow);
  const qualityTriggers = asRecord(qualityRoot?.on);
  const tagTriggers = asRecord(tagRoot?.on);
  const qualityPush = asRecord(qualityTriggers?.push);
  if (!stringList(qualityPush?.tags).includes('v*')) {
    return null;
  }
  const workflowRun = asRecord(tagTriggers?.workflow_run);
  if (
    !workflowRun
    || !stringList(workflowRun.workflows).includes('Quality')
    || !stringList(workflowRun.types).includes('completed')
    || tagTriggers?.push !== undefined
  ) {
    return null;
  }
  const releaseGate = asRecord(asRecord(tagRoot?.jobs)?.['release-gate']);
  const gateCondition = typeof releaseGate?.if === 'string' ? releaseGate.if : '';
  if (
    !releaseGate
    || !gateCondition.includes("github.event.workflow_run.event == 'push'")
    || !gateCondition.includes("startsWith(github.event.workflow_run.head_branch, 'v')")
    || gateCondition.includes("github.event.workflow_run.conclusion == 'success'")
    || !Array.isArray(releaseGate.steps)
    || !releaseGate.steps.some((step) => (
      asRecord(step)?.uses === 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262'
      && asRecord(asRecord(step)?.with)?.ref === '${{ github.sha }}'
    ))
    || !releaseGate.steps.some((step) => asRecord(step)?.run === 'node scripts/private-integrity-release.ts select')
    || !releaseGate.steps.some((step) => (
      asRecord(step)?.run === 'node scripts/private-integrity-release.ts verify --receipt \"$RUNNER_TEMP/private-integrity/receipt.json\"'
    ))
    || !forcedFullSelection(qualityRoot)
  ) return null;
  const full = workflowJob(inputs.qualityWorkflow, 'full');
  if (!full || !/^ {4}if:\s*needs\.selection\.outputs\.profile == 'full'\s*$/m.test(full)) {
    return null;
  }
  return full;
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
    privateIntegrityWorkflow: readFileSync(resolve(repoRoot, '.github/workflows/private-test-integrity.yml'), 'utf8'),
  };
}

/** The commands actually reachable for a given path. */
export function workflowFor(path: GatePath, inputs: GateInputs): string {
  if (path === 'pull-request') return inputs.qualityWorkflow;
  return callableTagFullJob(inputs) ?? inputs.tagReleaseWorkflow;
}

/**
 * Does this path run the full vitest suite?
 *
 * It is derived from the commands actually callable on each path rather than hardcoded.
 * A tag consumer earns its full-suite result only by resolving to Quality's selected full job.
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
  'guard:fault-taxonomy-coverage': {
    backedBy: 'tests/scripts/fault-taxonomy-source-coverage-guard.test.ts',
    why: 'its "passes on the live tree" test executes the exact guard script as a subprocess against REPO_ROOT in the full CI suite.',
  },
  'guard:publication:staged': {
    backedBy: null,
    why: 'quality.yml runs guard:publication:all (--all), which scans every tracked doc and is a strict superset of the --staged subset. No test backs this; the CI step does.',
  },
};

/**
 * The thin entry point into the declarative push-gate manifest (#2224). When
 * verify:push:branch holds this one-liner, gate membership comes from the
 * manifest; a legacy-format chain (fixture repos, stale checkouts) is parsed
 * directly; an absent script yields [] (load-bearing for reachability tests).
 */
const MANIFEST_ENTRY_POINT_RE = /^bash scripts\/run-with-pinned-node\.sh scripts\/push-gate\.ts branch\s*$/;

/** Every `guard:*` npm script that `verify:push:branch` invokes, deduped and sorted. */
export function pushGateGuards(scripts: Record<string, string>): string[] {
  const chain = scripts['verify:push:branch'];
  if (chain && MANIFEST_ENTRY_POINT_RE.test(chain.trim())) {
    return [
      ...new Set(
        BRANCH_STEPS.map((step) => step.name).filter((name) => name.startsWith('guard:')),
      ),
    ].sort();
  }
  return [
    ...new Set(
      [...(chain ?? '').matchAll(/npm run (guard:[a-z0-9:._-]+)/g)].map(
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
 * Is this check connected to the full server-side profile on `path`?
 *
 * Reachable two ways, and only two:
 *   - `ci-step`             — named in that workflow or connected through the validated
 *                             trusted private scanner workflow.
 *   - `push-gate-exemption` — in `verify:push:branch` with an entry in
 *                             CI_EXEMPT_PUSH_GATE_GUARDS, i.e. a live-tree test carries the
 *                             same assertion inside the full suite.
 *
 * The exemption route is conditional on the path actually running the full suite, which is
 * why `runsFullSuite` is consulted rather than assumed. This is a full-profile audit, not
 * a claim that an eligible docs/affected fast path runs every backstop. The trusted tag
 * consumer gets that coverage only when direct tag dispatch reaches Quality's selected full
 * job; a broken or redirected completion remains unreachable instead of borrowing unrelated
 * Quality commands.
 *
 * Anything else is `none`: on that path it runs from an advisory client-side hook, or not
 * at all. This static wiring audit does not authenticate live branch protection,
 * workflow execution or the implementation's semantic guarantees.
 */
export function scriptReachability(
  script: string,
  inputs: GateInputs,
  path: GatePath = 'pull-request',
): Reachability {
  const workflow = workflowFor(path, inputs);
  if (script === 'guard:test-integrity'
    && inputs.privateIntegrityWorkflow
    && privateTestIntegrityFailures(inputs.privateIntegrityWorkflow).length === 0
    && (path === 'pull-request' || callableTagFullJob(inputs) !== null)) {
    return { reachable: true, via: 'ci-step', detail: `trusted private scanner workflow on ${path}; live required-check configuration is verified separately` };
  }
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
