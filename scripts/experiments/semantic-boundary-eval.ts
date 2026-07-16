import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  analyzeReachability,
  buildModuleGraph,
  type ModuleSource,
} from '../lib/semantic-quality/module-graph.ts';
import { readCandidateTree } from '../lib/semantic-quality/git-tree.ts';
import {
  buildProposalIdentity,
  contentFingerprintSha256,
  taskFingerprintSha256,
  type PathBlobRecord as ProductionPathBlobRecord,
  type PathBlobStatus,
  type ProposalIdentity,
} from '../lib/semantic-quality/fingerprint.ts';
import { evaluateHistory, type ReentryPacket } from '../lib/semantic-quality/history.ts';
import type { HistoryCollection } from '../lib/semantic-quality/history-provider.ts';
import type {
  DispositionCategory,
  HistoryArtifactRecord,
} from '../lib/semantic-quality/history-types.ts';
import {
  evaluateProvenance,
  type ProvenanceObservation,
} from '../lib/semantic-quality/provenance.ts';
import type { BoundaryFinding } from '../lib/semantic-quality/boundary-types.ts';
import {
  aggregateBoundaryDecision,
  isBoundaryFindingComplete,
  type BoundaryDecision as SemanticBoundaryDecision,
} from '../lib/semantic-quality/receipt.ts';

export type BoundaryDecision = SemanticBoundaryDecision;

export interface EvaluationCase {
  id: string;
  cohort: 'visible-pr' | 'synthetic';
  evidence: 'detector-backed' | 'manual-visible' | 'synthetic';
  expected: BoundaryDecision;
  currentDecision: BoundaryDecision;
  rationale: string;
  sourceRefs: string[];
  semantic?:
    | { kind: 'fixture'; graph: string; changedModules: string[] }
    | { kind: 'git'; revision: string; changedModules: string[] };
  proposal?: {
    number: number;
    state: 'open' | 'closed-unmerged' | 'merged';
    pathBlobSet: PathBlobRecord[];
  };
  history?: {
    exactMatch?: 'open' | 'closed-unmerged';
    matchedPr?: number;
    subsetMatch?: boolean;
    renamedPatchClosed?: boolean;
    pathOverlap?: boolean;
    sameFilenameOnly?: boolean;
    exactIssue?: boolean;
    similarIssue?: boolean;
    matchedIssue?: number;
  };
  reentry?: {
    priorDisposition: string;
    delta: 'cosmetic' | 'material';
    packetComplete: boolean;
    ownerOverride: boolean;
  };
  provenance?: {
    remoteAvailable: boolean;
    trackingMatches: boolean;
    mergeBaseAvailable: boolean;
    olderBase: boolean;
    overlap: boolean;
    highCoupling: boolean;
  };
  supply?: {
    actionRefs?: string[];
    dockerBases?: string[];
    runnerLabels?: string[];
    provenanceManifest?: boolean;
  };
  process?: { bounded: boolean; ownsProcessGroup: boolean };
  guardChange?: { negativeControlChanged: boolean };
  timeout?: boolean;
}

export interface PathBlobRecord {
  status: string;
  oldPath?: string;
  path: string;
  blobOid: string;
}

export interface Corpus {
  schemaVersion: number;
  lockedAt: string;
  primaryMetric: string;
  target: { minimumAccuracy: number; maximumFalseBlocks: number };
  productionRoots: string[];
  graphs: Record<string, Record<string, string>>;
  cases: EvaluationCase[];
}

export interface EvaluationSummary {
  engine: 'baseline' | 'candidate';
  corpusLockedAt: string;
  primaryMetric: string;
  correct: number;
  total: number;
  accuracy: number;
  falseBlocks: number;
  missedCritical: number;
  targetMet: boolean;
  byCohort: Record<string, { correct: number; total: number; accuracy: number }>;
  byEvidence: Record<string, { correct: number; total: number; accuracy: number }>;
  mismatches: Array<{
    id: string;
    expected: BoundaryDecision;
    predicted: BoundaryDecision;
    sourceRefs: string[];
  }>;
}

