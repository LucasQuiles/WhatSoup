/**
 * Drift classifier and receipt sensitivity model (rider P1).
 *
 * When a candidate branch was verified against base OID X and `main` has since moved to Y,
 * the question is never "how far behind am I". It is **what changed, and which of my
 * evidence still holds**. "Behind by N commits" and elapsed time are advisory only: a
 * hundred commits of unrelated documentation invalidate nothing, and one commit touching a
 * workflow invalidates every policy-dependent claim.
 *
 * This module answers that mechanically. It is pure — no git, no filesystem, no clock — so
 * it is exhaustively testable and cannot fail open on an IO fault. `scripts/drift-classify.ts`
 * is the CLI that feeds it a real path set.
 *
 * Built against what is on `main` today. It deliberately does NOT depend on
 * `scripts/lib/ci-control/`, which has never landed here.
 *
 * SCOPE OF THE CLAIM: this classifies drift by the PATHS that changed and reports which
 * evidence classes that invalidates. It does not verify that the invalidated evidence was
 * actually re-run — that is the caller's obligation, and conflating the two would be the
 * same false-green the fitness backing suite exists to prevent.
 */

/**
 * Rider §"Drift classifier / invalidation matrix", in escalation order.
 *
 * Order matters: `worstOf` takes the maximum, so a path set touching both docs and a
 * workflow classifies as `POLICY_OR_WORKFLOW`. Drift is not additive — the most invalidating
 * change governs.
 */
export const DRIFT_CLASSES = [
  'NONE',
  'DISJOINT_METADATA',
  'DISJOINT_CODE',
  'AFFECTED_COMPONENT',
  'GENERATED_INPUT',
  'DEPENDENCY',
  'SHARED_RUNTIME',
  'CONFLICT',
  'POLICY_OR_WORKFLOW',
  'UNKNOWN',
] as const;
export type DriftClass = (typeof DRIFT_CLASSES)[number];

/** What a drift class means for the caller. */
export type DriftBehavior =
  | 'continue'
  | 'usually-continue'
  | 'pause-before-final-verification'
  | 'reconcile'
  | 'reconcile-and-regenerate'
  | 'integrator-intervention'
  | 'immediate-integrity-stop'
  | 'inconclusive';

/** Rider §"Receipt sensitivity tags (make reuse mechanical)". */
export const SENSITIVITY_TAGS = [
  'candidate-only',
  'base-sensitive',
  'merge-sensitive',
  'policy-sensitive',
  'toolchain-sensitive',
  'platform-sensitive',
  'artifact-sensitive',
] as const;
export type SensitivityTag = (typeof SENSITIVITY_TAGS)[number];

export interface DriftClassSpec {
  behavior: DriftBehavior;
  /** Sensitivity tags whose receipts this drift class invalidates. */
  invalidates: readonly SensitivityTag[];
  why: string;
}

/**
 * `candidate-only` appears in NO invalidation set, deliberately and by definition: a receipt
 * that depends only on the candidate OID cannot be invalidated by anything happening on
 * `main`. That is the whole point of the tag, and it is asserted in the tests so the
 * property cannot be quietly lost.
 */
