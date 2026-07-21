import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanGitEnv } from '../../../src/lib/git-env.ts';
import {
  ExactGitInputError,
  readExactChangeFacts,
  type ChangeFactV1,
} from './git-input.ts';
import {
  ControlManifestError,
  digestControlManifest,
  parseControlManifestBytes,
  type ControlManifestV1,
  type RiskTier,
} from './manifest.ts';
import { canonicalizeBoundaryRun } from '../verification/boundary-run/shared.ts';

export interface ExactRevisionInput {
  eventName: 'pull_request' | 'merge_group' | 'push' | 'tag' | 'local';
  baseOid: string | null;
  candidateOid: string;
  mergeOid: string | null;
  manifestDigest: string;
}

export interface RiskClassificationV1 {
  schemaVersion: 1;
  outcome: 'pass' | 'inconclusive';
  exitCode: 0 | 2;
  riskTier: RiskTier;
  reasons: string[];
  changed: ChangeFactV1[];
  requiredControls: string[];
  requiredSuites: string[];
  baseOid: string | null;
  candidateOid: string;
  mergeOid: string | null;
  mergeBaseOid: string | null;
  manifestDigest: string;
  classifierDigest: string;
  graphDigest: string | null;
  changeSetDigest: string | null;
}

export interface LineageLeaseInput extends ExactRevisionInput {
  candidateRef: string | null;
  remoteRef: string;
  policyDigest: string;
  toolchainDigest: string;
  selectedPlanDigest: string;
  prerequisiteReceiptDigests: string[];
  createdAt: string;
}

interface TreeGroupDigestsV1 {
  documentation: string;
  enforcement: string;
}

export interface LineageLeaseV1 extends LineageLeaseInput {
  schemaVersion: 1;
  candidateRefOid: string | null;
  remoteOid: string | null;
  baseTreeOid: string | null;
  candidateTreeOid: string | null;
  mergeTreeOid: string | null;
  classifierDigest: string;
  treeGroupDigests: TreeGroupDigestsV1 | null;
}

export interface InvalidationDecisionV1 {
  invalidated: boolean;
  scope: 'none' | 'metadata-and-merge' | 'all';
  reasons: string[];
  revalidate: string[];
}

const OID = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const EXACT_INPUT_KEYS = ['baseOid', 'candidateOid', 'eventName', 'manifestDigest', 'mergeOid'];
const TIER_ORDER: Record<RiskTier, number> = { low: 0, standard: 1, elevated: 2, 'system-wide': 3 };
const ALL_REVALIDATION = ['aggregate', 'classification', 'execution-plan', 'merge-result', 'metadata'];
const METADATA_REVALIDATION = ['aggregate', 'classification', 'merge-result', 'metadata'];
const MAX_GIT_BYTES = 32 * 1024 * 1024;
const MAX_TREE_ENTRIES = 100_000;
const MAX_TREE_PATH_BYTES = 1_024;
const FULL_SUITE_FALLBACK = '@full-suite:coverage:check';
const GIT_TIMEOUT_MS = 30_000;
const MAX_CLASSIFIER_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_CLASSIFIER_SOURCE_FILE_BYTES = 2 * 1024 * 1024;

export const CLASSIFIER_TOOL_SOURCE_PATHS = [
  'scripts/ci-control-classify.ts',
  'scripts/lib/ci-control/classifier.ts',
  'scripts/lib/ci-control/git-input.ts',
  'scripts/lib/ci-control/manifest.ts',
  'scripts/lib/ci-control/reasons.ts',
  'scripts/lib/ci-control/ref-policy.ts',
  'scripts/lib/verification/boundary-run/contracts.ts',
  'scripts/lib/verification/boundary-run/model.ts',
  'scripts/lib/verification/boundary-run/schema.ts',
  'scripts/lib/verification/boundary-run/shared.ts',
  'scripts/lib/verification/boundary-run/worktree.ts',
  'src/lib/git-env.ts',
  'src/lib/type-guards.ts',
] as const;

export class LineageLeaseError extends Error {
  readonly code: string;
  readonly outcome = 'inconclusive' as const;
  readonly exitCode = 2 as const;
  readonly scope = 'all' as const;
  readonly revalidate = ALL_REVALIDATION;
  readonly guidance = ['Reacquire the lease from the exact current ref and object identities.'];
  readonly reproduce = 'npm run ci:classify -- --help';
  readonly retryable = false;

