/**
 * agent-lease.ts — atomic writer/lineage lease for multi-agent git work.
 *
 * Implements the P0 control of the Multi-Agent Git Control Rider
 * (`~/.claude/plans/multi-agent-git-control-rider.md` §"Writer/lineage lease"):
 * *"The most important control is not a rebase policy. It is exclusive mutation
 * ownership."*
 *
 * WHY THIS EXISTS. Linked worktrees isolate HEAD and the index but SHARE `refs/*`
 * — including the stash ref — and the repo config. An agent building uncommitted
 * work in one worktree can therefore be swept away by a `git stash -u` run from a
 * second session reconciling the same branch. That happened in this repo. "My files
 * are untracked, so they are safe" is false. This lease turns that collision class
 * into a REFUSED, REPORTED condition instead of silent loss.
 *
 * STORAGE (deliberate). The lease lives at `<per-worktree git dir>/agent-writer-lease.json`,
 * i.e. `.git/worktrees/<name>/` for a linked worktree and `.git/` for the primary one:
 *   - It is OUTSIDE the working tree, so `git clean -fdx` — the other half of the
 *     destructive-cleanup family — cannot delete a live lease. A lease `git clean`
 *     can remove is not a lease.
 *   - `git rev-parse --absolute-git-dir` is DISTINCT per linked worktree, so the
 *     path itself keys the lease per worktree for free; no naming scheme to get wrong.
 *   - It is not a tracked file, so it can never be committed, stashed, or merged.
 * An XDG state dir was rejected: it decouples the lease from the repo it protects
 * (a moved/re-cloned worktree would silently orphan or inherit a lease), and it does
 * not survive `git worktree` administration in step with the worktree itself.
 *
 * NOTE: `git worktree lock` is NOT a substitute. It only blocks prune/move/remove —
 * it does not exclude concurrent file edits, and a worktree locked by a dead session
 * stays locked. Hence an external lease with a PROVEN takeover path.
 *
 * ATOMICITY. `acquire` creates the lease with a single exclusive-create open
 * (`O_EXCL` via `openSync(path, 'wx')` / `fsPromises.open(path, 'wx')`). There is no
 * `existsSync`-then-write anywhere on the acquire path: that is a check-then-act race
 * two agents can both win. Takeover claims the incumbent lease with a single
 * `renameSync`, which is likewise atomic — the loser of a concurrent takeover gets
 * ENOENT and is refused.
 *
 * FAIL-CLOSED. Unreadable, truncated, malformed or ambiguous state is NEVER success.
 * "I could not determine the process identity" resolves to INCONCLUSIVE (exit 2), never
 * to "therefore takeover is fine". Absence of evidence is not evidence of absence.
 *
 * Node builtins only — no npm dependencies, no Zod (lease parsing is a hand-written
 * narrowing validator over `unknown`).
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { open as openFileHandle } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { cleanGitEnv } from './lib/guard-core.ts';

// ── Outcome taxonomy ────────────────────────────────────────────────────────

export const EXIT_OK = 0;
export const EXIT_BLOCK = 1;
export const EXIT_INCONCLUSIVE = 2;

export type LeaseOutcome = 'block' | 'inconclusive';

/**
 * Rider error taxonomy (the subset this tool can emit) plus ONE clearly-labelled
 * extension. `GIT.LEASE.PATH_NOT_ALLOWED` is not in the rider table; it is added
 * here because the rider's lease record carries `allowedPaths[]` but the table has
 * no code for violating it. Everything else is the rider's own spelling.
 *
 * Malformed / unreadable lease state maps to `GIT.WORKTREE.UNACCOUNTED_STATE`
 * (Inconclusive in the rider table) — state belonging to the worktree that cannot
 * be accounted for. It is deliberately NOT mapped to a Block code: an operator must
 * reconcile it, and a Block would invite "just delete it".
 */