export interface BoundaryReceipt {
  schemaVersion: 1;
  caseId: string;
  repository: 'LucasQuiles/WhatSoup';
  invocation: 'semantic-boundary-experiment';
  decision: BoundaryDecision;
  findings: BoundaryFinding[];
  limitations: string[];
}

export interface CandidateSummary extends EvaluationSummary {
  engine: 'candidate';
  feedbackCompleteness: number;
  receipts: BoundaryReceipt[];
  detectorVerification: {
    requested: boolean;
    revisions: number;
    modulesChecked: number;
  };
}

const DEFAULT_CORPUS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../tests/fixtures/semantic-boundary-eval/cases.json',
);
const REPOSITORY = 'LucasQuiles/WhatSoup';
const FIXTURE_OIDS = Object.freeze({
  remote: '1'.repeat(40),
  head: '2'.repeat(40),
  base: '3'.repeat(40),
  staleTracking: '4'.repeat(40),
  candidateBlob: 'a'.repeat(40),
  priorBlob: 'b'.repeat(40),
  extraBlob: 'c'.repeat(40),
  patch: 'd'.repeat(40),
});
const PATH_BLOB_STATUSES = new Set<PathBlobStatus>([
  'added',
  'copied',
  'modified',
  'renamed',
  'deleted',
]);
const GIT_OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export function loadCorpus(path = DEFAULT_CORPUS): Corpus {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Corpus;
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.cases) || parsed.cases.length === 0) {
    throw new Error(`invalid semantic boundary evaluation corpus: ${path}`);
  }
  return parsed;
}

function groupScore(
  cases: EvaluationCase[],
  field: 'cohort' | 'evidence',
  predict: (item: EvaluationCase) => BoundaryDecision,
): Record<string, { correct: number; total: number; accuracy: number }> {
  const scores: Record<string, { correct: number; total: number; accuracy: number }> = {};
  for (const item of cases) {
    const key = item[field];
    const score = (scores[key] ??= { correct: 0, total: 0, accuracy: 0 });
    score.total += 1;
    if (predict(item) === item.expected) score.correct += 1;
  }
  for (const score of Object.values(scores)) score.accuracy = score.correct / score.total;
  return scores;
}

export function evaluateBaseline(corpus: Corpus): EvaluationSummary {
  const mismatches = corpus.cases
    .filter((item) => item.currentDecision !== item.expected)
    .map((item) => ({
      id: item.id,
      expected: item.expected,
      predicted: item.currentDecision,
      sourceRefs: item.sourceRefs,
    }));
  const correct = corpus.cases.length - mismatches.length;
  const falseBlocks = corpus.cases.filter(
    (item) => item.currentDecision === 'block' && item.expected === 'pass',
  ).length;
  const missedCritical = corpus.cases.filter(
    (item) => item.expected === 'block' && item.currentDecision !== 'block',
  ).length;
  const accuracy = correct / corpus.cases.length;
  return {
    engine: 'baseline',
    corpusLockedAt: corpus.lockedAt,
    primaryMetric: corpus.primaryMetric,
    correct,
    total: corpus.cases.length,
    accuracy,
    falseBlocks,
    missedCritical,
    targetMet:
      accuracy >= corpus.target.minimumAccuracy && falseBlocks <= corpus.target.maximumFalseBlocks,
    byCohort: groupScore(corpus.cases, 'cohort', (item) => item.currentDecision),
    byEvidence: groupScore(corpus.cases, 'evidence', (item) => item.currentDecision),
    mismatches,
  };
}

function moduleSources(sources: Record<string, string>): ModuleSource[] {
  return Object.entries(sources).map(([path, text]) => ({ path, text }));
}

