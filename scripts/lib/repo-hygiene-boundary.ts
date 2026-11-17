/**
 * Public-boundary scanning for the repository hygiene guard (one check, several inputs).
 *
 * Shared by scripts/repo-hygiene-guard.ts (its --tree, --text and --refs modes and the term
 * rules every other mode adds), scripts/pre-push-guard.ts (pushed ref names) and
 * scripts/pr-metadata-guard.ts (PR title and body). It holds:
 *
 * - the single finding formatter: it accepts only a location and a rule code and prints a
 *   static message chosen by code, with every private match in the location masked, so no
 *   output path can carry matched text, a term id or a term value;
 * - the rule sets: generic boundary rules (secret, contact and path shapes), the inline
 *   fallback rules, and the term rules loaded from the private term file;
 * - the text and ref-name scans;
 * - the whole-tree scan of HEAD and its private per-path baseline, kept outside the repository.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { isRecord } from '../../src/lib/type-guards.ts';
import { cleanGitEnv, git } from './guard-core.ts';
import {
  addedLinePatterns,
  commitMessagePatterns,
  disallowedCommitAuthorPatterns,
  findDisallowedMatch,
  type GuardPattern,
} from './repo-hygiene-policy.ts';
import {
  PRIVATE_TERM_CODE_MESSAGES,
  PRIVATE_TERM_CODES,
  loadPrivateTerms,
  requirePrivateTermsUsable,
  type PrivateTermRule,
  type PrivateTermsLoad,
} from './private-terms.ts';

// ---------------------------------------------------------------------------
// Rule sets
// ---------------------------------------------------------------------------

/** Codes the inline fallback lists produce. They run alone without a term file and join the term rules with one. */
export const FALLBACK_PRIVATE_CODES: ReadonlySet<string> = new Set([
  'private-host-label',
  'private-instance-label',
  'private-tailnet-ip',
]);

/**
 * Generic boundary codes: secret, contact and home-path shapes that need no term file. The text
 * and ref scans use these plus the private-name codes; the whole-tree scan does not (generic
 * shapes stay with the diff modes), and the hygiene-only codes stay with the diff scans.
 */
export const GENERIC_BOUNDARY_CODES: ReadonlySet<string> = new Set([
  'anthropic-key',
  'github-token',
  'local-home-path',
  'openai-key',
  'operator-phone',
  'personal-email',
  'pinecone-key',
  'private-key',
  'secret-assignment',
  'slack-token',
  'supabase-secret',
  'twilio-account-sid',
  'whatsapp-group-jid',
  'whatsapp-user-jid',
]);

/** Codes only a term rule produces (no fallback list feeds them). */
export const TERM_ONLY_CODES: ReadonlySet<string> = new Set(
  PRIVATE_TERM_CODES.filter((code) => !FALLBACK_PRIVATE_CODES.has(code)),
);

export const fallbackPrivatePatterns: readonly GuardPattern[] = addedLinePatterns.filter((pattern) =>
  FALLBACK_PRIVATE_CODES.has(pattern.code),
);

export const genericBoundaryPatterns: readonly GuardPattern[] = addedLinePatterns.filter((pattern) =>
  GENERIC_BOUNDARY_CODES.has(pattern.code),
);

export interface BoundaryTerms {
  readonly load: PrivateTermsLoad;
  /** Empty when the term file is absent. */
  readonly rules: readonly PrivateTermRule[];
}

/**
 * Load the private term file for one scan. Throws PrivateTermsError (exit 2) for an unreadable
 * or invalid file, or for an absent file under WHATSOUP_REQUIRE_PRIVATE_TERMS=1.
 */
export function resolveBoundaryTerms(env: NodeJS.ProcessEnv): BoundaryTerms {
  const load = loadPrivateTerms(env);
  return { load, rules: requirePrivateTermsUsable(load) };
}

/** Codes of `patterns` with a disallowed match in `text`, at most once per code. */
export function boundaryCodesInLine(
  filePath: string,
  text: string,
  patterns: readonly GuardPattern[],
  alreadyReported: ReadonlySet<string> = new Set(),
): string[] {
  const codes = new Set<string>();
  for (const pattern of patterns) {
    if (codes.has(pattern.code) || alreadyReported.has(pattern.code)) continue;
    if (findDisallowedMatch(filePath, pattern, text) !== null) codes.add(pattern.code);
  }
  return [...codes];
}

// ---------------------------------------------------------------------------
// Split literals: the joined view of a line
// ---------------------------------------------------------------------------

// A quoted literal: single, double or backtick quotes (a backtick template with `${` is not one).
const QUOTED_LITERAL = [
  String.raw`'(?:[^'\\\r\n]|\\.)*'`,
  String.raw`"(?:[^"\\\r\n]|\\.)*"`,
  '`(?:[^`\\\\$\\r\\n]|\\\\.)*`',
].join('|');
const LITERAL_LIST = String.raw`\[\s*(?:${QUOTED_LITERAL})(?:\s*,\s*(?:${QUOTED_LITERAL}))+\s*,?\s*\]`;
// One call's arguments on one line, with at most one level of nested parentheses.
const CALL_ARGUMENTS = String.raw`\((?:[^()\r\n]|\([^()\r\n]*\))*\)`;
// A list the code joins where it stands: `[...].join('x')`, or `[...].map(...).join('x')`.
// Group 1 is the list, group 2 the joiner literal.
const JOINED_LIST = new RegExp(
  String.raw`(${LITERAL_LIST})\s*(?:\.map${CALL_ARGUMENTS}\s*)?\.join\(\s*(${QUOTED_LITERAL})\s*\)`,
  'g',
);
const SPLIT_CHAIN = new RegExp(String.raw`(?:${QUOTED_LITERAL})(?:\s*\+\s*(?:${QUOTED_LITERAL}))+`, 'g');
const QUOTED_PART = new RegExp(QUOTED_LITERAL, 'g');