export const REASON_CODES = [
  'GIT.LEASE.WRITER_CONFLICT',
  'GIT.LEASE.EXPIRED_UNRECONCILED',
  'GIT.LEASE.PATH_NOT_ALLOWED',
  'GIT.HEAD.UNEXPECTED_CHANGE',
  'GIT.WORKTREE.WRONG_BRANCH',
  'GIT.WORKTREE.UNACCOUNTED_STATE',
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

export const REASON_OUTCOMES: Readonly<Record<ReasonCode, LeaseOutcome>> = {
  'GIT.LEASE.WRITER_CONFLICT': 'block',
  'GIT.LEASE.EXPIRED_UNRECONCILED': 'inconclusive',
  'GIT.LEASE.PATH_NOT_ALLOWED': 'block',
  'GIT.HEAD.UNEXPECTED_CHANGE': 'inconclusive',
  'GIT.WORKTREE.WRONG_BRANCH': 'block',
  'GIT.WORKTREE.UNACCOUNTED_STATE': 'inconclusive',
};

// ── Lease record (rider §"Writer/lineage lease") ────────────────────────────

export const LEASE_SCHEMA_VERSION = 1;
export const DEFAULT_TTL_SECONDS = 900;

export interface LeaseWriter {
  sessionId: string;
  /** `pid:<n>|start:<raw ps lstart>` — PID alone is NOT identity. */
  processIdentity: string;
  toolIdentity: string;
}

export interface LeaseRepository {
  identity: string;
  worktreeIdentity: string;
  branch: string | null;
}

export interface LeaseLineage {
  /** Immutable task starting point. NEVER silently replaced when main moves. */
  baseOid: string | null;
  candidateOid: string | null;
  /** Latest main observed LOCALLY (`refs/remotes/origin/main`). Never fetched here. */
  observedMainOid: string | null;
  testedMergeOid: string | null;
}

export interface LeaseBindings {
  manifestDigest: string;
  policyDigest: string;
  toolchainDigest: string;
  planDigest: string;
}

/** Branch + workspace state frozen at takeover (rider takeover step 3). */
export interface WorkspaceFreeze {
  branch: string | null;
  headOid: string | null;
  workspaceDigest: string;
  dirtyPaths: string[];
  frozenAt: string;
}

export interface LeaseRecord {
  schemaVersion: number;
  leaseId: string;
  generation: number;
  taskId: string;
  mode: 'write' | 'read';
  /** Candidate attempt id, re-issued on every takeover (rider takeover step 7). */
  attemptId: string;
  writer: LeaseWriter;
  repository: LeaseRepository;
  lineage: LeaseLineage;
  bindings: LeaseBindings;
  allowedPaths: string[];
  createdAt: string;
  heartbeatAt: string;
  expiresAt: string;
  freeze?: WorkspaceFreeze;
}

export interface TakeoverStep {
  step: number;
  id: string;
  satisfied: boolean;
  detail: string;
}

export interface LeaseSuccess {
  kind: 'ok';
  message: string;
  record: LeaseRecord;
  steps: TakeoverStep[];
}

export interface LeaseFailure {
  kind: LeaseOutcome;
  reason: ReasonCode;
  message: string;
  steps: TakeoverStep[];
}

export type LeaseResult = LeaseSuccess | LeaseFailure;

export type StatusResult =
  | { kind: 'ok'; state: 'free'; message: string; record: null; steps: TakeoverStep[] }
  | { kind: 'ok'; state: 'held'; message: string; record: LeaseRecord; steps: TakeoverStep[] }
  | LeaseFailure;

export function exitCodeFor(result: { kind: 'ok' } | { kind: LeaseOutcome; reason: ReasonCode }): number {
  if (result.kind === 'ok') return EXIT_OK;
  return REASON_OUTCOMES[result.reason] === 'block' ? EXIT_BLOCK : EXIT_INCONCLUSIVE;
}

function fail(reason: ReasonCode, message: string, steps: TakeoverStep[] = []): LeaseFailure {
  return { kind: REASON_OUTCOMES[reason], reason, message, steps };
}

// ── Narrowing validators (no Zod: builtins only, and no `as` widening) ──────

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

export type LeaseParse = { valid: true; record: LeaseRecord } | { valid: false; problem: string };

function parseWriter(value: unknown): LeaseWriter | string {
  if (!isRecordObject(value)) return 'writer is not an object';
  const { sessionId, processIdentity, toolIdentity } = value;
  if (typeof sessionId !== 'string' || sessionId === '') return 'writer.sessionId is not a non-empty string';
  if (typeof processIdentity !== 'string' || processIdentity === '') {
    return 'writer.processIdentity is not a non-empty string';
  }
  if (typeof toolIdentity !== 'string' || toolIdentity === '') return 'writer.toolIdentity is not a non-empty string';
  return { sessionId, processIdentity, toolIdentity };
}

function parseRepository(value: unknown): LeaseRepository | string {
  if (!isRecordObject(value)) return 'repository is not an object';
  const { identity, worktreeIdentity, branch } = value;
  if (typeof identity !== 'string' || identity === '') return 'repository.identity is not a non-empty string';
  if (typeof worktreeIdentity !== 'string' || worktreeIdentity === '') {
    return 'repository.worktreeIdentity is not a non-empty string';
  }
  if (!isNullableString(branch)) return 'repository.branch is not a string or null';
  return { identity, worktreeIdentity, branch };
}

function parseLineage(value: unknown): LeaseLineage | string {
  if (!isRecordObject(value)) return 'lineage is not an object';
  const { baseOid, candidateOid, observedMainOid, testedMergeOid } = value;
  if (!isNullableString(baseOid)) return 'lineage.baseOid is not a string or null';
  if (!isNullableString(candidateOid)) return 'lineage.candidateOid is not a string or null';
  if (!isNullableString(observedMainOid)) return 'lineage.observedMainOid is not a string or null';
  if (!isNullableString(testedMergeOid)) return 'lineage.testedMergeOid is not a string or null';
  return { baseOid, candidateOid, observedMainOid, testedMergeOid };
}

function parseBindings(value: unknown): LeaseBindings | string {
  if (!isRecordObject(value)) return 'bindings is not an object';
  const { manifestDigest, policyDigest, toolchainDigest, planDigest } = value;
  if (typeof manifestDigest !== 'string') return 'bindings.manifestDigest is not a string';
  if (typeof policyDigest !== 'string') return 'bindings.policyDigest is not a string';
  if (typeof toolchainDigest !== 'string') return 'bindings.toolchainDigest is not a string';
  if (typeof planDigest !== 'string') return 'bindings.planDigest is not a string';
  return { manifestDigest, policyDigest, toolchainDigest, planDigest };
}

function parseFreeze(value: unknown): WorkspaceFreeze | string {
  if (!isRecordObject(value)) return 'freeze is not an object';
  const { branch, headOid, workspaceDigest, dirtyPaths, frozenAt } = value;
  if (!isNullableString(branch)) return 'freeze.branch is not a string or null';
  if (!isNullableString(headOid)) return 'freeze.headOid is not a string or null';
  if (typeof workspaceDigest !== 'string') return 'freeze.workspaceDigest is not a string';
  if (!isStringArray(dirtyPaths)) return 'freeze.dirtyPaths is not a string[]';
  if (!isIsoTimestamp(frozenAt)) return 'freeze.frozenAt is not an ISO timestamp';
  return { branch, headOid, workspaceDigest, dirtyPaths, frozenAt };
}

/**
 * Parse + fully validate a lease document. Every field is checked; a missing,
 * extraneously-typed or unparseable field yields `{ valid: false }`, never a
 * partially-populated record. Callers must map that to INCONCLUSIVE.
 */
export function parseLeaseRecord(raw: string): LeaseParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { valid: false, problem: `lease is not valid JSON: ${(err as Error).message}` };
  }
  if (!isRecordObject(parsed)) return { valid: false, problem: 'lease is not a JSON object' };

  const { schemaVersion, leaseId, generation, taskId, mode, attemptId, allowedPaths } = parsed;
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion)) {
    return { valid: false, problem: 'schemaVersion is not an integer' };
  }
  if (schemaVersion !== LEASE_SCHEMA_VERSION) {
    return { valid: false, problem: `unsupported schemaVersion ${schemaVersion} (expected ${LEASE_SCHEMA_VERSION})` };
  }
  if (typeof leaseId !== 'string' || leaseId === '') return { valid: false, problem: 'leaseId is not a non-empty string' };
  if (typeof generation !== 'number' || !Number.isInteger(generation) || generation < 1) {
    return { valid: false, problem: 'generation is not a positive integer' };
  }
  if (typeof taskId !== 'string' || taskId === '') return { valid: false, problem: 'taskId is not a non-empty string' };
  if (mode !== 'write' && mode !== 'read') return { valid: false, problem: "mode is not 'write' or 'read'" };
  if (typeof attemptId !== 'string' || attemptId === '') {
    return { valid: false, problem: 'attemptId is not a non-empty string' };
  }
  if (!isStringArray(allowedPaths)) return { valid: false, problem: 'allowedPaths is not a string[]' };

  const writer = parseWriter(parsed.writer);
  if (typeof writer === 'string') return { valid: false, problem: writer };
  const repository = parseRepository(parsed.repository);
  if (typeof repository === 'string') return { valid: false, problem: repository };
  const lineage = parseLineage(parsed.lineage);
  if (typeof lineage === 'string') return { valid: false, problem: lineage };
  const bindings = parseBindings(parsed.bindings);
  if (typeof bindings === 'string') return { valid: false, problem: bindings };

  const { createdAt, heartbeatAt, expiresAt } = parsed;
  if (!isIsoTimestamp(createdAt)) return { valid: false, problem: 'createdAt is not an ISO timestamp' };
  if (!isIsoTimestamp(heartbeatAt)) return { valid: false, problem: 'heartbeatAt is not an ISO timestamp' };
  if (!isIsoTimestamp(expiresAt)) return { valid: false, problem: 'expiresAt is not an ISO timestamp' };

  const record: LeaseRecord = {
    schemaVersion,
    leaseId,
    generation,
    taskId,
    mode,
    attemptId,
    writer,
    repository,
    lineage,
    bindings,
    allowedPaths,
    createdAt,
    heartbeatAt,
    expiresAt,
  };

  if (parsed.freeze !== undefined) {
    const freeze = parseFreeze(parsed.freeze);
    if (typeof freeze === 'string') return { valid: false, problem: freeze };
    record.freeze = freeze;
  }
  return { valid: true, record };
}

