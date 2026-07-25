import {
  execFile,
  spawnSync,
  type ExecFileException,
} from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { cleanGitEnv } from './lib/guard-core.ts';

const SCHEMA_VERSION = 1 as const;
const BASELINE_SCHEMA_VERSION = 2 as const;
const BASELINE_NAME = 'git-estate-baseline.v2.json';
const HASH_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ORDINARY_XY = new Set([
  '.M', '.T', '.A', '.D',
  'M.', 'MM', 'MT', 'MD',
  'T.', 'TM', 'TT', 'TD',
  'A.', 'AM', 'AT', 'AD',
  'D.',
]);
const RENAME_XY = new Set([
  'R.', 'RM', 'RT', 'RD', 'RR', 'RC',
  'C.', 'CM', 'CT', 'CD', 'CR', 'CC',
  '.R', '.C', 'MR', 'MC', 'TR', 'TC', 'AR', 'AC',
]);
const UNMERGED_XY_PATTERN = /^(?:DD|AU|UD|UA|DU|AA|UU)$/;
const SUBMODULE_STATE_PATTERN = /^(?:N\.\.\.|S[.C][.M][.U])$/;
const FILE_MODE_PATTERN = /^[0-7]{6}$/;
const RENAME_SCORE_PATTERN = /^([RC])(?:100|[1-9]?\d)$/;
const FINDING_ID_PATTERN = /^(dirty|untracked|conflict|detached|locked|prunable|branch_no_upstream|branch_gone|branch_ahead|branch_behind|stash):[0-9a-f]{24}$/;
const WORKTREE_ID_PATTERN = /^worktree:[0-9a-f]{24}$/;
const BRANCH_ID_PATTERN = /^branch:[0-9a-f]{24}$/;
const DEFAULT_GIT_TIMEOUT_MS = 5_000;
const MAX_GIT_TIMEOUT_MS = 30_000;
const STATUS_SCAN_CONCURRENCY = 4;

type GuardPhase = 'pre-commit' | 'pre-push';
type BaselineState = 'valid' | 'missing' | 'malformed';
type SnapshotConsistency = 'single-pass' | 'verified';

interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

interface WorktreePorcelain {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  locked: boolean;
  lockReason: string | null;
  prunable: boolean;
  pruneReason: string | null;
}

interface TrackedStatus {
  path: string;
  originalPath?: string;
  xy: string;
  staged: boolean;
  unstaged: boolean;
}

interface ConflictStatus {
  path: string;
  xy: string;
  stageOids: [string, string, string];
}

interface WorktreeStatus {
  branchOid: string | null;
  branchHead: string | null;
  branchUpstream: string | null;
  ahead: number;
  behind: number;
  tracked: TrackedStatus[];
  untracked: string[];
  conflicts: ConflictStatus[];
  conflictOperationMarker: string | null;
  conflictOperationReliable: boolean;
}

interface EstateWorktree extends WorktreePorcelain {
  primary: boolean;
  status: WorktreeStatus | null;
}

interface EstateBranch {
  name: string;
  oid: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  gone: boolean;
}

interface EstateStash {
  oid: string;
  parents: string[];
}

interface EstateFinding {
  id: string;
  kind:
    | 'dirty'
    | 'untracked'
    | 'conflict'
    | 'detached'
    | 'locked'
    | 'prunable'
    | 'branch_no_upstream'
    | 'branch_gone'
    | 'branch_ahead'
    | 'branch_behind'
    | 'stash';
  worktree?: string;
  path?: string;
  branch?: string;
  upstream?: string;
  oid?: string;
  conflictInstanceReliable?: boolean;
}

interface ScanError {
  kind:
    | 'worktree_status_failed'
    | 'worktree_status_rescan_failed'
    | 'topology_rescan_failed';
  message: string;
  worktree?: string;
}

interface EstateSnapshotWithoutHash {
  schemaVersion: 1;
  commonDir: string;
  baselinePath: string;
  invokingWorktreePath: string;
  topologyFingerprintStart: string;
  topologyFingerprintEnd: string;
  statusFingerprintStart: string;
  statusFingerprintEnd: string;
  incomplete: boolean;
  racing: boolean;
  worktrees: EstateWorktree[];
  branches: EstateBranch[];
  stashes: EstateStash[];
  findings: EstateFinding[];
  errors: ScanError[];
}

interface EstateSnapshot extends EstateSnapshotWithoutHash {
  snapshotHash: string;
}

interface BaselinePayload {
  schemaVersion: 2;
  commonDir: string;
  snapshotHash: string;
  findingIds: string[];
  worktreeCount: number;
  branchCount: number;
  worktreeIds: string[];
  branchIds: string[];
}

interface BaselineFile extends BaselinePayload {
  payloadHash: string;
}

interface BaselineReceipt {
  state: BaselineState;
  path: string;
  findingIds: string[];
  worktreeCount: number;
  branchCount: number;
  worktreeIds: string[];
  branchIds: string[];
  error?: string;
}

interface GuardDecision {
  blocked: boolean;
  newConflictIds: string[];
  newCriticalFindingIds: string[];
  countGrowth: {
    worktrees: number;
    branches: number;
  };
  newWorktreeIds: string[];
  newBranchIds: string[];
  exemptedWorktreeIds: string[];
  exemptedBranchIds: string[];
  warningCounts: Record<string, number>;
  reasons: string[];
}

