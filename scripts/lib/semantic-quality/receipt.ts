import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
import type { CandidateTree } from './git-tree.ts';
import type { SemanticPolicyFinding } from './policy.ts';

export type BoundaryDecision = 'pass' | 'warn' | 'block' | 'inconclusive';
export type EnforcementMode = 'shadow' | 'enforce';

export interface BoundaryFinding {
  ruleId: string;
  decision: Exclude<BoundaryDecision, 'pass'>;
  action: 'push';
  summary: string;
  why: string;
  observed: Array<{ label: string; value: string }>;
  matchedArtifacts: [];
  correction: string[];
  rerun: string;
  sourceRefs: string[];
}

export interface BoundaryReceipt {
  schemaVersion: 1;
  repository: 'LucasQuiles/WhatSoup';
  invocation: 'semantic-quality';
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
};

function findingFromPolicy(
  finding: SemanticPolicyFinding,
  evidenceSource: string,
): BoundaryFinding {
  const language = FINDING_LANGUAGE[finding.ruleId];
  const sourceRefs = [
    evidenceSource,
    'config/semantic-quality.json',
    ...finding.paths,
  ];
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
    sourceRefs: [...new Set(sourceRefs)],
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
  return {
    schemaVersion: 1,
    repository: 'LucasQuiles/WhatSoup',
    invocation: 'semantic-quality',
    enforcementMode: input.enforcementMode,
    decision: aggregateBoundaryDecision(input.policyFindings),
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
  };
}

export function renderSemanticReceipt(receipt: BoundaryReceipt): string {
  if (receipt.decision === 'pass') {
    return `PASS semantic quality head=${receipt.base.headOid ?? 'unknown'}\n`;
  }

  const lines: string[] = [];
  for (const finding of receipt.findings) {
    if (lines.length > 0) lines.push('');
    lines.push(`${finding.decision.toUpperCase()} [${finding.ruleId}] while ${finding.action}`);
    lines.push(`Summary: ${finding.summary}`);
    lines.push('Observed:');
    for (const item of finding.observed) lines.push(`  - ${item.label}: ${item.value}`);
    lines.push(`Why: ${finding.why}`);
    lines.push('Correction:');
    for (const item of finding.correction) lines.push(`  - ${item}`);
    lines.push(`Rerun: ${finding.rerun}`);
    lines.push('Sources:');
    for (const item of finding.sourceRefs) lines.push(`  - ${item}`);
  }
  if (receipt.findings.length === 0 && receipt.limitations.length > 0) {
    lines.push('INCONCLUSIVE [semantic.production-reachability] while push');
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
