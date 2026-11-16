/**
 * Public-boundary scanning for the repository hygiene guard (one check, several inputs).
 *
 * Shared by scripts/repo-hygiene-guard.ts (its --tree, --text and --refs modes and the term
 * rules every other mode adds), scripts/pre-push-guard.ts (pushed ref names) and
 * scripts/pr-metadata-guard.ts (PR title and body). It holds:
 *
 * - the single finding formatter: it accepts only a location and a rule code and prints a
 *   static message chosen by code, so no output path can carry matched text, a term id or a
 *   term value;
 * - the rule sets: generic boundary rules (secret, contact and path shapes), the inline
 *   fallback rules, and the term rules loaded from the private term file;
 * - the text and ref-name scans;
 * - the whole-tree scan of HEAD and its per-file, per-code baseline.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { cleanGitEnv, git } from './guard-core.ts';
import {
  addedLinePatterns,
  commitMessagePatterns,
  disallowedCommitAuthorPatterns,
  findDisallowedMatch,
  isFixtureFile,
  patternMatches,
  projectedFileSecretFixtureFileSet,
  projectedFileSecretPatterns,
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
 * Generic boundary codes: secret, contact and home-path shapes that need no term file. The
 * whole-tree, text and ref scans use these plus the private-name codes; the hygiene-only codes
 * (focused tests, console calls, planning labels and the like) stay with the diff scans.
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
// The single finding formatter
// ---------------------------------------------------------------------------

export interface FindingLocation {
  /** A repository path, or a source label such as `commit-msg`, `text`, `refs` or `commit:<sha>`. */
  readonly file: string;
  /** 1-based line. Absent for a file-level finding, such as a hit in a tracked path name. */
  readonly line?: number;
  /** For a history finding: the commit that added the line (hex; anything else is dropped). */
  readonly history?: { readonly kind: 'history' | 'branch history'; readonly commit: string };
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

/** First 16 hex characters of sha256(path): the baseline key and the printed form of a private path. */
export function pathKey(filePath: string): string {
  return createHash('sha256').update(filePath, 'utf8').digest('hex').slice(0, 16);
}

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
    return `${where} ${safeCode}: ${history}${RULE_MESSAGES.get(safeCode) ?? 'See the rule code.'}`;
  };
}

// ---------------------------------------------------------------------------
// Free text (--text, PR title and body) and ref names (--refs, pre-push)
// ---------------------------------------------------------------------------

