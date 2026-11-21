import type { AuthBondFileSnapshot } from './auth-bond-files.ts';

/**
 * 'unknown' is produced ONLY by inspectCached(), and only when the tree has
 * never been observed or its observation is stale past the risk bound. It says
 * "no current evidence", which is a different claim from 'invalid' ("evidence
 * of corruption") and must not be collapsed into it: 'invalid' de-links the
 * message scheduler (src/core/scheduler.ts:478-479) and would hold scheduled
 * sends on an instance whose credentials are fine. inspect() walks live and
 * never returns 'unknown'. The one other source is a capture's last-resort
 * failure result (unreadCaptureResult), which reads nothing and so has no
 * evidence either.
 */
export type AuthBondStatus = 'present' | 'missing' | 'invalid' | 'unknown';

export interface AuthBondBackupSnapshot {
  root: string;
  latest: string | null;
  latestAt: string | null;
  latestReason: string | null;
  latestTreeHash: string | null;
  lastCaptureAt: string | null;
  lastCaptureReason: string | null;
  lastCaptureError: string | null;
  lastCaptureDeferredAt: string | null;
  lastCaptureDeferredReason: string | null;
  lastCaptureDeferredAgeMs: number | null;
  lastRestoreAt: string | null;
  lastRestoreSource: string | null;
  lastRestoreError: string | null;
  lastSweepError: string | null;
}

/**
 * Where the two full-tree walks in a snapshot came from.
 *
 * Present only on snapshots served by inspectCached(); inspect() omits it
 * because its walks are always live. A consumer that must reason about
 * freshness (the /health projection does) reads `ageMs`; a consumer that needs
 * a guaranteed-current tree calls inspect() and pays for it.
 */
export interface AuthBondTreeProvenance {
  /**
   * 'cached' — a completed walk, inside the max age.
   * 'stale'  — a completed walk that an event invalidated, or that is past the
   *            max age; still the best evidence available and still reported.
   * 'absent' — no walk has ever completed, so there is no evidence at all.
   */
  readonly source: 'cached' | 'stale' | 'absent';
  /** Age of the cached walk in milliseconds; null when source is 'absent'. */
  readonly ageMs: number | null;
  readonly refreshInFlight: boolean;
  /**
   * Walks that PUBLISHED a new observation since construction.
   *
   * Not the number of completed walks: `incomplete`, `failed` and `superseded`
   * all complete without incrementing this. `refreshAttemptCount` is the cost
   * counterpart.
   */
  readonly refreshCount: number;
  readonly lastInvalidationReason: string | null;
  /**
   * How the most recent refresh attempt ended.
   *
   * 'fresh' is the only kind that republishes a digest. 'incomplete' (an entry
   * vanished mid-walk) and 'failed' (the walk threw) deliberately keep the
   * previous observation and let it go on ageing, so a persistent I/O fault
   * surfaces as a digest that stops advancing rather than as a green one that
   * silently never updates.
   */
  readonly lastRefreshKind: TreeRefreshKind;
  readonly lastRefreshReason: string | null;
  /**
   * A successor walk is queued but has not started.
   *
   * Separate from `lastRefreshKind`, which describes the last COMPLETED attempt.
   * Without this, a reader immediately after a floor-blocked invalidation sees
   * `source: 'stale'`, `refreshInFlight: false`, `lastRefreshKind: 'fresh'` —
   * four fields that together say "the last walk succeeded and nothing is
   * happening" while a walk is in fact queued.
   */
  readonly refreshScheduled: boolean;
  /** Milliseconds until the queued successor may start; null when none is queued. */
  readonly nextRefreshEligibleInMs: number | null;
  /** Walks STARTED since construction, including ones that did not publish. */
  readonly refreshAttemptCount: number;
  /**
   * No walk has published since construction and the stale-risk bound has not
   * passed since then. `unknown` here means "not looked at yet", which the first
   * completed walk settles, so /health keeps it out of the silence latch. Past
   * the bound it is the same absence of evidence a stale digest reports.
   */
  readonly firstWalkPending: boolean;
}

export type TreeRefreshKind = 'none' | 'fresh' | 'incomplete' | 'failed' | 'superseded';

