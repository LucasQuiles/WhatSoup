import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseClosedOptions } from './lib/cli-args.ts';
import { cleanGitEnv } from './lib/guard-core.ts';

export type GuardDecision = 'pass' | 'warn' | 'fail' | 'inconclusive';

export interface PrMetadataFinding {
  code:
    | 'pr-metadata.closing-directive-outside-section'
    | 'pr-metadata.invalid-directive-section'
    | 'pr-metadata.commit-closing-directive';
  issueNumbers: number[];
}

export interface PrMetadataReceipt {
  decision: GuardDecision;
  pullRequestNumber: number | null;
  intentionalIssueNumbers: number[];
  findings: PrMetadataFinding[];
  warnings: string[];
  errors: string[];
}

export interface PrMetadataGuardResult {
  exitCode: 0 | 1 | 2;
  receipt: PrMetadataReceipt;
}

interface GuardInput {
  body: string;
  base: string;
  head: string;
  target: string;
  defaultBranch: string;
  pullRequestNumber: number | null;
}

type GuardInputResult =
  | { ok: true; value: GuardInput }
  | { ok: false; code: string };

const OPTIONS = {
  booleanOptions: ['--help', '-h', '--json', '--stdin'],
  valueOptions: ['--base', '--body-file', '--head', '--target', '--default-branch', '--github-event'],
} as const;

const USAGE = [
  'Usage: pr-metadata-guard.ts (--stdin | --body-file <path> | --github-event <path>) [options]',
  '',
  'Options:',
  '  --base <oid>             Exact base object ID for --stdin/--body-file.',
  '  --head <oid>             Exact head object ID for --stdin/--body-file.',
  '  --target <branch>        Target branch for --stdin/--body-file.',
  '  --default-branch <name>  Default branch for --stdin/--body-file.',
  '  --json                   Print the bounded receipt as JSON.',
  '  --help, -h               Print this usage text.',
].join('\n');

