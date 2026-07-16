import type {
  BoundaryAction,
  BoundaryArtifact,
  BoundaryEvidenceRecord,
  BoundaryFinding,
} from './boundary-types.ts';
import {
  canonicalRepositoryPath,
  canonicalPathBlobRecords,
  contentFingerprintSha256,
  type PathBlobRecord,
  type ProposalIdentity,
} from './fingerprint.ts';
import {
  canonicalHistoryArtifact,
  isValidHistoryTimestamp,
  type HistoryCollection,
} from './history-provider.ts';
import type { HistoryArtifactRecord } from './history-types.ts';

export interface ReentryPacket {
  priorArtifactRefs: string[];
  addressedConditions: string[];
  deltaKind: 'material' | 'test-only' | 'docs-only' | 'format-only' | 'fixture-hygiene';
  productionOwner?: string | null;
  override?: {
    owner: string;
    ruleId: string;
    fingerprintSha256: string;
    reason: string;
    expiresAt: string;
    sourceRef: string;
  } | null;
}

interface PreparedArtifact {
  artifact: HistoryArtifactRecord;
  contentFingerprintSha256: string | null;
  recordKeys: Set<string>;
  paths: Set<string>;
}

const RERUN = 'npm run verify:boundary';
const SHA256_RE = /^[0-9a-f]{64}$/;
const GIT_OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function artifactKey(artifact: HistoryArtifactRecord): string {
  return `${artifact.kind}#${artifact.number}`;
}

function compareArtifacts(left: HistoryArtifactRecord, right: HistoryArtifactRecord): number {
  if (left.kind < right.kind) return -1;
  if (left.kind > right.kind) return 1;
  return left.number - right.number;
}

function validStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === 'string' && entry.trim().length > 0) &&
    new Set(value).size === value.length
  );
}

function recordKey(record: PathBlobRecord): string {
  return JSON.stringify(record);
}

function prepareArtifact(artifact: HistoryArtifactRecord): PreparedArtifact {
  const records = artifact.pathBlobSet ? canonicalPathBlobRecords(artifact.pathBlobSet) : [];
  return {
    artifact,
    contentFingerprintSha256: records.length > 0 ? contentFingerprintSha256(records) : null,
    recordKeys: new Set(records.map(recordKey)),
    paths: new Set(
      records.flatMap((record) => [record.oldPath, record.path].filter(Boolean) as string[]),
    ),
  };
}

function toBoundaryArtifact(
  prepared: PreparedArtifact,
  fingerprintSha256?: string | null,
): BoundaryArtifact {
  return {
    kind: prepared.artifact.kind,
    repository: prepared.artifact.repository,
    id: String(prepared.artifact.number),
    url: prepared.artifact.url,
    state: prepared.artifact.state,
    ...(fingerprintSha256 ? { fingerprintSha256 } : {}),
  };
}

function sourceRefs(matches: PreparedArtifact[]): string[] {
  return uniqueSorted(matches.map((match) => match.artifact.url));
}

function dispositionEvidence(matches: PreparedArtifact[]): BoundaryEvidenceRecord[] {
  return matches.flatMap((match) =>
    match.artifact.disposition
      ? [
          {
            label: `prior_disposition_${match.artifact.number}`,
            value: match.artifact.disposition.category,
          },
        ]
      : [],
  );
}

function finding(input: {
  action: BoundaryAction;
  ruleId: string;
  decision: BoundaryFinding['decision'];
  summary: string;
  why: string;
  observed: BoundaryEvidenceRecord[];
  matches?: PreparedArtifact[];
  fingerprint?: (match: PreparedArtifact) => string | null | undefined;
  correction: string[];
  sourceRefs?: string[];
}): BoundaryFinding {
  const matches = input.matches ?? [];
  return {
    ruleId: input.ruleId,
    decision: input.decision,
    action: input.action,
    summary: input.summary,
    why: input.why,
    observed: input.observed,
    matchedArtifacts: matches.map((match) => toBoundaryArtifact(match, input.fingerprint?.(match))),
    correction: input.correction,
    rerun: RERUN,
    sourceRefs: input.sourceRefs ?? sourceRefs(matches),
  };
}

