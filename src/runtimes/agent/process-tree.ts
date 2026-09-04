import { execFileSync } from 'node:child_process';
import { systemClock } from '../../lib/clock.ts';
import { SIGNAL } from '../../lib/signals.ts';
import {
  processBirthTokenSupportsNumericSignal,
  probeProcessBirthToken,
  probeProcessBirthTokens,
} from '../../lib/process-identity.ts';
import { createChildLogger } from '../../logger.ts';
import { bfsFromRoot, buildChildrenIndex } from './process-tree-parse.ts';
import {
  observeCgroupMemberPids,
  type CgroupMemberPidReader,
} from './process-tree-cgroup.ts';
import {
  PROCESS_TREE_DIAGNOSTIC_SOURCES,
  PROCESS_TREE_MAX_DURATION_MS,
  ProcessTreeTerminationError,
  type CgroupDivergenceInfo,
  type KillSessionOutcome,
  type ProcessTreeDiagnosticFailureCode,
  type ProcessTreeDiagnosticSource,
  type ProcessTreeRootAuthority,
  type ProcessTreeTerminationErrorCode,
  type ProcessTreeTerminationRetryClass,
} from './process-tree-contract.ts';

export {
  PROCESS_TREE_DIAGNOSTIC_FAILURE_CODES,
  PROCESS_TREE_DIAGNOSTIC_SOURCES,
  PROCESS_TREE_MAX_DURATION_MS,
  PROCESS_TREE_TERMINATION_ERROR_CODES,
  ProcessTreeTerminationError,
  processTreeFailureDiagnostic,
} from './process-tree-contract.ts';
export type {
  CgroupDivergenceInfo,
  KillSessionOutcome,
  ProcessTreeDiagnosticFailureCode,
  ProcessTreeDiagnosticSource,
  ProcessTreeRootAuthority,
  ProcessTreeTerminationErrorCode,
  ProcessTreeTerminationRetryClass,
} from './process-tree-contract.ts';

const log = createChildLogger('process-tree');

export interface ProcessTreeTarget {
  readonly pid?: number;
  readonly exitCode?: number | null;
  readonly signalCode?: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): boolean;
}

interface ProcessTreeRootAuthorityBinding {
  readonly target: ProcessTreeTarget;
  readonly pid: number;
  readonly parentPid: number;
  readonly birthToken: string;
  signalRoot(signal: NodeJS.Signals): boolean;
}

const REFLECT_APPLY = Reflect.apply;
const OBJECT_FREEZE = Object.freeze;
const WEAK_MAP_GET = WeakMap.prototype.get;
const WEAK_MAP_SET = WeakMap.prototype.set;
const WEAK_MAP_DELETE = WeakMap.prototype.delete;
const processTreeRootAuthorityBindings = new WeakMap<
  object,
  Readonly<ProcessTreeRootAuthorityBinding>
>();
const MAX_REGISTERED_SESSION_AUTHORITIES = 4_096;
interface RegisteredSessionAuthority {
  readonly authority: ProcessTreeRootAuthority;
  readonly target: ProcessTreeTarget;
  readonly pid: number;
  readonly provider: string;
}

const registeredSessionAuthorities = new Map<
  number,
  Readonly<RegisteredSessionAuthority>
>();
let registeredSessionRowByAuthority = new WeakMap<object, number>();

function rootAuthorityBinding(value: unknown): Readonly<ProcessTreeRootAuthorityBinding> | null {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return null;
  try {
    return REFLECT_APPLY(
      WEAK_MAP_GET,
      processTreeRootAuthorityBindings,
      [value],
    ) as Readonly<ProcessTreeRootAuthorityBinding> | undefined ?? null;
  } catch {
    return null;
  }
}

/**
 * Mint same-process authority for an exact child handle at spawn time.
 * The returned object is deliberately not a data credential: copies and
 * serialized forms are rejected because the private WeakMap binding is the
 * authority. A null result means the child identity could not be frozen.
 */
export function captureProcessTreeRootAuthority(
  target: ProcessTreeTarget,
): ProcessTreeRootAuthority | null {
  try {
    if (typeof target !== 'object' || target === null || Array.isArray(target)) return null;
    const pid = target.pid;
    if (!Number.isSafeInteger(pid) || (pid as number) <= 1) return null;
    const kill = target.kill;
    if (typeof kill !== 'function') return null;
    if (target.exitCode !== undefined && target.exitCode !== null) return null;
    if (target.signalCode !== undefined && target.signalCode !== null) return null;
    const birthToken = probeProcessBirthToken(pid as number);
    if (birthToken === null) return null;
    const authority = OBJECT_FREEZE({
      pid: pid as number,
      parentPid: process.pid,
      birthToken,
    });
    const binding = OBJECT_FREEZE({
      target,
      pid: pid as number,
      parentPid: process.pid,
      birthToken,
      signalRoot: (signal: NodeJS.Signals) => REFLECT_APPLY(kill, target, [signal]),
    });
    REFLECT_APPLY(
      WEAK_MAP_SET,
      processTreeRootAuthorityBindings,
      [authority, binding],
    );
    return authority;
  } catch {
    return null;
  }
}

export interface RegisteredProcessTreeTerminationLease {
  readonly target: ProcessTreeTarget;
  readonly rootAuthority: ProcessTreeRootAuthority;
}

type ProcessTreeTargetState = 'live' | 'terminal' | 'unverifiable';

function processTreeTargetState(target: ProcessTreeTarget): ProcessTreeTargetState {
  try {
    return (
      (target.exitCode !== undefined && target.exitCode !== null)
      || (target.signalCode !== undefined && target.signalCode !== null)
    ) ? 'terminal' : 'live';
  } catch {
    return 'unverifiable';
  }
}

function registeredRowForAuthority(authority: ProcessTreeRootAuthority): number | undefined {
  try {
    return REFLECT_APPLY(
      WEAK_MAP_GET,
      registeredSessionRowByAuthority,
      [authority],
    ) as number | undefined;
  } catch {
    return undefined;
  }
}

function deleteRegisteredSessionAuthority(
  sessionRowId: number,
  registered: Readonly<RegisteredSessionAuthority>,
): void {
  if (registeredSessionAuthorities.get(sessionRowId) !== registered) return;
  registeredSessionAuthorities.delete(sessionRowId);
  if (registeredRowForAuthority(registered.authority) !== sessionRowId) return;
  try {
    REFLECT_APPLY(
      WEAK_MAP_DELETE,
      registeredSessionRowByAuthority,
      [registered.authority],
    );
  } catch {
    // Intentional: the forward binding is removed and a stale reverse fence fails closed.
  }
}

function reclaimTerminalSessionAuthorities(): void {
  for (const [sessionRowId, registered] of registeredSessionAuthorities) {
    if (processTreeTargetState(registered.target) === 'terminal') {
      deleteRegisteredSessionAuthority(sessionRowId, registered);
    }
  }
}

/** Bind a spawn-time capability to the durable row that owns that child. */
export function bindProcessTreeRootAuthority(
  authority: ProcessTreeRootAuthority,
  sessionRowId: number,
  provider: string,
): boolean {
  const binding = rootAuthorityBinding(authority);
  if (
    binding === null
    || !Number.isSafeInteger(sessionRowId)
    || sessionRowId <= 0
    || typeof provider !== 'string'
    || provider.length === 0
    || provider.length > 128
    || processTreeTargetState(binding.target) !== 'live'
  ) return false;
  const boundRowId = registeredRowForAuthority(authority);
  if (boundRowId !== undefined && boundRowId !== sessionRowId) return false;
  const existing = registeredSessionAuthorities.get(sessionRowId);
  if (existing !== undefined && existing.authority !== authority) {
    if (processTreeTargetState(existing.target) !== 'terminal') return false;
    deleteRegisteredSessionAuthority(sessionRowId, existing);
  } else if (existing !== undefined) {
    return existing.provider === provider;
  }
  if (
    !registeredSessionAuthorities.has(sessionRowId)
    && registeredSessionAuthorities.size >= MAX_REGISTERED_SESSION_AUTHORITIES
  ) {
    reclaimTerminalSessionAuthorities();
    if (registeredSessionAuthorities.size >= MAX_REGISTERED_SESSION_AUTHORITIES) return false;
  }
  const registered = OBJECT_FREEZE({
    authority,
    target: binding.target,
    pid: binding.pid,
    provider,
  });
  registeredSessionAuthorities.set(sessionRowId, registered);
  try {
    REFLECT_APPLY(
      WEAK_MAP_SET,
      registeredSessionRowByAuthority,
      [authority, sessionRowId],
    );
  } catch {
    registeredSessionAuthorities.delete(sessionRowId);
    return false;
  }
  return true;
}

