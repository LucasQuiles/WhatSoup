#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { types as utilTypes } from 'node:util';
import {
  git,
  isTextCandidate,
  listStagedFiles,
  normalizeRepoPath,
  readStagedAddedLines,
  readStagedFileContentResult,
  isDocumentationEmailFixture,
  isGitHubSshTransportPrincipal,
  isOperationalProtocolToken,
  operationalReleaseHygieneFiles,
} from './lib/guard-core.ts';
import {
  ExactGitInputError,
  MAX_EXACT_ADDED_LINE_BUDGET_V1,
  MAX_EXACT_ADDED_LINE_SOURCE_LINE_COUNT,
  MAX_EXACT_AGGREGATE_BLOB_BYTES,
  MAX_EXACT_SINGLE_BLOB_BYTES,
  MAX_EXACT_TREE_ENTRY_PATH_COUNT,
  readExactAddedLinesWithinBudget,
  readExactBlobs,
  readExactCommitMetadata,
  readExactCommitRange,
  readExactTreeEntries,
  type ExactAddedLineBudgetAccountingV1,
  type ExactAddedLineBudgetV1,
  type ExactChangeWithAddedLinesV1,
} from './lib/ci-control/git-input.ts';
import { canonicalizeBoundaryRun } from './lib/verification/boundary-run/shared.ts';
import { parseBoundaryJsonBytes } from './lib/verification/boundary-run/schema.ts';
import { validateExactRangeProvenance } from './lib/ci-control/exact-range-provenance.ts';

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
  /^docs\/triage\//,
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
    // Two branches, deliberately asymmetric because they identify differently:
    //
    //   Absolute `/Users/<name>` or `/home/<name>` — the segment after the root
    //   IS an operator/OS username, so it identifies. Flag unless it is a shared
    //   CI/deploy user (runner, testuser, whatsoup). The allowlist requires a
    //   FULL-segment match (`runner(?:\/|$)`), so the `runner` allow does NOT
    //   also permit a `runner`+suffix segment — allowlist-inside-blocklist
    //   filters otherwise leak at prefix boundaries.
    //
    //   Tilde `~/<segment>` — `~` already hides the username, so the segment
    //   identifies the operator's WORKSPACE, not their name. A chosen top-level
    //   dir (`~/<workspace>/...`) reveals that layout and flags; the standard
    //   XDG/OS dot-dirs (`~/.config`,
    //   `~/.local`, `~/.claude`, `~/.ssh`) and `~/Library` identify NOBODY and
    //   are dropped — they were ~85% of the 2026-07-20 sweep and a mostly-noise
    //   gate trains people to bypass it. This is a reasoned blocklist exception
    //   to the allowlist-preferred rule: this is a hygiene signal, not a secrets
    //   gate, so precision beats exhaustiveness. The tilde branch drops dot-dirs
    //   via its non-dot leading char class and `~/Library` via lookahead.
    regex:
      /(?:\/(?:Users|home)\/(?!runner(?:\/|$)|testuser(?:\/|$)|whatsoup(?:\/|$))[A-Za-z0-9._-]+|~\/(?!Library(?:\/|$)|runner(?:\/|$)|testuser(?:\/|$)|whatsoup(?:\/|$))[A-Za-z0-9_-][A-Za-z0-9._-]*)(?:\/|$)/,
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

// Same shape as isOperationalUnitLine, for RFC 2606 / RFC 6761 reserved
// documentation domains: skip the rule only when EVERY email-shaped token on the
// line is a fixture. A real address sharing a line with a fixture still flags.
// Not file-scoped — a reserved domain is unroutable wherever it appears.
function isAllowedNonMailboxEmailLine(lineText: string, regex: RegExp): boolean {
  const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
  const tokens = lineText.match(new RegExp(regex.source, flags)) ?? [];
  return (
    tokens.length > 0
    && tokens.every((token) => (
      isDocumentationEmailFixture(token) || isGitHubSshTransportPrincipal(token)
    ))
  );
}