export const DRIFT_MATRIX: Readonly<Record<DriftClass, DriftClassSpec>> = {
  NONE: {
    behavior: 'continue',
    invalidates: [],
    why: 'observed base is unchanged; nothing depends on a difference that does not exist',
  },
  DISJOINT_METADATA: {
    behavior: 'continue',
    invalidates: ['base-sensitive', 'merge-sensitive'],
    why: 'unrelated docs/metadata: indexes and the merge result move, executable behaviour does not',
  },
  DISJOINT_CODE: {
    behavior: 'usually-continue',
    invalidates: ['base-sensitive', 'merge-sensitive'],
    why: 'unrelated closed component: the integration result changes, component-local evidence does not',
  },
  AFFECTED_COMPONENT: {
    behavior: 'pause-before-final-verification',
    invalidates: ['base-sensitive', 'merge-sensitive'],
    why: 'same package or dependency closure: affected build, unit and integration evidence must be re-earned',
  },
  GENERATED_INPUT: {
    behavior: 'reconcile-and-regenerate',
    invalidates: ['base-sensitive', 'merge-sensitive', 'artifact-sensitive'],
    why: 'a generator or authoritative input moved: generated output, docs and packaging are stale',
  },
  DEPENDENCY: {
    behavior: 'reconcile',
    invalidates: ['base-sensitive', 'merge-sensitive', 'toolchain-sensitive', 'artifact-sensitive'],
    why: 'lockfile, runtime pin or base image: install, build, security, portability and integration all depend on it',
  },
  SHARED_RUNTIME: {
    behavior: 'reconcile',
    invalidates: ['base-sensitive', 'merge-sensitive', 'toolchain-sensitive', 'artifact-sensitive'],
    why: 'a common library or interface moved: every dependent component’s evidence is suspect',
  },
  CONFLICT: {
    behavior: 'integrator-intervention',
    invalidates: ['base-sensitive', 'merge-sensitive', 'artifact-sensitive'],
    why: 'overlapping edits: no automated reconciliation is safe, merge-sensitive evidence is void',
  },
  POLICY_OR_WORKFLOW: {
    behavior: 'immediate-integrity-stop',
    invalidates: [
      'base-sensitive',
      'merge-sensitive',
      'policy-sensitive',
      'toolchain-sensitive',
      'platform-sensitive',
      'artifact-sensitive',
    ],
    why: 'manifest, workflow, hook or classifier changed: the rules that judged the evidence are themselves different',
  },
  UNKNOWN: {
    behavior: 'inconclusive',
    invalidates: [
      'base-sensitive',
      'merge-sensitive',
      'policy-sensitive',
      'toolchain-sensitive',
      'platform-sensitive',
      'artifact-sensitive',
    ],
    why: 'missing objects or failed graph analysis: run broadly and return INCONCLUSIVE rather than a verdict',
  },
};

/**
 * Path → drift class, most-invalidating first.
 *
 * These are matched in order and the FIRST match wins per path, so the policy patterns must
 * precede the generic source patterns — `.github/workflows/x.yml` is policy, not metadata,
 * even though it is also a non-source file.
 */