export function findUnreachableModules(
  sources: Record<string, string>,
  roots: string[],
  changedModules: string[],
): string[] {
  const graph = buildModuleGraph(moduleSources(sources));
  return analyzeReachability(graph, roots, changedModules).unreachableCandidates;
}

function findGitUnreachableModules(
  revision: string,
  roots: string[],
  changedModules: string[],
  cwd: string,
): string[] {
  const tree = readCandidateTree({ cwd, head: revision, scope: 'tree' });
  if (!tree.headOid || tree.limitations.length > 0) {
    throw new Error(`could not inspect ${revision}: ${tree.limitations.join('; ')}`);
  }
  const graph = buildModuleGraph(tree.sources);
  return analyzeReachability(graph, roots, changedModules).unreachableCandidates;
}

function fixtureOid(value: string): string {
  return GIT_OID_RE.test(value)
    ? value.toLowerCase()
    : taskFingerprintSha256({
        title: 'semantic-boundary-fixture-oid',
        body: value,
      });
}

function fixturePathBlobRecords(records: PathBlobRecord[]): ProductionPathBlobRecord[] {
  return records.map((record) => {
    if (!PATH_BLOB_STATUSES.has(record.status as PathBlobStatus)) {
      throw new Error(`invalid fixture path/blob status: ${record.status}`);
    }
    return {
      status: record.status as PathBlobStatus,
      ...(record.oldPath == null ? {} : { oldPath: record.oldPath }),
      path: record.path,
      blobOid: fixtureOid(record.blobOid),
    };
  });
}

export function contentFingerprint(records: PathBlobRecord[]): string {
  return contentFingerprintSha256(fixturePathBlobRecords(records));
}

type CandidateIdentity = ProposalIdentity & {
  pathBlobSet: ProductionPathBlobRecord[];
};

function fixtureCandidate(input: {
  records: PathBlobRecord[];
  patchIdStable?: string | null;
  task?: { title: string; body: string } | null;
}): CandidateIdentity {
  const pathBlobSet = fixturePathBlobRecords(input.records);
  return {
    ...buildProposalIdentity({
      records: pathBlobSet,
      patchIdStable: input.patchIdStable,
      task: input.task,
    }),
    pathBlobSet,
  };
}

function completeHistory(corpus: Corpus, artifacts: HistoryArtifactRecord[]): HistoryCollection {
  return {
    repository: REPOSITORY,
    observedAt: [corpus.lockedAt],
    artifacts,
    pageCount: 1,
    complete: true,
    limitations: [],
  };
}

function artifactUrl(kind: 'pull-request' | 'issue', number: number): string {
  const route = kind === 'pull-request' ? 'pull' : 'issues';
  return `https://github.com/${REPOSITORY}/${route}/${number}`;
}

function withFixtureSources(item: EvaluationCase, findings: BoundaryFinding[]): BoundaryFinding[] {
  return findings.map((result) => ({
    ...result,
    sourceRefs: [...new Set([...result.sourceRefs, ...item.sourceRefs])].sort(),
  }));
}

function historyArtifact(input: {
  kind?: 'pull-request' | 'issue';
  number: number;
  state?: HistoryArtifactRecord['state'];
  pathBlobSet?: ProductionPathBlobRecord[];
  patchIdStable?: string | null;
  taskFingerprintSha256?: string | null;
  disposition?: HistoryArtifactRecord['disposition'];
}): HistoryArtifactRecord {
  const kind = input.kind ?? 'pull-request';
  return {
    repository: REPOSITORY,
    kind,
    number: input.number,
    state: input.state ?? 'closed-unmerged',
    url: artifactUrl(kind, input.number),
    ...(input.pathBlobSet == null ? {} : { pathBlobSet: input.pathBlobSet }),
    ...(input.patchIdStable === undefined ? {} : { patchIdStable: input.patchIdStable }),
    ...(input.taskFingerprintSha256 === undefined
      ? {}
      : { taskFingerprintSha256: input.taskFingerprintSha256 }),
    ...(input.disposition === undefined ? {} : { disposition: input.disposition }),
  };
}

