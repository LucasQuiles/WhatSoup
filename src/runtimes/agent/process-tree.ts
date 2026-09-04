import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SIGNAL } from '../../lib/signals.ts';
import { isNonEmptyString } from '../../lib/type-guards.ts';
import { createChildLogger } from '../../logger.ts';
import { bfsFromRoot, buildChildrenIndex, parsePsLines } from './process-tree-parse.ts';

const log = createChildLogger('process-tree');

export type ProcessTreeTerminationErrorCode =
  | 'PROCESS_TREE_INVALID_TARGET'
  | 'PROCESS_TREE_INVALID_GENERATION'
  | 'PROCESS_TREE_LEASE_CONFLICT'
  | 'PROCESS_TREE_INITIAL_CENSUS_UNAVAILABLE'
  | 'PROCESS_TREE_ROOT_IDENTITY_UNVERIFIED'
  | 'PROCESS_TREE_PRE_SIGNAL_CENSUS_UNAVAILABLE'
  | 'PROCESS_TREE_ESCALATION_CENSUS_UNAVAILABLE'
  | 'PROCESS_TREE_FINAL_CENSUS_UNAVAILABLE'
  | 'PROCESS_TREE_SIGNAL_FAILED'
  | 'PROCESS_TREE_SURVIVORS_REMAIN'
  | 'PROCESS_TREE_AMBIGUOUS_IDENTITY_UNRESOLVED'
  | 'PROCESS_TREE_UNEXPECTED_FAILURE';

export type ProcessTreeTerminationRetryClass =
  | 'invalid_request'
  | 'active_lease'
  | 'census_retryable'
  | 'signal_retryable'
  | 'survivor_unresolved'
  | 'unknown';

const RETRY_CLASS_BY_ERROR_CODE: Readonly<
  Record<ProcessTreeTerminationErrorCode, ProcessTreeTerminationRetryClass>
> = {
  PROCESS_TREE_INVALID_TARGET: 'invalid_request',
  PROCESS_TREE_INVALID_GENERATION: 'invalid_request',
  PROCESS_TREE_LEASE_CONFLICT: 'active_lease',
  PROCESS_TREE_INITIAL_CENSUS_UNAVAILABLE: 'census_retryable',
  PROCESS_TREE_ROOT_IDENTITY_UNVERIFIED: 'census_retryable',
  PROCESS_TREE_PRE_SIGNAL_CENSUS_UNAVAILABLE: 'census_retryable',
  PROCESS_TREE_ESCALATION_CENSUS_UNAVAILABLE: 'census_retryable',
  PROCESS_TREE_FINAL_CENSUS_UNAVAILABLE: 'census_retryable',
  PROCESS_TREE_SIGNAL_FAILED: 'signal_retryable',
  PROCESS_TREE_SURVIVORS_REMAIN: 'survivor_unresolved',
  PROCESS_TREE_AMBIGUOUS_IDENTITY_UNRESOLVED: 'census_retryable',
  PROCESS_TREE_UNEXPECTED_FAILURE: 'unknown',
};

export class ProcessTreeTerminationError extends Error {
  readonly code: ProcessTreeTerminationErrorCode;
  readonly retryClass: ProcessTreeTerminationRetryClass;

  constructor(
    code: ProcessTreeTerminationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ProcessTreeTerminationError';
    this.code = code;
    this.retryClass = RETRY_CLASS_BY_ERROR_CODE[code];
  }
}

export const PROCESS_TREE_DIAGNOSTIC_SOURCES = [
  'session_shutdown',
  'stale_session_sweep',
  'ownership_loss_cleanup',
] as const;

export type ProcessTreeDiagnosticSource = typeof PROCESS_TREE_DIAGNOSTIC_SOURCES[number];

export interface ProcessTreeTarget {
  readonly pid?: number;
  readonly exitCode?: number | null;
  readonly signalCode?: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): boolean;
}

