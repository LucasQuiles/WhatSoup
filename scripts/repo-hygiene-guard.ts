import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { git, normalizeRepoPath } from './lib/guard-core.ts';

export { normalizeRepoPath } from './lib/guard-core.ts';

export type GuardMode = 'staged' | 'commit-msg' | 'release-hygiene' | 'commit-authors';

export interface ParsedArgs {
  mode: GuardMode;
  messageFile?: string;
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
}

interface GuardPattern {
  code: string;
  message: string;
  regex: RegExp;
}

const fixtureFiles = new Set([
  'scripts/anonymize-private-literals.ts',
  'scripts/repo-hygiene-guard.ts',
  'tests/scripts/anonymize-private-literals.test.ts',
  'tests/scripts/repo-hygiene-guard.test.ts',
]);

const releaseHygieneFiles = [
  'scripts/cutover.sh',
  'scripts/migrate-namespace.sh',
  'scripts/soak-check.sh',
  'src/runtimes/agent/providers/child-env.ts',
  'src/transport/contract/capabilities.ts',
];

const operationalReleaseHygieneFiles = new Set([
  'scripts/cutover.sh',
  'scripts/migrate-namespace.sh',
  'scripts/soak-check.sh',
]);

const allowedEnvVarNameToken = /^[A-Z][A-Z0-9_]+_(?:MUTATIONS|TOKEN|KEY|URL|PATH)$/;
const allowedMessagingAddressRhs = /@(?:s\.whatsapp\.net|c\.us|lid)$/i;

const operationalProtocolIdentifiers = new Set([
  'whatsapp-bot@personal',
  'whatsapp-bot@loops',
  'whatsapp-bot@besbot',
  'whatsoup@q',
  'whatsoup@loops',
  'whatsoup@besbot',
  'whatsoup@personal',
  'whatsoup-personal',
  'instances/personal/whatsoup.sock',
]);

const trackedSensitiveAllowlist = new Set(['.env.example', '.claude/settings.json']);

const disallowedCommitAuthorPatterns: GuardPattern[] = [
  {
    code: 'placeholder-commit-author',
    message: 'Commit author uses a placeholder identity; amend before publishing.',
    regex: /\b(?:whatsoup-test|test|example)\.invalid\b/i,
  },
  {
    code: 'placeholder-commit-author',
    message: 'Commit author uses a placeholder identity; amend before publishing.',
    regex: /\bWhatSoup Test\b/i,
  },
];

function isAllowedPatternMatch(filePath: string, code: string, token: string): boolean {
  if (allowedEnvVarNameToken.test(token)) return true;
  if (code === 'personal-email' && allowedMessagingAddressRhs.test(token)) return true;
  return code === 'private-instance-label'
    && operationalReleaseHygieneFiles.has(filePath)
    && operationalProtocolIdentifiers.has(token);
}

const srcConsoleAllowedFiles = new Set([
  'src/bootstrap.ts',
  'src/bootstrap-auth.ts',
  'src/config.ts',
  'src/fleet/standalone.ts',
  'src/transport/auth.ts',
]);