/** The text between the quotes of each literal in `source`, escapes left as written. */
function literalParts(source: string): string[] {
  return [...source.matchAll(QUOTED_PART)].map((part) => part[0].slice(1, -1));
}

/**
 * Each run of two or more adjacent parts without a backslash, joined by `joiner`. An escape is
 * never decoded, so the part that holds one is skipped and no join spans it: `'zo\r' + 'blab'`
 * builds nothing.
 */
function joinedRuns(parts: readonly string[], joiner: string): string[] {
  const views: string[] = [];
  let run: string[] = [];
  const flush = (): void => {
    if (run.length >= 2) views.push(run.join(joiner));
    run = [];
  };
  for (const part of parts) {
    if (part.includes('\\')) flush();
    else run.push(part);
  }
  flush();
  return views;
}

/**
 * The joined view of one line, built only where the code joins: a bracketed list of two or more
 * quoted literals followed by `.join(<literal>)`, directly or after one `.map(...)`, joined with
 * that literal; and a `+` chain of quoted literals, joined with nothing. Source that stores a name
 * as short fragments joined at run time hides it from a whole-term matcher, while any reader
 * reassembles it at a glance; this view shows it to the matcher too. A list the code never joins
 * builds nothing, so ordinary data such as `['100', '1', '2', '3'].map(Number)` is never read as
 * one name.
 */