export interface BoundaryHit {
  readonly source: string;
  readonly line: number;
  readonly code: string;
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
  const hits: BoundaryHit[] = [];
  text.split(/\r?\n/).forEach((row, index) => {
    for (const code of boundaryCodesInLine(TEXT_PATH_LABEL, row, patterns)) {
      hits.push({ source, line: index + 1, code });
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

// ---------------------------------------------------------------------------
// Whole tree (--tree) and its baseline
// ---------------------------------------------------------------------------

export const BOUNDARY_BASELINE_PATH = 'scripts/boundary-baseline.json';
export const BOUNDARY_BASELINE_SCHEMA_VERSION = 1;
export const BOUNDARY_BASELINE_NOTE =
  'Public-boundary hits already in the tree, per file and rule code. A file key is the first 16 hex '
  + 'characters of sha256 of its path. Counts may only fall: npm run guard:repo:tree:write-baseline '
  + 'rewrites this file and refuses to raise a count or add a file entry compared with origin/main. '
  + 'On a merge conflict in this file, take the side from main, then run '
  + 'npm run guard:repo:tree:write-baseline, which can only lower counts.';
const WRITE_BASELINE_COMMAND = 'npm run guard:repo:tree:write-baseline';

export interface BoundaryBaseline {
  /** False when no baseline file exists at the ref read. */
  readonly present: boolean;
  readonly termsSha256: string | null;
  readonly files: ReadonlyMap<string, ReadonlyMap<string, number>>;
}

const EMPTY_BASELINE: BoundaryBaseline = Object.freeze({ present: false, termsSha256: null, files: new Map() });

/** A baseline that cannot be read or parsed; the tree check is then inconclusive (exit 2). */
export class BoundaryBaselineError extends Error {}

/** The tree cannot be scanned (no HEAD, no tracked files, unreadable objects): exit 2. */
export class TreeScanInconclusive extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseBoundaryBaseline(text: string): BoundaryBaseline {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw new BoundaryBaselineError(`${BOUNDARY_BASELINE_PATH} is not valid JSON`);
  }
  const header = isRecord(document) ? document.header : undefined;
  const fileEntries = isRecord(document) ? document.files : undefined;
  if (!isRecord(header) || !isRecord(fileEntries)) {
    throw new BoundaryBaselineError(`${BOUNDARY_BASELINE_PATH} must hold a header object and a files object`);
  }
  if (header.schemaVersion !== BOUNDARY_BASELINE_SCHEMA_VERSION) {
    throw new BoundaryBaselineError(`${BOUNDARY_BASELINE_PATH} header.schemaVersion must be ${BOUNDARY_BASELINE_SCHEMA_VERSION}`);
  }
  const termsSha256 = header.termsSha256;
  if (termsSha256 !== null && (typeof termsSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(termsSha256))) {
    throw new BoundaryBaselineError(`${BOUNDARY_BASELINE_PATH} header.termsSha256 must be null or 64 hex characters`);
  }
  const files = new Map<string, Map<string, number>>();
  for (const [key, codes] of Object.entries(fileEntries)) {
    if (!/^[0-9a-f]{16}$/.test(key) || !isRecord(codes)) {
      throw new BoundaryBaselineError(`${BOUNDARY_BASELINE_PATH} has a malformed file entry`);
    }
    const counts = new Map<string, number>();
    for (const [code, count] of Object.entries(codes)) {
      if (!RULE_CODE.test(code) || typeof count !== 'number' || !Number.isSafeInteger(count) || count <= 0) {
        throw new BoundaryBaselineError(`${BOUNDARY_BASELINE_PATH} has a malformed count under #${key}`);
      }
      counts.set(code, count);
    }
    files.set(key, counts);
  }
  return { present: true, termsSha256: termsSha256 as string | null, files };
}

export function serializeBoundaryBaseline(baseline: BoundaryBaseline): string {
  const files: Record<string, Record<string, number>> = {};
  for (const key of [...baseline.files.keys()].sort()) {
    const counts = baseline.files.get(key)!;
    const entries = [...counts].filter(([, count]) => count > 0).sort(([left], [right]) => left.localeCompare(right));
    if (entries.length > 0) files[key] = Object.fromEntries(entries);
  }
  const document = {
    header: {
      schemaVersion: BOUNDARY_BASELINE_SCHEMA_VERSION,
      note: BOUNDARY_BASELINE_NOTE,
      termsSha256: baseline.termsSha256,
    },
    files,
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** Sum of every count: the ordinal debt weight scripts/lib/baseline-weight.ts compares. */
export function boundaryBaselineWeight(baseline: BoundaryBaseline): number {
  let total = 0;
  for (const counts of baseline.files.values()) for (const count of counts.values()) total += count;
  return total;
}

function refHasCommit(cwd: string, ref: string): boolean {
  try {
    git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd);
    return true;
  } catch {
    return false;
  }
}

/** The baseline committed at `ref`; an absent ref or file reads as an empty baseline. */
export function readBoundaryBaselineAt(cwd: string, ref: string): BoundaryBaseline {
  if (!refHasCommit(cwd, ref)) return EMPTY_BASELINE;
  if (git(['ls-tree', '--full-tree', ref, '--', BOUNDARY_BASELINE_PATH], cwd).trim() === '') return EMPTY_BASELINE;
  return parseBoundaryBaseline(git(['show', `${ref}:${BOUNDARY_BASELINE_PATH}`], cwd));
}

interface TreeEntry {
  readonly path: string;
  readonly oid: string;
  readonly size: number;
}

const BLOB_BATCH_BYTES = 32 * 1024 * 1024;
const MAX_BLOB_BYTES = 128 * 1024 * 1024;

function listHeadBlobs(cwd: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const record of git(['ls-tree', '-r', '-z', '-l', '--full-tree', 'HEAD'], cwd, 120_000).split('\0')) {
    if (record === '') continue;
    const match = /^(\d{6}) (\S+) ([0-9a-f]{40,64}) +(\d+|-)\t([\s\S]+)$/.exec(record);
    if (match === null) throw new TreeScanInconclusive('git ls-tree output is malformed');
    // Gitlinks (submodule commits) have no content in this tree.
    if (match[2] !== 'blob') continue;
    entries.push({ path: match[5]!, oid: match[3]!, size: Number(match[4]) });
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

// A whole-blob test is a superset of the per-line test once `$` and `^` may match at line
// breaks, so blobs that cannot hit a rule skip line splitting entirely.
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

/** Combined prefilters for the term rules, one per flag set. Rules with backreferences or named groups test alone. */
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

/** path -> rule code -> hit lines (0 = the path name itself). */
export type TreeHits = ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<number>>>;

export interface TreeScan {
  readonly trackedPaths: readonly string[];
  readonly textFileCount: number;
  readonly hits: TreeHits;
}

function addHit(hits: Map<string, Map<string, Set<number>>>, filePath: string, code: string, line: number): void {
  let codes = hits.get(filePath);
  if (codes === undefined) {
    codes = new Map();
    hits.set(filePath, codes);
  }
  let lines = codes.get(code);
  if (lines === undefined) {
    lines = new Set();
    codes.set(code, lines);
  }
  lines.add(line);
}

function scanTreeContent(
  filePath: string,
  text: string,
  patterns: readonly GuardPattern[],
  termRules: readonly PrivateTermRule[],
  termFilters: readonly RegExp[],
  hits: Map<string, Map<string, Set<number>>>,
): void {
  let rows: string[] | null = null;
  const scan = (pattern: GuardPattern, allowlisted: boolean): void => {
    if (!blobPrefilter(pattern.regex).test(text)) return;
    rows ??= text.split(/\r?\n/);
    rows.forEach((row, index) => {
      const hit = allowlisted
        ? findDisallowedMatch(filePath, pattern, row) !== null
        : patternMatches(pattern, row).length > 0;
      if (hit) addHit(hits, filePath, pattern.code, index + 1);
    });
  };
  // The fixture allow-list works as in the diff scans: fixture files are exempt, except that
  // the projected-file fixtures still may not carry literal provider-key or key-block shapes.
  if (isFixtureFile(filePath)) {
    if (projectedFileSecretFixtureFileSet.has(filePath)) {
      for (const pattern of projectedFileSecretPatterns) scan(pattern, false);
    }
    return;
  }
  for (const pattern of patterns) scan(pattern, true);
  if (termRules.length > 0 && termFilters.some((filter) => filter.test(text))) {
    for (const rule of termRules) scan(rule, true);
  }
}

/** Scan every tracked blob at HEAD (read from git, never the working tree) and every tracked path name. */
export function scanHeadTree(cwd: string, termRules: readonly PrivateTermRule[]): TreeScan {
  if (!refHasCommit(cwd, 'HEAD')) throw new TreeScanInconclusive('HEAD has no commit');
  const entries = listHeadBlobs(cwd);
  if (entries.length === 0) throw new TreeScanInconclusive('HEAD tracks no files');
  const blobs = readBlobs(cwd, entries);
  const patterns = [...genericBoundaryPatterns, ...fallbackPrivatePatterns];
  const termFilters = termPrefilters(termRules);
  const hits = new Map<string, Map<string, Set<number>>>();
  let textFileCount = 0;
  for (const entry of entries) {
    for (const code of boundaryCodesInLine(entry.path, entry.path, [...patterns, ...termRules])) {
      addHit(hits, entry.path, code, 0);
    }
    const bytes = blobs.get(entry.oid);
    if (bytes === undefined) throw new TreeScanInconclusive('a tracked blob could not be read');
    if (bytes.includes(0)) continue;
    textFileCount += 1;
    scanTreeContent(entry.path, bytes.toString('utf8'), patterns, termRules, termFilters, hits);
  }
  return { trackedPaths: entries.map((entry) => entry.path), textFileCount, hits };
}

/** `full`: the baseline was built from the loaded term file. `generic`: no term file, or a different one. */
export type TreeCompareMode = 'full' | 'generic';

export interface BaselineDelta {
  readonly kind: 'rise' | 'new-file' | 'fall';
  readonly key: string;
  /** Real path from the current tree; null when the file no longer exists. */
  readonly path: string | null;
  readonly code: string;
  readonly baseline: number;
  readonly current: number;
}

/**
 * Compare a tree scan with a baseline, per file and per rule code.
 *
 * In `generic` mode the counts a term rule could have raised are unknown: codes shared with the
 * fallback rules fail only on a rise or a new file entry (a fallback-only count can only sit at
 * or below a term-built count), and term-only codes are skipped. Generic codes always compare
 * in both directions.
 */
export function compareTreeToBaseline(scan: TreeScan, baseline: BoundaryBaseline, mode: TreeCompareMode): BaselineDelta[] {
  const compared = (code: string): boolean => mode === 'full' || !TERM_ONLY_CODES.has(code);
  const fallCompared = (code: string): boolean => mode === 'full' || GENERIC_BOUNDARY_CODES.has(code);
  const deltas: BaselineDelta[] = [];
  for (const [filePath, codes] of scan.hits) {
    const key = pathKey(filePath);
    const entry = baseline.files.get(key);
    for (const [code, lines] of codes) {
      if (!compared(code)) continue;
      const current = lines.size;
      const before = entry?.get(code) ?? 0;
      if (entry === undefined) deltas.push({ kind: 'new-file', key, path: filePath, code, baseline: 0, current });
      else if (current > before) deltas.push({ kind: 'rise', key, path: filePath, code, baseline: before, current });
      else if (current < before && fallCompared(code)) {
        deltas.push({ kind: 'fall', key, path: filePath, code, baseline: before, current });
      }
    }
  }
  const pathsByKey = new Map(scan.trackedPaths.map((filePath) => [pathKey(filePath), filePath] as const));
  for (const [key, codes] of baseline.files) {
    const filePath = pathsByKey.get(key) ?? null;
    const current = filePath === null ? undefined : scan.hits.get(filePath);
    for (const [code, before] of codes) {
      if (!compared(code) || !fallCompared(code)) continue;
      if ((current?.get(code)?.size ?? 0) === 0) {
        deltas.push({ kind: 'fall', key, path: filePath, code, baseline: before, current: 0 });
      }
    }
  }
  return deltas.sort((left, right) =>
    `${left.path ?? left.key}\0${left.code}`.localeCompare(`${right.path ?? right.key}\0${right.code}`));
}

/**
 * The baseline a write produces. `full` rebuilds every count from the scan and binds the loaded
 * term file. `generic` (no term file) rewrites the generic counts only and keeps every count a
 * term rule could have produced, and termsSha256, from the current baseline.
 */
export function nextBoundaryBaseline(
  scan: TreeScan,
  mode: TreeCompareMode,
  termsSha256: string | null,
  current: BoundaryBaseline,
): BoundaryBaseline {
  const files = new Map<string, Map<string, number>>();
  for (const [filePath, codes] of scan.hits) {
    const counts = new Map<string, number>();
    for (const [code, lines] of codes) {
      if (mode === 'full' || GENERIC_BOUNDARY_CODES.has(code)) counts.set(code, lines.size);
    }
    files.set(pathKey(filePath), counts);
  }
  if (mode === 'full') return { present: true, termsSha256, files };
  for (const [key, codes] of current.files) {
    for (const [code, count] of codes) {
      if (GENERIC_BOUNDARY_CODES.has(code)) continue;
      let counts = files.get(key);
      if (counts === undefined) {
        counts = new Map();
        files.set(key, counts);
      }
      counts.set(code, count);
    }
  }
  return { present: true, termsSha256: current.termsSha256, files };
}

export interface BaselineIncrease {
  readonly key: string;
  readonly code: string;
  readonly before: number;
  readonly after: number;
}

/** Every count `next` raises above `reference`, including any file entry `reference` lacks. */
export function boundaryBaselineIncreases(next: BoundaryBaseline, reference: BoundaryBaseline): BaselineIncrease[] {
  const increases: BaselineIncrease[] = [];
  for (const [key, codes] of next.files) {
    const entry = reference.files.get(key);
    for (const [code, after] of codes) {
      if (after <= 0) continue;
      const before = entry?.get(code) ?? 0;
      if (entry === undefined || after > before) increases.push({ key, code, before, after });
    }
  }
  return increases.sort((left, right) => `${left.key}\0${left.code}`.localeCompare(`${right.key}\0${right.code}`));
}

export interface TreeCheckOptions {
  readonly writeBaseline: boolean;
  readonly allowIncrease: boolean;
}

const TREE_ABSENT_LINE =
  'repo hygiene tree: private term file absent; comparing only the generic codes (codes shared with the fallback rules fail only on a rise)';
const TREE_MISMATCH_LINE =
  'repo hygiene tree: the private term file differs from the one scripts/boundary-baseline.json was built from; comparing only the generic and fallback codes';

function printDelta(delta: BaselineDelta, scan: TreeScan, format: FindingFormatter): void {
  const label = delta.path ?? `#${delta.key}`;
  const head = format({ file: label }, delta.code);
  if (delta.kind === 'fall') {
    console.error(`${head} (count fell from ${delta.baseline} to ${delta.current}; run ${WRITE_BASELINE_COMMAND} and commit ${BOUNDARY_BASELINE_PATH})`);
    return;
  }
  console.error(delta.kind === 'rise'
    ? `${head} (count rose from ${delta.baseline} to ${delta.current})`
    : `${head} (${delta.current} hit(s) in a file with no baseline entry)`);
  if (delta.path === null) return;
  const lines = [...(scan.hits.get(delta.path)?.get(delta.code) ?? [])].sort((left, right) => left - right);
  for (const line of lines) {
    console.error(`  ${format(line === 0 ? { file: delta.path } : { file: delta.path, line }, delta.code)}`);
  }
}

function writeBaseline(cwd: string, scan: TreeScan, mode: TreeCompareMode, terms: BoundaryTerms, head: BoundaryBaseline, allowIncrease: boolean): number {
  const next = nextBoundaryBaseline(scan, mode, terms.load.sha256, head);
  if (!allowIncrease) {
    const increases = boundaryBaselineIncreases(next, readBoundaryBaselineAt(cwd, 'origin/main'));
    if (increases.length > 0) {
      for (const { key, code, before, after } of increases) {
        console.error(`repo hygiene tree: refusing to raise #${key} ${code} from ${before} to ${after} compared with origin/main`);
      }
      console.error(`repo hygiene tree: ${increases.length} count(s) would rise; ${BOUNDARY_BASELINE_PATH} was not written (only a term-list revision or the first baseline passes --allow-increase)`);
      return 1;
    }
  }
  const target = path.join(cwd, BOUNDARY_BASELINE_PATH);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, serializeBoundaryBaseline(next));
  const entries = [...next.files.values()].filter((counts) => counts.size > 0).length;
  console.log(
    `repo hygiene tree: wrote ${BOUNDARY_BASELINE_PATH} (${entries} file entries, weight ${boundaryBaselineWeight(next)}, `
      + `${mode === 'full' ? 'term rules included' : 'generic codes rewritten, term-affected counts kept'})`,
  );
  return 0;
}

/** Run --tree or --tree --write-baseline. Returns the exit code: 0 clean, 1 differences or refusal, 2 inconclusive. */
export function runTreeCheck(cwd: string, terms: BoundaryTerms, options: TreeCheckOptions): number {
  try {
    if (!refHasCommit(cwd, 'HEAD')) throw new TreeScanInconclusive('HEAD has no commit');
    const head = readBoundaryBaselineAt(cwd, 'HEAD');
    const loaded = terms.load.status === 'loaded';
    // No baseline file means nothing was built from any term list: everything is new.
    const sameTerms = loaded && (!head.present || terms.load.sha256 === head.termsSha256);
    if (!options.writeBaseline && loaded && !sameTerms && terms.load.required) {
      console.error(
        `${TREE_MISMATCH_LINE}. WHATSOUP_REQUIRE_PRIVATE_TERMS=1 refuses that: rebuild it with ${WRITE_BASELINE_COMMAND} -- --allow-increase`,
      );
      return 2;
    }
    const mode: TreeCompareMode = options.writeBaseline ? (loaded ? 'full' : 'generic') : (sameTerms ? 'full' : 'generic');
    if (!loaded) console.error(TREE_ABSENT_LINE);
    else if (!options.writeBaseline && !sameTerms) console.error(TREE_MISMATCH_LINE);
    const scan = scanHeadTree(cwd, mode === 'full' ? terms.rules : []);
    if (options.writeBaseline) return writeBaseline(cwd, scan, mode, terms, head, options.allowIncrease);
    const format = createFindingFormatter(terms.rules);
    const deltas = compareTreeToBaseline(scan, head, mode);
    for (const delta of deltas) printDelta(delta, scan, format);
    if (deltas.length > 0) {
      console.error(`repo hygiene tree: ${deltas.length} difference(s) from ${BOUNDARY_BASELINE_PATH}`);
      return 1;
    }
    console.log(
      `repo hygiene tree passed: ${scan.trackedPaths.length} tracked path(s), ${scan.textFileCount} text file(s), `
        + `${head.files.size} baselined file entr${head.files.size === 1 ? 'y' : 'ies'}`,
    );
    return 0;
  } catch (error) {
    if (error instanceof TreeScanInconclusive) {
      console.error(`repo hygiene tree: INCONCLUSIVE — ${error.message}; a scan of no tree certifies nothing`);
      return 2;
    }
    if (error instanceof BoundaryBaselineError) {
      console.error(`repo hygiene tree: INCONCLUSIVE — ${error.message}`);
      return 2;
    }
    throw error;
  }
}