export interface TreeRefreshOutcome {
  readonly kind: TreeRefreshKind;
  readonly atMs: number;
  readonly reason: string | null;
}

export interface AuthBondSnapshot {
  status: AuthBondStatus;
  authDir: AuthBondFileSnapshot;
  creds: AuthBondFileSnapshot;
  meHash: string | null;
  treeHash: string | null;
  fileCount: number | null;
  totalBytes: number | null;
  backup: AuthBondBackupSnapshot;
  issues: string[];
  treeProvenance?: AuthBondTreeProvenance;
  /**
   * True once ONE transient credential read has persisted continuously past
   * treeStaleRiskMs (the same bound `unknown` uses). Consumed by
   * classifyAuthFailure, which reports `auth_bond_read_persistent` — a
   * NON-TERMINAL class. The escalation says the read has been indefinite for
   * long enough to be worth naming; it does not say the credential is corrupt,
   * because nothing on this path establishes that.
   *
   * PROCESS-LIFETIME ONLY. The streak lives in guard memory and starts over on
   * every process restart, so an instance that restarts more often than
   * treeStaleRiskMs never reaches the bound however long the underlying fault
   * lasts. Persisting the episode start is deliberately out of scope here; the
   * release note states the limitation.
   *
   * Optional so hand-constructed test snapshots keep compiling without one;
   * undefined reads as `false`.
   */
  transientReadPersistent?: boolean;
  /**
   * The transient issue owning the current streak, or null when there is none.
   *
   * Serialized onto the health surface next to the age below so the escalated
   * class can be reconciled with the issue list in one response. The streak is
   * keyed by this text, so it names the fault the age was accumulated against.
   */
  transientReadReason?: string | null;
  /** Milliseconds the current transient streak has run, or null when none is open. */
  transientReadAgeMs?: number | null;
}

export interface AuthBondCaptureResult {
  ok: boolean;
  snapshot: AuthBondSnapshot;
  captured: boolean;
  deferred: boolean;
  path: string | null;
  error: string | null;
  /** The block reason stopped the run, at its start or in the publish turn. Nothing was published. */
  blocked?: boolean;
  /** A restore or shutdown stopped the run before it published. Guard health fields are unchanged. */
  aborted?: boolean;
}

/** How a capture run ended. One value per run, carried on its finished event. */
export type AuthBondCaptureOutcome = 'captured' | 'unchanged' | 'deferred' | 'failed' | 'blocked' | 'aborted';

/** Wall time a run spent in each phase, in milliseconds, yields included. */
export interface AuthBondCapturePhaseMs {
  inspect: number;
  sweep: number;
  copy: number;
  validate: number;
  publish: number;
  prune: number;
}

/**
 * Emitted through onCaptureEvent; connection.ts turns each event into one log
 * line. No event carries file contents, a tree or identity hash, or a path.
 */
export type AuthBondCaptureEvent =
  | {
      kind: 'started';
      run: number;
      reason: string;
      /** Requests folded into this run; at least 1. */
      coalescedRequests: number;
      /** From the first folded request to the start; 0 when not queued. */
      queuedMs: number;
    }
  | {
      kind: 'finished';
      run: number;
      reason: string;
      outcome: AuthBondCaptureOutcome;
      elapsedMs: number;
      attempts: number;
      /** captureYield calls: how many times the run handed the loop back. */
      slices: number;
      /** The longest stretch the run held the loop between two yields. */
      maxSliceMs: number;
      phaseMs: AuthBondCapturePhaseMs;
      /** From the run's last pre-copy walk, or null. */
      fileCount: number | null;
      totalBytes: number | null;
      error: string | null;
      /** +1 per run that ends deferred; reset by captured or unchanged; kept by the rest. */
      consecutiveDeferrals: number;
    };

export interface AuthBondRestoreResult {
  attempted: boolean;
  restored: boolean;
  source: string | null;
  snapshot: AuthBondSnapshot;
  error: string | null;
  /**
   * The restore was WITHHELD on a transient read, not declined for any other
   * reason. A machine-readable discriminator because the caller has to act on
   * it — connection.ts aborts the activation and schedules a retry — and the
   * only other signal was prose inside `error`.
   */
  deferred?: boolean;
}

