import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { cleanGitEnv } from '../../../src/lib/git-env.ts';
import { fsyncDirectory, privateWriteError } from '../../../src/lib/private-fs.ts';
import type {
  BoundaryAction,
  BoundaryArtifact,
  BoundaryDecision,
  BoundaryFinding,
} from './boundary-types.ts';
import type { CandidateTree } from './git-tree.ts';
import type { SemanticPolicyFinding } from './policy.ts';

export type {
  BoundaryAction,
  BoundaryArtifact,
  BoundaryDecision,
  BoundaryEvidenceRecord,
  BoundaryFinding,
} from './boundary-types.ts';
export type EnforcementMode = 'shadow' | 'enforce';

export interface BoundaryReceipt {
  schemaVersion: 1;
  repository: 'LucasQuiles/WhatSoup';
  invocation: string;
  action?: BoundaryAction;
  correlationIdSha256?: string;
  enforcementMode: EnforcementMode;
  decision: BoundaryDecision;
  base: {
    headOid: string | null;
    baseOid: string | null;
    mergeBaseOid: string | null;
    evidenceSource: string;
  };
  fingerprints: Record<string, string | null>;
  findings: BoundaryFinding[];
  limitations: string[];
}

export interface BuildBoundaryReceiptInput {
  invocation: string;
  action: BoundaryAction;
  enforcementMode: EnforcementMode;
  base: BoundaryReceipt['base'];
  fingerprints?: Record<string, string | null>;
  findings: BoundaryFinding[];
  limitations?: string[];
}

export interface BuildSemanticReceiptInput {
  tree: CandidateTree;
  policyFindings: SemanticPolicyFinding[];
  enforcementMode: EnforcementMode;
  evidenceSource: string;
  limitations?: string[];
}

interface FindingLanguage {
  summary: string;
  why: string;
  correction: string[];
}

const FINDING_LANGUAGE: Record<SemanticPolicyFinding['ruleId'], FindingLanguage> = {
  'semantic.production-reachability': {
    summary: 'A changed production module is not reachable from a declared runtime root.',
    why: 'Tests or isolated declarations do not prove that a production composition path owns this module.',
    correction: [
      'Integrate the module through one declared production root and add a behavior test through that owner.',
      'If the module is intentionally non-runtime, move it outside src/ or add a scoped, expiring owner allowlist record.',
    ],
  },
  'semantic.export-ownership': {
    summary: 'A reachable module exposes a runtime export without a production owner.',
    why: 'An exported declaration can survive refactoring even after every runtime caller has been removed.',
    correction: [
      'Remove the orphaned export or call it through the production module that owns the behavior.',
      'Keep public entrypoints explicit and document their external owner before promotion to enforcement.',
    ],
  },
  'semantic.unresolved-runtime-edge': {
    summary: 'A changed production module contains an unresolved relative runtime edge.',
    why: 'An unresolved literal import prevents the exact runtime graph from proving the intended production path.',
    correction: [
      'Correct the relative specifier or add the missing committed TypeScript/TSX target.',
      'If the edge is intentionally computed at runtime, replace the literal with the reviewed composition mechanism.',
    ],
  },
  'semantic.invalid-allowlist': {
    summary: 'The semantic quality allowlist is missing, malformed, duplicated, or expired.',
    why: 'An invalid override record could hide evidence without a current owner, reason, expiry, and re-entry condition.',
    correction: [
      'Remove the invalid override or replace it with a path-qualified owner record whose expiry and re-entry condition are current.',
      'Do not use environment variables or source comments as semantic-quality bypasses.',
    ],
  },
  'semantic.candidate-unavailable': {
    summary: 'The requested candidate revision could not be resolved.',
    why: 'Without an exact candidate tree and head identity, semantic reachability and ownership analysis cannot produce a clean result.',
    correction: [
      'Fetch the requested revision and verify the --head value resolves to a committed candidate.',
      'Rerun only after the candidate tree and changed-path evidence are readable.',
    ],
  },
  'semantic.policy-unavailable': {
    summary: 'The semantic quality policy could not be read or parsed.',
    why: 'Unreadable policy evidence leaves production roots, source scope, and owner exceptions unknown.',
    correction: [
      'Restore config/semantic-quality.json at the candidate revision and validate its JSON encoding.',
      'Keep a readable but semantically invalid policy on the existing invalid-allowlist blocker path.',
    ],
  },
  'semantic.source-tree-unavailable': {
    summary: 'The candidate source tree or a configured production root is incomplete.',
    why: 'A missing source inventory or runtime root prevents the graph from proving which production composition paths exist.',
    correction: [
      'Restore the missing TypeScript source tree or correct the configured production root.',
      'Rerun after every declared root is present in the exact candidate tree.',
    ],
  },
  'semantic.analysis-unavailable': {
    summary: 'Semantic graph analysis could not complete.',
    why: 'A parse, graph, reachability, or ownership failure makes partial semantic conclusions unsafe.',
    correction: [
      'Correct the named source or analysis failure and rerun the semantic boundary.',
      'Do not treat partial graph results as proof of reachability or ownership.',
    ],
  },
  'semantic.invocation-invalid': {
    summary: 'The semantic quality invocation is invalid.',
    why: 'Unknown, conflicting, or missing CLI arguments mean the requested boundary scope was not established.',
    correction: [
      'Correct the named CLI argument and rerun with an explicit scope, head, base, mode, and receipt choice.',
    ],
  },
  'semantic.receipt-write-failed': {
    summary: 'The boundary receipt could not be written durably.',
    why: 'Analysis without an atomic durable receipt cannot prove what evidence and decision reached the enforcement boundary.',
    correction: [
      'Choose a writable non-symlink receipt path and verify its parent directory is private and durable.',
      'Rerun the complete boundary action; do not reuse an in-memory decision as durable proof.',
    ],
  },
};

