import { readFileSync } from 'node:fs';
import path from 'node:path';

import { isRecord } from '../../../src/lib/type-guards.ts';

import {
  analyzeExportOwnership,
  analyzeReachability,
  buildModuleGraph,
} from './module-graph.ts';
import { readGitTextAtRevision, type CandidateTree } from './git-tree.ts';
import { evidenceStateForRule } from './rule-guidance.ts';
import type { EvidenceState } from './boundary-types.ts';

export interface SemanticQualityPolicy {
  schemaVersion: 1;
  roots: string[];
  sourcePrefixes: string[];
  excludedSuffixes: string[];
  allowlist: Array<{
    path: string;
    owner: string;
    reason: string;
    expiresOn: string;
    reentryCondition: string;
  }>;
}

export interface SemanticPolicyFinding {
  ruleId:
    | 'semantic.production-reachability'
    | 'semantic.export-ownership'
    | 'semantic.unresolved-runtime-edge'
    | 'semantic.invalid-allowlist'
    | 'semantic.candidate-unavailable'
    | 'semantic.policy-unavailable'
    | 'semantic.source-tree-unavailable'
    | 'semantic.analysis-unavailable'
    | 'semantic.invocation-invalid'
    | 'semantic.receipt-write-failed';
  decision: 'warn' | 'block' | 'inconclusive';
  paths: string[];
  evidence: Array<{ label: string; value: string }>;
}

export function semanticPolicyEvidenceState(
  finding: Pick<SemanticPolicyFinding, 'ruleId'>,
): EvidenceState {
  return evidenceStateForRule(finding.ruleId);
}

const TOP_LEVEL_KEYS = new Set([
  'schemaVersion',
  'roots',
  'sourcePrefixes',
  'excludedSuffixes',
  'allowlist',
]);

const ALLOWLIST_KEYS = new Set([
  'path',
  'owner',
  'reason',
  'expiresOn',
  'reentryCondition',
]);

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function uniqueStrings(values: string[], label: string): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].map((value) => `duplicate ${label}: ${value}`);
}

function validIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function dateAt(now: Date): string {
  return now.toISOString().slice(0, 10);
}

interface PolicyValidation {
  problems: string[];
  expiredPaths: string[];
}

function validatePolicy(value: unknown, now: Date): PolicyValidation {
  const problems: string[] = [];
  const expiredPaths: string[] = [];
  if (!isRecord(value)) return { problems: ['policy must be a JSON object'], expiredPaths };

  for (const key of Object.keys(value)) {
    if (!TOP_LEVEL_KEYS.has(key)) problems.push(`unknown top-level key: ${key}`);
  }
  if (value.schemaVersion !== 1) problems.push('schemaVersion must be 1');

  const roots = Array.isArray(value.roots) && value.roots.every(nonEmptyString)
    ? value.roots
    : null;
  if (!roots || roots.length === 0) {
    problems.push('roots must be a non-empty string array');
  } else {
    problems.push(...uniqueStrings(roots, 'root'));
    for (const root of roots) {
      if (!root.startsWith('src/') || root.includes('..') || root.startsWith('/')) {
        problems.push(`root is outside src/: ${root}`);
      }
    }
  }

  const sourcePrefixes =
    Array.isArray(value.sourcePrefixes) && value.sourcePrefixes.every(nonEmptyString)
      ? value.sourcePrefixes
      : null;
  if (!sourcePrefixes || sourcePrefixes.length === 0) {
    problems.push('sourcePrefixes must be a non-empty string array');
  } else {
    problems.push(...uniqueStrings(sourcePrefixes, 'source prefix'));
    for (const prefix of sourcePrefixes) {
      if (!prefix.startsWith('src/') || prefix.includes('..') || prefix.startsWith('/')) {
        problems.push(`source prefix is outside src/: ${prefix}`);
      }
    }
  }

  const excludedSuffixes =
    Array.isArray(value.excludedSuffixes) && value.excludedSuffixes.every(nonEmptyString)
      ? value.excludedSuffixes
      : null;
  if (!excludedSuffixes) {
    problems.push('excludedSuffixes must be a string array');
  } else {
    problems.push(...uniqueStrings(excludedSuffixes, 'excluded suffix'));
  }

  if (!Array.isArray(value.allowlist)) {
    problems.push('allowlist must be an array');
    return { problems, expiredPaths };
  }

  const allowlistPaths: string[] = [];
  value.allowlist.forEach((entry, index) => {
    if (!isRecord(entry)) {
      problems.push(`allowlist entry ${index} must be an object`);
      return;
    }
    for (const key of Object.keys(entry)) {
      if (!ALLOWLIST_KEYS.has(key)) problems.push(`allowlist entry ${index} has unknown key: ${key}`);
    }
    for (const field of ALLOWLIST_KEYS) {
      if (!nonEmptyString(entry[field])) problems.push(`allowlist entry ${index} requires ${field}`);
    }

    if (nonEmptyString(entry.path)) {
      allowlistPaths.push(entry.path);
      if (!entry.path.startsWith('src/') || entry.path.includes('..') || entry.path.startsWith('/')) {
        problems.push(`allowlist path is outside src/: ${entry.path}`);
      }
    }
    if (nonEmptyString(entry.expiresOn)) {
      if (!validIsoDate(entry.expiresOn)) {
        problems.push(`allowlist expiresOn must use YYYY-MM-DD: ${entry.expiresOn}`);
      } else if (entry.expiresOn < dateAt(now)) {
        problems.push(`expired allowlist entry: ${String(entry.path)}`);
        if (nonEmptyString(entry.path)) expiredPaths.push(entry.path);
      }
    }
  });
  problems.push(...uniqueStrings(allowlistPaths, 'allowlist path'));
  return { problems, expiredPaths: [...new Set(expiredPaths)].sort() };
}