function evaluateHistoryFixtures(
  item: EvaluationCase,
  corpus: Corpus,
  priorProposals: HistoryArtifactRecord[],
): BoundaryFinding[] {
  const inputs: Array<{
    action: 'open-pr' | 'open-issue' | 'reopen-pr';
    candidate: CandidateIdentity;
    artifacts: HistoryArtifactRecord[];
    reentry?: ReentryPacket;
  }> = [];

  if (item.proposal) {
    inputs.push({
      action: 'open-pr',
      candidate: fixtureCandidate({ records: item.proposal.pathBlobSet }),
      artifacts: priorProposals,
    });
  }

  const history = item.history;
  if (history) {
    const number = history.matchedPr ?? history.matchedIssue ?? 100;
    if (history.exactMatch) {
      const candidate = fixtureCandidate({
        records: [
          {
            status: 'modified',
            path: 'src/exact.ts',
            blobOid: FIXTURE_OIDS.candidateBlob,
          },
        ],
      });
      inputs.push({
        action: 'open-pr',
        candidate,
        artifacts: [
          historyArtifact({
            number,
            state: history.exactMatch,
            pathBlobSet: candidate.pathBlobSet,
          }),
        ],
      });
    } else if (history.subsetMatch) {
      const shared = {
        status: 'modified',
        path: 'src/shared.ts',
        blobOid: FIXTURE_OIDS.candidateBlob,
      } satisfies PathBlobRecord;
      const candidate = fixtureCandidate({
        records: [
          shared,
          {
            status: 'added',
            path: 'src/new.ts',
            blobOid: FIXTURE_OIDS.extraBlob,
          },
        ],
      });
      inputs.push({
        action: 'open-pr',
        candidate,
        artifacts: [
          historyArtifact({
            number,
            pathBlobSet: fixturePathBlobRecords([shared]),
          }),
        ],
      });
    } else if (history.renamedPatchClosed) {
      const candidate = fixtureCandidate({
        records: [
          {
            status: 'added',
            path: 'src/new-name.ts',
            blobOid: FIXTURE_OIDS.candidateBlob,
          },
        ],
        patchIdStable: FIXTURE_OIDS.patch,
      });
      inputs.push({
        action: 'open-pr',
        candidate,
        artifacts: [
          historyArtifact({
            number,
            pathBlobSet: fixturePathBlobRecords([
              {
                status: 'added',
                path: 'src/old-name.ts',
                blobOid: FIXTURE_OIDS.priorBlob,
              },
            ]),
            patchIdStable: FIXTURE_OIDS.patch,
          }),
        ],
      });
    } else if (history.pathOverlap) {
      const candidate = fixtureCandidate({
        records: [
          {
            status: 'modified',
            path: 'src/overlap.ts',
            blobOid: FIXTURE_OIDS.candidateBlob,
          },
        ],
      });
      inputs.push({
        action: 'open-pr',
        candidate,
        artifacts: [
          historyArtifact({
            number,
            pathBlobSet: fixturePathBlobRecords([
              {
                status: 'modified',
                path: 'src/overlap.ts',
                blobOid: FIXTURE_OIDS.priorBlob,
              },
            ]),
          }),
        ],
      });
    } else if (history.sameFilenameOnly) {
      inputs.push({
        action: 'open-pr',
        candidate: fixtureCandidate({
          records: [
            {
              status: 'modified',
              path: 'src/current/feature.ts',
              blobOid: FIXTURE_OIDS.candidateBlob,
            },
          ],
        }),
        artifacts: [
          historyArtifact({
            number,
            pathBlobSet: fixturePathBlobRecords([
              {
                status: 'modified',
                path: 'src/prior/feature.ts',
                blobOid: FIXTURE_OIDS.priorBlob,
              },
            ]),
          }),
        ],
      });
    } else if (history.exactIssue || history.similarIssue) {
      const task = {
        title: 'Deterministic boundary fixture',
        body: 'Prove exact task identity through the production history evaluator.',
      };
      const candidate = fixtureCandidate({ records: [], task });
      inputs.push({
        // The production core intentionally makes exact issue identity warning-only for a
        // code proposal; the holdout uses that path to calibrate contextual issue feedback.
        action: history.exactIssue ? 'open-issue' : 'open-pr',
        candidate,
        artifacts: [
          historyArtifact({
            kind: 'issue',
            number,
            state: 'open',
            taskFingerprintSha256: candidate.taskFingerprintSha256,
          }),
        ],
      });
    }
  }

  if (item.reentry) {
    const number = 700;
    const priorUrl = artifactUrl('pull-request', number);
    const condition = 'Integrate through a named production owner.';
    const candidate = fixtureCandidate({
      records: [
        {
          status: 'modified',
          path: 'src/reentry-new.ts',
          blobOid: FIXTURE_OIDS.candidateBlob,
        },
      ],
    });
    const packet: ReentryPacket = {
      priorArtifactRefs: [priorUrl],
      addressedConditions: item.reentry.packetComplete ? [condition] : [],
      deltaKind: item.reentry.delta === 'material' ? 'material' : 'fixture-hygiene',
      productionOwner: item.reentry.packetComplete ? 'src/main.ts' : null,
      ...(item.reentry.ownerOverride
        ? {
            override: {
              owner: 'repository-owner',
              ruleId: 'history.incomplete-reentry',
              fingerprintSha256: candidate.proposalFingerprintSha256,
              reason: 'Scoped fixture override for the exact proposal identity.',
              expiresAt: '2099-01-01T00:00:00Z',
              sourceRef: priorUrl,
            },
          }
        : {}),
    };
    inputs.push({
      action: 'reopen-pr',
      candidate,
      artifacts: [
        historyArtifact({
          number,
          pathBlobSet: fixturePathBlobRecords([
            {
              status: 'modified',
              path: 'src/reentry-old.ts',
              blobOid: FIXTURE_OIDS.priorBlob,
            },
          ]),
          disposition: {
            category: item.reentry.priorDisposition as DispositionCategory,
            artifactRefs: [priorUrl],
            reentryConditions: [condition],
            recordedAt: corpus.lockedAt,
          },
        }),
      ],
      reentry: packet,
    });
  }

  return inputs.flatMap((input) =>
    withFixtureSources(
      item,
      evaluateHistory({
        action: input.action,
        candidate: input.candidate,
        collection: completeHistory(corpus, input.artifacts),
        reentry: input.reentry,
        now: new Date(corpus.lockedAt),
      }),
    ),
  );
}