/**
 * Resolve stale-row cleanup only when this process still owns the exact
 * spawn-time handle bound to that row. Persisted PID metadata alone is never
 * upgraded into signal authority.
 */
export function getRegisteredProcessTreeTerminationLease(
  sessionRowId: number,
  pid: number,
  provider: string | null,
): RegisteredProcessTreeTerminationLease | null {
  const registered = registeredSessionAuthorities.get(sessionRowId);
  const targetState = registered === undefined
    ? null
    : processTreeTargetState(registered.target);
  if (
    registered === undefined
    || registered.pid !== pid
    || registered.provider !== provider
    || targetState !== 'live'
  ) {
    if (registered !== undefined && targetState === 'terminal') {
      deleteRegisteredSessionAuthority(sessionRowId, registered);
    }
    return null;
  }
  const binding = rootAuthorityBinding(registered.authority);
  if (
    binding === null
    || binding.target !== registered.target
    || probeProcessBirthToken(pid) !== binding.birthToken
  ) return null;
  return { target: registered.target, rootAuthority: registered.authority };
}

function releaseRegisteredProcessTreeTerminationLease(
  authority: ProcessTreeRootAuthority,
): void {
  const sessionRowId = registeredRowForAuthority(authority);
  if (sessionRowId === undefined) return;
  const registered = registeredSessionAuthorities.get(sessionRowId);
  if (registered?.authority === authority) {
    deleteRegisteredSessionAuthority(sessionRowId, registered);
  }
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
export interface KillSessionTreeOptions {
  readonly generationMarker: string;
  /** Authority captured before cleanup began; a PID alone never grants signal authority. */
  readonly rootAuthority: ProcessTreeRootAuthority;
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
  readonly readCgroupMemberPids?: CgroupMemberPidReader;
}

type CgroupDivergenceOptions = Omit<KillSessionTreeOptions, 'rootAuthority'> & {
  readonly rootAuthority?: ProcessTreeRootAuthority;
};

interface CapturedKillSessionTreeOptions {
  readonly generationMarker: unknown;
  readonly rootAuthority: unknown;
  readonly diagnosticSource: unknown;
  readonly diagnosticSessionRowId: unknown;
  readonly termGraceMs: unknown;
  readonly killGraceMs: unknown;
  readonly ambiguityResolveMs: unknown;
  readonly onOutcome: unknown;
  readonly onCgroupDivergence: unknown;
  readonly readCgroupMemberPids: unknown;
}

interface NormalizedProcessTreeTarget {
  readonly pid: number;
  readonly source: ProcessTreeTarget | null;
  signalRoot(signal: NodeJS.Signals): boolean;
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
  readonly birthToken: string;
}

interface TerminationContext {
  readonly rootPid: number;
  readonly generationMarker: string;
  readonly target: NormalizedProcessTreeTarget;
  readonly signal: NodeJS.Signals;
  readonly options: KillSessionTreeOptions;
  readonly executionOptions: KillSessionTreeOptions;
  readonly lease: OwnedTreeLease;
  readonly telemetry: TerminationTelemetry;
  readonly expiresAt: number;
  attemptCount: number;
  state: 'active' | 'retained' | 'nonretryable' | 'expired';
  promise: Promise<KillSessionOutcome> | null;
}

interface TelemetryObserver<T> {
  readonly sink: (value: T) => void;
  readonly options: KillSessionTreeOptions;
}

interface TerminationTelemetry {
  readonly outcomeObservers: Set<TelemetryObserver<KillSessionOutcome>>;
  readonly divergenceObservers: Set<TelemetryObserver<CgroupDivergenceInfo>>;
  readonly diagnosticCodes: Set<ProcessTreeDiagnosticFailureCode>;
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
const MAX_OWNED_IDENTITIES = 4_096;
const MAX_RETAINED_TERMINATION_LEASES = 64;
const MAX_TERMINATION_ATTEMPTS = 5;
const TERMINATION_LEASE_TTL_MS = 120_000;
const terminationLeases = new Map<number, TerminationContext>();

type CensusUnavailableCode =
  | 'PROCESS_TREE_INITIAL_CENSUS_UNAVAILABLE'
  | 'PROCESS_TREE_PRE_SIGNAL_CENSUS_UNAVAILABLE'
  | 'PROCESS_TREE_ESCALATION_CENSUS_UNAVAILABLE'
  | 'PROCESS_TREE_FINAL_CENSUS_UNAVAILABLE'
  | 'PROCESS_TREE_SIGNAL_FAILED';

interface OwnedTreeSnapshot {
  readonly rootState: 'present' | 'missing' | 'ambiguous' | 'unverified';
  readonly owned: readonly OwnedProcessIdentity[];
}

interface OwnedTreeLease {
  readonly rootAuthority: ProcessTreeRootAuthority;
  readonly owned: OwnedProcessIdentity[];
}

interface CoreKillSessionOutcome {
  readonly outcome: KillSessionOutcome['outcome'];
  readonly durationMs: number;
  readonly ownedProcessCount: number;
  readonly signaledProcessCount: number;
  readonly ambiguousProcessCount: number;
}

function boundedDuration(startedAt: number): number {
  const elapsed = systemClock.now() - startedAt;
  if (!Number.isFinite(elapsed) || elapsed <= 0) return 0;
  return Math.min(PROCESS_TREE_MAX_DURATION_MS, Math.floor(elapsed));
}

function parseProcessCensus(output: string): ProcessCensusRow[] {
  if (typeof output !== 'string') {
    throw new ProcessTreeTerminationError(
      'PROCESS_TREE_CENSUS_MALFORMED',
      'Process census did not return text',
    );
  }
  const lines = output.split('\n');
  const header = lines[0]?.trim().split(/\s+/);
  if (
    !header
    || header.length !== 5
    || header[0] !== 'PID'
    || header[1] !== 'PPID'
    || header[2] !== 'PGID'
    || header[3] !== 'STARTED'
    || header[4] !== 'COMMAND'
  ) {
    throw new ProcessTreeTerminationError(
      'PROCESS_TREE_CENSUS_MALFORMED',
      'Process census header is malformed',
    );
  }
  const rows: ProcessCensusRow[] = [];
  for (const [index, line] of lines.slice(1).entries()) {
    if (line.trim().length === 0) continue;
    const match = line.match(
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*?)\s*$/,
    );
    if (!match || match[5].length === 0) {
      throw new ProcessTreeTerminationError(
        'PROCESS_TREE_CENSUS_MALFORMED',
        `Process census row ${index + 1} is malformed`,
      );
    }
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const pgid = Number(match[3]);
    if (
      !Number.isSafeInteger(pid) || pid <= 0
      || !Number.isSafeInteger(ppid) || ppid < 0
      || !Number.isSafeInteger(pgid) || pgid <= 0
    ) {
      throw new ProcessTreeTerminationError(
        'PROCESS_TREE_CENSUS_MALFORMED',
        `Process census row ${index + 1} has invalid identifiers`,
      );
    }
    rows.push({ pid, ppid, pgid, startedAt: match[4], command: match[5] });
  }
  return rows;
}

function systemErrorCode(error: unknown): string | null {
  try {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === 'string' ? code : null;
  } catch {
    return null;
  }
}

function normalizeCensusFailure(
  error: unknown,
  unavailableCode: CensusUnavailableCode,
): ProcessTreeTerminationError {
  if (error instanceof ProcessTreeTerminationError) return error;
  const code = systemErrorCode(error);
  if (code === 'EACCES' || code === 'EPERM') {
    return new ProcessTreeTerminationError(
      'PROCESS_TREE_CENSUS_PERMISSION_DENIED',
      'Process census permission was denied',
      { systemCode: code },
    );
  }
  return new ProcessTreeTerminationError(
    unavailableCode,
    'Process census is unavailable',
    { systemCode: code },
  );
}

function readProcessCensus(unavailableCode: CensusUnavailableCode): ProcessCensusRow[] {
  try {
    const output = execFileSync(
      'ps',
      ['-eo', 'pid,ppid,pgid,lstart,command'],
      { encoding: 'utf8', timeout: 2_000, maxBuffer: 16 * 1024 * 1024 },
    );
    return parseProcessCensus(output);
  } catch (error) {
    throw normalizeCensusFailure(error, unavailableCode);
  }
}

function uniqueRowForPid(rows: readonly ProcessCensusRow[], pid: number): ProcessCensusRow | null {
  const matches = rows.filter((row) => row.pid === pid);
  return matches.length === 1 ? matches[0] : null;
}

function snapshotOwnedTree(
  rows: readonly ProcessCensusRow[],
  rootPid: number,
  generationMarker: string,
  rootAuthority: ProcessTreeRootAuthority,
): OwnedTreeSnapshot {
  const roots = rows.filter((row) => row.pid === rootPid);
  if (roots.length === 0) return { rootState: 'missing', owned: [] };
  if (roots.length !== 1) return { rootState: 'ambiguous', owned: [] };
  const root = roots[0];
  if (
    rootAuthority.pid !== rootPid
    || root.ppid !== rootAuthority.parentPid
  ) {
    return { rootState: 'unverified', owned: [] };
  }

  const childrenIndex = buildChildrenIndex(rows, (row) => row.ppid);
  const walked = bfsFromRoot(childrenIndex, root, (row) => row.pid);
  if (walked.length > MAX_OWNED_IDENTITIES) {
    throw new ProcessTreeTerminationError(
      'PROCESS_TREE_IDENTITY_LIMIT',
      'Session process tree exceeds the bounded identity limit',
    );
  }
  const birthTokens = probeProcessBirthTokens(walked.map(({ row }) => row.pid));
  if (birthTokens?.get(rootPid) !== rootAuthority.birthToken) {
    return { rootState: 'unverified', owned: [] };
  }
  const owned: OwnedProcessIdentity[] = [];
  for (const { row, depth } of walked) {
    const birthToken = birthTokens.get(row.pid) ?? null;
    if (birthToken === null) {
      throw new ProcessTreeTerminationError(
        'PROCESS_TREE_AMBIGUOUS_IDENTITY_UNRESOLVED',
        'Session process identity could not be frozen',
      );
    }
    owned.push({ ...row, depth, generationMarker, birthToken });
  }
  return {
    rootState: 'present',
    owned,
  };
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
  observedBirthTokens?: ReadonlyMap<number, string> | null,
): OwnedInspection {
  const survivors: OwnedProcessIdentity[] = [];
  const ambiguous: OwnedProcessIdentity[] = [];
  const uniqueMatches = new Map<number, ProcessCensusRow>();
  for (const identity of owned) {
    const matches = rows.filter((row) => row.pid === identity.pid);
    if (matches.length === 1) uniqueMatches.set(identity.pid, matches[0]);
  }
  const birthTokens = observedBirthTokens === undefined
    ? probeProcessBirthTokens([...uniqueMatches.keys()])
    : observedBirthTokens;
  for (const identity of owned) {
    const matches = rows.filter((row) => row.pid === identity.pid);
    if (matches.length === 0) continue;
    if (matches.length !== 1) {
      ambiguous.push(identity);
      continue;
    }
    const current = matches[0];
    const currentBirthToken = birthTokens?.get(identity.pid) ?? null;
    if (currentBirthToken === null) {
      ambiguous.push(identity);
      continue;
    }
    if (currentBirthToken !== identity.birthToken) continue;
    if (current.startedAt !== identity.startedAt) {
      ambiguous.push(identity);
      continue;
    }
    if (!sameProcess(current, identity, generationMarker)) {
      ambiguous.push(identity);
      continue;
    }
    survivors.push(identity);
  }
  return { survivors, ambiguous };
}

function invalidOptions(message: string, cause?: unknown): ProcessTreeTerminationError {
  return new ProcessTreeTerminationError(
    'PROCESS_TREE_INVALID_OPTIONS',
    message,
    cause === undefined ? undefined : { systemCode: systemErrorCode(cause) },
  );
}

function validateDuration(name: string, value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || !Number.isInteger(value) || (value as number) < 0
    || (value as number) > PROCESS_TREE_MAX_DURATION_MS) {
    throw new ProcessTreeTerminationError(
      'PROCESS_TREE_INVALID_DURATION',
      `${name} must be a finite integer from 0 through ${PROCESS_TREE_MAX_DURATION_MS}`,
    );
  }
  return value as number;
}

