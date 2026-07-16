import { assertNoSecretLike } from '../../artifact-redaction.ts';

import type {
  BoundaryAction,
  BoundaryArtifact,
  BoundaryEvidenceRecord,
  BoundaryFinding,
} from './boundary-types.ts';
import { canonicalRepositoryPath } from './fingerprint.ts';
import { isValidHistoryTimestamp } from './history-provider.ts';

export interface ProvenanceObservation {
  repository: string;
  remoteTipOid: string | null;
  localTrackingOid: string | null;
  mergeBaseOid: string | null;
  headOid: string | null;
  aheadCount: number | null;
  behindCount: number | null;
  candidatePaths: string[] | null;
  upstreamPaths: string[] | null;
  highCouplingPaths: string[];
  observedAt: string | null;
  evidenceSource: string;
  complete: boolean;
  limitations: string[];
}

const RERUN = 'npm run verify:boundary';
const GIT_OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const REPOSITORY_RE = /^[^/\s]+\/[^/\s]+$/;

function bounded(value: unknown): string {
  const text = String(value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 240);
  try {
    assertNoSecretLike(text, 'provenance evidence');
    return text;
  } catch {
    return 'redacted-sensitive-value';
  }
}

function sourceReference(value: unknown): string {
  const text = bounded(value);
  if (text === 'redacted-sensitive-value' || text.length === 0) {
    return 'upstream-provenance:redacted';
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    try {
      const parsed = new URL(text);
      if (parsed.username || parsed.password || parsed.search) {
        return 'upstream-provenance:redacted';
      }
    } catch {
      return 'upstream-provenance:redacted';
    }
  }
  return text;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function validLimitations(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string' && item.trim().length > 0)
  );
}

function canonicalOid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !GIT_OID_RE.test(value)) {
    throw new Error(`${label} object identity is missing or invalid`);
  }
  return value.toLowerCase();
}

function canonicalCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} count is missing or invalid`);
  }
  return Number(value);
}

function canonicalPaths(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} paths are incomplete`);
  try {
    return uniqueSorted(
      value.map((path, index) => canonicalRepositoryPath(path, `${label}[${index}]`)),
    );
  } catch (error) {
    throw new Error(`${label} path evidence is invalid: ${bounded(error)}`);
  }
}

function pathArtifacts(
  repository: string,
  overlapPaths: string[],
  highCouplingPaths: string[],
): BoundaryArtifact[] {
  const overlap = new Set(overlapPaths);
  return uniqueSorted([...overlapPaths, ...highCouplingPaths]).map((path) => ({
    kind: 'path',
    repository,
    id: path,
    state: overlap.has(path) ? 'upstream-overlap' : 'high-coupling-upstream',
  }));
}

function unavailable(
  action: BoundaryAction,
  observation: ProvenanceObservation,
  limitations: string[],
): BoundaryFinding {
  return {
    ruleId: 'provenance.unavailable',
    decision: 'inconclusive',
    action,
    summary: 'Upstream provenance could not be proven.',
    why: 'A clean boundary result requires a complete remote tip, tracking ref, merge base, revision count, and path observation.',
    observed: limitations.map((value) => ({ label: 'limitation', value: bounded(value) })),
    matchedArtifacts: [],
    correction: [
      'Restore read access to the configured upstream and fetch its current tip.',
      'Recompute the merge base, revision counts, and changed paths from the same remote observation.',
    ],
    rerun: RERUN,
    sourceRefs: [sourceReference(observation.evidenceSource || 'upstream-provenance:unknown')],
  };
}

function intersects(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((value) => rightSet.has(value));
}

