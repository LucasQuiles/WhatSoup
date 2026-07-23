/**
 * Receipt invalidation adapter for the canonical exact-revision classifier.
 *
 * This module owns no path policy. It consumes the manifest-backed risk decision from
 * `scripts/lib/ci-control/classifier.ts` and translates only that decision into receipt
 * sensitivity invalidation. The exact classifier remains the sole owner of path matching,
 * mode/type escalation, and unknown-path behavior.
 */
import {
  classifyRiskFacts,
} from './ci-control/classifier.ts';
import {
  matchesSameProcessRiskClassificationAdmission,
  type AdmittedRiskClassificationV1,
} from './ci-control/classification-admission.ts';
import type { ChangeFactV1 } from './ci-control/git-input.ts';
import { digestControlManifest, type ControlManifestV1 } from './ci-control/manifest.ts';

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

export type DriftBehavior =
  | 'continue'
  | 'usually-continue'
  | 'pause-before-final-verification'
  | 'reconcile'
  | 'reconcile-and-regenerate'
  | 'integrator-intervention'
  | 'immediate-integrity-stop'
  | 'inconclusive';

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
export type DriftOutcome = 'pass' | 'warn' | 'block' | 'inconclusive';

export interface DriftClassSpec {
  behavior: DriftBehavior;
  invalidates: readonly SensitivityTag[];
  why: string;
}

const ALL_BASE_DERIVED_SENSITIVITY = [
  'base-sensitive',
  'merge-sensitive',
  'policy-sensitive',
  'toolchain-sensitive',
  'platform-sensitive',
  'artifact-sensitive',
] as const satisfies readonly SensitivityTag[];

export const DRIFT_MATRIX: Readonly<Record<DriftClass, DriftClassSpec>> = {
  NONE: {
    behavior: 'continue',
    invalidates: [],
    why: 'observed base is unchanged; nothing depends on a difference that does not exist',
  },
  DISJOINT_METADATA: {
    behavior: 'continue',
    invalidates: ['base-sensitive', 'merge-sensitive'],
    why: 'unrelated documentation or metadata moved; indexes and the merge result must be refreshed',
  },
  DISJOINT_CODE: {
    behavior: 'usually-continue',
    invalidates: ['merge-sensitive'],
    why: 'ordinary code moved outside the affected closure; merge-result and cross-component integration evidence must be refreshed',
  },
  AFFECTED_COMPONENT: {
    behavior: 'pause-before-final-verification',
    invalidates: ALL_BASE_DERIVED_SENSITIVITY,
    why: 'a release, deployment, or platform surface moved; affected integration evidence is stale',
  },
  GENERATED_INPUT: {
    behavior: 'reconcile-and-regenerate',
    invalidates: ALL_BASE_DERIVED_SENSITIVITY,
    why: 'a generator, generated output, or authoritative public inventory moved and must be regenerated',
  },
  DEPENDENCY: {
    behavior: 'reconcile',
    invalidates: ALL_BASE_DERIVED_SENSITIVITY,
    why: 'a dependency or toolchain input moved; install, build, portability, and integration evidence is stale',
  },
  SHARED_RUNTIME: {
    behavior: 'reconcile',
    invalidates: ALL_BASE_DERIVED_SENSITIVITY,
    why: 'a shared runtime surface moved; every dependent component and platform result must be reconciled',
  },
  CONFLICT: {
    behavior: 'integrator-intervention',
    invalidates: ALL_BASE_DERIVED_SENSITIVITY,
    why: 'the candidate and observed base edit the same structural path; integration requires an explicit resolution',
  },
  POLICY_OR_WORKFLOW: {
    behavior: 'immediate-integrity-stop',
    invalidates: ALL_BASE_DERIVED_SENSITIVITY,
    why: 'the manifest, workflow, hook, classifier, or shared gate tooling changed; policy-dependent evidence is stale',
  },
  UNKNOWN: {
    behavior: 'inconclusive',
    invalidates: ALL_BASE_DERIVED_SENSITIVITY,
    why: 'the canonical classifier could not establish the change risk; broad work may run but authorization remains inconclusive',
  },
};

