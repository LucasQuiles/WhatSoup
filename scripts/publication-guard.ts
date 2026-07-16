#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  git,
  isTextCandidate,
  listStagedFiles,
  normalizeRepoPath,
  readStagedAddedLines,
  readStagedFileContentResult,
  isOperationalProtocolToken,
  operationalReleaseHygieneFiles,
} from './lib/guard-core.ts';

export { isTextCandidate, normalizeRepoPath } from './lib/guard-core.ts';

export type PublicationClass = 'PUBLIC' | 'PRIVATE-ARCHIVE' | 'SANITIZE' | 'DELETE';
export type PublicationMode = 'all' | 'release' | 'staged';
export type GuardSeverity = 'error' | 'warning';

export interface AuditRow {
  filePath: string;
  classification: PublicationClass;
}

export interface ParsedAudit {
  rows: AuditRow[];
  duplicates: string[];
  summaryCounts: Partial<Record<PublicationClass | 'Total', number>>;
  declaredTotal: number | undefined;
}

export interface GuardIssue {
  severity: GuardSeverity;
  code: string;
  message: string;
  filePath?: string;
  line?: number;
}

interface ParsedArgs {
  mode: PublicationMode;
  json: boolean;
  help: boolean;
}

interface PrivatePattern {
  code: string;
  description: string;
  regex: RegExp;
}

type StagedAuditRead =
  | { ok: true; parsed: ParsedAudit | undefined }
  | { ok: false; issue: GuardIssue };

const publicationClasses = new Set<PublicationClass>(['PUBLIC', 'PRIVATE-ARCHIVE', 'SANITIZE', 'DELETE']);

export const internalPublicationRoots = [
  /^docs\/runbooks\//,
  /^docs\/sdlc\//,
  /^docs\/superpowers\//,
  /^docs\/plans\//,
  /^docs\/cutover\//,
  /^docs\/handoff-[^/]+\.md$/,
  /^HANDOFF-[^/]+\.md$/,
  /^docs\/project-status-[^/]+\.md$/,
  /^docs\/audit-[^/]+\.md$/,
  /^docs\/research\//,
  /^docs\/specs\/(?!2026-04-25-prompt-enrichment-design\.md$|image-tools-design\.md$|2026-04-26-byok-hardening-remaining-work\.md$)/,
  /^tmp\//,
  /^docs\/work-index(?:\.md|\.json|-repair-matrix\.md)?$/,
  /^docs\/current-program\.md$/,
];

const manualPublicationDocs = [
  'docs/work-index.md',
  'docs/work-index.json',
  'docs/work-index-repair-matrix.md',
  'docs/current-program.md',
];