function captureOptions(input: unknown): CapturedKillSessionTreeOptions {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw invalidOptions('Process-tree options must be an object');
  }
  try {
    const options = input as Partial<KillSessionTreeOptions>;
    return {
      generationMarker: options.generationMarker,
      rootAuthority: options.rootAuthority,
      diagnosticSource: options.diagnosticSource,
      diagnosticSessionRowId: options.diagnosticSessionRowId,
      termGraceMs: options.termGraceMs,
      killGraceMs: options.killGraceMs,
      ambiguityResolveMs: options.ambiguityResolveMs,
      onOutcome: options.onOutcome,
      onCgroupDivergence: options.onCgroupDivergence,
      readCgroupMemberPids: options.readCgroupMemberPids,
    };
  } catch (error) {
    throw invalidOptions('Process-tree options could not be inspected', error);
  }
}

function validateOptions(options: CapturedKillSessionTreeOptions): KillSessionTreeOptions {
  try {
    const generationMarker = options.generationMarker;
    const rootAuthority = options.rootAuthority;
    const diagnosticSource = options.diagnosticSource;
    const diagnosticSessionRowId = options.diagnosticSessionRowId;
    const termGraceMs = validateDuration('termGraceMs', options.termGraceMs);
    const killGraceMs = validateDuration('killGraceMs', options.killGraceMs);
    const ambiguityResolveMs = validateDuration(
      'ambiguityResolveMs',
      options.ambiguityResolveMs,
    );
    const onOutcome = options.onOutcome;
    const onCgroupDivergence = options.onCgroupDivergence;
    const readCgroupMemberPids = options.readCgroupMemberPids;

    if (typeof generationMarker !== 'string' || generationMarker.trim().length === 0) {
      throw new ProcessTreeTerminationError(
        'PROCESS_TREE_INVALID_GENERATION',
        'Session process-tree generation marker must be non-empty',
      );
    }
    const authority = rootAuthorityBinding(rootAuthority);
    if (authority === null) {
      throw new ProcessTreeTerminationError(
        'PROCESS_TREE_ROOT_IDENTITY_UNVERIFIED',
        'Session process-tree root authority was not issued for this process',
      );
    }
    if (
      diagnosticSource !== undefined
      && !PROCESS_TREE_DIAGNOSTIC_SOURCES.includes(
        diagnosticSource as ProcessTreeDiagnosticSource,
      )
    ) {
      throw invalidOptions('Process-tree diagnostic source is invalid');
    }
    if (
      diagnosticSessionRowId !== undefined
      && (!Number.isSafeInteger(diagnosticSessionRowId)
        || (diagnosticSessionRowId as number) <= 0)
    ) {
      throw invalidOptions('Process-tree diagnostic row identifier is invalid');
    }
    if (onOutcome !== undefined && typeof onOutcome !== 'function') {
      throw invalidOptions('Process-tree outcome observer must be callable');
    }
    if (
      onCgroupDivergence !== undefined
      && typeof onCgroupDivergence !== 'function'
    ) {
      throw invalidOptions('Process-tree cgroup observer must be callable');
    }
    if (
      readCgroupMemberPids !== undefined
      && typeof readCgroupMemberPids !== 'function'
    ) {
      throw invalidOptions('Process-tree cgroup reader must be callable');
    }
    return {
      generationMarker,
      rootAuthority: rootAuthority as ProcessTreeRootAuthority,
      ...(diagnosticSource === undefined
        ? {}
        : { diagnosticSource: diagnosticSource as ProcessTreeDiagnosticSource }),
      ...(diagnosticSessionRowId === undefined
        ? {}
        : { diagnosticSessionRowId: diagnosticSessionRowId as number }),
      ...(termGraceMs === undefined ? {} : { termGraceMs }),
      ...(killGraceMs === undefined ? {} : { killGraceMs }),
      ...(ambiguityResolveMs === undefined ? {} : { ambiguityResolveMs }),
      ...(onOutcome === undefined
        ? {}
        : { onOutcome: onOutcome as (outcome: KillSessionOutcome) => void }),
      ...(onCgroupDivergence === undefined
        ? {}
        : {
            onCgroupDivergence:
              onCgroupDivergence as (info: CgroupDivergenceInfo) => void,
          }),
      ...(readCgroupMemberPids === undefined
        ? {}
        : {
            readCgroupMemberPids: readCgroupMemberPids as CgroupMemberPidReader,
          }),
    };
  } catch (error) {
    if (error instanceof ProcessTreeTerminationError) throw error;
    throw invalidOptions('Process-tree options could not be inspected', error);
  }
}