/**
 * #1755: outcome of a kill-session-tree attempt, emitted via `onOutcome` so the
 * shutdown phase is attributable without journal archaeology.
 *  - `terminated`: every owned process is provably gone.
 *  - `escalated`: at least one confirmed survivor was SIGKILLed and then verified gone.
 *  - `unresolved_ambiguous`: after bounded re-census, one or more PIDs stayed
 *    ambiguous (never signaled — a duplicate-pid census race or a same-pid/same-start
 *    /different-command reading); shutdown proceeds instead of burning the full grace.
 */
export interface KillSessionOutcome {
  readonly outcome: 'terminated' | 'escalated' | 'unresolved_ambiguous';
  readonly generationMarker: string;
  readonly durationMs: number;
  readonly escalated: boolean;
  readonly ambiguousPids: readonly number[];
}

export interface KillSessionTreeOptions {
  readonly generationMarker: string;
  /**
   * Stable production owner used by the central diagnostic emitter. Tests and
   * library consumers may omit it; the release guard requires it at every
   * production call site. It never changes signal authority.
   */
  readonly diagnosticSource?: ProcessTreeDiagnosticSource;
  /** Numeric durable row reference when one already exists; never synthesize it. */
  readonly diagnosticSessionRowId?: number;
  readonly termGraceMs?: number;
  readonly killGraceMs?: number;
  /**
   * #1755: bounded window to let a transient PID-census ambiguity (a `ps` race, a
   * mid-exit process, or a same-pid/different-command reading) resolve to gone or
   * re-confirm as a survivor before we record it as unresolved. Default 250ms.
   */
  readonly ambiguityResolveMs?: number;
  /** #1755: per-tree shutdown outcome sink (telemetry). Best-effort; never throws. */
  readonly onOutcome?: (outcome: KillSessionOutcome) => void;
  /**
   * #1869: per-teardown cgroup-vs-PPID divergence sink (telemetry). Best-effort;
   * never throws and never affects termination. The reaper owns processes by PPID
   * descent from the provider root, but the service cgroup can hold members that
   * reparented off that tree (e.g. workload ssh-agents that double-fork to the
   * user manager); those are invisible to PPID descent and accumulate silently.
   * This surfaces the raw divergence (the metric this issue's evidence used —
   * "125 processes in the cgroup") so unbounded growth is observable before it
   * bites, without changing what the reaper kills. See #1869.
   */
  readonly onCgroupDivergence?: (info: CgroupDivergenceInfo) => void;
  /**
   * #1869: injectable reader for the current unit's cgroup member PIDs (test seam;
   * defaults to a fail-safe Linux cgroup.procs reader). Returns `null` when cgroup
   * membership cannot be determined (non-Linux, cgroup v1, read/parse failure) —
   * in which case no divergence telemetry is emitted.
   */
  readonly readCgroupMemberPids?: () => readonly number[] | null;
}

/**
 * #1869: coarse, assumption-free divergence gauge emitted at each teardown.
 * `offTreeCount` is the count of cgroup members not in this session's PPID-owned
 * set (excluding the provider root itself) — a superset of the leaked reparented
 * daemons (it also includes the main process and other sessions), so it is a
 * trend gauge, NOT a per-session leak attribution. Classifying which off-tree
 * members are session-owned-and-leaked requires a leak-signature decision that is
 * out of scope here (tracked on #1869's reclaim design).
 */
export interface CgroupDivergenceInfo {
  readonly cgroupMemberCount: number;
  readonly ownedCount: number;
  readonly offTreeCount: number;
}

interface ProcessCensusRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly startedAt: string;
  readonly command: string;
}

interface OwnedProcessIdentity extends ProcessCensusRow {
  readonly depth: number;
  readonly generationMarker: string;
}

interface TerminationContext {
  readonly generationMarker: string;
  readonly promise: Promise<void>;
  readonly telemetry: TerminationTelemetry;
}

interface TelemetryObserver<T> {
  readonly sink: (value: T) => void;
  readonly options: KillSessionTreeOptions;
}

interface TerminationTelemetry {
  readonly outcomeObservers: Set<TelemetryObserver<KillSessionOutcome>>;
  readonly divergenceObservers: Set<TelemetryObserver<CgroupDivergenceInfo>>;
  lastOutcome: KillSessionOutcome | null;
  lastDivergence: CgroupDivergenceInfo | null;
}