function policyFromUnknown(value: unknown, now: Date): SemanticQualityPolicy {
  const validation = validatePolicy(value, now);
  if (validation.problems.length > 0) {
    throw new Error(`invalid semantic quality policy: ${validation.problems.join('; ')}`);
  }
  const policy = value as SemanticQualityPolicy;
  return {
    schemaVersion: 1,
    roots: [...policy.roots],
    sourcePrefixes: [...policy.sourcePrefixes],
    excludedSuffixes: [...policy.excludedSuffixes],
    allowlist: policy.allowlist.map((entry) => ({ ...entry })),
  };
}

export function loadSemanticPolicy(cwd: string, revision?: string): SemanticQualityPolicy {
  const policyPath = path.join(cwd, 'config/semantic-quality.json');
  let payload: unknown;
  try {
    const text = revision
      ? readGitTextAtRevision({ cwd, revision, path: 'config/semantic-quality.json' })
      : readFileSync(policyPath, 'utf8');
    payload = JSON.parse(text) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read semantic quality policy ${policyPath}: ${message}`);
  }
  return policyFromUnknown(payload, new Date());
}

function sourcePath(policy: SemanticQualityPolicy, candidate: string): boolean {
  return (
    policy.sourcePrefixes.some((prefix) => candidate.startsWith(prefix))
    && /\.tsx?$/.test(candidate)
    && !policy.excludedSuffixes.some((suffix) => candidate.endsWith(suffix))
  );
}

function inconclusive(
  ruleId: 'semantic.source-tree-unavailable' | 'semantic.analysis-unavailable',
  label: 'source_tree_problem' | 'analysis_problem',
  problems: string[],
): SemanticPolicyFinding[] {
  return [{
    ruleId,
    decision: 'inconclusive',
    paths: [],
    evidence: problems.map((value) => ({ label, value })),
  }];
}

function invalidPolicyFindings(validation: PolicyValidation): SemanticPolicyFinding[] {
  return [{
    ruleId: 'semantic.invalid-allowlist',
    decision: 'block',
    paths: validation.expiredPaths,
    evidence: validation.problems.map((value) => ({ label: 'policy_problem', value })),
  }];
}

export function evaluateSemanticPolicy(input: {
  tree: CandidateTree;
  policy: SemanticQualityPolicy;
  now: Date;
}): SemanticPolicyFinding[] {
  const policyValidation = validatePolicy(input.policy, input.now);
  if (policyValidation.problems.length > 0) return invalidPolicyFindings(policyValidation);
  if (input.tree.limitations.length > 0) {
    return inconclusive(
      'semantic.source-tree-unavailable',
      'source_tree_problem',
      input.tree.limitations,
    );
  }

  let graph: ReturnType<typeof buildModuleGraph>;
  try {
    graph = buildModuleGraph(input.tree.sources);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return inconclusive(
      'semantic.analysis-unavailable',
      'analysis_problem',
      [message.slice(0, 500)],
    );
  }

  const missingRoots = input.policy.roots.filter((root) => !graph.files.has(root));
  if (missingRoots.length > 0) {
    return inconclusive(
      'semantic.source-tree-unavailable',
      'source_tree_problem',
      missingRoots.map((root) => `configured production root is missing: ${root}`),
    );
  }

  const candidates = input.tree.changedPaths
    .filter((changed) => changed.status !== 'deleted' && sourcePath(input.policy, changed.path));
  const reachability = analyzeReachability(
    graph,
    input.policy.roots,
    candidates.map((candidate) => candidate.path),
  );
  const unreachable = new Set(reachability.unreachableCandidates);
  const allowlist = new Map(input.policy.allowlist.map((entry) => [entry.path, entry]));
  const findings: SemanticPolicyFinding[] = [];

  for (const candidate of candidates) {
    if (!unreachable.has(candidate.path)) continue;
    const override = allowlist.get(candidate.path);
    const blockCapable = candidate.status === 'added'
      || candidate.status === 'copied'
      || candidate.status === 'renamed';
    const evidence: SemanticPolicyFinding['evidence'] = [
      { label: 'change_status', value: candidate.status },
      { label: 'head_oid', value: input.tree.headOid },
      ...input.policy.roots.map((root) => ({ label: 'production_root', value: root })),
    ];
    if (candidate.oldPath) evidence.push({ label: 'old_path', value: candidate.oldPath });
    if (override) {
      evidence.push(
        { label: 'allowlist_owner', value: override.owner },
        { label: 'allowlist_reason', value: override.reason },
        { label: 'allowlist_expires_on', value: override.expiresOn },
        { label: 'allowlist_reentry_condition', value: override.reentryCondition },
      );
    }
    findings.push({
      ruleId: 'semantic.production-reachability',
      decision: override ? 'warn' : (blockCapable ? 'block' : 'warn'),
      paths: [candidate.path],
      evidence,
    });
  }

  let ownership: ReturnType<typeof analyzeExportOwnership>;
  try {
    ownership = analyzeExportOwnership(input.tree.sources, graph, reachability.reachable);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    findings.push({
      ruleId: 'semantic.analysis-unavailable',
      decision: 'inconclusive',
      paths: [],
      evidence: [{ label: 'analysis_problem', value: message.slice(0, 500) }],
    });
    return findings;
  }

  if (ownership.unowned.length > 0) {
    findings.push({
      ruleId: 'semantic.export-ownership',
      decision: 'warn',
      paths: [...new Set(ownership.unowned.map((item) => item.path))].sort(),
      evidence: ownership.unowned.map((item) => ({
        label: 'unowned_export',
        value: `${item.path}#${item.name}`,
      })),
    });
  }

  const changedPaths = new Set(candidates.map((candidate) => candidate.path));
  const unresolvedByImporter = new Map<string, string[]>();
  for (const item of reachability.unresolved) {
    if (!changedPaths.has(item.importer)) continue;
    const specifiers = unresolvedByImporter.get(item.importer) ?? [];
    specifiers.push(item.specifier);
    unresolvedByImporter.set(item.importer, specifiers);
  }
  for (const [importer, specifiers] of [...unresolvedByImporter].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    findings.push({
      ruleId: 'semantic.unresolved-runtime-edge',
      decision: 'warn',
      paths: [importer],
      evidence: [...new Set(specifiers)].sort().map((value) => ({
        label: 'unresolved_specifier',
        value,
      })),
    });
  }

  return findings;
}