function incompleteFinding(
  action: BoundaryAction,
  collection: HistoryCollection,
  limitations: string[],
): BoundaryFinding {
  const observed = (
    limitations.length > 0 ? limitations : ['history collection did not prove a terminal page']
  ).map((value) => ({ label: 'limitation', value }));
  return finding({
    action,
    ruleId: 'history.evidence-incomplete',
    decision: 'inconclusive',
    summary: 'Repository history evidence is incomplete.',
    why: 'A bounded history read must prove repository identity and a terminal cursor before it can authorize a clean boundary result.',
    observed,
    correction: [
      'Repair the provider failure or increase the explicit bound, then rerun the read-only history check.',
      'Do not treat retained partial artifacts as proof that no duplicate exists.',
    ],
    sourceRefs: collection.observedAt.map((value) => `history-observed:${value}`),
  });
}

function exactFinding(
  action: BoundaryAction,
  state: HistoryArtifactRecord['state'],
  matches: PreparedArtifact[],
  candidateFingerprint: string,
): BoundaryFinding {
  const count = matches.length;
  const noun = count === 1 ? 'pull request' : 'pull requests';
  const hasDisposition = matches.some((match) => match.artifact.disposition != null);
  if (state === 'open') {
    return finding({
      action,
      ruleId: 'history.exact-open-pr',
      decision: 'block',
      summary: `Candidate content exactly matches ${count} open ${noun}.`,
      why: 'The canonical changed path/blob identity is identical, independent of branch or proposal identity.',
      observed: [
        { label: 'content_fingerprint_sha256', value: candidateFingerprint },
        { label: 'match_count', value: String(count) },
        ...dispositionEvidence(matches),
      ],
      matches,
      fingerprint: () => candidateFingerprint,
      correction: [
        'Continue through the existing open pull request instead of creating another artifact.',
        'If the work is materially different, change the implementation and rerun the boundary check.',
      ],
    });
  }
  if (state === 'merged') {
    return finding({
      action,
      ruleId: 'history.exact-merged-pr',
      decision: 'warn',
      summary: `Candidate content exactly matches ${count} merged ${noun}.`,
      why: 'Merged work may have been reverted or made unreachable, but recreation requires proof rather than a duplicate artifact.',
      observed: [
        { label: 'content_fingerprint_sha256', value: candidateFingerprint },
        { label: 'match_count', value: String(count) },
      ],
      matches,
      fingerprint: () => candidateFingerprint,
      correction: [
        'Prove the behavior is absent from current main and show production reachability before recreating it.',
        'Link the merged artifact and explain the new material delta.',
      ],
    });
  }
  return finding({
    action,
    ruleId: 'history.exact-closed-pr',
    decision: 'block',
    summary: `Candidate content exactly matches ${count} closed-unmerged ${noun}.`,
    why: 'Exact content evidence survives branch deletion and proposal recreation, so a new artifact would repeat prior work.',
    observed: [
      { label: 'content_fingerprint_sha256', value: candidateFingerprint },
      { label: 'match_count', value: String(count) },
      ...dispositionEvidence(matches),
    ],
    matches,
    fingerprint: () => candidateFingerprint,
    correction: hasDisposition
      ? [
          'Satisfy every recorded disposition with a material re-entry packet before recreating this work.',
          'Name the production owner and cite every prior artifact and required condition.',
        ]
      : [
          'Continue from the existing artifact or provide a material re-entry packet that proves the implementation changed.',
        ],
  });
}

function isSubset(left: Set<string>, right: Set<string>): boolean {
  return left.size > 0 && [...left].every((value) => right.has(value));
}

function intersects(left: Set<string>, right: Set<string>): boolean {
  return [...left].some((value) => right.has(value));
}

