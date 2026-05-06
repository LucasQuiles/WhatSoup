import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export type GuardMode = 'staged' | 'commit-msg';

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

interface GuardPattern {
  code: string;
  message: string;
  regex: RegExp;
}

const fixtureFiles = new Set([
  'scripts/repo-hygiene-guard.ts',
  'tests/scripts/repo-hygiene-guard.test.ts',
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
    regex: /\b[A-Z0-9._%+-]+@(?!(?:users\.noreply\.github\.com|s\.whatsapp\.net|g\.us)\b)[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  },
  {
    code: 'local-home-path',
    message: 'Public repo text must not include operator-local home paths.',
    regex: /\/(?:Users|home)\/(?!runner(?:\/|$)|testuser(?:\/|$)|whatsoup(?:\/|$))[A-Za-z0-9._-]+(?:\/|$)/,
  },
  {
    code: 'whatsapp-group-jid',
    message: 'Public repo text must not include real-shaped WhatsApp group JIDs.',
    regex: /\b120363\d{6,}@g\.us\b/,
  },
  {
    code: 'whatsapp-user-jid',
    message: 'Public repo text must not include real-shaped WhatsApp user JIDs.',
    regex: /\b(?!(?:1555\d{4,}|1111111\d+)@(s\.whatsapp\.net|lid)\b)\d{8,}@(s\.whatsapp\.net|lid)\b/,
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

export function normalizeRepoPath(filePath: string): string {
  return filePath.split(path.sep).join('/').replace(/^\.\//, '');
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { mode: 'staged', help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--staged') {
      args.mode = 'staged';
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

export function scanAddedLines(lines: AddedLine[]): GuardIssue[] {
  const issues: GuardIssue[] = [];

  for (const line of lines) {
    if (fixtureFiles.has(normalizeRepoPath(line.filePath))) continue;
    for (const pattern of addedLinePatterns) {
      if (pattern.regex.test(line.text)) {
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

export function scanCommitMessage(message: string): GuardIssue[] {
  const issues: GuardIssue[] = [];
  const lines = message.split(/\r?\n/);

  lines.forEach((text, index) => {
    for (const pattern of commitMessagePatterns) {
      if (pattern.regex.test(text)) {
        issues.push({ code: pattern.code, message: pattern.message, line: index + 1 });
      }
    }
  });

  return issues;
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function stagedDiff(cwd: string): string {
  return git(['diff', '--cached', '--unified=0', '--no-ext-diff'], cwd);
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
       npm run guard:repo:commit-msg -- <message-file>

Modes:
  --staged              Scan staged added lines. This is the default.
  --commit-msg <file>   Scan a commit message file.
  --help                Show this help.

This guard is changed-content only. It is not a full-tree release gate.`);
}

export function run(argv: string[] = process.argv.slice(2), cwd: string = process.cwd()): GuardIssue[] {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return [];
  }

  const issues = args.mode === 'commit-msg'
    ? scanCommitMessage(readFileSync(args.messageFile ?? '', 'utf8'))
    : scanAddedLines(parseUnifiedDiffAddedLines(stagedDiff(cwd)));

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