const PATH_RULES: ReadonlyArray<{ test: (p: string) => boolean; drift: DriftClass; label: string }> = [
  {
    label: 'CI workflow, git hook, or the gate composition itself',
    drift: 'POLICY_OR_WORKFLOW',
    test: (p) =>
      p.startsWith('.github/workflows/') ||
      p.startsWith('.husky/') ||
      p === 'package.json' ||
      p.startsWith('.claude/fitness/') ||
      p.startsWith('docs/enforcement/') ||
      // NOTE — this guard-name heuristic is a SECOND encoding of a fact
      // `scripts/guard-test-coverage-check.ts:89` already owns
      // (`name.includes('guard') || name.startsWith('check-')`). Not imported from there
      // on purpose: that predicate lives inside a function that reads the filesystem, and
      // this module is pure by design. The duplication is low-risk because the `scripts/`
      // catch-all below yields the SAME verdict for every path this branch matches — the
      // only thing lost if they drift is the precise `rule` label. If a third guard-naming
      // convention is ever added, both places need it.
      //
      // BOTH naming conventions. The repo uses `import-boundary-check.ts` AND
      // `check-insecure-tempfile.ts` for the same kind of thing; the first draft of this
      // rule matched only the suffix form, so `check-*` fell through to no rule at all.
      // Found by running the classifier against real drift on this repo — it refused
      // rather than guessing, which is exactly what the UNKNOWN branch is for.
      /^scripts\/(lib\/fitness\/|.*guard.*\.(ts|sh)$|.*-check\.ts$|check-.*\.(ts|sh)$)/.test(p),
  },
  {
    // Everything that decides HOW the tree is judged: lint rule implementations, the
    // fitness eslint config, vitest configs (which choose what the suite even collects),
    // agent/runtime policy directories, and the guard tooling package.
    label: 'lint rule, test-runner config, or agent/tool policy',
    drift: 'POLICY_OR_WORKFLOW',
    test: (p) =>
      p.startsWith('eslint-rules/') ||
      /^eslint\.config\./.test(p) ||
      /^vitest(\.[a-z.]+)?\.config\.ts$/.test(p) ||
      p === 'stryker.conf.json' ||
      p.startsWith('.claude/') ||
      p.startsWith('.arc/') ||
      p.startsWith('tools/whatsoup_guard/'),
  },
  {
    label: 'dependency or toolchain pin',
    drift: 'DEPENDENCY',
    test: (p) =>
      p === 'package-lock.json' ||
      p === '.nvmrc' ||
      p.endsWith('/package-lock.json') ||
      p.endsWith('/package.json') ||
      p === 'Dockerfile' ||
      /^tsconfig(\.[a-z]+)?\.json$/.test(p) ||
      p === 'docker-compose.yml' ||
      p.startsWith('docker/') ||
      p.startsWith('deploy/docker/'),
  },
  {
    // Service units, plists, install scripts and proxy assets. These do not change what the
    // code computes, but they change what a HOST does with it — so platform and artifact
    // evidence is invalidated while component-local evidence survives.
    label: 'deployment or platform asset',
    drift: 'AFFECTED_COMPONENT',
    test: (p) => p.startsWith('deploy/') || p.startsWith('phonectl/') || p.startsWith('config/'),
  },
  {
    label: 'shared runtime library or cross-cutting core module',
    drift: 'SHARED_RUNTIME',
    test: (p) => p.startsWith('src/lib/') || p.startsWith('src/core/'),
  },
  {
    label: 'generator or authoritative generated input',
    drift: 'GENERATED_INPUT',
    test: (p) =>
      /\.generated\.|^docs\/tools\.md$|^docs\/public-surface\.md$/.test(p) ||
      p.startsWith('artifacts/'),
  },
  {
    label: 'repo-level ignore or environment template',
    drift: 'DISJOINT_METADATA',
    test: (p) => /^\.(gitignore|dockerignore|gitattributes|editorconfig)$/.test(p) || p === '.env.example',
  },
  {
    label: 'plugin or auxiliary tool source',
    drift: 'DISJOINT_CODE',
    test: (p) => p.startsWith('plugins/') || p.startsWith('tools/'),
  },
  {
    /**
     * Catch-all for `scripts/`, deliberately conservative and deliberately LAST.
     *
     * In this repo `scripts/` IS the enforcement surface: every guard runs through
     * `scripts/run-with-pinned-node.sh`, and `scripts/lib/verification/` and
     * `scripts/lib/semantic-quality/` are the libraries those guards are built on. A change
     * anywhere in here can change what the gate concludes.
     *
     * The error is asymmetric, which is why the default leans this way: misclassifying a
     * runtime-only helper (say `transcribe-faster-whisper.py`) as policy costs one
     * unnecessary reconcile, while the reverse ships a false green on a change to the rules
     * themselves. Placed last so the more specific rules above — guards, fitness registry,
     * lib/fitness — still supply their own precise labels.
     */
    label: 'script surface (the tooling the gate itself runs on)',
    drift: 'POLICY_OR_WORKFLOW',
    test: (p) => p.startsWith('scripts/'),
  },
  {
    label: 'documentation or metadata',
    drift: 'DISJOINT_METADATA',
    test: (p) => p.startsWith('docs/') || p.endsWith('.md') || p.startsWith('.github/ISSUE_TEMPLATE/'),
  },
  {
    label: 'component source or tests',
    drift: 'DISJOINT_CODE',
    test: (p) => p.startsWith('src/') || p.startsWith('tests/') || p.startsWith('console/'),
  },
];

export interface PathClassification {
  path: string;
  drift: DriftClass;
  /** Which rule matched, for an explainable verdict rather than a bare label. */
  rule: string;
}

export interface DriftVerdict {
  drift: DriftClass;
  behavior: DriftBehavior;
  invalidates: readonly SensitivityTag[];
  /** Per-path detail — an operator must be able to see WHY, not just WHAT. */
  classifications: readonly PathClassification[];
  /** Paths matching no rule. Non-empty forces UNKNOWN; see classifyDrift. */
  unclassified: readonly string[];
  why: string;
}

/** Escalation order index. */
const rank = (d: DriftClass): number => DRIFT_CLASSES.indexOf(d);

/** The most-invalidating of two classes. */
export function worstOf(a: DriftClass, b: DriftClass): DriftClass {
  return rank(a) >= rank(b) ? a : b;
}