class GitEstateError extends Error {
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.kind = kind;
  }
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort(compareText).map((key) =>
    `${JSON.stringify(key)}:${stableJson(record[key])}`
  ).join(',')}}`;
}

export function isFullObjectId(value: string): boolean {
  return HASH_PATTERN.test(value);
}

function cleanGitEnvironment(): NodeJS.ProcessEnv {
  return { ...cleanGitEnv(), GIT_OPTIONAL_LOCKS: '0' };
}

function gitTimeoutMs(): number {
  const configured = process.env['WHATSOUP_GIT_ESTATE_GIT_TIMEOUT_MS'];
  if (configured === undefined) return DEFAULT_GIT_TIMEOUT_MS;
  if (!/^\d+$/.test(configured)) {
    throw new GitEstateError(
      'git_timeout_invalid',
      'WHATSOUP_GIT_ESTATE_GIT_TIMEOUT_MS must be an integer',
    );
  }
  return Math.min(
    MAX_GIT_TIMEOUT_MS,
    Math.max(25, Number(configured)),
  );
}

function runGit(cwd: string, args: string[]): GitResult {
  const result = spawnSync('git', ['--no-optional-locks', '-C', cwd, ...args], {
    encoding: 'utf8',
    env: cleanGitEnvironment(),
    maxBuffer: 32 * 1024 * 1024,
    timeout: gitTimeoutMs(),
    killSignal: 'SIGKILL',
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error?.message,
  };
}

function runGitAsync(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['--no-optional-locks', '-C', cwd, ...args],
      {
        encoding: 'utf8',
        env: cleanGitEnvironment(),
        maxBuffer: 32 * 1024 * 1024,
        timeout: gitTimeoutMs(),
        killSignal: 'SIGKILL',
      },
      (error: ExecFileException | null, stdout, stderr) => {
        resolve({
          status: error === null
            ? 0
            : typeof error.code === 'number'
              ? error.code
              : null,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          error: error?.message,
        });
      },
    );
  });
}

function requireGit(cwd: string, args: string[], label: string): string {
  const result = runGit(cwd, args);
  if (result.status !== 0) {
    throw new GitEstateError(
      'git_scan_failed',
      `${label} failed (exit ${String(result.status)}${result.error ? `: ${result.error}` : ''})`,
    );
  }
  return result.stdout;
}

export function parseWorktreePorcelain(raw: string): WorktreePorcelain[] {
  const records: WorktreePorcelain[] = [];
  let current: (Partial<WorktreePorcelain> & { bare?: boolean }) | null = null;
  let phase: 'identity' | 'checkout' | 'annotations' = 'identity';
  if (!raw.endsWith('\0\0')) {
    throw new GitEstateError(
      'worktree_parse_failed',
      'worktree porcelain omitted its final record terminator',
    );
  }
  const finish = (): void => {
    if (current === null) {
      throw new GitEstateError('worktree_parse_failed', 'unexpected empty worktree record');
    }
    if (
      !current.path
      || (current.bare !== true && (
        current.head === undefined
        || (current.branch === undefined && current.detached !== true)
      ))
    ) {
      throw new GitEstateError('worktree_parse_failed', 'incomplete worktree record');
    }
    records.push({
      path: current.path,
      head: current.head ?? null,
      branch: current.branch ?? null,
      detached: current.detached ?? false,
      locked: current.locked ?? false,
      lockReason: current.lockReason ?? null,
      prunable: current.prunable ?? false,
      pruneReason: current.pruneReason ?? null,
    });
    current = null;
    phase = 'identity';
  };

  const tokens = raw.split('\0');
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (index === tokens.length - 1) {
      if (token !== '' || current !== null) {
        throw new GitEstateError('worktree_parse_failed', 'invalid worktree record framing');
      }
      continue;
    }
    if (token === '') {
      finish();
      continue;
    }
    const space = token.indexOf(' ');
    const key = space < 0 ? token : token.slice(0, space);
    const value = space < 0 ? '' : token.slice(space + 1);
    if (current === null) {
      if (key !== 'worktree' || !value) {
        throw new GitEstateError(
          'worktree_parse_failed',
          'worktree must be the first attribute of every record',
        );
      }
      current = { path: value };
      phase = 'identity';
      continue;
    }
    switch (key) {
      case 'HEAD':
        if (phase !== 'identity' || current.head !== undefined || !isFullObjectId(value)) {
          throw new GitEstateError('worktree_parse_failed', 'invalid worktree HEAD identity');
        }
        current.head = value;
        phase = 'checkout';
        break;
      case 'branch':
        if (phase !== 'checkout' || !/^refs\/heads\/\S+$/.test(value)) {
          throw new GitEstateError('worktree_parse_failed', 'invalid worktree branch identity');
        }
        current.branch = value.slice('refs/heads/'.length);
        phase = 'annotations';
        break;
      case 'detached':
        if (phase !== 'checkout' || value) {
          throw new GitEstateError('worktree_parse_failed', 'invalid detached worktree marker');
        }
        current.detached = true;
        phase = 'annotations';
        break;
      case 'locked':
        if (
          phase !== 'annotations'
          || current.bare === true
          || current.locked === true
          || current.prunable === true
        ) {
          throw new GitEstateError('worktree_parse_failed', 'invalid locked worktree marker');
        }
        current.locked = true;
        current.lockReason = value || null;
        break;
      case 'prunable':
        if (
          phase !== 'annotations'
          || current.bare === true
          || current.locked === true
          || current.prunable === true
          || !value
        ) {
          throw new GitEstateError('worktree_parse_failed', 'invalid prunable worktree marker');
        }
        current.prunable = true;
        current.pruneReason = value;
        break;
      case 'bare':
        if (phase !== 'identity' || value) {
          throw new GitEstateError('worktree_parse_failed', 'invalid bare worktree marker');
        }
        current.bare = true;
        phase = 'annotations';
        break;
      default:
        throw new GitEstateError('worktree_parse_failed', `unknown worktree field: ${key}`);
    }
  }
  if (records.length === 0) {
    throw new GitEstateError('worktree_parse_failed', 'git returned no worktree records');
  }
  return records;
}

export function parseStatus(raw: string): WorktreeStatus {
  const status: WorktreeStatus = {
    branchOid: null,
    branchHead: null,
    branchUpstream: null,
    ahead: 0,
    behind: 0,
    tracked: [],
    untracked: [],
    conflicts: [],
    conflictOperationMarker: null,
    conflictOperationReliable: false,
  };
  let branchOidSeen = false;
  let branchHeadSeen = false;
  const tokens = raw.split('\0');
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (!token) continue;
    if (token.startsWith('# ')) {
      const body = token.slice(2);
      const space = body.indexOf(' ');
      const key = space < 0 ? body : body.slice(0, space);
      const value = space < 0 ? '' : body.slice(space + 1);
      if (key === 'branch.oid') {
        if (branchOidSeen || (value !== '(initial)' && !isFullObjectId(value))) {
          throw new GitEstateError('status_parse_failed', 'invalid branch.oid header');
        }
        branchOidSeen = true;
        status.branchOid = value === '(initial)' ? null : value;
      } else if (key === 'branch.head') {
        if (branchHeadSeen || !value) {
          throw new GitEstateError('status_parse_failed', 'invalid branch.head header');
        }
        branchHeadSeen = true;
        status.branchHead = value === '(detached)' ? null : value;
      }
      else if (key === 'branch.upstream') status.branchUpstream = value || null;
      else if (key === 'branch.ab') {
        const match = /^\+(\d+) -(\d+)$/.exec(value);
        if (!match) throw new GitEstateError('status_parse_failed', 'invalid branch.ab header');
        status.ahead = Number(match[1]);
        status.behind = Number(match[2]);
      }
      continue;
    }

    const kind = token[0];
    if (kind === '?') {
      const untrackedPath = token.startsWith('? ') ? token.slice(2) : '';
      if (!untrackedPath) {
        throw new GitEstateError('status_parse_failed', 'invalid untracked status record');
      }
      status.untracked.push(untrackedPath);
      continue;
    }
    if (kind === '!') {
      if (!token.startsWith('! ') || !token.slice(2)) {
        throw new GitEstateError('status_parse_failed', 'invalid ignored status record');
      }
      continue;
    }
    if (kind === '1') {
      const record = splitFixedStatusFields(token, 8);
      if (
        !record
        || record.fields[0] !== '1'
        || !isValidTrackedStatusFields(record.fields, ORDINARY_XY)
      ) {
        throw new GitEstateError('status_parse_failed', 'invalid ordinary status record');
      }
      const xy = record.fields[1]!;
      status.tracked.push({
        xy,
        path: record.remainder,
        staged: xy[0] !== '.',
        unstaged: xy[1] !== '.',
      });
      continue;
    }
    if (kind === '2') {
      const record = splitFixedStatusFields(token, 9);
      const originalPath = tokens[index + 1] ?? '';
      if (
        !record
        || record.fields[0] !== '2'
        || !isValidTrackedStatusFields(record.fields, RENAME_XY)
        || !isValidRenameScore(record.fields[1]!, record.fields[8]!)
        || !originalPath
      ) {
        throw new GitEstateError('status_parse_failed', 'invalid rename/copy status record');
      }
      index += 1;
      const xy = record.fields[1]!;
      status.tracked.push({
        xy,
        path: record.remainder,
        originalPath,
        staged: xy[0] !== '.',
        unstaged: xy[1] !== '.',
      });
      continue;
    }
    if (kind === 'u') {
      const record = splitFixedStatusFields(token, 10);
      const stageOids = record?.fields.slice(7, 10) ?? [];
      if (
        !record
        || record.fields[0] !== 'u'
        || !UNMERGED_XY_PATTERN.test(record.fields[1]!)
        || !SUBMODULE_STATE_PATTERN.test(record.fields[2]!)
        || !record.fields.slice(3, 7).every((mode) => FILE_MODE_PATTERN.test(mode))
        || stageOids.length !== 3
        || !stageOids.every(isFullObjectId)
      ) {
        throw new GitEstateError('status_parse_failed', 'invalid unmerged stage identities');
      }
      const xy = record.fields[1]!;
      status.conflicts.push({
        xy,
        path: record.remainder,
        stageOids: stageOids as [string, string, string],
      });
      continue;
    }
    throw new GitEstateError('status_parse_failed', `unknown porcelain status record: ${kind}`);
  }
  if (!branchOidSeen || !branchHeadSeen) {
    throw new GitEstateError(
      'status_parse_failed',
      'porcelain-v2 status omitted mandatory branch.oid or branch.head headers',
    );
  }
  status.tracked.sort((a, b) => compareText(a.path, b.path) || compareText(a.xy, b.xy));
  status.untracked.sort(compareText);
  status.conflicts.sort((a, b) => compareText(a.path, b.path) || compareText(a.xy, b.xy));
  return status;
}

function isValidTrackedStatusFields(
  fields: string[],
  allowedXy: ReadonlySet<string>,
): boolean {
  return (
    allowedXy.has(fields[1]!)
    && SUBMODULE_STATE_PATTERN.test(fields[2]!)
    && fields.slice(3, 6).every((mode) => FILE_MODE_PATTERN.test(mode))
    && fields.slice(6, 8).every(isFullObjectId)
  );
}

function isValidRenameScore(xy: string, score: string): boolean {
  const match = RENAME_SCORE_PATTERN.exec(score);
  return match !== null && xy.includes(match[1]!);
}

function splitFixedStatusFields(
  token: string,
  fixedFieldCount: number,
): { fields: string[]; remainder: string } | null {
  const fields: string[] = [];
  let cursor = 0;
  for (let index = 0; index < fixedFieldCount; index += 1) {
    const separator = token.indexOf(' ', cursor);
    if (separator < 0) return null;
    const field = token.slice(cursor, separator);
    if (!field) return null;
    fields.push(field);
    cursor = separator + 1;
  }
  const remainder = token.slice(cursor);
  return remainder ? { fields, remainder } : null;
}

const OPERATION_ANCHORS = [
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'REBASE_HEAD',
  'rebase-merge/orig-head',
  'rebase-merge/stopped-sha',
  'rebase-apply/orig-head',
  'rebase-apply/original-commit',
  'sequencer/head',
] as const;

function readConflictOperationInstance(
  worktreePath: string,
): { marker: string | null; reliable: boolean } {
  const gitDirRaw = requireGit(
    worktreePath,
    ['rev-parse', '--path-format=absolute', '--git-dir'],
    'worktree git directory discovery',
  ).trim();
  if (!path.isAbsolute(gitDirRaw)) {
    throw new GitEstateError('git_dir_invalid', 'worktree git directory is not absolute');
  }
  const gitDir = path.normalize(gitDirRaw);
  for (const anchor of OPERATION_ANCHORS) {
    const anchorPath = path.join(gitDir, anchor);
    try {
      const before = lstatSync(anchorPath, { bigint: true });
      if (!before.isFile()) continue;
      const contentHash = sha256(readFileSync(anchorPath));
      const after = lstatSync(anchorPath, { bigint: true });
      const beforeIdentity = [
        before.dev,
        before.ino,
        before.size,
        before.birthtimeNs,
        before.ctimeNs,
      ].map(String);
      const afterIdentity = [
        after.dev,
        after.ino,
        after.size,
        after.birthtimeNs,
        after.ctimeNs,
      ].map(String);
      if (stableJson(beforeIdentity) !== stableJson(afterIdentity)) {
        throw new GitEstateError(
          'operation_state_racing',
          'conflict operation metadata changed while it was inspected',
        );
      }
      return {
        marker: sha256(stableJson({ anchor, contentHash, identity: afterIdentity })),
        reliable: true,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
  return { marker: null, reliable: false };
}

export function parseBranches(raw: string): EstateBranch[] {
  const branches: EstateBranch[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const [name = '', oid = '', upstreamValue = '', trackValue = ''] = line.split('\0');
    if (!name || !isFullObjectId(oid)) {
      throw new GitEstateError('branch_parse_failed', 'invalid local branch record');
    }
    const track = trackValue.trim();
    const gone = track === 'gone';
    const ahead = Number(/\bahead (\d+)\b/.exec(track)?.[1] ?? 0);
    const behind = Number(/\bbehind (\d+)\b/.exec(track)?.[1] ?? 0);
    branches.push({
      name,
      oid,
      upstream: upstreamValue || null,
      ahead,
      behind,
      gone,
    });
  }
  return branches.sort((a, b) => compareText(a.name, b.name));
}

export function parseStashes(raw: string): EstateStash[] {
  const stashes: EstateStash[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const [oid = '', parentsValue = ''] = line.split('\0');
    if (!isFullObjectId(oid)) {
      throw new GitEstateError('stash_parse_failed', 'invalid stash object identity');
    }
    const parents = parentsValue.split(' ').filter(Boolean).sort(compareText);
    if (!parents.every(isFullObjectId)) {
      throw new GitEstateError('stash_parse_failed', 'invalid stash parent identity');
    }
    stashes.push({ oid, parents });
  }
  stashes.sort((a, b) => compareText(a.oid, b.oid));
  return stashes;
}

function readStashes(cwd: string): { raw: string; stashes: EstateStash[] } {
  const exists = runGit(cwd, ['show-ref', '--verify', '--quiet', 'refs/stash']);
  if (exists.status === 1) return { raw: '', stashes: [] };
  if (exists.status !== 0) {
    throw new GitEstateError('stash_scan_failed', 'failed to inspect the common stash ref');
  }
  const raw = requireGit(
    cwd,
    ['reflog', 'show', '--format=%H%x00%P%x00', 'refs/stash'],
    'stash identity scan',
  );
  return { raw, stashes: parseStashes(raw) };
}

interface CommonCapture {
  commonDir: string;
  fingerprint: string;
  worktrees: WorktreePorcelain[];
  branches: EstateBranch[];
  stashes: EstateStash[];
}

function captureCommonState(cwd: string): CommonCapture {
  const commonDirRaw = requireGit(
    cwd,
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    'common git directory discovery',
  ).trim();
  if (!path.isAbsolute(commonDirRaw)) {
    throw new GitEstateError('common_dir_invalid', 'git common directory is not absolute');
  }
  const commonDir = path.normalize(commonDirRaw);
  const worktreeRaw = requireGit(
    cwd,
    ['worktree', 'list', '--porcelain', '-z'],
    'worktree topology scan',
  );
  const branchRaw = requireGit(
    cwd,
    [
      'for-each-ref',
      '--format=%(refname:short)%00%(objectname)%00%(upstream:short)%00%(upstream:track,nobracket)%00',
      'refs/heads',
    ],
    'local branch scan',
  );
  const refRaw = requireGit(
    cwd,
    [
      'for-each-ref',
      '--format=%(refname)%00%(objectname)%00%(upstream)%00',
      'refs/heads',
      'refs/remotes',
      'refs/stash',
    ],
    'common ref scan',
  );
  const stash = readStashes(cwd);
  return {
    commonDir,
    fingerprint: sha256(stableJson({
      commonDir,
      worktreeRaw,
      branchRaw,
      refRaw,
      stashRaw: stash.raw,
    })),
    worktrees: parseWorktreePorcelain(worktreeRaw),
    branches: parseBranches(branchRaw),
    stashes: stash.stashes,
  };
}

function findingId(kind: EstateFinding['kind'], identity: string): string {
  return `${kind}:${sha256(`${kind}\0${identity}`).slice(0, 24)}`;
}

function worktreeId(worktreePath: string): string {
  return `worktree:${sha256(`worktree\0${worktreePath}`).slice(0, 24)}`;
}

function branchId(branchName: string): string {
  return `branch:${sha256(`branch\0${branchName}`).slice(0, 24)}`;
}

function buildFindings(
  worktrees: EstateWorktree[],
  branches: EstateBranch[],
  stashes: EstateStash[],
): EstateFinding[] {
  const findings: EstateFinding[] = [];
  for (const worktree of worktrees) {
    if (worktree.detached) {
      findings.push({
        id: findingId('detached', worktree.path),
        kind: 'detached',
        worktree: worktree.path,
      });
    }
    if (worktree.locked) {
      findings.push({
        id: findingId('locked', worktree.path),
        kind: 'locked',
        worktree: worktree.path,
      });
    }
    if (worktree.prunable) {
      findings.push({
        id: findingId('prunable', worktree.path),
        kind: 'prunable',
        worktree: worktree.path,
      });
    }
    for (const entry of worktree.status?.tracked ?? []) {
      findings.push({
        id: findingId('dirty', `${worktree.path}\0${entry.path}`),
        kind: 'dirty',
        worktree: worktree.path,
        path: entry.path,
      });
    }
    for (const file of worktree.status?.untracked ?? []) {
      findings.push({
        id: findingId('untracked', `${worktree.path}\0${file}`),
        kind: 'untracked',
        worktree: worktree.path,
        path: file,
      });
    }
    for (const conflict of worktree.status?.conflicts ?? []) {
      const operationMarker = worktree.status?.conflictOperationMarker;
      findings.push({
        id: findingId(
          'conflict',
          [
            worktree.path,
            conflict.path,
            conflict.xy,
            ...conflict.stageOids,
            operationMarker ?? 'unidentified-operation',
          ].join('\0'),
        ),
        kind: 'conflict',
        worktree: worktree.path,
        path: conflict.path,
        conflictInstanceReliable: worktree.status?.conflictOperationReliable === true,
      });
    }
  }
  for (const branch of branches) {
    if (branch.upstream === null) {
      findings.push({
        id: findingId('branch_no_upstream', branch.name),
        kind: 'branch_no_upstream',
        branch: branch.name,
      });
    } else if (branch.gone) {
      findings.push({
        id: findingId('branch_gone', `${branch.name}\0${branch.upstream}`),
        kind: 'branch_gone',
        branch: branch.name,
        upstream: branch.upstream,
      });
    }
    if (branch.ahead > 0) {
      findings.push({
        id: findingId('branch_ahead', `${branch.name}\0${branch.upstream ?? ''}`),
        kind: 'branch_ahead',
        branch: branch.name,
        upstream: branch.upstream ?? undefined,
      });
    }
    if (branch.behind > 0) {
      findings.push({
        id: findingId('branch_behind', `${branch.name}\0${branch.upstream ?? ''}`),
        kind: 'branch_behind',
        branch: branch.name,
        upstream: branch.upstream ?? undefined,
      });
    }
  }
  for (const stash of stashes) {
    findings.push({
      id: findingId('stash', stash.oid),
      kind: 'stash',
      oid: stash.oid,
    });
  }
  findings.sort((a, b) => compareText(a.id, b.id));
  return findings;
}

interface WorktreeStatusScan {
  fingerprint: string;
  worktrees: EstateWorktree[];
  errors: ScanError[];
}

interface WorktreeStatusResult {
  capture: {
    path: string;
    status: number | null;
    stdout: string;
    error: string | null;
  };
  worktree: EstateWorktree;
  error: ScanError | null;
}

async function mapWithBoundedConcurrency<T, U>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, values.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(values[index]!);
    }
  }));
  return results;
}

async function scanWorktreeStatuses(
  worktrees: WorktreePorcelain[],
  primaryPath: string,
): Promise<WorktreeStatusScan> {
  const orderedWorktrees = [...worktrees].sort(
    (a, b) => compareText(a.path, b.path),
  );
  const results = await mapWithBoundedConcurrency<WorktreePorcelain, WorktreeStatusResult>(
    orderedWorktrees,
    STATUS_SCAN_CONCURRENCY,
    async (worktree) => {
      const result = await runGitAsync(worktree.path, [
        'status',
        '--porcelain=v2',
        '--branch',
        '-z',
        '--untracked-files=all',
      ]);
      const capture: {
        path: string;
        status: number | null;
        stdout: string;
        error: string | null;
      } = {
        path: worktree.path,
        status: result.status,
        stdout: result.stdout,
        error: result.error ?? null,
      };
      if (result.status !== 0) {
        return {
          capture,
          worktree: {
            ...worktree,
            primary: worktree.path === primaryPath,
            status: null,
          } satisfies EstateWorktree,
          error: {
            kind: 'worktree_status_failed',
            message: `status scan failed for one registered worktree (exit ${String(result.status)})`,
            worktree: worktree.path,
          } satisfies ScanError,
        };
      }
      try {
        const parsedStatus = parseStatus(result.stdout);
        if (parsedStatus.conflicts.length > 0) {
          const operation = readConflictOperationInstance(worktree.path);
          parsedStatus.conflictOperationMarker = operation.marker;
          parsedStatus.conflictOperationReliable = operation.reliable;
        }
        return {
          capture,
          worktree: {
            ...worktree,
            primary: worktree.path === primaryPath,
            status: parsedStatus,
          } satisfies EstateWorktree,
          error: null,
        };
      } catch {
        return {
          capture,
          worktree: {
            ...worktree,
            primary: worktree.path === primaryPath,
            status: null,
          } satisfies EstateWorktree,
          error: {
            kind: 'worktree_status_failed',
            message: 'status scan returned malformed porcelain data for one registered worktree',
            worktree: worktree.path,
          } satisfies ScanError,
        };
      }
    },
  );
  const captures: Array<{
    path: string;
    status: number | null;
    stdout: string;
    error: string | null;
  }> = results.map(({ capture }) => capture);
  const estateWorktrees = results.map(({ worktree }) => worktree);
  const errors: ScanError[] = results
    .map(({ error }) => error)
    .filter((error): error is ScanError => error !== null);
  return {
    fingerprint: sha256(stableJson({
      captures,
      operationInstances: estateWorktrees.map(({ path: worktreePath, status }) => ({
        path: worktreePath,
        marker: status?.conflictOperationMarker ?? null,
        reliable: status?.conflictOperationReliable ?? false,
      })),
    })),
    worktrees: estateWorktrees,
    errors,
  };
}

async function collectSnapshot(
  cwd: string,
  consistency: SnapshotConsistency = 'verified',
): Promise<EstateSnapshot> {
  const start = captureCommonState(cwd);
  const invokingWorktreePathRaw = requireGit(
    cwd,
    ['rev-parse', '--path-format=absolute', '--show-toplevel'],
    'invoking worktree discovery',
  ).trim();
  if (!path.isAbsolute(invokingWorktreePathRaw)) {
    throw new GitEstateError(
      'invoking_worktree_invalid',
      'invoking worktree path is not absolute',
    );
  }
  const invokingWorktreePath = path.normalize(invokingWorktreePathRaw);
  if (!start.worktrees.some(({ path: worktreePath }) => worktreePath === invokingWorktreePath)) {
    throw new GitEstateError(
      'invoking_worktree_unregistered',
      'invoking worktree is not present in registered topology',
    );
  }
  const primaryPath = start.worktrees[0]!.path;
  const initialStatus = await scanWorktreeStatuses(start.worktrees, primaryPath);
  const errors = [...initialStatus.errors];
  let endFingerprint = start.fingerprint;
  let endStatusFingerprint = initialStatus.fingerprint;
  let racing = false;
  if (consistency === 'verified') {
    try {
      const end = captureCommonState(cwd);
      endFingerprint = end.fingerprint;
      const finalStatus = await scanWorktreeStatuses(end.worktrees, primaryPath);
      endStatusFingerprint = finalStatus.fingerprint;
      const initialFailedPaths = new Set(
        initialStatus.errors.map(({ worktree }) => worktree).filter(Boolean),
      );
      for (const error of finalStatus.errors) {
        if (!initialFailedPaths.has(error.worktree)) {
          errors.push({ ...error, kind: 'worktree_status_rescan_failed' });
        }
      }
      racing = (
        end.commonDir !== start.commonDir
        || end.fingerprint !== start.fingerprint
        || finalStatus.fingerprint !== initialStatus.fingerprint
      );
    } catch {
      errors.push({
        kind: 'topology_rescan_failed',
        message: 'final topology/ref/stash fingerprint scan failed',
      });
      racing = true;
      endFingerprint = 'unavailable';
      endStatusFingerprint = 'unavailable';
    }
  }

  const withoutHash: EstateSnapshotWithoutHash = {
    schemaVersion: SCHEMA_VERSION,
    commonDir: start.commonDir,
    baselinePath: path.join(start.commonDir, 'whatsoup', BASELINE_NAME),
    invokingWorktreePath,
    topologyFingerprintStart: start.fingerprint,
    topologyFingerprintEnd: endFingerprint,
    statusFingerprintStart: initialStatus.fingerprint,
    statusFingerprintEnd: endStatusFingerprint,
    incomplete: errors.length > 0 || racing,
    racing,
    worktrees: initialStatus.worktrees,
    branches: start.branches,
    stashes: start.stashes,
    findings: buildFindings(initialStatus.worktrees, start.branches, start.stashes),
    errors: errors.sort((a, b) =>
      compareText(a.kind, b.kind) || compareText(a.worktree ?? '', b.worktree ?? '')
    ),
  };
  return {
    ...withoutHash,
    snapshotHash: sha256(stableJson(withoutHash)),
  };
}

function readBaseline(snapshot: EstateSnapshot): BaselineReceipt {
  try {
    const parsed = JSON.parse(readFileSync(snapshot.baselinePath, 'utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new GitEstateError('baseline_schema_invalid', 'baseline root must be an object');
    }
    const record = parsed as Record<string, unknown>;
    const expectedKeys = [
      'branchCount',
      'branchIds',
      'commonDir',
      'findingIds',
      'payloadHash',
      'schemaVersion',
      'snapshotHash',
      'worktreeCount',
      'worktreeIds',
    ];
    if (
      stableJson(Object.keys(record).sort(compareText)) !== stableJson(expectedKeys)
    ) {
      throw new GitEstateError('baseline_schema_invalid', 'baseline fields do not match schema');
    }
    const findingIds = record['findingIds'];
    const worktreeIds = record['worktreeIds'];
    const branchIds = record['branchIds'];
    if (
      record['schemaVersion'] !== BASELINE_SCHEMA_VERSION
      || record['commonDir'] !== snapshot.commonDir
      || typeof record['snapshotHash'] !== 'string'
      || !/^[0-9a-f]{64}$/.test(record['snapshotHash'])
      || !Array.isArray(findingIds)
      || !findingIds.every((id) => typeof id === 'string' && FINDING_ID_PATTERN.test(id))
      || new Set(findingIds).size !== findingIds.length
      || stableJson(findingIds) !== stableJson([...findingIds].sort(compareText))
      || !Array.isArray(worktreeIds)
      || !worktreeIds.every((id) => typeof id === 'string' && WORKTREE_ID_PATTERN.test(id))
      || new Set(worktreeIds).size !== worktreeIds.length
      || stableJson(worktreeIds) !== stableJson([...worktreeIds].sort(compareText))
      || !Array.isArray(branchIds)
      || !branchIds.every((id) => typeof id === 'string' && BRANCH_ID_PATTERN.test(id))
      || new Set(branchIds).size !== branchIds.length
      || stableJson(branchIds) !== stableJson([...branchIds].sort(compareText))
      || !Number.isSafeInteger(record['worktreeCount'])
      || (record['worktreeCount'] as number) < 0
      || record['worktreeCount'] !== worktreeIds.length
      || !Number.isSafeInteger(record['branchCount'])
      || (record['branchCount'] as number) < 0
      || record['branchCount'] !== branchIds.length
      || typeof record['payloadHash'] !== 'string'
      || !/^[0-9a-f]{64}$/.test(record['payloadHash'])
    ) {
      throw new GitEstateError(
        'baseline_schema_invalid',
        `baseline does not match schema version ${BASELINE_SCHEMA_VERSION}`,
      );
    }
    const payload: BaselinePayload = {
      schemaVersion: BASELINE_SCHEMA_VERSION,
      commonDir: record['commonDir'] as string,
      snapshotHash: record['snapshotHash'],
      findingIds: findingIds as string[],
      worktreeCount: record['worktreeCount'] as number,
      branchCount: record['branchCount'] as number,
      worktreeIds: worktreeIds as string[],
      branchIds: branchIds as string[],
    };
    if (record['payloadHash'] !== sha256(stableJson(payload))) {
      throw new GitEstateError(
        'baseline_payload_hash_invalid',
        'baseline canonical payload hash does not match its fields',
      );
    }
    return {
      state: 'valid',
      path: snapshot.baselinePath,
      findingIds: [...payload.findingIds],
      worktreeCount: payload.worktreeCount,
      branchCount: payload.branchCount,
      worktreeIds: [...payload.worktreeIds],
      branchIds: [...payload.branchIds],
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT'
      ? {
          state: 'missing',
          path: snapshot.baselinePath,
          findingIds: [],
          worktreeCount: 0,
          branchCount: 0,
          worktreeIds: [],
          branchIds: [],
        }
      : {
          state: 'malformed',
          path: snapshot.baselinePath,
          findingIds: [],
          worktreeCount: 0,
          branchCount: 0,
          worktreeIds: [],
          branchIds: [],
          error: 'baseline could not be parsed',
        };
  }
}

function warningCounts(findings: EstateFinding[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const finding of findings) {
    counts[finding.kind] = (counts[finding.kind] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([a], [b]) => compareText(a, b)),
  );
}

function decideGuard(
  snapshot: EstateSnapshot,
  baseline: BaselineReceipt,
  phase: GuardPhase,
  pushLocalRefs: string[],
): GuardDecision {
  const baselineIds = new Set(baseline.findingIds);
  const newConflictIds = snapshot.findings
    .filter(({ kind, id, conflictInstanceReliable }) =>
      kind === 'conflict'
      && (conflictInstanceReliable !== true || !baselineIds.has(id))
    )
    .map(({ id }) => id)
    .sort(compareText);
  const criticalKinds = new Set<EstateFinding['kind']>([
    'conflict',
    'prunable',
    'detached',
    'locked',
    'stash',
    'branch_gone',
  ]);
  const newCriticalFindingIds = snapshot.findings
    .filter(({ kind, id }) => criticalKinds.has(kind) && !baselineIds.has(id))
    .map(({ id }) => id)
    .sort(compareText);
  const baselineWorktreeIds = new Set(baseline.worktreeIds);
  const baselineBranchIds = new Set(baseline.branchIds);
  const newWorktreeIds = baseline.state === 'valid'
    ? snapshot.worktrees
      .map(({ path: worktreePath }) => worktreeId(worktreePath))
      .filter((id) => !baselineWorktreeIds.has(id))
      .sort(compareText)
    : [];
  const newBranchIds = baseline.state === 'valid'
    ? snapshot.branches
      .map(({ name }) => branchId(name))
      .filter((id) => !baselineBranchIds.has(id))
      .sort(compareText)
    : [];
  const invokingWorktree = snapshot.worktrees.find(
    ({ path: worktreePath }) => worktreePath === snapshot.invokingWorktreePath,
  );
  const invokingWorktreeId = invokingWorktree
    ? worktreeId(invokingWorktree.path)
    : null;
  const invokingBranchId = invokingWorktree?.branch
    ? branchId(invokingWorktree.branch)
    : null;
  const invokingBranchName = invokingWorktree?.branch ?? null;
  const pushedBranchNames = new Set(
    pushLocalRefs.map((ref) => ref.slice('refs/heads/'.length)),
  );
  const exactInvokingBranchIsPushed = invokingBranchName !== null
    && pushedBranchNames.has(invokingBranchName);
  const exemptedWorktreeIds = (
      exactInvokingBranchIsPushed
      && invokingWorktreeId !== null
      && newWorktreeIds.includes(invokingWorktreeId)
    )
    ? [invokingWorktreeId]
    : [];
  const exemptedBranchIds = (
      exactInvokingBranchIsPushed
      && invokingBranchId !== null
      && newBranchIds.includes(invokingBranchId)
    )
    ? [invokingBranchId]
    : [];
  const unexemptedWorktreeIds = newWorktreeIds.filter(
    (id) => !exemptedWorktreeIds.includes(id),
  );
  const unexemptedBranchIds = newBranchIds.filter(
    (id) => !exemptedBranchIds.includes(id),
  );
  const countGrowth = {
    worktrees: unexemptedWorktreeIds.length,
    branches: unexemptedBranchIds.length,
  };
  const reasons: string[] = [];
  if (baseline.state !== 'valid') reasons.push(`baseline_${baseline.state}`);
  if (snapshot.incomplete) reasons.push('scan_incomplete');
  if (snapshot.racing) reasons.push('scan_racing');
  if (newConflictIds.length > 0) reasons.push('new_conflicts');
  if (newCriticalFindingIds.some((id) => !newConflictIds.includes(id))) {
    reasons.push('new_critical_housekeeping_debt');
  }
  if (countGrowth.worktrees > 0 || countGrowth.branches > 0) {
    reasons.push('estate_count_growth');
  }
  return {
    blocked: phase === 'pre-push' && reasons.length > 0,
    newConflictIds,
    newCriticalFindingIds,
    countGrowth,
    newWorktreeIds,
    newBranchIds,
    exemptedWorktreeIds,
    exemptedBranchIds,
    warningCounts: warningCounts(snapshot.findings),
    reasons,
  };
}

function printJson(document: unknown): void {
  process.stdout.write(`${JSON.stringify(document)}\n`);
}

function totals(snapshot: EstateSnapshot): Record<string, number> {
  const counts = warningCounts(snapshot.findings);
  return {
    worktrees: snapshot.worktrees.length,
    branches: snapshot.branches.length,
    dirty: counts['dirty'] ?? 0,
    untracked: counts['untracked'] ?? 0,
    conflicts: counts['conflict'] ?? 0,
    detached: counts['detached'] ?? 0,
    locked: counts['locked'] ?? 0,
    gone: counts['branch_gone'] ?? 0,
    stashes: snapshot.stashes.length,
    prunable: counts['prunable'] ?? 0,
    ahead: counts['branch_ahead'] ?? 0,
    behind: counts['branch_behind'] ?? 0,
    noUpstream: counts['branch_no_upstream'] ?? 0,
    scanErrors: snapshot.errors.length,
  };
}

function printHumanSnapshot(snapshot: EstateSnapshot): void {
  const count = totals(snapshot);
  process.stdout.write([
    `git-estate snapshot ${snapshot.snapshotHash}`,
    `complete=${String(!snapshot.incomplete)} racing=${String(snapshot.racing)}`,
    `worktrees=${count.worktrees} branches=${count.branches} dirty=${count.dirty} untracked=${count.untracked} conflicts=${count.conflicts}`,
    `detached=${count.detached} locked=${count.locked} prunable=${count.prunable} gone=${count.gone} no-upstream=${count.noUpstream}`,
    `ahead=${count.ahead} behind=${count.behind} stashes=${count.stashes} scan-errors=${count.scanErrors}`,
  ].join('\n') + '\n');
}

function printHumanGuard(
  phase: GuardPhase,
  snapshot: EstateSnapshot | null,
  baseline: BaselineReceipt,
  decision: GuardDecision,
): void {
  if (!snapshot) {
    process.stdout.write(`WARN git-estate ${phase}: scan unavailable; baseline=${baseline.state}\n`);
    return;
  }
  const count = totals(snapshot);
  const label = decision.blocked ? 'BLOCK' : decision.reasons.length > 0 ? 'WARN' : 'OK';
  process.stdout.write(
    `${label} git-estate ${phase}: baseline=${baseline.state} complete=${String(!snapshot.incomplete)} ` +
      `dirty=${count.dirty} untracked=${count.untracked} conflicts=${count.conflicts} ` +
      `new-conflicts=${decision.newConflictIds.length} new-critical=${decision.newCriticalFindingIds.length} ` +
      `worktree-growth=${decision.countGrowth.worktrees} branch-growth=${decision.countGrowth.branches} ` +
      `detached=${count.detached} locked=${count.locked} ` +
      `gone=${count.gone} stashes=${count.stashes} prunable=${count.prunable} ` +
      `ahead=${count.ahead} behind=${count.behind} no-upstream=${count.noUpstream}\n`,
  );
}

function diagnostic(message: string): void {
  process.stderr.write(`git-estate: ${message}\n`);
}

const USAGE = [
  'Usage:',
  '  git-estate-guard snapshot [--json]',
  '  git-estate-guard guard --phase pre-commit|pre-push [--push-local-ref refs/heads/<name>]... [--json]',
  '  git-estate-guard baseline write [--json]',
].join('\n');

interface CliArgs {
  command: 'snapshot' | 'guard' | 'baseline' | 'help';
  json: boolean;
  phase?: GuardPhase;
  pushLocalRefs: string[];
}

function parseCli(argv: string[]): CliArgs {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    return { command: 'help', json: argv.includes('--json'), pushLocalRefs: [] };
  }
  const json = argv.includes('--json');
  const args = argv.filter((arg) => arg !== '--json');
  const command = args[0];
  if (command === 'snapshot' && args.length === 1) {
    return { command, json, pushLocalRefs: [] };
  }
  if (command === 'guard') {
    if (args.length < 3 || args[1] !== '--phase') {
      throw new GitEstateError('usage', 'guard requires --phase pre-commit|pre-push');
    }
    const phase = args[2];
    if (phase !== 'pre-commit' && phase !== 'pre-push') {
      throw new GitEstateError('usage', 'guard phase must be pre-commit|pre-push');
    }
    const pushLocalRefs: string[] = [];
    for (let index = 3; index < args.length; index += 2) {
      if (
        args[index] !== '--push-local-ref'
        || typeof args[index + 1] !== 'string'
        || !/^refs\/heads\/\S+$/.test(args[index + 1]!)
      ) {
        throw new GitEstateError(
          'usage',
          'guard accepts only repeated --push-local-ref refs/heads/<name> arguments',
        );
      }
      pushLocalRefs.push(args[index + 1]!);
    }
    if (phase !== 'pre-push' && pushLocalRefs.length > 0) {
      throw new GitEstateError(
        'usage',
        '--push-local-ref is valid only for the pre-push phase',
      );
    }
    return {
      command,
      json,
      phase,
      pushLocalRefs: [...new Set(pushLocalRefs)].sort(compareText),
    };
  }
  if (command === 'baseline') {
    if (args.length !== 2 || args[1] !== 'write') {
      throw new GitEstateError('usage', 'baseline supports only the write action');
    }
    return { command, json, pushLocalRefs: [] };
  }
  throw new GitEstateError('usage', `unknown or malformed command: ${command ?? '(missing)'}`);
}

function errorDocument(exitCode: number, kind: string, message: string): object {
  return {
    schemaVersion: SCHEMA_VERSION,
    command: 'error',
    exitCode,
    error: { kind, message },
  };
}

async function runSnapshotCommand(cwd: string, json: boolean): Promise<number> {
  try {
    const snapshot = await collectSnapshot(cwd);
    const exitCode = snapshot.incomplete ? 2 : 0;
    if (json) {
      printJson({
        schemaVersion: SCHEMA_VERSION,
        command: 'snapshot',
        exitCode,
        snapshot,
      });
    } else {
      printHumanSnapshot(snapshot);
    }
    if (snapshot.incomplete) {
      diagnostic(`snapshot incomplete (${snapshot.errors.length} scan errors; racing=${String(snapshot.racing)})`);
    }
    return exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown scan failure';
    if (json) {
      printJson({
        schemaVersion: SCHEMA_VERSION,
        command: 'snapshot',
        exitCode: 2,
        snapshot: null,
        error: { kind: 'scan_failed', message },
      });
    }
    diagnostic(`snapshot failed: ${message}`);
    return 2;
  }
}

async function runGuardCommand(
  cwd: string,
  phase: GuardPhase,
  json: boolean,
  pushLocalRefs: string[],
): Promise<number> {
  let snapshot: EstateSnapshot | null = null;
  let baseline: BaselineReceipt;
  let scanFailure: string | null = null;
  try {
    snapshot = await collectSnapshot(
      cwd,
      phase === 'pre-commit' ? 'single-pass' : 'verified',
    );
    baseline = readBaseline(snapshot);
  } catch (error) {
    scanFailure = error instanceof Error ? error.message : 'unknown scan failure';
    baseline = {
      state: 'missing',
      path: '',
      findingIds: [],
      worktreeCount: 0,
      branchCount: 0,
      worktreeIds: [],
      branchIds: [],
      error: 'scan unavailable',
    };
  }

  const decision: GuardDecision = snapshot
    ? decideGuard(snapshot, baseline, phase, pushLocalRefs)
    : {
        blocked: phase === 'pre-push',
        newConflictIds: [],
        newCriticalFindingIds: [],
        countGrowth: { worktrees: 0, branches: 0 },
        newWorktreeIds: [],
        newBranchIds: [],
        exemptedWorktreeIds: [],
        exemptedBranchIds: [],
        warningCounts: {},
        reasons: ['scan_incomplete'],
      };
  const exitCode = phase === 'pre-commit' ? 0 : decision.blocked ? 2 : 0;
  if (json) {
    printJson({
      schemaVersion: SCHEMA_VERSION,
      command: 'guard',
      phase,
      exitCode,
      baseline: {
        state: baseline.state,
        path: baseline.path,
        ...(baseline.error ? { error: baseline.error } : {}),
      },
      decision,
      snapshot,
      ...(scanFailure ? { error: { kind: 'scan_failed', message: scanFailure } } : {}),
    });
  } else {
    printHumanGuard(phase, snapshot, baseline, decision);
  }
  if (scanFailure) diagnostic(`guard scan failed: ${scanFailure}`);
  else if (decision.reasons.length > 0) {
    diagnostic(`${phase} warnings: ${decision.reasons.join(', ')}`);
  }
  return exitCode;
}

function writeBaselineAtomically(snapshot: EstateSnapshot): BaselineFile {
  const payload: BaselinePayload = {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    commonDir: snapshot.commonDir,
    snapshotHash: snapshot.snapshotHash,
    findingIds: snapshot.findings.map(({ id }) => id).sort(compareText),
    worktreeCount: snapshot.worktrees.length,
    branchCount: snapshot.branches.length,
    worktreeIds: snapshot.worktrees.map(({ path: worktreePath }) =>
      worktreeId(worktreePath)
    ).sort(compareText),
    branchIds: snapshot.branches.map(({ name }) => branchId(name)).sort(compareText),
  };
  const baseline: BaselineFile = {
    ...payload,
    payloadHash: sha256(stableJson(payload)),
  };
  const directory = path.dirname(snapshot.baselinePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    directory,
    `.${BASELINE_NAME}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`,
  );
  try {
    writeFileSync(temporaryPath, `${stableJson(baseline)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    renameSync(temporaryPath, snapshot.baselinePath);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Nothing to clean up when creation failed or rename already completed.
    }
    throw error;
  }
  return baseline;
}