const closingReference = /\b(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s*:?\s+(?:(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#)([1-9]\d*)\b/gi;
const directiveLine = /^(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s*:?[ \t]+(?:(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#)([1-9]\d*)\s*$/i;
const directiveStart = '<!-- whatsoup:closing-directives:start -->';
const directiveEnd = '<!-- whatsoup:closing-directives:end -->';

function issueNumbers(text: string): number[] {
  const values = new Set<number>();
  for (const match of text.matchAll(closingReference)) values.add(Number(match[1]));
  return [...values].sort((left, right) => left - right);
}

function receipt(
  decision: GuardDecision,
  findings: PrMetadataFinding[] = [],
  intentionalIssueNumbers: number[] = [],
  warnings: string[] = [],
  errors: string[] = [],
  pullRequestNumber: number | null = null,
): PrMetadataReceipt {
  return {
    decision,
    pullRequestNumber,
    intentionalIssueNumbers,
    findings,
    warnings,
    errors,
  };
}

function scanBody(body: string): { findings: PrMetadataFinding[]; intentionalIssueNumbers: number[] } {
  const outsideIssues = new Set<number>();
  const intentionalIssues = new Set<number>();
  const invalidSectionIssues = new Set<number>();
  const outsideSegments: string[] = [];
  let outsideLines: string[] = [];
  let inDirectiveSection = false;
  let sawDirectiveStart = false;
  let sawDirectiveEnd = false;
  let invalidSection = false;

  const closeOutsideSegment = (): void => {
    if (outsideLines.length === 0) return;
    outsideSegments.push(outsideLines.join('\n'));
    outsideLines = [];
  };

  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === directiveStart) {
      closeOutsideSegment();
      if (inDirectiveSection || sawDirectiveStart) invalidSection = true;
      sawDirectiveStart = true;
      inDirectiveSection = true;
      continue;
    }
    if (trimmed === directiveEnd) {
      closeOutsideSegment();
      if (!inDirectiveSection || sawDirectiveEnd) invalidSection = true;
      sawDirectiveEnd = true;
      inDirectiveSection = false;
      continue;
    }
    if (inDirectiveSection) {
      const match = trimmed.match(directiveLine);
      if (match?.[1]) intentionalIssues.add(Number(match[1]));
      else if (trimmed !== '') {
        invalidSection = true;
        for (const issue of issueNumbers(line)) invalidSectionIssues.add(issue);
      }
      continue;
    }
    outsideLines.push(line);
  }

  closeOutsideSegment();
  for (const segment of outsideSegments) {
    for (const issue of issueNumbers(segment)) outsideIssues.add(issue);
  }

  if (inDirectiveSection || sawDirectiveStart !== sawDirectiveEnd) invalidSection = true;

  const findings: PrMetadataFinding[] = [];
  if (outsideIssues.size > 0) {
    findings.push({
      code: 'pr-metadata.closing-directive-outside-section',
      issueNumbers: [...outsideIssues].sort((left, right) => left - right),
    });
  }
  if (invalidSection) {
    findings.push({
      code: 'pr-metadata.invalid-directive-section',
      issueNumbers: [...invalidSectionIssues].sort((left, right) => left - right),
    });
  }

  return {
    findings,
    intentionalIssueNumbers: [...intentionalIssues].sort((left, right) => left - right),
  };
}

function inconclusive(code: string, pullRequestNumber: number | null = null): PrMetadataGuardResult {
  return { exitCode: 2, receipt: receipt('inconclusive', [], [], [], [code], pullRequestNumber) };
}

export function formatPrMetadataReceipt(value: PrMetadataReceipt): string {
  const codes = [
    ...value.findings.map((finding) => finding.code),
    ...value.warnings,
    ...value.errors,
  ].sort();
  const issues = new Set<number>(value.intentionalIssueNumbers);
  for (const finding of value.findings) {
    for (const issue of finding.issueNumbers) issues.add(issue);
  }
  const issueList = [...issues].sort((left, right) => left - right).join(',') || 'none';
  const pr = value.pullRequestNumber === null ? 'none' : String(value.pullRequestNumber);
  const receiptCodes = codes.length > 0 ? codes : ['clean'];

  return receiptCodes
    .map((code) => `PR_METADATA_GUARD ${value.decision} ${code} pr=${pr} issues=${issueList}`)
    .join('\n');
}

function isFullObjectId(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readPullRequestEvent(eventPath: string): GuardInputResult {
  let text: string;
  try {
    text = readFileSync(eventPath, 'utf8');
  } catch {
    return { ok: false, code: 'pr-metadata.event-unavailable' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, code: 'pr-metadata.event-invalid' };
  }

  const event = asRecord(parsed);
  const pullRequest = asRecord(event?.pull_request);
  const repository = asRecord(event?.repository);
  const base = asRecord(pullRequest?.base);
  const head = asRecord(pullRequest?.head);
  const number = event?.number;
  const body = pullRequest?.body;
  const target = base?.ref;
  const baseOid = base?.sha;
  const headOid = head?.sha;
  const defaultBranch = repository?.default_branch;

  if (
    !Number.isSafeInteger(number)
    || (number as number) <= 0
    || !(typeof body === 'string' || body === null)
    || typeof target !== 'string'
    || typeof baseOid !== 'string'
    || typeof headOid !== 'string'
    || typeof defaultBranch !== 'string'
    || target.length === 0
    || defaultBranch.length === 0
  ) {
    return { ok: false, code: 'pr-metadata.event-invalid' };
  }

  return {
    ok: true,
    value: {
      body: body ?? '',
      base: baseOid,
      head: headOid,
      target,
      defaultBranch,
      pullRequestNumber: number as number,
    },
  };
}

export function runPrMetadataGuard(
  argv: readonly string[] = process.argv.slice(2),
  cwd = process.cwd(),
  stdin = '',
): PrMetadataGuardResult {
  const parsed = parseClosedOptions(argv, OPTIONS);
  if (parsed.error !== null) return inconclusive('pr-metadata.input-invalid');

  const stdinSelected = parsed.flags.has('--stdin');
  const bodyFilePath = parsed.values.get('--body-file');
  const eventPath = parsed.values.get('--github-event');
  if (Number(stdinSelected) + Number(bodyFilePath !== undefined) + Number(eventPath !== undefined) !== 1) {
    return inconclusive('pr-metadata.input-invalid');
  }

  let input: GuardInput;
  if (eventPath !== undefined) {
    const eventInput = readPullRequestEvent(eventPath);
    if (!eventInput.ok) return inconclusive(eventInput.code);
    input = eventInput.value;
  } else {
    const base = parsed.values.get('--base');
    const head = parsed.values.get('--head');
    const target = parsed.values.get('--target');
    const defaultBranch = parsed.values.get('--default-branch');
    if (!base || !head || !target || !defaultBranch) return inconclusive('pr-metadata.input-invalid');
    let body = stdin;
    if (bodyFilePath !== undefined) {
      try {
        body = readFileSync(bodyFilePath, 'utf8');
      } catch {
        return inconclusive('pr-metadata.body-unavailable');
      }
    }
    input = { body, base, head, target, defaultBranch, pullRequestNumber: null };
  }

  const { base, head, target, defaultBranch, pullRequestNumber } = input;
  if (!isFullObjectId(base) || !isFullObjectId(head)) return inconclusive('pr-metadata.revision-invalid');

  let commits = '';
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', base, head], {
      cwd,
      encoding: 'utf8',
      env: cleanGitEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return inconclusive('pr-metadata.commit-range-invalid');
  }

  try {
    commits = execFileSync('git', ['log', '--format=%B', `${base}..${head}`], {
      cwd,
      encoding: 'utf8',
      env: cleanGitEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return inconclusive('pr-metadata.commit-range-unavailable');
  }

  const body = scanBody(input.body);
  const findings: PrMetadataFinding[] = [...body.findings];

  const commitIssues = issueNumbers(commits);
  if (commitIssues.length > 0) {
    findings.push({ code: 'pr-metadata.commit-closing-directive', issueNumbers: commitIssues });
  }

  if (target !== defaultBranch) {
    return {
      exitCode: 0,
      receipt: receipt('warn', findings, body.intentionalIssueNumbers, ['pr-metadata.nondefault-target'], [], pullRequestNumber),
    };
  }
  if (findings.length === 0) {
    return { exitCode: 0, receipt: receipt('pass', [], body.intentionalIssueNumbers, [], [], pullRequestNumber) };
  }
  return { exitCode: 1, receipt: receipt('fail', findings, body.intentionalIssueNumbers, [], [], pullRequestNumber) };
}

function isHelpRequest(argv: readonly string[]): boolean {
  return argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h');
}

function main(argv: readonly string[]): void {
  if (isHelpRequest(argv)) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  let stdin = '';
  if (argv.includes('--stdin')) {
    try {
      stdin = readFileSync(0, 'utf8');
    } catch {
      const result = inconclusive('pr-metadata.body-unavailable');
      process.stdout.write(`${argv.includes('--json') ? JSON.stringify(result.receipt) : formatPrMetadataReceipt(result.receipt)}\n`);
      process.exitCode = result.exitCode;
      return;
    }
  }

  const result = runPrMetadataGuard(argv, process.cwd(), stdin);
  process.stdout.write(`${argv.includes('--json') ? JSON.stringify(result.receipt) : formatPrMetadataReceipt(result.receipt)}\n`);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2));
}