  constructor(code: string) {
    super(code);
    this.name = 'LineageLeaseError';
    this.code = code;
  }
}

function digestBytes(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

interface ClassifierToolSourceObservation {
  digest: string;
  latestChangeTimeMs: number;
}

function exactGitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...cleanGitEnv(),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  };
}

function gitBytes(cwd: string, args: string[]): Buffer {
  return execFileSync('git', args, {
    cwd,
    env: exactGitEnvironment(),
    maxBuffer: MAX_GIT_BYTES,
    timeout: GIT_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function gitText(cwd: string, args: string[]): string {
  return gitBytes(cwd, args).toString('utf8').trim();
}

function validOid(value: unknown): value is string {
  return typeof value === 'string' && OID.test(value);
}

function validDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

function requireCommit(cwd: string, oid: string): void {
  if (!validOid(oid)) throw new Error('ci.input.revision-unavailable');
  let type: string;
  try {
    type = gitText(cwd, ['cat-file', '-t', oid]);
  } catch (error) {
    throw new Error('ci.input.revision-unavailable', { cause: error });
  }
  if (type !== 'commit') throw new Error('ci.input.revision-not-commit');
}

function commitExists(cwd: string, oid: string): boolean {
  try {
    requireCommit(cwd, oid);
    return true;
  } catch {
    return false;
  }
}

function isShallowRepository(cwd: string): boolean {
  try {
    return gitText(cwd, ['rev-parse', '--is-shallow-repository']) === 'true';
  } catch {
    return false;
  }
}

function mergeBase(cwd: string, baseOid: string, candidateOid: string): string {
  let output: string;
  try {
    output = gitText(cwd, ['merge-base', '--all', baseOid, candidateOid]);
  } catch (error) {
    throw new Error('ci.classification.merge-base-unavailable', { cause: error });
  }
  const values = output.split(/\r?\n/).filter(Boolean);
  if (values.length !== 1 || !validOid(values[0])) throw new Error('ci.classification.merge-base-unavailable');
  return values[0]!;
}

function commitTreeOid(cwd: string, oid: string | null): string | null {
  if (oid === null) return null;
  requireCommit(cwd, oid);
  const tree = gitText(cwd, ['show', '-s', '--format=%T', oid]);
  if (!validOid(tree)) throw new Error('ci.input.revision-unavailable');
  return tree;
}

function candidateManifest(cwd: string, candidateOid: string): ControlManifestV1 {
  const bytes = gitBytes(cwd, ['show', `${candidateOid}:controls/ci-control-manifest.json`]);
  return parseControlManifestBytes(bytes);
}

function fallbackManifest(cwd: string, baseOid: string | null): ControlManifestV1 | null {
  if (baseOid === null || !validOid(baseOid)) return null;
  try {
    requireCommit(cwd, baseOid);
    return candidateManifest(cwd, baseOid);
  } catch {
    return null;
  }
}

function inspectClassifierToolSources(repositoryRoot: string): ClassifierToolSourceObservation {
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(resolve(repositoryRoot));
  } catch {
    throw new Error('ci.classification.tool-source-unavailable');
  }
  const sources: Array<{ path: string; digest: string }> = [];
  let totalBytes = 0;
  let latestChangeTimeMs = 0;
  for (const sourcePath of CLASSIFIER_TOOL_SOURCE_PATHS) {
    const expectedPath = resolve(canonicalRoot, sourcePath);
    if (!expectedPath.startsWith(`${canonicalRoot}/`)) throw new Error('ci.classification.tool-source-escape');
    let bytes: Buffer;
    try {
      const stat = lstatSync(expectedPath);
      if (stat.isSymbolicLink()) throw new Error('ci.classification.tool-source-symlink');
      if (!stat.isFile()) throw new Error('ci.classification.tool-source-invalid-type');
      if (realpathSync(expectedPath) !== expectedPath) throw new Error('ci.classification.tool-source-escape');
      if (stat.size > MAX_CLASSIFIER_SOURCE_FILE_BYTES) throw new Error('ci.classification.tool-source-byte-budget');
      totalBytes += stat.size;
      if (totalBytes > MAX_CLASSIFIER_SOURCE_BYTES) throw new Error('ci.classification.tool-source-byte-budget');
      bytes = readFileSync(expectedPath);
      latestChangeTimeMs = Math.max(latestChangeTimeMs, stat.mtimeMs, stat.ctimeMs);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('ci.classification.tool-source-')) throw error;
      throw new Error('ci.classification.tool-source-unavailable', { cause: error });
    }
    sources.push({ path: sourcePath, digest: digestBytes(bytes) });
  }
  return {
    digest: digestBytes(canonicalizeBoundaryRun(sources)),
    latestChangeTimeMs,
  };
}

export function digestClassifierToolSources(repositoryRoot: string): string {
  return inspectClassifierToolSources(repositoryRoot).digest;
}

export function assertClassifierToolSourcesStable(
  repositoryRoot: string,
  processStartTimeMs: number,
  loadedDigest: string,
): string {
  const observed = inspectClassifierToolSources(repositoryRoot);
  if (observed.latestChangeTimeMs > processStartTimeMs) {
    throw new Error('ci.classification.tool-source-changed-during-process');
  }
  if (observed.digest !== loadedDigest) throw new Error('ci.classification.tool-source-changed');
  return loadedDigest;
}

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const LOADED_CLASSIFIER_DIGEST = digestClassifierToolSources(REPOSITORY_ROOT);

function classifierDigest(): string {
  return assertClassifierToolSourcesStable(
    REPOSITORY_ROOT,
    performance.timeOrigin,
    LOADED_CLASSIFIER_DIGEST,
  );
}

function fullTreeBytes(cwd: string, candidateOid: string): Buffer {
  return gitBytes(cwd, ['ls-tree', '-rz', '--full-tree', candidateOid]);
}

function testSuitesFromTree(bytes: Buffer): string[] {
  if (bytes.length > 0 && bytes[bytes.length - 1] !== 0) throw new Error('ci.classification.graph-unavailable');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const suites: string[] = [];
  const entries = bytes.subarray(0, bytes.length === 0 ? 0 : bytes.length - 1).toString('binary').split('\0');
  if (entries.length > MAX_TREE_ENTRIES) throw new Error('ci.classification.graph-unavailable');
  for (const entry of entries) {
    if (entry.length === 0) continue;
    const raw = Buffer.from(entry, 'binary');
    const tab = raw.indexOf(0x09);
    if (tab < 0) throw new Error('ci.classification.graph-unavailable');
    const metadata = raw.subarray(0, tab).toString('ascii');
    const pathBytes = raw.subarray(tab + 1);
    if (pathBytes.length === 0 || pathBytes.length > MAX_TREE_PATH_BYTES) throw new Error('ci.classification.graph-unavailable');
    const path = decoder.decode(pathBytes);
    if (!/^\d{6} (?:blob|tree|commit) [0-9a-f]{40}$/.test(metadata)) throw new Error('ci.classification.graph-unavailable');
    if (path.startsWith('tests/') && path.endsWith('.test.ts')) suites.push(path);
  }
  return [...new Set(suites)].sort();
}

function pathMatchesPrefix(candidatePath: string, prefix: string): boolean {
  const normalized = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  return normalized.length > 0 && (candidatePath === normalized || candidatePath.startsWith(`${normalized}/`));
}

function higherTier(left: RiskTier, right: RiskTier): RiskTier {
  return TIER_ORDER[left] >= TIER_ORDER[right] ? left : right;
}

function selectRisk(manifest: ControlManifestV1, facts: ChangeFactV1[]): {
  riskTier: RiskTier;
  reasons: string[];
  inconclusive: boolean;
} {
  let riskTier: RiskTier = 'low';
  let inconclusive = false;
  const reasons = new Set<string>();

  if (facts.length === 0) reasons.add('ci.classification.no-change');
  for (const fact of facts) {
    const paths = fact.oldPath === null ? [fact.path] : [fact.oldPath, fact.path];
    let matchedTier: RiskTier | null = null;
    const matchedReasons = new Map<RiskTier, Set<string>>();
    for (const candidatePath of paths) {
      for (const rule of manifest.riskRules) {
        if (!rule.pathPrefixes.some((prefix) => pathMatchesPrefix(candidatePath, prefix))) continue;
        matchedTier = matchedTier === null ? rule.tier : higherTier(matchedTier, rule.tier);
        const tierReasons = matchedReasons.get(rule.tier) ?? new Set<string>();
        rule.reasons.forEach((reason) => tierReasons.add(reason));
        matchedReasons.set(rule.tier, tierReasons);
      }
    }
    if (matchedTier === null) {
      riskTier = 'system-wide';
      inconclusive = true;
      reasons.add('ci.classification.unknown-path');
      matchedTier = 'system-wide';
    }
    let factTier = matchedTier;
    let factReasons = new Set(matchedReasons.get(matchedTier));
    const executableTransition = fact.oldMode !== '000000'
      && fact.oldMode !== fact.newMode
      && (fact.oldMode === '100755' || fact.newMode === '100755');
    if (executableTransition) {
      factTier = 'system-wide';
      factReasons = new Set();
      reasons.add('ci.classification.executable-mode');
    } else if (fact.oldMode === '100755' || fact.newMode === '100755') {
      factTier = higherTier(factTier, 'elevated');
      reasons.add('ci.classification.executable-mode');
    }
    if (fact.oldType === 'symlink' || fact.newType === 'symlink') {
      factTier = 'system-wide';
      inconclusive = true;
      reasons.add('ci.classification.symlink');
    }
    if (fact.oldType === 'gitlink' || fact.newType === 'gitlink') {
      factTier = higherTier(factTier, 'elevated');
      reasons.add('ci.classification.gitlink');
    }
    riskTier = higherTier(riskTier, factTier);
    factReasons.forEach((reason) => reasons.add(reason));
  }
  return { riskTier, reasons: [...reasons].sort(), inconclusive };
}

function controlsForRisk(manifest: ControlManifestV1 | null, tier: RiskTier, inconclusive: boolean): string[] {
  if (manifest === null) return ['@full-control-set'];
  const selected = inconclusive
    ? manifest.controls
    : manifest.controls.filter(({ riskTiers }) => riskTiers.includes(tier));
  const byId = new Map(manifest.controls.map((control) => [control.id, control]));
  const ids = new Set(selected.map(({ id }) => id));
  const pending = [...ids];
  while (pending.length > 0) {
    const control = byId.get(pending.pop()!);
    if (control === undefined) continue;
    for (const dependency of control.dependencies) {
      if (ids.has(dependency)) continue;
      ids.add(dependency);
      pending.push(dependency);
    }
  }
  return [...ids].sort();
}

function mapInputFailure(error: unknown): string {
  if (error instanceof ExactGitInputError) {
    return error.code;
  }
  if (error instanceof Error && /^ci\.(?:input|classification)\./.test(error.message)) return error.message;
  return 'ci.input.revision-unavailable';
}

function inconclusiveResult(cwd: string, input: ExactRevisionInput, reason: string, manifest: ControlManifestV1 | null, changed: ChangeFactV1[] = []): RiskClassificationV1 {
  let suites: string[] = [];
  let graphDigest: string | null = null;
  let graphComplete = false;
  try {
    if (validOid(input.candidateOid) && commitExists(cwd, input.candidateOid)) {
      const tree = fullTreeBytes(cwd, input.candidateOid);
      graphDigest = digestBytes(tree);
      suites = testSuitesFromTree(tree);
      graphComplete = true;
    }
  } catch {
    graphComplete = false;
  }
  const reasons = new Set(graphComplete ? [reason] : [reason, 'ci.classification.graph-unavailable']);
  let observedClassifierDigest = LOADED_CLASSIFIER_DIGEST;
  try {
    observedClassifierDigest = classifierDigest();
  } catch {
    reasons.add('ci.classification.tool-source-changed');
  }
  const graphRelationshipUntrusted = reason === 'ci.classification.graph-incomplete'
    || reason === 'ci.classification.merge-base-unavailable'
    || reason === 'ci.classification.manifest-unavailable'
    || reason === 'ci.classification.manifest-invalid';
  return {
    schemaVersion: 1,
    outcome: 'inconclusive',
    exitCode: 2,
    riskTier: 'system-wide',
    reasons: [...reasons].sort(),
    changed,
    requiredControls: controlsForRisk(manifest, 'system-wide', true),
    requiredSuites: graphComplete && !graphRelationshipUntrusted ? suites : [FULL_SUITE_FALLBACK],
    baseOid: input.baseOid,
    candidateOid: input.candidateOid,
    mergeOid: input.mergeOid,
    mergeBaseOid: null,
    manifestDigest: input.manifestDigest,
    classifierDigest: observedClassifierDigest,
    graphDigest,
    changeSetDigest: changed.length === 0 ? null : digestBytes(canonicalizeBoundaryRun(changed)),
  };
}

export function classifyExactRevision(cwd: string, input: ExactRevisionInput): RiskClassificationV1 {
  let manifest: ControlManifestV1 | null = fallbackManifest(cwd, input.baseOid);
  let changed: ChangeFactV1[] = [];
  try {
    if (Object.keys(input).sort().join('\0') !== EXACT_INPUT_KEYS.join('\0')) {
      throw new Error('ci.input.shape-invalid');
    }
    if (!['pull_request', 'merge_group', 'push', 'tag', 'local'].includes(input.eventName)
      || !validOid(input.candidateOid)
      || !(input.baseOid === null || validOid(input.baseOid))
      || !(input.mergeOid === null || validOid(input.mergeOid))
      || !validDigest(input.manifestDigest)) {
      throw new Error('ci.input.revision-unavailable');
    }
    requireCommit(cwd, input.candidateOid);
    if (input.baseOid === null) throw new Error('ci.classification.merge-base-unavailable');
    try {
      requireCommit(cwd, input.baseOid);
    } catch (error) {
      if (isShallowRepository(cwd)) throw new Error('ci.classification.graph-incomplete', { cause: error });
      throw error;
    }
    try {
      manifest = candidateManifest(cwd, input.baseOid);
    } catch (error) {
      if (error instanceof ControlManifestError) {
        throw new Error('ci.classification.manifest-invalid', { cause: error });
      }
      throw new Error('ci.classification.manifest-unavailable', { cause: error });
    }
    const observedManifestDigest = digestControlManifest(manifest);
    if (observedManifestDigest !== input.manifestDigest) {
      return inconclusiveResult(cwd, input, 'ci.classification.manifest-mismatch', manifest);
    }
    const mergeRequired = input.eventName === 'pull_request' || input.eventName === 'merge_group';
    if (mergeRequired && input.mergeOid === null) throw new Error('ci.classification.merge-binding-invalid');
    if (!mergeRequired && input.mergeOid !== null) throw new Error('ci.classification.merge-binding-invalid');
    if (input.eventName === 'pull_request' && input.mergeOid !== null) {
      requireCommit(cwd, input.mergeOid);
      try {
        const parents = gitText(cwd, ['rev-list', '--parents', '-n', '1', input.mergeOid]).split(/\s+/).slice(1);
        if (parents.length !== 2 || new Set(parents).size !== 2
          || !parents.includes(input.baseOid) || !parents.includes(input.candidateOid)) {
          throw new Error('direct merge parents do not match');
        }
      } catch (error) {
        throw new Error('ci.classification.merge-binding-invalid', { cause: error });
      }
    }
    if (input.eventName === 'merge_group') {
      if (input.mergeOid !== input.candidateOid) throw new Error('ci.classification.merge-binding-invalid');
      requireCommit(cwd, input.candidateOid);
    }
    const resolvedMergeBase = mergeBase(cwd, input.baseOid, input.candidateOid);
    if (input.eventName === 'merge_group' && resolvedMergeBase !== input.baseOid) {
      throw new Error('ci.classification.merge-binding-invalid');
    }
    if ((input.eventName === 'push' || input.eventName === 'tag') && resolvedMergeBase !== input.baseOid) {
      throw new Error('ci.classification.predecessor-not-ancestor');
    }
    const evaluatedOid = input.mergeOid ?? input.candidateOid;
    changed = readExactChangeFacts(cwd, input.baseOid, evaluatedOid);
    const tree = fullTreeBytes(cwd, evaluatedOid);
    const risk = selectRisk(manifest, changed);
    try {
      const evaluatedManifestDigest = digestControlManifest(candidateManifest(cwd, evaluatedOid));
      if (evaluatedManifestDigest !== observedManifestDigest) {
        risk.riskTier = 'system-wide';
        risk.inconclusive = true;
        risk.reasons = [...new Set([...risk.reasons, 'ci.classification.candidate-policy-changed'])].sort();
      }
    } catch {
      risk.riskTier = 'system-wide';
      risk.inconclusive = true;
      risk.reasons = [...new Set([...risk.reasons, 'ci.classification.candidate-policy-invalid'])].sort();
    }
    return {
      schemaVersion: 1,
      outcome: risk.inconclusive ? 'inconclusive' : 'pass',
      exitCode: risk.inconclusive ? 2 : 0,
      riskTier: risk.riskTier,
      reasons: risk.reasons,
      changed,
      requiredControls: controlsForRisk(manifest, risk.riskTier, risk.inconclusive),
      requiredSuites: risk.riskTier === 'low' ? [] : testSuitesFromTree(tree),
      baseOid: input.baseOid,
      candidateOid: input.candidateOid,
      mergeOid: input.mergeOid,
      mergeBaseOid: resolvedMergeBase,
      manifestDigest: observedManifestDigest,
      classifierDigest: classifierDigest(),
      graphDigest: digestBytes(tree),
      changeSetDigest: digestBytes(canonicalizeBoundaryRun(changed)),
    };
  } catch (error) {
    return inconclusiveResult(cwd, input, mapInputFailure(error), manifest, changed);
  }
}

function readRemoteOid(cwd: string, remoteRef: string): string | null {
  if (!remoteRef.startsWith('refs/remotes/') || /[\u0000-\u0020~^:?*\\[]/.test(remoteRef)) return null;
  try {
    const oid = gitText(cwd, ['rev-parse', '--verify', `${remoteRef}^{commit}`]);
    return validOid(oid) ? oid : null;
  } catch {
    return null;
  }
}

function readCandidateRefOid(cwd: string, candidateRef: string | null): string | null {
  if (candidateRef === null) return null;
  if (!candidateRef.startsWith('refs/heads/') || /[\u0000-\u0020~^:?*\\[]/.test(candidateRef)) return null;
  try {
    const oid = gitText(cwd, ['rev-parse', '--verify', `${candidateRef}^{commit}`]);
    return validOid(oid) ? oid : null;
  } catch {
    return null;
  }
}

function treeGroupDigests(cwd: string, baseOid: string | null, remoteOid: string | null, manifest: ControlManifestV1): TreeGroupDigestsV1 | null {
  if (baseOid === null || remoteOid === null) return null;
  try {
    if (mergeBase(cwd, baseOid, remoteOid) !== baseOid) return null;
    const groups: Record<keyof TreeGroupDigestsV1, ChangeFactV1[]> = { documentation: [], enforcement: [] };
    for (const fact of readExactChangeFacts(cwd, baseOid, remoteOid)) {
      const risk = selectRisk(manifest, [fact]);
      groups[risk.riskTier === 'low' && !risk.inconclusive ? 'documentation' : 'enforcement'].push(fact);
    }
    return Object.fromEntries(Object.entries(groups).map(([key, facts]) => [key, digestBytes(canonicalizeBoundaryRun(facts))])) as unknown as TreeGroupDigestsV1;
  } catch {
    return null;
  }
}

function validateLineageInput(input: LineageLeaseInput): void {
  if (!validDigest(input.manifestDigest) || !validDigest(input.policyDigest) || !validDigest(input.toolchainDigest) || !validDigest(input.selectedPlanDigest)) throw new Error('lineage digest is invalid');
  if (!Array.isArray(input.prerequisiteReceiptDigests) || input.prerequisiteReceiptDigests.some((value) => !validDigest(value)) || new Set(input.prerequisiteReceiptDigests).size !== input.prerequisiteReceiptDigests.length) throw new Error('lineage prerequisite receipt set is invalid');
  const createdAt = Date.parse(input.createdAt);
  if (!Number.isFinite(createdAt) || new Date(createdAt).toISOString() !== input.createdAt
    || createdAt > Date.now() + 5 * 60_000) throw new Error('lineage creation timestamp is invalid');
  if (!(input.candidateRef === null || input.candidateRef.startsWith('refs/heads/'))) throw new Error('lineage candidate ref is invalid');
}

export function acquireLineageLease(cwd: string, input: LineageLeaseInput): LineageLeaseV1 {
  validateLineageInput(input);
  let manifest: ControlManifestV1;
  try {
    if (input.baseOid === null) throw new Error('base revision is required');
    manifest = candidateManifest(cwd, input.baseOid);
  } catch (error) {
    if (error instanceof ControlManifestError) {
      throw new LineageLeaseError('ci.lineage.manifest-invalid');
    }
    throw new LineageLeaseError('ci.lineage.manifest-unavailable');
  }
  if (digestControlManifest(manifest) !== input.manifestDigest) {
    throw new LineageLeaseError('ci.lineage.manifest-mismatch');
  }
  const remoteOid = readRemoteOid(cwd, input.remoteRef);
  if (remoteOid === null) throw new Error('ci.lineage.remote-unavailable');
  const candidateRefOid = readCandidateRefOid(cwd, input.candidateRef);
  if (input.candidateRef !== null && candidateRefOid === null) throw new Error('ci.lineage.candidate-ref-unavailable');
  if (input.candidateRef !== null && candidateRefOid !== input.candidateOid) throw new LineageLeaseError('ci.lineage.candidate-moved');
  let observedClassifierDigest: string;
  try {
    observedClassifierDigest = classifierDigest();
  } catch {
    throw new LineageLeaseError('ci.lineage.tool-source-changed');
  }
  const observedTreeGroups = treeGroupDigests(cwd, input.baseOid, remoteOid, manifest);
  if (observedTreeGroups === null) {
    throw new LineageLeaseError('ci.lineage.remote-graph-unavailable');
  }
  return {
    ...input,
    prerequisiteReceiptDigests: [...input.prerequisiteReceiptDigests].sort(),
    schemaVersion: 1,
    candidateRefOid,
    remoteOid,
    baseTreeOid: commitTreeOid(cwd, input.baseOid),
    candidateTreeOid: commitTreeOid(cwd, input.candidateOid),
    mergeTreeOid: commitTreeOid(cwd, input.mergeOid),
    classifierDigest: observedClassifierDigest,
    treeGroupDigests: observedTreeGroups,
  };
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return canonicalizeBoundaryRun(left) === canonicalizeBoundaryRun(right);
}

function identityLease(lease: LineageLeaseV1): Omit<LineageLeaseV1, 'createdAt'> {
  const { createdAt: _createdAt, ...identity } = lease;
  return identity;
}

export function invalidateForLineageChange(oldLease: LineageLeaseV1, currentLease: LineageLeaseV1): InvalidationDecisionV1 {
  if (oldLease.treeGroupDigests === null || currentLease.treeGroupDigests === null) {
    return {
      invalidated: true,
      scope: 'all',
      reasons: ['ci.lineage.remote-graph-unavailable'],
      revalidate: ALL_REVALIDATION,
    };
  }
  if (canonicalEqual(identityLease(oldLease), identityLease(currentLease))) return { invalidated: false, scope: 'none', reasons: [], revalidate: [] };
  const candidateRefOnlyOld = { ...oldLease, candidateRefOid: currentLease.candidateRefOid };
  if (oldLease.candidateRef === currentLease.candidateRef
    && oldLease.candidateRefOid !== currentLease.candidateRefOid
    && canonicalEqual(identityLease(candidateRefOnlyOld), identityLease(currentLease))) {
    return {
      invalidated: true,
      scope: 'all',
      reasons: ['ci.lineage.candidate-moved'],
      revalidate: ALL_REVALIDATION,
    };
  }
  const remoteOnlyOld = { ...oldLease, remoteOid: currentLease.remoteOid, treeGroupDigests: currentLease.treeGroupDigests };
  if (canonicalEqual(identityLease(remoteOnlyOld), identityLease(currentLease))) {
    const before = oldLease.treeGroupDigests;
    const after = currentLease.treeGroupDigests;
    if (before !== null && after !== null
      && before.enforcement === after.enforcement
      && before.documentation !== after.documentation) {
      return {
        invalidated: true,
        scope: 'metadata-and-merge',
        reasons: ['ci.lineage.remote-documentation-changed'],
        revalidate: METADATA_REVALIDATION,
      };
    }
    return {
      invalidated: true,
      scope: 'all',
      reasons: ['ci.lineage.remote-boundary-changed'],
      revalidate: ALL_REVALIDATION,
    };
  }
  return {
    invalidated: true,
    scope: 'all',
    reasons: ['ci.lineage.bound-identity-changed'],
    revalidate: ALL_REVALIDATION,
  };
}