async function runBaselineWriteCommand(cwd: string, json: boolean): Promise<number> {
  let snapshot: EstateSnapshot;
  try {
    snapshot = await collectSnapshot(cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown scan failure';
    if (json) {
      printJson({
        schemaVersion: SCHEMA_VERSION,
        command: 'baseline',
        action: 'write',
        exitCode: 2,
        baseline: null,
        error: { kind: 'scan_failed', message },
      });
    }
    diagnostic(`baseline write refused: ${message}`);
    return 2;
  }

  if (snapshot.incomplete || snapshot.racing) {
    const message = `snapshot is incomplete or racing (${snapshot.errors.length} scan errors)`;
    if (json) {
      printJson({
        schemaVersion: SCHEMA_VERSION,
        command: 'baseline',
        action: 'write',
        exitCode: 2,
        baseline: null,
        snapshotHash: snapshot.snapshotHash,
        error: { kind: 'snapshot_unsafe', message },
      });
    }
    diagnostic(`baseline write refused: ${message}`);
    return 2;
  }

  try {
    const finalSnapshot = await collectSnapshot(cwd);
    if (finalSnapshot.incomplete || finalSnapshot.racing) {
      const message = 'final acceptance snapshot is incomplete or racing';
      if (json) {
        printJson({
          schemaVersion: SCHEMA_VERSION,
          command: 'baseline',
          action: 'write',
          exitCode: 2,
          baseline: null,
          snapshotHash: snapshot.snapshotHash,
          error: { kind: 'snapshot_unsafe', message },
        });
      }
      diagnostic(`baseline write refused: ${message}`);
      return 2;
    }
    if (finalSnapshot.snapshotHash !== snapshot.snapshotHash) {
      const message = 'estate state changed between acceptance snapshots';
      if (json) {
        printJson({
          schemaVersion: SCHEMA_VERSION,
          command: 'baseline',
          action: 'write',
          exitCode: 2,
          baseline: null,
          snapshotHash: snapshot.snapshotHash,
          finalSnapshotHash: finalSnapshot.snapshotHash,
          error: { kind: 'scan_racing', message },
        });
      }
      diagnostic(`baseline write refused: ${message}`);
      return 2;
    }

    const baseline = writeBaselineAtomically(finalSnapshot);
    if (json) {
      printJson({
        schemaVersion: SCHEMA_VERSION,
        command: 'baseline',
        action: 'write',
        exitCode: 0,
        baseline: {
          path: finalSnapshot.baselinePath,
          snapshotHash: baseline.snapshotHash,
          findingCount: baseline.findingIds.length,
          worktreeCount: baseline.worktreeCount,
          branchCount: baseline.branchCount,
        },
      });
    } else {
      process.stdout.write(
        `OK git-estate baseline: findings=${baseline.findingIds.length} ` +
          `worktrees=${baseline.worktreeCount} branches=${baseline.branchCount} ` +
          `snapshot=${baseline.snapshotHash}\n`,
      );
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown baseline write failure';
    if (json) {
      printJson({
        schemaVersion: SCHEMA_VERSION,
        command: 'baseline',
        action: 'write',
        exitCode: 1,
        baseline: null,
        snapshotHash: snapshot.snapshotHash,
        error: { kind: 'write_failed', message },
      });
    }
    diagnostic(`baseline write failed: ${message}`);
    return 1;
  }
}

export async function main(
  argv = process.argv.slice(2),
  cwd = process.cwd(),
): Promise<number> {
  let parsed: CliArgs;
  try {
    parsed = parseCli(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid arguments';
    const json = argv.includes('--json');
    if (json) printJson(errorDocument(64, 'usage', message));
    else process.stdout.write(`${USAGE}\n`);
    diagnostic(`${message}; expected pre-commit|pre-push where applicable`);
    return 64;
  }

  if (parsed.command === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (parsed.command === 'baseline') {
    return await runBaselineWriteCommand(cwd, parsed.json);
  }
  if (parsed.command === 'snapshot') {
    return await runSnapshotCommand(cwd, parsed.json);
  }
  return await runGuardCommand(cwd, parsed.phase!, parsed.json, parsed.pushLocalRefs);
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  process.exitCode = await main();
}