export function splitLiteralViews(line: string): string[] {
  if (!/['"`]/.test(line)) return [];
  const views = new Set<string>();
  for (const list of line.matchAll(JOINED_LIST)) {
    const joiner = literalParts(list[2]!)[0]!;
    if (joiner.includes('\\')) continue;
    for (const view of joinedRuns(literalParts(list[1]!), joiner)) views.add(view);
  }
  for (const chain of line.matchAll(SPLIT_CHAIN)) {
    for (const view of joinedRuns(literalParts(chain[0]), '')) views.add(view);
  }
  return [...views];
}

/**
 * Codes of `patterns` found only in the joined view of `text`, never one in `alreadyReported`
 * (the codes the line itself shows). Such a hit is reported with the same code and a split marker.
 */
export function splitCodesInLine(
  filePath: string,
  text: string,
  patterns: readonly GuardPattern[],
  alreadyReported: ReadonlySet<string> = new Set(),
): string[] {
  const views = splitLiteralViews(text);
  if (views.length === 0) return [];
  const codes = new Set<string>();
  for (const pattern of patterns) {
    if (codes.has(pattern.code) || alreadyReported.has(pattern.code)) continue;
    if (views.some((view) => findDisallowedMatch(filePath, pattern, view) !== null)) codes.add(pattern.code);
  }
  return [...codes];
}

// ---------------------------------------------------------------------------
// The single finding formatter
// ---------------------------------------------------------------------------

export interface FindingLocation {
  /** A repository path, or a source label such as `commit-msg`, `text`, `refs` or `commit:<sha>`. */
  readonly file: string;
  /** 1-based line. Absent for a file-level finding, such as a hit in a tracked path name. */
  readonly line?: number;
  /** For a history finding: the commit that added the line (hex; anything else is dropped). */
  readonly history?: { readonly kind: 'history' | 'branch history'; readonly commit: string };
  /** The hit appears only in the joined view of split literals on that line. */
  readonly split?: boolean;
}

const COMMIT_ID = /^[0-9a-f]{7,64}$/;

export type FindingFormatter = (location: FindingLocation, code: string) => string;

const GUARD_RULE_MESSAGES: ReadonlyArray<readonly [string, string]> = [
  ['src-console-call', 'Production source should use the structured logger instead of ad-hoc console calls.'],
  ['process-env-inheritance', 'Child processes must use an explicit allowlisted env instead of inheriting the parent environment.'],
  ['child-process-shell-true', 'Child process shell mode must not be introduced without an explicit reviewed exception.'],
  ['dynamic-code-execution', 'Dynamic code execution must not be introduced in source, scripts, or deploy code.'],
  ['unbounded-suppression', 'Lint/type suppressions must include a rationale and an expires YYYY-MM-DD marker.'],
  ['staged-sensitive-artifact', 'Runtime credential, database, key, workspace, or scratch artifact must not be committed.'],
  ['branch-sensitive-artifact', 'Runtime credential, database, key, workspace, or scratch artifact must not be committed in the branch diff.'],
  ['branch-history-sensitive-artifact', 'Runtime credential, database, key, workspace, or scratch artifact was committed in branch history.'],
];

const RULE_MESSAGES: ReadonlyMap<string, string> = new Map<string, string>([
  ...GUARD_RULE_MESSAGES,
  ...[...addedLinePatterns, ...commitMessagePatterns, ...disallowedCommitAuthorPatterns]
    .map((pattern) => [pattern.code, pattern.message] as const),
  ...Object.entries(PRIVATE_TERM_CODE_MESSAGES),
]);

const RULE_CODE = /^[a-z0-9][a-z0-9.-]*$/;

/** The printed form of every term or fallback match inside a path, a ref name or a number. */
export const PRIVATE_MASK = '<private>';

const fallbackMaskRegexes: readonly RegExp[] = fallbackPrivatePatterns.map((pattern) =>
  new RegExp(pattern.regex.source, pattern.regex.flags.includes('g') ? pattern.regex.flags : `${pattern.regex.flags}g`));

/**
 * `text` with every term match (the bare term, wherever it appears: inside a longer word or
 * outside its contexts) and every fallback match replaced by `<private>`. Spans are collected on
 * the original text and merged, so one term inside another is masked whole and no mask is
 * matched again.
 */
export function maskPrivateText(text: string, termRules: readonly PrivateTermRule[]): string {
  const spans: Array<readonly [number, number]> = [];
  for (const regex of [...termRules.map((rule) => rule.maskRegex), ...fallbackMaskRegexes]) {
    regex.lastIndex = 0;
    for (let match = regex.exec(text); match !== null; match = regex.exec(text)) {
      if (match[0] === '') regex.lastIndex += 1;
      else spans.push([match.index, match.index + match[0].length]);
    }
  }
  if (spans.length === 0) return text;
  spans.sort((left, right) => left[0] - right[0]);
  let masked = '';
  let cursor = 0;
  for (const [start, end] of spans) {
    if (end <= cursor) continue;
    if (start >= cursor) masked += `${text.slice(cursor, start)}${PRIVATE_MASK}`;
    cursor = end;
  }
  return `${masked}${text.slice(cursor)}`;
}

/**
 * The single output path for findings in every mode. It receives only a location and a rule
 * code and prints a static message chosen by code, so a caller cannot route matched text, a
 * term id or a term value to the output. A location (a path, a branch, a source label) prints
 * with every term or fallback match replaced by `<private>`.
 */
export function createFindingFormatter(termRules: readonly PrivateTermRule[]): FindingFormatter {
  return (location, code) => {
    const label = maskPrivateText(location.file, termRules);
    const where = location.line === undefined ? label : `${label}:${location.line}`;
    const safeCode = RULE_CODE.test(code) ? code : 'unknown-rule';
    const history = location.history !== undefined && COMMIT_ID.test(location.history.commit)
      ? `[${location.history.kind} ${maskPrivateText(location.history.commit, termRules)}] `
      : '';
    const split = location.split === true ? '[split] ' : '';
    return `${where} ${safeCode}: ${history}${split}${RULE_MESSAGES.get(safeCode) ?? 'See the rule code.'}`;
  };
}

// ---------------------------------------------------------------------------
// Free text (--text, PR title and body) and ref names (--refs, pre-push)
// ---------------------------------------------------------------------------

export interface BoundaryHit {
  readonly source: string;
  readonly line: number;
  readonly code: string;
  /** Found only in the joined view of split literals. */
  readonly split?: boolean;
}

/** Generic boundary rules plus the fallback and term rules. */
export function publicTextPatterns(termRules: readonly PrivateTermRule[]): GuardPattern[] {
  return [...genericBoundaryPatterns, ...fallbackPrivatePatterns, ...termRules];
}

// Free text is not a tracked file: the path-scoped allowances (fixtures, operational files)
// never apply to it, while reserved documentation-domain email fixtures stay allowed, as they
// are in tracked content.
const TEXT_PATH_LABEL = '<text>';
const REF_PATH_LABEL = '<refs>';

/** Scan free text (a PR title or body, an issue, a comment), one hit per line and code. */
export function scanPublicText(source: string, text: string, termRules: readonly PrivateTermRule[]): BoundaryHit[] {
  const patterns = publicTextPatterns(termRules);
  const splitPatterns = [...fallbackPrivatePatterns, ...termRules];
  const hits: BoundaryHit[] = [];
  text.split(/\r?\n/).forEach((row, index) => {
    const codes = boundaryCodesInLine(TEXT_PATH_LABEL, row, patterns);
    for (const code of codes) hits.push({ source, line: index + 1, code });
    for (const code of splitCodesInLine(TEXT_PATH_LABEL, row, splitPatterns, new Set(codes))) {
      hits.push({ source, line: index + 1, code, split: true });
    }
  });
  return hits;
}

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ZERO_OBJECT_ID = /^0+$/;

/**
 * Ref names per input line. A line is either one ref name or a pre-push hook line
 * (`<local ref> <local oid> <remote ref> <remote oid>`). A deletion line is skipped: removing a
 * privately named remote ref is the remedy, not a leak.
 */
export function refNamesByLine(input: string): Array<{ line: number; names: string[] }> {
  const result: Array<{ line: number; names: string[] }> = [];
  input.split(/\r?\n/).forEach((row, index) => {
    const trimmed = row.trim();
    if (trimmed === '') return;
    const fields = trimmed.split(/\s+/);
    if (fields.length === 4 && OBJECT_ID.test(fields[1]!) && OBJECT_ID.test(fields[3]!)) {
      if (ZERO_OBJECT_ID.test(fields[1]!)) return;
      result.push({ line: index + 1, names: [fields[0]!, fields[2]!] });
      return;
    }
    result.push({ line: index + 1, names: [trimmed] });
  });
  return result;
}

/**
 * Scan ref names with the private-name rules: the term rules plus the inline fallback rules,
 * so a ref named after a fallback label is still caught where no term file exists.
 */
export function scanRefNames(input: string, termRules: readonly PrivateTermRule[]): BoundaryHit[] {
  const patterns = [...fallbackPrivatePatterns, ...termRules];
  const hits: BoundaryHit[] = [];
  for (const { line, names } of refNamesByLine(input)) {
    const reported = new Set<string>();
    for (const name of names) {
      for (const code of boundaryCodesInLine(REF_PATH_LABEL, name, patterns, reported)) {
        reported.add(code);
        hits.push({ source: 'refs', line, code });
      }
    }
  }
  return hits;
}

/**
 * Rule codes in one path name: the fallback rules, then the term rules. The tree scan counts them
 * for every tracked path name, and the hosted candidate check for every added or renamed one.
 */
export function pathNameCodes(
  filePath: string,
  termRules: readonly PrivateTermRule[],
): Array<{ readonly origin: CountOrigin; readonly code: string }> {
  const codes: Array<{ readonly origin: CountOrigin; readonly code: string }> = [];
  for (const pattern of fallbackPrivatePatterns) {
    if (findDisallowedMatch(filePath, pattern, filePath) !== null) codes.push({ origin: 'fallback', code: pattern.code });
  }
  for (const rule of termRules) {
    if (findDisallowedMatch(filePath, rule, filePath) !== null) codes.push({ origin: 'term', code: rule.code });
  }
  return codes;
}

// ---------------------------------------------------------------------------
// Whole tree (--tree) and its private baseline
// ---------------------------------------------------------------------------

export const BOUNDARY_BASELINE_FILE_ENV = 'WHATSOUP_BOUNDARY_BASELINE_FILE';
export const BOUNDARY_BASELINE_FORMAT_VERSION = 2;
export const BOUNDARY_BASELINE_NOTE =
  'Private-name hits (term rules and the inline fallback rules, counted apart) in the tree of the '
  + 'recorded commit, per repository path. This file is private: it lives outside the repository '
  + 'and is never committed. Only --tree --write-baseline writes it; raising a count, adding a '
  + 'path or a new term file needs --allow-increase.';
const WRITE_BASELINE_COMMAND = 'npm run guard:repo:tree:write-baseline';
const FIRST_BASELINE_COMMAND = `${WRITE_BASELINE_COMMAND} -- --allow-increase`;

/** The private baseline: WHATSOUP_BOUNDARY_BASELINE_FILE when set and not empty, else ~/.config/whatsoup/boundary-baseline.json. */
export function boundaryBaselinePath(env: NodeJS.ProcessEnv): string {
  const configured = env[BOUNDARY_BASELINE_FILE_ENV];
  if (configured !== undefined && configured !== '') return configured;
  const home = env.HOME !== undefined && env.HOME !== '' ? env.HOME : homedir();
  return path.join(home, '.config', 'whatsoup', 'boundary-baseline.json');
}

/** How output names the baseline file; never the resolved path, which can hold a private name. */
function boundaryBaselineLabel(env: NodeJS.ProcessEnv): string {
  const configured = env[BOUNDARY_BASELINE_FILE_ENV];
  return configured !== undefined && configured !== ''
    ? `the file named by ${BOUNDARY_BASELINE_FILE_ENV}`
    : '~/.config/whatsoup/boundary-baseline.json';
}

/** Term rules and the inline fallback lists can share a code, so their counts are kept apart. */
export type CountOrigin = 'term' | 'fallback';
/** `term:<code>` or `fallback:<code>`. */
export type CountKey = `${CountOrigin}:${string}`;

const COUNT_KEY = /^(?:term|fallback):[a-z0-9][a-z0-9.-]*$/;

export interface BoundaryBaseline {
  /** sha256 of the term file bytes the counts were built from. */
  readonly termsSha256: string;
  /** The commit whose tree the counts describe. */
  readonly commit: string;
  /** Plain repository path (the file is private) -> count key -> count. */
  readonly files: ReadonlyMap<string, ReadonlyMap<CountKey, number>>;
}

/** A baseline that cannot be read or parsed; the tree check is then inconclusive (exit 2). */
export class BoundaryBaselineError extends Error {}

/** The tree cannot be scanned (no HEAD, no tracked files, unreadable objects): exit 2. */
export class TreeScanInconclusive extends Error {}

// Messages name no path: a path can hold a private name.
export function parseBoundaryBaseline(text: string): BoundaryBaseline {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw new BoundaryBaselineError('the private baseline is not valid JSON');
  }
  const header = isRecord(document) ? document.header : undefined;
  const fileEntries = isRecord(document) ? document.files : undefined;
  if (!isRecord(header) || !isRecord(fileEntries)) {
    throw new BoundaryBaselineError('the private baseline must hold a header object and a files object');
  }
  if (header.formatVersion !== BOUNDARY_BASELINE_FORMAT_VERSION) {
    throw new BoundaryBaselineError(`the private baseline header.formatVersion must be ${BOUNDARY_BASELINE_FORMAT_VERSION}`);
  }
  if (typeof header.termsSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(header.termsSha256)) {
    throw new BoundaryBaselineError('the private baseline header.termsSha256 must be 64 hex characters');
  }
  if (typeof header.commit !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(header.commit)) {
    throw new BoundaryBaselineError('the private baseline header.commit must be a full object id');
  }
  const files = new Map<string, Map<CountKey, number>>();
  for (const [filePath, counts] of Object.entries(fileEntries)) {
    if (filePath === '' || !isRecord(counts)) throw new BoundaryBaselineError('the private baseline has a malformed path entry');
    const entry = new Map<CountKey, number>();
    for (const [key, count] of Object.entries(counts)) {
      if (!COUNT_KEY.test(key) || typeof count !== 'number' || !Number.isSafeInteger(count) || count <= 0) {
        throw new BoundaryBaselineError('the private baseline has a malformed count');
      }
      entry.set(key as CountKey, count);
    }
    files.set(filePath, entry);
  }
  return { termsSha256: header.termsSha256, commit: header.commit, files };
}

export function serializeBoundaryBaseline(baseline: BoundaryBaseline): string {
  const files: Record<string, Record<string, number>> = {};
  for (const filePath of [...baseline.files.keys()].sort()) {
    const entries = [...baseline.files.get(filePath)!]
      .filter(([, count]) => count > 0)
      .sort(([left], [right]) => left.localeCompare(right));
    if (entries.length > 0) files[filePath] = Object.fromEntries(entries);
  }
  const document = {
    header: {
      formatVersion: BOUNDARY_BASELINE_FORMAT_VERSION,
      note: BOUNDARY_BASELINE_NOTE,
      termsSha256: baseline.termsSha256,
      commit: baseline.commit,
    },
    files,
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** Sum of every count. */
export function boundaryBaselineWeight(baseline: BoundaryBaseline): number {
  let total = 0;
  for (const counts of baseline.files.values()) for (const count of counts.values()) total += count;
  return total;
}

/** The private baseline, or null when the file does not exist. */
export function readBoundaryBaseline(env: NodeJS.ProcessEnv): BoundaryBaseline | null {
  let text: string;
  try {
    text = readFileSync(boundaryBaselinePath(env), 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw new BoundaryBaselineError('the private baseline cannot be read');
  }
  return parseBoundaryBaseline(text);
}

/** Write the private baseline: the folder is created 0700, the file is written 0600 and renamed into place. */
function writeBoundaryBaseline(env: NodeJS.ProcessEnv, baseline: BoundaryBaseline): void {
  const target = boundaryBaselinePath(env);
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, serializeBoundaryBaseline(baseline), { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, target);
}

function refHasCommit(cwd: string, ref: string): boolean {
  try {
    git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd);
    return true;
  } catch {
    return false;
  }
}

function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  try {
    git(['merge-base', '--is-ancestor', ancestor, descendant], cwd);
    return true;
  } catch {
    return false;
  }
}

interface TreeEntry {
  readonly path: string;
  /** `blob` (files and symlinks) or `commit` (a gitlink, which has no content here). */
  readonly type: string;
  readonly oid: string;
  readonly size: number;
}

const BLOB_BATCH_BYTES = 32 * 1024 * 1024;
const MAX_BLOB_BYTES = 128 * 1024 * 1024;

// Every tracked entry: a gitlink has no content in this tree, but its path name is still scanned.
function listHeadEntries(cwd: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const record of git(['ls-tree', '-r', '-z', '-l', '--full-tree', 'HEAD'], cwd, 120_000).split('\0')) {
    if (record === '') continue;
    const match = /^(\d{6}) (\S+) ([0-9a-f]{40,64}) +(\d+|-)\t([\s\S]+)$/.exec(record);
    if (match === null) throw new TreeScanInconclusive('git ls-tree output is malformed');
    entries.push({ path: match[5]!, type: match[2]!, oid: match[3]!, size: match[4] === '-' ? 0 : Number(match[4]) });
  }
  return entries;
}

function parseBlobBatch(output: Buffer, requested: readonly string[], blobs: Map<string, Buffer>): void {
  let offset = 0;
  for (const oid of requested) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd < 0) throw new TreeScanInconclusive('git cat-file output ended early');
    const header = /^([0-9a-f]{40,64}) (\S+) (\d+)$/.exec(output.subarray(offset, headerEnd).toString('utf8'));
    if (header === null || header[1] !== oid || header[2] !== 'blob') {
      throw new TreeScanInconclusive('git cat-file returned an unexpected object');
    }
    const start = headerEnd + 1;
    const end = start + Number(header[3]);
    if (end > output.length) throw new TreeScanInconclusive('git cat-file output ended early');
    blobs.set(oid, output.subarray(start, end));
    offset = end + 1;
  }
}