function reentryFinding(input: {
  action: BoundaryAction;
  candidate: ProposalIdentity;
  reentry: ReentryPacket;
  matches: PreparedArtifact[];
  now: Date;
  verifiedOverrideOwners: ReadonlySet<string>;
  candidatePaths: ReadonlySet<string>;
}): BoundaryFinding | null {
  const observed: BoundaryEvidenceRecord[] = dispositionEvidence(input.matches);
  const packet = input.reentry as Partial<ReentryPacket>;
  const priorRefsValid = validStringArray(packet.priorArtifactRefs);
  const conditionsValid = validStringArray(packet.addressedConditions);
  const priorRefs = priorRefsValid ? packet.priorArtifactRefs! : [];
  const addressedConditions = conditionsValid ? packet.addressedConditions! : [];
  const requiredRefs = uniqueSorted(
    input.matches.flatMap((match) => [
      match.artifact.url,
      ...(match.artifact.disposition?.artifactRefs ?? []),
    ]),
  );
  const requiredConditions = uniqueSorted(
    input.matches.flatMap((match) => match.artifact.disposition?.reentryConditions ?? []),
  );
  const missingRefs = requiredRefs.filter((value) => !priorRefs.includes(value));
  const missingConditions = requiredConditions.filter(
    (value) => !addressedConditions.includes(value),
  );

  observed.push({ label: 'delta_kind', value: String(packet.deltaKind ?? 'missing') });
  let productionOwnerPath: string | null = null;
  if (typeof packet.productionOwner === 'string' && packet.productionOwner.trim().length > 0) {
    try {
      productionOwnerPath = canonicalRepositoryPath(packet.productionOwner, 'productionOwner');
    } catch {
      observed.push({ label: 'packet_error', value: 'productionOwner invalid' });
    }
  }
  const productionOwnerChanged =
    productionOwnerPath !== null && input.candidatePaths.has(productionOwnerPath);
  observed.push({
    label: 'production_owner',
    value: productionOwnerPath ?? 'missing',
  });
  observed.push({ label: 'production_owner_changed', value: String(productionOwnerChanged) });
  if (!priorRefsValid) observed.push({ label: 'packet_error', value: 'priorArtifactRefs invalid' });
  if (!conditionsValid) {
    observed.push({ label: 'packet_error', value: 'addressedConditions invalid' });
  }
  observed.push(...missingRefs.map((value) => ({ label: 'missing_artifact_ref', value })));
  observed.push(...missingConditions.map((value) => ({ label: 'missing_condition', value })));

  if (packet.override != null) {
    const override = packet.override;
    const overrideFailures: string[] = [];
    if (typeof override.owner !== 'string' || override.owner.trim().length === 0) {
      overrideFailures.push('owner is missing');
    } else if (!input.verifiedOverrideOwners.has(override.owner)) {
      overrideFailures.push('owner authority is unverified');
    }
    if (override.ruleId !== 'history.incomplete-reentry') {
      overrideFailures.push('rule scope does not match');
    }
    if (
      typeof override.fingerprintSha256 !== 'string' ||
      !SHA256_RE.test(override.fingerprintSha256) ||
      override.fingerprintSha256 !== input.candidate.proposalFingerprintSha256
    ) {
      overrideFailures.push('proposal fingerprint scope does not match');
    }
    if (typeof override.reason !== 'string' || override.reason.trim().length === 0) {
      overrideFailures.push('reason is missing');
    }
    if (
      !isValidHistoryTimestamp(override.expiresAt) ||
      Date.parse(override.expiresAt) <= input.now.getTime()
    ) {
      overrideFailures.push('override is expired or has an invalid expiry');
    }
    if (
      typeof override.sourceRef !== 'string' ||
      !priorRefs.includes(override.sourceRef) ||
      !requiredRefs.includes(override.sourceRef)
    ) {
      overrideFailures.push('override source is not a cited prior artifact');
    }
    if (!priorRefsValid || missingRefs.length > 0) {
      overrideFailures.push('prior artifact scope is incomplete');
    }
    if (overrideFailures.length === 0) return null;
    observed.push(...overrideFailures.map((value) => ({ label: 'override_error', value })));
  } else {
    const materialPacketComplete =
      packet.deltaKind === 'material' &&
      productionOwnerChanged &&
      priorRefsValid &&
      conditionsValid &&
      missingRefs.length === 0 &&
      missingConditions.length === 0;
    if (materialPacketComplete) return null;
  }

  return finding({
    action: input.action,
    ruleId: 'history.incomplete-reentry',
    decision: 'block',
    summary: 'The resubmission does not satisfy the recorded disposition.',
    why: 'Cosmetic deltas, incomplete packets, and ambient overrides cannot cure an architectural rejection.',
    observed,
    matches: input.matches,
    fingerprint: (match) => match.contentFingerprintSha256,
    correction: [
      'Cite every prior artifact and address every recorded re-entry condition.',
      'Provide a material implementation delta and name its production owner, or attach a current owner override scoped to this rule and proposal fingerprint.',
    ],
  });
}