function normalizeTarget(
  target: number | ProcessTreeTarget,
  authority: ProcessTreeRootAuthority,
): NormalizedProcessTreeTarget {
  const binding = rootAuthorityBinding(authority);
  if (binding !== null && binding.target === target) {
    try {
      if (
        (target.exitCode !== undefined && target.exitCode !== null)
        || (target.signalCode !== undefined && target.signalCode !== null)
      ) {
        throw new ProcessTreeTerminationError(
          'PROCESS_TREE_ROOT_IDENTITY_UNVERIFIED',
          'Cannot reap through a terminal session process handle',
        );
      }
    } catch (error) {
      if (error instanceof ProcessTreeTerminationError) throw error;
      throw new ProcessTreeTerminationError(
        'PROCESS_TREE_INVALID_TARGET',
        'Cannot inspect the captured session process target',
      );
    }
    return {
      pid: binding.pid,
      source: binding.target,
      signalRoot: binding.signalRoot,
    };
  }
  let pid: unknown;
  let kill: ProcessTreeTarget['kill'] | null = null;
  let receiver: ProcessTreeTarget | null = null;
  try {
    if (typeof target === 'number') {
      pid = target;
    } else {
      if (typeof target !== 'object' || target === null || Array.isArray(target)) {
        throw new TypeError('target is not an object');
      }
      pid = target.pid;
      kill = target.kill;
      const exitCode = target.exitCode;
      const signalCode = target.signalCode;
      receiver = target;
      if (typeof kill !== 'function') {
        throw new TypeError('target kill method is not callable');
      }
      if (
        (exitCode !== undefined && exitCode !== null)
        || (signalCode !== undefined && signalCode !== null)
      ) {
        throw new ProcessTreeTerminationError(
          'PROCESS_TREE_ROOT_IDENTITY_UNVERIFIED',
          'Cannot reap through a terminal session process handle',
        );
      }
    }
  } catch (error) {
    if (error instanceof ProcessTreeTerminationError) throw error;
    throw new ProcessTreeTerminationError(
      'PROCESS_TREE_INVALID_TARGET',
      'Cannot reap an invalid session process target',
      { systemCode: systemErrorCode(error) },
    );
  }
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 1) {
    throw new ProcessTreeTerminationError(
      'PROCESS_TREE_INVALID_TARGET',
      'Cannot reap an invalid session process target',
    );
  }
  const normalizedPid = pid as number;
  return {
    pid: normalizedPid,
    source: receiver,
    signalRoot: kill && receiver
      ? (signal) => kill.call(receiver, signal)
      : (signal) => process.kill(normalizedPid, signal),
  };
}

function identityStillPresent(
  identity: OwnedProcessIdentity,
  generationMarker: string,
): boolean {
  const rows = readProcessCensus('PROCESS_TREE_SIGNAL_FAILED');
  const matches = rows.filter((row) => row.pid === identity.pid);
  if (matches.length === 0) return false;
  if (matches.length !== 1) return true;
  const current = matches[0];
  const currentBirthToken = probeProcessBirthToken(identity.pid);
  if (currentBirthToken === null) return true;
  if (currentBirthToken !== identity.birthToken) return false;
  if (current.startedAt !== identity.startedAt) return false;
  return sameProcess(current, identity, generationMarker);
}

function assimilateOwnedDescendants(
  lease: OwnedTreeLease,
  rows: readonly ProcessCensusRow[],
  generationMarker: string,
): void {
  const anchors: Array<{
    identity: OwnedProcessIdentity;
    row: ProcessCensusRow;
    walked: ReturnType<typeof bfsFromRoot<ProcessCensusRow>>;
  }> = [];
  const childrenIndex = buildChildrenIndex(rows, (row) => row.ppid);
  const pidsToVerify = new Set<number>();
  for (const identity of lease.owned) {
    const row = uniqueRowForPid(rows, identity.pid);
    if (row === null) continue;
    if (!sameProcess(row, identity, generationMarker)) continue;
    if (
      identity.pid === lease.rootAuthority.pid
      && row.ppid !== lease.rootAuthority.parentPid
    ) continue;
    const walked = bfsFromRoot(childrenIndex, row, (candidate) => candidate.pid);
    anchors.push({ identity, row, walked });
    for (const candidate of walked) pidsToVerify.add(candidate.row.pid);
  }
  if (anchors.length === 0) return;
  const birthTokens = probeProcessBirthTokens([...pidsToVerify]);
  if (birthTokens === null) {
    throw new ProcessTreeTerminationError(
      'PROCESS_TREE_AMBIGUOUS_IDENTITY_UNRESOLVED',
      'Retained session process identities could not be revalidated',
    );
  }
  const known = new Map(
    lease.owned.map((identity) => [identity.pid, identity.birthToken] as const),
  );
  for (const anchor of anchors) {
    if (birthTokens.get(anchor.identity.pid) !== anchor.identity.birthToken) continue;
    for (const { row, depth } of anchor.walked) {
      const birthToken = birthTokens.get(row.pid) ?? null;
      const retainedBirthToken = known.get(row.pid);
      if (retainedBirthToken !== undefined) {
        if (birthToken !== retainedBirthToken) {
          throw new ProcessTreeTerminationError(
            'PROCESS_TREE_AMBIGUOUS_IDENTITY_UNRESOLVED',
            'Retained session process identity changed during descendant discovery',
          );
        }
        continue;
      }
      if (
        lease.owned.length >= MAX_OWNED_IDENTITIES
        || retainedIdentityCount() >= MAX_OWNED_IDENTITIES
      ) {
        throw new ProcessTreeTerminationError(
          'PROCESS_TREE_IDENTITY_LIMIT',
          'Session process tree exceeds the bounded identity limit',
        );
      }
      if (birthToken === null) {
        throw new ProcessTreeTerminationError(
          'PROCESS_TREE_AMBIGUOUS_IDENTITY_UNRESOLVED',
          'Late session process identity could not be frozen',
        );
      }
      lease.owned.push({
        ...row,
        depth: anchor.identity.depth + depth,
        generationMarker,
        birthToken,
      });
      known.set(row.pid, birthToken);
    }
  }
}

function retainedIdentityCount(): number {
  let count = 0;
  for (const context of terminationLeases.values()) count += context.lease.owned.length;
  return count;
}

