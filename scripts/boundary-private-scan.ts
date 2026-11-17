/**
 * The hosted private boundary checks. GitHub runs this file from the default-branch commit only.
 *
 * - `boundary (private)`: after Quality completes on a pull request, bind the candidate (the
 *   Quality run's head and the tip of the pull request's base branch, read at run time), fetch
 *   its commits into a separate bare git directory and read them only as objects, scan them with
 *   the repository hygiene guard's own code and the private term file, and publish the check run
 *   on the candidate head. No file of the candidate is executed, sourced, imported, installed or
 *   used as configuration.
 * - The text check: scan issue text, comments and reviews with the code of the guard's --text mode.
 *
 * Each command runs in its own process, so the GitHub token and the term file never share one:
 *   bind --out DIR            GITHUB_TOKEN, GITHUB_REPOSITORY, QUALITY_RUN_ID, QUALITY_HEAD_SHA
 *   fetch --out DIR --remote URL
 *   scan --out DIR            WHATSOUP_PRIVATE_TERMS_FILE, WHATSOUP_REQUIRE_PRIVATE_TERMS=1
 *   publish --out DIR         GITHUB_TOKEN, GITHUB_REPOSITORY, QUALITY_HEAD_SHA
 *   collect-text --out DIR    GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_EVENT_NAME, GITHUB_EVENT_PATH
 *   scan-text --out DIR       WHATSOUP_PRIVATE_TERMS_FILE, WHATSOUP_REQUIRE_PRIVATE_TERMS=1
 *
 * Output is public: fixed lines, counts by mode and rule code, item kinds and numbers. Never a
 * matched text, a term, a path, a line of a scanned file or an error's own text.
 * Exit codes: 0 pass, 1 findings, 2 refusal or fault.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { isRecord } from '../src/lib/type-guards.ts';
import { PrivateTermsError, type PrivateTermRule } from './lib/private-terms.ts';
import { pathNameCodes, resolveBoundaryTerms, scanPublicText } from './lib/repo-hygiene-boundary.ts';
import {
  COMMIT_AUTHOR_LOG_FORMAT,
  GuardInputError,
  parseCommitAuthorLog,
  parseUnifiedDiffAddedLines,
  scanAddedLines,
  scanCommitAuthors,
  type CommitAuthor,
  type CommitTermTally,
} from './repo-hygiene-guard.ts';

export const CHECK_NAME = 'boundary (private)';
export const TEXT_WORKFLOW_FILE = 'boundary-private-text.yml';
const PREFIX = 'boundary (private):';
const TEXT_PREFIX = 'boundary text:';
const QUALITY_WORKFLOW_NAME = 'Quality';
const QUALITY_WORKFLOW_PATH = '.github/workflows/quality.yml';
const FULL_SHA = /^[0-9a-f]{40}$/;
const ZERO_SHA = /^0{40}$/;
const RULE_CODE = /^[a-z][a-z0-9-]{0,63}$/;
const BRANCH_NAME = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const DIFF_MAX_BYTES = 256 * 1024 * 1024;
const GIT_MAX_BYTES = 64 * 1024 * 1024;
const API_MAX_BYTES = 16 * 1024 * 1024;
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const SCHEDULE_OVERLAP_MS = 15 * 60 * 1000;
const SCHEDULE_DEFAULT_MS = 2 * 60 * 60 * 1000;
const TERMS_LINE = 'the private term file is missing, unreadable or invalid; the check fails closed';
const INCOMPLETE_LINE = `${PREFIX} the check could not complete; an earlier step refused its input or failed, and the run log names it. The check fails closed.`;

export const SCAN_MODES = ['added-lines', 'path-names', 'commits', 'pr-text'] as const;
export type ScanMode = (typeof SCAN_MODES)[number];

/** An input the check cannot bind or use. Its message is fixed text and is printed as is. */
export class BoundaryRefusal extends Error {}

/** A failed GitHub API request. Its message is fixed: a response body or URL can quote private data. */
class GitHubApiError extends Error {}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** The value at a key path, or undefined where any step is not an object. */
function field(value: unknown, ...keys: string[]): unknown {
  let current: unknown = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function fullSha(value: unknown, label: string): string {
  if (typeof value !== 'string' || !FULL_SHA.test(value) || ZERO_SHA.test(value)) {
    throw new BoundaryRefusal(`${label} is not a full, non-zero commit id`);
  }
  return value;
}

function positiveInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new BoundaryRefusal(`${label} is malformed`);
  return value;
}

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');