const POLICY_SOURCE_RULES = new Set<SemanticPolicyFinding['ruleId']>([
  'semantic.production-reachability',
  'semantic.export-ownership',
  'semantic.unresolved-runtime-edge',
  'semantic.invalid-allowlist',
  'semantic.policy-unavailable',
  'semantic.source-tree-unavailable',
  'semantic.analysis-unavailable',
]);

function semanticSourceRefs(
  finding: SemanticPolicyFinding,
  evidenceSource: string,
): string[] {
  const sources = [evidenceSource, ...finding.paths];
  if (POLICY_SOURCE_RULES.has(finding.ruleId)) sources.push('config/semantic-quality.json');
  if (finding.ruleId === 'semantic.invocation-invalid') sources.push('semantic-quality-cli');
  if (finding.ruleId === 'semantic.receipt-write-failed') sources.push('local-receipt-writer');
  return sources;
}

function findingFromPolicy(
  finding: SemanticPolicyFinding,
  evidenceSource: string,
): BoundaryFinding {
  const language = FINDING_LANGUAGE[finding.ruleId];
  const sourceRefs = semanticSourceRefs(finding, evidenceSource);
  return {
    ruleId: finding.ruleId,
    decision: finding.decision,
    action: 'push',
    summary: language.summary,
    why: language.why,
    observed: [
      ...finding.paths.map((value) => ({ label: 'path', value })),
      ...finding.evidence,
    ],
    matchedArtifacts: [],
    correction: [...language.correction],
    rerun: 'npm run verify:semantic -- --base origin/main',
    sourceRefs,
  };
}

function sortedUnique(values: ReadonlyArray<string>): string[] {
  return [...new Set(values)].sort();
}