const REASON_DRIFT: Readonly<Record<string, DriftClass>> = {
  'ci.classification.no-change': 'NONE',
  'ci.classification.docs-only': 'DISJOINT_METADATA',
  'ci.classification.application-code': 'AFFECTED_COMPONENT',
  'ci.classification.disjoint-code': 'DISJOINT_CODE',
  'ci.classification.release': 'AFFECTED_COMPONENT',
  'ci.classification.generator': 'GENERATED_INPUT',
  'ci.classification.generated-output': 'GENERATED_INPUT',
  'ci.classification.public-metadata': 'GENERATED_INPUT',
  'ci.classification.dependency-manifest': 'DEPENDENCY',
  'ci.classification.dependency-lock': 'DEPENDENCY',
  'ci.classification.gitlink': 'DEPENDENCY',
  'ci.classification.shared-runtime': 'SHARED_RUNTIME',
  'ci.classification.workflow': 'POLICY_OR_WORKFLOW',
  'ci.classification.hook': 'POLICY_OR_WORKFLOW',
  'ci.classification.shared-tooling': 'POLICY_OR_WORKFLOW',
  'ci.classification.policy': 'POLICY_OR_WORKFLOW',
  'ci.classification.executable-mode': 'POLICY_OR_WORKFLOW',
};

export interface PathClassification {
  path: string;
  drift: DriftClass;
  /** Canonical risk reason IDs. This adapter does not invent path-policy labels. */
  rule: string;
}

export interface DriftVerdict {
  drift: DriftClass;
  behavior: DriftBehavior;
  invalidates: readonly SensitivityTag[];
  classifications: readonly PathClassification[];
  unclassified: readonly string[];
  why: string;
}

const rank = (drift: DriftClass): number => DRIFT_CLASSES.indexOf(drift);

export function worstOf(left: DriftClass, right: DriftClass): DriftClass {
  return rank(left) >= rank(right) ? left : right;
}

export interface ClassifyOptions {
  candidatePaths?: readonly string[];
  analysisFailed?: boolean;
}

function syntheticFact(path: string): ChangeFactV1 {
  return {
    status: 'added',
    oldPath: null,
    path,
    oldMode: '000000',
    newMode: '100644',
    oldOid: '0'.repeat(40),
    newOid: '1'.repeat(40),
    oldType: 'absent',
    newType: 'blob',
    similarity: null,
  };
}

function classifyRiskDecision(risk: ReturnType<typeof classifyRiskFacts>): DriftClass {
  if (risk.inconclusive) return 'UNKNOWN';
  if (risk.reasons.some((reason) => REASON_DRIFT[reason] === undefined)) return 'UNKNOWN';
  return risk.reasons.reduce<DriftClass>(
    (drift, reason) => worstOf(drift, REASON_DRIFT[reason]!),
    'NONE',
  );
}

export function classifyDriftFacts(
  facts: readonly ChangeFactV1[],
  manifest: ControlManifestV1,
  options: ClassifyOptions = {},
): DriftVerdict {
  if (options.analysisFailed) return verdict('UNKNOWN', [], [], DRIFT_MATRIX.UNKNOWN.why);
  if (facts.length === 0) return verdict('NONE', [], [], DRIFT_MATRIX.NONE.why);

  const candidatePaths = new Set(options.candidatePaths ?? []);
  const classifications: PathClassification[] = [];
  const unclassified: string[] = [];
  const invalidates = new Set<SensitivityTag>();

  for (const fact of facts) {
    const structuralPaths = fact.oldPath === null ? [fact.path] : [fact.oldPath, fact.path];
    const risk = classifyRiskFacts(manifest, [fact]);
    const nativeDrift = classifyRiskDecision(risk);
    const conflicts = structuralPaths.some((path) => candidatePaths.has(path));
    const drift = conflicts ? worstOf(nativeDrift, 'CONFLICT') : nativeDrift;
    for (const tag of DRIFT_MATRIX[nativeDrift].invalidates) invalidates.add(tag);
    if (conflicts) for (const tag of DRIFT_MATRIX.CONFLICT.invalidates) invalidates.add(tag);
    if (risk.reasons.includes('ci.classification.unknown-path')) unclassified.push(fact.path);
    classifications.push({
      path: fact.path,
      drift,
      rule: [conflicts ? 'ci.lineage.path-conflict' : null, ...risk.reasons].filter(Boolean).join(',')
        || `ci.classification.tier.${risk.riskTier}`,
    });
  }

  const drift = classifications.reduce<DriftClass>((current, row) => worstOf(current, row.drift), 'NONE');
  return verdict(drift, classifications, unclassified, DRIFT_MATRIX[drift].why, [...invalidates]);
}