export function evaluateProvenance(input: {
  action: BoundaryAction;
  observation: ProvenanceObservation;
}): BoundaryFinding[] {
  const observation = input.observation;
  if (!observation || typeof observation !== 'object') {
    return [
      unavailable(input.action, {} as ProvenanceObservation, ['provenance observation is missing']),
    ];
  }
  if (!validLimitations(observation.limitations)) {
    return [unavailable(input.action, observation, ['provenance limitations are invalid'])];
  }
  if (!observation.complete || observation.limitations.length > 0) {
    return [
      unavailable(
        input.action,
        observation,
        observation.limitations.length > 0
          ? observation.limitations
          : ['provenance observation is incomplete'],
      ),
    ];
  }
  if (!REPOSITORY_RE.test(observation.repository)) {
    return [unavailable(input.action, observation, ['repository identity is invalid'])];
  }
  if (
    typeof observation.evidenceSource !== 'string' ||
    observation.evidenceSource.trim().length === 0
  ) {
    return [unavailable(input.action, observation, ['evidence source is missing'])];
  }
  if (!isValidHistoryTimestamp(observation.observedAt)) {
    return [unavailable(input.action, observation, ['observation timestamp is invalid'])];
  }

  let remoteTipOid: string;
  let localTrackingOid: string;
  let headOid: string;
  let mergeBaseOid: string | null;
  let candidatePaths: string[];
  let upstreamPaths: string[];
  let highCouplingPaths: string[];
  try {
    remoteTipOid = canonicalOid(observation.remoteTipOid, 'remote tip');
    localTrackingOid = canonicalOid(observation.localTrackingOid, 'local tracking tip');
    headOid = canonicalOid(observation.headOid, 'head');
    mergeBaseOid =
      observation.mergeBaseOid == null
        ? null
        : canonicalOid(observation.mergeBaseOid, 'merge base');
    candidatePaths = canonicalPaths(observation.candidatePaths, 'candidate');
    upstreamPaths = canonicalPaths(observation.upstreamPaths, 'upstream');
    highCouplingPaths = canonicalPaths(observation.highCouplingPaths, 'high-coupling');
  } catch (error) {
    return [
      unavailable(input.action, observation, [
        `provenance evidence validation failed: ${bounded(error)}`,
      ]),
    ];
  }

  if (localTrackingOid !== remoteTipOid) {
    return [
      {
        ruleId: 'provenance.stale-tracking-ref',
        decision: 'block',
        action: input.action,
        summary: 'The local tracking ref differs from the remotely observed tip.',
        why: 'A stale local tracking identity invalidates every downstream merge-base, overlap, and duplicate comparison.',
        observed: [
          { label: 'remote_tip_oid', value: remoteTipOid },
          { label: 'local_tracking_oid', value: localTrackingOid },
          { label: 'observed_at', value: observation.observedAt },
        ],
        matchedArtifacts: [],
        correction: [
          'Fetch the configured upstream and verify the local tracking ref now equals the observed remote tip.',
          'Recompute the merge base, revision counts, changed paths, and semantic boundary receipt.',
        ],
        rerun: RERUN,
        sourceRefs: [sourceReference(observation.evidenceSource)],
      },
    ];
  }

  if (mergeBaseOid === null) {
    return [unavailable(input.action, observation, ['merge base was not proven'])];
  }

  let aheadCount: number;
  let behindCount: number;
  try {
    aheadCount = canonicalCount(observation.aheadCount, 'ahead');
    behindCount = canonicalCount(observation.behindCount, 'behind');
  } catch (error) {
    return [unavailable(input.action, observation, [bounded(error)])];
  }

  const consistencyLimitations: string[] = [];
  if (headOid === remoteTipOid && (aheadCount !== 0 || behindCount !== 0)) {
    consistencyLimitations.push('equal head and remote identities require zero revision counts');
  }
  if (behindCount === 0 && mergeBaseOid !== remoteTipOid) {
    consistencyLimitations.push('zero behind count requires the remote tip to be the merge base');
  }
  if (aheadCount === 0 && mergeBaseOid !== headOid) {
    consistencyLimitations.push('zero ahead count requires the head to be the merge base');
  }
  if (behindCount === 0 && upstreamPaths.length > 0) {
    consistencyLimitations.push('zero behind count cannot advertise upstream delta paths');
  }
  if (consistencyLimitations.length > 0) {
    return [unavailable(input.action, observation, consistencyLimitations)];
  }

  if (behindCount === 0) return [];

  const overlapPaths = intersects(candidatePaths, upstreamPaths);
  const changedHighCouplingPaths = intersects(upstreamPaths, highCouplingPaths);
  if (overlapPaths.length > 0 || changedHighCouplingPaths.length > 0) {
    const observed: BoundaryEvidenceRecord[] = [
      { label: 'merge_base_oid', value: mergeBaseOid },
      { label: 'remote_tip_oid', value: remoteTipOid },
      { label: 'behind_count', value: String(behindCount) },
      ...overlapPaths.map((value) => ({ label: 'overlap_path', value })),
      ...changedHighCouplingPaths.map((value) => ({ label: 'high_coupling_path', value })),
    ];
    return [
      {
        ruleId: 'provenance.stale-overlap',
        decision: 'block',
        action: input.action,
        summary: 'The candidate base is older and intersects safety-relevant upstream changes.',
        why: 'Direct path overlap or an upstream change on a declared high-coupling surface requires deliberate reconciliation before boundary actions continue.',
        observed,
        matchedArtifacts: pathArtifacts(
          observation.repository,
          overlapPaths,
          changedHighCouplingPaths,
        ),
        correction: [
          'Fetch the remote tip and deliberately rebase or merge the upstream delta.',
          'Rerun tests for every named overlap or high-coupling path before rerunning the boundary check.',
        ],
        rerun: RERUN,
        sourceRefs: [sourceReference(observation.evidenceSource)],
      },
    ];
  }

  return [
    {
      ruleId: 'provenance.stale-disjoint',
      decision: 'warn',
      action: input.action,
      summary: 'The candidate base is older, but the observed upstream delta is disjoint.',
      why: 'Disjoint repository paths reduce immediate collision risk but do not make the older base invisible.',
      observed: [
        { label: 'merge_base_oid', value: mergeBaseOid },
        { label: 'remote_tip_oid', value: remoteTipOid },
        { label: 'ahead_count', value: String(aheadCount) },
        { label: 'behind_count', value: String(behindCount) },
        { label: 'path_overlap', value: 'false' },
      ],
      matchedArtifacts: [],
      correction: [
        'Fetch and review the upstream delta before the next material edit.',
        'Rebase or merge when required by branch policy, then rerun the boundary check.',
      ],
      rerun: RERUN,
      sourceRefs: [sourceReference(observation.evidenceSource)],
    },
  ];
}