function sortedFingerprints(
  fingerprints: Record<string, string | null> | undefined,
): Record<string, string | null> {
  return Object.fromEntries(
    Object.entries(fingerprints ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function compareArtifacts(left: BoundaryArtifact, right: BoundaryArtifact): number {
  return (
    left.kind.localeCompare(right.kind) ||
    left.repository.localeCompare(right.repository) ||
    left.id.localeCompare(right.id)
  );
}

function canonicalFinding(item: BoundaryFinding): BoundaryFinding {
  return {
    ...item,
    observed: item.observed.map((evidence) => ({ ...evidence })),
    matchedArtifacts: item.matchedArtifacts.map((artifact) => ({ ...artifact })).sort(compareArtifacts),
    correction: [...item.correction],
    sourceRefs: sortedUnique(item.sourceRefs),
  };
}

function correlationIdSha256(input: {
  invocation: string;
  action: BoundaryAction;
  enforcementMode: EnforcementMode;
  base: BoundaryReceipt['base'];
  fingerprints: Record<string, string | null>;
  findings: BoundaryFinding[];
}): string {
  const tuple = {
    schemaVersion: 1,
    repository: 'LucasQuiles/WhatSoup',
    invocation: input.invocation,
    action: input.action,
    enforcementMode: input.enforcementMode,
    base: {
      headOid: input.base.headOid,
      baseOid: input.base.baseOid,
      mergeBaseOid: input.base.mergeBaseOid,
    },
    fingerprints: input.fingerprints,
    ruleIds: sortedUnique(input.findings.map((finding) => finding.ruleId)),
  };
  return createHash('sha256').update(JSON.stringify(tuple)).digest('hex');
}

export function buildBoundaryReceipt(input: BuildBoundaryReceiptInput): BoundaryReceipt {
  if (typeof input.invocation !== 'string' || input.invocation.trim().length === 0) {
    throw new Error('boundary receipt invocation is required');
  }
  for (const item of input.findings) {
    if (item.action !== input.action) {
      throw new Error(
        `boundary finding action ${item.action} does not match receipt action ${input.action}`,
      );
    }
    if (!isBoundaryFindingComplete(item)) {
      throw new Error(`boundary finding ${item.ruleId || '<missing>'} is incomplete`);
    }
  }
  const fingerprints = sortedFingerprints(input.fingerprints);
  const findings = input.findings
    .map(canonicalFinding)
    .sort((left, right) => left.ruleId.localeCompare(right.ruleId));
  return {
    schemaVersion: 1,
    repository: 'LucasQuiles/WhatSoup',
    invocation: input.invocation,
    action: input.action,
    correlationIdSha256: correlationIdSha256({
      invocation: input.invocation,
      action: input.action,
      enforcementMode: input.enforcementMode,
      base: input.base,
      fingerprints,
      findings,
    }),
    enforcementMode: input.enforcementMode,
    decision: aggregateBoundaryDecision(findings),
    base: { ...input.base },
    fingerprints,
    findings,
    limitations: sortedUnique(input.limitations ?? []),
  };
}

export function aggregateBoundaryDecision(
  findings: ReadonlyArray<{ decision: BoundaryDecision }>,
): BoundaryDecision {
  if (findings.some((finding) => finding.decision === 'block')) return 'block';
  if (findings.some((finding) => finding.decision === 'inconclusive')) return 'inconclusive';
  if (findings.some((finding) => finding.decision === 'warn')) return 'warn';
  return 'pass';
}

export function isBoundaryFindingComplete(item: {
  ruleId: string;
  action: string;
  summary: string;
  why: string;
  observed: ReadonlyArray<unknown>;
  correction: ReadonlyArray<string>;
  rerun: string;
  sourceRefs: ReadonlyArray<string>;
}): boolean {
  return Boolean(
    item.ruleId
      && item.action
      && item.summary
      && item.why
      && item.observed.length > 0
      && item.correction.length > 0
      && item.rerun
      && item.sourceRefs.length > 0,
  );
}

export function buildSemanticReceipt(input: BuildSemanticReceiptInput): BoundaryReceipt {
  return buildBoundaryReceipt({
    invocation: 'semantic-quality',
    action: 'push',
    enforcementMode: input.enforcementMode,
    base: {
      headOid: input.tree.headOid || null,
      baseOid: input.tree.baseOid,
      mergeBaseOid: input.tree.mergeBaseOid,
      evidenceSource: input.evidenceSource,
    },
    fingerprints: {},
    findings: input.policyFindings.map((finding) =>
      findingFromPolicy(finding, input.evidenceSource),
    ),
    limitations: [...new Set([...input.tree.limitations, ...(input.limitations ?? [])])],
  });
}

export function renderSemanticReceipt(receipt: BoundaryReceipt): string {
  if (receipt.decision === 'pass') {
    return `PASS semantic quality head=${receipt.base.headOid ?? 'unknown'}\n`;
  }

  const lines: string[] = [];
  for (const finding of receipt.findings) {
    if (lines.length > 0) lines.push('');
    lines.push(`${finding.decision.toUpperCase()} [${finding.ruleId}] while ${finding.action}`);
    if (receipt.correlationIdSha256) {
      lines.push(`Correlation: ${receipt.correlationIdSha256.slice(0, 12)}`);
    }
    lines.push(`Summary: ${finding.summary}`);
    lines.push('Observed:');
    for (const item of finding.observed) lines.push(`  - ${item.label}: ${item.value}`);
    if (finding.matchedArtifacts.length > 0) {
      lines.push('Matched artifacts:');
      for (const item of finding.matchedArtifacts) {
        const details = [
          `${item.kind} ${item.repository}#${item.id}`,
          item.state ? `state=${item.state}` : '',
          item.url ?? '',
          item.fingerprintSha256 ? `fingerprint=${item.fingerprintSha256}` : '',
        ].filter(Boolean);
        lines.push(`  - ${details.join(' ')}`);
      }
    }
    lines.push(`Why: ${finding.why}`);
    lines.push('Correction:');
    for (const item of finding.correction) lines.push(`  - ${item}`);
    lines.push(`Rerun: ${finding.rerun}`);
    lines.push('Sources:');
    for (const item of finding.sourceRefs) lines.push(`  - ${item}`);
  }
  if (receipt.findings.length === 0 && receipt.limitations.length > 0) {
    lines.push(`INCONCLUSIVE [boundary.evidence-incomplete] while ${receipt.action ?? 'push'}`);
    if (receipt.correlationIdSha256) {
      lines.push(`Correlation: ${receipt.correlationIdSha256.slice(0, 12)}`);
    }
    lines.push('Observed:');
    for (const limitation of receipt.limitations) lines.push(`  - limitation: ${limitation}`);
  }
  return `${lines.join('\n')}\n`;
}

export function semanticExitCode(receipt: BoundaryReceipt): 0 | 1 | 2 {
  if (receipt.enforcementMode === 'shadow') return 0;
  if (receipt.decision === 'block') return 1;
  if (receipt.decision === 'inconclusive') return 2;
  return 0;
}

function assertReceiptDestination(filePath: string): void {
  try {
    const stat = lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      throw privateWriteError('refusing to write receipt through symlink', 'ELOOP');
    }
    if (!stat.isFile()) {
      throw privateWriteError('refusing to write receipt over non-regular path', 'EINVAL');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export function writeSemanticReceipt(filePath: string, receipt: BoundaryReceipt): string {
  const absolute = path.resolve(filePath);
  const directory = path.dirname(absolute);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = lstatSync(directory);
  if (directoryStat.isSymbolicLink()) {
    throw privateWriteError('refusing to write receipt through symlinked directory', 'ELOOP');
  }
  if (!directoryStat.isDirectory()) {
    throw privateWriteError('refusing to write receipt under non-directory path', 'EINVAL');
  }
  assertReceiptDestination(absolute);

  const temporary = path.join(
    directory,
    `.${path.basename(absolute)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    assertReceiptDestination(absolute);
    renameSync(temporary, absolute);
    fsyncDirectory(directory);
  } catch (error) {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // Best effort after the primary write failure.
      }
    }
    try {
      unlinkSync(temporary);
    } catch {
      // Best effort when the temporary file was never created or was already renamed.
    }
    throw error;
  }
  return absolute;
}

export function writeLocalReceipt(cwd: string, receipt: BoundaryReceipt): string {
  const gitPath = execFileSync(
    'git',
    ['rev-parse', '--git-path', 'whatsoup/receipts/semantic-quality.json'],
    {
      cwd,
      encoding: 'utf8',
      env: cleanGitEnv(),
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim();
  if (!gitPath) throw new Error('git returned an empty semantic receipt path');
  const receiptPath = path.isAbsolute(gitPath) ? gitPath : path.resolve(cwd, gitPath);
  return writeSemanticReceipt(receiptPath, receipt);
}