// ── Process identity: PID *and* start time ──────────────────────────────────

export type ProcessProbe =
  | { state: 'alive'; startedAt: string }
  | { state: 'absent' }
  | { state: 'unknown'; detail: string };

/**
 * Probe a PID via `ps -o lstart= -p <pid>`. The RAW `lstart` string is used verbatim
 * as the identity component — it is never parsed into an epoch, because locale/TZ
 * parsing is a bug farm and only equality is needed.
 *
 * Fail-closed: only an explicit "no such process" (non-zero exit with empty output)
 * counts as `absent`. A spawn error, an unexpected exit status, or empty output on a
 * zero exit is `unknown` — which callers must treat as INCONCLUSIVE, never as death.
 */
export function probeProcess(pid: number): ProcessProbe {
  if (!Number.isInteger(pid) || pid <= 0) return { state: 'unknown', detail: `not a valid pid: ${String(pid)}` };
  const probe = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: cleanGitEnv() });
  if (probe.error !== undefined) return { state: 'unknown', detail: `ps failed: ${probe.error.message}` };
  const stdout = (probe.stdout ?? '').trim();
  if (probe.status === 0) {
    if (stdout === '') return { state: 'unknown', detail: 'ps exited 0 with no start time' };
    return { state: 'alive', startedAt: stdout };
  }
  if (stdout === '') return { state: 'absent' };
  return { state: 'unknown', detail: `ps exited ${String(probe.status)} with output` };
}

/** `pid:<n>|start:<raw lstart>` — the identity written into the lease. */
export function processIdentityString(pid: number): string {
  const probe = probeProcess(pid);
  if (probe.state === 'alive') return `pid:${pid}|start:${probe.startedAt}`;
  return `pid:${pid}|start:unknown`;
}

export function parseProcessIdentity(identity: string): { pid: number; startedAt: string } | null {
  const match = /^pid:(\d+)\|start:(.+)$/.exec(identity);
  if (match === null) return null;
  const pid = Number.parseInt(match[1] ?? '', 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return { pid, startedAt: match[2] ?? '' };
}

// ── Git facts (read-only; NEVER fetches — the coordinator owns fetch) ────────

export interface RepoFacts {
  gitDir: string;
  commonDir: string;
  repositoryIdentity: string;
  worktreeIdentity: string;
  branch: string | null;
  headOid: string | null;
  dirtyPaths: string[];
  workspaceDigest: string;
  observedMainOid: string | null;
}

export type RepoFactsResult = { ok: true; facts: RepoFacts } | { ok: false; message: string };

/**
 * Child-process environment comes from the repo's shared {@link cleanGitEnv}, which builds an
 * explicit ALLOWLIST of ~24 named variables. An earlier draft here spread `process.env` and
 * deleted the `GIT_*` keys — a denylist. `guard:repo:staged` rejects that shape
 * (`process-env-inheritance`), and rightly so: a denylist silently passes through every
 * variable nobody thought to name, which is the same failure mode as blocklisting credential
 * fields instead of allowlisting the safe ones. Reusing the shared helper also means an
 * ambient `GIT_DIR`/`GIT_INDEX_FILE` cannot redirect our git probes at another worktree.
 */

interface GitRun {
  status: number;
  stdout: string;
  stderr: string;
  failed: boolean;
}

function git(cwd: string, args: string[]): GitRun {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() });
  if (run.error !== undefined) {
    return { status: -1, stdout: '', stderr: run.error.message, failed: true };
  }
  return {
    status: run.status ?? -1,
    stdout: run.stdout ?? '',
    stderr: run.stderr ?? '',
    failed: (run.status ?? -1) !== 0,
  };
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function digestFile(filePath: string): string {
  try {
    return createHash('sha256').update(readFileSync(filePath)).digest('hex');
  } catch {
    return 'absent';
  }
}

/**
 * Parse `git status --porcelain=v1 -z -uall` into the touched path set. Rename/copy
 * entries carry a trailing origin field which is consumed so it cannot be mistaken
 * for a status line.
 */
function parsePorcelainZ(payload: string): string[] {
  const fields = payload.split('\0').filter((field) => field !== '');
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field === undefined || field.length < 4) continue;
    const status = field.slice(0, 2);
    paths.push(field.slice(3));
    if (status.includes('R') || status.includes('C')) i += 1; // consume the origin path
  }
  return paths.sort();
}