function fixtureProvenance(item: EvaluationCase, corpus: Corpus): ProvenanceObservation | null {
  const input = item.provenance;
  if (!input) return null;
  if (!input.remoteAvailable) {
    return {
      repository: REPOSITORY,
      remoteTipOid: null,
      localTrackingOid: null,
      mergeBaseOid: null,
      headOid: null,
      aheadCount: null,
      behindCount: null,
      candidatePaths: null,
      upstreamPaths: null,
      highCouplingPaths: [],
      observedAt: corpus.lockedAt,
      evidenceSource: item.sourceRefs[0] ?? 'fixture:provenance',
      complete: false,
      limitations: ['fixture remote tip is unavailable'],
    };
  }

  const olderBase = input.olderBase;
  const candidatePaths = input.overlap ? ['src/shared.ts'] : ['src/local.ts'];
  const upstreamPaths = input.overlap
    ? ['src/shared.ts']
    : input.highCoupling
      ? ['package-lock.json']
      : olderBase
        ? ['src/upstream.ts']
        : [];
  return {
    repository: REPOSITORY,
    remoteTipOid: FIXTURE_OIDS.remote,
    localTrackingOid: input.trackingMatches ? FIXTURE_OIDS.remote : FIXTURE_OIDS.staleTracking,
    mergeBaseOid: input.mergeBaseAvailable
      ? olderBase
        ? FIXTURE_OIDS.base
        : FIXTURE_OIDS.remote
      : null,
    headOid: olderBase ? FIXTURE_OIDS.head : FIXTURE_OIDS.remote,
    aheadCount: input.mergeBaseAvailable ? (olderBase ? 1 : 0) : null,
    behindCount: input.mergeBaseAvailable ? (olderBase ? 1 : 0) : null,
    candidatePaths,
    upstreamPaths,
    highCouplingPaths: ['package-lock.json'],
    observedAt: corpus.lockedAt,
    evidenceSource: item.sourceRefs[0] ?? 'fixture:provenance',
    complete: true,
    limitations: [],
  };
}