const addedLinePatterns: GuardPattern[] = [
  {
    code: 'merge-conflict-marker',
    message: 'Line looks like an unresolved merge conflict marker.',
    regex: /^\s*(?:<{7}|>{7}|={7})/,
  },
  {
    code: 'focused-test',
    message: 'Focused tests must not be committed.',
    regex: /\b(?:describe|it|test)\.only(?:\s*\(|\.)/,
  },
  {
    code: 'skipped-test',
    message: 'Skipped tests must not be committed without an explicit tracked exception.',
    regex: /\b(?:describe|it|test)\.skip(?:\s*\(|\.)/,
  },
  {
    code: 'debugger-statement',
    message: 'debugger statements must not be committed.',
    regex: /\bdebugger\b/,
  },
  {
    code: 'model-attribution',
    message: 'Public repo text must not include model or generated-by attribution.',
    regex: /\b(?:Claude\s+(?:Code|Opus|Sonnet|Haiku)|Generated\s+(?:with|by)\s+(?:Claude|Codex|GPT)|Authored\s+(?:with|by)\s+(?:Claude|Codex|GPT)|Written\s+(?:with|by)\s+(?:Claude|Codex|GPT)|noreply@anthropic\.com)\b/i,
  },
  {
    code: 'internal-workstream-label',
    message: 'Public repo text must not include internal planning labels.',
    regex: /\b(?:Phase\s+\d|WS-\d|B-\d|P1-[A-Z]|FF-\d{3}|TW-|typed-walrus|planprompt)\b/i,
  },
  {
    code: 'personal-email',
    message: 'Public repo text must not include personal email addresses.',
    regex: /\b[A-Z0-9._%+-]+@(?!(?:users\.noreply\.github\.com|github\.com|s\.whatsapp\.net|g\.us)\b)[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  },
  {
    code: 'local-home-path',
    message: 'Public repo text must not include operator-local home paths.',
    regex: /\/(?:Users|home)\/(?!runner(?:\/|$)|testuser(?:\/|$)|whatsoup(?:\/|$))[A-Za-z0-9._-]+(?:\/|$)/,
  },
  {
    code: 'private-instance-label',
    message: 'Public repo text must not include private instance labels.',
    regex: /\b(?:BES Bot|Loops-managed|mw-bot|whatsapp:mw-bot|whatsapp-bot@(?:personal|loops|besbot)|whatsoup@(?:q|loops|besbot|personal)|whatsoup-personal|Q's (?:number|WhatsApp number))\b|instances\/personal\/whatsoup\.sock|\/home\/q\//,
  },
  {
    code: 'whatsapp-group-jid',
    message: 'Public repo text must not include real-shaped WhatsApp group JIDs.',
    regex: /\b(?!120363555555555000@g\.us\b)120363\d{6,}@g\.us\b/,
  },
  {
    code: 'whatsapp-user-jid',
    message: 'Public repo text must not include real-shaped WhatsApp user JIDs.',
    regex: /\b(?!(?:1555\d{4,}|1111111\d+|81536414179\d+)@(s\.whatsapp\.net|lid)\b)\d{8,}@(s\.whatsapp\.net|lid)\b/,
  },
  {
    code: 'github-token',
    message: 'Public repo text must not include GitHub token shapes.',
    regex: /\bgh[pousr]_[A-Za-z0-9_]{12,}\b/,
  },
  {
    code: 'openai-key',
    message: 'Public repo text must not include OpenAI key shapes.',
    regex: /\bsk-[A-Za-z0-9_-]{16,}\b/,
  },
  {
    code: 'pinecone-key',
    message: 'Public repo text must not include Pinecone key shapes.',
    regex: /\bpcsk_[A-Za-z0-9_-]{12,}\b/,
  },
  {
    code: 'slack-token',
    message: 'Public repo text must not include Slack token shapes.',
    regex: /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/,
  },
  {
    code: 'private-key',
    message: 'Public repo text must not include private key material.',
    regex: /BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY/,
  },
];

const commitMessagePatterns: GuardPattern[] = [
  {
    code: 'commit-coauthor-trailer',
    message: 'Public commits must not include Co-Authored-By trailers.',
    regex: /^Co-Authored-By:/i,
  },
  ...addedLinePatterns.filter((pattern) => pattern.code !== 'merge-conflict-marker'),
];

export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { mode: 'staged', help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--staged') {
      args.mode = 'staged';
    } else if (arg === '--release-hygiene') {
      args.mode = 'release-hygiene';
    } else if (arg === '--commit-authors') {
      args.mode = 'commit-authors';
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

function findDisallowedMatch(filePath: string, pattern: GuardPattern, text: string): string | null {
  const flags = pattern.regex.flags.includes('g') ? pattern.regex.flags : `${pattern.regex.flags}g`;
  const regex = new RegExp(pattern.regex.source, flags);

  for (const match of text.matchAll(regex)) {
    const token = match[0];
    if (!isAllowedPatternMatch(filePath, pattern.code, token)) {
      return token;
    }
    if (token === '') break;
  }

  return null;
}

function isPackageLockResolvedUrlLine(filePath: string, text: string): boolean {
  return normalizeRepoPath(filePath) === 'package-lock.json'
    && /^\s*"resolved":\s*"https:\/\/registry\.npmjs\.org\//.test(text);
}

export function scanAddedLines(lines: AddedLine[]): GuardIssue[] {
  const issues: GuardIssue[] = [];

  for (const line of lines) {
    const filePath = normalizeRepoPath(line.filePath);
    const productionCodePath = /^(?:src|scripts|deploy|console\/src)\//.test(filePath);

    if (fixtureFiles.has(filePath)) continue;
    if (
      /^(?:src|console\/src)\//.test(filePath)
      && !srcConsoleAllowedFiles.has(filePath)
      && /\bconsole\.(?:debug|error|info|log|warn)\s*\(/.test(line.text)
    ) {
      issues.push({
        code: 'src-console-call',
        message: 'Production source should use the structured logger instead of ad-hoc console calls.',
        filePath: line.filePath,
        line: line.line,
      });
    }
    if (productionCodePath && /(?:\benv\s*:\s*process\.env|\.{3}process\.env\b)/.test(line.text)) {
      issues.push({
        code: 'process-env-inheritance',
        message: 'Child processes must use an explicit allowlisted env instead of inheriting process.env.',
        filePath: line.filePath,
        line: line.line,
      });
    }
    if (productionCodePath && /\bshell\s*:\s*true\b/.test(line.text)) {
      issues.push({
        code: 'child-process-shell-true',
        message: 'Child process shell mode must not be introduced without an explicit reviewed exception.',
        filePath: line.filePath,
        line: line.line,
      });
    }
    if (productionCodePath && /\b(?:eval\s*\(|(?:new\s+)?Function\s*\()/.test(line.text)) {
      issues.push({
        code: 'dynamic-code-execution',
        message: 'Dynamic code execution must not be introduced in source, scripts, or deploy code.',
        filePath: line.filePath,
        line: line.line,
      });
    }
    if (isSuppressionComment(line.text) && !hasSuppressionRationaleAndExpiry(line.text)) {
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
  return /(?:@ts-ignore|@ts-expect-error|@ts-nocheck|eslint-disable|biome-ignore)/.test(text);
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
  if (/^\.env(?:\.|$)/.test(normalized)) return true;
  if (/(^|\/)auth_info/.test(normalized)) return true;
  if (/\.(?:db|db-wal|db-shm)$/.test(normalized)) return true;
  if (/\.(?:pem|key)$/.test(normalized)) return true;
  if (/^(?:\.codex|\.tmup-artifacts|artifacts)(?:\/|$)/.test(normalized)) return true;
  if (normalized === '.mcp.json') return true;
  if (/^instances\/[^/]+\/instance\.json$/.test(normalized)) return true;
  if (/^(?:users|groups|\.sweep)\//.test(normalized)) return true;
  return false;
}

function scanStagedSensitiveArtifacts(cwd: string): GuardIssue[] {
  return stagedFilePaths(cwd)
    .filter(isTrackedSensitiveArtifact)
    .map((filePath) => ({
      code: 'staged-sensitive-artifact',
      filePath,
      message: 'Runtime credential, database, key, workspace, or scratch artifact must not be committed.',
    }));
}

export function scanContentLines(lines: AddedLine[]): GuardIssue[] {
  const issues: GuardIssue[] = [];

  for (const line of lines) {
    const filePath = normalizeRepoPath(line.filePath);
    if (fixtureFiles.has(filePath)) continue;
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

export function parseCommitAuthorLog(log: string): CommitAuthor[] {
  return log
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha, name, email, subject] = record.split('\x00');
      return {
        sha: sha ?? '',
        name: name ?? '',
        email: email ?? '',
        subject: subject ?? '',
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

function commitAuthorBaseRef(cwd: string): string | null {
  const githubBaseRef = process.env.GITHUB_BASE_REF?.trim();
  if (githubBaseRef && gitRefExists(cwd, `origin/${githubBaseRef}`)) {
    return `origin/${githubBaseRef}`;
  }

  try {
    const branch = git(['branch', '--show-current'], cwd).trim();
    const upstream = branch
      ? git(['for-each-ref', '--format=%(upstream:short)', `refs/heads/${branch}`], cwd).trim()
      : '';
    if (upstream && gitRefExists(cwd, upstream)) return upstream;
  } catch {
    // Fall through to origin/main for detached or not-yet-published branches.
  }

  return gitRefExists(cwd, 'origin/main') ? 'origin/main' : null;
}

function readCommitAuthors(cwd: string): CommitAuthor[] {
  const baseRef = commitAuthorBaseRef(cwd);
  const rangeArgs = baseRef ? [`${baseRef}..HEAD`] : ['-1', 'HEAD'];
  const log = git(['log', '--format=%H%x00%an%x00%ae%x00%s%x1e', ...rangeArgs], cwd);
  return parseCommitAuthorLog(log);
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
       npm run guard:repo -- --release-hygiene
       npm run guard:repo -- --commit-authors
       npm run guard:repo:commit-msg -- <message-file>

Modes:
  --staged              Scan staged added lines. This is the default.
  --release-hygiene     Scan tracked release-hygiene files.
  --commit-authors      Scan commits in the branch/PR range for placeholder authors.
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

  const issues = args.mode === 'commit-msg'
    ? scanCommitMessage(readFileSync(args.messageFile ?? '', 'utf8'))
    : args.mode === 'release-hygiene'
      ? scanTrackedFiles(cwd)
      : args.mode === 'commit-authors'
        ? scanCommitAuthors(readCommitAuthors(cwd))
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