function reclaimProvenGoneTerminationLeases(): void {
  let rows: readonly ProcessCensusRow[];
  try {
    rows = readProcessCensus('PROCESS_TREE_FINAL_CENSUS_UNAVAILABLE');
  } catch {
    return;
  }
  const rowCounts = new Map<number, number>();
  for (const row of rows) rowCounts.set(row.pid, (rowCounts.get(row.pid) ?? 0) + 1);
  const reclaim = (rootPid: number, context: TerminationContext): void => {
    if (terminationLeases.get(rootPid) !== context) return;
    terminationLeases.delete(rootPid);
    releaseRegisteredProcessTreeTerminationLease(context.lease.rootAuthority);
  };
  const matchedPids = new Set<number>();
  for (const [rootPid, context] of terminationLeases) {
    if (context.state === 'active' || context.promise !== null) continue;
    if (context.lease.owned.length === 0) {
      const pid = context.lease.rootAuthority.pid;
      const matches = rowCounts.get(pid) ?? 0;
      if (matches === 0) {
        reclaim(rootPid, context);
      } else if (matches === 1) {
        matchedPids.add(pid);
      }
      continue;
    }
    let hasCensusMatch = false;
    for (const identity of context.lease.owned) {
      const matches = rowCounts.get(identity.pid) ?? 0;
      if (matches > 0) hasCensusMatch = true;
      if (matches === 1) matchedPids.add(identity.pid);
    }
    if (!hasCensusMatch) reclaim(rootPid, context);
  }
  const observedBirthTokens = matchedPids.size === 0
    ? new Map<number, string>()
    : probeProcessBirthTokens([...matchedPids]);
  for (const [rootPid, context] of terminationLeases) {
    if (context.state === 'active' || context.promise !== null) continue;
    if (context.lease.owned.length === 0) {
      const authority = context.lease.rootAuthority;
      if ((rowCounts.get(authority.pid) ?? 0) !== 1) continue;
      const observedBirthToken = observedBirthTokens?.get(authority.pid);
      if (
        observedBirthToken !== undefined
        && observedBirthToken !== authority.birthToken
      ) reclaim(rootPid, context);
      continue;
    }
    const inspection = inspectOwned(
      rows,
      context.lease.owned,
      context.generationMarker,
      observedBirthTokens,
    );
    if (inspection.survivors.length > 0 || inspection.ambiguous.length > 0) continue;
    reclaim(rootPid, context);
  }
}

function signalPid(
  target: NormalizedProcessTreeTarget,
  rootPid: number,
  identity: OwnedProcessIdentity,
  currentBirthToken: string | null,
  signal: NodeJS.Signals,
  generationMarker: string,
): boolean {
  if (currentBirthToken === null || currentBirthToken !== identity.birthToken) return false;
  try {
    let delivered: unknown;
    if (identity.pid === rootPid) {
      delivered = target.signalRoot(signal);
    } else {
      if (!processBirthTokenSupportsNumericSignal(identity.birthToken)) return false;
      delivered = process.kill(identity.pid, signal);
    }
    if (typeof delivered !== 'boolean') {
      throw new ProcessTreeTerminationError(
        'PROCESS_TREE_SIGNAL_FAILED',
        'Session process signal returned a non-boolean result',
      );
    }
    if (!delivered) {
      if (!identityStillPresent(identity, generationMarker)) return false;
      throw new ProcessTreeTerminationError(
        'PROCESS_TREE_SIGNAL_FAILED',
        'Unable to signal an owned session process',
      );
    }
    return true;
  } catch (error) {
    if (error instanceof ProcessTreeTerminationError) throw error;
    const code = systemErrorCode(error);
    if (code === 'EPERM' || code === 'EACCES') {
      throw new ProcessTreeTerminationError(
        'PROCESS_TREE_SIGNAL_PERMISSION_DENIED',
        'Permission to signal an owned session process was denied',
        { systemCode: code },
      );
    }
    if (code === 'ESRCH' && !identityStillPresent(identity, generationMarker)) return false;
    throw new ProcessTreeTerminationError(
      'PROCESS_TREE_SIGNAL_FAILED',
      'Unable to signal an owned session process',
      { systemCode: code },
    );
  }
}