export function evaluateHistory(input: {
  action: BoundaryAction;
  candidate: ProposalIdentity & { pathBlobSet: PathBlobRecord[] };
  collection: HistoryCollection;
  reentry?: ReentryPacket | null;
  verifiedOverrideOwners?: string[];
  now: Date;
}): BoundaryFinding[] {
  if (!input.collection.complete) {
    return [incompleteFinding(input.action, input.collection, input.collection.limitations)];
  }
  if (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) {
    return [incompleteFinding(input.action, input.collection, ['history policy clock is invalid'])];
  }
  if (
    input.verifiedOverrideOwners !== undefined &&
    !validStringArray(input.verifiedOverrideOwners)
  ) {
    return [
      incompleteFinding(input.action, input.collection, [
        'verified override owner evidence is invalid',
      ]),
    ];
  }
  const verifiedOverrideOwners = new Set(input.verifiedOverrideOwners ?? []);

  let candidateRecords: PathBlobRecord[];
  let candidateFingerprint: string;
  let prepared: PreparedArtifact[];
  try {
    candidateRecords = canonicalPathBlobRecords(input.candidate.pathBlobSet);
    candidateFingerprint = contentFingerprintSha256(candidateRecords);
    if (candidateFingerprint !== input.candidate.contentFingerprintSha256) {
      throw new Error('candidate content fingerprint does not match its path/blob evidence');
    }
    if (input.candidate.patchIdStable != null && !GIT_OID_RE.test(input.candidate.patchIdStable)) {
      throw new Error('candidate stable patch identity is invalid');
    }
    if (
      input.candidate.taskFingerprintSha256 != null &&
      !SHA256_RE.test(input.candidate.taskFingerprintSha256)
    ) {
      throw new Error('candidate task fingerprint is invalid');
    }
    const identities = new Set<string>();
    prepared = input.collection.artifacts
      .map((artifact) => canonicalHistoryArtifact(artifact, input.collection.repository))
      .sort(compareArtifacts)
      .map((artifact) => {
        const key = artifactKey(artifact);
        if (identities.has(key)) throw new Error(`duplicate artifact identity ${key}`);
        identities.add(key);
        return prepareArtifact(artifact);
      });
  } catch (error) {
    return [
      incompleteFinding(input.action, input.collection, [
        `history evidence validation failed: ${error instanceof Error ? error.message : String(error)}`,
      ]),
    ];
  }

  const findings: BoundaryFinding[] = [];
  const reported = new Set<string>();
  const pullRequests = prepared.filter((item) => item.artifact.kind === 'pull-request');
  for (const state of ['open', 'closed-unmerged', 'merged'] as const) {
    const matches = pullRequests.filter(
      (item) =>
        item.artifact.state === state && item.contentFingerprintSha256 === candidateFingerprint,
    );
    if (matches.length > 0) {
      findings.push(exactFinding(input.action, state, matches, candidateFingerprint));
      matches.forEach((match) => reported.add(artifactKey(match.artifact)));
    }
  }

  if (input.candidate.patchIdStable != null) {
    const matches = pullRequests.filter(
      (item) =>
        !reported.has(artifactKey(item.artifact)) &&
        item.artifact.state === 'closed-unmerged' &&
        item.artifact.patchIdStable === input.candidate.patchIdStable,
    );
    if (matches.length > 0) {
      findings.push(
        finding({
          action: input.action,
          ruleId: 'history.renamed-patch-closed-pr',
          decision: 'block',
          summary: `The stable patch matches ${matches.length} closed-unmerged pull request${matches.length === 1 ? '' : 's'}.`,
          why: 'A stable patch identity detects recreated work even when paths or proposal commits changed.',
          observed: [
            { label: 'patch_id_stable', value: input.candidate.patchIdStable },
            { label: 'match_count', value: String(matches.length) },
            ...dispositionEvidence(matches),
          ],
          matches,
          correction: [
            'Review and satisfy the prior disposition before recreating this patch.',
            'If the new implementation is materially different, ensure its stable patch identity changes and explain why.',
          ],
        }),
      );
      matches.forEach((match) => reported.add(artifactKey(match.artifact)));
    }
  }

  const candidateKeys = new Set(candidateRecords.map(recordKey));
  const candidatePaths = new Set(
    candidateRecords.flatMap((record) => [record.oldPath, record.path].filter(Boolean) as string[]),
  );
  const subsetMatches = pullRequests.filter((item) => {
    if (reported.has(artifactKey(item.artifact))) return false;
    return (
      intersects(candidateKeys, item.recordKeys) &&
      (isSubset(candidateKeys, item.recordKeys) || isSubset(item.recordKeys, candidateKeys))
    );
  });
  if (subsetMatches.length > 0) {
    findings.push(
      finding({
        action: input.action,
        ruleId: 'history.blob-subset',
        decision: 'warn',
        summary: `Candidate blobs are a subset or superset of ${subsetMatches.length} prior pull request${subsetMatches.length === 1 ? '' : 's'}.`,
        why: 'Exact blob reuse is stronger than path similarity but may still represent a legitimate shared refactor.',
        observed: [{ label: 'match_count', value: String(subsetMatches.length) }],
        matches: subsetMatches,
        fingerprint: (match) => match.contentFingerprintSha256,
        correction: [
          'Link each prior artifact and explain which reused blobs are intentional.',
          'Confirm the new production owner does not duplicate an existing mechanism.',
        ],
      }),
    );
    subsetMatches.forEach((match) => reported.add(artifactKey(match.artifact)));
  }

  const pathMatches = pullRequests.filter(
    (item) => !reported.has(artifactKey(item.artifact)) && intersects(candidatePaths, item.paths),
  );
  if (pathMatches.length > 0) {
    findings.push(
      finding({
        action: input.action,
        ruleId: 'history.path-overlap',
        decision: 'warn',
        summary: `Candidate paths overlap ${pathMatches.length} prior pull request${pathMatches.length === 1 ? '' : 's'}.`,
        why: 'A full repository-path overlap is contextual evidence, not proof of duplicate behavior or content.',
        observed: [{ label: 'match_count', value: String(pathMatches.length) }],
        matches: pathMatches,
        fingerprint: (match) => match.contentFingerprintSha256,
        correction: [
          'Link the overlapping artifact and describe the behavior-level distinction.',
          'Do not infer duplication from a shared filename or branch label alone.',
        ],
      }),
    );
    pathMatches.forEach((match) => reported.add(artifactKey(match.artifact)));
  }

  if (input.candidate.taskFingerprintSha256 != null) {
    const issueMatches = prepared.filter(
      (item) =>
        item.artifact.kind === 'issue' &&
        item.artifact.taskFingerprintSha256 === input.candidate.taskFingerprintSha256,
    );
    if (issueMatches.length > 0) {
      const openingIssue = input.action === 'open-issue';
      findings.push(
        finding({
          action: input.action,
          ruleId: 'history.exact-issue',
          decision: openingIssue ? 'block' : 'warn',
          summary: `The normalized task exactly matches ${issueMatches.length} existing issue${issueMatches.length === 1 ? '' : 's'}.`,
          why: 'The normalized title/body identity is exact; title-only or semantic similarity is not used as a blocker.',
          observed: [
            {
              label: 'task_fingerprint_sha256',
              value: input.candidate.taskFingerprintSha256,
            },
            { label: 'match_count', value: String(issueMatches.length) },
          ],
          matches: issueMatches,
          fingerprint: () => input.candidate.taskFingerprintSha256,
          correction: openingIssue
            ? [
                'Continue on the existing issue instead of creating another issue.',
                'If acceptance criteria differ, update the task body so the material distinction is explicit.',
              ]
            : ['Link the existing issue and map this change to its acceptance criteria.'],
        }),
      );
    }
  }

  if (input.reentry != null) {
    const packetRefs = Array.isArray(input.reentry.priorArtifactRefs)
      ? input.reentry.priorArtifactRefs
      : [];
    const disposed = pullRequests.filter((item) => {
      if (!item.artifact.disposition) return false;
      if (reported.has(artifactKey(item.artifact))) return true;
      const refs = [item.artifact.url, ...item.artifact.disposition.artifactRefs];
      return refs.some((ref) => packetRefs.includes(ref));
    });
    if (disposed.length > 0) {
      const dispositionFinding = reentryFinding({
        action: input.action,
        candidate: input.candidate,
        reentry: input.reentry,
        matches: disposed,
        now: input.now,
        verifiedOverrideOwners,
        candidatePaths: new Set(candidateRecords.map((record) => record.path)),
      });
      if (dispositionFinding) findings.push(dispositionFinding);
    }
  }

  return findings;
}