export interface LatestManifest {
  backupPath?: string;
  createdAt?: string;
  reason?: string;
  treeHash?: string;
}

export interface BackupManifest {
  instanceName?: string;
  reason?: string;
  createdAt?: string;
  authDir?: string;
  treeHash?: string | null;
  credsHash?: string | null;
  meHash?: string | null;
}

export interface AuthBondGuardOptions {
  authDir: string;
  stateRoot?: string;
  instanceName: string;
  now?: () => Date;
  keepBackups?: number;
  maxHistoryFiles?: number;
  autoRestore?: boolean;
  captureAttempts?: number;
  captureRetryDelayMs?: number;
  captureBlockReason?: () => string | null;
  freshInvalidGraceMs?: number;
  /** Ceiling on how stale inspectCached() may serve a tree walk. See DEFAULT_TREE_CACHE_MAX_AGE_MS. */
  treeCacheMaxAgeMs?: number;
  /** Floor between tree-walk starts. See DEFAULT_TREE_REFRESH_MIN_INTERVAL_MS. */
  treeRefreshMinIntervalMs?: number;
  /** Monotonic milliseconds, for digest age and capture timing. Defaults to performance.now(). */
  monotonicNow?: () => number;
  /** Hands the loop back between capture slices. Defaults to one setImmediate turn. */
  captureYield?: () => Promise<void>;
  /** Waits between capture attempts. Defaults to a setTimeout promise. */
  captureSleep?: (ms: number) => Promise<void>;
  /** Receives the started and finished event of every capture run. A throw is ignored. */
  onCaptureEvent?: (event: AuthBondCaptureEvent) => void;
}

/** The cheap half of a snapshot, read before the tree walk and shared by both drives. */
export interface AuthBondSnapshotHead {
  issues: string[];
  authDir: AuthBondFileSnapshot;
  creds: AuthBondFileSnapshot;
  status: AuthBondStatus;
  meHash: string | null;
}

export type CaptureAbortCause = 'shutdown' | 'auth-restore';

/** One capture run. Only the guard's activeCapture refers to it. */
export interface CaptureRun {
  readonly run: number;
  readonly reason: string;
  readonly startedAtMs: number;
  readonly promise: Promise<AuthBondCaptureResult>;
  readonly settle: (result: AuthBondCaptureResult) => void;
  abortCause: CaptureAbortCause | null;
  /**
   * Resolved by an abort. Every await in a run races it, so a parked run sees
   * the abort on a microtask instead of waiting for a timer that may be faked.
   */
  wake: Promise<void>;
  wakeUp: () => void;
  woken: boolean;
  attempts: number;
  slices: number;
  maxSliceMs: number;
  sliceStartedAtMs: number;
  /** Units spent in the current slice; the run's one budget (AUTH_TREE_SLICE_UNITS). */
  sliceUnits: number;
  /** The latest attempt ended in an incomplete-read deferral. Reset at each attempt's start. */
  incompleteRead: boolean;
  readonly phaseMs: AuthBondCapturePhaseMs;
  fileCount: number | null;
  totalBytes: number | null;
  /** The run's latest live snapshot, for results that must not walk again. */
  lastSnapshot: AuthBondSnapshot | null;
}

/** Requests made during a run, folded into the one run that follows it. */
export interface TrailingCapture {
  reason: string;
  requests: number;
  readonly firstRequestedAtMs: number;
  readonly promise: Promise<AuthBondCaptureResult>;
  readonly settle: (result: AuthBondCaptureResult) => void;
}

/** The two full-tree walks, held apart from the cheap per-request checks. */
export interface AuthBondTreeObservation {
  readonly hardenIssues: string[];
  readonly tree: AuthTreeObservation | null;
  /**
   * MONOTONIC milliseconds (see AuthBondGuard.monotonicNow), never wall time.
   * Age is derived from this, and a wall-clock rollback would otherwise make a
   * stale digest read as fresh.
   */
  readonly observedAtMs: number;
}

export interface AuthTreeObservation {
  treeHash: string;
  fileCount: number;
  totalBytes: number;
}

/** Yields the units of each next entry; see AUTH_TREE_SLICE_UNITS. */
export type AuthTreeSteps<T> = Generator<number, T, void>;