export function readRepoFacts(cwd: string): RepoFactsResult {
  const gitDirRun = git(cwd, ['rev-parse', '--absolute-git-dir']);
  if (gitDirRun.failed) {
    return { ok: false, message: `not a git worktree (${cwd}): ${gitDirRun.stderr.trim() || 'git rev-parse failed'}` };
  }
  const commonRun = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (commonRun.failed) {
    return { ok: false, message: `cannot resolve the shared git dir: ${commonRun.stderr.trim()}` };
  }
  const gitDir = path.resolve(gitDirRun.stdout.trim());
  const commonDir = path.resolve(commonRun.stdout.trim());

  const branchRun = git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const branch = branchRun.failed ? null : branchRun.stdout.trim();

  const headRun = git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  const headOid = headRun.failed ? null : headRun.stdout.trim();

  const statusRun = git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (statusRun.failed) {
    return { ok: false, message: `cannot read worktree status: ${statusRun.stderr.trim()}` };
  }
  const dirtyPaths = parsePorcelainZ(statusRun.stdout);

  // Local read of the coordinator's last observed main. NEVER a fetch.
  const mainRun = git(cwd, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main']);
  const observedMainOid = mainRun.failed || mainRun.stdout.trim() === '' ? null : mainRun.stdout.trim();

  return {
    ok: true,
    facts: {
      gitDir,
      commonDir,
      repositoryIdentity: `repo:${digest(commonDir).slice(0, 16)}`,
      worktreeIdentity: `${path.basename(gitDir)}:${digest(gitDir).slice(0, 16)}`,
      branch,
      headOid,
      dirtyPaths,
      workspaceDigest: digest(`${headOid ?? 'unborn'}\n${branch ?? 'detached'}\n${dirtyPaths.join('\n')}`),
      observedMainOid,
    },
  };
}

// ── Lease location ──────────────────────────────────────────────────────────

export interface LeaseLocation {
  gitDir: string;
  commonDir: string;
  leasePath: string;
  stateDir: string;
  abandonedDir: string;
  releasedDir: string;
}

const LEASE_FILE = 'agent-writer-lease.json';
const LEASE_STATE_DIR = 'agent-writer-lease.d';

function locationFromFacts(facts: RepoFacts): LeaseLocation {
  const stateDir = path.join(facts.gitDir, LEASE_STATE_DIR);
  return {
    gitDir: facts.gitDir,
    commonDir: facts.commonDir,
    leasePath: path.join(facts.gitDir, LEASE_FILE),
    stateDir,
    abandonedDir: path.join(stateDir, 'abandoned'),
    releasedDir: path.join(stateDir, 'released'),
  };
}

/** Throws when `cwd` is not inside a git worktree — callers on the CLI path use `readRepoFacts`. */
export function resolveLeaseLocation(cwd: string): LeaseLocation {
  const facts = readRepoFacts(cwd);
  if (!facts.ok) throw new Error(facts.message);
  return locationFromFacts(facts.facts);
}

type LeaseRead =
  | { state: 'absent' }
  | { state: 'present'; raw: string }
  | { state: 'unreadable'; problem: string };

function readLeaseFile(location: LeaseLocation): LeaseRead {
  try {
    return { state: 'present', raw: readFileSync(location.leasePath, 'utf8') };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { state: 'absent' };
    return { state: 'unreadable', problem: `${code ?? 'error'}: ${(err as Error).message}` };
  }
}

function serialize(record: LeaseRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

function isExpired(record: LeaseRecord, now: Date): boolean {
  return Date.parse(record.expiresAt) <= now.getTime();
}

function describeHolder(record: LeaseRecord): string {
  return (
    `lease ${record.leaseId} gen ${record.generation} held by session ${record.writer.sessionId} ` +
    `(${record.writer.toolIdentity}, ${record.writer.processIdentity}) for task ${record.taskId}; ` +
    `expires ${record.expiresAt}`
  );
}

// ── Bindings ────────────────────────────────────────────────────────────────

function repoRootFrom(facts: RepoFacts): string {
  // For a linked worktree the git dir is `<common>/worktrees/<name>`; the shared repo
  // root is the parent of the common dir in both layouts.
  return path.dirname(facts.commonDir);
}

function computeBindings(facts: RepoFacts, planPath?: string): LeaseBindings {
  const root = repoRootFrom(facts);
  const policyInputs: string[] = [];
  for (const dir of ['.husky', '.github/workflows']) {
    const abs = path.join(root, dir);
    let entries: string[] = [];
    try {
      entries = readdirSync(abs).sort();
    } catch {
      policyInputs.push(`${dir}:absent`);
      continue;
    }
    for (const entry of entries) {
      policyInputs.push(`${dir}/${entry}:${digestFile(path.join(abs, entry))}`);
    }
  }
  return {
    manifestDigest: digestFile(path.join(root, 'package.json')),
    policyDigest: digest(policyInputs.join('\n')),
    toolchainDigest: digest(`node:${process.version}\nnvmrc:${digestFile(path.join(root, '.nvmrc'))}`),
    planDigest: planPath === undefined ? 'absent' : digestFile(path.resolve(root, planPath)),
  };
}

// ── allowedPaths ────────────────────────────────────────────────────────────

/**
 * Return every candidate path NOT covered by the lease allowlist.
 *
 * Fail-closed rules: an empty `allowedPaths` denies everything (it is not read as
 * "unrestricted"); any candidate containing a `..` segment is a violation regardless
 * of where it normalises to; and prefix matching is segment-aware, so `srcfoo` is not
 * covered by `src`. `.` means the whole repository.
 */
export function checkAllowedPaths(record: LeaseRecord, candidates: string[]): string[] {
  const allowed = record.allowedPaths.map((entry) => entry.replace(/\/+$/, ''));
  const violations: string[] = [];
  for (const candidate of candidates) {
    const normalized = candidate.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (normalized === '' || normalized.split('/').includes('..') || path.isAbsolute(normalized)) {
      violations.push(candidate);
      continue;
    }
    const covered = allowed.some(
      (entry) => entry === '.' || entry === normalized || normalized.startsWith(`${entry}/`),
    );
    if (!covered) violations.push(candidate);
  }
  return violations;
}

// ── Acquire ─────────────────────────────────────────────────────────────────

export interface AcquireOptions {
  cwd?: string;
  taskId: string;
  sessionId: string;
  toolIdentity: string;
  mode?: 'write' | 'read';
  allowedPaths?: string[];
  expectBranch?: string;
  expectHeadOid?: string;
  baseOid?: string;
  planPath?: string;
  ttlSeconds?: number;
  now?: Date;
  pid?: number;
}

interface AcquirePlan {
  ready: true;
  location: LeaseLocation;
  record: LeaseRecord;
  now: Date;
}

function planAcquire(options: AcquireOptions): AcquirePlan | LeaseFailure {
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? new Date();
  const factsResult = readRepoFacts(cwd);
  if (!factsResult.ok) return fail('GIT.WORKTREE.UNACCOUNTED_STATE', factsResult.message);
  const facts = factsResult.facts;

  if (options.expectBranch !== undefined && facts.branch !== options.expectBranch) {
    return fail(
      'GIT.WORKTREE.WRONG_BRANCH',
      `worktree is on ${facts.branch ?? '(detached HEAD)'} but the task expects ${options.expectBranch}`,
    );
  }
  if (options.expectHeadOid !== undefined && facts.headOid !== options.expectHeadOid) {
    return fail(
      'GIT.HEAD.UNEXPECTED_CHANGE',
      `HEAD is ${facts.headOid ?? '(unborn)'} but ${options.expectHeadOid} was expected`,
    );
  }

  const location = locationFromFacts(facts);
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const timestamp = now.toISOString();
  const record: LeaseRecord = {
    schemaVersion: LEASE_SCHEMA_VERSION,
    leaseId: randomUUID(),
    generation: 1,
    taskId: options.taskId,
    mode: options.mode ?? 'write',
    attemptId: randomUUID(),
    writer: {
      sessionId: options.sessionId,
      processIdentity: processIdentityString(options.pid ?? process.pid),
      toolIdentity: options.toolIdentity,
    },
    repository: {
      identity: facts.repositoryIdentity,
      worktreeIdentity: facts.worktreeIdentity,
      branch: facts.branch,
    },
    lineage: {
      baseOid: options.baseOid ?? facts.headOid,
      candidateOid: facts.headOid,
      observedMainOid: facts.observedMainOid,
      testedMergeOid: null,
    },
    bindings: computeBindings(facts, options.planPath),
    allowedPaths: options.allowedPaths ?? ['.'],
    createdAt: timestamp,
    heartbeatAt: timestamp,
    expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
  };
  return { ready: true, location, record, now };
}

/** Classify a failed exclusive create. EEXIST is the interesting case: who holds it? */
function classifyCreateFailure(err: unknown, location: LeaseLocation, now: Date): LeaseFailure {
  const code = (err as NodeJS.ErrnoException).code;
  if (code !== 'EEXIST') {
    return fail(
      'GIT.WORKTREE.UNACCOUNTED_STATE',
      `could not create the lease at ${location.leasePath}: ${code ?? 'error'} ${(err as Error).message}`,
    );
  }
  const read = readLeaseFile(location);
  if (read.state === 'absent') {
    // The file vanished between O_EXCL failing and the read: concurrent mutation.
    return fail('GIT.WORKTREE.UNACCOUNTED_STATE', 'lease disappeared while it was being inspected');
  }
  if (read.state === 'unreadable') {
    return fail('GIT.WORKTREE.UNACCOUNTED_STATE', `lease state is unreadable: ${read.problem}`);
  }
  const parsed = parseLeaseRecord(read.raw);
  if (!parsed.valid) {
    return fail(
      'GIT.WORKTREE.UNACCOUNTED_STATE',
      `lease state is malformed (${parsed.problem}) — reconcile it manually; it is NOT safe to overwrite`,
    );
  }
  if (isExpired(parsed.record, now)) {
    return fail(
      'GIT.LEASE.EXPIRED_UNRECONCILED',
      `lease heartbeat expired at ${parsed.record.expiresAt} but was never reconciled — ` +
        `run 'takeover' (which must PROVE the previous writer is gone); ${describeHolder(parsed.record)}`,
    );
  }
  return fail('GIT.LEASE.WRITER_CONFLICT', `another writer holds this worktree: ${describeHolder(parsed.record)}`);
}

function ensureStateDirs(location: LeaseLocation): void {
  mkdirSync(location.abandonedDir, { recursive: true });
  mkdirSync(location.releasedDir, { recursive: true });
}

/**
 * Acquire the writer lease.
 *
 * The claim is a SINGLE `openSync(path, 'wx')` — an atomic `O_CREAT|O_EXCL` open.
 * There is deliberately no `existsSync` pre-check: that would be check-then-act and
 * two concurrent agents could both observe "free" and both write.
 */
export function acquireLease(options: AcquireOptions): LeaseResult {
  const plan = planAcquire(options);
  if (!('ready' in plan)) return plan;

  let fd: number;
  try {
    fd = openSync(plan.location.leasePath, 'wx', 0o600);
  } catch (err) {
    return classifyCreateFailure(err, plan.location, plan.now);
  }
  try {
    writeSync(fd, serialize(plan.record));
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    return fail('GIT.WORKTREE.UNACCOUNTED_STATE', `lease claimed but not written: ${(err as Error).message}`);
  }
  closeSync(fd);
  return {
    kind: 'ok',
    message: `acquired ${describeHolder(plan.record)}`,
    record: plan.record,
    steps: [],
  };
}

/** Async twin of {@link acquireLease}; identical policy, `fsPromises.open(path,'wx')` claim. */
export async function acquireLeaseAsync(options: AcquireOptions): Promise<LeaseResult> {
  const plan = planAcquire(options);
  if (!('ready' in plan)) return plan;

  let handle;
  try {
    handle = await openFileHandle(plan.location.leasePath, 'wx', 0o600);
  } catch (err) {
    return classifyCreateFailure(err, plan.location, plan.now);
  }
  try {
    await handle.writeFile(serialize(plan.record));
    await handle.sync();
  } catch (err) {
    await handle.close();
    return fail('GIT.WORKTREE.UNACCOUNTED_STATE', `lease claimed but not written: ${(err as Error).message}`);
  }
  await handle.close();
  return {
    kind: 'ok',
    message: `acquired ${describeHolder(plan.record)}`,
    record: plan.record,
    steps: [],
  };
}

// ── Status ──────────────────────────────────────────────────────────────────

export interface ContextOptions {
  cwd?: string;
  now?: Date;
}

export function statusLease(options: ContextOptions): StatusResult {
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? new Date();
  const factsResult = readRepoFacts(cwd);
  if (!factsResult.ok) return fail('GIT.WORKTREE.UNACCOUNTED_STATE', factsResult.message);
  const location = locationFromFacts(factsResult.facts);

  const read = readLeaseFile(location);
  if (read.state === 'absent') {
    return { kind: 'ok', state: 'free', message: `no writer lease on ${location.leasePath}`, record: null, steps: [] };
  }
  if (read.state === 'unreadable') {
    return fail('GIT.WORKTREE.UNACCOUNTED_STATE', `lease state is unreadable: ${read.problem}`);
  }
  const parsed = parseLeaseRecord(read.raw);
  if (!parsed.valid) {
    return fail('GIT.WORKTREE.UNACCOUNTED_STATE', `lease state is malformed: ${parsed.problem}`);
  }
  if (isExpired(parsed.record, now)) {
    return fail(
      'GIT.LEASE.EXPIRED_UNRECONCILED',
      `lease heartbeat expired at ${parsed.record.expiresAt} and was never reconciled; ${describeHolder(parsed.record)}`,
    );
  }
  return { kind: 'ok', state: 'held', message: describeHolder(parsed.record), record: parsed.record, steps: [] };
}

// ── Ownership-gated operations ──────────────────────────────────────────────

export interface OwnerOptions {
  cwd?: string;
  sessionId: string;
  toolIdentity: string;
  ttlSeconds?: number;
  now?: Date;
  pid?: number;
}

interface OwnedLease {
  location: LeaseLocation;
  record: LeaseRecord;
  now: Date;
}

/**
 * Load the lease and prove the caller owns it. Ownership is `sessionId` AND the full
 * `pid + process start time` identity — so a RECYCLED PID cannot masquerade as the
 * original writer.
 */
function loadOwnedLease(options: OwnerOptions, verb: string): OwnedLease | LeaseFailure {
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? new Date();
  const factsResult = readRepoFacts(cwd);
  if (!factsResult.ok) return fail('GIT.WORKTREE.UNACCOUNTED_STATE', factsResult.message);
  const location = locationFromFacts(factsResult.facts);

  const read = readLeaseFile(location);
  if (read.state === 'absent') {
    return fail('GIT.WORKTREE.UNACCOUNTED_STATE', `there is no lease to ${verb} at ${location.leasePath}`);
  }
  if (read.state === 'unreadable') {
    return fail('GIT.WORKTREE.UNACCOUNTED_STATE', `lease state is unreadable: ${read.problem}`);
  }
  const parsed = parseLeaseRecord(read.raw);
  if (!parsed.valid) {
    return fail('GIT.WORKTREE.UNACCOUNTED_STATE', `lease state is malformed: ${parsed.problem}`);
  }

  const callerIdentity = processIdentityString(options.pid ?? process.pid);
  if (parsed.record.writer.sessionId !== options.sessionId) {
    return fail(
      'GIT.LEASE.WRITER_CONFLICT',
      `session ${options.sessionId} cannot ${verb} a lease owned by session ${parsed.record.writer.sessionId}`,
    );
  }
  if (parsed.record.writer.processIdentity !== callerIdentity) {
    return fail(
      'GIT.LEASE.WRITER_CONFLICT',
      `process identity mismatch: lease holder is ${parsed.record.writer.processIdentity} but the caller is ` +
        `${callerIdentity} — a matching PID alone is not identity`,
    );
  }
  return { location, record: parsed.record, now };
}

/** Replace the lease in place (owner-verified path only): write a temp file, then rename. */
function replaceLease(location: LeaseLocation, record: LeaseRecord): LeaseFailure | null {
  const tmp = `${location.leasePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, serialize(record), { mode: 0o600 });
    renameSync(tmp, location.leasePath);
    return null;
  } catch (err) {
    return fail('GIT.WORKTREE.UNACCOUNTED_STATE', `could not update the lease: ${(err as Error).message}`);
  }
}

export function heartbeatLease(options: OwnerOptions): LeaseResult {
  const owned = loadOwnedLease(options, 'heartbeat');
  if ('kind' in owned) return owned;

  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const updated: LeaseRecord = {
    ...owned.record,
    heartbeatAt: owned.now.toISOString(),
    expiresAt: new Date(owned.now.getTime() + ttlSeconds * 1000).toISOString(),
  };
  const failure = replaceLease(owned.location, updated);
  if (failure !== null) return failure;
  return { kind: 'ok', message: `heartbeat ${describeHolder(updated)}`, record: updated, steps: [] };
}

export function releaseLease(options: OwnerOptions): LeaseResult {
  const owned = loadOwnedLease(options, 'release');
  if ('kind' in owned) return owned;

  ensureStateDirs(owned.location);
  const archive = path.join(
    owned.location.releasedDir,
    `${owned.record.leaseId}.gen${owned.record.generation}.released.json`,
  );
  try {
    renameSync(owned.location.leasePath, archive);
  } catch (err) {
    return fail('GIT.WORKTREE.UNACCOUNTED_STATE', `could not release the lease: ${(err as Error).message}`);
  }
  return {
    kind: 'ok',
    message: `released lease ${owned.record.leaseId}; evidence retained at ${archive}`,
    record: owned.record,
    steps: [],
  };
}

// ── Takeover (rider: a stale lease is NEVER removed merely for being old) ────

export interface TakeoverOptions extends AcquireOptions {
  reason?: string;
}

function step(stepNumber: number, id: string, satisfied: boolean, detail: string): TakeoverStep {
  return { step: stepNumber, id, satisfied, detail };
}

/**
 * Take over an abandoned lease. All SEVEN rider steps must be PROVEN; any step that
 * cannot be proven refuses the takeover and leaves the incumbent lease in place.
 *
 * Step 2 is the one that must not be "optimised": takeover is authorised ONLY by
 * positive proof that the recorded writer process is ABSENT. A live PID refuses —
 * whether or not its start time matches — because a recycled PID is an anomaly that
 * belongs in human reconciliation, not an automatic steal. An unparseable identity or
 * a failed probe is INCONCLUSIVE, never "therefore it is dead".
 */
export function takeoverLease(options: TakeoverOptions): LeaseResult {
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? new Date();
  const steps: TakeoverStep[] = [];

  const factsResult = readRepoFacts(cwd);
  if (!factsResult.ok) return fail('GIT.WORKTREE.UNACCOUNTED_STATE', factsResult.message, steps);
  const facts = factsResult.facts;
  const location = locationFromFacts(facts);

  const read = readLeaseFile(location);
  if (read.state === 'absent') {
    return fail(
      'GIT.WORKTREE.UNACCOUNTED_STATE',
      `there is no lease to take over at ${location.leasePath} — use 'acquire'`,
      steps,
    );
  }
  if (read.state === 'unreadable') {
    return fail('GIT.WORKTREE.UNACCOUNTED_STATE', `lease state is unreadable: ${read.problem}`, steps);
  }
  const parsed = parseLeaseRecord(read.raw);
  if (!parsed.valid) {
    return fail(
      'GIT.WORKTREE.UNACCOUNTED_STATE',
      `lease state is malformed (${parsed.problem}) — reconcile it manually; takeover will not guess`,
      steps,
    );
  }
  const previous = parsed.record;

  // 1. confirm heartbeat expired
  if (!isExpired(previous, now)) {
    steps.push(step(1, 'heartbeat-expired', false, `lease is live until ${previous.expiresAt}`));
    return fail('GIT.LEASE.WRITER_CONFLICT', `lease heartbeat is still live: ${describeHolder(previous)}`, steps);
  }
  steps.push(step(1, 'heartbeat-expired', true, `heartbeat expired at ${previous.expiresAt}`));

  // Worktree / branch identity must match before anything else is considered.
  if (previous.repository.worktreeIdentity !== facts.worktreeIdentity) {
    return fail(
      'GIT.WORKTREE.UNACCOUNTED_STATE',
      `lease belongs to worktree ${previous.repository.worktreeIdentity} but this is ${facts.worktreeIdentity}`,
      steps,
    );
  }
  const expectedBranch = options.expectBranch ?? previous.repository.branch;
  if (facts.branch !== expectedBranch) {
    return fail(
      'GIT.WORKTREE.WRONG_BRANCH',
      `lease was taken on branch ${expectedBranch ?? '(detached)'} but the worktree is on ` +
        `${facts.branch ?? '(detached)'} — reconcile the branch before taking over`,
      steps,
    );
  }
  if (options.expectHeadOid !== undefined && facts.headOid !== options.expectHeadOid) {
    return fail(
      'GIT.HEAD.UNEXPECTED_CHANGE',
      `HEAD is ${facts.headOid ?? '(unborn)'} but ${options.expectHeadOid} was expected`,
      steps,
    );
  }

  // 2. check process / process start time / session / worktree identity
  const identity = parseProcessIdentity(previous.writer.processIdentity);
  if (identity === null) {
    steps.push(
      step(2, 'writer-identity-proven-absent', false, `unparseable process identity ${previous.writer.processIdentity}`),
    );
    return fail(
      'GIT.LEASE.EXPIRED_UNRECONCILED',
      `the previous writer's process identity (${previous.writer.processIdentity}) could not be determined, ` +
        `so its death cannot be proven — refusing takeover`,
      steps,
    );
  }
  const probe = probeProcess(identity.pid);
  if (probe.state === 'alive') {
    const recycled = probe.startedAt !== identity.startedAt;
    steps.push(
      step(2, 'writer-identity-proven-absent', false, `pid ${identity.pid} is alive (started ${probe.startedAt})`),
    );
    return fail(
      'GIT.LEASE.EXPIRED_UNRECONCILED',
      recycled
        ? `pid ${identity.pid} is alive but started ${probe.startedAt}, not ${identity.startedAt} — the PID was ` +
          `recycled, so the previous writer's fate is unknown; refusing takeover (a PID alone is not identity)`
        : `pid ${identity.pid} is still alive (started ${probe.startedAt}) despite the expired heartbeat — ` +
          `refusing takeover`,
      steps,
    );
  }
  if (probe.state === 'unknown') {
    steps.push(step(2, 'writer-identity-proven-absent', false, `probe inconclusive: ${probe.detail}`));
    return fail(
      'GIT.LEASE.EXPIRED_UNRECONCILED',
      `could not determine whether pid ${identity.pid} is running (${probe.detail}); absence of evidence is not ` +
        `evidence of absence — refusing takeover`,
      steps,
    );
  }
  steps.push(
    step(
      2,
      'writer-identity-proven-absent',
      true,
      `pid ${identity.pid} (start ${identity.startedAt}, session ${previous.writer.sessionId}, ` +
        `worktree ${previous.repository.worktreeIdentity}) is absent`,
    ),
  );

  // 3. freeze current branch + workspace state
  const freeze: WorkspaceFreeze = {
    branch: facts.branch,
    headOid: facts.headOid,
    workspaceDigest: facts.workspaceDigest,
    dirtyPaths: facts.dirtyPaths,
    frozenAt: now.toISOString(),
  };
  steps.push(
    step(
      3,
      'workspace-frozen',
      true,
      `branch ${freeze.branch ?? '(detached)'} @ ${freeze.headOid ?? '(unborn)'}, ` +
        `${freeze.dirtyPaths.length} uncommitted path(s), digest ${freeze.workspaceDigest}`,
    ),
  );

  // 4. record the previous lease as abandoned — atomically CLAIM it by rename, so a
  //    concurrent takeover loses with ENOENT instead of both succeeding.
  ensureStateDirs(location);
  const attemptId = randomUUID();
  const claimPath = path.join(location.abandonedDir, `.claim-${attemptId}.tmp`);
  try {
    renameSync(location.leasePath, claimPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      steps.push(step(4, 'previous-lease-recorded-abandoned', false, 'another takeover claimed the lease first'));
      return fail('GIT.LEASE.WRITER_CONFLICT', 'another takeover claimed this lease first', steps);
    }
    steps.push(step(4, 'previous-lease-recorded-abandoned', false, `claim failed: ${(err as Error).message}`));
    return fail('GIT.WORKTREE.UNACCOUNTED_STATE', `could not claim the lease: ${(err as Error).message}`, steps);
  }

  const evidenceBase = path.join(location.abandonedDir, `${previous.leaseId}.gen${previous.generation}`);
  const evidenceLease = `${evidenceBase}.lease.json`;
  const evidenceMeta = `${evidenceBase}.abandoned.json`;
  try {
    // The ORIGINAL bytes are preserved verbatim — the record is evidence, not a copy.
    renameSync(claimPath, evidenceLease);
  } catch (err) {
    steps.push(step(4, 'previous-lease-recorded-abandoned', false, `could not file evidence: ${(err as Error).message}`));
    return fail(
      'GIT.WORKTREE.UNACCOUNTED_STATE',
      `previous lease claimed but not filed as evidence (it is at ${claimPath}): ${(err as Error).message}`,
      steps,
    );
  }
  steps.push(step(4, 'previous-lease-recorded-abandoned', true, `previous lease retained at ${evidenceLease}`));

  // 5. increment generation
  const generation = previous.generation + 1;
  steps.push(step(5, 'generation-incremented', true, `generation ${previous.generation} -> ${generation}`));

  // 6. revalidate HEAD/index/worktree/remote lineage AFTER the claim
  const recheck = readRepoFacts(cwd);
  let lineageFailure: LeaseFailure | null = null;
  if (!recheck.ok) {
    steps.push(step(6, 'lineage-revalidated', false, recheck.message));
    lineageFailure = fail('GIT.WORKTREE.UNACCOUNTED_STATE', recheck.message, steps);
  } else if (recheck.facts.headOid !== freeze.headOid || recheck.facts.branch !== freeze.branch) {
    steps.push(
      step(6, 'lineage-revalidated', false, `HEAD moved during takeover: ${freeze.headOid} -> ${recheck.facts.headOid}`),
    );
    lineageFailure = fail(
      'GIT.HEAD.UNEXPECTED_CHANGE',
      `HEAD or branch moved while the lease was being taken over (${freeze.headOid ?? '(unborn)'} -> ` +
        `${recheck.facts.headOid ?? '(unborn)'}); the previous lease is retained at ${evidenceLease}`,
      steps,
    );
  } else if (recheck.facts.workspaceDigest !== freeze.workspaceDigest) {
    steps.push(step(6, 'lineage-revalidated', false, 'the workspace changed during takeover'));
    lineageFailure = fail(
      'GIT.WORKTREE.UNACCOUNTED_STATE',
      `the workspace changed while the lease was being taken over; the previous lease is retained at ${evidenceLease}`,
      steps,
    );
  } else {
    steps.push(
      step(
        6,
        'lineage-revalidated',
        true,
        `base ${previous.lineage.baseOid ?? 'none'} preserved; candidate ${recheck.facts.headOid ?? '(unborn)'}; ` +
          `observed main ${recheck.facts.observedMainOid ?? 'none'} (read locally, not fetched)`,
      ),
    );
  }

  // 7. issue a new candidate attempt ID
  steps.push(step(7, 'candidate-attempt-issued', lineageFailure === null, `attempt ${attemptId}`));

  const abandonedEvidence = {
    previousLeasePath: evidenceLease,
    abandonedAt: now.toISOString(),
    abandonedBy: options.sessionId,
    abandonedByTool: options.toolIdentity,
    reason: options.reason ?? 'heartbeat expired and the writer process was proven absent',
    successorGeneration: generation,
    successorAttemptId: attemptId,
    freeze,
    steps,
  };
  try {
    writeFileSync(evidenceMeta, `${JSON.stringify(abandonedEvidence, null, 2)}\n`, { mode: 0o600 });
  } catch (err) {
    return fail(
      'GIT.WORKTREE.UNACCOUNTED_STATE',
      `could not write takeover evidence to ${evidenceMeta}: ${(err as Error).message}`,
      steps,
    );
  }
  if (lineageFailure !== null) return lineageFailure;

  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const successor: LeaseRecord = {
    schemaVersion: LEASE_SCHEMA_VERSION,
    leaseId: randomUUID(),
    generation,
    taskId: options.taskId,
    mode: options.mode ?? previous.mode,
    attemptId,
    writer: {
      sessionId: options.sessionId,
      processIdentity: processIdentityString(options.pid ?? process.pid),
      toolIdentity: options.toolIdentity,
    },
    repository: {
      identity: facts.repositoryIdentity,
      worktreeIdentity: facts.worktreeIdentity,
      branch: facts.branch,
    },
    lineage: {
      // The immutable task starting point is CARRIED FORWARD, never silently replaced.
      baseOid: previous.lineage.baseOid,
      candidateOid: facts.headOid,
      observedMainOid: facts.observedMainOid,
      testedMergeOid: null,
    },
    bindings: computeBindings(facts, options.planPath),
    allowedPaths: options.allowedPaths ?? previous.allowedPaths,
    createdAt: now.toISOString(),
    heartbeatAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
    freeze,
  };

  let fd: number;
  try {
    fd = openSync(location.leasePath, 'wx', 0o600);
  } catch (err) {
    return classifyCreateFailure(err, location, now);
  }
  try {
    writeSync(fd, serialize(successor));
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    return fail('GIT.WORKTREE.UNACCOUNTED_STATE', `successor lease claimed but not written: ${(err as Error).message}`);
  }
  closeSync(fd);
  return {
    kind: 'ok',
    message: `took over ${describeHolder(successor)}; previous lease retained at ${evidenceLease}`,
    record: successor,
    steps,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const USAGE = `Usage: agent-lease <command> [options]

Commands:
  acquire     Claim exclusive write ownership of this worktree (atomic O_EXCL create)
  status      Report the current lease (exit 2 if expired/malformed — fail-closed)
  heartbeat   Extend the lease you own
  release     Release the lease you own (archived as evidence)
  takeover    Take over an abandoned lease — all seven rider steps must be PROVEN
  check-path  Verify paths against the lease allowedPaths[]

Options:
  --cwd <dir>            Worktree to operate on (default: process.cwd())
  --task <id>            Task id (acquire/takeover)
  --session <id>         Session id of the writer
  --tool <id>            Tool identity of the writer
  --mode <write|read>    Lease mode (default: write)
  --allow <path>         Allowed path (repeatable; default '.')
  --expect-branch <b>    Refuse unless the worktree is on this branch
  --expect-head <oid>    Refuse unless HEAD is this OID
  --base-oid <oid>       Immutable task base OID (default: current HEAD)
  --plan <file>          File whose digest is bound as bindings.planDigest
  --pid <n>              PID of the LONG-LIVED writer process to bind identity to.
                         Default: this CLI process — which exits immediately, so a
                         long-running agent should pass its own supervisor PID.
  --ttl <seconds>        Lease lifetime (default: ${DEFAULT_TTL_SECONDS})
  --reason <text>        Takeover reason recorded in the abandonment evidence
  --json                 Emit the result as JSON on stdout

Exit codes: 0 = OK, 1 = BLOCK, 2 = INCONCLUSIVE (never a clean exit on unknown state).`;

interface ParsedArgs {
  command: string;
  flags: Map<string, string>;
  allow: string[];
  positional: string[];
  json: boolean;
}

function parseArgs(argv: string[]): ParsedArgs | string {
  const [command, ...rest] = argv;
  if (command === undefined) return 'no command given';
  const flags = new Map<string, string>();
  const allow: string[] = [];
  const positional: string[] = [];
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === undefined) continue;
    if (token === '--json') {
      json = true;
      continue;
    }
    if (token.startsWith('--')) {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith('--')) return `flag ${token} requires a value`;
      i += 1;
      if (token === '--allow') allow.push(value);
      else flags.set(token.slice(2), value);
      continue;
    }
    positional.push(token);
  }
  return { command, flags, allow, positional, json };
}