interface OwnedExitCheck {
  readonly survivors: readonly OwnedProcessIdentity[];
  readonly ambiguous: readonly OwnedProcessIdentity[];
  readonly verified: boolean;
  readonly censusError: unknown | null;
}

interface OwnedInspection {
  readonly survivors: readonly OwnedProcessIdentity[];
  readonly ambiguous: readonly OwnedProcessIdentity[];
}

const DEFAULT_TERM_GRACE_MS = 5_000;
const DEFAULT_KILL_GRACE_MS = 1_000;
const RECHECK_INTERVAL_MS = 25;
// #1755: bounded window to resolve a transient PID-census ambiguity before it is
// recorded as unresolved (never signaled). Kept short — most ambiguity is a `ps`
// race or a mid-exit process that clears within a read or two.
const DEFAULT_AMBIGUITY_RESOLVE_MS = 250;
const activeTerminations = new Map<number, TerminationContext>();

function parseProcessCensus(output: string): ProcessCensusRow[] {
  return parsePsLines(
    output,
    (line) => {
      const match = line.match(
        /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)\s*$/,
      );
      if (!match) return null;
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        pgid: Number(match[3]),
        startedAt: match[4],
        command: match[5],
      };
    },
    { skipHeaderLine: true },
  );
}

function readProcessCensus(): ProcessCensusRow[] {
  const output = execFileSync(
    'ps',
    ['-eo', 'pid,ppid,pgid,lstart,command'],
    { encoding: 'utf8', timeout: 2_000, maxBuffer: 16 * 1024 * 1024 },
  );
  return parseProcessCensus(output);
}

function uniqueRowForPid(rows: readonly ProcessCensusRow[], pid: number): ProcessCensusRow | null {
  const matches = rows.filter((row) => row.pid === pid);
  return matches.length === 1 ? matches[0] : null;
}

function snapshotOwnedTree(
  rows: readonly ProcessCensusRow[],
  rootPid: number,
  generationMarker: string,
): OwnedProcessIdentity[] {
  const root = uniqueRowForPid(rows, rootPid);
  if (!root) return [];

  const childrenIndex = buildChildrenIndex(rows, (row) => row.ppid);
  const walked = bfsFromRoot(childrenIndex, root, (row) => row.pid);
  return walked.map(({ row, depth }) => ({ ...row, depth, generationMarker }));
}

function sameProcess(
  row: ProcessCensusRow,
  owned: OwnedProcessIdentity,
  generationMarker: string,
): boolean {
  return row.pid === owned.pid &&
    row.startedAt === owned.startedAt &&
    row.command === owned.command &&
    owned.generationMarker === generationMarker;
}

function inspectOwned(
  rows: readonly ProcessCensusRow[],
  owned: readonly OwnedProcessIdentity[],
  generationMarker: string,
): OwnedInspection {
  const survivors: OwnedProcessIdentity[] = [];
  const ambiguous: OwnedProcessIdentity[] = [];
  for (const identity of owned) {
    const matches = rows.filter((row) => row.pid === identity.pid);
    if (matches.length === 0) continue;
    if (matches.length !== 1) {
      ambiguous.push(identity);
      continue;
    }
    const current = matches[0];
    if (current.startedAt !== identity.startedAt) continue;
    if (!sameProcess(current, identity, generationMarker)) {
      ambiguous.push(identity);
      continue;
    }
    survivors.push(identity);
  }
  return { survivors, ambiguous };
}

function targetPid(target: number | ProcessTreeTarget): number {
  const pid = typeof target === 'number' ? target : target.pid;
  if (!Number.isSafeInteger(pid) || (pid ?? 0) <= 1) {
    throw new ProcessTreeTerminationError(
      'PROCESS_TREE_INVALID_TARGET',
      `Cannot reap invalid session process PID ${String(pid)}`,
    );
  }
  return pid as number;
}