function signalOwned(
  target: NormalizedProcessTreeTarget,
  rootPid: number,
  owned: readonly OwnedProcessIdentity[],
  signal: NodeJS.Signals,
  generationMarker: string,
): ReadonlySet<number> {
  const signaledPids = new Set<number>();
  const ordered = [...owned].sort((left, right) => right.depth - left.depth);
  const birthTokens = probeProcessBirthTokens(ordered.map((identity) => identity.pid));
  if (birthTokens === null) {
    throw new ProcessTreeTerminationError(
      'PROCESS_TREE_AMBIGUOUS_IDENTITY_UNRESOLVED',
      'Owned session process identities could not be checked before signaling',
    );
  }
  for (const identity of ordered) {
    if (signalPid(
      target,
      rootPid,
      identity,
      birthTokens.get(identity.pid) ?? null,
      signal,
      generationMarker,
    )) {
      signaledPids.add(identity.pid);
    }
  }
  return signaledPids;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForOwnedExit(
  lease: OwnedTreeLease,
  generationMarker: string,
  timeoutMs: number,
  unavailableCode: CensusUnavailableCode,
): Promise<OwnedExitCheck> {
  const deadline = systemClock.now() + timeoutMs;
  let survivors: readonly OwnedProcessIdentity[] = lease.owned;
  let ambiguous: readonly OwnedProcessIdentity[] = [];
  let censusError: unknown | null = null;
  do {
    try {
      const rows = readProcessCensus(unavailableCode);
      assimilateOwnedDescendants(lease, rows, generationMarker);
      const inspection = inspectOwned(rows, lease.owned, generationMarker);
      survivors = inspection.survivors;
      ambiguous = inspection.ambiguous;
      censusError = null;
      if (survivors.length === 0 && ambiguous.length === 0) {
        return { survivors: [], ambiguous: [], verified: true, censusError: null };
      }
    } catch (error) {
      survivors = lease.owned;
      ambiguous = [];
      censusError = error;
    }
    if (systemClock.now() >= deadline) {
      return { survivors, ambiguous, verified: censusError === null, censusError };
    }
    await delay(Math.min(RECHECK_INTERVAL_MS, Math.max(1, deadline - systemClock.now())));
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
  lease: OwnedTreeLease,
  generationMarker: string,
  resolveMs: number,
  unavailableCode: CensusUnavailableCode,
): Promise<ResolvedInspection> {
  const deadline = systemClock.now() + Math.max(0, resolveMs);
  let rows = readProcessCensus(unavailableCode);
  assimilateOwnedDescendants(lease, rows, generationMarker);
  let inspection = inspectOwned(rows, lease.owned, generationMarker);
  while (inspection.ambiguous.length > 0 && systemClock.now() < deadline) {
    await delay(Math.min(RECHECK_INTERVAL_MS, Math.max(1, deadline - systemClock.now())));
    rows = readProcessCensus(unavailableCode);
    assimilateOwnedDescendants(lease, rows, generationMarker);
    inspection = inspectOwned(rows, lease.owned, generationMarker);
  }
  return { rows, survivors: inspection.survivors, ambiguous: inspection.ambiguous };
}

async function runTermination(
  target: NormalizedProcessTreeTarget,
  rootPid: number,
  lease: OwnedTreeLease,
  signal: NodeJS.Signals,
  options: KillSessionTreeOptions,
): Promise<CoreKillSessionOutcome> {
  const generationMarker = options.generationMarker;
  const resolveMs = options.ambiguityResolveMs ?? DEFAULT_AMBIGUITY_RESOLVE_MS;
  const startedAt = systemClock.now();
  let escalated = false;
  const signaledPids = new Set<number>();

  // Pre-signal. #1755: resolve transient ambiguity over a bounded window, then
  // signal the CONFIRMED survivors only — never an ambiguous PID (a duplicate-pid
  // census race or a same-pid/different-command reading). A census that cannot be
  // read at all still fails closed (unchanged). Ambiguity no longer aborts the
  // whole kill: we signal what we can confirm and record the residue below.
  let first: ResolvedInspection;
  try {
    first = await resolveOwnedInspection(
      lease,
      generationMarker,
      resolveMs,
      'PROCESS_TREE_PRE_SIGNAL_CENSUS_UNAVAILABLE',
    );
  } catch (error) {
    throw normalizeCensusFailure(error, 'PROCESS_TREE_PRE_SIGNAL_CENSUS_UNAVAILABLE');
  }
  if (first.survivors.length > 0) {
    for (const pid of signalOwned(
      target,
      rootPid,
      first.survivors,
      signal,
      generationMarker,
    )) signaledPids.add(pid);
  }

  if (signal === SIGNAL.TERM) {
    const termCheck = await waitForOwnedExit(
      lease,
      generationMarker,
      options.termGraceMs ?? DEFAULT_TERM_GRACE_MS,
      'PROCESS_TREE_ESCALATION_CENSUS_UNAVAILABLE',
    );
    // Escalate the still-present set (survivors + any still-ambiguous), re-resolved:
    // confirmed survivors get SIGKILL, residual ambiguous is left alone and recorded.
    const pending = [...termCheck.survivors, ...termCheck.ambiguous];
    if (pending.length > 0) {
      let kill: ResolvedInspection;
      try {
        kill = await resolveOwnedInspection(
          lease,
          generationMarker,
          resolveMs,
          'PROCESS_TREE_ESCALATION_CENSUS_UNAVAILABLE',
        );
      } catch (error) {
        throw normalizeCensusFailure(error, 'PROCESS_TREE_ESCALATION_CENSUS_UNAVAILABLE');
      }
      if (kill.survivors.length > 0) {
        escalated = true;
        for (const pid of signalOwned(
          target,
          rootPid,
          kill.survivors,
          SIGNAL.KILL,
          generationMarker,
        )) signaledPids.add(pid);
      }
    }
  }

  const finalCheck = await waitForOwnedExit(
    lease,
    generationMarker,
    options.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
    'PROCESS_TREE_FINAL_CENSUS_UNAVAILABLE',
  );
  if (!finalCheck.verified) {
    throw normalizeCensusFailure(
      finalCheck.censusError,
      'PROCESS_TREE_FINAL_CENSUS_UNAVAILABLE',
    );
  }
  // A CONFIRMED survivor that outlived SIGKILL is a genuine failure (unkillable /
  // zombie) — still fail closed. Residual AMBIGUOUS identity is NOT: it is never
  // signaled, so recording it (below) and letting shutdown proceed is strictly
  // better than burning the full grace and being SIGKILLed by the service manager.
  if (finalCheck.survivors.length > 0) {
    throw new ProcessTreeTerminationError(
      'PROCESS_TREE_SURVIVORS_REMAIN',
      'Owned session processes remain after termination',
    );
  }

  const ambiguousProcessCount = finalCheck.ambiguous.length;
  const outcome: KillSessionOutcome['outcome'] =
    ambiguousProcessCount > 0 ? 'unresolved_ambiguous' : escalated ? 'escalated' : 'terminated';
  return {
    outcome,
    durationMs: boundedDuration(startedAt),
    ownedProcessCount: lease.owned.length,
    signaledProcessCount: signaledPids.size,
    ambiguousProcessCount,
  };
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

export type CgroupDivergenceObservation =
  | {
      readonly state: 'complete';
      readonly divergence: CgroupDivergenceInfo;
      readonly diagnosticCodes?: readonly ProcessTreeDiagnosticFailureCode[];
    }
  | {
      readonly state: 'not_applicable';
      readonly diagnosticCodes?: readonly ProcessTreeDiagnosticFailureCode[];
    }
  | {
      readonly state: 'unavailable' | 'inconclusive';
      readonly diagnosticCode: ProcessTreeDiagnosticFailureCode;
      readonly diagnosticCodes?: readonly ProcessTreeDiagnosticFailureCode[];
    };

/**
 * #1869: best-effort emit of the cgroup-vs-PPID divergence gauge. Fully isolated
 * so any failure is logged and can NEVER affect termination. No-op unless a
 * sink is provided and cgroup membership is readable. A readable census emits
 * zero as well as non-zero divergence so callers receive the documented gauge
 * at each teardown.
 */
export async function emitCgroupDivergence(
  owned: readonly { readonly pid: number }[],
  rootPid: number,
  options: CgroupDivergenceOptions,
): Promise<CgroupDivergenceObservation> {
  const sink = options.onCgroupDivergence;
  const diagnostic = diagnosticContext(options);
  if (!sink && !diagnostic && options.readCgroupMemberPids === undefined) {
    return { state: 'not_applicable' };
  }
  const observation = await observeCgroupMemberPids(options.readCgroupMemberPids);
  if (observation.state === 'not_applicable') return observation;
  if (observation.state !== 'complete') {
    const logFailure = safeProcessTreeLog(
      'warn',
      {
        ...diagnostic,
        diagnosticCode: observation.diagnosticCode,
      },
      'cgroup divergence telemetry inconclusive',
    );
    return logFailure
      ? { ...observation, diagnosticCodes: [logFailure] }
      : observation;
  }
  const divergence = computeCgroupDivergence(observation.memberPids, owned, rootPid);
  const diagnosticCodes = new Set<ProcessTreeDiagnosticFailureCode>();
  const reportSinkFailure = (): void => {
    diagnosticCodes.add('PROCESS_TREE_CGROUP_OBSERVER_FAILED');
    const logFailure = safeProcessTreeLog(
      'warn',
      {
        ...diagnostic,
        sink: 'cgroup_divergence',
        diagnosticCode: 'PROCESS_TREE_CGROUP_OBSERVER_FAILED',
      },
      'process-tree telemetry sink failed',
    );
    if (logFailure) diagnosticCodes.add(logFailure);
  };
  try {
    if (diagnostic) {
      const logFailure = safeProcessTreeLog(
        'debug',
        {
          ...diagnostic,
          ...divergence,
        },
        'process-tree cgroup divergence',
      );
      if (logFailure) diagnosticCodes.add(logFailure);
    }
    const sinkResult = sink?.(divergence) as unknown;
    if (
      (typeof sinkResult === 'object' && sinkResult !== null)
      || typeof sinkResult === 'function'
    ) {
      Promise.resolve(sinkResult).catch(reportSinkFailure);
    }
    return {
      state: 'complete',
      divergence,
      ...(diagnosticCodes.size === 0
        ? {}
        : { diagnosticCodes: [...diagnosticCodes].sort() }),
    };
  } catch {
    reportSinkFailure();
    return {
      state: 'inconclusive',
      diagnosticCode: 'PROCESS_TREE_CGROUP_OBSERVER_FAILED',
      diagnosticCodes: [...diagnosticCodes].sort(),
    };
  }
}

function normalizeTerminationError(error: unknown): ProcessTreeTerminationError {
  return error instanceof ProcessTreeTerminationError
    ? error
    : new ProcessTreeTerminationError(
        'PROCESS_TREE_UNEXPECTED_FAILURE',
        'Unexpected process-tree termination failure',
        { systemCode: systemErrorCode(error) },
      );
}

interface DiagnosticContextInput {
  readonly diagnosticSource?: unknown;
  readonly diagnosticSessionRowId?: unknown;
}

function diagnosticContext(
  options: DiagnosticContextInput,
): { source: ProcessTreeDiagnosticSource; sessionRowId?: number } | null {
  const source = options.diagnosticSource;
  if (!PROCESS_TREE_DIAGNOSTIC_SOURCES.includes(source as ProcessTreeDiagnosticSource)) {
    return null;
  }
  const sessionRowId = options.diagnosticSessionRowId;
  return typeof sessionRowId === 'number'
    && Number.isSafeInteger(sessionRowId)
    && sessionRowId > 0
    ? { source: source as ProcessTreeDiagnosticSource, sessionRowId }
    : { source: source as ProcessTreeDiagnosticSource };
}

function safeProcessTreeLog(
  level: 'debug' | 'warn',
  record: Record<string, unknown>,
  message: string,
): ProcessTreeDiagnosticFailureCode | null {
  try {
    log[level](record, message);
    return null;
  } catch {
    return 'PROCESS_TREE_DIAGNOSTIC_LOG_FAILED';
  }
}

function reportTelemetrySinkFailure(
  telemetry: TerminationTelemetry,
  options: KillSessionTreeOptions,
  sink: 'outcome' | 'cgroup_divergence',
): void {
  telemetry.diagnosticCodes.add(
    sink === 'outcome'
      ? 'PROCESS_TREE_OUTCOME_OBSERVER_FAILED'
      : 'PROCESS_TREE_CGROUP_OBSERVER_FAILED',
  );
  const logFailure = safeProcessTreeLog(
    'warn',
    {
      ...diagnosticContext(options),
      sink,
      diagnosticCode: sink === 'outcome'
        ? 'PROCESS_TREE_OUTCOME_OBSERVER_FAILED'
        : 'PROCESS_TREE_CGROUP_OBSERVER_FAILED',
    },
    'process-tree telemetry sink failed',
  );
  if (logFailure) telemetry.diagnosticCodes.add(logFailure);
}

function notifyTelemetryObserver<T>(
  telemetry: TerminationTelemetry,
  observer: TelemetryObserver<T>,
  value: T,
  sink: 'outcome' | 'cgroup_divergence',
): void {
  try {
    const result = observer.sink(value) as unknown;
    if (
      (typeof result === 'object' && result !== null)
      || typeof result === 'function'
    ) {
      Promise.resolve(result).catch(() => {
        reportTelemetrySinkFailure(telemetry, observer.options, sink);
      });
    }
  } catch {
    reportTelemetrySinkFailure(telemetry, observer.options, sink);
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
      notifyTelemetryObserver(telemetry, observer, telemetry.lastOutcome, 'outcome');
    }
  }
  if (options.onCgroupDivergence) {
    const observer = { sink: options.onCgroupDivergence, options };
    telemetry.divergenceObservers.add(observer);
    if (replay && telemetry.lastDivergence) {
      notifyTelemetryObserver(
        telemetry,
        observer,
        telemetry.lastDivergence,
        'cgroup_divergence',
      );
    }
  }
}

function publicOutcome(
  core: CoreKillSessionOutcome,
  diagnosticCodes: ReadonlySet<ProcessTreeDiagnosticFailureCode>,
): KillSessionOutcome {
  const codes = [...diagnosticCodes].sort();
  return {
    ...core,
    diagnosticState: codes.length === 0 ? 'complete' : 'inconclusive',
    diagnosticCodes: codes,
  };
}

function broadcastOutcome(
  telemetry: TerminationTelemetry,
  core: CoreKillSessionOutcome,
  options: KillSessionTreeOptions,
  signal: NodeJS.Signals,
): KillSessionOutcome {
  const diagnostic = diagnosticContext(options);
  if (diagnostic) {
    const logFailure = safeProcessTreeLog(
      core.outcome === 'unresolved_ambiguous' ? 'warn' : 'debug',
      {
        ...diagnostic,
        signal,
        outcome: core.outcome,
        durationMs: core.durationMs,
        ownedProcessCount: core.ownedProcessCount,
        signaledProcessCount: core.signaledProcessCount,
        ambiguousProcessCount: core.ambiguousProcessCount,
      },
      'process-tree termination outcome',
    );
    if (logFailure) telemetry.diagnosticCodes.add(logFailure);
  }
  const initial = publicOutcome(core, telemetry.diagnosticCodes);
  telemetry.lastOutcome = initial;
  for (const observer of telemetry.outcomeObservers) {
    notifyTelemetryObserver(telemetry, observer, initial, 'outcome');
  }
  const final = publicOutcome(core, telemetry.diagnosticCodes);
  telemetry.lastOutcome = final;
  return final;
}

function broadcastDivergence(
  telemetry: TerminationTelemetry,
  divergence: CgroupDivergenceInfo,
): void {
  telemetry.lastDivergence = divergence;
  for (const observer of telemetry.divergenceObservers) {
    notifyTelemetryObserver(telemetry, observer, divergence, 'cgroup_divergence');
  }
}

async function settleCgroupObservation(
  telemetry: TerminationTelemetry,
  observation: Promise<CgroupDivergenceObservation>,
): Promise<void> {
  try {
    const result = await observation;
    for (const code of result.diagnosticCodes ?? []) telemetry.diagnosticCodes.add(code);
    if (result.state === 'unavailable' || result.state === 'inconclusive') {
      telemetry.diagnosticCodes.add(result.diagnosticCode);
    }
  } catch {
    telemetry.diagnosticCodes.add('PROCESS_TREE_CGROUP_OBSERVATION_UNAVAILABLE');
  }
}

function emitTerminationFailure(
  options: DiagnosticContextInput | null,
  error: ProcessTreeTerminationError,
): void {
  if (!options) return;
  const diagnostic = diagnosticContext(options);
  if (!diagnostic) return;
  const logFailure = safeProcessTreeLog(
    'warn',
    {
      ...diagnostic,
      errorCode: error.code,
      retryClass: error.retryClass,
      ...(error.systemCode === undefined ? {} : { systemCode: error.systemCode }),
    },
    'process-tree termination failed',
  );
  if (logFailure) error.addDiagnosticCodes([logFailure]);
}

function rejectTermination(
  options: DiagnosticContextInput | null,
  error: ProcessTreeTerminationError,
): Promise<never> {
  emitTerminationFailure(options, error);
  return Promise.reject(error);
}

function rootSnapshotError(state: Exclude<OwnedTreeSnapshot['rootState'], 'present'>) {
  return new ProcessTreeTerminationError(
    state === 'missing'
      ? 'PROCESS_TREE_ROOT_MISSING'
      : state === 'ambiguous'
        ? 'PROCESS_TREE_ROOT_AMBIGUOUS'
        : 'PROCESS_TREE_ROOT_IDENTITY_UNVERIFIED',
    state === 'missing'
      ? 'Session process-tree root is missing from the census'
      : state === 'ambiguous'
        ? 'Session process-tree root is ambiguous in the census'
        : 'Session process-tree root does not match its captured authority',
  );
}

function initializeTerminationLease(context: TerminationContext): void {
  if (context.lease.owned.length > 0) return;
  const snapshot = snapshotOwnedTree(
    readProcessCensus('PROCESS_TREE_INITIAL_CENSUS_UNAVAILABLE'),
    context.rootPid,
    context.generationMarker,
    context.lease.rootAuthority,
  );
  if (snapshot.rootState !== 'present') throw rootSnapshotError(snapshot.rootState);
  if (retainedIdentityCount() + snapshot.owned.length > MAX_OWNED_IDENTITIES) {
    throw new ProcessTreeTerminationError(
      'PROCESS_TREE_IDENTITY_LIMIT',
      'Retained process-tree identities exceed the global bound',
    );
  }
  context.lease.owned.push(...snapshot.owned);
}

async function executeTerminationAttempt(
  context: TerminationContext,
): Promise<KillSessionOutcome> {
  initializeTerminationLease(context);
  // Cgroup membership proves only service-unit co-location, not ownership by
  // this provider session. Keep it observational until per-session attribution exists.
  const cgroupObservation = emitCgroupDivergence(
    context.lease.owned,
    context.rootPid,
    context.executionOptions,
  );
  try {
    const core = await runTermination(
      context.target,
      context.rootPid,
      context.lease,
      context.signal,
      context.executionOptions,
    );
    await settleCgroupObservation(context.telemetry, cgroupObservation);
    return broadcastOutcome(
      context.telemetry,
      core,
      context.options,
      context.signal,
    );
  } catch (error) {
    await settleCgroupObservation(context.telemetry, cgroupObservation);
    throw error;
  }
}

function startTerminationAttempt(context: TerminationContext): Promise<KillSessionOutcome> {
  context.attemptCount += 1;
  context.state = 'active';
  let attemptPromise: Promise<KillSessionOutcome>;
  attemptPromise = executeTerminationAttempt(context)
    .then((outcome) => {
      if (outcome.outcome === 'unresolved_ambiguous') {
        context.state = 'retained';
      } else if (terminationLeases.get(context.rootPid) === context) {
        terminationLeases.delete(context.rootPid);
        releaseRegisteredProcessTreeTerminationLease(context.lease.rootAuthority);
      }
      return outcome;
    })
    .catch((error: unknown) => {
      const normalized = normalizeTerminationError(error);
      normalized.addDiagnosticCodes(context.telemetry.diagnosticCodes);
      emitTerminationFailure(context.options, normalized);
      context.state = normalized.retryClass === 'permission_denied'
        ? 'nonretryable'
        : 'retained';
      throw normalized;
    })
    .finally(() => {
      if (context.promise === attemptPromise) context.promise = null;
    });
  context.promise = attemptPromise;
  return attemptPromise;
}

export function retryKillSessionTree(
  rootPid: number,
  generationMarker: string,
): Promise<KillSessionOutcome> {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 1) {
    return rejectTermination(
      null,
      new ProcessTreeTerminationError(
        'PROCESS_TREE_INVALID_TARGET',
        'Cannot retry an invalid session process target',
      ),
    );
  }
  if (typeof generationMarker !== 'string' || generationMarker.trim().length === 0) {
    return rejectTermination(
      null,
      new ProcessTreeTerminationError(
        'PROCESS_TREE_INVALID_GENERATION',
        'Session process-tree generation marker must be non-empty',
      ),
    );
  }
  const context = terminationLeases.get(rootPid);
  if (context === undefined) {
    return rejectTermination(
      null,
      new ProcessTreeTerminationError(
        'PROCESS_TREE_RETRY_LEASE_MISSING',
        'No retained process-tree lease exists for this target',
      ),
    );
  }
  if (context.generationMarker !== generationMarker) {
    return rejectTermination(
      context.options,
      new ProcessTreeTerminationError(
        'PROCESS_TREE_LEASE_CONFLICT',
        'Refusing process-tree retry for a different generation',
      ),
    );
  }
  if (context.state === 'active' && context.promise !== null) return context.promise;
  if (systemClock.now() > context.expiresAt || context.state === 'expired') {
    context.state = 'expired';
    return rejectTermination(
      context.options,
      new ProcessTreeTerminationError(
        'PROCESS_TREE_RETRY_LEASE_EXPIRED',
        'Retained process-tree retry lease has expired',
      ),
    );
  }
  if (context.state === 'nonretryable') {
    return rejectTermination(
      context.options,
      new ProcessTreeTerminationError(
        'PROCESS_TREE_RETRY_NOT_ALLOWED',
        'Retained process-tree lease is not automatically retryable',
      ),
    );
  }
  if (context.attemptCount >= MAX_TERMINATION_ATTEMPTS) {
    return rejectTermination(
      context.options,
      new ProcessTreeTerminationError(
        'PROCESS_TREE_RETRY_ATTEMPTS_EXHAUSTED',
        'Retained process-tree retry attempts are exhausted',
      ),
    );
  }
  return startTerminationAttempt(context);
}

/** Clear in-memory leases only inside an isolated test runtime. */
export function resetProcessTreeTerminationLeasesForTesting(): void {
  // env-allowed: destructive test reset requires Vitest runner and worker signals
  const env = process.env;
  if (
    env['VITEST'] !== 'true'
    || (env['VITEST_POOL_ID'] === undefined && env['VITEST_WORKER_ID'] === undefined)
  ) {
    throw new Error('Process-tree lease reset is test-only');
  }
  terminationLeases.clear();
  registeredSessionAuthorities.clear();
  registeredSessionRowByAuthority = new WeakMap<object, number>();
}

export function killSessionTree(
  target: number | ProcessTreeTarget,
  signal: NodeJS.Signals,
  options: KillSessionTreeOptions,
): Promise<KillSessionOutcome> {
  let capturedOptions: CapturedKillSessionTreeOptions;
  try {
    capturedOptions = captureOptions(options);
  } catch (error) {
    return rejectTermination(null, normalizeTerminationError(error));
  }
  let validatedOptions: KillSessionTreeOptions;
  try {
    validatedOptions = validateOptions(capturedOptions);
  } catch (error) {
    return rejectTermination(capturedOptions, normalizeTerminationError(error));
  }
  let normalizedTarget: NormalizedProcessTreeTarget;
  try {
    normalizedTarget = normalizeTarget(target, validatedOptions.rootAuthority);
  } catch (error) {
    return rejectTermination(validatedOptions, normalizeTerminationError(error));
  }
  const rootPid = normalizedTarget.pid;
  const binding = rootAuthorityBinding(validatedOptions.rootAuthority);
  if (
    binding === null
    || binding.target !== normalizedTarget.source
    || binding.pid !== rootPid
    || binding.parentPid !== validatedOptions.rootAuthority.parentPid
    || binding.birthToken !== validatedOptions.rootAuthority.birthToken
  ) {
    return rejectTermination(
      validatedOptions,
      new ProcessTreeTerminationError(
        'PROCESS_TREE_ROOT_IDENTITY_UNVERIFIED',
        'Session process-tree authority does not match the exact target handle',
      ),
    );
  }

  const existing = terminationLeases.get(rootPid);
  if (existing !== undefined) {
    if (existing.generationMarker === validatedOptions.generationMarker) {
      if (
        existing.lease.rootAuthority !== validatedOptions.rootAuthority
        || existing.target.source !== normalizedTarget.source
      ) {
        return rejectTermination(
          validatedOptions,
          new ProcessTreeTerminationError(
            'PROCESS_TREE_LEASE_CONFLICT',
            'Refusing process-tree coalescing from a different target authority',
          ),
        );
      }
      addTerminationObservers(existing.telemetry, validatedOptions, true);
      if (existing.state === 'active' && existing.promise !== null) return existing.promise;
      return rejectTermination(
        validatedOptions,
        new ProcessTreeTerminationError(
          'PROCESS_TREE_RETRY_LEASE_REQUIRED',
          'Use the explicit retry operation for a retained process-tree lease',
        ),
      );
    }
    return rejectTermination(
      validatedOptions,
      new ProcessTreeTerminationError(
        'PROCESS_TREE_LEASE_CONFLICT',
        'Refusing process-tree lease change while any frozen identity remains unproved',
      ),
    );
  }
  if (terminationLeases.size >= MAX_RETAINED_TERMINATION_LEASES) {
    reclaimProvenGoneTerminationLeases();
  }
  if (terminationLeases.size >= MAX_RETAINED_TERMINATION_LEASES) {
    return rejectTermination(
      validatedOptions,
      new ProcessTreeTerminationError(
        'PROCESS_TREE_LEASE_CAPACITY',
        'Process-tree lease capacity is exhausted',
      ),
    );
  }

  const telemetry: TerminationTelemetry = {
    outcomeObservers: new Set(),
    divergenceObservers: new Set(),
    diagnosticCodes: new Set(),
    lastOutcome: null,
    lastDivergence: null,
  };
  addTerminationObservers(telemetry, validatedOptions, false);
  const executionOptions: KillSessionTreeOptions = {
    ...validatedOptions,
    onOutcome: undefined,
    onCgroupDivergence: (divergence) => broadcastDivergence(telemetry, divergence),
  };
  const context: TerminationContext = {
    rootPid,
    generationMarker: validatedOptions.generationMarker,
    target: normalizedTarget,
    signal,
    options: validatedOptions,
    executionOptions,
    lease: { rootAuthority: validatedOptions.rootAuthority, owned: [] },
    telemetry,
    expiresAt: systemClock.now() + TERMINATION_LEASE_TTL_MS,
    attemptCount: 0,
    state: 'retained',
    promise: null,
  };
  terminationLeases.set(rootPid, context);
  return startTerminationAttempt(context);
}
