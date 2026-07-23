import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TextDecoder, types as utilTypes } from 'node:util';
import {
  git,
  isDocumentationEmailFixture,
  isOperationalProtocolToken,
  normalizeRepoPath,
  operationalReleaseHygieneFiles,
} from './lib/guard-core.ts';
import {
  ExactGitInputError,
  MAX_EXACT_ADDED_LINE_BUDGET_V1,
  MAX_EXACT_TREE_ENTRY_PATH_COUNT,
  readExactAddedLinesWithinBudget,
  readExactBlobs,
  readExactCommitMetadata,
  readExactCommitRange,
  readExactTreeEntries,
  type ExactAddedLineBudgetAccountingV1,
  type ExactAddedLineBudgetV1,
  type ExactAddedLineV1,
  type ExactChangeWithAddedLinesV1,
  type ExactCommitMetadataV1,
} from './lib/ci-control/git-input.ts';
import { canonicalizeBoundaryRun } from './lib/verification/boundary-run/shared.ts';
import { parseBoundaryJsonBytes } from './lib/verification/boundary-run/schema.ts';
import { validateExactRangeProvenance } from './lib/ci-control/exact-range-provenance.ts';
import {
  addedLinePatterns,
  allowedEnvVarNameToken,
  allowedMessagingAddressRhs,
  allowedPhoneFixture,
  allowedProviderKeyFixture,
  allowedSecretAssignmentValue,
  allowedTwilioSidFixture,
  commitMessagePatterns,
  disallowedCommitAuthorPatterns,
  findDisallowedMatch,
  fixtureFiles,
  isAllowedPatternMatch,
  isChildProcessShellTrue,
  isDynamicCodeExecution,
  isFixtureFile,
  isPackageLockResolvedUrlLine,
  isProcessEnvInheritance,
  isProductionCodePath,
  isSourceConsoleCall,
  releaseHygieneFiles,
  selfReferentialAllowedCodes,
  selfReferentialAllowlistFiles,
  srcConsoleAllowedFiles,
  trackedSensitiveAllowlist,
  trackedSensitiveArtifactPatterns,
  type GuardPattern,
} from './lib/repo-hygiene-policy.ts';

export { privateHostLabels, isAllowedPatternMatch } from './lib/repo-hygiene-policy.ts';


export { normalizeRepoPath } from './lib/guard-core.ts';

export type GuardMode =
  | 'staged'
  | 'branch-diff'
  | 'commit-msg'
  | 'release-hygiene'
  | 'commit-authors'
  | 'scan-history';

export interface ParsedArgs {
  mode: GuardMode;
  messageFile?: string;
  baseRef?: string;
  historyDepth?: number;
  help: boolean;
}

export interface AddedLine {
  filePath: string;
  line: number;
  text: string;
}

export interface GuardIssue {
  code: string;
  message: string;
  filePath?: string;
  line?: number;
}

export interface CommitAuthor {
  sha: string;
  name: string;
  email: string;
  subject: string;
  message?: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { mode: 'staged', help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--staged') {
      args.mode = 'staged';
    } else if (arg === '--branch-diff') {
      args.mode = 'branch-diff';
    } else if (arg === '--base') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        throw new Error('--base requires a git ref');
      }
      args.baseRef = next;
      i += 1;
    } else if (arg === '--release-hygiene') {
      args.mode = 'release-hygiene';
    } else if (arg === '--commit-authors') {
      args.mode = 'commit-authors';
    } else if (arg === '--scan-history') {
      args.mode = 'scan-history';
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        const depth = Number(next);
        if (!Number.isInteger(depth) || depth <= 0) {
          throw new Error(`--scan-history depth must be a positive integer: ${next}`);
        }
        args.historyDepth = depth;
        i += 1;
      }
    } else if (arg === '--commit-msg') {
      args.mode = 'commit-msg';
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args.messageFile = next;
        i += 1;
      }
    } else if (args.mode === 'commit-msg' && !args.messageFile) {
      args.messageFile = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (args.baseRef && args.mode !== 'branch-diff') {
    throw new Error('--base is only valid with --branch-diff');
  }

  return args;
}

function stripDiffPath(filePath: string): string {
  if (filePath.startsWith('b/')) return normalizeRepoPath(filePath.slice(2));
  return normalizeRepoPath(filePath);
}

export function parseUnifiedDiffAddedLines(diff: string): AddedLine[] {
  const addedLines: AddedLine[] = [];
  let filePath: string | null = null;
  let nextLine = 0;

  for (const rawLine of diff.split(/\r?\n/)) {
    if (rawLine.startsWith('+++ ')) {
      const candidate = rawLine.slice(4).trim();
      filePath = candidate === '/dev/null' ? null : stripDiffPath(candidate);
      continue;
    }

    const hunk = rawLine.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      nextLine = Number(hunk[1]);
      continue;
    }

    if (!filePath || nextLine === 0) continue;
    if (rawLine.startsWith('+')) {
      addedLines.push({ filePath, line: nextLine, text: rawLine.slice(1) });
      nextLine += 1;
    } else if (rawLine.startsWith(' ')) {
      nextLine += 1;
    }
  }

  return addedLines;
}


function isInertMarkdownPath(filePath: string): boolean {
  return /\.(?:md|markdown)$/i.test(filePath);
}

export function scanAddedLines(lines: AddedLine[]): GuardIssue[] {
  const issues: GuardIssue[] = [];

  for (const line of lines) {
    const filePath = normalizeRepoPath(line.filePath);
    const productionCodePath = isProductionCodePath(filePath);

    if (isFixtureFile(filePath)) continue;
    if (isSourceConsoleCall(filePath, line.text)) {
      issues.push({
        code: 'src-console-call',
        message: 'Production source should use the structured logger instead of ad-hoc console calls.',
        filePath: line.filePath,
        line: line.line,
      });
    }
    if (productionCodePath && isProcessEnvInheritance(line.text)) {
      issues.push({
        code: 'process-env-inheritance',
        message: 'Child processes must use an explicit allowlisted env instead of inheriting process.env.',
        filePath: line.filePath,
        line: line.line,
      });
    }
    if (productionCodePath && isChildProcessShellTrue(line.text)) {
      issues.push({
        code: 'child-process-shell-true',
        message: 'Child process shell mode must not be introduced without an explicit reviewed exception.',
        filePath: line.filePath,
        line: line.line,
      });
    }
    if (productionCodePath && isDynamicCodeExecution(line.text)) {
      issues.push({
        code: 'dynamic-code-execution',
        message: 'Dynamic code execution must not be introduced in source, scripts, or deploy code.',
        filePath: line.filePath,
        line: line.line,
      });
    }
    if (
      !isInertMarkdownPath(filePath)
      && isSuppressionComment(line.text)
      && !hasSuppressionRationaleAndExpiry(line.text)
    ) {
      issues.push({
        code: 'unbounded-suppression',
        message: 'Lint/type suppressions must include a rationale and an expires YYYY-MM-DD marker.',
        filePath: line.filePath,
        line: line.line,
      });
    }
    for (const pattern of addedLinePatterns) {
      if (pattern.code === 'internal-workstream-label' && isPackageLockResolvedUrlLine(filePath, line.text)) {
        continue;
      }
      if (findDisallowedMatch(filePath, pattern, line.text)) {
        issues.push({
          code: pattern.code,
          message: pattern.message,
          filePath: line.filePath,
          line: line.line,
        });
      }
    }
  }

  return issues;
}

function isSuppressionComment(text: string): boolean {
  // Concatenated at build time to avoid the bare-suppression hook false-positive
  // on this detector's own source line (the hook greps for the literal token).
  const lintSuppressToken = ['eslint', 'disable'].join('-');
  return new RegExp(`(?:@ts-ignore|@ts-expect-error|@ts-nocheck|${lintSuppressToken}|biome-ignore)`).test(text);
}

function hasSuppressionRationaleAndExpiry(text: string): boolean {
  return /--\s+\S.*\bexpires\s+\d{4}-\d{2}-\d{2}\b/.test(text);
}

export function scanCommitMessage(message: string): GuardIssue[] {
  const issues: GuardIssue[] = [];
  const lines = message.split(/\r?\n/);

  lines.forEach((text, index) => {
    for (const pattern of commitMessagePatterns) {
      if (findDisallowedMatch('', pattern, text)) {
        issues.push({ code: pattern.code, message: pattern.message, line: index + 1 });
      }
    }
  });

  return issues;
}

function stagedDiff(cwd: string): string {
  return git(['diff', '--cached', '--unified=0', '--no-ext-diff'], cwd);
}

function stagedFilePaths(cwd: string): string[] {
  return git(['diff', '--cached', '--name-only', '--diff-filter=ACMR'], cwd)
    .split(/\r?\n/)
    .filter(Boolean)
    .map(normalizeRepoPath);
}

function trackedFiles(cwd: string, filePaths: readonly string[]): string[] {
  const tracked = new Set(git(['ls-files', '-z', '--', ...filePaths], cwd)
    .split('\0')
    .filter(Boolean)
    .map(normalizeRepoPath));

  return filePaths.filter((filePath) => tracked.has(filePath));
}

export function isTrackedSensitiveArtifact(filePath: string): boolean {
  const normalized = normalizeRepoPath(filePath);
  if (trackedSensitiveAllowlist.has(normalized)) return false;
  if (trackedSensitiveArtifactPatterns.some((pattern) => pattern.test(normalized))) return true;
  if (normalized === '.mcp.json') return true;
  return false;
}