function baseRefName(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length > 200
    || !BRANCH_NAME.test(value)
    || value.includes('..')
    || value.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock'))
  ) {
    throw new BoundaryRefusal('the pull request base ref is malformed');
  }
  return value;
}

// ---------------------------------------------------------------------------
// GitHub API
// ---------------------------------------------------------------------------

export interface GitHubApi {
  getJson(pathname: string): Promise<unknown>;
  postJson(pathname: string, body: unknown): Promise<unknown>;
}

async function readBounded(response: Response, limit: number): Promise<string> {
  if (Number(response.headers.get('content-length') ?? '0') > limit) throw new GitHubApiError('a GitHub API response exceeds its size bound');
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new GitHubApiError('a GitHub API response exceeds its size bound');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The repository's REST API, with requests relative to `repos/<owner>/<name>/`. */
export function createGitHubApi(env: NodeJS.ProcessEnv): GitHubApi {
  const token = env['GITHUB_TOKEN'] ?? '';
  const repository = env['GITHUB_REPOSITORY'] ?? '';
  const apiUrl = env['GITHUB_API_URL'] || 'https://api.github.com';
  if (token === '') throw new BoundaryRefusal('the GitHub token is missing');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new BoundaryRefusal('the repository name is malformed');
  if (!/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?(?:\/[A-Za-z0-9._-]+)*\/?$/.test(apiUrl)) throw new BoundaryRefusal('the GitHub API address is malformed');
  const base = `${apiUrl.replace(/\/+$/, '')}/repos/${repository}/`;
  const request = async (pathname: string, method: 'GET' | 'POST', body?: unknown): Promise<unknown> => {
    const response = await fetch(new URL(pathname, base), {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'boundary-private-check',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await readBounded(response, API_MAX_BYTES);
    if (!response.ok) throw new GitHubApiError(`a GitHub API request failed with status ${response.status}`);
    return JSON.parse(text) as unknown;
  };
  return {
    getJson: (pathname) => request(pathname, 'GET'),
    postJson: (pathname, body) => request(pathname, 'POST', body),
  };
}

// ---------------------------------------------------------------------------
// boundary (private): bind the candidate to the Quality run
// ---------------------------------------------------------------------------

export interface CandidateBinding {
  readonly head: string;
  readonly base: string;
  readonly number: number;
  readonly title: string;
  readonly body: string;
}

/**
 * Bind the Quality run's head to exactly one open pull request of this repository and read the
 * tip of its base branch now. A pull request from a fork has an empty workflow_run.pull_requests,
 * so the commit association names the pull request for every head, the way the private
 * test-integrity binding does.
 */
export async function bindPullRequestCandidate(
  api: GitHubApi,
  input: { readonly runId: string; readonly headSha: string; readonly repository: string },
): Promise<CandidateBinding> {
  const head = fullSha(input.headSha, 'the Quality run head');
  if (!/^[1-9][0-9]{0,18}$/.test(input.runId)) throw new BoundaryRefusal('the Quality run id is malformed');
  const run = await api.getJson(`actions/runs/${input.runId}`);
  if (
    String(field(run, 'id')) !== input.runId
    || field(run, 'name') !== QUALITY_WORKFLOW_NAME
    || field(run, 'path') !== QUALITY_WORKFLOW_PATH
    || field(run, 'event') !== 'pull_request'
    || field(run, 'status') !== 'completed'
    || field(run, 'head_sha') !== head
    || field(run, 'repository', 'full_name') !== input.repository
  ) {
    throw new BoundaryRefusal('the triggering run is not the completed Quality pull_request run for this head');
  }

  const associations = await api.getJson(`commits/${head}/pulls?per_page=100`);
  if (!Array.isArray(associations)) throw new BoundaryRefusal('the pull request association is malformed');
  const matching = associations.filter((entry) => field(entry, 'state') === 'open'
    && field(entry, 'head', 'sha') === head
    && field(entry, 'base', 'repo', 'full_name') === input.repository);
  if (matching.length !== 1) throw new BoundaryRefusal('the head is not the head of exactly one open pull request in this repository');
  const number = positiveInt(field(matching[0], 'number'), 'the pull request number');

  const pull = await api.getJson(`pulls/${number}`);
  if (
    field(pull, 'number') !== number
    || field(pull, 'state') !== 'open'
    || field(pull, 'head', 'sha') !== head
    || field(pull, 'base', 'repo', 'full_name') !== input.repository
  ) {
    throw new BoundaryRefusal('the pull request no longer matches the Quality run head');
  }
  const baseRef = baseRefName(field(pull, 'base', 'ref'));
  const title = field(pull, 'title');
  const body = field(pull, 'body');
  if (typeof title !== 'string' || (body !== null && body !== undefined && typeof body !== 'string')) {
    throw new BoundaryRefusal('the pull request title or body is malformed');
  }

  const tip = await api.getJson(`git/ref/heads/${baseRef}`);
  if (field(tip, 'ref') !== `refs/heads/${baseRef}` || field(tip, 'object', 'type') !== 'commit') {
    throw new BoundaryRefusal('the base branch tip is not a commit');
  }
  const base = fullSha(field(tip, 'object', 'sha'), 'the base branch tip');
  if (base === head) throw new BoundaryRefusal('the base branch tip equals the head; there is no change to check');
  return { head, base, number, title, body: textOf(body) };
}

// ---------------------------------------------------------------------------
// boundary (private): the candidate as git objects
// ---------------------------------------------------------------------------

interface CandidateGit {
  readonly gitDir: string;
  readonly home: string;
}

// No system or global configuration, no attributes file, no hooks: the bare directory has no
// work tree and its HEAD stays unborn, so no attribute of the candidate's own tree is read.
const GIT_ISOLATION = [
  '-c', 'core.attributesFile=/dev/null',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.quotePath=false',
  '-c', 'core.fsmonitor=false',
] as const;

export function candidateGitEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: home,
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
  };
}

function gitBytes(git: CandidateGit, args: readonly string[], maxBuffer: number = GIT_MAX_BYTES): Buffer {
  return execFileSync('git', [...GIT_ISOLATION, `--git-dir=${git.gitDir}`, ...args], {
    env: candidateGitEnv(git.home),
    maxBuffer,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 300_000,
  });
}

function gitText(git: CandidateGit, args: readonly string[], refusal: string, maxBuffer?: number): string {
  try {
    return gitBytes(git, args, maxBuffer).toString('utf8');
  } catch {
    throw new BoundaryRefusal(refusal);
  }
}

function requireRange(baseValue: string, headValue: string): { base: string; head: string } {
  const head = fullSha(headValue, 'the head');
  const base = fullSha(baseValue, 'the base');
  if (base === head) throw new BoundaryRefusal('the base equals the head; there is no change to check');
  return { base, head };
}

function requireCommitObjects(git: CandidateGit, ids: readonly string[]): void {
  for (const id of ids) {
    let type = '';
    try {
      type = gitBytes(git, ['cat-file', '-t', id]).toString('utf8').trim();
    } catch {
      type = '';
    }
    if (type !== 'commit') throw new BoundaryRefusal('the head or base is not a commit object that the fetch brought');
  }
}

/** Fetch the head and base commits, and their history, into a new bare directory, as data. */
export function fetchCandidateObjects(input: CandidateGit & { readonly remote: string; readonly base: string; readonly head: string }): void {
  const { base, head } = requireRange(input.base, input.head);
  if (!/^(?:https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9_.\/-]+|\/[^\0]+)$/.test(input.remote)) throw new BoundaryRefusal('the fetch remote is malformed');
  try {
    execFileSync('git', [...GIT_ISOLATION, 'init', '--bare', '--quiet', input.gitDir], {
      env: candidateGitEnv(input.home),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    gitBytes(input, [
      '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'protocol.file.allow=always',
      'fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head',
      input.remote, `+${head}:refs/candidate/head`, `+${base}:refs/candidate/base`,
    ]);
  } catch {
    throw new BoundaryRefusal('the fetch did not bring the head and base commits');
  }
  requireCommitObjects(input, [base, head]);
}

function isAncestor(git: CandidateGit, ancestor: string, descendant: string): boolean {
  try {
    gitBytes(git, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch (error) {
    if ((error as { status?: unknown }).status === 1) return false;
    throw new BoundaryRefusal('the ancestry of the base and the head could not be read');
  }
}

// ---------------------------------------------------------------------------
// boundary (private): the scan
// ---------------------------------------------------------------------------

export interface CandidateScanResult {
  readonly version: 1;
  readonly conclusion: 'pass' | 'fail';
  readonly counts: Readonly<Record<ScanMode, Readonly<Record<string, number>>>>;
  /** Term hits in commits dated before the term-list epoch: counted, not blocked, as in every range scan. */
  readonly olderTermHits: number;
  readonly scanned: { readonly addedLines: number; readonly pathNames: number; readonly commits: number; readonly texts: number };
}

const emptyCounts = (): Record<ScanMode, Record<string, number>> => ({ 'added-lines': {}, 'path-names': {}, commits: {}, 'pr-text': {} });

const totalOf = (counts: Readonly<Record<ScanMode, Readonly<Record<string, number>>>>): number =>
  SCAN_MODES.reduce((sum, mode) => sum + Object.values(counts[mode]).reduce((part, count) => part + count, 0), 0);

const COMMIT_RECORDS_LINE = 'the commit records of the range could not be read exactly';

/**
 * The commit records of base..head, read exactly: one per listed commit, in the order of the
 * revision list, each with every field of the log format. A record separator or a NUL inside a
 * message or an identity would cut or shift the fields after it, so a record that lacks one, or
 * holds one of the wrong shape, refuses the range.
 */
export function requireExactCommitRecords(records: CommitAuthor[], listed: readonly string[]): CommitAuthor[] {
  const exact = records.length > 0 && records.length === listed.length && records.every((record, index) =>
    record.sha === listed[index]
    && FULL_SHA.test(record.sha)
    && typeof record.name === 'string'
    && typeof record.email === 'string'
    && typeof record.subject === 'string'
    && typeof record.message === 'string'
    && typeof record.committerName === 'string'
    && typeof record.committerEmail === 'string'
    && typeof record.committerTime === 'number'
    && Number.isSafeInteger(record.committerTime)
    && record.committerTime >= 0);
  if (!exact) throw new BoundaryRefusal(COMMIT_RECORDS_LINE);
  return records;
}

/**
 * Scan the candidate with the guard's own code: the added lines (the --branch-diff and --staged
 * scan), each added or renamed path name (the --tree path-name scan), every commit message and
 * author and committer identity in base..head (the --commit-authors scan), and the pull request
 * title and body (the --text scan).
 */
export function scanCandidate(input: CandidateGit & {
  readonly base: string;
  readonly head: string;
  readonly title: string;
  readonly body: string;
  readonly termRules: readonly PrivateTermRule[];
}): CandidateScanResult {
  const { base, head } = requireRange(input.base, input.head);
  requireCommitObjects(input, [base, head]);
  if (!isAncestor(input, base, head)) {
    throw new BoundaryRefusal('the base branch tip is not an ancestor of the head; update the branch from its base');
  }
  const counts = emptyCounts();
  const add = (mode: ScanMode, code: string): void => {
    if (!RULE_CODE.test(code)) throw new BoundaryRefusal('a rule code has an unexpected shape');
    counts[mode][code] = (counts[mode][code] ?? 0) + 1;
  };

  // Tree to tree, so content that only a merge commit introduces is in the diff. Text is forced
  // for every path and neither textconv nor an external diff runs, so no attribute and no NUL
  // byte turns a file into "Binary files differ".
  const diff = gitText(input, [
    'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--text', '--find-renames', '--unified=0',
    '--src-prefix=a/', '--dst-prefix=b/', `${base}^{tree}`, `${head}^{tree}`, '--',
  ], 'the candidate diff could not be read within its bound', DIFF_MAX_BYTES);
  const lines = parseUnifiedDiffAddedLines(diff);
  for (const issue of scanAddedLines(lines, input.termRules)) add('added-lines', issue.code);

  const paths = gitText(input, [
    'diff', '--no-color', '--no-ext-diff', '--name-only', '-z', '--find-renames', '--diff-filter=AR',
    `${base}^{tree}`, `${head}^{tree}`, '--',
  ], 'the added path names could not be read').split('\0').filter((entry) => entry !== '');
  for (const filePath of paths) {
    for (const code of new Set(pathNameCodes(filePath, input.termRules).map((hit) => hit.code))) add('path-names', code);
  }

  const log = gitText(input, ['log', `--format=${COMMIT_AUTHOR_LOG_FORMAT}`, `${base}..${head}`], 'the commit range could not be read');
  let records: CommitAuthor[];
  try {
    records = parseCommitAuthorLog(log);
  } catch (error) {
    if (error instanceof GuardInputError) throw new BoundaryRefusal(COMMIT_RECORDS_LINE);
    throw error;
  }
  const listed = gitText(input, ['rev-list', `${base}..${head}`], 'the commit range could not be read').split('\n').filter((entry) => entry !== '');
  const commits = requireExactCommitRecords(records, listed);
  const tally: CommitTermTally = { olderTermHits: 0 };
  for (const issue of scanCommitAuthors(commits, input.termRules, undefined, tally)) add('commits', issue.code);

  for (const text of [input.title, input.body]) {
    for (const hit of scanPublicText('text', text, input.termRules)) add('pr-text', hit.code);
  }

  return {
    version: 1,
    conclusion: totalOf(counts) > 0 ? 'fail' : 'pass',
    counts,
    olderTermHits: tally.olderTermHits,
    scanned: { addedLines: lines.length, pathNames: paths.length, commits: commits.length, texts: 2 },
  };
}

export function formatCandidateResult(result: CandidateScanResult): string[] {
  const { scanned } = result;
  const lines = [
    `${PREFIX} scanned ${scanned.addedLines} added line(s), ${scanned.pathNames} added or renamed path name(s), `
      + `${scanned.commits} commit(s) and ${scanned.texts} pull request text(s)`,
  ];
  for (const mode of SCAN_MODES) {
    for (const code of Object.keys(result.counts[mode]).sort()) lines.push(`${PREFIX} ${mode} ${code} ${result.counts[mode][code]}`);
  }
  if (result.olderTermHits > 0) {
    lines.push(`${PREFIX} ${result.olderTermHits} private-term hit(s) in commits dated before the term-list epoch were counted, not blocked`);
  }
  lines.push(result.conclusion === 'pass'
    ? `${PREFIX} no findings`
    : `${PREFIX} ${totalOf(result.counts)} finding(s); matched text withheld; the local guard with the term file shows each location`);
  return lines;
}

/** A scan result read back from its file: every field checked, or null. */
export function parseCandidateResult(value: unknown): CandidateScanResult | null {
  if (field(value, 'version') !== 1) return null;
  const conclusion = field(value, 'conclusion');
  const counts = field(value, 'counts');
  if ((conclusion !== 'pass' && conclusion !== 'fail') || !isRecord(counts)) return null;
  if (Object.keys(counts).sort().join(',') !== [...SCAN_MODES].sort().join(',')) return null;
  const parsed = emptyCounts();
  for (const mode of SCAN_MODES) {
    const codes = counts[mode];
    if (!isRecord(codes)) return null;
    for (const [code, hits] of Object.entries(codes)) {
      if (!RULE_CODE.test(code) || typeof hits !== 'number' || !Number.isSafeInteger(hits) || hits <= 0) return null;
      parsed[mode][code] = hits;
    }
  }
  const count = (key: string): number | null => {
    const entry = key === 'olderTermHits' ? field(value, key) : field(value, 'scanned', key);
    return typeof entry === 'number' && Number.isSafeInteger(entry) && entry >= 0 ? entry : null;
  };
  const older = count('olderTermHits');
  const addedLines = count('addedLines');
  const pathNames = count('pathNames');
  const commits = count('commits');
  const texts = count('texts');
  if (older === null || addedLines === null || pathNames === null || commits === null || texts === null) return null;
  if ((conclusion === 'fail') !== (totalOf(parsed) > 0)) return null;
  return { version: 1, conclusion, counts: parsed, olderTermHits: older, scanned: { addedLines, pathNames, commits, texts } };
}

/** Publish `boundary (private)` on the candidate head: success only for a passing result. */
export async function publishCheckRun(
  api: GitHubApi,
  input: { readonly headSha: string; readonly result: CandidateScanResult | null },
): Promise<'success' | 'failure'> {
  const head = fullSha(input.headSha, 'the head');
  const result = input.result === null ? null : parseCandidateResult(input.result);
  const conclusion = result?.conclusion === 'pass' ? 'success' : 'failure';
  const title = result === null
    ? `${PREFIX} the check could not complete`
    : result.conclusion === 'pass' ? `${PREFIX} no findings` : `${PREFIX} ${totalOf(result.counts)} finding(s)`;
  const lines = result === null ? [INCOMPLETE_LINE] : formatCandidateResult(result);
  const summary = lines.map((line) => line.slice(PREFIX.length + 1)).join('\n');
  const created = await api.postJson('check-runs', {
    name: CHECK_NAME,
    head_sha: head,
    status: 'completed',
    conclusion,
    output: { title, summary },
  });
  const id = field(created, 'id');
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) throw new BoundaryRefusal('the check run was not created');
  const readback = await api.getJson(`check-runs/${id}`);
  if (
    field(readback, 'name') !== CHECK_NAME
    || field(readback, 'head_sha') !== head
    || field(readback, 'status') !== 'completed'
    || field(readback, 'conclusion') !== conclusion
  ) {
    throw new BoundaryRefusal('the published check run does not read back as written');
  }
  return conclusion;
}

// ---------------------------------------------------------------------------
// The text check: issues, comments and reviews
// ---------------------------------------------------------------------------

export type TextKind = 'issue' | 'pull-request' | 'issue-comment' | 'review' | 'review-comment';
const TEXT_KINDS: ReadonlySet<string> = new Set(['issue', 'pull-request', 'issue-comment', 'review', 'review-comment']);

export interface TextItem {
  readonly kind: TextKind;
  /** The issue or pull request number. */
  readonly number: number;
  readonly id: number;
  readonly text: string;
}

/** The item an `issues` or `issue_comment` event names, read from its payload. */
export function collectEventItems(eventName: string, payload: unknown): TextItem[] {
  if (eventName === 'issues') {
    const issue = field(payload, 'issue');
    const title = field(issue, 'title');
    if (typeof title !== 'string') throw new BoundaryRefusal('the event holds no issue title');
    return [{
      kind: field(issue, 'pull_request') === undefined ? 'issue' : 'pull-request',
      number: positiveInt(field(issue, 'number'), 'the issue number'),
      id: positiveInt(field(issue, 'id'), 'the issue id'),
      text: `${title}\n${textOf(field(issue, 'body'))}`,
    }];
  }
  if (eventName === 'issue_comment') {
    const comment = field(payload, 'comment');
    if (!isRecord(comment)) throw new BoundaryRefusal('the event holds no comment');
    return [{
      kind: 'issue-comment',
      number: positiveInt(field(payload, 'issue', 'number'), 'the issue number'),
      id: positiveInt(comment['id'], 'the comment id'),
      text: textOf(comment['body']),
    }];
  }
  throw new BoundaryRefusal('the event is not one the text check reads from its payload');
}

/** Where the hourly listing starts: the last successful scheduled run less an overlap, else two hours back. */
export async function scheduleSince(api: GitHubApi, now: Date): Promise<string> {
  const runs = field(await api.getJson(`actions/workflows/${TEXT_WORKFLOW_FILE}/runs?event=schedule&status=success&per_page=1`), 'workflow_runs');
  if (!Array.isArray(runs)) throw new BoundaryRefusal('the scheduled run listing is malformed');
  if (runs.length === 0) return new Date(now.getTime() - SCHEDULE_DEFAULT_MS).toISOString();
  const createdAt = field(runs[0], 'created_at');
  const time = typeof createdAt === 'string' ? Date.parse(createdAt) : Number.NaN;
  if (!Number.isFinite(time) || time > now.getTime()) throw new BoundaryRefusal('the last scheduled run time is malformed');
  return new Date(time - SCHEDULE_OVERLAP_MS).toISOString();
}

async function listPages(api: GitHubApi, pathname: string, query: string): Promise<unknown[]> {
  const entries: unknown[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const answer = await api.getJson(`${pathname}?${query === '' ? '' : `${query}&`}per_page=${PAGE_SIZE}&page=${page}`);
    if (!Array.isArray(answer)) throw new BoundaryRefusal('a listing is malformed');
    entries.push(...answer);
    if (answer.length < PAGE_SIZE) return entries;
  }
  throw new BoundaryRefusal(`a listing holds more than ${MAX_PAGES * PAGE_SIZE} items; the run fails closed`);
}

function trailingNumber(url: unknown, segment: 'issues' | 'pulls'): number {
  const match = typeof url === 'string' ? new RegExp(`/${segment}/([1-9][0-9]{0,9})$`).exec(url) : null;
  if (match === null) throw new BoundaryRefusal('a comment names no issue or pull request');
  return Number(match[1]);
}

/**
 * Every issue and pull request (title and body), issue comment and review comment changed since
 * `since`, and every review of each pull request that changed. A listing that fills every page
 * it may read fails closed.
 */
export async function collectChangedItems(api: GitHubApi, since: string): Promise<TextItem[]> {
  if (Number.isNaN(Date.parse(since))) throw new BoundaryRefusal('the listing start time is malformed');
  const changed = `since=${encodeURIComponent(since)}&sort=updated&direction=asc`;
  const items: TextItem[] = [];
  const pulls: number[] = [];
  for (const issue of await listPages(api, 'issues', `state=all&${changed}`)) {
    const number = positiveInt(field(issue, 'number'), 'an issue number');
    const isPull = field(issue, 'pull_request') !== undefined;
    if (isPull) pulls.push(number);
    items.push({
      kind: isPull ? 'pull-request' : 'issue',
      number,
      id: positiveInt(field(issue, 'id'), 'an issue id'),
      text: `${textOf(field(issue, 'title'))}\n${textOf(field(issue, 'body'))}`,
    });
  }
  for (const comment of await listPages(api, 'issues/comments', changed)) {
    items.push({
      kind: 'issue-comment',
      number: trailingNumber(field(comment, 'issue_url'), 'issues'),
      id: positiveInt(field(comment, 'id'), 'a comment id'),
      text: textOf(field(comment, 'body')),
    });
  }
  for (const comment of await listPages(api, 'pulls/comments', changed)) {
    items.push({
      kind: 'review-comment',
      number: trailingNumber(field(comment, 'pull_request_url'), 'pulls'),
      id: positiveInt(field(comment, 'id'), 'a review comment id'),
      text: textOf(field(comment, 'body')),
    });
  }
  // Reviews have no repository-wide listing: every review of each changed pull request is read.
  for (const number of pulls) {
    for (const review of await listPages(api, `pulls/${number}/reviews`, '')) {
      items.push({ kind: 'review', number, id: positiveInt(field(review, 'id'), 'a review id'), text: textOf(field(review, 'body')) });
    }
  }
  return items;
}

export interface TextFinding {
  readonly kind: TextKind;
  readonly number: number;
  readonly id: number;
  readonly counts: Readonly<Record<string, number>>;
}

export interface TextScanResult {
  readonly conclusion: 'pass' | 'fail';
  readonly items: number;
  readonly findings: readonly TextFinding[];
}

/** Each item through the --text scan; a finding keeps the item's kind, number and counts by rule code. */
export function scanTextItems(items: readonly TextItem[], termRules: readonly PrivateTermRule[]): TextScanResult {
  const findings: TextFinding[] = [];
  for (const item of items) {
    const counts: Record<string, number> = {};
    for (const hit of scanPublicText('text', item.text, termRules)) counts[hit.code] = (counts[hit.code] ?? 0) + 1;
    if (Object.keys(counts).length > 0) findings.push({ kind: item.kind, number: item.number, id: item.id, counts });
  }
  return { conclusion: findings.length > 0 ? 'fail' : 'pass', items: items.length, findings };
}

export function formatTextResult(result: TextScanResult): string[] {
  const lines: string[] = [];
  for (const finding of result.findings) {
    for (const code of Object.keys(finding.counts).sort()) {
      lines.push(`${TEXT_PREFIX} ${finding.kind} #${finding.number} (id ${finding.id}) ${code} ${finding.counts[code]}`);
    }
  }
  lines.push(result.findings.length === 0
    ? `${TEXT_PREFIX} ${result.items} item(s) scanned; no findings`
    : `${TEXT_PREFIX} ${result.items} item(s) scanned; ${result.findings.length} with findings; matched text withheld`);
  return lines;
}

function parseTextItems(value: unknown): TextItem[] {
  if (!Array.isArray(value)) throw new BoundaryRefusal('the collected items are malformed');
  return value.map((entry) => {
    const kind = field(entry, 'kind');
    const text = field(entry, 'text');
    if (typeof kind !== 'string' || !TEXT_KINDS.has(kind) || typeof text !== 'string') {
      throw new BoundaryRefusal('the collected items are malformed');
    }
    return {
      kind: kind as TextKind,
      number: positiveInt(field(entry, 'number'), 'an item number'),
      id: positiveInt(field(entry, 'id'), 'an item id'),
      text,
    };
  });
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

function loadRequiredTerms(env: NodeJS.ProcessEnv): readonly PrivateTermRule[] {
  let terms: ReturnType<typeof resolveBoundaryTerms>;
  try {
    terms = resolveBoundaryTerms(env);
  } catch (error) {
    if (error instanceof PrivateTermsError) throw new BoundaryRefusal(TERMS_LINE);
    throw error;
  }
  if (terms.load.status !== 'loaded' || terms.rules.length === 0) throw new BoundaryRefusal(TERMS_LINE);
  return terms.rules;
}

/** Written once, owner-only: a scan input or result never replaces an earlier file. */
function writePrivate(file: string, content: string): void {
  writeFileSync(file, content, { mode: 0o600, flag: 'wx' });
}

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8')) as unknown;

function readBinding(file: string): { head: string; base: string } {
  const value = readJson(file);
  return requireRange(String(field(value, 'base')), String(field(value, 'head')));
}

async function runCommand(command: string, outDir: string, remote: string | undefined, env: NodeJS.ProcessEnv): Promise<number> {
  const out = (name: string): string => path.join(outDir, name);
  const git = { gitDir: out('candidate.git'), home: out('git-home') };
  switch (command) {
    case 'bind': {
      const binding = await bindPullRequestCandidate(createGitHubApi(env), {
        runId: env['QUALITY_RUN_ID'] ?? '',
        headSha: env['QUALITY_HEAD_SHA'] ?? '',
        repository: env['GITHUB_REPOSITORY'] ?? '',
      });
      writePrivate(out('binding.json'), JSON.stringify({ head: binding.head, base: binding.base, number: binding.number }));
      writePrivate(out('pr-title.txt'), binding.title);
      writePrivate(out('pr-body.txt'), binding.body);
      console.log(`${PREFIX} bound pull request #${binding.number}: head ${binding.head}, base branch tip ${binding.base}`);
      return 0;
    }
    case 'fetch': {
      const binding = readBinding(out('binding.json'));
      mkdirSync(git.home, { recursive: true, mode: 0o700 });
      fetchCandidateObjects({ ...git, remote: remote ?? '', ...binding });
      console.log(`${PREFIX} fetched the head and base commits into a separate git directory, as data`);
      return 0;
    }
    case 'scan': {
      const termRules = loadRequiredTerms(env);
      const binding = readBinding(out('binding.json'));
      const result = scanCandidate({
        ...git,
        ...binding,
        title: readFileSync(out('pr-title.txt'), 'utf8'),
        body: readFileSync(out('pr-body.txt'), 'utf8'),
        termRules,
      });
      writePrivate(out('result.json'), JSON.stringify(result));
      for (const line of formatCandidateResult(result)) console.log(line);
      return result.conclusion === 'pass' ? 0 : 1;
    }
    case 'publish': {
      const api = createGitHubApi(env);
      let result: CandidateScanResult | null;
      try {
        result = parseCandidateResult(readJson(out('result.json')));
      } catch {
        result = null;
      }
      if (result === null) console.log(INCOMPLETE_LINE);
      const conclusion = await publishCheckRun(api, { headSha: env['QUALITY_HEAD_SHA'] ?? '', result });
      console.log(`${PREFIX} published the ${CHECK_NAME} check run as ${conclusion}`);
      return conclusion === 'success' ? 0 : 1;
    }
    case 'collect-text': {
      const api = createGitHubApi(env);
      const eventName = env['GITHUB_EVENT_NAME'] ?? '';
      const items = eventName === 'schedule'
        ? await collectChangedItems(api, await scheduleSince(api, new Date()))
        : collectEventItems(eventName, readJson(env['GITHUB_EVENT_PATH'] ?? ''));
      writePrivate(out('items.json'), JSON.stringify(items));
      console.log(`${TEXT_PREFIX} collected ${items.length} item(s)`);
      return 0;
    }
    case 'scan-text': {
      const termRules = loadRequiredTerms(env);
      const result = scanTextItems(parseTextItems(readJson(out('items.json'))), termRules);
      for (const line of formatTextResult(result)) console.log(line);
      return result.conclusion === 'pass' ? 0 : 1;
    }
    default:
      throw new BoundaryRefusal('the command is unknown');
  }
}

/** Run one command. A refusal prints its fixed text; any other error prints its class only. */
export async function main(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  const command = argv[0] ?? '';
  const prefix = command.endsWith('-text') ? TEXT_PREFIX : PREFIX;
  try {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: { out: { type: 'string' }, remote: { type: 'string' } },
      strict: true,
      allowPositionals: false,
    });
    if (typeof values.out !== 'string' || !path.isAbsolute(values.out)) throw new BoundaryRefusal('--out must name an absolute folder');
    return await runCommand(command, values.out, values.remote, env);
  } catch (error) {
    if (error instanceof BoundaryRefusal || error instanceof GitHubApiError) {
      console.log(`${prefix} ${error.message}`);
    } else {
      const kind = error instanceof Error ? error.constructor.name : typeof error;
      console.log(`${prefix} the step failed (${kind}); its text is withheld because it can quote private data`);
    }
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code;
  });
}