function requireFlags(args: ParsedArgs, names: string[]): string | null {
  const missing = names.filter((name) => !args.flags.has(name));
  return missing.length === 0 ? null : `missing required flag(s): ${missing.map((n) => `--${n}`).join(', ')}`;
}

function parsePositiveInt(args: ParsedArgs, flag: string): number | undefined | string {
  const raw = args.flags.get(flag);
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0 || String(value) !== raw.trim()) {
    return `--${flag} must be a positive integer, got '${raw}'`;
  }
  return value;
}

function report(result: LeaseResult | StatusResult, json: boolean): number {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.kind === 'ok') {
    process.stdout.write(`[agent-lease] OK ${result.message}\n`);
  } else {
    process.stderr.write(`[agent-lease] ${result.reason} (${result.kind.toUpperCase()}) ${result.message}\n`);
    for (const entry of result.steps) {
      process.stderr.write(`  step ${entry.step} ${entry.id}: ${entry.satisfied ? 'ok' : 'UNPROVEN'} — ${entry.detail}\n`);
    }
  }
  return exitCodeFor(result);
}

function usageError(message: string): number {
  process.stderr.write(`[agent-lease] INCONCLUSIVE ${message}\n\n${USAGE}\n`);
  return EXIT_INCONCLUSIVE;
}

