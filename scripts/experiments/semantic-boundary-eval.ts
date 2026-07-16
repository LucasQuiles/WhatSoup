import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import { cleanGitEnv } from '../../src/lib/git-env.ts';

export type BoundaryDecision = 'pass' | 'warn' | 'block' | 'inconclusive';

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

export interface BoundaryFinding {
  ruleId: string;
  decision: Exclude<BoundaryDecision, 'pass'>;
  action: 'commit' | 'push' | 'open-pr' | 'reopen-pr' | 'open-issue';
  summary: string;
  why: string;
  observed: Array<{ label: string; value: string }>;
  matchedArtifacts: Array<{
    kind: 'pr' | 'issue';
    number: number;
    url: string;
    state: string;
  }>;
  correction: string[];
  rerun: string;
  sourceRefs: string[];
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

function runtimeSpecifiers(sourceText: string, filePath: string): string[] {
  const source = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const specifiers = new Set<string>();

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const namedBindings = clause?.namedBindings;
      const onlyTypeSpecifiers =
        namedBindings &&
        ts.isNamedImports(namedBindings) &&
        namedBindings.elements.length > 0 &&
        namedBindings.elements.every((element) => element.isTypeOnly);
      if (!clause?.isTypeOnly && !(onlyTypeSpecifiers && !clause?.name)) {
        specifiers.add(node.moduleSpecifier.text);
      }
    } else if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.add(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.add(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return [...specifiers];
}

function resolveSpecifier(fromPath: string, specifier: string, files: Set<string>): string | null {
  if (!specifier.startsWith('.')) return null;
  const joined = posix.normalize(posix.join(posix.dirname(fromPath), specifier));
  const candidates = [joined];
  if (/\.m?js$/i.test(joined)) {
    candidates.push(joined.replace(/\.m?js$/i, '.ts'), joined.replace(/\.m?js$/i, '.tsx'));
  } else if (!/\.[a-z0-9]+$/i.test(joined)) {
    candidates.push(`${joined}.ts`, `${joined}.tsx`, `${joined}/index.ts`, `${joined}/index.tsx`);
  }
  return candidates.find((candidate) => files.has(candidate)) ?? null;
}

function reachableModules(
  files: Set<string>,
  roots: string[],
  loadSource: (path: string) => string,
): Set<string> {
  const reachable = new Set<string>();
  const pending = roots.filter((root) => files.has(root));
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (reachable.has(current)) continue;
    reachable.add(current);
    for (const specifier of runtimeSpecifiers(loadSource(current), current)) {
      const resolved = resolveSpecifier(current, specifier, files);
      if (resolved && !reachable.has(resolved)) pending.push(resolved);
    }
  }
  return reachable;
}

export function findUnreachableModules(
  sources: Record<string, string>,
  roots: string[],
  changedModules: string[],
): string[] {
  const files = new Set(Object.keys(sources).filter((path) => /\.tsx?$/.test(path)));
  const reachable = reachableModules(files, roots, (path) => sources[path] ?? '');
  return changedModules.filter((path) => !reachable.has(path)).sort();
}

function findGitUnreachableModules(
  revision: string,
  roots: string[],
  changedModules: string[],
  cwd: string,
): string[] {
  const listed = execFileSync('git', ['ls-tree', '-r', '--name-only', revision, '--', 'src'], {
    cwd,
    encoding: 'utf8',
    env: cleanGitEnv(),
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const files = new Set(
    listed
      .split(/\r?\n/)
      .filter((path) => /\.tsx?$/.test(path)),
  );
  const sourceCache = new Map<string, string>();
  const reachable = reachableModules(files, roots, (path) => {
    const cached = sourceCache.get(path);
    if (cached !== undefined) return cached;
    const source = execFileSync('git', ['show', `${revision}:${path}`], {
      cwd,
      encoding: 'utf8',
      env: cleanGitEnv(),
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    sourceCache.set(path, source);
    return source;
  });
  return changedModules.filter((path) => !reachable.has(path)).sort();
}

export function contentFingerprint(records: PathBlobRecord[]): string {
  const canonical = records
    .map((record) => ({
      status: record.status,
      oldPath: record.oldPath ?? null,
      path: record.path,
      blobOid: record.blobOid,
    }))
    .sort((left, right) =>
      `${left.status}\0${left.oldPath}\0${left.path}\0${left.blobOid}`.localeCompare(
        `${right.status}\0${right.oldPath}\0${right.path}\0${right.blobOid}`,
      ),
    );
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
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
  priorProposals: Map<string, { number: number; state: string }>,
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

  const provenance = item.provenance;
  if (provenance && (!provenance.remoteAvailable || !provenance.mergeBaseAvailable)) {
    findings.push(
      finding(item, {
        ruleId: 'provenance.unavailable',
        decision: 'inconclusive',
        action: 'push',
        summary: 'Upstream provenance could not be proven.',
        why: 'Duplicate and overlap verdicts are unsafe without the remote tip and merge base.',
        observed: [
          { label: 'remote_available', value: String(provenance.remoteAvailable) },
          { label: 'merge_base_available', value: String(provenance.mergeBaseAvailable) },
        ],
        correction: ['Restore read access to origin, fetch the tip, and recompute the merge base.'],
        rerun: 'npm run verify:boundary',
      }),
    );
  } else if (provenance && !provenance.trackingMatches) {
    findings.push(
      finding(item, {
        ruleId: 'provenance.stale-tracking-ref',
        decision: 'block',
        action: 'push',
        summary: 'The local tracking ref differs from the remotely observed tip.',
        why: 'A stale local tip invalidates subsequent changed-path and duplicate comparisons.',
        observed: [{ label: 'tracking_matches_remote', value: 'false' }],
        correction: ['Fetch origin/main, verify the observed OIDs, and recompute the branch diff.'],
        rerun: 'npm run verify:boundary',
      }),
    );
  } else if (provenance?.olderBase && (provenance.overlap || provenance.highCoupling)) {
    findings.push(
      finding(item, {
        ruleId: 'provenance.stale-overlap',
        decision: 'block',
        action: 'push',
        summary: 'The candidate has an older base that overlaps upstream changes.',
        why: 'Overlapping or high-coupling upstream changes require deliberate reconciliation.',
        observed: [
          { label: 'path_overlap', value: String(provenance.overlap) },
          { label: 'high_coupling', value: String(provenance.highCoupling) },
        ],
        correction: ['Rebase or merge deliberately, then rerun the affected tests and boundary check.'],
        rerun: 'npm run verify:boundary',
      }),
    );
  } else if (provenance?.olderBase) {
    findings.push(
      finding(item, {
        ruleId: 'provenance.stale-disjoint',
        decision: 'warn',
        action: 'push',
        summary: 'The candidate base is older, but the proven upstream delta is disjoint.',
        why: 'Disjoint changes lower immediate risk but should remain visible to the agent.',
        observed: [{ label: 'path_overlap', value: 'false' }],
        correction: ['Fetch origin/main and consider rebasing before the next material edit.'],
        rerun: 'npm run verify:boundary',
      }),
    );
  }

  if (item.proposal) {
    const fingerprint = contentFingerprint(item.proposal.pathBlobSet);
    const prior = priorProposals.get(fingerprint);
    if (prior) {
      findings.push(
        finding(item, {
          ruleId: prior.state === 'open' ? 'history.exact-open-pr' : 'history.exact-closed-pr',
          decision: 'block',
          action: 'open-pr',
          summary: `The candidate content exactly matches PR #${prior.number}.`,
          why: 'The canonical changed path/blob fingerprint is identical after removing proposal identity.',
          observed: [{ label: 'content_fingerprint_sha256', value: fingerprint }],
          matchedArtifacts: [
            {
              kind: 'pr',
              number: prior.number,
              url: `https://github.com/LucasQuiles/WhatSoup/pull/${prior.number}`,
              state: prior.state,
            },
          ],
          correction: ['Continue through the existing artifact or provide a material re-entry packet.'],
          rerun: 'npm run verify:boundary',
        }),
      );
    }
  }

  const history = item.history;
  if (history?.exactMatch) {
    const number = history.matchedPr!;
    findings.push(
      finding(item, {
        ruleId: history.exactMatch === 'open' ? 'history.exact-open-pr' : 'history.exact-closed-pr',
        decision: 'block',
        action: 'open-pr',
        summary: `The candidate exactly matches PR #${number}.`,
        why: 'Exact content evidence is deterministic and survives branch recreation.',
        observed: [{ label: 'match', value: history.exactMatch }],
        matchedArtifacts: [
          {
            kind: 'pr',
            number,
            url: `https://github.com/LucasQuiles/WhatSoup/pull/${number}`,
            state: history.exactMatch,
          },
        ],
        correction: ['Continue through the existing PR or prove a material re-entry delta.'],
        rerun: 'npm run verify:boundary',
      }),
    );
  }
  if (history?.renamedPatchClosed) {
    findings.push(
      finding(item, {
        ruleId: 'history.renamed-patch-closed-pr',
        decision: 'block',
        action: 'open-pr',
        summary: `The stable patch matches closed PR #${history.matchedPr}.`,
        why: 'A stable patch match detects identical work even when its path is renamed.',
        observed: [{ label: 'stable_patch_match', value: 'true' }],
        matchedArtifacts: [
          {
            kind: 'pr',
            number: history.matchedPr!,
            url: `https://github.com/LucasQuiles/WhatSoup/pull/${history.matchedPr}`,
            state: 'closed-unmerged',
          },
        ],
        correction: ['Address the recorded disposition before recreating the patch.'],
        rerun: 'npm run verify:boundary',
      }),
    );
  }
  if (history?.subsetMatch || history?.pathOverlap) {
    const ruleId = history.subsetMatch ? 'history.blob-subset' : 'history.path-overlap';
    findings.push(
      finding(item, {
        ruleId,
        decision: 'warn',
        action: 'open-pr',
        summary: `The candidate overlaps prior PR #${history.matchedPr}.`,
        why: 'Partial overlap may be legitimate, so it supplies context without blocking.',
        observed: [{ label: 'overlap_kind', value: history.subsetMatch ? 'blob-subset' : 'path' }],
        matchedArtifacts: [
          {
            kind: 'pr',
            number: history.matchedPr!,
            url: `https://github.com/LucasQuiles/WhatSoup/pull/${history.matchedPr}`,
            state: 'historical',
          },
        ],
        correction: ['Link the prior artifact and explain the material distinction.'],
        rerun: 'npm run verify:boundary',
      }),
    );
  }
  if (history?.exactIssue || history?.similarIssue) {
    const number = history.matchedIssue!;
    const exact = Boolean(history.exactIssue);
    findings.push(
      finding(item, {
        ruleId: exact ? 'history.exact-issue' : 'history.related-issue',
        decision: exact ? 'block' : 'warn',
        action: 'open-issue',
        summary: `${exact ? 'Exact' : 'Related'} issue #${number} already exists.`,
        why: exact
          ? 'The normalized title/body fingerprint is identical.'
          : 'Similarity is contextual evidence and cannot safely block by itself.',
        observed: [{ label: 'issue_match', value: exact ? 'exact' : 'similar' }],
        matchedArtifacts: [
          {
            kind: 'issue',
            number,
            url: `https://github.com/LucasQuiles/WhatSoup/issues/${number}`,
            state: 'existing',
          },
        ],
        correction: ['Continue on the existing issue or state the non-overlapping acceptance criteria.'],
        rerun: 'npm run verify:boundary',
      }),
    );
  }

  const reentry = item.reentry;
  if (reentry && !reentry.ownerOverride && (reentry.delta !== 'material' || !reentry.packetComplete)) {
    findings.push(
      finding(item, {
        ruleId: 'history.incomplete-reentry',
        decision: 'block',
        action: 'reopen-pr',
        summary: 'The resubmission does not satisfy the prior disposition.',
        why: 'Cosmetic changes and incomplete packets cannot cure an architectural rejection.',
        observed: [
          { label: 'prior_disposition', value: reentry.priorDisposition },
          { label: 'delta', value: reentry.delta },
          { label: 'packet_complete', value: String(reentry.packetComplete) },
        ],
        correction: ['Name the production owner, prove the material delta, and complete the re-entry packet.'],
        rerun: 'npm run verify:boundary',
      }),
    );
  }

  if (item.semantic) {
    let unreachable: string[];
    if (item.semantic.kind === 'fixture') {
      const graph = corpus.graphs[item.semantic.graph];
      if (!graph) throw new Error(`missing graph fixture: ${item.semantic.graph}`);
      unreachable = findUnreachableModules(graph, corpus.productionRoots, item.semantic.changedModules);
    } else {
      if (!verifyGit) {
        throw new Error(`case ${item.id} requires --verify-git to inspect ${item.semantic.revision}`);
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
          correction: ['Integrate through the named production owner and add a behavior test through that owner.'],
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
        correction: ['Record the intended runner support window or pin an explicit image generation.'],
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
          { label: 'owns_process_group', value: String(item.process.ownsProcessGroup) },
        ],
        correction: ['Wrap the command in an external deadline that owns and reaps its process group.'],
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
        correction: ['Add a fixture that triggers the unsafe input and assert the guard rejects it.'],
        rerun: 'npm test -- tests/scripts/<guard>.test.ts',
      }),
    );
  }

  const decision = findings.some((item) => item.decision === 'block')
    ? 'block'
    : findings.some((item) => item.decision === 'inconclusive')
      ? 'inconclusive'
      : findings.some((item) => item.decision === 'warn')
        ? 'warn'
        : 'pass';
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

function isFindingComplete(item: BoundaryFinding): boolean {
  return Boolean(
    item.ruleId &&
      item.action &&
      item.summary &&
      item.why &&
      item.observed.length > 0 &&
      item.correction.length > 0 &&
      item.rerun &&
      item.sourceRefs.length > 0,
  );
}

export function evaluateCandidate(
  corpus: Corpus,
  options: { verifyGit?: boolean; cwd?: string } = {},
): CandidateSummary {
  const verifyGit = options.verifyGit ?? false;
  const cwd = options.cwd ?? process.cwd();
  const priorProposals = new Map<string, { number: number; state: string }>();
  const detectorCounts = { revisions: 0, modulesChecked: 0 };
  const receipts: BoundaryReceipt[] = [];
  for (const item of corpus.cases) {
    const receipt = candidateReceipt(
      item,
      corpus,
      priorProposals,
      verifyGit,
      cwd,
      detectorCounts,
    );
    receipts.push(receipt);
    if (item.proposal) {
      priorProposals.set(contentFingerprint(item.proposal.pathBlobSet), {
        number: item.proposal.number,
        state: item.proposal.state,
      });
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
  const completeFindings = interventionFindings.filter(isFindingComplete).length;
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