function finding(
  item: EvaluationCase,
  input: Omit<BoundaryFinding, 'sourceRefs' | 'matchedArtifacts'> & {
    matchedArtifacts?: BoundaryFinding['matchedArtifacts'];
  },
): BoundaryFinding {
  return {
    ...input,
    matchedArtifacts: input.matchedArtifacts ?? [],
    sourceRefs: item.sourceRefs,
  };
}

function candidateReceipt(
  item: EvaluationCase,
  corpus: Corpus,
  priorProposals: HistoryArtifactRecord[],
  verifyGit: boolean,
  cwd: string,
  detectorCounts: { revisions: number; modulesChecked: number },
): BoundaryReceipt {
  const findings: BoundaryFinding[] = [];

  if (item.timeout) {
    findings.push(
      finding(item, {
        ruleId: 'boundary.timeout',
        decision: 'inconclusive',
        action: 'push',
        summary: 'The boundary process exceeded its owned deadline.',
        why: 'A timeout supplies no clean verdict and must fail closed at the boundary.',
        observed: [{ label: 'case', value: item.id }],
        correction: ['Inspect the active phase, terminate the owned process group, and rerun.'],
        rerun: 'npm run verify:boundary',
      }),
    );
  }

  const provenance = fixtureProvenance(item, corpus);
  if (provenance) {
    findings.push(
      ...withFixtureSources(item, evaluateProvenance({ action: 'push', observation: provenance })),
    );
  }
  findings.push(...evaluateHistoryFixtures(item, corpus, priorProposals));

  if (item.semantic) {
    let unreachable: string[];
    if (item.semantic.kind === 'fixture') {
      const graph = corpus.graphs[item.semantic.graph];
      if (!graph) throw new Error(`missing graph fixture: ${item.semantic.graph}`);
      unreachable = findUnreachableModules(
        graph,
        corpus.productionRoots,
        item.semantic.changedModules,
      );
    } else {
      if (!verifyGit) {
        throw new Error(
          `case ${item.id} requires --verify-git to inspect ${item.semantic.revision}`,
        );
      }
      unreachable = findGitUnreachableModules(
        item.semantic.revision,
        corpus.productionRoots,
        item.semantic.changedModules,
        cwd,
      );
      detectorCounts.revisions += 1;
      detectorCounts.modulesChecked += item.semantic.changedModules.length;
    }
    if (unreachable.length > 0) {
      findings.push(
        finding(item, {
          ruleId: 'semantic.production-reachability',
          decision: 'block',
          action: 'push',
          summary: 'Added production modules are unreachable from every production root.',
          why: 'Tests, comments, strings, and disconnected islands do not prove runtime integration.',
          observed: [{ label: 'unreachable_modules', value: unreachable.join(', ') }],
          correction: [
            'Integrate through the named production owner and add a behavior test through that owner.',
          ],
          rerun: 'npm run verify:semantic',
        }),
      );
    }
  }

  for (const actionRef of item.supply?.actionRefs ?? []) {
    if (!/@[0-9a-f]{40}$/i.test(actionRef)) {
      findings.push(
        finding(item, {
          ruleId: 'supply-chain.mutable-action',
          decision: 'block',
          action: 'commit',
          summary: `${actionRef} uses a mutable action reference.`,
          why: 'Release tags can move and do not identify reviewed upstream content immutably.',
          observed: [{ label: 'uses', value: actionRef }],
          correction: ['Pin the reviewed release to its full commit SHA and update provenance.'],
          rerun: 'npm run guard:upstream-pins',
        }),
      );
    }
  }
  for (const dockerBase of item.supply?.dockerBases ?? []) {
    if (!/@sha256:[0-9a-f]{64}$/i.test(dockerBase)) {
      findings.push(
        finding(item, {
          ruleId: 'supply-chain.mutable-image',
          decision: 'block',
          action: 'commit',
          summary: `${dockerBase} lacks an immutable image digest.`,
          why: 'A patch tag alone can resolve to different upstream bytes over time.',
          observed: [{ label: 'base_image', value: dockerBase }],
          correction: ['Add the verified sha256 digest and update the provenance manifest.'],
          rerun: 'npm run guard:upstream-pins',
        }),
      );
    }
  }
  if (item.supply?.runnerLabels?.some((label) => label.endsWith('-latest'))) {
    findings.push(
      finding(item, {
        ruleId: 'supply-chain.floating-runner',
        decision: 'warn',
        action: 'commit',
        summary: 'The workflow uses a floating runner label.',
        why: 'Runner image drift should remain visible until the support policy is explicit.',
        observed: [{ label: 'runner', value: item.supply.runnerLabels.join(', ') }],
        correction: [
          'Record the intended runner support window or pin an explicit image generation.',
        ],
        rerun: 'npm run guard:upstream-pins',
      }),
    );
  }
  if (item.process && (!item.process.bounded || !item.process.ownsProcessGroup)) {
    findings.push(
      finding(item, {
        ruleId: 'process.unbounded-primitive',
        decision: 'warn',
        action: 'commit',
        summary: 'The process primitive lacks a bounded, owned watchdog.',
        why: 'An unowned child can hang a hook or leave descendants after timeout.',
        observed: [
          { label: 'bounded', value: String(item.process.bounded) },
          {
            label: 'owns_process_group',
            value: String(item.process.ownsProcessGroup),
          },
        ],
        correction: [
          'Wrap the command in an external deadline that owns and reaps its process group.',
        ],
        rerun: 'npm run verify:boundary',
      }),
    );
  }
  if (item.guardChange && !item.guardChange.negativeControlChanged) {
    findings.push(
      finding(item, {
        ruleId: 'semantic.guard-negative-control',
        decision: 'warn',
        action: 'commit',
        summary: 'Guard behavior changed without a neighboring negative-control fixture.',
        why: 'A wired test name does not prove the guard rejects its target failure mode.',
        observed: [{ label: 'negative_control_changed', value: 'false' }],
        correction: [
          'Add a fixture that triggers the unsafe input and assert the guard rejects it.',
        ],
        rerun: 'npm test -- tests/scripts/<guard>.test.ts',
      }),
    );
  }

  const decision = aggregateBoundaryDecision(findings);
  return {
    schemaVersion: 1,
    caseId: item.id,
    repository: 'LucasQuiles/WhatSoup',
    invocation: 'semantic-boundary-experiment',
    decision,
    findings,
    limitations: verifyGit ? [] : ['Git-backed visible cases require --verify-git.'],
  };
}