function sensitiveArtifactIssues(
  filePaths: readonly string[],
  code: string,
  message: string,
): GuardIssue[] {
  return filePaths
    .filter(isTrackedSensitiveArtifact)
    .map((filePath) => ({
      code,
      filePath,
      message,
    }));
}

function scanStagedSensitiveArtifacts(cwd: string): GuardIssue[] {
  return sensitiveArtifactIssues(
    stagedFilePaths(cwd),
    'staged-sensitive-artifact',
    'Runtime credential, database, key, workspace, or scratch artifact must not be committed.',
  );
}

export function scanContentLines(lines: AddedLine[]): GuardIssue[] {
  const issues: GuardIssue[] = [];

  for (const line of lines) {
    const filePath = normalizeRepoPath(line.filePath);
    if (isFixtureFile(filePath)) continue;
    for (const pattern of addedLinePatterns) {
      if (findDisallowedMatch(filePath, pattern, line.text)) {
        issues.push({
          code: pattern.code,
          message: pattern.message,
          filePath: line.filePath,
          line: line.line,
        });
      }
    }
  }

  return issues;
}

export function scanTrackedFiles(cwd: string): GuardIssue[] {
  const lines: AddedLine[] = [];

  for (const filePath of trackedFiles(cwd, releaseHygieneFiles)) {
    const content = readFileSync(path.join(cwd, filePath), 'utf8');
    content.split(/\r?\n/).forEach((text, index) => {
      lines.push({ filePath, line: index + 1, text });
    });
  }

  return scanContentLines(lines);
}

// Secret-shaped detector codes — the high-signal subset used for advisory
// history scanning. Hygiene-only patterns (focused-test, console calls, internal
// labels) are intentionally excluded so history scans stay actionable.
const secretPatternCodes = new Set([
  'github-token',
  'anthropic-key',
  'openai-key',
  'pinecone-key',
  'twilio-account-sid',
  'slack-token',
  'private-key',
  'secret-assignment',
  'operator-phone',
  'whatsapp-group-jid',
  'whatsapp-user-jid',
  'personal-email',
]);

const secretPatterns = addedLinePatterns.filter((pattern) => secretPatternCodes.has(pattern.code));

/**
 * Advisory-only: scan added lines of recent commits for leaked secret shapes.
 * Report-only — never mutates exitCode in run() for this mode. Fail-closed: a
 * git/parse failure throws rather than returning a silent empty result.
 */
export function scanCommitHistory(cwd: string, depth: number): GuardIssue[] {
  const shas = git(['log', `-${depth}`, '--format=%H'], cwd)
    .split(/\r?\n/)
    .filter(Boolean);

  const issues: GuardIssue[] = [];
  for (const sha of shas) {
    // --unified=0, no-ext-diff for added lines only; -m flattens merge diffs.
    const diff = git(
      ['show', '--format=', '--unified=0', '--no-ext-diff', '-m', sha],
      cwd,
    );
    for (const line of parseUnifiedDiffAddedLines(diff)) {
      const filePath = normalizeRepoPath(line.filePath);
      if (isFixtureFile(filePath)) continue;
      for (const pattern of secretPatterns) {
        if (findDisallowedMatch(filePath, pattern, line.text)) {
          issues.push({
            code: pattern.code,
            message: `[history ${sha.slice(0, 12)}] ${pattern.message}`,
            filePath: line.filePath,
            line: line.line,
          });
        }
      }
    }
  }

  return issues;
}

function branchCommitShas(cwd: string, mergeBase: string): string[] {
  return git(['log', '--reverse', '--format=%H', `${mergeBase}..HEAD`], cwd)
    .split(/\r?\n/)
    .filter(Boolean);
}

// Raw line-set of a file as it exists at the base ref (origin/main), cached per file.
// Used by the branch-history scan to skip matches byte-identical to already-published
// content. Returns an empty set when the file is absent at the base (every line is then
// genuinely branch-new and must be scanned).
function baseRefFileLines(
  cwd: string,
  baseRef: string,
  filePath: string,
  cache: Map<string, Set<string>>,
): Set<string> {
  const cached = cache.get(filePath);
  if (cached) return cached;
  let lines = new Set<string>();
  // ls-tree is quiet for paths absent at the base (empty output, no stderr), so a
  // branch-new file never emits a `fatal: path ... not in <base>` line. Only read the
  // blob when the path exists at the base.
  let existsAtBase = false;
  try {
    existsAtBase = git(['ls-tree', baseRef, '--', filePath], cwd).trim() !== '';
  } catch {
    existsAtBase = false;
  }
  if (existsAtBase) {
    try {
      lines = new Set(git(['show', `${baseRef}:${filePath}`], cwd).split(/\r?\n/));
    } catch {
      lines = new Set();
    }
  }
  cache.set(filePath, lines);
  return lines;
}

function scanBranchCommitSecretLines(
  cwd: string,
  sha: string,
  baseRef?: string,
  baseLineCache?: Map<string, Set<string>>,
): GuardIssue[] {
  const issues: GuardIssue[] = [];
  const diff = git(['show', '--format=', '--unified=0', '--no-ext-diff', '-m', sha], cwd);

  for (const line of parseUnifiedDiffAddedLines(diff)) {
    const filePath = normalizeRepoPath(line.filePath);
    if (isFixtureFile(filePath)) continue;
    // Correctness (not a detection weakening): a line byte-identical to the base ref
    // (origin/main) is already-published content, not branch-introduced. Merge commits
    // re-expose the base's own lines as branch-unique per-commit diffs; skipping those
    // removes that false-positive class. A genuinely new secret cannot already exist in
    // origin/main, so every real introduction is still flagged.
    if (
      baseRef
      && baseLineCache
      && baseRefFileLines(cwd, baseRef, line.filePath, baseLineCache).has(line.text)
    ) {
      continue;
    }
    for (const pattern of secretPatterns) {
      if (findDisallowedMatch(filePath, pattern, line.text)) {
        issues.push({
          code: pattern.code,
          message: `[branch history ${sha.slice(0, 12)}] ${pattern.message}`,
          filePath: line.filePath,
          line: line.line,
        });
      }
    }
  }

  return issues;
}

function scanBranchCommitSensitiveArtifacts(cwd: string, sha: string): GuardIssue[] {
  const changedFiles = git(['diff-tree', '--no-commit-id', '--name-only', '--diff-filter=ACMR', '-r', sha], cwd)
    .split(/\r?\n/)
    .filter(Boolean)
    .map(normalizeRepoPath);

  return sensitiveArtifactIssues(
    changedFiles,
    'branch-history-sensitive-artifact',
    `Runtime credential, database, key, workspace, or scratch artifact was committed in branch history ${sha.slice(0, 12)}.`,
  );
}

export function scanBranchSecretHistory(
  cwd: string,
  mergeBase: string,
  baseRef?: string,
): GuardIssue[] {
  const issues: GuardIssue[] = [];
  const baseLineCache = new Map<string, Set<string>>();
  for (const sha of branchCommitShas(cwd, mergeBase)) {
    issues.push(
      ...scanBranchCommitSensitiveArtifacts(cwd, sha),
      ...scanBranchCommitSecretLines(cwd, sha, baseRef, baseLineCache),
    );
  }
  return issues;
}

export function parseCommitAuthorLog(log: string): CommitAuthor[] {
  return log
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha, name, email, subject, message] = record.split('\x00');
      return {
        sha: sha ?? '',
        name: name ?? '',
        email: email ?? '',
        subject: subject ?? '',
        ...(message === undefined ? {} : { message }),
      };
    })
    .filter((commit) => commit.sha !== '');
}

export function scanCommitAuthors(commits: CommitAuthor[]): GuardIssue[] {
  const issues: GuardIssue[] = [];

  for (const commit of commits) {
    const author = `${commit.name} ${commit.email}`;
    for (const pattern of disallowedCommitAuthorPatterns) {
      if (pattern.regex.test(author)) {
        issues.push({
          code: pattern.code,
          message: `${pattern.message} (${commit.subject || 'no subject'})`,
          filePath: `commit:${commit.sha.slice(0, 12)}`,
        });
        break;
      }
    }

    for (const issue of scanCommitMessage(commit.message ?? commit.subject)) {
      issues.push({
        ...issue,
        message: `${issue.message} (${commit.subject || 'no subject'})`,
        filePath: `commit:${commit.sha.slice(0, 12)}`,
      });
    }
  }

  return issues;
}

function gitRefExists(cwd: string, ref: string): boolean {
  try {
    git(['rev-parse', '--verify', '--quiet', ref], cwd);
    return true;
  } catch {
    return false;
  }
}

function branchDiffBaseRef(cwd: string, requestedBaseRef?: string): string | null {
  const explicitBaseRef = requestedBaseRef?.trim();
  if (explicitBaseRef) {
    if (!gitRefExists(cwd, explicitBaseRef)) {
      throw new Error(`--base ref does not exist: ${explicitBaseRef}`);
    }
    return explicitBaseRef;
  }

  const githubBaseRef = process.env.GITHUB_BASE_REF?.trim();
  if (githubBaseRef && gitRefExists(cwd, `origin/${githubBaseRef}`)) {
    return `origin/${githubBaseRef}`;
  }

  if (gitRefExists(cwd, 'origin/main')) return 'origin/main';

  try {
    const branch = git(['branch', '--show-current'], cwd).trim();
    const upstream = branch
      ? git(['for-each-ref', '--format=%(upstream:short)', `refs/heads/${branch}`], cwd).trim()
      : '';
    if (upstream && gitRefExists(cwd, upstream)) return upstream;
  } catch {
    // Detached or not-yet-published branch with no origin/main mirror.
  }

  return null;
}