function signalPid(
  target: number | ProcessTreeTarget,
  rootPid: number,
  pid: number,
  signal: NodeJS.Signals,
): void {
  try {
    if (typeof target !== 'number' && pid === rootPid) {
      target.kill(signal);
    } else {
      process.kill(pid, signal);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw new ProcessTreeTerminationError(
        'PROCESS_TREE_SIGNAL_FAILED',
        `Unable to signal owned session process with ${signal}`,
        { cause: error },
      );
    }
  }
}

function signalOwned(
  target: number | ProcessTreeTarget,
  rootPid: number,
  rows: readonly ProcessCensusRow[],
  owned: readonly OwnedProcessIdentity[],
  signal: NodeJS.Signals,
  generationMarker: string,
): void {
  const root = uniqueRowForPid(rows, rootPid);
  const ownedRoot = owned.find((identity) => identity.pid === rootPid) ?? null;
  const self = uniqueRowForPid(rows, process.pid);
  // #1755: the process-group broadcast below is indiscriminate over root.pgid.
  // Never let it reach a process that is not a confirmed owned identity.
  // A process-group signal reaches every current member, including processes
  // that are not descendants of this provider root. Broadcast only when the
  // same full-system census proves every member of the root group is one of the
  // confirmed PPID-owned identities. Otherwise signal those identities by PID.
  const rootGroupFullyOwned =
    root !== null &&
    rows
      .filter((row) => row.pgid === root.pgid)
      .every((row) =>
        owned.some((identity) => sameProcess(row, identity, generationMarker)),
      );
  const safeGroup = root !== null &&
    ownedRoot !== null &&
    sameProcess(root, ownedRoot, generationMarker) &&
    self !== null &&
    root.pgid === root.pid &&
    root.pgid !== self.pgid &&
    rootGroupFullyOwned;
  let groupSignalled = false;

  if (safeGroup) {
    try {
      process.kill(-root.pgid, signal);
      groupSignalled = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        groupSignalled = false;
      }
    }
  }

  for (const identity of [...owned].sort((left, right) => right.depth - left.depth)) {
    const current = uniqueRowForPid(rows, identity.pid);
    if (groupSignalled && current?.pgid === root?.pgid) continue;
    signalPid(target, rootPid, identity.pid, signal);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForOwnedExit(
  owned: readonly OwnedProcessIdentity[],
  generationMarker: string,
  timeoutMs: number,
): Promise<OwnedExitCheck> {
  const deadline = Date.now() + timeoutMs;
  let survivors: readonly OwnedProcessIdentity[] = owned;
  let ambiguous: readonly OwnedProcessIdentity[] = [];
  let censusError: unknown | null = null;
  do {
    try {
      const inspection = inspectOwned(readProcessCensus(), owned, generationMarker);
      survivors = inspection.survivors;
      ambiguous = inspection.ambiguous;
      censusError = null;
      if (survivors.length === 0 && ambiguous.length === 0) {
        return { survivors: [], ambiguous: [], verified: true, censusError: null };
      }
    } catch (error) {
      survivors = owned;
      ambiguous = [];
      censusError = error;
    }
    if (Date.now() >= deadline) {
      return { survivors, ambiguous, verified: censusError === null, censusError };
    }
    await delay(Math.min(RECHECK_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  } while (true);
}

interface ResolvedInspection {
  readonly rows: readonly ProcessCensusRow[];
  readonly survivors: readonly OwnedProcessIdentity[];
  readonly ambiguous: readonly OwnedProcessIdentity[];
}

/**
 * #1755: inspect the owned set and, if any PID is ambiguous, re-census over a
 * bounded window to give a transient ambiguity — a `ps` census race, a mid-exit
 * process, or a same-pid/same-start/different-command reading — a chance to
 * resolve to gone or re-confirm as a `sameProcess` survivor. Throws ONLY if the
 * census cannot be read at all (fail-closed, unchanged). Signals nothing; the
 * caller signals only the returned (confirmed) survivors.
 */
async function resolveOwnedInspection(
  owned: readonly OwnedProcessIdentity[],
  generationMarker: string,
  resolveMs: number,
): Promise<ResolvedInspection> {
  const deadline = Date.now() + Math.max(0, resolveMs);
  let rows = readProcessCensus();
  let inspection = inspectOwned(rows, owned, generationMarker);
  while (inspection.ambiguous.length > 0 && Date.now() < deadline) {
    await delay(Math.min(RECHECK_INTERVAL_MS, Math.max(1, deadline - Date.now())));
    rows = readProcessCensus();
    inspection = inspectOwned(rows, owned, generationMarker);
  }
  return { rows, survivors: inspection.survivors, ambiguous: inspection.ambiguous };
}

async function runTermination(
  target: number | ProcessTreeTarget,
  rootPid: number,
  owned: readonly OwnedProcessIdentity[],
  preCensusError: unknown | null,
  signal: NodeJS.Signals,
  options: KillSessionTreeOptions,
): Promise<void> {
  const generationMarker = options.generationMarker;
  const resolveMs = options.ambiguityResolveMs ?? DEFAULT_AMBIGUITY_RESOLVE_MS;
  const startedAt = Date.now();
  let escalated = false;

  if (owned.length === 0) {
    const censusUnavailable = preCensusError !== null;
    const reason = censusUnavailable ? 'census unavailable' : 'root row missing or ambiguous';
    throw new ProcessTreeTerminationError(
      censusUnavailable
        ? 'PROCESS_TREE_INITIAL_CENSUS_UNAVAILABLE'
        : 'PROCESS_TREE_ROOT_IDENTITY_UNVERIFIED',
      `Refusing to signal session process tree ${generationMarker}: pre-signal ${reason}`,
      censusUnavailable ? { cause: preCensusError } : undefined,
    );
  }

  // Pre-signal. #1755: resolve transient ambiguity over a bounded window, then
  // signal the CONFIRMED survivors only — never an ambiguous PID (a duplicate-pid
  // census race or a same-pid/different-command reading). A census that cannot be
  // read at all still fails closed (unchanged). Ambiguity no longer aborts the
  // whole kill: we signal what we can confirm and record the residue below.
  let first: ResolvedInspection;
  try {
    first = await resolveOwnedInspection(owned, generationMarker, resolveMs);
  } catch (error) {
    throw new ProcessTreeTerminationError(
      'PROCESS_TREE_PRE_SIGNAL_CENSUS_UNAVAILABLE',
      `Refusing to signal session process tree ${generationMarker}: pre-signal recensus unavailable`,
      { cause: error },
    );
  }
  if (first.survivors.length > 0) {
    signalOwned(target, rootPid, first.rows, first.survivors, signal, generationMarker);
  }

  if (signal === SIGNAL.TERM) {
    const termCheck = await waitForOwnedExit(
      owned,
      generationMarker,
      options.termGraceMs ?? DEFAULT_TERM_GRACE_MS,
    );
    // Escalate the still-present set (survivors + any still-ambiguous), re-resolved:
    // confirmed survivors get SIGKILL, residual ambiguous is left alone and recorded.
    const pending = [...termCheck.survivors, ...termCheck.ambiguous];
    if (pending.length > 0) {
      let kill: ResolvedInspection;
      try {
        kill = await resolveOwnedInspection(pending, generationMarker, resolveMs);
      } catch (error) {
        throw new ProcessTreeTerminationError(
          'PROCESS_TREE_ESCALATION_CENSUS_UNAVAILABLE',
          `Refusing to escalate session process tree ${generationMarker}: recensus unavailable`,
          { cause: error },
        );
      }
      if (kill.survivors.length > 0) {
        escalated = true;
        signalOwned(target, rootPid, kill.rows, kill.survivors, SIGNAL.KILL, generationMarker);
      }
    }
  }

  const finalCheck = await waitForOwnedExit(
    owned,
    generationMarker,
    options.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
  );
  if (!finalCheck.verified) {
    throw new ProcessTreeTerminationError(
      'PROCESS_TREE_FINAL_CENSUS_UNAVAILABLE',
      `Unable to prove session process tree ${generationMarker} empty: final census unavailable`,
      { cause: finalCheck.censusError },
    );
  }
  // A CONFIRMED survivor that outlived SIGKILL is a genuine failure (unkillable /
  // zombie) — still fail closed. Residual AMBIGUOUS identity is NOT: it is never
  // signaled, so recording it (below) and letting shutdown proceed is strictly
  // better than burning the full grace and being SIGKILLed by the service manager.
  if (finalCheck.survivors.length > 0) {
    throw new ProcessTreeTerminationError(
      'PROCESS_TREE_SURVIVORS_REMAIN',
      `Session process tree ${generationMarker} still has live PIDs: ` +
        finalCheck.survivors.map((row) => row.pid).join(', '),
    );
  }

  const ambiguousPids = finalCheck.ambiguous.map((identity) => identity.pid);
  const outcome: KillSessionOutcome['outcome'] =
    ambiguousPids.length > 0 ? 'unresolved_ambiguous' : escalated ? 'escalated' : 'terminated';
  const diagnostic = diagnosticContext(options);
  if (diagnostic) {
    const record = {
      ...diagnostic,
      signal,
      outcome,
      escalated,
      durationMs: Date.now() - startedAt,
      ambiguousCount: ambiguousPids.length,
    };
    if (outcome === 'unresolved_ambiguous') {
      log.warn(record, 'process-tree termination outcome');
    } else {
      log.debug(record, 'process-tree termination outcome');
    }
  }
  try {
    options.onOutcome?.({
      outcome,
      generationMarker,
      durationMs: Date.now() - startedAt,
      escalated,
      ambiguousPids,
    });
  } catch (err) {
    // Telemetry is best-effort — never let an outcome sink failure break shutdown.
    log.warn(
      { ...diagnosticContext(options), sink: 'outcome', err },
      'process-tree telemetry sink failed',
    );
  }
}

/**
 * #1869: pure divergence computation — cgroup members not in the PPID-owned set
 * (excluding the provider root). No I/O; fully unit-testable. `cgroupPids` and
 * `owned` are supplied by the caller (real readers in production, synthetic in
 * tests).
 */
export function computeCgroupDivergence(
  cgroupPids: readonly number[],
  owned: readonly { readonly pid: number }[],
  rootPid: number,
): CgroupDivergenceInfo {
  const ownedPids = new Set<number>(owned.map((o) => o.pid));
  ownedPids.add(rootPid);
  let offTreeCount = 0;
  for (const pid of cgroupPids) {
    if (!ownedPids.has(pid)) offTreeCount += 1;
  }
  return { cgroupMemberCount: cgroupPids.length, ownedCount: owned.length, offTreeCount };
}

/**
 * #1869: fail-safe reader for the current unit's cgroup member PIDs (cgroup v2,
 * Linux systemd). Reads `/proc/self/cgroup` for the unified path, then reads
 * `cgroup.procs` recursively under `/sys/fs/cgroup<path>`. Returns `null` on any
 * failure (non-Linux, cgroup v1, missing/unreadable files, parse error) so the
 * caller emits no telemetry rather than guessing. NEVER throws.
 */
function readServiceCgroupMemberPids(): readonly number[] | null {
  try {
    if (process.platform !== 'linux') return null;
    const selfCgroup = readFileSync('/proc/self/cgroup', 'utf8');
    const v2 = selfCgroup.split('\n').map((line) => line.trim()).find((line) => line.startsWith('0::'));
    if (!v2) return null;
    const rel = v2.slice('0::'.length);
    if (!rel.startsWith('/')) return null;
    // Only trust cgroup membership when this process actually runs inside a
    // whatsoup service unit. In any shared cgroup — CI runners, dev shells,
    // user session scopes — the membership list is every process on the box,
    // and treating it as owned would hand the reaper the harness running us
    // (observed: GitHub runners killed mid-suite by their own test process).
    if (!/whatsoup/i.test(rel)) return null;
    const base = join('/sys/fs/cgroup', rel);
    if (!existsSync(base)) return null;
    const pids = new Set<number>();
    const walk = (dir: string): void => {
      const procsFile = join(dir, 'cgroup.procs');
      if (existsSync(procsFile)) {
        for (const line of readFileSync(procsFile, 'utf8').split('\n')) {
          const parsed = Number(line.trim());
          if (Number.isInteger(parsed) && parsed > 0) pids.add(parsed);
        }
      }
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(dir, entry.name));
      }
    };
    walk(base);
    return [...pids];
  } catch {
    return null;
  }
}

/**
 * #1869: best-effort emit of the cgroup-vs-PPID divergence gauge. Fully isolated
 * so any failure is logged and can NEVER affect termination. No-op unless a
 * sink is provided and cgroup membership is readable. A readable census emits
 * zero as well as non-zero divergence so callers receive the documented gauge
 * at each teardown.
 */
export function emitCgroupDivergence(
  owned: readonly { readonly pid: number }[],
  rootPid: number,
  options: KillSessionTreeOptions,
): void {
  const sink = options.onCgroupDivergence;
  const diagnostic = diagnosticContext(options);
  if (!sink && !diagnostic) return;
  try {
    const reader = options.readCgroupMemberPids ?? readServiceCgroupMemberPids;
    const cgroupPids = reader();
    if (cgroupPids === null) return;
    const divergence = computeCgroupDivergence(cgroupPids, owned, rootPid);
    if (diagnostic) {
      log.debug(
        {
          ...diagnostic,
          ...divergence,
        },
        'process-tree cgroup divergence',
      );
    }
    sink?.(divergence);
  } catch (err) {
    // Best-effort telemetry must never affect termination, but failures stay visible.
    log.warn({ err }, 'cgroup divergence telemetry failed');
  }
}

function normalizeTerminationError(error: unknown): ProcessTreeTerminationError {
  return error instanceof ProcessTreeTerminationError
    ? error
    : new ProcessTreeTerminationError(
        'PROCESS_TREE_UNEXPECTED_FAILURE',
        'Unexpected process-tree termination failure',
        { cause: error },
      );
}

function diagnosticContext(
  options: KillSessionTreeOptions,
): { source: ProcessTreeDiagnosticSource; sessionRowId?: number } | null {
  const source = options.diagnosticSource;
  if (!PROCESS_TREE_DIAGNOSTIC_SOURCES.includes(source as ProcessTreeDiagnosticSource)) {
    return null;
  }
  const sessionRowId = options.diagnosticSessionRowId;
  return Number.isSafeInteger(sessionRowId) && (sessionRowId ?? 0) > 0
    ? { source: source as ProcessTreeDiagnosticSource, sessionRowId }
    : { source: source as ProcessTreeDiagnosticSource };
}

function reportTelemetrySinkFailure(
  options: KillSessionTreeOptions,
  sink: 'outcome' | 'cgroup_divergence',
  err: unknown,
): void {
  log.warn(
    { ...diagnosticContext(options), sink, err },
    'process-tree telemetry sink failed',
  );
}

function notifyTelemetryObserver<T>(
  observer: TelemetryObserver<T>,
  value: T,
  sink: 'outcome' | 'cgroup_divergence',
): void {
  try {
    observer.sink(value);
  } catch (err) {
    reportTelemetrySinkFailure(observer.options, sink, err);
  }
}

function addTerminationObservers(
  telemetry: TerminationTelemetry,
  options: KillSessionTreeOptions,
  replay: boolean,
): void {
  if (options.onOutcome) {
    const observer = { sink: options.onOutcome, options };
    telemetry.outcomeObservers.add(observer);
    if (replay && telemetry.lastOutcome) {
      notifyTelemetryObserver(observer, telemetry.lastOutcome, 'outcome');
    }
  }
  if (options.onCgroupDivergence) {
    const observer = { sink: options.onCgroupDivergence, options };
    telemetry.divergenceObservers.add(observer);
    if (replay && telemetry.lastDivergence) {
      notifyTelemetryObserver(observer, telemetry.lastDivergence, 'cgroup_divergence');
    }
  }
}

function broadcastOutcome(telemetry: TerminationTelemetry, outcome: KillSessionOutcome): void {
  telemetry.lastOutcome = outcome;
  for (const observer of telemetry.outcomeObservers) {
    notifyTelemetryObserver(observer, outcome, 'outcome');
  }
}

function broadcastDivergence(
  telemetry: TerminationTelemetry,
  divergence: CgroupDivergenceInfo,
): void {
  telemetry.lastDivergence = divergence;
  for (const observer of telemetry.divergenceObservers) {
    notifyTelemetryObserver(observer, divergence, 'cgroup_divergence');
  }
}

function boundedSystemErrorCode(error: ProcessTreeTerminationError): string | undefined {
  const cause = error.cause as { code?: unknown } | undefined;
  const code = cause?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/.test(code)
    ? code
    : undefined;
}

function emitTerminationFailure(
  options: KillSessionTreeOptions,
  error: ProcessTreeTerminationError,
): void {
  const diagnostic = diagnosticContext(options);
  if (!diagnostic) return;
  const causeCode = boundedSystemErrorCode(error);
  log.warn(
    {
      ...diagnostic,
      errorCode: error.code,
      retryClass: error.retryClass,
      ...(causeCode === undefined ? {} : { causeCode }),
    },
    'process-tree termination failed',
  );
}

function rejectTermination(
  options: KillSessionTreeOptions,
  error: ProcessTreeTerminationError,
): Promise<never> {
  emitTerminationFailure(options, error);
  return Promise.reject(error);
}

export function killSessionTree(
  target: number | ProcessTreeTarget,
  signal: NodeJS.Signals,
  options: KillSessionTreeOptions,
): Promise<void> {
  if (!isNonEmptyString(options.generationMarker)) {
    return rejectTermination(
      options,
      new ProcessTreeTerminationError(
        'PROCESS_TREE_INVALID_GENERATION',
        'Session process-tree generation marker must be non-empty',
      ),
    );
  }
  let rootPid: number;
  try {
    rootPid = targetPid(target);
  } catch (error) {
    const normalized = normalizeTerminationError(error);
    return rejectTermination(options, normalized);
  }
  const existing = activeTerminations.get(rootPid);
  if (existing) {
    if (existing.generationMarker !== options.generationMarker) {
      return rejectTermination(
        options,
        new ProcessTreeTerminationError(
          'PROCESS_TREE_LEASE_CONFLICT',
          `Refusing process-tree lease change for active PID ${rootPid}: ` +
            `${existing.generationMarker} -> ${options.generationMarker}`,
        ),
      );
    }
    addTerminationObservers(existing.telemetry, options, true);
    return existing.promise;
  }

  const telemetry: TerminationTelemetry = {
    outcomeObservers: new Set(),
    divergenceObservers: new Set(),
    lastOutcome: null,
    lastDivergence: null,
  };
  addTerminationObservers(telemetry, options, false);
  const multiplexedOptions: KillSessionTreeOptions = {
    ...options,
    onOutcome: (outcome) => broadcastOutcome(telemetry, outcome),
    onCgroupDivergence: (divergence) => broadcastDivergence(telemetry, divergence),
  };

  let owned: OwnedProcessIdentity[];
  let preCensusError: unknown | null = null;
  try {
    owned = snapshotOwnedTree(readProcessCensus(), rootPid, options.generationMarker);
  } catch (error) {
    owned = [];
    preCensusError = error;
  }

  // Cgroup membership proves only service-unit co-location, not ownership by
  // this provider session. Keep it observational until per-session attribution exists.
  emitCgroupDivergence(owned, rootPid, multiplexedOptions);

  let context: TerminationContext;
  const promise = runTermination(target, rootPid, owned, preCensusError, signal, multiplexedOptions)
    .catch((error: unknown) => {
      const normalized = normalizeTerminationError(error);
      emitTerminationFailure(multiplexedOptions, normalized);
      throw normalized;
    })
    .finally(() => {
      if (activeTerminations.get(rootPid) === context) activeTerminations.delete(rootPid);
    });
  context = {
    generationMarker: options.generationMarker,
    promise,
    telemetry,
  };
  activeTerminations.set(rootPid, context);
  return promise;
}