export function evaluateCandidate(
  corpus: Corpus,
  options: { verifyGit?: boolean; cwd?: string } = {},
): CandidateSummary {
  const verifyGit = options.verifyGit ?? false;
  const cwd = options.cwd ?? process.cwd();
  const priorProposals: HistoryArtifactRecord[] = [];
  const detectorCounts = { revisions: 0, modulesChecked: 0 };
  const receipts: BoundaryReceipt[] = [];
  for (const item of corpus.cases) {
    const receipt = candidateReceipt(item, corpus, priorProposals, verifyGit, cwd, detectorCounts);
    receipts.push(receipt);
    if (item.proposal) {
      priorProposals.push(
        historyArtifact({
          number: item.proposal.number,
          state: item.proposal.state,
          pathBlobSet: fixturePathBlobRecords(item.proposal.pathBlobSet),
        }),
      );
    }
  }
  const predicted = new Map(receipts.map((receipt) => [receipt.caseId, receipt.decision]));
  const mismatches = corpus.cases
    .filter((item) => predicted.get(item.id) !== item.expected)
    .map((item) => ({
      id: item.id,
      expected: item.expected,
      predicted: predicted.get(item.id)!,
      sourceRefs: item.sourceRefs,
    }));
  const correct = corpus.cases.length - mismatches.length;
  const falseBlocks = corpus.cases.filter(
    (item) => predicted.get(item.id) === 'block' && item.expected === 'pass',
  ).length;
  const missedCritical = corpus.cases.filter(
    (item) => item.expected === 'block' && predicted.get(item.id) !== 'block',
  ).length;
  const interventionFindings = receipts.flatMap((receipt) => receipt.findings);
  const completeFindings = interventionFindings.filter(isBoundaryFindingComplete).length;
  const accuracy = correct / corpus.cases.length;
  const predict = (item: EvaluationCase): BoundaryDecision => predicted.get(item.id)!;
  return {
    engine: 'candidate',
    corpusLockedAt: corpus.lockedAt,
    primaryMetric: corpus.primaryMetric,
    correct,
    total: corpus.cases.length,
    accuracy,
    falseBlocks,
    missedCritical,
    targetMet:
      accuracy >= corpus.target.minimumAccuracy && falseBlocks <= corpus.target.maximumFalseBlocks,
    byCohort: groupScore(corpus.cases, 'cohort', predict),
    byEvidence: groupScore(corpus.cases, 'evidence', predict),
    mismatches,
    feedbackCompleteness:
      interventionFindings.length === 0 ? 1 : completeFindings / interventionFindings.length,
    receipts,
    detectorVerification: {
      requested: verifyGit,
      ...detectorCounts,
    },
  };
}