function readBlobs(cwd: string, entries: readonly TreeEntry[]): Map<string, Buffer> {
  const sizes = new Map<string, number>();
  for (const entry of entries) sizes.set(entry.oid, entry.size);
  const blobs = new Map<string, Buffer>();
  let batch: string[] = [];
  let batchBytes = 0;
  const flush = (): void => {
    if (batch.length === 0) return;
    // No `encoding` option: the default returns a Buffer on every Node version, while
    // `encoding: 'buffer'` is rejected by Node 26 (TypeError: Unknown encoding).
    const output = execFileSync('git', ['cat-file', '--batch'], {
      cwd,
      env: cleanGitEnv(),
      input: `${batch.join('\n')}\n`,
      maxBuffer: batchBytes + batch.length * 160 + 4096,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 120_000,
    });
    parseBlobBatch(output, batch, blobs);
    batch = [];
    batchBytes = 0;
  };
  for (const [oid, size] of sizes) {
    if (size > MAX_BLOB_BYTES) throw new TreeScanInconclusive(`a tracked blob exceeds ${MAX_BLOB_BYTES} bytes`);
    if (batch.length > 0 && batchBytes + size > BLOB_BATCH_BYTES) flush();
    batch.push(oid);
    batchBytes += size;
  }
  flush();
  return blobs;
}