function runCheckPath(args: ParsedArgs, cwd: string, json: boolean): number {
  if (args.positional.length === 0) return usageError('check-path requires at least one path');
  const status = statusLease({ cwd });
  if (status.kind !== 'ok') return report(status, json);
  if (status.record === null) {
    return usageError('there is no lease on this worktree, so allowedPaths cannot be checked');
  }
  const violations = checkAllowedPaths(status.record, args.positional);
  if (violations.length === 0) {
    process.stdout.write(`[agent-lease] OK ${args.positional.length} path(s) within allowedPaths\n`);
    return EXIT_OK;
  }
  return report(
    fail(
      'GIT.LEASE.PATH_NOT_ALLOWED',
      `path(s) outside the lease allowlist [${status.record.allowedPaths.join(', ')}]: ${violations.join(', ')}`,
    ),
    json,
  );
}

export function main(argv: string[]): number {
  const parsed = parseArgs(argv);
  if (typeof parsed === 'string') return usageError(parsed);
  const args = parsed;
  const cwd = args.flags.get('cwd') ?? process.cwd();
  const ttl = parsePositiveInt(args, 'ttl');
  if (typeof ttl === 'string') return usageError(ttl);
  const pid = parsePositiveInt(args, 'pid');
  if (typeof pid === 'string') return usageError(pid);

  const mode = args.flags.get('mode');
  if (mode !== undefined && mode !== 'write' && mode !== 'read') {
    return usageError(`--mode must be 'write' or 'read', got '${mode}'`);
  }
  const allowedPaths = args.allow.length > 0 ? args.allow : undefined;

  switch (args.command) {
    case 'acquire':
    case 'takeover': {
      const missing = requireFlags(args, ['task', 'session', 'tool']);
      if (missing !== null) return usageError(missing);
      const options: TakeoverOptions = {
        cwd,
        taskId: args.flags.get('task') ?? '',
        sessionId: args.flags.get('session') ?? '',
        toolIdentity: args.flags.get('tool') ?? '',
        mode,
        allowedPaths,
        expectBranch: args.flags.get('expect-branch'),
        expectHeadOid: args.flags.get('expect-head'),
        baseOid: args.flags.get('base-oid'),
        planPath: args.flags.get('plan'),
        reason: args.flags.get('reason'),
        ttlSeconds: ttl,
        pid,
      };
      return report(args.command === 'acquire' ? acquireLease(options) : takeoverLease(options), args.json);
    }
    case 'status':
      return report(statusLease({ cwd }), args.json);
    case 'heartbeat':
    case 'release': {
      const missing = requireFlags(args, ['session', 'tool']);
      if (missing !== null) return usageError(missing);
      const options: OwnerOptions = {
        cwd,
        sessionId: args.flags.get('session') ?? '',
        toolIdentity: args.flags.get('tool') ?? '',
        ttlSeconds: ttl,
        pid,
      };
      return report(args.command === 'heartbeat' ? heartbeatLease(options) : releaseLease(options), args.json);
    }
    case 'check-path':
      return runCheckPath(args, cwd, args.json);
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(`${USAGE}\n`);
      return EXIT_OK;
    default:
      return usageError(`unknown command '${args.command}'`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let code = EXIT_INCONCLUSIVE;
  try {
    code = main(process.argv.slice(2));
  } catch (err) {
    // A crash is INCONCLUSIVE, never a clean exit.
    process.stderr.write(`[agent-lease] GIT.WORKTREE.UNACCOUNTED_STATE (INCONCLUSIVE) crashed: ${(err as Error).stack ?? String(err)}\n`);
    code = EXIT_INCONCLUSIVE;
  }
  process.exit(code);
}