function parseArgs(argv: string[]): {
  engine: 'baseline' | 'candidate';
  format: 'human' | 'json';
  corpusPath?: string;
  verifyGit: boolean;
} {
  let engine: 'baseline' | 'candidate' = 'baseline';
  let format: 'human' | 'json' = 'human';
  let corpusPath: string | undefined;
  let verifyGit = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--format' && argv[index + 1] === 'json') {
      format = 'json';
      index += 1;
    } else if (arg === '--corpus' && argv[index + 1]) {
      corpusPath = resolve(argv[index + 1]);
      index += 1;
    } else if (arg === '--engine' && ['baseline', 'candidate'].includes(argv[index + 1] ?? '')) {
      engine = argv[index + 1] as 'baseline' | 'candidate';
      index += 1;
    } else if (arg === '--verify-git') {
      verifyGit = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { engine, format, corpusPath, verifyGit };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const corpus = loadCorpus(args.corpusPath);
  const summary =
    args.engine === 'candidate'
      ? evaluateCandidate(corpus, { verifyGit: args.verifyGit })
      : evaluateBaseline(corpus);
  if (args.format === 'json') {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    `${summary.engine}: ${summary.correct}/${summary.total} correct (${(summary.accuracy * 100).toFixed(1)}%), ` +
      `${summary.falseBlocks} false blocks, ${summary.missedCritical} missed critical cases\n`,
  );
  for (const mismatch of summary.mismatches) {
    process.stdout.write(
      `MISS ${mismatch.id}: expected=${mismatch.expected} predicted=${mismatch.predicted} ` +
        `source=${mismatch.sourceRefs.join(',')}\n`,
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