export function scanTextForPrivateLiterals(filePath: string, text: string): GuardIssue[] {
  const issues: GuardIssue[] = [];

  text.split(/\r?\n/).forEach((lineText, index) => {
    for (const pattern of privatePatterns) {
      if (pattern.regex.test(lineText)) {
        if (pattern.code === 'personal-email' && isOperationalUnitLine(filePath, lineText, pattern.regex)) {
          continue;
        }
        if (pattern.code === 'personal-email' && isAllowedNonMailboxEmailLine(lineText, pattern.regex)) {
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

  // Non-vacuity floor for the whole-tree modes. `all` and `release` audit the set of TRACKED
  // files (git ls-files); zero tracked files means the scope resolved to an empty/wrong tree,
  // and "0 issues over 0 files" must not read as a pass. Gated on mode: `staged` scans the
  // commit's ADDED lines, where an empty set is legitimate (committing with nothing staged is
  // normal, and .husky/pre-commit runs guard:publication:staged), so it is deliberately exempt.
  if (args.mode !== 'staged') {
    const trackedCount = git(['ls-files'], cwd).split(/\r?\n/).filter(Boolean).length;
    if (trackedCount === 0) {
      console.error(
        `publication-guard: INCONCLUSIVE — 0 tracked files under ${cwd} in ${args.mode} mode. ` +
          'A publication audit over an empty tree certifies nothing, which is not a pass.',
      );
      return 2;
    }
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

  if (!args.json) {
    console.log(`publication-guard passed (${args.mode}): ${issues.length - errors.length} warning(s)`);
    // Scope statement (honesty over convenience): staged mode scans only the
    // lines this commit ADDS, so a clean result is not a statement about the
    // repository. Pre-existing operator-local content already in history is
    // invisible here — "guard clean" must not be read as "repo clean".
    if (args.mode === 'staged') {
      console.log('  scope: staged added lines only — pre-existing repo content is NOT scanned');
    }
  }
  return 0;
}

const PUBLICATION_EXACT_RANGE_DETECTOR = 'publication-guard';
const PUBLICATION_EXACT_RANGE_OWNER = 'publication-decision-owner';
const PUBLICATION_EXACT_RANGE_VALIDITY_MS = 5 * 60 * 1000;
const MAX_PUBLICATION_EXACT_RANGE_FINDINGS = 4_096;
const FULL_OID = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true });
const PUBLICATION_MODULE_PATH = fileURLToPath(import.meta.url);
const PUBLICATION_TOOL_PATHS = Object.freeze([
  { id: 'publication-guard.ts', path: PUBLICATION_MODULE_PATH },
  { id: 'git-input-core.ts', path: fileURLToPath(new URL('./lib/ci-control/git-input-core.ts', import.meta.url)) },
  { id: 'git-input.ts', path: fileURLToPath(new URL('./lib/ci-control/git-input.ts', import.meta.url)) },
  { id: 'exact-range-provenance.ts', path: fileURLToPath(new URL('./lib/ci-control/exact-range-provenance.ts', import.meta.url)) },
  { id: 'guard-core.ts', path: fileURLToPath(new URL('./lib/guard-core.ts', import.meta.url)) },
  { id: 'boundary-run/shared.ts', path: fileURLToPath(new URL('./lib/verification/boundary-run/shared.ts', import.meta.url)) },
  { id: 'boundary-run/schema.ts', path: fileURLToPath(new URL('./lib/verification/boundary-run/schema.ts', import.meta.url)) },
  { id: 'boundary-run/contracts.ts', path: fileURLToPath(new URL('./lib/verification/boundary-run/contracts.ts', import.meta.url)) },
  { id: 'boundary-run/model.ts', path: fileURLToPath(new URL('./lib/verification/boundary-run/model.ts', import.meta.url)) },
  { id: 'boundary-run/worktree.ts', path: fileURLToPath(new URL('./lib/verification/boundary-run/worktree.ts', import.meta.url)) },
  { id: 'src/lib/git-env.ts', path: fileURLToPath(new URL('../src/lib/git-env.ts', import.meta.url)) },
  { id: 'src/lib/type-guards.ts', path: fileURLToPath(new URL('../src/lib/type-guards.ts', import.meta.url)) },
]);
const PUBLICATION_GUARD_CORE_PATH = fileURLToPath(new URL('./lib/guard-core.ts', import.meta.url));
const PUBLICATION_POLICY_PROJECTION_COVERAGE = Object.freeze([
  'baseline-materialization-budget',
  'baseline-same-path-exact-text',
  'documentation-email-exception-routing',
  'is-text-candidate-routing',
  'normalize-repo-path-routing',
  'operational-identifier-exception-routing',
  'path-transition-entire-new-blob',
  'private-pattern-catalog',
  'scan-text-for-private-literals',
] as const);
const PUBLICATION_EXACT_RANGE_LIMITATIONS = Object.freeze([
  'aggregate-authorization-unavailable',
  'changed-content-only',
  'executor-platform-unavailable',
  'finding-fingerprint-unavailable',
  'markdown-reference-validation-unavailable',
  'precondition-receipt-unavailable',
  'producer-authentication-unavailable',
  'publication-audit-validation-unavailable',
  'release-classification-unavailable',
  'report-only',
  'terminal-attempt-process-group-unavailable',
  'workspace-ignored-document-observation-unavailable',
] as const);

export const MAX_PUBLICATION_BASELINE_BLOB_BYTES = MAX_EXACT_SINGLE_BLOB_BYTES;
export const MAX_PUBLICATION_PATH_TRANSITION_BLOB_BYTES = MAX_EXACT_SINGLE_BLOB_BYTES;
const MAX_PUBLICATION_BASELINE_AGGREGATE_BYTES = MAX_EXACT_AGGREGATE_BLOB_BYTES;
const MAX_PUBLICATION_BASELINE_BLOB_LINES = 100_000;
const MAX_PUBLICATION_BASELINE_AGGREGATE_LINES = 200_000;
const MAX_PUBLICATION_PATH_TRANSITION_BLOB_LINES = 100_000;

export interface PublicationExactRangeInputV1 {
  baseOid: string;
  remoteOid: string | null;
  localOid: string;
}

export interface PublicationExactRangeFindingV1 {
  cause: string;
  observationKind: 'net-added-line' | 'history-added-line';
  commitOid: string;
  parentOid: string;
  path: null;
  pathDisclosure: 'redacted';
  line: number;
  blob: null;
  blobDisclosure: 'redacted';
}

export interface PublicationExactRangeCommitBindingV1 {
  oid: string;
  parentOids: string[];
  treeOid: string;
  metadataSha256: `sha256:${string}`;
}

export interface PublicationExactRangeReceiptV1 {
  schemaVersion: 1;
  detectorId: typeof PUBLICATION_EXACT_RANGE_DETECTOR;
  decisionOwner: typeof PUBLICATION_EXACT_RANGE_OWNER;
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
  commitBindings: PublicationExactRangeCommitBindingV1[];
  commitRangeDigest: `sha256:${string}`;
  metadataDigest: `sha256:${string}`;
  observedPathDisclosure: 'all-redacted';
  observedPathDigest: `sha256:${string}`;
  observedBlobDisclosure: 'all-redacted';
  observedBlobCount: number;
  observedBlobDigest: `sha256:${string}`;
  budget: ExactAddedLineBudgetAccountingV1;
  claimedScope: {
    content: 'net-range-private-literal-additions';
    history: 'per-parent-private-literal-additions';
    paths: 'all-redacted';
  };
  observedScope: {
    commitCount: number;
    parentEdgeCount: number;
    changeCount: number;
    observedPathCount: number;
  };
  nativeCauses: string[];
  findings: PublicationExactRangeFindingV1[];
  limitations: string[];
  createdAt: string;
  validUntil: string;
}

export interface PublicationExactRangeArtifactV1 {
  payloadBytes: Uint8Array;
  binding: {
    schemaVersion: 1;
    detectorId: typeof PUBLICATION_EXACT_RANGE_DETECTOR;
    payloadByteLength: number;
    payloadSha256: `sha256:${string}`;
  };
}

export interface PublicationExactRangeExpectedV1 extends PublicationExactRangeInputV1 {
  currentToolDigest: string;
  currentPolicyDigest: string;
  expectedPayloadByteLength: number;
  expectedPayloadSha256: string;
}

export type PublicationExactRangeErrorCode =
  | 'publication.exact-range.input-malformed'
  | 'publication.exact-range.evidence-unavailable'
  | 'publication.exact-range.budget'
  | 'publication.exact-range.identity-mismatch'
  | 'publication.exact-range.tool-drift'
  | 'publication.exact-range.policy-drift'
  | 'publication.exact-range.receipt-invalid'
  | 'publication.exact-range.receipt-binding-mismatch'
  | 'publication.exact-range.receipt-stale'
  | 'publication.exact-range.tool-mismatch'
  | 'publication.exact-range.policy-mismatch';

export type PublicationExactRangeBuildResultV1 =
  | { ok: true; artifact: PublicationExactRangeArtifactV1 }
  | { ok: false; error: { code: PublicationExactRangeErrorCode } };

export type PublicationExactRangeValidationResultV1 =
  | { ok: true; receipt: PublicationExactRangeReceiptV1 }
  | { ok: false; error: { code: PublicationExactRangeErrorCode } };

function publicationExactRangeFailure(
  code: PublicationExactRangeErrorCode,
): { ok: false; error: { code: PublicationExactRangeErrorCode } } {
  return { ok: false, error: { code } };
}

function publicationStrictRecord(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> | null {
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
    const expected = [...expectedKeys].sort();
    if ([...keys].sort().some((key, index) => key !== expected[index])) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) return null;
    }
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function publicationStrictArray(value: unknown, maxLength: number): unknown[] | null {
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

function validatePublicationExactRangeInput(value: unknown): PublicationExactRangeInputV1 | null {
  const record = publicationStrictRecord(value, ['baseOid', 'remoteOid', 'localOid']);
  if (
    record === null
    || typeof record.baseOid !== 'string'
    || !FULL_OID.test(record.baseOid)
    || (record.remoteOid !== null && (typeof record.remoteOid !== 'string' || !FULL_OID.test(record.remoteOid)))
    || typeof record.localOid !== 'string'
    || !FULL_OID.test(record.localOid)
  ) return null;
  return { baseOid: record.baseOid, remoteOid: record.remoteOid as string | null, localOid: record.localOid };
}

function publicationSha256Bytes(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function publicationSha256Canonical(value: unknown): `sha256:${string}` {
  return publicationSha256Bytes(Buffer.from(canonicalizeBoundaryRun(value), 'utf8'));
}

function publicationToolProjection(): unknown {
  return {
    schemaVersion: 1,
    sources: PUBLICATION_TOOL_PATHS.map((source) => {
      const bytes = readFileSync(source.path);
      return {
        id: source.id,
        byteLength: bytes.byteLength,
        sha256: publicationSha256Bytes(bytes),
      };
    }),
  };
}

export function canonicalPublicationToolProjection(): string {
  return canonicalizeBoundaryRun(publicationToolProjection());
}

export function currentPublicationToolDigest(): `sha256:${string}` {
  return publicationSha256Bytes(Buffer.from(canonicalPublicationToolProjection(), 'utf8'));
}

function publicationPolicyProjection(): unknown {
  return {
    schemaVersion: 1,
    guardCoreDigest: publicationSha256Bytes(readFileSync(PUBLICATION_GUARD_CORE_PATH)),
    privatePatterns: privatePatterns.map((pattern) => ({
      code: pattern.code,
      description: pattern.description,
      source: pattern.regex.source,
      flags: pattern.regex.flags,
    })),
    exceptionPolicy: {
      operationalReleaseHygieneFiles: [...operationalReleaseHygieneFiles].sort(),
      documentationEmailFixtureImplementation: isDocumentationEmailFixture.toString(),
      operationalProtocolTokenImplementation: isOperationalProtocolToken.toString(),
    },
    historyPolicy: {
      baselineSuppression: 'range-start-same-path-exact-text',
      scope: 'private-literal-additions-only',
    },
    materializationBudget: {
      baselineAggregateBlobBytes: MAX_PUBLICATION_BASELINE_AGGREGATE_BYTES,
      baselineAggregateLines: MAX_PUBLICATION_BASELINE_AGGREGATE_LINES,
      baselineSingleBlobBytes: MAX_PUBLICATION_BASELINE_BLOB_BYTES,
      baselineSingleBlobLines: MAX_PUBLICATION_BASELINE_BLOB_LINES,
      pathTransitionSingleBlobBytes: MAX_PUBLICATION_PATH_TRANSITION_BLOB_BYTES,
      pathTransitionSingleBlobLines: MAX_PUBLICATION_PATH_TRANSITION_BLOB_LINES,
    },
    liveRouteCoverage: [...PUBLICATION_POLICY_PROJECTION_COVERAGE],
    liveRouteImplementations: {
      baselineMaterialization: publicationBaseLineSets.toString(),
      blobLineCount: publicationBlobLineCount.toString(),
      blobTextByteCount: publicationBlobTextByteCount.toString(),
      documentationEmailException: isAllowedNonMailboxEmailLine.toString(),
      isTextCandidate: isTextCandidate.toString(),
      normalizeRepoPath: normalizeRepoPath.toString(),
      operationalIdentifierException: isOperationalUnitLine.toString(),
      pathTransitionRouting: publicationPathTransitionLinesWithinBudget.toString(),
      preflightBlob: preflightPublicationBlob.toString(),
      scanTextForPrivateLiterals: scanTextForPrivateLiterals.toString(),
    },
  };
}

export function canonicalPublicationPolicyProjection(): string {
  return canonicalizeBoundaryRun(publicationPolicyProjection());
}

export function currentPublicationPolicyDigest(): `sha256:${string}` {
  return publicationSha256Bytes(Buffer.from(canonicalPublicationPolicyProjection(), 'utf8'));
}

export function publicationPolicyProjectionCoverage(): string[] {
  return [...PUBLICATION_POLICY_PROJECTION_COVERAGE];
}

function mapPublicationExactRangeError(error: unknown): PublicationExactRangeErrorCode {
  if (error instanceof ExactGitInputError) {
    if (error.code.endsWith('-budget') || error.code.endsWith('.budget')) return 'publication.exact-range.budget';
    if (error.code.endsWith('-identity-mismatch') || error.code.endsWith('.identity-mismatch')) {
      return 'publication.exact-range.identity-mismatch';
    }
  }
  return 'publication.exact-range.evidence-unavailable';
}

function copyPublicationBudget(budget: ExactAddedLineBudgetV1): ExactAddedLineBudgetV1 {
  return {
    changeCount: budget.changeCount,
    sourceBlobBytes: budget.sourceBlobBytes,
    sourceLineCount: budget.sourceLineCount,
    patchBytes: budget.patchBytes,
    addedLineCount: budget.addedLineCount,
    addedTextBytes: budget.addedTextBytes,
  };
}

function publicationBudgetAccounting(
  limit: ExactAddedLineBudgetV1,
  remaining: ExactAddedLineBudgetV1,
): ExactAddedLineBudgetAccountingV1 {
  const consumed = {} as ExactAddedLineBudgetV1;
  for (const key of Object.keys(limit) as Array<keyof ExactAddedLineBudgetV1>) {
    consumed[key] = limit[key] - remaining[key];
  }
  return { limit: copyPublicationBudget(limit), consumed, remaining: copyPublicationBudget(remaining) };
}

interface PublicationHistoryCandidate {
  cause: string;
  commitOid: string;
  parentOid: string;
  path: string;
  line: number;
  blobOid: string;
  text: string;
}

function publicationNativeCauseCodes(): ReadonlySet<string> {
  return new Set(privatePatterns.map((pattern) => pattern.code));
}

function publicationLineCauses(path: string, text: string): string[] {
  return scanTextForPrivateLiterals(path, text).map((issue) => issue.code);
}

function publicationBlobLineCount(bytes: Uint8Array): number {
  if (bytes.byteLength === 0) return 0;
  let lineCount = bytes[bytes.byteLength - 1] === 0x0a ? 0 : 1;
  for (const byte of bytes) {
    if (byte === 0) throw new ExactGitInputError('ci.input.blob-set-malformed', 'ci.input.blob-set-malformed');
    if (byte === 0x0a) lineCount += 1;
  }
  return lineCount;
}

function preflightPublicationBlob(
  bytes: Uint8Array,
  maxBytes: number,
  maxLines: number,
): { byteLength: number; lineCount: number } {
  if (bytes.byteLength > maxBytes) {
    throw new ExactGitInputError('ci.input.blob-set-budget', 'ci.input.blob-set-budget');
  }
  const lineCount = publicationBlobLineCount(bytes);
  if (lineCount > maxLines) {
    throw new ExactGitInputError('ci.input.blob-set-budget', 'ci.input.blob-set-budget');
  }
  return { byteLength: bytes.byteLength, lineCount };
}

function publicationBaseLineSets(
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
  const preflights = new Map<string, { byteLength: number; lineCount: number }>();
  let aggregateBytes = 0;
  let aggregateLines = 0;
  for (const blob of blobs.values()) {
    const preflight = preflightPublicationBlob(
      blob.bytes,
      MAX_PUBLICATION_BASELINE_BLOB_BYTES,
      MAX_PUBLICATION_BASELINE_BLOB_LINES,
    );
    aggregateBytes += preflight.byteLength;
    aggregateLines += preflight.lineCount;
    if (
      aggregateBytes > MAX_PUBLICATION_BASELINE_AGGREGATE_BYTES
      || aggregateLines > MAX_PUBLICATION_BASELINE_AGGREGATE_LINES
    ) throw new ExactGitInputError('ci.input.blob-set-budget', 'ci.input.blob-set-budget');
    preflights.set(blob.oid, preflight);
  }
  const lineSetsByOid = new Map<string, Set<string>>();
  for (const blob of blobs.values()) {
    if (preflights.get(blob.oid) === undefined) {
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
    lineSetsByOid.set(blob.oid, new Set(rows.map((row, index) => (
      (index < rows.length - 1 || decoded.endsWith('\n')) && row.endsWith('\r') ? row.slice(0, -1) : row
    ))));
  }
  for (const entry of entries.entries) {
    if (entry.presence === 'absent') {
      result.set(entry.path, new Set());
      continue;
    }
    const lines = lineSetsByOid.get(entry.objectOid!);
    if (lines === undefined) {
      throw new ExactGitInputError('ci.input.blob-set-malformed', 'ci.input.blob-set-malformed');
    }
    result.set(entry.path, lines);
  }
  return result;
}

function comparePublicationFindings(
  left: PublicationExactRangeFindingV1,
  right: PublicationExactRangeFindingV1,
): number {
  return [left.cause, left.observationKind, left.commitOid, left.parentOid, String(left.line)]
    .join('\0')
    .localeCompare([right.cause, right.observationKind, right.commitOid, right.parentOid, String(right.line)].join('\0'));
}

function appendPublicationFinding(
  findings: PublicationExactRangeFindingV1[],
  projectedKeys: Set<string>,
  finding: PublicationExactRangeFindingV1,
): void {
  const key = canonicalizeBoundaryRun(finding);
  if (projectedKeys.has(key)) return;
  if (findings.length >= MAX_PUBLICATION_EXACT_RANGE_FINDINGS) {
    throw new ExactGitInputError('ci.input.added-lines.budget', 'ci.input.added-lines.budget');
  }
  projectedKeys.add(key);
  findings.push(finding);
}

function appendPublicationRawKey(rawKeys: Set<string>, key: string): boolean {
  if (rawKeys.has(key)) return false;
  if (rawKeys.size >= MAX_PUBLICATION_EXACT_RANGE_FINDINGS) {
    throw new ExactGitInputError('ci.input.added-lines.budget', 'ci.input.added-lines.budget');
  }
  rawKeys.add(key);
  return true;
}

function publicationBlobTextByteCount(bytes: Uint8Array): number {
  let textBytes = 0;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] === 0x0a) continue;
    if (bytes[index] === 0x0d && bytes[index + 1] === 0x0a) continue;
    textBytes += 1;
  }
  return textBytes;
}

function publicationPathTransitionLinesWithinBudget(
  cwd: string,
  change: ExactChangeWithAddedLinesV1,
  budget: ExactAddedLineBudgetV1,
): {
  applicable: boolean;
  lines: Array<{ path: string; newBlobOid: string; newLineNumber: number; text: string }>;
  remaining: ExactAddedLineBudgetV1;
} {
  if (
    change.oldPath === null
    || change.oldPath === change.path
    || (change.status !== 'copied' && change.status !== 'renamed')
  ) return { applicable: false, lines: [], remaining: copyPublicationBudget(budget) };
  const [blob] = readExactBlobs(cwd, [change.newOid]);
  if (blob === undefined) {
    throw new ExactGitInputError('ci.input.blob-set-malformed', 'ci.input.blob-set-malformed');
  }
  const preflight = preflightPublicationBlob(
    blob.bytes,
    MAX_PUBLICATION_PATH_TRANSITION_BLOB_BYTES,
    MAX_PUBLICATION_PATH_TRANSITION_BLOB_LINES,
  );
  const primitiveLines = new Map<number, string>();
  let primitiveTextBytes = 0;
  for (const line of change.addedLines) {
    if (
      line.path !== change.path
      || line.newBlobOid !== change.newOid
      || line.newLineNumber < 1
      || line.newLineNumber > preflight.lineCount
      || primitiveLines.has(line.newLineNumber)
    ) throw new ExactGitInputError('ci.input.blob-set-malformed', 'ci.input.blob-set-malformed');
    primitiveLines.set(line.newLineNumber, line.text);
    primitiveTextBytes += Buffer.byteLength(line.text, 'utf8');
  }
  const sourceBlobBytes = change.oldOid === change.newOid ? preflight.byteLength : 0;
  const sourceLineCount = change.oldOid === change.newOid ? preflight.lineCount : 0;
  const extraLineCount = preflight.lineCount - primitiveLines.size;
  const totalTextBytes = publicationBlobTextByteCount(blob.bytes);
  if (
    sourceBlobBytes > budget.sourceBlobBytes
    || sourceLineCount > budget.sourceLineCount
    || extraLineCount > budget.addedLineCount
    || totalTextBytes > primitiveTextBytes + budget.addedTextBytes
  ) throw new ExactGitInputError('ci.input.added-lines.budget', 'ci.input.added-lines.budget');
  let decoded: string;
  try {
    decoded = UTF8_FATAL.decode(blob.bytes);
  } catch {
    throw new ExactGitInputError('ci.input.added-lines.invalid-utf8', 'ci.input.added-lines.invalid-utf8');
  }
  const rawRows = decoded === '' ? [] : decoded.split('\n');
  if (decoded.endsWith('\n')) rawRows.pop();
  const rows = rawRows.map((row, index) => (
    (index < rawRows.length - 1 || decoded.endsWith('\n')) && row.endsWith('\r') ? row.slice(0, -1) : row
  ));
  if (rows.length !== preflight.lineCount) {
    throw new ExactGitInputError('ci.input.blob-set-malformed', 'ci.input.blob-set-malformed');
  }
  let extraTextBytes = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const lineNumber = index + 1;
    const primitiveText = primitiveLines.get(lineNumber);
    if (primitiveText !== undefined) {
      if (primitiveText !== rows[index]) {
        throw new ExactGitInputError('ci.input.blob-set-malformed', 'ci.input.blob-set-malformed');
      }
    } else {
      extraTextBytes += Buffer.byteLength(rows[index]!, 'utf8');
    }
  }
  if (extraTextBytes > budget.addedTextBytes) {
    throw new ExactGitInputError('ci.input.added-lines.budget', 'ci.input.added-lines.budget');
  }
  return {
    applicable: true,
    lines: rows.map((text, index) => ({
      path: change.path,
      newBlobOid: change.newOid,
      newLineNumber: index + 1,
      text,
    })),
    remaining: {
      ...copyPublicationBudget(budget),
      sourceBlobBytes: budget.sourceBlobBytes - sourceBlobBytes,
      sourceLineCount: budget.sourceLineCount - sourceLineCount,
      addedLineCount: budget.addedLineCount - extraLineCount,
      addedTextBytes: budget.addedTextBytes - extraTextBytes,
    },
  };
}

function observePublicationChanges(
  changes: readonly ExactChangeWithAddedLinesV1[],
  observedPaths: Set<string>,
  observedBlobOids: Set<string>,
): void {
  for (const change of changes) {
    observedPaths.add(change.path);
    if (change.oldPath !== null) observedPaths.add(change.oldPath);
    if (change.oldOid !== '0'.repeat(40)) observedBlobOids.add(change.oldOid);
    if (change.newOid !== '0'.repeat(40)) observedBlobOids.add(change.newOid);
  }
}

function deepFreezePublication<T>(value: T): T {
  if (typeof value !== 'object' || value === null || ArrayBuffer.isView(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreezePublication(nested);
  return Object.freeze(value);
}

export function createPublicationExactRangeArtifact(
  cwd: string,
  input: PublicationExactRangeInputV1,
): PublicationExactRangeBuildResultV1 {
  const validated = validatePublicationExactRangeInput(input);
  if (validated === null) return publicationExactRangeFailure('publication.exact-range.input-malformed');
  try {
    const initialToolProjection = canonicalPublicationToolProjection();
    const initialToolDigest = publicationSha256Bytes(Buffer.from(initialToolProjection, 'utf8'));
    const initialPolicyProjection = canonicalPublicationPolicyProjection();
    const initialPolicyDigest = publicationSha256Bytes(Buffer.from(initialPolicyProjection, 'utf8'));
    const range = readExactCommitRange(cwd, validated);
    const metadataByOid = new Map(
      readExactCommitMetadata(cwd, range.commits.map((commit) => commit.oid).sort())
        .map((metadata) => [metadata.oid, metadata]),
    );
    const commitBindings: PublicationExactRangeCommitBindingV1[] = [];
    for (const commit of range.commits) {
      const metadata = metadataByOid.get(commit.oid);
      if (
        metadata === undefined
        || metadata.parentOids.length !== commit.parentOids.length
        || metadata.parentOids.some((parentOid, index) => parentOid !== commit.parentOids[index])
      ) return publicationExactRangeFailure('publication.exact-range.identity-mismatch');
      commitBindings.push({
        oid: commit.oid,
        parentOids: [...commit.parentOids],
        treeOid: metadata.treeOid,
        metadataSha256: metadata.contentSha256,
      });
    }

    const limit = copyPublicationBudget(MAX_EXACT_ADDED_LINE_BUDGET_V1);
    let remaining = copyPublicationBudget(limit);
    let totalChangeCount = 0;
    let parentEdgeCount = 0;
    const observedPaths = new Set<string>();
    const observedBlobOids = new Set<string>();
    const findings: PublicationExactRangeFindingV1[] = [];
    const projectedKeys = new Set<string>();
    const rawKeys = new Set<string>();
    const netContentKeys = new Set<string>();

    const net = readExactAddedLinesWithinBudget(cwd, {
      baseOid: range.rangeStartOid,
      candidateOid: range.localOid,
      budget: remaining,
    });
    remaining = copyPublicationBudget(net.accounting.remaining);
    totalChangeCount += net.changes.length;
    observePublicationChanges(net.changes, observedPaths, observedBlobOids);
    for (const change of net.changes) {
      if (!isTextCandidate(change.path)) continue;
      const transition = publicationPathTransitionLinesWithinBudget(cwd, change, remaining);
      remaining = transition.remaining;
      const lines = transition.applicable ? transition.lines : change.addedLines;
      for (const line of lines) {
        for (const cause of publicationLineCauses(line.path, line.text)) {
          const contentKey = `${cause}\0${line.path}\0${line.text}`;
          netContentKeys.add(contentKey);
          appendPublicationRawKey(rawKeys, `net\0${contentKey}\0${line.newLineNumber}`);
          appendPublicationFinding(findings, projectedKeys, {
            cause,
            observationKind: 'net-added-line',
            commitOid: range.localOid,
            parentOid: range.rangeStartOid,
            path: null,
            pathDisclosure: 'redacted',
            line: line.newLineNumber,
            blob: null,
            blobDisclosure: 'redacted',
          });
        }
      }
    }

    const historyCandidates: PublicationHistoryCandidate[] = [];
    for (const commit of range.commits) {
      for (const parentOid of commit.parentOids) {
        parentEdgeCount += 1;
        const edge = readExactAddedLinesWithinBudget(cwd, {
          baseOid: parentOid,
          candidateOid: commit.oid,
          budget: remaining,
        });
        remaining = copyPublicationBudget(edge.accounting.remaining);
        totalChangeCount += edge.changes.length;
        observePublicationChanges(edge.changes, observedPaths, observedBlobOids);
        for (const change of edge.changes) {
          if (!isTextCandidate(change.path)) continue;
          const transition = publicationPathTransitionLinesWithinBudget(cwd, change, remaining);
          remaining = transition.remaining;
          const lines = transition.applicable ? transition.lines : change.addedLines;
          for (const line of lines) {
            for (const cause of publicationLineCauses(line.path, line.text)) {
              const rawKey = `history\0${cause}\0${commit.oid}\0${parentOid}\0${line.path}\0${line.newLineNumber}\0${line.text}`;
              if (!appendPublicationRawKey(rawKeys, rawKey)) continue;
              if (historyCandidates.length >= MAX_PUBLICATION_EXACT_RANGE_FINDINGS) {
                throw new ExactGitInputError('ci.input.added-lines.budget', 'ci.input.added-lines.budget');
              }
              historyCandidates.push({
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
        }
      }
    }

    const baselinePaths = [...new Set(historyCandidates.map((candidate) => candidate.path))].sort();
    const baselines = publicationBaseLineSets(cwd, range.rangeStartOid, baselinePaths);
    for (const candidate of historyCandidates) {
      if (baselines.get(candidate.path)?.has(candidate.text)) continue;
      if (netContentKeys.has(`${candidate.cause}\0${candidate.path}\0${candidate.text}`)) continue;
      appendPublicationFinding(findings, projectedKeys, {
        cause: candidate.cause,
        observationKind: 'history-added-line',
        commitOid: candidate.commitOid,
        parentOid: candidate.parentOid,
        path: null,
        pathDisclosure: 'redacted',
        line: candidate.line,
        blob: null,
        blobDisclosure: 'redacted',
      });
    }
    findings.sort(comparePublicationFindings);

    const terminalToolProjection = canonicalPublicationToolProjection();
    if (terminalToolProjection !== initialToolProjection) {
      return publicationExactRangeFailure('publication.exact-range.tool-drift');
    }
    const terminalPolicyProjection = canonicalPublicationPolicyProjection();
    if (terminalPolicyProjection !== initialPolicyProjection) {
      return publicationExactRangeFailure('publication.exact-range.policy-drift');
    }
    const created = Date.now();
    const nativeCauses = [...new Set(findings.map((finding) => finding.cause))].sort();
    const payload: PublicationExactRangeReceiptV1 = {
      schemaVersion: 1,
      detectorId: PUBLICATION_EXACT_RANGE_DETECTOR,
      decisionOwner: PUBLICATION_EXACT_RANGE_OWNER,
      authorization: 'report-only',
      outcome: findings.length === 0 ? 'pass' : 'block',
      exitCode: findings.length === 0 ? 0 : 1,
      completeness: 'complete',
      baseOid: range.baseOid,
      remoteOid: range.remoteOid,
      rangeStartOid: range.rangeStartOid,
      localOid: range.localOid,
      toolDigest: initialToolDigest,
      policyDigest: initialPolicyDigest,
      commitBindings,
      commitRangeDigest: publicationSha256Canonical(range),
      metadataDigest: publicationSha256Canonical(commitBindings),
      observedPathDisclosure: 'all-redacted',
      observedPathDigest: publicationSha256Canonical({
        schemaVersion: 1,
        disclosure: 'all-redacted',
        count: observedPaths.size,
      }),
      observedBlobDisclosure: 'all-redacted',
      observedBlobCount: observedBlobOids.size,
      observedBlobDigest: publicationSha256Canonical({
        schemaVersion: 1,
        disclosure: 'all-redacted',
        count: observedBlobOids.size,
      }),
      budget: publicationBudgetAccounting(limit, remaining),
      claimedScope: {
        content: 'net-range-private-literal-additions',
        history: 'per-parent-private-literal-additions',
        paths: 'all-redacted',
      },
      observedScope: {
        commitCount: range.commits.length,
        parentEdgeCount,
        changeCount: totalChangeCount,
        observedPathCount: observedPaths.size,
      },
      nativeCauses,
      findings,
      limitations: [...PUBLICATION_EXACT_RANGE_LIMITATIONS],
      createdAt: new Date(created).toISOString(),
      validUntil: new Date(created + PUBLICATION_EXACT_RANGE_VALIDITY_MS).toISOString(),
    };
    const payloadBytes = Uint8Array.from(Buffer.from(canonicalizeBoundaryRun(payload), 'utf8'));
    return {
      ok: true,
      artifact: {
        payloadBytes,
        binding: Object.freeze({
          schemaVersion: 1 as const,
          detectorId: PUBLICATION_EXACT_RANGE_DETECTOR,
          payloadByteLength: payloadBytes.byteLength,
          payloadSha256: publicationSha256Bytes(payloadBytes),
        }),
      },
    };
  } catch (error) {
    return publicationExactRangeFailure(mapPublicationExactRangeError(error));
  }
}

function publicationSafeInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && !Object.is(value, -0)
    && value >= 0
    && value <= max;
}

function validatePublicationBudgetRecord(value: unknown): ExactAddedLineBudgetV1 | null {
  const keys: Array<keyof ExactAddedLineBudgetV1> = [
    'changeCount', 'sourceBlobBytes', 'sourceLineCount', 'patchBytes', 'addedLineCount', 'addedTextBytes',
  ];
  const record = publicationStrictRecord(value, keys);
  if (record === null) return null;
  const result = {} as ExactAddedLineBudgetV1;
  for (const key of keys) {
    if (!publicationSafeInteger(record[key], MAX_EXACT_ADDED_LINE_BUDGET_V1[key])) return null;
    result[key] = record[key];
  }
  return result;
}

function validatePublicationBudgetAccounting(value: unknown): ExactAddedLineBudgetAccountingV1 | null {
  const record = publicationStrictRecord(value, ['limit', 'consumed', 'remaining']);
  if (record === null) return null;
  const limit = validatePublicationBudgetRecord(record.limit);
  const consumed = validatePublicationBudgetRecord(record.consumed);
  const remaining = validatePublicationBudgetRecord(record.remaining);
  if (limit === null || consumed === null || remaining === null) return null;
  for (const key of Object.keys(limit) as Array<keyof ExactAddedLineBudgetV1>) {
    if (limit[key] !== MAX_EXACT_ADDED_LINE_BUDGET_V1[key] || consumed[key] + remaining[key] !== limit[key]) return null;
  }
  return { limit, consumed, remaining };
}

function validatePublicationStringArray(value: unknown, maxLength: number): string[] | null {
  const array = publicationStrictArray(value, maxLength);
  if (array === null || array.some((item) => typeof item !== 'string')) return null;
  const strings = array as string[];
  if (strings.some((item, index) => index > 0 && strings[index - 1]! >= item)) return null;
  return strings;
}

function validatePublicationCommitBindings(value: unknown): PublicationExactRangeCommitBindingV1[] | null {
  const array = publicationStrictArray(value, 4_096);
  if (array === null) return null;
  const result: PublicationExactRangeCommitBindingV1[] = [];
  const seen = new Set<string>();
  for (const item of array) {
    const record = publicationStrictRecord(item, ['oid', 'parentOids', 'treeOid', 'metadataSha256']);
    const parents = record === null ? null : publicationStrictArray(record.parentOids, 8_192);
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

function validatePublicationFindings(value: unknown): PublicationExactRangeFindingV1[] | null {
  const array = publicationStrictArray(value, MAX_PUBLICATION_EXACT_RANGE_FINDINGS);
  if (array === null) return null;
  const result: PublicationExactRangeFindingV1[] = [];
  for (const item of array) {
    const record = publicationStrictRecord(item, [
      'cause', 'observationKind', 'commitOid', 'parentOid', 'path', 'pathDisclosure', 'line', 'blob',
      'blobDisclosure',
    ]);
    if (
      record === null
      || typeof record.cause !== 'string'
      || !publicationNativeCauseCodes().has(record.cause)
      || (record.observationKind !== 'net-added-line' && record.observationKind !== 'history-added-line')
      || typeof record.commitOid !== 'string'
      || !FULL_OID.test(record.commitOid)
      || typeof record.parentOid !== 'string'
      || !FULL_OID.test(record.parentOid)
      || record.path !== null
      || record.pathDisclosure !== 'redacted'
      || !publicationSafeInteger(record.line, MAX_EXACT_ADDED_LINE_SOURCE_LINE_COUNT)
      || record.line < 1
      || record.blob !== null
      || record.blobDisclosure !== 'redacted'
    ) return null;
    result.push(record as unknown as PublicationExactRangeFindingV1);
  }
  const sorted = [...result].sort(comparePublicationFindings);
  if (result.some((finding, index) => comparePublicationFindings(finding, sorted[index]!) !== 0)) return null;
  return result;
}

function validatePublicationExactRangeReceipt(value: unknown): PublicationExactRangeReceiptV1 | null {
  const record = publicationStrictRecord(value, [
    'schemaVersion', 'detectorId', 'decisionOwner', 'authorization', 'outcome', 'exitCode', 'completeness',
    'baseOid', 'remoteOid', 'rangeStartOid', 'localOid', 'toolDigest', 'policyDigest', 'commitBindings',
    'commitRangeDigest', 'metadataDigest', 'observedPathDisclosure', 'observedPathDigest',
    'observedBlobDisclosure', 'observedBlobCount', 'observedBlobDigest', 'budget', 'claimedScope',
    'observedScope', 'nativeCauses', 'findings', 'limitations', 'createdAt', 'validUntil',
  ]);
  if (record === null) return null;
  const commitBindings = validatePublicationCommitBindings(record.commitBindings);
  const findings = validatePublicationFindings(record.findings);
  const nativeCauses = validatePublicationStringArray(record.nativeCauses, MAX_PUBLICATION_EXACT_RANGE_FINDINGS);
  const budget = validatePublicationBudgetAccounting(record.budget);
  const claimedScope = publicationStrictRecord(record.claimedScope, ['content', 'history', 'paths']);
  const observedScope = publicationStrictRecord(record.observedScope, [
    'commitCount', 'parentEdgeCount', 'changeCount', 'observedPathCount',
  ]);
  const limitations = publicationStrictArray(record.limitations, PUBLICATION_EXACT_RANGE_LIMITATIONS.length);
  if (
    record.schemaVersion !== 1
    || record.detectorId !== PUBLICATION_EXACT_RANGE_DETECTOR
    || record.decisionOwner !== PUBLICATION_EXACT_RANGE_OWNER
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
    || record.observedBlobDisclosure !== 'all-redacted'
    || !publicationSafeInteger(record.observedBlobCount, MAX_EXACT_ADDED_LINE_BUDGET_V1.changeCount * 2)
    || typeof record.observedBlobDigest !== 'string'
    || !SHA256.test(record.observedBlobDigest)
    || commitBindings === null
    || findings === null
    || nativeCauses === null
    || budget === null
    || claimedScope === null
    || claimedScope.content !== 'net-range-private-literal-additions'
    || claimedScope.history !== 'per-parent-private-literal-additions'
    || claimedScope.paths !== 'all-redacted'
    || observedScope === null
    || !publicationSafeInteger(observedScope.commitCount, 4_096)
    || !publicationSafeInteger(observedScope.parentEdgeCount, 8_192)
    || !publicationSafeInteger(observedScope.changeCount, MAX_EXACT_ADDED_LINE_BUDGET_V1.changeCount)
    || !publicationSafeInteger(observedScope.observedPathCount, MAX_EXACT_ADDED_LINE_BUDGET_V1.changeCount * 2)
    || observedScope.commitCount !== commitBindings.length
    || limitations === null
    || limitations.length !== PUBLICATION_EXACT_RANGE_LIMITATIONS.length
    || limitations.some((limitation, index) => limitation !== PUBLICATION_EXACT_RANGE_LIMITATIONS[index])
    || typeof record.createdAt !== 'string'
    || typeof record.validUntil !== 'string'
  ) return null;
  if (record.observedPathDigest !== publicationSha256Canonical({
    schemaVersion: 1,
    disclosure: 'all-redacted',
    count: observedScope.observedPathCount,
  })) return null;
  if (record.observedBlobDigest !== publicationSha256Canonical({
    schemaVersion: 1,
    disclosure: 'all-redacted',
    count: record.observedBlobCount,
  })) return null;
  const causes = [...new Set(findings.map((finding) => finding.cause))].sort();
  const emptyRange = commitBindings.length === 0 && record.localOid === record.rangeStartOid;
  const consumedValues = Object.values(budget.consumed);
  if (
    nativeCauses.length !== causes.length
    || nativeCauses.some((cause, index) => cause !== causes[index])
    || (findings.length === 0) !== (record.outcome === 'pass')
    || observedScope.changeCount !== budget.consumed.changeCount
    || observedScope.parentEdgeCount !== commitBindings.reduce((total, binding) => total + binding.parentOids.length, 0)
    || (observedScope.changeCount === 0 && (
      observedScope.observedPathCount !== 0
      || record.observedBlobCount !== 0
    ))
    || (observedScope.changeCount > 0 && (
      observedScope.observedPathCount === 0
      || record.observedBlobCount === 0
    ))
    || observedScope.observedPathCount > observedScope.changeCount * 2
    || record.observedBlobCount > observedScope.changeCount * 2
    || (findings.length > 0 && (
      observedScope.changeCount === 0
      || observedScope.observedPathCount === 0
      || record.observedBlobCount === 0
    ))
    || (emptyRange && (
      record.outcome !== 'pass'
      || record.exitCode !== 0
      || findings.length !== 0
      || nativeCauses.length !== 0
      || observedScope.commitCount !== 0
      || observedScope.parentEdgeCount !== 0
      || observedScope.changeCount !== 0
      || observedScope.observedPathCount !== 0
      || record.observedBlobCount !== 0
      || consumedValues.some((consumed) => consumed !== 0)
    ))
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
    if (finding.observationKind === 'net-added-line') {
      if (finding.commitOid !== record.localOid || finding.parentOid !== record.rangeStartOid) return null;
    } else {
      const binding = bindingByOid.get(finding.commitOid);
      if (binding === undefined || !binding.parentOids.includes(finding.parentOid)) return null;
    }
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
  if (
    publicationSha256Canonical(reconstructedRange) !== record.commitRangeDigest
    || publicationSha256Canonical(commitBindings) !== record.metadataDigest
  ) return null;
  const created = Date.parse(record.createdAt);
  const validUntil = Date.parse(record.validUntil);
  if (
    !Number.isSafeInteger(created)
    || !Number.isSafeInteger(validUntil)
    || validUntil - created !== PUBLICATION_EXACT_RANGE_VALIDITY_MS
    || new Date(created).toISOString() !== record.createdAt
    || new Date(validUntil).toISOString() !== record.validUntil
  ) return null;
  return record as unknown as PublicationExactRangeReceiptV1;
}

export function validatePublicationExactRangeArtifact(
  artifact: PublicationExactRangeArtifactV1,
  expected: PublicationExactRangeExpectedV1,
): PublicationExactRangeValidationResultV1 {
  try {
    const artifactRecord = publicationStrictRecord(artifact, ['payloadBytes', 'binding']);
    const expectedRecord = publicationStrictRecord(expected, [
      'baseOid', 'remoteOid', 'localOid', 'currentToolDigest', 'currentPolicyDigest',
      'expectedPayloadByteLength', 'expectedPayloadSha256',
    ]);
    const expectedLineage = expectedRecord === null ? null : validatePublicationExactRangeInput({
      baseOid: expectedRecord.baseOid,
      remoteOid: expectedRecord.remoteOid,
      localOid: expectedRecord.localOid,
    });
    const binding = artifactRecord === null ? null : publicationStrictRecord(artifactRecord.binding, [
      'schemaVersion', 'detectorId', 'payloadByteLength', 'payloadSha256',
    ]);
    const bytes = artifactRecord?.payloadBytes;
    const provenance = expectedRecord === null
      ? 'receipt-invalid'
      : validateExactRangeProvenance(
        expectedRecord.currentToolDigest,
        expectedRecord.currentPolicyDigest,
        currentPublicationToolDigest(),
        currentPublicationPolicyDigest(),
      );
    if (
      artifactRecord === null
      || expectedRecord === null
      || expectedLineage === null
      || !publicationSafeInteger(expectedRecord.expectedPayloadByteLength, 4 * 1024 * 1024)
      || typeof expectedRecord.expectedPayloadSha256 !== 'string'
      || !SHA256.test(expectedRecord.expectedPayloadSha256)
      || binding === null
      || binding.schemaVersion !== 1
      || binding.detectorId !== PUBLICATION_EXACT_RANGE_DETECTOR
      || !publicationSafeInteger(binding.payloadByteLength, 4 * 1024 * 1024)
      || typeof binding.payloadSha256 !== 'string'
      || !SHA256.test(binding.payloadSha256)
    ) return publicationExactRangeFailure('publication.exact-range.receipt-invalid');
    if (provenance !== 'valid') {
      return publicationExactRangeFailure(`publication.exact-range.${provenance}`);
    }
    if (
      binding.payloadByteLength !== expectedRecord.expectedPayloadByteLength
      || binding.payloadSha256 !== expectedRecord.expectedPayloadSha256
    ) return publicationExactRangeFailure('publication.exact-range.receipt-binding-mismatch');
    if (
      !(bytes instanceof Uint8Array)
      || utilTypes.isProxy(bytes)
      || bytes.byteLength !== binding.payloadByteLength
      || bytes.byteLength === 0
      || publicationSha256Bytes(bytes) !== binding.payloadSha256
    ) return publicationExactRangeFailure('publication.exact-range.receipt-invalid');
    const parsed = parseBoundaryJsonBytes(bytes);
    if (!parsed.result.ok || parsed.value === null || parsed.text === null) {
      return publicationExactRangeFailure('publication.exact-range.receipt-invalid');
    }
    if (parsed.text !== canonicalizeBoundaryRun(parsed.value)) {
      return publicationExactRangeFailure('publication.exact-range.receipt-invalid');
    }
    const receipt = validatePublicationExactRangeReceipt(parsed.value);
    if (receipt === null) return publicationExactRangeFailure('publication.exact-range.receipt-invalid');
    if (
      receipt.baseOid !== expectedLineage.baseOid
      || receipt.remoteOid !== expectedLineage.remoteOid
      || receipt.localOid !== expectedLineage.localOid
    ) return publicationExactRangeFailure('publication.exact-range.identity-mismatch');
    if (receipt.toolDigest !== expectedRecord.currentToolDigest) {
      return publicationExactRangeFailure('publication.exact-range.tool-mismatch');
    }
    if (receipt.policyDigest !== expectedRecord.currentPolicyDigest) {
      return publicationExactRangeFailure('publication.exact-range.policy-mismatch');
    }
    const now = Date.now();
    if (now < Date.parse(receipt.createdAt) || now > Date.parse(receipt.validUntil)) {
      return publicationExactRangeFailure('publication.exact-range.receipt-stale');
    }
    return { ok: true, receipt: deepFreezePublication(receipt) };
  } catch {
    return publicationExactRangeFailure('publication.exact-range.receipt-invalid');
  }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = runPublicationGuard();
}