function branchMergeBase(cwd: string, baseRef: string): string {
  const mergeBase = git(['merge-base', baseRef, 'HEAD'], cwd).trim();
  if (!mergeBase) {
    throw new Error(`No merge base found between ${baseRef} and HEAD`);
  }
  return mergeBase;
}

export function scanBranchDiff(cwd: string, requestedBaseRef?: string): GuardIssue[] {
  const baseRef = branchDiffBaseRef(cwd, requestedBaseRef);
  if (!baseRef) {
    throw new Error('No branch-diff base ref found; pass --base <ref> or fetch origin/main');
  }

  const mergeBase = branchMergeBase(cwd, baseRef);
  const changedFiles = git(['diff', '--name-only', '--diff-filter=ACMR', `${mergeBase}..HEAD`], cwd)
    .split(/\r?\n/)
    .filter(Boolean)
    .map(normalizeRepoPath);
  const diff = git(['diff', '--unified=0', '--no-ext-diff', `${mergeBase}..HEAD`], cwd);

  const finalDiffIssues = [
    ...sensitiveArtifactIssues(
      changedFiles,
      'branch-sensitive-artifact',
      'Runtime credential, database, key, workspace, or scratch artifact must not be committed in the branch diff.',
    ),
    ...scanAddedLines(parseUnifiedDiffAddedLines(diff)),
  ];
  const finalSensitiveArtifactPaths = new Set(
    finalDiffIssues
      .filter((issue) => issue.code === 'branch-sensitive-artifact' && issue.filePath)
      .map((issue) => issue.filePath),
  );
  const seen = new Set(finalDiffIssues.map((issue) => `${issue.code}:${issue.filePath ?? ''}:${issue.line ?? 0}`));
  const historyIssues = scanBranchSecretHistory(cwd, mergeBase, baseRef)
    .filter((issue) => {
      if (
        issue.code === 'branch-history-sensitive-artifact'
        && issue.filePath
        && finalSensitiveArtifactPaths.has(issue.filePath)
      ) {
        return false;
      }
      const key = `${issue.code}:${issue.filePath ?? ''}:${issue.line ?? 0}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  return [...finalDiffIssues, ...historyIssues];
}

function commitAuthorBaseRef(cwd: string): string | null {
  const githubBaseRef = process.env.GITHUB_BASE_REF?.trim();
  if (githubBaseRef && gitRefExists(cwd, `origin/${githubBaseRef}`)) {
    return `origin/${githubBaseRef}`;
  }

  // The public boundary is the default branch, not the branch's own upstream:
  // preferring the upstream made a sync-merge pull already-published main
  // commits into the scan range, so violations that landed upstream blocked
  // unrelated branches from pushing.
  if (gitRefExists(cwd, 'origin/main')) return 'origin/main';

  try {
    const branch = git(['branch', '--show-current'], cwd).trim();
    const upstream = branch
      ? git(['for-each-ref', '--format=%(upstream:short)', `refs/heads/${branch}`], cwd).trim()
      : '';
    if (upstream && gitRefExists(cwd, upstream)) return upstream;
  } catch {
    // Detached or not-yet-published branch with no origin/main mirror.
  }

  return null;
}

export function readCommitAuthors(cwd: string): CommitAuthor[] {
  const baseRef = commitAuthorBaseRef(cwd);
  if (!baseRef) {
    const log = git(['log', '--format=%H%x00%an%x00%ae%x00%s%x00%B%x1e', '-1', 'HEAD'], cwd);
    return parseCommitAuthorLog(log);
  }
  // Exclude commits already reachable from origin/main.  This matters when the
  // upstream ref lags behind origin/main: without the exclusion, commits that
  // have already merged into main are re-scanned on subsequent branches.
  // Concretely, a GitHub squash-merge appends a GitHub-generated Co-authored-by
  // trailer to the merged commit on origin/main; that merged commit should never
  // enter the scan window for a fresh branch even if baseRef still points to an
  // older upstream tip.  When baseRef IS origin/main the argument is redundant
  // but harmless.
  //
  // NOTE: future squash merges via `gh pr merge --squash` should pass
  // `--body <message>` explicitly to prevent GitHub from appending the
  // generated trailer automatically.
  const excludeArgs = gitRefExists(cwd, 'origin/main') ? ['--not', 'origin/main'] : [];
  const log = git(
    ['log', '--format=%H%x00%an%x00%ae%x00%s%x00%B%x1e', `${baseRef}..HEAD`, ...excludeArgs],
    cwd,
  );
  return parseCommitAuthorLog(log);
}

const REPO_HYGIENE_EXACT_RANGE_DETECTOR = 'repo-hygiene-guard';
const REPO_HYGIENE_EXACT_RANGE_OWNER = 'repository-hygiene-decision-owner';
const REPO_HYGIENE_EXACT_RANGE_VALIDITY_MS = 5 * 60 * 1000;
const MAX_REPO_HYGIENE_EXACT_RANGE_FINDINGS = 4_096;
const FULL_OID = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true });
const MODULE_PATH = fileURLToPath(import.meta.url);
const GUARD_CORE_MODULE_PATH = fileURLToPath(new URL('./lib/guard-core.ts', import.meta.url));
const REPO_HYGIENE_POLICY_MODULE_PATH = fileURLToPath(
  new URL('./lib/repo-hygiene-policy.ts', import.meta.url),
);
const EXACT_RANGE_PROVENANCE_MODULE_PATH = fileURLToPath(
  new URL('./lib/ci-control/exact-range-provenance.ts', import.meta.url),
);
const REPO_HYGIENE_POLICY_PROJECTION_COVERAGE = Object.freeze([
  'base-line-sets',
  'child-process-shell-true',
  'dynamic-code-execution',
  'find-disallowed-match',
  'fixture-file-routing',
  'normalize-repo-path',
  'package-lock-resolved-url-exception',
  'pattern-allowlist-routing',
  'process-env-inheritance',
  'production-code-path-routing',
  'scan-added-lines',
  'scan-commit-authors',
  'scan-commit-message',
  'secret-history-subset',
  'source-console-routing',
  'suppression-comment-routing',
  'suppression-rationale-expiry',
  'tracked-sensitive-artifact-routing',
] as const);
const REPO_HYGIENE_EXACT_RANGE_LIMITATIONS = Object.freeze([
  'aggregate-authorization-unavailable',
  'changed-content-only',
  'executor-platform-unavailable',
  'finding-fingerprint-unavailable',
  'precondition-receipt-unavailable',
  'producer-authentication-unavailable',
  'report-only',
  'terminal-attempt-process-group-unavailable',
] as const);

export interface RepoHygieneExactRangeInputV1 {
  baseOid: string;
  remoteOid: string | null;
  localOid: string;
}

export interface RepoHygieneExactRangeFindingV1 {
  cause: string;
  observationKind:
    | 'net-added-line'
    | 'net-sensitive-artifact'
    | 'history-added-line'
    | 'history-sensitive-artifact'
    | 'commit-metadata';
  commitOid: string;
  parentOid: string | null;
  path: string | null;
  pathDisclosure: 'redacted' | 'not-applicable';
  line: number | null;
  blobOid: string | null;
}

export interface RepoHygieneExactRangeCommitBindingV1 {
  oid: string;
  parentOids: string[];
  treeOid: string;
  metadataSha256: `sha256:${string}`;
}

export interface RepoHygieneExactRangeReceiptV1 {
  schemaVersion: 1;
  detectorId: typeof REPO_HYGIENE_EXACT_RANGE_DETECTOR;
  decisionOwner: typeof REPO_HYGIENE_EXACT_RANGE_OWNER;
  authorization: 'report-only';
  outcome: 'pass' | 'block';
  exitCode: 0 | 1;
  completeness: 'complete';
  baseOid: string;
  remoteOid: string | null;
  rangeStartOid: string;
  localOid: string;
  toolDigest: `sha256:${string}`;
  policyDigest: `sha256:${string}`;
  commitBindings: RepoHygieneExactRangeCommitBindingV1[];
  commitRangeDigest: `sha256:${string}`;
  metadataDigest: `sha256:${string}`;
  observedPathDisclosure: 'all-redacted';
  observedPathDigest: `sha256:${string}`;
  observedBlobOidDigest: `sha256:${string}`;
  budget: ExactAddedLineBudgetAccountingV1;
  claimedScope: {
    content: 'net-range-all-rules';
    history: 'per-parent-secret-and-sensitive-artifact';
    metadata: 'all-ordered-outgoing-commits';
  };
  observedScope: {
    commitCount: number;
    parentEdgeCount: number;
    changeCount: number;
    observedPathCount: number;
  };
  nativeCauses: string[];
  findings: RepoHygieneExactRangeFindingV1[];
  limitations: string[];
  createdAt: string;
  validUntil: string;
}

export interface RepoHygieneExactRangeArtifactV1 {
  payloadBytes: Uint8Array;
  binding: {
    schemaVersion: 1;
    detectorId: typeof REPO_HYGIENE_EXACT_RANGE_DETECTOR;
    payloadByteLength: number;
    payloadSha256: `sha256:${string}`;
  };
}

export interface RepoHygieneExactRangeExpectedV1 extends RepoHygieneExactRangeInputV1 {
  currentToolDigest: string;
  currentPolicyDigest: string;
  expectedPayloadByteLength: number;
  expectedPayloadSha256: string;
}

export type RepoHygieneExactRangeErrorCode =
  | 'repo-hygiene.exact-range.input-malformed'
  | 'repo-hygiene.exact-range.evidence-unavailable'
  | 'repo-hygiene.exact-range.budget'
  | 'repo-hygiene.exact-range.identity-mismatch'
  | 'repo-hygiene.exact-range.tool-drift'
  | 'repo-hygiene.exact-range.policy-drift'
  | 'repo-hygiene.exact-range.receipt-invalid'
  | 'repo-hygiene.exact-range.receipt-binding-mismatch'
  | 'repo-hygiene.exact-range.receipt-stale'
  | 'repo-hygiene.exact-range.tool-mismatch'
  | 'repo-hygiene.exact-range.policy-mismatch';

export type RepoHygieneExactRangeBuildResultV1 =
  | { ok: true; artifact: RepoHygieneExactRangeArtifactV1 }
  | { ok: false; error: { code: RepoHygieneExactRangeErrorCode } };

export type RepoHygieneExactRangeValidationResultV1 =
  | { ok: true; receipt: RepoHygieneExactRangeReceiptV1 }
  | { ok: false; error: { code: RepoHygieneExactRangeErrorCode } };

function exactRangeFailure(
  code: RepoHygieneExactRangeErrorCode,
): { ok: false; error: { code: RepoHygieneExactRangeErrorCode } } {
  return { ok: false, error: { code } };
}

function strictRecord(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> | null {
  try {
    if (
      typeof value !== 'object'
      || value === null
      || Array.isArray(value)
      || utilTypes.isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype
    ) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string') || keys.length !== expectedKeys.length) return null;
    const sorted = [...keys].sort();
    if (sorted.some((key, index) => key !== [...expectedKeys].sort()[index])) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined
        || !('value' in descriptor)
        || descriptor.enumerable !== true
      ) return null;
    }
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function validateExactRangeInput(value: unknown): RepoHygieneExactRangeInputV1 | null {
  const record = strictRecord(value, ['baseOid', 'remoteOid', 'localOid']);
  if (
    record === null
    || typeof record.baseOid !== 'string'
    || !FULL_OID.test(record.baseOid)
    || (record.remoteOid !== null && (typeof record.remoteOid !== 'string' || !FULL_OID.test(record.remoteOid)))
    || typeof record.localOid !== 'string'
    || !FULL_OID.test(record.localOid)
  ) return null;
  return {
    baseOid: record.baseOid,
    remoteOid: record.remoteOid as string | null,
    localOid: record.localOid,
  };
}

function sha256Bytes(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function sha256Canonical(value: unknown): `sha256:${string}` {
  return sha256Bytes(Buffer.from(canonicalizeBoundaryRun(value), 'utf8'));
}

function readToolBytes(): Buffer {
  const sources = [
    { id: 'scripts/repo-hygiene-guard.ts', bytes: readFileSync(MODULE_PATH) },
    { id: 'scripts/lib/repo-hygiene-policy.ts', bytes: readFileSync(REPO_HYGIENE_POLICY_MODULE_PATH) },
    { id: 'scripts/lib/ci-control/exact-range-provenance.ts', bytes: readFileSync(EXACT_RANGE_PROVENANCE_MODULE_PATH) },
  ];
  const chunks: Buffer[] = [Buffer.from('repo-hygiene-tool-v1\0', 'utf8')];
  for (const source of sources) {
    const id = Buffer.from(source.id, 'utf8');
    chunks.push(
      Buffer.from(`${id.byteLength}:${source.bytes.byteLength}:`, 'ascii'),
      id,
      source.bytes,
    );
  }
  return Buffer.concat(chunks);
}

function repoHygienePolicyProjection(): unknown {
  const project = (patterns: readonly GuardPattern[]) => patterns.map((pattern) => ({
    code: pattern.code,
    message: pattern.message,
    source: pattern.regex.source,
    flags: pattern.regex.flags,
  }));
  return {
    schemaVersion: 1,
    guardCoreDigest: sha256Bytes(readFileSync(GUARD_CORE_MODULE_PATH)),
    addedLinePatterns: project(addedLinePatterns),
    commitMessagePatterns: project(commitMessagePatterns),
    disallowedCommitAuthorPatterns: project(disallowedCommitAuthorPatterns),
    secretPatternCodes: [...secretPatternCodes].sort(),
    fixtureFiles: [...fixtureFiles].sort(),
    selfReferentialAllowlistFiles: [...selfReferentialAllowlistFiles].sort(),
    selfReferentialAllowedCodes: [...selfReferentialAllowedCodes].sort(),
    trackedSensitiveAllowlist: [...trackedSensitiveAllowlist].sort(),
    trackedSensitiveArtifactPatterns: trackedSensitiveArtifactPatterns.map((pattern) => ({
      source: pattern.source,
      flags: pattern.flags,
    })),
    trackedSensitiveArtifactExactPaths: ['.mcp.json'],
    allowedMatchPolicies: {
      allowedEnvVarNameToken: { source: allowedEnvVarNameToken.source, flags: allowedEnvVarNameToken.flags },
      allowedMessagingAddressRhs: { source: allowedMessagingAddressRhs.source, flags: allowedMessagingAddressRhs.flags },
      allowedPhoneFixture: { source: allowedPhoneFixture.source, flags: allowedPhoneFixture.flags },
      allowedTwilioSidFixture: { source: allowedTwilioSidFixture.source, flags: allowedTwilioSidFixture.flags },
      allowedProviderKeyFixture: { source: allowedProviderKeyFixture.source, flags: allowedProviderKeyFixture.flags },
      allowedSecretAssignmentValue: { source: allowedSecretAssignmentValue.source, flags: allowedSecretAssignmentValue.flags },
      documentationEmailFixtureImplementation: isDocumentationEmailFixture.toString(),
      operationalProtocolTokenImplementation: isOperationalProtocolToken.toString(),
      operationalReleaseHygieneFiles: [...operationalReleaseHygieneFiles].sort(),
    },
    sourceConsoleAllowedFiles: [...srcConsoleAllowedFiles].sort(),
    historyPolicy: {
      patterns: [...secretPatternCodes].sort(),
      baselineSuppression: 'range-start-same-path-byte-identical-crlf-line',
      sensitiveArtifacts: true,
    },
    liveRouteCoverage: [...REPO_HYGIENE_POLICY_PROJECTION_COVERAGE],
    liveRouteImplementations: {
      baseLineSets: baseLineSets.toString(),
      childProcessShellTrue: isChildProcessShellTrue.toString(),
      dynamicCodeExecution: isDynamicCodeExecution.toString(),
      findDisallowedMatch: findDisallowedMatch.toString(),
      fixtureFileRouting: isFixtureFile.toString(),
      normalizeRepoPath: normalizeRepoPath.toString(),
      packageLockResolvedUrlException: isPackageLockResolvedUrlLine.toString(),
      patternAllowlistRouting: isAllowedPatternMatch.toString(),
      processEnvInheritance: isProcessEnvInheritance.toString(),
      productionCodePathRouting: isProductionCodePath.toString(),
      scanAddedLines: scanAddedLines.toString(),
      scanCommitAuthors: scanCommitAuthors.toString(),
      scanCommitMessage: scanCommitMessage.toString(),
      secretHistorySubset: secretCauses.toString(),
      sourceConsoleRouting: isSourceConsoleCall.toString(),
      suppressionCommentRouting: isSuppressionComment.toString(),
      suppressionRationaleExpiry: hasSuppressionRationaleAndExpiry.toString(),
      trackedSensitiveArtifactRouting: isTrackedSensitiveArtifact.toString(),
    },
  };
}

export function canonicalRepoHygienePolicyProjection(): string {
  return canonicalizeBoundaryRun(repoHygienePolicyProjection());
}

function policyDigest(): `sha256:${string}` {
  return sha256Bytes(Buffer.from(canonicalRepoHygienePolicyProjection(), 'utf8'));
}

export function currentRepoHygieneToolDigest(): `sha256:${string}` {
  return sha256Bytes(readToolBytes());
}

export function currentRepoHygienePolicyDigest(): `sha256:${string}` {
  return policyDigest();
}

export function repoHygienePolicyProjectionCoverage(): string[] {
  return [...REPO_HYGIENE_POLICY_PROJECTION_COVERAGE];
}

function mapExactRangeError(error: unknown): RepoHygieneExactRangeErrorCode {
  if (error instanceof ExactGitInputError) {
    if (error.code.endsWith('-budget') || error.code.endsWith('.budget')) {
      return 'repo-hygiene.exact-range.budget';
    }
    if (error.code.endsWith('-identity-mismatch') || error.code.endsWith('.identity-mismatch')) {
      return 'repo-hygiene.exact-range.identity-mismatch';
    }
    if (error.code.endsWith('-malformed') || error.code.endsWith('.input-malformed')) {
      return 'repo-hygiene.exact-range.input-malformed';
    }
  }
  return 'repo-hygiene.exact-range.evidence-unavailable';
}

function copyBudget(budget: ExactAddedLineBudgetV1): ExactAddedLineBudgetV1 {
  return {
    changeCount: budget.changeCount,
    sourceBlobBytes: budget.sourceBlobBytes,
    sourceLineCount: budget.sourceLineCount,
    patchBytes: budget.patchBytes,
    addedLineCount: budget.addedLineCount,
    addedTextBytes: budget.addedTextBytes,
  };
}

function budgetAccounting(
  limit: ExactAddedLineBudgetV1,
  remaining: ExactAddedLineBudgetV1,
): ExactAddedLineBudgetAccountingV1 {
  const consumed = {} as ExactAddedLineBudgetV1;
  for (const key of Object.keys(limit) as Array<keyof ExactAddedLineBudgetV1>) {
    consumed[key] = limit[key] - remaining[key];
  }
  return { limit: copyBudget(limit), consumed, remaining: copyBudget(remaining) };
}

interface HistoryLineCandidate {
  cause: string;
  commitOid: string;
  parentOid: string;
  path: string;
  line: number;
  blobOid: string;
  text: string;
}

function secretCauses(line: ExactAddedLineV1): string[] {
  if (isFixtureFile(normalizeRepoPath(line.path))) return [];
  return secretPatterns
    .filter((pattern) => findDisallowedMatch(normalizeRepoPath(line.path), pattern, line.text) !== null)
    .map((pattern) => pattern.code);
}

function baseLineSets(
  cwd: string,
  rangeStartOid: string,
  paths: readonly string[],
): Map<string, Set<string>> {
  if (paths.length > MAX_EXACT_TREE_ENTRY_PATH_COUNT) {
    throw new ExactGitInputError('ci.input.tree-entry-budget', 'ci.input.tree-entry-budget');
  }
  const result = new Map<string, Set<string>>();
  if (paths.length === 0) return result;
  const entries = readExactTreeEntries(cwd, { candidateOid: rangeStartOid, paths });
  const objectOids = entries.entries
    .filter((entry) => entry.presence === 'present')
    .map((entry) => {
      if (entry.objectOid === null || entry.objectType === 'tree' || entry.objectType === 'gitlink') {
        throw new ExactGitInputError('ci.input.tree-entry-malformed', 'ci.input.tree-entry-malformed');
      }
      return entry.objectOid;
    });
  const blobs = new Map(readExactBlobs(cwd, objectOids).map((blob) => [blob.oid, blob]));
  for (const entry of entries.entries) {
    if (entry.presence === 'absent') {
      result.set(entry.path, new Set());
      continue;
    }
    const blob = blobs.get(entry.objectOid!);
    if (blob === undefined || blob.bytes.includes(0)) {
      throw new ExactGitInputError('ci.input.blob-set-malformed', 'ci.input.blob-set-malformed');
    }
    let decoded: string;
    try {
      decoded = UTF8_FATAL.decode(blob.bytes);
    } catch {
      throw new ExactGitInputError('ci.input.added-lines.invalid-utf8', 'ci.input.added-lines.invalid-utf8');
    }
    const rows = decoded === '' ? [] : decoded.split('\n');
    if (decoded.endsWith('\n')) rows.pop();
    result.set(entry.path, new Set(rows.map((row, index) => (
      (index < rows.length - 1 || decoded.endsWith('\n')) && row.endsWith('\r') ? row.slice(0, -1) : row
    ))));
  }
  return result;
}

function compareFindings(
  left: RepoHygieneExactRangeFindingV1,
  right: RepoHygieneExactRangeFindingV1,
): number {
  return [left.cause, left.observationKind, left.commitOid, left.parentOid ?? '', left.path ?? '', String(left.line ?? 0)]
    .join('\0')
    .localeCompare([right.cause, right.observationKind, right.commitOid, right.parentOid ?? '', right.path ?? '', String(right.line ?? 0)].join('\0'));
}

function nativeCauseCodes(): ReadonlySet<string> {
  return new Set([
    ...addedLinePatterns.map((pattern) => pattern.code),
    ...commitMessagePatterns.map((pattern) => pattern.code),
    ...disallowedCommitAuthorPatterns.map((pattern) => pattern.code),
    'src-console-call',
    'process-env-inheritance',
    'child-process-shell-true',
    'dynamic-code-execution',
    'unbounded-suppression',
    'branch-sensitive-artifact',
    'branch-history-sensitive-artifact',
  ]);
}

function appendExactRangeFinding(
  findings: RepoHygieneExactRangeFindingV1[],
  projectedFindingKeys: Set<string>,
  finding: RepoHygieneExactRangeFindingV1,
): void {
  const projectedKey = canonicalizeBoundaryRun(finding);
  if (projectedFindingKeys.has(projectedKey)) return;
  if (findings.length >= MAX_REPO_HYGIENE_EXACT_RANGE_FINDINGS) {
    throw new ExactGitInputError('ci.input.added-lines.budget', 'ci.input.added-lines.budget');
  }
  projectedFindingKeys.add(projectedKey);
  findings.push(finding);
}

function appendRawFindingKey(rawFindingKeys: Set<string>, key: string): boolean {
  if (rawFindingKeys.has(key)) return false;
  if (rawFindingKeys.size >= MAX_REPO_HYGIENE_EXACT_RANGE_FINDINGS) {
    throw new ExactGitInputError('ci.input.added-lines.budget', 'ci.input.added-lines.budget');
  }
  rawFindingKeys.add(key);
  return true;
}

function scanNetAddedLineFindingsIncrementally(
  changes: readonly ExactChangeWithAddedLinesV1[],
  commitOid: string,
  parentOid: string,
  findings: RepoHygieneExactRangeFindingV1[],
  projectedFindingKeys: Set<string>,
  rawFindingKeys: Set<string>,
): void {
  for (const change of changes) {
    for (const exactLine of change.addedLines) {
      for (const issue of scanAddedLines([{
        filePath: exactLine.path,
        line: exactLine.newLineNumber,
        text: exactLine.text,
      }])) {
        const finding: RepoHygieneExactRangeFindingV1 = {
          cause: issue.code,
          observationKind: 'net-added-line',
          commitOid,
          parentOid,
          path: null,
          pathDisclosure: issue.filePath === undefined ? 'not-applicable' : 'redacted',
          line: issue.line ?? null,
          blobOid: issue.filePath === exactLine.path && issue.line === exactLine.newLineNumber
            ? exactLine.newBlobOid
            : null,
        };
        appendExactRangeFinding(findings, projectedFindingKeys, finding);
        appendRawFindingKey(
          rawFindingKeys,
          `${finding.cause}\0${issue.filePath ?? ''}\0${finding.line ?? 0}`,
        );
      }
    }
  }
}

function appendHistoryLineCandidate(
  historyLines: HistoryLineCandidate[],
  historyArtifactCount: number,
  candidate: HistoryLineCandidate,
): void {
  if (historyLines.length + historyArtifactCount >= MAX_REPO_HYGIENE_EXACT_RANGE_FINDINGS) {
    throw new ExactGitInputError('ci.input.added-lines.budget', 'ci.input.added-lines.budget');
  }
  historyLines.push(candidate);
}

function appendHistoryArtifactCandidate(
  historyArtifacts: Array<{
    rawPath: string;
    finding: RepoHygieneExactRangeFindingV1;
  }>,
  historyLineCount: number,
  candidate: {
    rawPath: string;
    finding: RepoHygieneExactRangeFindingV1;
  },
): void {
  if (historyArtifacts.length + historyLineCount >= MAX_REPO_HYGIENE_EXACT_RANGE_FINDINGS) {
    throw new ExactGitInputError('ci.input.added-lines.budget', 'ci.input.added-lines.budget');
  }
  historyArtifacts.push(candidate);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || ArrayBuffer.isView(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}

export function createRepoHygieneExactRangeArtifact(
  cwd: string,
  input: RepoHygieneExactRangeInputV1,
): RepoHygieneExactRangeBuildResultV1 {
  const validated = validateExactRangeInput(input);
  if (validated === null) return exactRangeFailure('repo-hygiene.exact-range.input-malformed');

  try {
    const initialToolBytes = readToolBytes();
    const initialPolicyDigest = policyDigest();
    const range = readExactCommitRange(cwd, validated);
    const metadataByOid = new Map(
      readExactCommitMetadata(cwd, range.commits.map((commit) => commit.oid).sort())
        .map((metadata) => [metadata.oid, metadata]),
    );
    const commitBindings: RepoHygieneExactRangeCommitBindingV1[] = [];
    for (const commit of range.commits) {
      const metadata = metadataByOid.get(commit.oid);
      if (
        metadata === undefined
        || metadata.parentOids.length !== commit.parentOids.length
        || metadata.parentOids.some((parentOid, index) => parentOid !== commit.parentOids[index])
      ) {
        return exactRangeFailure('repo-hygiene.exact-range.identity-mismatch');
      }
      commitBindings.push({
        oid: commit.oid,
        parentOids: [...commit.parentOids],
        treeOid: metadata.treeOid,
        metadataSha256: metadata.contentSha256,
      });
    }

    const limit = copyBudget(MAX_EXACT_ADDED_LINE_BUDGET_V1);
    let remaining = copyBudget(limit);
    const observedPaths = new Set<string>();
    const observedBlobOids = new Set<string>();
    let totalChangeCount = 0;
    let parentEdgeCount = 0;
    const findings: RepoHygieneExactRangeFindingV1[] = [];
    const projectedFindingKeys = new Set<string>();
    const finalArtifactPaths = new Set<string>();
    const rawFindingKeys = new Set<string>();

    const net = readExactAddedLinesWithinBudget(cwd, {
      baseOid: range.rangeStartOid,
      candidateOid: range.localOid,
      budget: remaining,
    });
    remaining = copyBudget(net.accounting.remaining);
    totalChangeCount += net.changes.length;
    for (const change of net.changes) {
      observedPaths.add(change.path);
      if (change.oldPath !== null) observedPaths.add(change.oldPath);
      if (change.oldOid !== '0'.repeat(40)) observedBlobOids.add(change.oldOid);
      if (change.newOid !== '0'.repeat(40)) observedBlobOids.add(change.newOid);
      if (change.status !== 'deleted' && isTrackedSensitiveArtifact(change.path)) {
        finalArtifactPaths.add(change.path);
        const finding: RepoHygieneExactRangeFindingV1 = {
          cause: 'branch-sensitive-artifact',
          observationKind: 'net-sensitive-artifact',
          commitOid: range.localOid,
          parentOid: range.rangeStartOid,
          path: null,
          pathDisclosure: 'redacted',
          line: null,
          blobOid: change.newOid === '0'.repeat(40) ? null : change.newOid,
        };
        appendExactRangeFinding(findings, projectedFindingKeys, finding);
        appendRawFindingKey(
          rawFindingKeys,
          `${finding.cause}\0${change.path}\0${finding.line ?? 0}`,
        );
      }
    }
    scanNetAddedLineFindingsIncrementally(
      net.changes,
      range.localOid,
      range.rangeStartOid,
      findings,
      projectedFindingKeys,
      rawFindingKeys,
    );

    const historyLines: HistoryLineCandidate[] = [];
    const historyArtifacts: Array<{
      rawPath: string;
      finding: RepoHygieneExactRangeFindingV1;
    }> = [];
    for (const commit of range.commits) {
      for (const parentOid of commit.parentOids) {
        parentEdgeCount += 1;
        const edge = readExactAddedLinesWithinBudget(cwd, {
          baseOid: parentOid,
          candidateOid: commit.oid,
          budget: remaining,
        });
        remaining = copyBudget(edge.accounting.remaining);
        totalChangeCount += edge.changes.length;
        for (const change of edge.changes) {
          observedPaths.add(change.path);
          if (change.oldPath !== null) observedPaths.add(change.oldPath);
          if (change.oldOid !== '0'.repeat(40)) observedBlobOids.add(change.oldOid);
          if (change.newOid !== '0'.repeat(40)) observedBlobOids.add(change.newOid);
          for (const line of change.addedLines) {
            for (const cause of secretCauses(line)) {
              appendHistoryLineCandidate(historyLines, historyArtifacts.length, {
                cause,
                commitOid: commit.oid,
                parentOid,
                path: line.path,
                line: line.newLineNumber,
                blobOid: line.newBlobOid,
                text: line.text,
              });
            }
          }
          if (
            change.status !== 'deleted'
            && isTrackedSensitiveArtifact(change.path)
            && !finalArtifactPaths.has(change.path)
          ) {
            appendHistoryArtifactCandidate(historyArtifacts, historyLines.length, {
              rawPath: change.path,
              finding: {
                cause: 'branch-history-sensitive-artifact',
                observationKind: 'history-sensitive-artifact',
                commitOid: commit.oid,
                parentOid,
                path: null,
                pathDisclosure: 'redacted',
                line: null,
                blobOid: change.newOid === '0'.repeat(40) ? null : change.newOid,
              },
            });
          }
        }
      }
    }

    const baselinePaths = [...new Set(historyLines.map((candidate) => candidate.path))].sort();
    const baselines = baseLineSets(cwd, range.rangeStartOid, baselinePaths);
    for (const candidate of historyLines) {
      if (baselines.get(candidate.path)?.has(candidate.text)) continue;
      const key = `${candidate.cause}\0${candidate.path}\0${candidate.line}`;
      if (!appendRawFindingKey(rawFindingKeys, key)) continue;
      appendExactRangeFinding(findings, projectedFindingKeys, {
        cause: candidate.cause,
        observationKind: 'history-added-line',
        commitOid: candidate.commitOid,
        parentOid: candidate.parentOid,
        path: null,
        pathDisclosure: 'redacted',
        line: candidate.line,
        blobOid: candidate.blobOid,
      });
    }
    for (const { rawPath, finding } of historyArtifacts) {
      const key = `${finding.cause}\0${rawPath}\0${finding.line ?? 0}`;
      if (!appendRawFindingKey(rawFindingKeys, key)) continue;
      appendExactRangeFinding(findings, projectedFindingKeys, finding);
    }

    for (const commit of range.commits) {
      const metadata = metadataByOid.get(commit.oid)!;
      for (const issue of scanCommitAuthors([{
        sha: commit.oid,
        name: metadata.authorName,
        email: metadata.authorEmail,
        subject: metadata.subject,
        message: metadata.message,
      }])) {
        appendExactRangeFinding(findings, projectedFindingKeys, {
          cause: issue.code,
          observationKind: 'commit-metadata',
          commitOid: commit.oid,
          parentOid: null,
          path: null,
          pathDisclosure: 'not-applicable',
          line: issue.line ?? null,
          blobOid: null,
        });
      }
    }
    if (findings.length > MAX_REPO_HYGIENE_EXACT_RANGE_FINDINGS) {
      return exactRangeFailure('repo-hygiene.exact-range.budget');
    }
    findings.sort(compareFindings);

    const terminalToolBytes = readToolBytes();
    if (!initialToolBytes.equals(terminalToolBytes)) {
      return exactRangeFailure('repo-hygiene.exact-range.tool-drift');
    }
    const terminalPolicyDigest = policyDigest();
    if (terminalPolicyDigest !== initialPolicyDigest) {
      return exactRangeFailure('repo-hygiene.exact-range.policy-drift');
    }
    const created = Date.now();
    const nativeCauses = [...new Set(findings.map((finding) => finding.cause))].sort();
    const payload: RepoHygieneExactRangeReceiptV1 = {
      schemaVersion: 1,
      detectorId: REPO_HYGIENE_EXACT_RANGE_DETECTOR,
      decisionOwner: REPO_HYGIENE_EXACT_RANGE_OWNER,
      authorization: 'report-only',
      outcome: findings.length === 0 ? 'pass' : 'block',
      exitCode: findings.length === 0 ? 0 : 1,
      completeness: 'complete',
      baseOid: range.baseOid,
      remoteOid: range.remoteOid,
      rangeStartOid: range.rangeStartOid,
      localOid: range.localOid,
      toolDigest: sha256Bytes(initialToolBytes),
      policyDigest: initialPolicyDigest,
      commitBindings,
      commitRangeDigest: sha256Canonical(range),
      metadataDigest: sha256Canonical(commitBindings),
      observedPathDisclosure: 'all-redacted',
      observedPathDigest: sha256Canonical({
        schemaVersion: 1,
        disclosure: 'all-redacted',
        count: observedPaths.size,
      }),
      observedBlobOidDigest: sha256Canonical([...observedBlobOids].sort()),
      budget: budgetAccounting(limit, remaining),
      claimedScope: {
        content: 'net-range-all-rules',
        history: 'per-parent-secret-and-sensitive-artifact',
        metadata: 'all-ordered-outgoing-commits',
      },
      observedScope: {
        commitCount: range.commits.length,
        parentEdgeCount,
        changeCount: totalChangeCount,
        observedPathCount: observedPaths.size,
      },
      nativeCauses,
      findings,
      limitations: [...REPO_HYGIENE_EXACT_RANGE_LIMITATIONS],
      createdAt: new Date(created).toISOString(),
      validUntil: new Date(created + REPO_HYGIENE_EXACT_RANGE_VALIDITY_MS).toISOString(),
    };
    const serialized = canonicalizeBoundaryRun(payload);
    const payloadBytes = Uint8Array.from(Buffer.from(serialized, 'utf8'));
    const binding: RepoHygieneExactRangeArtifactV1['binding'] = {
      schemaVersion: 1 as const,
      detectorId: REPO_HYGIENE_EXACT_RANGE_DETECTOR,
      payloadByteLength: payloadBytes.byteLength,
      payloadSha256: sha256Bytes(payloadBytes),
    };
    return {
      ok: true,
      artifact: {
        payloadBytes: Uint8Array.from(payloadBytes),
        binding: Object.freeze({ ...binding }),
      },
    };
  } catch (error) {
    return exactRangeFailure(mapExactRangeError(error));
  }
}

function strictArray(value: unknown, maxLength: number): unknown[] | null {
  try {
    if (
      !Array.isArray(value)
      || utilTypes.isProxy(value)
      || Object.getPrototypeOf(value) !== Array.prototype
      || value.length > maxLength
    ) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || !keys.includes('length')) return null;
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) return null;
    }
    return value;
  } catch {
    return null;
  }
}

function safeInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && !Object.is(value, -0)
    && value >= 0
    && value <= max;
}

function validateBudgetRecord(value: unknown): ExactAddedLineBudgetV1 | null {
  const keys: Array<keyof ExactAddedLineBudgetV1> = [
    'changeCount',
    'sourceBlobBytes',
    'sourceLineCount',
    'patchBytes',
    'addedLineCount',
    'addedTextBytes',
  ];
  const record = strictRecord(value, keys);
  if (record === null) return null;
  const result = {} as ExactAddedLineBudgetV1;
  for (const key of keys) {
    if (!safeInteger(record[key], MAX_EXACT_ADDED_LINE_BUDGET_V1[key])) return null;
    result[key] = record[key];
  }
  return result;
}

function validateBudgetAccounting(value: unknown): ExactAddedLineBudgetAccountingV1 | null {
  const record = strictRecord(value, ['limit', 'consumed', 'remaining']);
  if (record === null) return null;
  const limit = validateBudgetRecord(record.limit);
  const consumed = validateBudgetRecord(record.consumed);
  const remaining = validateBudgetRecord(record.remaining);
  if (limit === null || consumed === null || remaining === null) return null;
  for (const key of Object.keys(limit) as Array<keyof ExactAddedLineBudgetV1>) {
    if (
      limit[key] !== MAX_EXACT_ADDED_LINE_BUDGET_V1[key]
      || consumed[key] + remaining[key] !== limit[key]
    ) return null;
  }
  return { limit, consumed, remaining };
}

function validateStringArray(value: unknown, maxLength: number): string[] | null {
  const array = strictArray(value, maxLength);
  if (array === null || array.some((item) => typeof item !== 'string')) return null;
  const strings = array as string[];
  if (strings.some((item, index) => index > 0 && strings[index - 1]! >= item)) return null;
  return strings;
}

function validateCommitBindings(value: unknown): RepoHygieneExactRangeCommitBindingV1[] | null {
  const array = strictArray(value, 4_096);
  if (array === null) return null;
  const result: RepoHygieneExactRangeCommitBindingV1[] = [];
  const seen = new Set<string>();
  for (const item of array) {
    const record = strictRecord(item, ['oid', 'parentOids', 'treeOid', 'metadataSha256']);
    const parents = record === null ? null : strictArray(record.parentOids, 8_192);
    if (
      record === null
      || typeof record.oid !== 'string'
      || !FULL_OID.test(record.oid)
      || seen.has(record.oid)
      || typeof record.treeOid !== 'string'
      || !FULL_OID.test(record.treeOid)
      || typeof record.metadataSha256 !== 'string'
      || !SHA256.test(record.metadataSha256)
      || parents === null
      || parents.some((parent) => typeof parent !== 'string' || !FULL_OID.test(parent))
      || new Set(parents as string[]).size !== parents.length
    ) return null;
    seen.add(record.oid);
    result.push({
      oid: record.oid,
      parentOids: [...parents] as string[],
      treeOid: record.treeOid,
      metadataSha256: record.metadataSha256 as `sha256:${string}`,
    });
  }
  return result;
}

function validateFindings(value: unknown): RepoHygieneExactRangeFindingV1[] | null {
  const array = strictArray(value, MAX_REPO_HYGIENE_EXACT_RANGE_FINDINGS);
  if (array === null) return null;
  const kinds = new Set([
    'net-added-line',
    'net-sensitive-artifact',
    'history-added-line',
    'history-sensitive-artifact',
    'commit-metadata',
  ]);
  const result: RepoHygieneExactRangeFindingV1[] = [];
  for (const item of array) {
    const record = strictRecord(item, [
      'cause', 'observationKind', 'commitOid', 'parentOid', 'path', 'pathDisclosure', 'line', 'blobOid',
    ]);
    if (
      record === null
      || typeof record.cause !== 'string'
      || record.cause.length === 0
      || record.cause.length > 128
      || !nativeCauseCodes().has(record.cause)
      || typeof record.observationKind !== 'string'
      || !kinds.has(record.observationKind)
      || typeof record.commitOid !== 'string'
      || !FULL_OID.test(record.commitOid)
      || (record.parentOid !== null && (typeof record.parentOid !== 'string' || !FULL_OID.test(record.parentOid)))
      || record.path !== null
      || (record.pathDisclosure !== 'redacted' && record.pathDisclosure !== 'not-applicable')
      || (record.line !== null && (!safeInteger(record.line) || record.line < 1))
      || (record.blobOid !== null && (typeof record.blobOid !== 'string' || !FULL_OID.test(record.blobOid)))
    ) return null;
    result.push(record as unknown as RepoHygieneExactRangeFindingV1);
  }
  const sorted = [...result].sort(compareFindings);
  if (result.some((finding, index) => compareFindings(finding, sorted[index]!) !== 0)) return null;
  return result;
}

function validateExactRangeReceipt(value: unknown): RepoHygieneExactRangeReceiptV1 | null {
  const record = strictRecord(value, [
    'schemaVersion', 'detectorId', 'decisionOwner', 'authorization', 'outcome', 'exitCode',
    'completeness', 'baseOid', 'remoteOid', 'rangeStartOid', 'localOid', 'toolDigest',
    'policyDigest', 'commitBindings', 'commitRangeDigest', 'metadataDigest',
    'observedPathDisclosure', 'observedPathDigest', 'observedBlobOidDigest', 'budget', 'claimedScope', 'observedScope',
    'nativeCauses', 'findings', 'limitations', 'createdAt', 'validUntil',
  ]);
  if (record === null) return null;
  const commitBindings = validateCommitBindings(record.commitBindings);
  const findings = validateFindings(record.findings);
  const nativeCauses = validateStringArray(record.nativeCauses, MAX_REPO_HYGIENE_EXACT_RANGE_FINDINGS);
  const budget = validateBudgetAccounting(record.budget);
  const claimedScope = strictRecord(record.claimedScope, ['content', 'history', 'metadata']);
  const observedScope = strictRecord(record.observedScope, [
    'commitCount', 'parentEdgeCount', 'changeCount', 'observedPathCount',
  ]);
  const limitations = strictArray(
    record.limitations,
    REPO_HYGIENE_EXACT_RANGE_LIMITATIONS.length,
  );
  if (
    record.schemaVersion !== 1
    || record.detectorId !== REPO_HYGIENE_EXACT_RANGE_DETECTOR
    || record.decisionOwner !== REPO_HYGIENE_EXACT_RANGE_OWNER
    || record.authorization !== 'report-only'
    || (record.outcome !== 'pass' && record.outcome !== 'block')
    || (record.exitCode !== 0 && record.exitCode !== 1)
    || (record.outcome === 'pass') !== (record.exitCode === 0)
    || record.completeness !== 'complete'
    || typeof record.baseOid !== 'string'
    || !FULL_OID.test(record.baseOid)
    || (record.remoteOid !== null && (typeof record.remoteOid !== 'string' || !FULL_OID.test(record.remoteOid)))
    || typeof record.rangeStartOid !== 'string'
    || !FULL_OID.test(record.rangeStartOid)
    || record.rangeStartOid !== (record.remoteOid ?? record.baseOid)
    || typeof record.localOid !== 'string'
    || !FULL_OID.test(record.localOid)
    || typeof record.toolDigest !== 'string'
    || !SHA256.test(record.toolDigest)
    || typeof record.policyDigest !== 'string'
    || !SHA256.test(record.policyDigest)
    || typeof record.commitRangeDigest !== 'string'
    || !SHA256.test(record.commitRangeDigest)
    || typeof record.metadataDigest !== 'string'
    || !SHA256.test(record.metadataDigest)
    || record.observedPathDisclosure !== 'all-redacted'
    || typeof record.observedPathDigest !== 'string'
    || !SHA256.test(record.observedPathDigest)
    || typeof record.observedBlobOidDigest !== 'string'
    || !SHA256.test(record.observedBlobOidDigest)
    || commitBindings === null
    || findings === null
    || nativeCauses === null
    || budget === null
    || claimedScope === null
    || claimedScope.content !== 'net-range-all-rules'
    || claimedScope.history !== 'per-parent-secret-and-sensitive-artifact'
    || claimedScope.metadata !== 'all-ordered-outgoing-commits'
    || observedScope === null
    || !safeInteger(observedScope.commitCount, 4_096)
    || !safeInteger(observedScope.parentEdgeCount, 8_192)
    || !safeInteger(observedScope.changeCount, MAX_EXACT_ADDED_LINE_BUDGET_V1.changeCount)
    || !safeInteger(observedScope.observedPathCount, MAX_EXACT_ADDED_LINE_BUDGET_V1.changeCount * 2)
    || observedScope.commitCount !== commitBindings.length
    || limitations === null
    || limitations.length !== REPO_HYGIENE_EXACT_RANGE_LIMITATIONS.length
    || limitations.some((limitation, index) => limitation !== REPO_HYGIENE_EXACT_RANGE_LIMITATIONS[index])
    || typeof record.createdAt !== 'string'
    || typeof record.validUntil !== 'string'
  ) return null;
  if (record.observedPathDigest !== sha256Canonical({
    schemaVersion: 1,
    disclosure: 'all-redacted',
    count: observedScope.observedPathCount,
  })) return null;
  const causes = [...new Set(findings.map((finding) => finding.cause))].sort();
  if (
    nativeCauses.length !== causes.length
    || nativeCauses.some((cause, index) => cause !== causes[index])
    || (findings.length === 0) !== (record.outcome === 'pass')
    || observedScope.changeCount !== budget.consumed.changeCount
    || observedScope.parentEdgeCount !== commitBindings.reduce(
      (total, binding) => total + binding.parentOids.length,
      0,
    )
  ) return null;
  if (
    (commitBindings.length === 0 && record.localOid !== record.rangeStartOid)
    || (commitBindings.length > 0 && commitBindings.at(-1)?.oid !== record.localOid)
    || commitBindings.some((binding) => binding.parentOids.length === 0)
  ) return null;
  const commitIndexes = new Map(commitBindings.map((binding, index) => [binding.oid, index]));
  if (commitBindings.some((binding, index) => binding.parentOids.some((parentOid) => {
    const parentIndex = commitIndexes.get(parentOid);
    return parentIndex !== undefined && parentIndex >= index;
  }))) return null;
  const bindingByOid = new Map(commitBindings.map((binding) => [binding.oid, binding]));
  const findingKeys = new Set<string>();
  for (const finding of findings) {
    const key = canonicalizeBoundaryRun(finding);
    if (findingKeys.has(key)) return null;
    findingKeys.add(key);
    if (finding.observationKind === 'commit-metadata') {
      if (
        !bindingByOid.has(finding.commitOid)
        || finding.parentOid !== null
        || finding.path !== null
        || finding.pathDisclosure !== 'not-applicable'
        || finding.blobOid !== null
      ) return null;
      continue;
    }
    if (finding.path !== null || finding.pathDisclosure !== 'redacted') return null;
    if (finding.observationKind.startsWith('net-')) {
      if (finding.commitOid !== record.localOid || finding.parentOid !== record.rangeStartOid) return null;
    } else {
      const binding = bindingByOid.get(finding.commitOid);
      if (binding === undefined || finding.parentOid === null || !binding.parentOids.includes(finding.parentOid)) {
        return null;
      }
    }
    const addedLine = finding.observationKind.endsWith('added-line');
    if (addedLine && (finding.line === null || finding.blobOid === null)) return null;
    if (!addedLine && finding.line !== null) return null;
  }
  const reconstructedRange = {
    baseOid: record.baseOid,
    remoteOid: record.remoteOid,
    rangeStartOid: record.rangeStartOid,
    localOid: record.localOid,
    commits: commitBindings.map((binding) => ({
      oid: binding.oid,
      parentOids: binding.parentOids,
      firstParentOid: binding.parentOids[0],
    })),
  };
  if (sha256Canonical(reconstructedRange) !== record.commitRangeDigest) return null;
  if (sha256Canonical(commitBindings) !== record.metadataDigest) return null;
  const created = Date.parse(record.createdAt);
  const validUntil = Date.parse(record.validUntil);
  if (
    !Number.isSafeInteger(created)
    || !Number.isSafeInteger(validUntil)
    || validUntil - created !== REPO_HYGIENE_EXACT_RANGE_VALIDITY_MS
    || new Date(created).toISOString() !== record.createdAt
    || new Date(validUntil).toISOString() !== record.validUntil
  ) return null;
  return record as unknown as RepoHygieneExactRangeReceiptV1;
}

export function validateRepoHygieneExactRangeArtifact(
  artifact: RepoHygieneExactRangeArtifactV1,
  expected: RepoHygieneExactRangeExpectedV1,
): RepoHygieneExactRangeValidationResultV1 {
  try {
    const artifactRecord = strictRecord(artifact, ['payloadBytes', 'binding']);
    const expectedRecord = strictRecord(expected, [
      'baseOid', 'remoteOid', 'localOid', 'currentToolDigest', 'currentPolicyDigest',
      'expectedPayloadByteLength', 'expectedPayloadSha256',
    ]);
    const expectedLineage = expectedRecord === null ? null : validateExactRangeInput({
      baseOid: expectedRecord.baseOid,
      remoteOid: expectedRecord.remoteOid,
      localOid: expectedRecord.localOid,
    });
    const binding = artifactRecord === null
      ? null
      : strictRecord(artifactRecord.binding, [
        'schemaVersion', 'detectorId', 'payloadByteLength', 'payloadSha256',
      ]);
    const bytes = artifactRecord?.payloadBytes;
    const provenance = expectedRecord === null
      ? 'receipt-invalid'
      : validateExactRangeProvenance(
        expectedRecord.currentToolDigest,
        expectedRecord.currentPolicyDigest,
        currentRepoHygieneToolDigest(),
        currentRepoHygienePolicyDigest(),
      );
    if (
      artifactRecord === null
      || expectedRecord === null
      || expectedLineage === null
      || !safeInteger(expectedRecord.expectedPayloadByteLength, 4 * 1024 * 1024)
      || typeof expectedRecord.expectedPayloadSha256 !== 'string'
      || !SHA256.test(expectedRecord.expectedPayloadSha256)
      || binding === null
      || binding.schemaVersion !== 1
      || binding.detectorId !== REPO_HYGIENE_EXACT_RANGE_DETECTOR
      || !safeInteger(binding.payloadByteLength, 4 * 1024 * 1024)
      || typeof binding.payloadSha256 !== 'string'
      || !SHA256.test(binding.payloadSha256)
    ) return exactRangeFailure('repo-hygiene.exact-range.receipt-invalid');
    if (provenance !== 'valid') {
      return exactRangeFailure(`repo-hygiene.exact-range.${provenance}`);
    }
    if (
      binding.payloadByteLength !== expectedRecord.expectedPayloadByteLength
      || binding.payloadSha256 !== expectedRecord.expectedPayloadSha256
    ) return exactRangeFailure('repo-hygiene.exact-range.receipt-binding-mismatch');
    if (
      !(bytes instanceof Uint8Array)
      || utilTypes.isProxy(bytes)
      || bytes.byteLength !== binding.payloadByteLength
      || bytes.byteLength === 0
      || sha256Bytes(bytes) !== binding.payloadSha256
    ) return exactRangeFailure('repo-hygiene.exact-range.receipt-invalid');

    const parsed = parseBoundaryJsonBytes(bytes);
    if (!parsed.result.ok || parsed.value === null || parsed.text === null) {
      return exactRangeFailure('repo-hygiene.exact-range.receipt-invalid');
    }
    if (parsed.text !== canonicalizeBoundaryRun(parsed.value)) {
      return exactRangeFailure('repo-hygiene.exact-range.receipt-invalid');
    }
    const receipt = validateExactRangeReceipt(parsed.value);
    if (receipt === null) return exactRangeFailure('repo-hygiene.exact-range.receipt-invalid');
    if (
      receipt.baseOid !== expectedLineage.baseOid
      || receipt.remoteOid !== expectedLineage.remoteOid
      || receipt.localOid !== expectedLineage.localOid
    ) return exactRangeFailure('repo-hygiene.exact-range.identity-mismatch');
    if (receipt.toolDigest !== expectedRecord.currentToolDigest) {
      return exactRangeFailure('repo-hygiene.exact-range.tool-mismatch');
    }
    if (receipt.policyDigest !== expectedRecord.currentPolicyDigest) {
      return exactRangeFailure('repo-hygiene.exact-range.policy-mismatch');
    }
    const now = Date.now();
    if (now < Date.parse(receipt.createdAt) || now > Date.parse(receipt.validUntil)) {
      return exactRangeFailure('repo-hygiene.exact-range.receipt-stale');
    }
    return { ok: true, receipt: deepFreeze(receipt) };
  } catch {
    return exactRangeFailure('repo-hygiene.exact-range.receipt-invalid');
  }
}

function printIssues(issues: GuardIssue[]): void {
  for (const issue of issues) {
    const location = issue.filePath
      ? `${issue.filePath}:${issue.line ?? 1}`
      : `commit-msg:${issue.line ?? 1}`;
    console.error(`${location} ${issue.code}: ${issue.message}`);
  }
}

function printHelp(): void {
  console.log(`Usage: npm run guard:repo -- [--staged]
       npm run guard:repo -- --branch-diff [--base <ref>]
       npm run guard:repo -- --release-hygiene
       npm run guard:repo -- --commit-authors
       npm run guard:repo:commit-msg -- <message-file>

Modes:
  --staged              Scan staged added lines. This is the default.
  --branch-diff         Scan added lines from merge-base(base, HEAD)..HEAD.
  --base <ref>          Base ref for --branch-diff (default: origin/<GITHUB_BASE_REF>,
                        then origin/main, then branch upstream).
  --release-hygiene     Scan tracked release-hygiene files.
  --commit-authors      Scan commits in the branch/PR range for placeholder authors
                        and public commit-message hygiene violations.
  --scan-history [N]    Advisory: scan added lines of the last N commits (default 50)
                        for leaked secret shapes. Report-only; exit code stays 0.
  --commit-msg <file>   Scan a commit message file.
  --help                Show this help.

By default, this guard is changed-content only. Use --release-hygiene for the release-hygiene file gate.`);
}

export function run(argv: string[] = process.argv.slice(2), cwd: string = process.cwd()): GuardIssue[] {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return [];
  }

  if (args.mode === 'scan-history') {
    const depth = args.historyDepth ?? 50;
    // Advisory-only: a git failure (e.g. shallow clone with no history) must NOT
    // fail the build, so we never let the throw reach the top-level exit-1 handler.
    let historyIssues: GuardIssue[];
    try {
      historyIssues = scanCommitHistory(cwd, depth);
    } catch (err) {
      console.error(
        `repo hygiene history scan (advisory): skipped — ${(err as Error).message}`,
      );
      return [];
    }
    if (historyIssues.length > 0) {
      printIssues(historyIssues);
      console.error(
        `repo hygiene history scan (advisory): ${historyIssues.length} secret-shaped finding(s) in last ${depth} commits`,
      );
    } else {
      console.log(`repo hygiene history scan (advisory): no secret shapes in last ${depth} commits`);
    }
    return historyIssues;
  }

  const issues = args.mode === 'commit-msg'
    ? scanCommitMessage(readFileSync(args.messageFile ?? '', 'utf8'))
    : args.mode === 'release-hygiene'
      ? scanTrackedFiles(cwd)
      : args.mode === 'commit-authors'
        ? scanCommitAuthors(readCommitAuthors(cwd))
        : args.mode === 'branch-diff'
          ? scanBranchDiff(cwd, args.baseRef)
          : [
              ...scanStagedSensitiveArtifacts(cwd),
              ...scanAddedLines(parseUnifiedDiffAddedLines(stagedDiff(cwd))),
            ];

  if (issues.length > 0) {
    printIssues(issues);
    process.exitCode = 1;
  } else {
    console.log('repo hygiene guard passed');
  }

  return issues;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    run();
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}