const privatePatterns: PrivatePattern[] = [
  {
    code: 'personal-email',
    description: 'personal email address',
    regex: /\b[A-Z0-9._%+-]+@(?!(?:users\.noreply\.github\.com|s\.whatsapp\.net|g\.us|heal\.internal)\b)[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  },
  {
    code: 'local-home-path',
    description: 'operator-local home path',
    // Matches both absolute home roots (Users/<name>, home/<name>) and the
    // tilde-relative form (~/...). The tilde branch reuses the SAME allowlist
    // lookahead so it stays symmetric with the absolute rule: the ~/whatsoup,
    // ~/runner, and ~/testuser first segments are permitted just as the
    // equivalent absolute deploy/CI usernames are.
    regex: /(?:\/(?:Users|home)|~)\/(?!runner(?:\/|$)|testuser(?:\/|$)|whatsoup(?:\/|$))[A-Za-z0-9._-]+(?:\/|$)/,
  },
  {
    code: 'whatsapp-group-jid',
    description: 'real-shaped WhatsApp group JID',
    regex: /\b120363\d{6,}@g\.us\b/,
  },
  {
    code: 'whatsapp-user-jid',
    description: 'real-shaped WhatsApp user JID',
    regex: /\b(?!(?:1555\d{4,}|1111111\d+|81536414179\d+)@(s\.whatsapp\.net|lid)\b)\d{8,}@(s\.whatsapp\.net|lid)\b/,
  },
  {
    code: 'github-token',
    description: 'GitHub token shape',
    regex: /\bgh[pousr]_[A-Za-z0-9_]{12,}\b/,
  },
  {
    code: 'openai-key',
    description: 'OpenAI key shape',
    regex: /\bsk-[A-Za-z0-9_-]{16,}\b/,
  },
  {
    code: 'pinecone-key',
    description: 'Pinecone key shape',
    regex: /\bpcsk_[A-Za-z0-9_-]{12,}\b/,
  },
  {
    code: 'slack-token',
    description: 'Slack token shape',
    regex: /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/,
  },
  {
    code: 'private-key',
    description: 'private key material',
    regex: /BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY/,
  },
];

export function isInternalPublicationPath(filePath: string): boolean {
  const normalized = normalizeRepoPath(filePath);
  return internalPublicationRoots.some((pattern) => pattern.test(normalized));
}

export function parsePublicationAudit(markdown: string): ParsedAudit {
  const rows: AuditRow[] = [];
  const seen = new Set<string>();
  const duplicates: string[] = [];
  const summaryCounts: Partial<Record<PublicationClass | 'Total', number>> = {};
  let declaredTotal: number | undefined;

  for (const line of markdown.split(/\r?\n/)) {
    const totalLine = line.match(/^\*\*Total classification rows:\*\*\s+(\d+)\s*$/);
    if (totalLine) {
      declaredTotal = Number(totalLine[1]);
      continue;
    }

    const row = line.match(/^\| `([^`]+)` \| (PUBLIC|PRIVATE-ARCHIVE|SANITIZE|DELETE) \|/);
    if (row) {
      const filePath = normalizeRepoPath(row[1]);
      if (seen.has(filePath)) duplicates.push(filePath);
      seen.add(filePath);
      rows.push({ filePath, classification: row[2] as PublicationClass });
      continue;
    }

    const summary = line.match(/^\| (PUBLIC|PRIVATE-ARCHIVE|SANITIZE|DELETE|Total) \| (\d+) \|$/);
    if (summary) summaryCounts[summary[1] as PublicationClass | 'Total'] = Number(summary[2]);
  }

  return { rows, duplicates, summaryCounts, declaredTotal };
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { mode: 'all', json: false, help: false };

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--all') {
      args.mode = 'all';
    } else if (arg === '--release') {
      args.mode = 'release';
    } else if (arg === '--staged') {
      args.mode = 'staged';
    } else if (arg === '--json') {
      args.json = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

// Operational fleet files (health profiles, expected-fleet manifest) carry
// real systemd template-unit names that the email-shape regex matches. Skip
// the personal-email rule only when EVERY email-shaped token on the line is
// an allowlisted operational identifier - a real address alongside a unit
// name still flags.
function isOperationalUnitLine(filePath: string, lineText: string, regex: RegExp): boolean {
  if (!operationalReleaseHygieneFiles.has(normalizeRepoPath(filePath))) return false;
  const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
  const tokens = lineText.match(new RegExp(regex.source, flags)) ?? [];
  return tokens.length > 0 && tokens.every((token) => isOperationalProtocolToken(token));
}

export function scanTextForPrivateLiterals(filePath: string, text: string): GuardIssue[] {
  const issues: GuardIssue[] = [];

  text.split(/\r?\n/).forEach((lineText, index) => {
    for (const pattern of privatePatterns) {
      if (pattern.regex.test(lineText)) {
        if (pattern.code === 'personal-email' && isOperationalUnitLine(filePath, lineText, pattern.regex)) {
          continue;
        }
        issues.push({
          severity: 'error',
          code: pattern.code,
          filePath,
          line: index + 1,
          message: `Found ${pattern.description}; replace with a placeholder or classify the file as non-public.`,
        });
      }
    }
  });

  return issues;
}

export function findMissingMarkdownRefs(
  filePath: string,
  text: string,
  exists: (filePath: string) => boolean = existsSync,
): GuardIssue[] {
  const issues: GuardIssue[] = [];
  const refPattern = /`(docs\/[A-Za-z0-9_./@-]+\.md(?:#[^`\s]+)?)`|\]\((docs\/[A-Za-z0-9_./@-]+\.md(?:#[^)\s]+)?)\)/g;

  text.split(/\r?\n/).forEach((lineText, index) => {
    let match: RegExpExecArray | null;
    while ((match = refPattern.exec(lineText))) {
      const ref = (match[1] ?? match[2]).split('#')[0];
      if (!exists(ref)) {
        issues.push({
          severity: 'error',
          code: 'missing-doc-ref',
          filePath,
          line: index + 1,
          message: `Referenced markdown file does not exist: ${ref}`,
        });
      }
    }
  });

  return issues;
}

export function validatePublicationAudit(
  parsed: ParsedAudit,
  trackedInternalDocs: string[],
  readFile: (filePath: string) => string | undefined,
): GuardIssue[] {
  const issues: GuardIssue[] = [];
  const tracked = new Set(trackedInternalDocs.map(normalizeRepoPath).sort());
  const rows = new Map(parsed.rows.map((row) => [row.filePath, row.classification]));

  for (const duplicate of parsed.duplicates) {
    issues.push({
      severity: 'error',
      code: 'audit-duplicate-row',
      filePath: duplicate,
      message: 'Publication audit contains duplicate rows for this file.',
    });
  }

  for (const filePath of tracked) {
    if (!rows.has(filePath)) {
      issues.push({
        severity: 'error',
        code: 'audit-missing-row',
        filePath,
        message: 'Tracked internal documentation is missing from docs/publication-audit.md.',
      });
    }
  }

  for (const [filePath, classification] of rows) {
    if (!tracked.has(filePath)) {
      issues.push({
        severity: 'error',
        code: 'audit-stale-row',
        filePath,
        message: 'Publication audit row does not correspond to a tracked internal documentation file.',
      });
    }
    if (classification === 'PUBLIC') {
      const text = readFile(filePath);
      if (text !== undefined) issues.push(...scanTextForPrivateLiterals(filePath, text));
    }
  }

  const actualCounts: Record<PublicationClass, number> = {
    PUBLIC: 0,
    'PRIVATE-ARCHIVE': 0,
    SANITIZE: 0,
    DELETE: 0,
  };

  for (const row of parsed.rows) actualCounts[row.classification] += 1;

  for (const classification of publicationClasses) {
    const expected = parsed.summaryCounts[classification];
    if (expected !== undefined && expected !== actualCounts[classification]) {
      issues.push({
        severity: 'error',
        code: 'audit-summary-mismatch',
        message: `Publication audit summary says ${classification}=${expected}, but table has ${actualCounts[classification]}.`,
      });
    }
  }

  const summaryTotal = parsed.summaryCounts.Total;
  if (summaryTotal !== undefined && summaryTotal !== parsed.rows.length) {
    issues.push({
      severity: 'error',
      code: 'audit-total-mismatch',
      message: `Publication audit summary says Total=${summaryTotal}, but table has ${parsed.rows.length}.`,
    });
  }

  if (parsed.declaredTotal !== undefined && parsed.declaredTotal !== parsed.rows.length) {
    issues.push({
      severity: 'error',
      code: 'publication-audit-total-mismatch',
      message: `Publication audit declares Total classification rows=${parsed.declaredTotal}, but table has ${parsed.rows.length} rows.`,
    });
  }

  if (parsed.rows.length !== tracked.size) {
    issues.push({
      severity: 'error',
      code: 'audit-tracked-count-mismatch',
      message: `Publication audit table has ${parsed.rows.length} rows, but git tracks ${tracked.size} internal documentation files.`,
    });
  }

  return issues;
}

function stagedAddedText(cwd: string, filePath: string): string {
  const lines: string[] = [];

  for (const diffLine of readStagedAddedLines(cwd, filePath).split(/\r?\n/)) {
    if (diffLine.startsWith('+++') || diffLine.startsWith('---')) continue;
    if (diffLine.startsWith('+')) lines.push(diffLine.slice(1));
  }

  return lines.join('\n');
}

function listTrackedInternalDocs(cwd: string): string[] {
  const trackedFiles = git(['ls-files'], cwd).split(/\r?\n/).filter(Boolean);
  const docs = new Set<string>();

  for (const filePath of trackedFiles) {
    if (isInternalPublicationPath(filePath) || manualPublicationDocs.includes(filePath)) {
      docs.add(normalizeRepoPath(filePath));
    }
  }

  return [...docs].sort();
}

function listIgnoredInternalDocs(cwd: string): string[] {
  const output = git(['status', '--ignored', '--short', '--untracked-files=all', '--', 'docs', 'HANDOFF-*.md', 'tmp'], cwd);
  return output
    .split(/\r?\n/)
    .filter((line) => line.startsWith('!! '))
    .map((line) => normalizeRepoPath(line.slice(3)))
    .filter(isInternalPublicationPath)
    .sort();
}

function loadAudit(cwd: string): ParsedAudit | undefined {
  const auditPath = path.join(cwd, 'docs/publication-audit.md');
  if (!existsSync(auditPath)) return undefined;
  return parsePublicationAudit(readFileSync(auditPath, 'utf8'));
}

/**
 * Load the audit from the staged index (or HEAD), never from the working tree.
 * Used in staged mode to prevent bypass via unstaged audit additions.
 */
function loadStagedAudit(cwd: string): StagedAuditRead {
  const result = readStagedFileContentResult(cwd, 'docs/publication-audit.md');
  if (!result.ok) {
    return {
      ok: false,
      issue: {
        severity: 'error',
        code: 'audit-read-failed',
        filePath: 'docs/publication-audit.md',
        message: `Could not read docs/publication-audit.md from the staged index or HEAD: ${result.error}`,
      },
    };
  }
  return {
    ok: true,
    parsed: result.content === undefined ? undefined : parsePublicationAudit(result.content),
  };
}

function readWorkingFile(cwd: string, filePath: string): string | undefined {
  const fullPath = path.join(cwd, filePath);
  return existsSync(fullPath) ? readFileSync(fullPath, 'utf8') : undefined;
}

function validateStaged(cwd: string): GuardIssue[] {
  const issues: GuardIssue[] = [];
  const staged = listStagedFiles(cwd, 'ACMR');
  const deleted = listStagedFiles(cwd, 'D');
  // Use the staged (or HEAD) version of the audit — never the working tree.
  // This closes the bypass where a new runbook is staged but its audit row is
  // only added to the working tree (not staged), which previously made --staged
  // return 0 (false negative).
  const stagedAudit = loadStagedAudit(cwd);
  if (!stagedAudit.ok) issues.push(stagedAudit.issue);
  const parsed = stagedAudit.ok ? stagedAudit.parsed : undefined;
  const auditRows = new Set(parsed?.rows.map((row) => row.filePath) ?? []);
  const auditStaged = staged.includes('docs/publication-audit.md') || deleted.includes('docs/publication-audit.md');

  if (stagedAudit.ok) {
    for (const filePath of staged.filter(isInternalPublicationPath)) {
      if (!auditRows.has(filePath)) {
        issues.push({
          severity: 'error',
          code: 'staged-internal-doc-unclassified',
          filePath,
          message: 'Staged internal documentation must be classified in docs/publication-audit.md before commit.',
        });
      }
    }

    for (const filePath of deleted.filter(isInternalPublicationPath)) {
      if (auditRows.has(filePath)) {
        issues.push({
          severity: 'error',
          code: 'deleted-internal-doc-stale-audit',
          filePath,
          message: 'Deleted internal documentation still has a docs/publication-audit.md row. Update the audit in the same commit.',
        });
      }
    }
  }

  for (const filePath of staged.filter(isTextCandidate)) {
    const addedText = stagedAddedText(cwd, filePath);
    issues.push(...scanTextForPrivateLiterals(filePath, addedText));
    if (path.extname(filePath) === '.md') {
      issues.push(...findMissingMarkdownRefs(filePath, addedText, (ref) => existsSync(path.join(cwd, ref))));
    }
  }

  if (auditStaged && stagedAudit.ok) {
    if (!parsed) {
      issues.push({
        severity: 'error',
        code: 'audit-missing',
        filePath: 'docs/publication-audit.md',
        message: 'docs/publication-audit.md is required when internal docs are tracked.',
      });
    } else {
      issues.push(...validatePublicationAudit(parsed, listTrackedInternalDocs(cwd), (filePath) => readWorkingFile(cwd, filePath)));
    }
  }

  return issues;
}

function validateAll(cwd: string): GuardIssue[] {
  const trackedInternalDocs = listTrackedInternalDocs(cwd);
  const parsed = loadAudit(cwd);
  const issues: GuardIssue[] = [];

  if (trackedInternalDocs.length > 0 && !parsed) {
    issues.push({
      severity: 'error',
      code: 'audit-missing',
      filePath: 'docs/publication-audit.md',
      message: 'docs/publication-audit.md is required when internal docs are tracked.',
    });
  } else if (parsed) {
    issues.push(...validatePublicationAudit(parsed, trackedInternalDocs, (filePath) => readWorkingFile(cwd, filePath)));
  }

  for (const filePath of listIgnoredInternalDocs(cwd)) {
    issues.push({
      severity: 'warning',
      code: 'ignored-internal-doc',
      filePath,
      message: 'Ignored internal documentation exists locally. It is not publication risk unless force-added.',
    });
  }

  return issues;
}

function validateRelease(cwd: string): GuardIssue[] {
  const issues = validateAll(cwd);
  const parsed = loadAudit(cwd);
  const trackedInternalDocs = new Set(listTrackedInternalDocs(cwd));
  if (!parsed) return issues;

  for (const row of parsed.rows) {
    if (row.classification === 'PUBLIC') continue;
    if (!trackedInternalDocs.has(row.filePath)) continue;
    issues.push({
      severity: 'error',
      code: 'release-internal-doc-still-tracked',
      filePath: row.filePath,
      message: `Release mode requires this ${row.classification} file to be sanitized, removed, or moved to a private archive before publication.`,
    });
  }

  return issues;
}

function printIssues(issues: GuardIssue[]): void {
  for (const issue of issues) {
    const location = issue.filePath ? `${issue.filePath}:${issue.line ?? 1}` : 'publication-guard:1';
    console.error(`${location} ${issue.severity} ${issue.code}: ${issue.message}`);
  }
}

function printHelp(): void {
  console.log(`Usage: npm run guard:publication -- [--all|--staged|--release] [--json]

Checks:
  --all      Validate tracked publication audit state.
  --staged   Validate the same deterministic publication audit state before commit.
  --release  Require every tracked internal doc to be PUBLIC-clean before publication.
  --json     Print machine-readable results.
  --help     Show this help.`);
}

export function runPublicationGuard(argv = process.argv.slice(2), cwd = process.cwd()): number {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }

  if (args.help) {
    printHelp();
    return 0;
  }

  const issues =
    args.mode === 'staged'
      ? validateStaged(cwd)
      : args.mode === 'release'
        ? validateRelease(cwd)
        : validateAll(cwd);
  const errors = issues.filter((issue) => issue.severity === 'error');

  if (args.json) {
    console.log(JSON.stringify({ ok: errors.length === 0, errors: errors.length, warnings: issues.length - errors.length, issues }, null, 2));
  } else if (issues.length > 0) {
    printIssues(issues);
  }

  if (errors.length > 0) {
    console.error(`publication-guard failed: ${errors.length} error(s), ${issues.length - errors.length} warning(s)`);
    return 1;
  }

  if (!args.json) console.log(`publication-guard passed (${args.mode}): ${issues.length - errors.length} warning(s)`);
  return 0;
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = runPublicationGuard();
}