export interface ClassifyOptions {
  /**
   * Paths the candidate itself touches. A drifted path that the candidate ALSO touches is
   * an overlapping edit, which the rider classifies as `CONFLICT` — integrator
   * intervention, not automated reconciliation.
   */
  candidatePaths?: readonly string[];
  /**
   * Set when the caller could not enumerate the changed paths (missing objects, failed
   * graph analysis). Forces `UNKNOWN`; the rider is explicit that this returns
   * INCONCLUSIVE rather than a verdict.
   */
  analysisFailed?: boolean;
}

/**
 * Classify drift from the set of paths that changed on the observed base.
 *
 * Fail-closed in three distinct ways, each for a different fault:
 *  - `analysisFailed` → UNKNOWN. The caller could not look.
 *  - any path matching NO rule → UNKNOWN. We looked and did not understand what we saw;
 *    guessing `DISJOINT_CODE` for an unrecognised path is exactly how a policy file gets
 *    silently treated as inert.
 *  - an empty path set with `analysisFailed` unset → NONE, which is a real verdict: the
 *    caller positively established that nothing changed.
 */
export function classifyDrift(
  changedPaths: readonly string[],
  options: ClassifyOptions = {},
): DriftVerdict {
  if (options.analysisFailed) {
    return verdict('UNKNOWN', [], [], 'path enumeration failed; no verdict can be derived');
  }

  const candidate = new Set(options.candidatePaths ?? []);
  const classifications: PathClassification[] = [];
  const unclassified: string[] = [];

  for (const path of changedPaths) {
    if (candidate.has(path)) {
      classifications.push({ path, drift: 'CONFLICT', rule: 'also edited by the candidate' });
      continue;
    }
    const rule = PATH_RULES.find((r) => r.test(path));
    if (!rule) {
      unclassified.push(path);
      continue;
    }
    classifications.push({ path, drift: rule.drift, rule: rule.label });
  }

  if (unclassified.length > 0) {
    return verdict(
      'UNKNOWN',
      classifications,
      unclassified,
      `${unclassified.length} path(s) matched no classification rule — refusing to guess: ${unclassified.slice(0, 5).join(', ')}`,
    );
  }

  const drift = classifications.reduce<DriftClass>((acc, c) => worstOf(acc, c.drift), 'NONE');
  return verdict(drift, classifications, [], DRIFT_MATRIX[drift].why);
}

function verdict(
  drift: DriftClass,
  classifications: readonly PathClassification[],
  unclassified: readonly string[],
  why: string,
): DriftVerdict {
  const spec = DRIFT_MATRIX[drift];
  return { drift, behavior: spec.behavior, invalidates: spec.invalidates, classifications, unclassified, why };
}

/**
 * Does a receipt carrying `tags` survive this drift?
 *
 * A receipt survives only if NONE of its tags is invalidated. `candidate-only` receipts
 * always survive, because no tag in any invalidation set is `candidate-only`.
 */
export function receiptSurvives(tags: readonly SensitivityTag[], drift: DriftClass): boolean {
  const invalid = new Set<SensitivityTag>(DRIFT_MATRIX[drift].invalidates);
  return !tags.some((t) => invalid.has(t));
}

/** Rider §"Receipt sensitivity tags" worked examples, as a checkable table. */
export const RECEIPT_TAG_EXAMPLES: Readonly<Record<string, readonly SensitivityTag[]>> = {
  'formatter (candidate OID)': ['candidate-only'],
  'isolated package unit test': ['candidate-only', 'toolchain-sensitive'],
  'documentation index': ['base-sensitive'],
  'dependency install': ['base-sensitive', 'toolchain-sensitive'],
  'integration suite': ['merge-sensitive'],
  'workflow policy check': ['policy-sensitive'],
  'release artifact': ['merge-sensitive', 'policy-sensitive', 'toolchain-sensitive'],
};

/** Exit codes, matching the three-outcome discipline the repo's guards use. */
export const EXIT_CONTINUE = 0;
export const EXIT_STOP = 1;
export const EXIT_INCONCLUSIVE = 2;

export function exitCodeFor(drift: DriftClass): number {
  if (drift === 'UNKNOWN') return EXIT_INCONCLUSIVE;
  const behavior = DRIFT_MATRIX[drift].behavior;
  return behavior === 'continue' || behavior === 'usually-continue' ? EXIT_CONTINUE : EXIT_STOP;
}