// A whole-blob test (with `^` and `$` matching at line breaks) finds every match a line test
// finds, unless a negative lookaround can see past the end of the line: in a blob it sees the
// next lines too (`x(?![\s\S]*y)` fails on `x\ny`). The boundary forms below test one character
// class that never holds a line break, so they stay sound; a rule with any other negative
// lookaround is tested line by line on every text file.
const SOUND_LOOKAROUNDS = ['(?<![A-Za-z0-9_])', '(?![A-Za-z0-9_])', '(?<![0-9.])', '(?![0-9]|\\.[0-9])'];

function blobPrefilterIsSound(regex: RegExp): boolean {
  let source = regex.source;
  for (const form of SOUND_LOOKAROUNDS) source = source.split(form).join('');
  return !/\(\?<?!/.test(source);
}

const blobPrefilters = new WeakMap<RegExp, RegExp>();

function blobPrefilter(regex: RegExp): RegExp {
  let prefilter = blobPrefilters.get(regex);
  if (prefilter === undefined) {
    const flags = regex.flags.replace(/[gy]/g, '');
    prefilter = new RegExp(regex.source, flags.includes('m') ? flags : `${flags}m`);
    blobPrefilters.set(regex, prefilter);
  }
  return prefilter;
}

/** Combined prefilters for sound term rules, one per flag set. Rules with backreferences or named groups test alone. */
function termPrefilters(rules: readonly PrivateTermRule[]): RegExp[] {
  const grouped = new Map<string, string[]>();
  const alone: RegExp[] = [];
  for (const rule of rules) {
    if (/\\[1-9]|\\k<|\(\?<[A-Za-z]/.test(rule.regex.source)) {
      alone.push(blobPrefilter(rule.regex));
      continue;
    }
    const flags = rule.regex.flags.replace(/[gy]/g, '');
    grouped.set(flags, [...(grouped.get(flags) ?? []), `(?:${rule.regex.source})`]);
  }
  try {
    const combined = [...grouped].map(([flags, sources]) => new RegExp(sources.join('|'), `${flags}m`));
    return [...combined, ...alone];
  } catch {
    return rules.map((rule) => blobPrefilter(rule.regex));
  }
}

/** path -> count key -> hit lines (0 = the path name itself). */
export type TreeHits = ReadonlyMap<string, ReadonlyMap<CountKey, ReadonlySet<number>>>;

export interface TreeScan {
  readonly trackedPaths: readonly string[];
  readonly textFileCount: number;
  readonly hits: TreeHits;
  /** The part of `hits` found only in a line's joined view of split literals (for the split marker). */
  readonly splitHits: TreeHits;
}

function addHit(hits: Map<string, Map<CountKey, Set<number>>>, filePath: string, key: CountKey, line: number): void {
  let keys = hits.get(filePath);
  if (keys === undefined) {
    keys = new Map();
    hits.set(filePath, keys);
  }
  let lines = keys.get(key);
  if (lines === undefined) {
    lines = new Set();
    keys.set(key, lines);
  }
  lines.add(line);
}

interface TreeRules {
  readonly soundTerms: readonly PrivateTermRule[];
  readonly lineTerms: readonly PrivateTermRule[];
  readonly termFilters: readonly RegExp[];
  /** Combined filters over every term rule, tested on the joined views of a line. */
  readonly viewFilters: readonly RegExp[];
}

// Term and fallback rules only: generic shapes stay with the diff modes, and fixture paths get
// no exemption here (a fixture is exempt from generic shapes only, never from private names).
function scanTreeContent(
  filePath: string,
  text: string,
  rules: TreeRules,
  hits: Map<string, Map<CountKey, Set<number>>>,
  splitHits: Map<string, Map<CountKey, Set<number>>>,
): void {
  let rows: string[] | null = null;
  const scan = (pattern: GuardPattern, key: CountKey, prefilter: boolean): void => {
    if (prefilter && !blobPrefilter(pattern.regex).test(text)) return;
    rows ??= text.split(/\r?\n/);
    rows.forEach((row, index) => {
      if (findDisallowedMatch(filePath, pattern, row) !== null) addHit(hits, filePath, key, index + 1);
    });
  };
  for (const pattern of fallbackPrivatePatterns) scan(pattern, `fallback:${pattern.code}`, blobPrefilterIsSound(pattern.regex));
  if (rules.soundTerms.length > 0 && rules.termFilters.some((filter) => filter.test(text))) {
    for (const rule of rules.soundTerms) scan(rule, `term:${rule.code}`, true);
  }
  for (const rule of rules.lineTerms) scan(rule, `term:${rule.code}`, false);

  // Split literals: a hit found only in a line's joined view counts under the same key; the line
  // is also kept in `splitHits` for the split marker. A whole-blob prefilter cannot see a
  // joined name, so every line that holds a quote is viewed.
  if (!/['"`]/.test(text)) return;
  rows ??= text.split(/\r?\n/);
  const termRules = [...rules.soundTerms, ...rules.lineTerms];
  rows.forEach((row, index) => {
    const views = splitLiteralViews(row);
    if (views.length === 0) return;
    const line = index + 1;
    const test = (pattern: GuardPattern, key: CountKey): void => {
      if (hits.get(filePath)?.get(key)?.has(line) === true) return;
      if (views.some((view) => findDisallowedMatch(filePath, pattern, view) !== null)) {
        addHit(hits, filePath, key, line);
        addHit(splitHits, filePath, key, line);
      }
    };
    for (const pattern of fallbackPrivatePatterns) test(pattern, `fallback:${pattern.code}`);
    if (termRules.length > 0 && views.some((view) => rules.viewFilters.some((filter) => filter.test(view)))) {
      for (const rule of termRules) test(rule, `term:${rule.code}`);
    }
  });
}

/** Scan every tracked entry at HEAD (read from git, never the working tree): each path name, and the content of each blob. */
export function scanHeadTree(cwd: string, termRules: readonly PrivateTermRule[]): TreeScan {
  if (!refHasCommit(cwd, 'HEAD')) throw new TreeScanInconclusive('HEAD has no commit');
  const entries = listHeadEntries(cwd);
  if (entries.length === 0) throw new TreeScanInconclusive('HEAD tracks no files');
  const blobs = readBlobs(cwd, entries.filter((entry) => entry.type === 'blob'));
  const soundTerms = termRules.filter((rule) => blobPrefilterIsSound(rule.regex));
  const rules: TreeRules = {
    soundTerms,
    lineTerms: termRules.filter((rule) => !blobPrefilterIsSound(rule.regex)),
    termFilters: termPrefilters(soundTerms),
    viewFilters: termPrefilters(termRules),
  };
  const hits = new Map<string, Map<CountKey, Set<number>>>();
  const splitHits = new Map<string, Map<CountKey, Set<number>>>();
  let textFileCount = 0;
  for (const entry of entries) {
    for (const { origin, code } of pathNameCodes(entry.path, termRules)) addHit(hits, entry.path, `${origin}:${code}`, 0);
    if (entry.type !== 'blob') continue;
    const bytes = blobs.get(entry.oid);
    if (bytes === undefined) throw new TreeScanInconclusive('a tracked blob could not be read');
    if (bytes.includes(0)) continue;
    textFileCount += 1;
    scanTreeContent(entry.path, bytes.toString('utf8'), rules, hits, splitHits);
  }
  return { trackedPaths: entries.map((entry) => entry.path), textFileCount, hits, splitHits };
}

export interface BaselineDelta {
  readonly kind: 'rise' | 'new-file' | 'fall';
  readonly path: string;
  readonly key: CountKey;
  readonly baseline: number;
  readonly current: number;
}

/**
 * Compare a tree scan with the private baseline, per path and count key. No baseline means every
 * path with hits is new. `compared` selects the keys that take part (only the fallback keys when
 * the term file differs from the one the baseline was built from).
 */
export function compareTreeToBaseline(
  scan: TreeScan,
  baseline: BoundaryBaseline | null,
  compared: (key: CountKey) => boolean,
): BaselineDelta[] {
  const deltas: BaselineDelta[] = [];
  for (const [filePath, keys] of scan.hits) {
    const entry = baseline?.files.get(filePath);
    for (const [key, lines] of keys) {
      if (!compared(key)) continue;
      const current = lines.size;
      const before = entry?.get(key) ?? 0;
      if (entry === undefined) deltas.push({ kind: 'new-file', path: filePath, key, baseline: 0, current });
      else if (current > before) deltas.push({ kind: 'rise', path: filePath, key, baseline: before, current });
      else if (current < before) deltas.push({ kind: 'fall', path: filePath, key, baseline: before, current });
    }
  }
  for (const [filePath, counts] of baseline?.files ?? []) {
    for (const [key, before] of counts) {
      if (compared(key) && (scan.hits.get(filePath)?.get(key)?.size ?? 0) === 0) {
        deltas.push({ kind: 'fall', path: filePath, key, baseline: before, current: 0 });
      }
    }
  }
  return deltas.sort((left, right) => `${left.path}\0${left.key}`.localeCompare(`${right.path}\0${right.key}`));
}

export interface BaselineIncrease {
  readonly path: string;
  readonly key: CountKey;
  readonly before: number;
  readonly after: number;
}

/** Every count `next` raises above `reference` (none: an empty baseline), including any path `reference` lacks. */
export function boundaryBaselineIncreases(next: BoundaryBaseline, reference: BoundaryBaseline | null): BaselineIncrease[] {
  const increases: BaselineIncrease[] = [];
  for (const [filePath, counts] of next.files) {
    const entry = reference?.files.get(filePath);
    for (const [key, after] of counts) {
      if (after <= 0) continue;
      const before = entry?.get(key) ?? 0;
      if (entry === undefined || after > before) increases.push({ path: filePath, key, before, after });
    }
  }
  return increases.sort((left, right) => `${left.path}\0${left.key}`.localeCompare(`${right.path}\0${right.key}`));
}

export interface TreeCheckOptions {
  readonly writeBaseline: boolean;
  readonly allowIncrease: boolean;
}

const TREE_SKIPPED_LINE =
  'repo hygiene tree: skipped — no private term file is present (generic shapes stay with the diff modes)';
const TREE_WRITE_WITHOUT_TERMS_LINE =
  'repo hygiene tree: the private baseline cannot be written without the private term file';
const TREE_MISMATCH_LINE =
  'repo hygiene tree: the private term file differs from the one the private baseline was built from; comparing only the fallback counts';

function codeOf(key: CountKey): string {
  return key.slice(key.indexOf(':') + 1);
}

function originOf(key: CountKey): string {
  return key.startsWith('term:') ? 'term rules' : 'fallback rules';
}

function printDelta(delta: BaselineDelta, scan: TreeScan, format: FindingFormatter): void {
  const code = codeOf(delta.key);
  const head = format({ file: delta.path }, code);
  console.error(delta.kind === 'rise'
    ? `${head} (${originOf(delta.key)}: count rose from ${delta.baseline} to ${delta.current})`
    : `${head} (${originOf(delta.key)}: ${delta.current} hit(s) in a file with no baseline entry)`);
  const lines = [...(scan.hits.get(delta.path)?.get(delta.key) ?? [])].sort((left, right) => left - right);
  const splitLines = scan.splitHits.get(delta.path)?.get(delta.key);
  for (const line of lines) {
    const location = line === 0 ? { file: delta.path } : { file: delta.path, line, split: splitLines?.has(line) === true };
    console.error(`  ${format(location, code)}`);
  }
}

function writeBaseline(
  cwd: string,
  env: NodeJS.ProcessEnv,
  terms: BoundaryTerms,
  termsSha256: string,
  current: BoundaryBaseline | null,
  allowIncrease: boolean,
): number {
  if (!refHasCommit(cwd, 'origin/main') || !isAncestor(cwd, 'origin/main', 'HEAD')) {
    console.error('repo hygiene tree: refusing to write the private baseline: origin/main is missing or is not an ancestor of HEAD; fetch and merge main first');
    return 1;
  }
  if (current !== null && current.termsSha256 !== termsSha256 && !allowIncrease) {
    console.error(
      'repo hygiene tree: refusing to write the private baseline: the private term file differs from the one it was built from; '
        + `a term-list revision rebuilds it with ${FIRST_BASELINE_COMMAND}`,
    );
    return 1;
  }
  const head = git(['rev-parse', 'HEAD'], cwd).trim();
  const scan = scanHeadTree(cwd, terms.rules);
  const files = new Map<string, Map<CountKey, number>>();
  for (const [filePath, keys] of scan.hits) {
    files.set(filePath, new Map([...keys].map(([key, lines]) => [key, lines.size] as const)));
  }
  // An entry for a path absent from HEAD's tree is dropped only when HEAD contains the commit the
  // counts describe (the file was deleted since). Otherwise HEAD may be behind that commit, and
  // the entry stays.
  if (current !== null && !isAncestor(cwd, current.commit, 'HEAD')) {
    const tracked = new Set(scan.trackedPaths);
    for (const [filePath, counts] of current.files) {
      if (!tracked.has(filePath)) files.set(filePath, new Map(counts));
    }
  }
  const next: BoundaryBaseline = { termsSha256, commit: head, files };
  if (!allowIncrease) {
    const increases = boundaryBaselineIncreases(next, current);
    if (increases.length > 0) {
      for (const { path: filePath, key, before, after } of increases) {
        console.error(`repo hygiene tree: refusing to raise ${maskPrivateText(filePath, terms.rules)} ${key} from ${before} to ${after}`);
      }
      console.error(
        `repo hygiene tree: ${increases.length} count(s) would rise; the private baseline was not written `
          + '(the first baseline and a term-list revision pass --allow-increase)',
      );
      return 1;
    }
  }
  writeBoundaryBaseline(env, next);
  console.log(
    `repo hygiene tree: wrote the private baseline (${boundaryBaselineLabel(env)}): ${files.size} path(s), `
      + `weight ${boundaryBaselineWeight(next)}, commit ${head.slice(0, 12)}`,
  );
  return 0;
}

/**
 * Run --tree or --tree --write-baseline. Returns the exit code: 0 clean (a fall passes with one
 * advisory line), 1 a rise, a new file with hits or a refused write, 2 inconclusive.
 */
export function runTreeCheck(
  cwd: string,
  terms: BoundaryTerms,
  options: TreeCheckOptions,
  env: NodeJS.ProcessEnv = process.env,
): number {
  try {
    if (terms.load.status !== 'loaded' || terms.load.sha256 === null) {
      if (options.writeBaseline) {
        console.error(TREE_WRITE_WITHOUT_TERMS_LINE);
        return 2;
      }
      console.log(TREE_SKIPPED_LINE);
      return 0;
    }
    if (!refHasCommit(cwd, 'HEAD')) throw new TreeScanInconclusive('HEAD has no commit');
    const baseline = readBoundaryBaseline(env);
    if (options.writeBaseline) {
      return writeBaseline(cwd, env, terms, terms.load.sha256, baseline, options.allowIncrease);
    }
    const sameTerms = baseline !== null && baseline.termsSha256 === terms.load.sha256;
    if (baseline !== null && !sameTerms && terms.load.required) {
      console.error(`${TREE_MISMATCH_LINE}. WHATSOUP_REQUIRE_PRIVATE_TERMS=1 refuses that: rebuild it with ${FIRST_BASELINE_COMMAND}`);
      return 2;
    }
    const scan = scanHeadTree(cwd, terms.rules);
    if (baseline === null) {
      console.error(`repo hygiene tree: no private baseline (${boundaryBaselineLabel(env)}); build the first one with ${FIRST_BASELINE_COMMAND}`);
    } else if (!sameTerms) {
      console.error(TREE_MISMATCH_LINE);
    }
    const compared = (key: CountKey): boolean => baseline === null || sameTerms || key.startsWith('fallback:');
    const deltas = compareTreeToBaseline(scan, baseline, compared);
    const failures = deltas.filter((delta) => delta.kind !== 'fall');
    const format = createFindingFormatter(terms.rules);
    for (const delta of failures) printDelta(delta, scan, format);
    const falls = deltas.length - failures.length;
    if (falls > 0) {
      console.log(`repo hygiene tree: ${falls} count(s) fell below the private baseline; ${WRITE_BASELINE_COMMAND} lowers it`);
    }
    if (failures.length > 0) {
      console.error(`repo hygiene tree: ${failures.length} rise(s) or new file(s) with private-name hits`);
      return 1;
    }
    console.log(
      `repo hygiene tree passed: ${scan.trackedPaths.length} tracked path(s), ${scan.textFileCount} text file(s), `
        + `${baseline?.files.size ?? 0} baselined path(s)`,
    );
    return 0;
  } catch (error) {
    if (error instanceof TreeScanInconclusive) {
      console.error(`repo hygiene tree: INCONCLUSIVE — ${error.message}; a scan of no tree certifies nothing`);
      return 2;
    }
    if (error instanceof BoundaryBaselineError) {
      console.error(`repo hygiene tree: INCONCLUSIVE — ${error.message} (${boundaryBaselineLabel(env)})`);
      return 2;
    }
    throw error;
  }
}