/** Authoritative adapter entry: project only validated exact-revision classifier results. */
export function projectDriftResult(
  observedAdmission: unknown,
  manifest: ControlManifestV1,
  candidateAdmission: unknown = null,
): DriftVerdict {
  if (!matchesSameProcessRiskClassificationAdmission(observedAdmission)
    || (candidateAdmission !== null && !matchesSameProcessRiskClassificationAdmission(candidateAdmission))) {
    return verdict('UNKNOWN', [], [], DRIFT_MATRIX.UNKNOWN.why);
  }
  const observed = observedAdmission.classification;
  const candidate = candidateAdmission === null
    ? null
    : (candidateAdmission as AdmittedRiskClassificationV1).classification;
  const manifestDigest = digestControlManifest(manifest);
  const candidateBindingsMatch = candidate === null || (
    candidate.outcome === 'pass'
    && candidate.baseOid === observed.baseOid
    && candidate.mergeBaseOid === observed.baseOid
    && candidate.mergeOid === null
    && candidate.manifestDigest === observed.manifestDigest
    && candidate.classifierDigest === observed.classifierDigest
  );
  if (observed.outcome !== 'pass'
    || observed.baseOid === null
    || observed.mergeBaseOid !== observed.baseOid
    || observed.mergeOid !== null
    || observed.manifestDigest !== manifestDigest
    || !candidateBindingsMatch) {
    return verdict('UNKNOWN', [], [], DRIFT_MATRIX.UNKNOWN.why);
  }
  const candidatePaths = candidate === null
    ? []
    : candidate.changed.flatMap((fact) => fact.oldPath === null ? [fact.path] : [fact.oldPath, fact.path]);
  return classifyDriftFacts(observed.changed, manifest, { candidatePaths });
}

/** Test/self-check convenience that still delegates all path policy to the manifest. */
export function classifyDrift(
  changedPaths: readonly string[],
  manifest: ControlManifestV1,
  options: ClassifyOptions = {},
): DriftVerdict {
  return classifyDriftFacts(changedPaths.map(syntheticFact), manifest, options);
}

function verdict(
  drift: DriftClass,
  classifications: readonly PathClassification[],
  unclassified: readonly string[],
  why: string,
  invalidates: readonly SensitivityTag[] = DRIFT_MATRIX[drift].invalidates,
): DriftVerdict {
  const spec = DRIFT_MATRIX[drift];
  return { drift, behavior: spec.behavior, invalidates, classifications, unclassified, why };
}

export function receiptSurvives(tags: readonly SensitivityTag[], drift: DriftClass): boolean {
  const invalid = new Set<SensitivityTag>(DRIFT_MATRIX[drift].invalidates);
  return !tags.some((tag) => invalid.has(tag));
}

export const RECEIPT_TAG_EXAMPLES: Readonly<Record<string, readonly SensitivityTag[]>> = {
  'formatter (candidate OID)': ['candidate-only'],
  'isolated package unit test': ['candidate-only', 'toolchain-sensitive'],
  'documentation index': ['base-sensitive'],
  'dependency install': ['base-sensitive', 'toolchain-sensitive'],
  'integration suite': ['merge-sensitive'],
  'workflow policy check': ['policy-sensitive'],
  'release artifact': ['merge-sensitive', 'policy-sensitive', 'toolchain-sensitive'],
};

export const EXIT_CONTINUE = 0;
export const EXIT_STOP = 1;
export const EXIT_INCONCLUSIVE = 2;

export function exitCodeFor(drift: DriftClass): number {
  if (drift === 'NONE' || drift === 'DISJOINT_METADATA' || drift === 'DISJOINT_CODE') return EXIT_CONTINUE;
  if (drift === 'CONFLICT') return EXIT_STOP;
  return EXIT_INCONCLUSIVE;
}

export function outcomeForDrift(drift: DriftClass): DriftOutcome {
  if (drift === 'NONE') return 'pass';
  if (drift === 'DISJOINT_METADATA' || drift === 'DISJOINT_CODE') return 'warn';
  if (drift === 'CONFLICT') return 'block';
  return 'inconclusive';
}

export function codeForDrift(drift: DriftClass): string {
  if (drift === 'NONE') return 'git.lineage.base.unchanged';
  if (drift === 'DISJOINT_METADATA' || drift === 'DISJOINT_CODE') return 'git.lineage.base.drift-disjoint';
  if (drift === 'POLICY_OR_WORKFLOW') return 'git.lineage.base.drift-policy';
  if (drift === 'CONFLICT') return 'git.merge.result.conflict';
  if (drift === 'UNKNOWN') return 'ci.native.receipt-unavailable';
  return 'git.lineage.base.drift-relevant';
}
