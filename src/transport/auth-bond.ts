import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  DEFAULT_FRESH_INVALID_GRACE_MS,
  hasTransientAuthReadIssue,
  transientAuthReadIssue,
} from '../lib/auth-bond-policy.ts';
import { forceEnsurePrivateDirectorySync } from '../lib/private-fs.ts';
import { errorMessage } from '../lib/error-message.ts';
import { decideRestoreFromCandidate, readTerminalLatchJournal } from './terminal-latch.ts';
import { readRestoreCandidateEvidence } from './auth-generation-v2.ts';
import {
  errnoCode,
  fileSnapshot,
  readCredsThroughNoFollow,
  type AuthBondFileSnapshot,
  type CredsRead,
} from './auth-bond-files.ts';
import {
  AUTH_TREE_SLICE_UNITS,
  CaptureAbortedError,
  DEFAULT_CAPTURE_ATTEMPTS,
  DEFAULT_CAPTURE_RETRY_DELAY_MS,
  DEFAULT_KEEP_BACKUPS,
  DEFAULT_MAX_HISTORY_FILES,
  DEFAULT_TREE_CACHE_MAX_AGE_MS,
  DEFAULT_TREE_REFRESH_MIN_INTERVAL_MS,
  EMPTY_SHA256,
  INCOMPLETE_READ_BOUND_FAILURE,
  INCOMPLETE_READ_DEFERRAL,
  INCOMPLETE_READ_DEFERRED_RUNS,
  MAX_REFRESH_BACKOFF_STEPS,
  MIN_REFRESH_RETRY_INTERVAL_MS,
  TREE_STALE_RISK_MULTIPLE,
  WALK_ENTRY_UNITS,
  authRootKindIssue,
  authTreeValidationError,
  captureOutcome,
  copyPrivateTree,
  copyPrivateTreeSteps,
  drainYielding,
  extractMeHash,
  hardenPrivateTree,
  hardenPrivateTreeSteps,
  inspectAuthTree,
  inspectAuthTreeSteps,
  isHistoryEntryDir,
  isHistoryStagingDirName,
  isoForFileName,
  pathIsInside,
  readJsonOrThrow,
  readLatestManifest,
  removeTreeSteps,
  safeName,
  settleablePromise,
  validateCopiedAuthTreeSteps,
  wholeMs,
  writePrivateJson,
} from './auth-bond-support.ts';
import type {
  AuthBondBackupSnapshot,
  AuthBondCaptureEvent,
  AuthBondCapturePhaseMs,
  AuthBondCaptureResult,
  AuthBondGuardOptions,
  AuthBondRestoreResult,
  AuthBondSnapshot,
  AuthBondSnapshotHead,
  AuthBondStatus,
  AuthBondTreeObservation,
  AuthBondTreeProvenance,
  AuthTreeObservation,
  AuthTreeSteps,
  BackupManifest,
  CaptureAbortCause,
  CaptureRun,
  LatestManifest,
  TrailingCapture,
  TreeRefreshOutcome,
} from './auth-bond-types.ts';

export { MAX_CREDS_BYTES } from './auth-bond-files.ts';
export type { AuthBondFileSnapshot } from './auth-bond-files.ts';
export type {
  AuthBondBackupSnapshot,
  AuthBondCaptureEvent,
  AuthBondCaptureOutcome,
  AuthBondCapturePhaseMs,
  AuthBondCaptureResult,
  AuthBondRestoreResult,
  AuthBondSnapshot,
  AuthBondStatus,
  AuthBondTreeProvenance,
  AuthTreeObservation,
  TreeRefreshKind,
} from './auth-bond-types.ts';

export class AuthBondGuard {
  private readonly authDir: string;
  private readonly instanceName: string;
  private readonly now: () => Date;
  private readonly keepBackups: number;
  private readonly maxHistoryFiles: number;
  private readonly autoRestore: boolean;
  private readonly captureAttempts: number;
  private readonly captureRetryDelayMs: number;
  private readonly captureBlockReason: () => string | null;
  private readonly freshInvalidGraceMs: number;
  private readonly root: string;
  private readonly stateRoot: string;
  private readonly historyRoot: string;
  private readonly stagingRoot: string;
  private readonly latestManifestPath: string;
  private readonly treeCacheMaxAgeMs: number;
  private readonly treeStaleRiskMs: number;
  private readonly treeRefreshMinIntervalMs: number;
  /** Monotonic construction time: the start of the first-walk window. */
  private readonly constructedAtMs: number;
  private lastRefreshStartedAtMs: number | null = null;
  private treeObservation: AuthBondTreeObservation | null = null;
  private treeRefresh: Promise<void> | null = null;
  private treeRefreshCount = 0;
  /** Bumped by every invalidation so a walk started before one cannot publish over it. */
  private treeGeneration = 0;
  /** True from an invalidation until the next successful refresh publishes. */
  private treeInvalidated = false;
  private lastRefreshOutcome: TreeRefreshOutcome | null = null;
  private treeRefreshAttempts = 0;
  private consecutiveRefreshFailures = 0;
  private successorDueAtMs: number | null = null;
  /** An invalidation arrived that no started walk has covered yet. */
  private treeRefreshRequested = false;
  /** At most one pending successor walk. */
  private treeSuccessorTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Which armed successor a fired callback belongs to.
   *
   * clearTimeout cannot recall a callback that has already been handed to the
   * event loop, so cancellation alone does not establish "an obsolete timer
   * never forces a walk". Comparing this token does.
   */
  private treeSuccessorEpoch = 0;
  /**
   * Monotonic timestamp of the first snapshot in the current transient-read
   * streak, cleared as soon as a snapshot no longer carries one. Compared to
   * treeStaleRiskMs so a permanently transient credential is eventually named
   * on the health surface. See the transientReadPersistent field on
   * AuthBondSnapshot and classifyAuthFailure in src/core/health.ts.
   *
   * PROCESS-LOCAL, and deliberately so this round: a restart starts the streak
   * over, so an instance restarting faster than treeStaleRiskMs never reaches
   * the bound. Documented on the snapshot field and in the release note.
   */
  private transientReadStartedAtMs: number | null = null;
  /**
   * The transient issue text the open streak belongs to, or null when none is
   * open. The streak is keyed by it, so a change of reason closes one episode
   * and starts another rather than accumulating one age across two different
   * faults — which is what would make the serialized reason and age on the
   * health surface describe different things.
   */
  private transientReadReason: string | null = null;
  /**
   * Monotonic clock for digest age.
   *
   * Age must never come from wall time: a clock adjustment backwards would make
   * a stale digest read as fresh and silently extend the staleness bound. The
   * Date-valued `now` stays for the human-facing timestamps elsewhere in this
   * class, which must track wall time.
   */
  private readonly monotonicNow: () => number;
  private lastTreeInvalidationReason: string | null = null;
  private lastCaptureAt: string | null = null;
  private lastCaptureReason: string | null = null;
  private lastCaptureError: string | null = null;
  private lastCaptureDeferredAt: string | null = null;
  private lastCaptureDeferredReason: string | null = null;
  private lastCaptureDeferredAgeMs: number | null = null;
  private lastRestoreAt: string | null = null;
  private lastRestoreSource: string | null = null;
  private lastRestoreError: string | null = null;
  private lastSweepError: string | null = null;
  private readonly captureYield: () => Promise<void>;
  private readonly captureSleep: (ms: number) => Promise<void>;
  private readonly onCaptureEvent: ((event: AuthBondCaptureEvent) => void) | null;
  private captureRunCount = 0;
  /** At most one run at a time; requests made during it fold into trailingCapture. */
  private activeCapture: CaptureRun | null = null;
  private trailingCapture: TrailingCapture | null = null;
  /** Set by shutdownCaptures(); every later request is refused. */
  private capturesShutDown = false;
  private consecutiveCaptureDeferrals = 0;
  /** Runs in a row that ended deferred on an incomplete read; see INCOMPLETE_READ_DEFERRED_RUNS. */
  private consecutiveIncompleteReadRuns = 0;
  /**
   * Live capture snapshots whose tree read lost an entry between the walk's
   * listing and its read. Such a snapshot is 'present' with no tree hash, and
   * so is one whose auth root was absent at the walk; only the first is an
   * incomplete read that defers. The second fails as before.
   */
  private readonly incompleteTreeReads = new WeakSet<AuthBondSnapshot>();
  /** The last settled run's result snapshot, carried by refused and aborted results. */
  private lastCaptureRunSnapshot: AuthBondSnapshot | null = null;

  constructor(options: AuthBondGuardOptions) {
    this.authDir = options.authDir;
    this.instanceName = safeName(options.instanceName);
    this.now = options.now ?? (() => new Date());
    this.keepBackups = options.keepBackups ?? DEFAULT_KEEP_BACKUPS;
    this.maxHistoryFiles = Math.max(2, options.maxHistoryFiles ?? DEFAULT_MAX_HISTORY_FILES);
    this.autoRestore = options.autoRestore ?? true;
    this.captureAttempts = Math.max(1, options.captureAttempts ?? DEFAULT_CAPTURE_ATTEMPTS);
    this.captureRetryDelayMs = Math.max(0, options.captureRetryDelayMs ?? DEFAULT_CAPTURE_RETRY_DELAY_MS);
    this.captureBlockReason = options.captureBlockReason ?? (() => null);
    this.freshInvalidGraceMs = Math.max(0, options.freshInvalidGraceMs ?? DEFAULT_FRESH_INVALID_GRACE_MS);
    const stateRoot = options.stateRoot && options.stateRoot.trim() !== ''
      ? options.stateRoot
      : join(dirname(options.authDir), '..', 'state');
    this.stateRoot = stateRoot;
    this.root = join(stateRoot, 'auth-bond-backups', this.instanceName);
    this.historyRoot = join(this.root, 'history');
    this.stagingRoot = join(this.root, 'staging');
    this.latestManifestPath = join(this.root, 'latest.json');
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.captureYield = options.captureYield ?? (() => new Promise<void>((resolve) => { setImmediate(resolve); }));
    this.captureSleep = options.captureSleep ?? ((ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
    this.onCaptureEvent = options.onCaptureEvent ?? null;
    this.treeCacheMaxAgeMs = Math.max(0, options.treeCacheMaxAgeMs ?? DEFAULT_TREE_CACHE_MAX_AGE_MS);
    this.treeStaleRiskMs = this.treeCacheMaxAgeMs * TREE_STALE_RISK_MULTIPLE;
    this.constructedAtMs = this.monotonicNow();
    this.treeRefreshMinIntervalMs = Math.max(
      0,
      options.treeRefreshMinIntervalMs ?? DEFAULT_TREE_REFRESH_MIN_INTERVAL_MS,
    );
  }

  /**
   * Full live inspection: both tree walks run inline, on this thread, now.
   *
   * This is the contract every restore, capture and verification path depends
   * on, so it is deliberately NOT cached — a stale tree hash there would turn a
   * fail-closed tamper check into a fail-open one. Observability readers want
   * inspectCached() instead.
   */
  inspect(): AuthBondSnapshot {
    return this.buildSnapshot(hardenPrivateTree(this.authDir), () => inspectAuthTree(this.authDir));
  }

  /**
   * Observability read: never walks the tree on the calling thread.
   *
   * The cheap half of a snapshot (two lstats and one bounded creds.json read)
   * still runs live, so a deleted or corrupted creds.json is reported at once.
   * Only the two full-tree walks come from cache, because those are the ones
   * that cost ~400 ms on an instance carrying 17,680 key files, and they were
   * being paid on every single GET /health.
   *
   * A read here is not what drives convergence, and has not been since the
   * successor timer landed. It may START a walk — when nothing has ever been
   * observed, or the observation is stale and neither the refresh floor, the
   * failure back-off, nor an already-armed successor is holding it back — but a
   * digest converges on its own whether or not anybody reads. Treat a read as
   * an opportunity to refresh, never as the mechanism.
   */
  inspectCached(): AuthBondSnapshot {
    const observation = this.treeObservation;
    const ageMs = observation === null
      ? null
      : Math.max(0, this.monotonicNow() - observation.observedAtMs);
    const stale = observation !== null
      && (this.treeInvalidated || (ageMs !== null && ageMs >= this.treeCacheMaxAgeMs));
    if (observation === null || stale) void this.refreshTreeCache();

    // The two states that are NOT evidence of a healthy tree. Everything else,
    // including a merely stale observation, is still the best evidence there is
    // and is reported as such.
    const unknownReason = observation === null
      ? 'auth_tree_unobserved'
      : ageMs !== null && ageMs >= this.treeStaleRiskMs
        ? `auth_tree_stale:${ageMs}`
        : null;

    return this.buildSnapshot(
      observation?.hardenIssues ?? [],
      () => observation?.tree ?? null,
      {
        source: observation === null ? 'absent' : stale ? 'stale' : 'cached',
        ageMs,
        // Assigned synchronously by refreshTreeCache, so a refresh started
        // immediately above is already visible here.
        refreshInFlight: this.treeRefresh !== null,
        refreshCount: this.treeRefreshCount,
        lastInvalidationReason: this.lastTreeInvalidationReason,
        lastRefreshKind: this.lastRefreshOutcome?.kind ?? 'none',
        lastRefreshReason: this.lastRefreshOutcome?.reason ?? null,
        refreshScheduled: this.treeSuccessorTimer !== null,
        nextRefreshEligibleInMs: this.successorDueAtMs === null
          ? null
          : Math.max(0, this.successorDueAtMs - this.monotonicNow()),
        refreshAttemptCount: this.treeRefreshAttempts,
        // Same bound as `auth_tree_stale`: past it, refreshes are failing or
        // starved, so a never-completed first walk is no longer "pending".
        firstWalkPending: observation === null
          && this.monotonicNow() - this.constructedAtMs < this.treeStaleRiskMs,
      },
      unknownReason,
    );
  }

  /**
   * Record that the auth tree has changed, and converge on a new digest.
   *
   * Contract, stated rather than enumerated by caller — enumerating call sites
   * in this comment went stale twice:
   *
   * - Call it ONCE PER MUTATION, AFTER the write is durable. Calling it before a
   *   write as well is worse than useless: the pair bumps the generation twice,
   *   the second bump fences off the walk the first one started, and the write
   *   buys a full tree walk guaranteed to be discarded.
   * - The last completed observation is KEPT and served, marked stale. These
   *   callers say the tree CHANGED, not that it became unknowable, so the last
   *   walk stays the best available evidence until a newer one exists.
   *   Discarding it was a fail-open: reads then built a snapshot from an empty
   *   harden-issue list, so a planted symlink read as `present` with no issues.
   * - Convergence does not depend on anyone reading. A burst of invalidations
   *   settles onto exactly one successor walk, honouring the refresh floor.
   *
   * Mutations no caller announces — a file planted by hand — are covered by
   * treeCacheMaxAgeMs and the stale risk bound, not by this.
   */
  invalidateTreeCache(reason: string): void {
    this.markTreeStale(reason);
    this.treeRefreshRequested = true;
    void this.refreshTreeCache(false, true);
  }

  /**
   * Record that a walk ended without publishing and a retry is owed.
   *
   * EVERY non-publishing walk earns a retry, not only one an invalidation
   * started. The earlier rule — retry only while `treeInvalidated` — left the
   * two cases that reach here without a mutation, a cold walk and an age-driven
   * one, with no scheduled successor at all, so convergence fell back to
   * "someone reads again". That contradicts the contract stated on
   * invalidateTreeCache: convergence does not depend on anyone reading.
   *
   * What made the old rule necessary was the fear of spinning at the floor
   * cadence for as long as the fault lasts. The back-off is what answers that
   * now: the retry interval doubles per consecutive failure to a ceiling of 16
   * intervals, so a permanently broken tree settles to one walk per ceiling
   * rather than one per floor. On the default 5 s floor that is one walk per
   * 80 s, against the one walk per 5 s a live fleet poller used to drive.
   */
  private noteRefreshNeedsRetry(): void {
    this.consecutiveRefreshFailures = Math.min(
      this.consecutiveRefreshFailures + 1,
      MAX_REFRESH_BACKOFF_STEPS,
    );
    this.treeRefreshRequested = true;
  }

  /**
   * Fence the generation and mark the digest stale WITHOUT starting a walk.
   *
   * For the moment a mutation begins, where a walk would race the mutation it
   * is trying to observe. The restore path is the case: it renames the auth root
   * away on the line after, so a walk started here observes a directory
   * mid-rename and reports `failed`, `incomplete`, or a `fresh` describing a
   * tree that existed for milliseconds.
   */
  private markTreeStale(reason: string): void {
    // A NEW episode starts a new failure streak. The streak exists to slow
    // retries of a fault that is still happening; it is not a fact about the
    // instance, and a mutation announced now is new information that has not
    // failed at anything yet. Without this, demand-driven failures accumulate
    // silently while nothing is invalidated and the next unrelated mutation
    // inherits the ceiling — an 80 s wait for its first look at a tree that
    // just changed. Retries WITHIN an episode keep the streak, which is what
    // makes the back-off a back-off.
    //
    // The armed successor goes with it: it was scheduled against the old
    // streak, and scheduleTreeRefreshSuccessor will not re-time a timer that
    // already exists, so leaving it armed would hand the new episode exactly
    // the wait this reset exists to remove.
    if (!this.treeInvalidated) {
      this.consecutiveRefreshFailures = 0;
      this.cancelTreeRefreshSuccessor();
    }
    this.treeInvalidated = true;
    this.treeGeneration += 1;
    this.lastTreeInvalidationReason = reason;
  }

  /**
   * Minimum gap between walk STARTS, widened while walks keep failing.
   *
   * The flat floor bounds reader-driven cost at one walk per floor, which on a
   * persistently failing tree is one walk every 5 s for as long as the fault
   * lasts — the fleet polls /health at exactly the floor cadence, so the quiet
   * instance the floor was sized against never arrives. The successor back-off
   * did not cover that: it gates scheduleTreeRefreshSuccessor, and a reader
   * does not go through it. Widening the floor by the same factor puts
   * reader-driven and mutation-driven walks on one budget.
   *
   * It stays a FLOOR, not a lock. The floor is consulted only when NO
   * successor is armed: refreshTreeCache returns above at the armed-successor
   * check before this widening is reached, so in ordinary failing operation
   * the timer is the binding guard and this widening is a backstop for the
   * paths where no timer is queued. The stubbed-scheduler test at
   * tests/core/health-auth-bond-digest-cost.test.ts:1426 holds that backstop
   * directly by removing the outer guard.
   *
   * The price is detection latency on the recovery edge: after four
   * consecutive failures a reader re-observes a tree that has come back up to
   * 80 s later, where the flat floor re-observed it within 5 s. Bounded by the
   * 120 s stale risk bound, and fail-closed past it — the digest reads
   * `unknown`, never a stale green. The counter it reads is shared with
   * mutation-driven walks, so an unrelated earlier failure widens this floor
   * too; also bounded by the same ceiling.
   */
  private refreshFloorMs(): number {
    return this.treeRefreshMinIntervalMs * 2 ** this.consecutiveRefreshFailures;
  }

  /**
   * How long a failure retry waits, which is NOT the reader admission floor.
   *
   * Same doubling, but over a base clamped at MIN_REFRESH_RETRY_INTERVAL_MS.
   * Every non-publishing walk now schedules a successor, so this base is what
   * stops the retry chain from becoming a 0 ms timer loop when a caller
   * configures a zero floor. The reader floor deliberately does NOT share the
   * clamp: a caller that asks for an unthrottled reader still gets one.
   */
  private refreshRetryWaitMs(): number {
    return Math.max(this.treeRefreshMinIntervalMs, MIN_REFRESH_RETRY_INTERVAL_MS)
      * 2 ** this.consecutiveRefreshFailures;
  }

  /**
   * Drop a queued successor that has been made pointless.
   *
   * Two callers, both of which have just made the queued walk wrong rather
   * than merely early: a publication (the successor would re-walk a tree that
   * has just been observed, and would leave `digest_refresh_scheduled` true
   * over a settled digest), and the start of a new invalidation episode (the
   * successor carries the previous episode's back-off).
   */
  private cancelTreeRefreshSuccessor(): void {
    if (this.treeSuccessorTimer === null) return;
    clearTimeout(this.treeSuccessorTimer);
    this.treeSuccessorTimer = null;
    this.successorDueAtMs = null;
    // Retire the token as well: a callback already queued behind clearTimeout
    // must not walk when it runs.
    this.treeSuccessorEpoch += 1;
  }

  /**
   * Queue exactly one successor walk, no earlier than the refresh floor allows.
   *
   * This is what makes a burst converge. Without it, an invalidation landing
   * during a walk fenced that walk off and scheduled nothing, so the digest
   * stayed stale until some reader happened to ask past the floor — and under
   * sustained writes, never.
   */
  private scheduleTreeRefreshSuccessor(): void {
    if (this.treeSuccessorTimer !== null) return;
    const sinceLastStartMs = this.lastRefreshStartedAtMs === null
      ? Number.POSITIVE_INFINITY
      : this.monotonicNow() - this.lastRefreshStartedAtMs;
    const floorWaitMs = Number.isFinite(sinceLastStartMs)
      ? Math.max(0, this.treeRefreshMinIntervalMs - sinceLastStartMs)
      : 0;
    // Back off after repeated non-publishing walks so a persistent I/O fault
    // does not walk the tree at the floor cadence forever. The wait doubles per
    // consecutive failure and is capped at 2^4 = 16 intervals, which at the 5 s
    // default is 80 s.
    //
    // THE 120 s STALE RISK BOUND BOUNDS CLASSIFICATION, NOT CONVERGENCE. It
    // guarantees only this: on the first read at or after 120 s from the last
    // successful observation, the digest reports `unknown` instead of a stale
    // `present`. It does NOT guarantee that a refresh lands inside 120 s, and
    // this schedule is why. The failure counter is raised before this runs, so
    // measured from the last publication the attempts land at roughly 10, 30,
    // 70 and 150 s and then every 80 s, plus the walk's own duration. The last
    // attempt inside the bound is the one at 70 s; a tree that recovers after
    // it is not re-observed until about 150 s, and reads `unknown` until then.
    //
    // Deliberate on both counts. `unknown` is the fail-closed reading, never a
    // stale green, and four consecutive failed walks is exactly the case where
    // continuing at the floor cadence buys nothing.
    const backoffMs = this.refreshRetryWaitMs();
    const waitMs = Math.max(floorWaitMs, this.consecutiveRefreshFailures > 0 ? backoffMs : 0);
    const epoch = (this.treeSuccessorEpoch += 1);
    this.successorDueAtMs = this.monotonicNow() + waitMs;
    this.treeSuccessorTimer = setTimeout(() => {
      // An obsolete timer must never force a walk. clearTimeout is the primary
      // mechanism; this token is what makes the property hold for a callback
      // that was already queued when the timer was cancelled.
      if (epoch !== this.treeSuccessorEpoch) return;
      this.treeSuccessorTimer = null;
      this.successorDueAtMs = null;
      // Forced: the floor and the back-off were both served by waiting here.
      void this.refreshTreeCache(true);
    }, waitMs);
    this.treeSuccessorTimer.unref?.();
  }

  /**
   * Complete a refresh, ignoring the rate floor.
   *
   * Forced because its callers need a digest to exist before proceeding —
   * connection open, and tests. The floor exists to stop event-driven churn
   * from monopolising the CPU, not to make a deliberate warm fail.
   */
  async warmTreeCache(): Promise<void> {
    // A refresh already in flight may be superseded by an invalidation and
    // discard its result, leaving no observation behind. One retry covers that
    // without looping forever on a walk that genuinely cannot complete.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await this.refreshTreeCache(true);
      // Only a 'fresh' outcome counts. An observation left over from an earlier
      // walk is not proof that THIS warm succeeded, and treating it as proof is
      // how an incomplete walk used to be accepted as a completed one.
      if (this.lastRefreshOutcome?.kind === 'fresh') return;
    }
  }

  private refreshTreeCache(force = false, fromInvalidation = false): Promise<void> {
    const inFlight = this.treeRefresh;
    if (inFlight !== null) {
      // Only a MUTATION earns a successor. A reader or a warm that merely
      // arrived during a walk is answered by that walk; queueing a successor
      // for them bought a second full traversal for no new information.
      if (fromInvalidation) this.treeRefreshRequested = true;
      return inFlight;
    }
    // A successor is already armed, so a walk is coming at successorDueAtMs and
    // a reader that starts one anyway defeats the back-off that timer is
    // holding. The two are not redundant: the reader floor is measured from the
    // last walk's START and the successor's wait from its END, so the floor can
    // elapse while the timer is still pending, which is the window a 5 s poller
    // used to walk through. Mutations are deliberately NOT gated here — a
    // mutation is new information, and markTreeStale has already cancelled
    // the successor at the START of a new episode; the replacement is armed
    // later, by the floor branch below or by the walk's own `finally`.
    if (!force && !fromInvalidation && this.treeSuccessorTimer !== null) {
      return Promise.resolve();
    }
    const startedAtMs = this.monotonicNow();
    if (
      !force
      && this.lastRefreshStartedAtMs !== null
      && startedAtMs - this.lastRefreshStartedAtMs < this.refreshFloorMs()
    ) {
      // Too soon to walk again. Deferred, not dropped: queue one successor so
      // convergence does not depend on a reader arriving after the floor. Only
      // for a mutation — a floor-blocked reader has nothing to converge on.
      if (fromInvalidation) {
        this.treeRefreshRequested = true;
        this.scheduleTreeRefreshSuccessor();
      }
      return Promise.resolve();
    }
    this.treeRefreshRequested = false;
    this.lastRefreshStartedAtMs = startedAtMs;
    this.treeRefreshAttempts += 1;
    const generation = this.treeGeneration;
    const run = (async (): Promise<void> => {
      try {
        const hardenIssues = await drainYielding(hardenPrivateTreeSteps(this.authDir));
        // walkAuthFilesSteps throws on a symlink rather than reporting it, and
        // the harden pass has already recorded that same condition as an issue.
        // Skipping the digest walk here mirrors inspect(), where a symlink
        // forces status away from 'present' and the tree is never walked.
        const symlinked = hardenIssues.some(issue => issue.startsWith('auth_tree_symlink:'));
        const rootPresent = existsSync(this.authDir);
        const tree = symlinked || !rootPresent
          ? null
          : await drainYielding(inspectAuthTreeSteps(this.authDir));

        // A refresh is single-flight, so an invalidation landing mid-walk would
        // otherwise be erased: this walk would finish and stamp a fresh
        // observation over a tree that has already changed again.
        if (generation !== this.treeGeneration) {
          this.lastRefreshOutcome = {
            kind: 'superseded', atMs: this.monotonicNow(), reason: 'invalidated-during-walk',
          };
          return;
        }

        // A null tree with a present, non-symlinked root means the walk saw an
        // entry vanish and fail-closed to no digest. That is NOT an observation:
        // publishing it stamped a current timestamp on a null digest, which read
        // as `digest_source: "cached"` with no issue and no hash — green health
        // built from a walk that never completed. Keep the previous observation
        // and let it age instead.
        if (tree === null && !symlinked) {
          // Deliberately NOT conditioned on the root being present. A walk over
          // an absent root inspected nothing and its harden pass returns an
          // empty issue list, so publishing it stamped a current timestamp on a
          // null digest with no issues — which reads back as `cached` with a
          // clean tree once the root returns. That window is the auto-restore
          // rename, which is on by default. An absent root is already reported
          // by buildSnapshot's live authDir check, so declining to publish here
          // loses no evidence.
          this.lastRefreshOutcome = {
            kind: 'incomplete',
            atMs: this.monotonicNow(),
            reason: rootPresent ? 'auth_tree_walk_incomplete' : 'auth_root_absent',
          };
          this.noteRefreshNeedsRetry();
          return;
        }

        this.treeObservation = { hardenIssues, tree, observedAtMs: this.monotonicNow() };
        this.treeInvalidated = false;
        this.treeRefreshCount += 1;
        this.consecutiveRefreshFailures = 0;
        // Any successor armed before this walk was queued for work this walk
        // has now done: an invalidation arriving DURING the walk bumps the
        // generation and returns 'superseded' above, so reaching this line
        // means nothing is outstanding. Leaving it armed spends a second full
        // traversal and publishes `digest_refresh_scheduled: true` over a
        // digest that is settled. The `finally` below arms a fresh one if a
        // mutation did land mid-walk.
        this.cancelTreeRefreshSuccessor();
        this.lastRefreshOutcome = { kind: 'fresh', atMs: this.monotonicNow(), reason: null };
      } catch (err) {
        // Keep the last known observation and let it go on ageing. A failed
        // refresh must never propagate: its only caller is a fire-and-forget
        // `void` from a read path, where a rejection becomes an unhandled
        // rejection and main.ts turns that into an instance shutdown. The
        // outcome is recorded so a persistent fault is visible rather than
        // silently holding a digest at a fixed age.
        this.lastRefreshOutcome = {
          kind: 'failed', atMs: this.monotonicNow(), reason: errorMessage(err),
        };
        this.noteRefreshNeedsRetry();
      } finally {
        this.treeRefresh = null;
        // An invalidation landed while this walk ran, so this walk's result was
        // either fenced off or already out of date. Exactly one successor.
        if (this.treeRefreshRequested) {
          this.treeRefreshRequested = false;
          this.scheduleTreeRefreshSuccessor();
        }
      }
    })();
    this.treeRefresh = run;
    return run;
  }

  private buildSnapshot(
    hardenIssues: readonly string[],
    readTree: () => AuthTreeObservation | null,
    treeProvenance?: AuthBondTreeProvenance,
    unknownReason?: string | null,
  ): AuthBondSnapshot {
    const head = this.snapshotHead(hardenIssues);
    return this.snapshotTail(head, head.status === 'present' ? readTree() : null, treeProvenance, unknownReason);
  }

  /**
   * inspect(), as slices: the same harden walk, cheap reads, tree walk and
   * tail, in the same order. A capture drives it with yields between slices.
   */
  private *liveSnapshotSteps(): AuthTreeSteps<AuthBondSnapshot> {
    const hardenIssues = yield* hardenPrivateTreeSteps(this.authDir);
    const head = this.snapshotHead(hardenIssues);
    const read = { incomplete: false };
    const tree = head.status === 'present' ? yield* inspectAuthTreeSteps(this.authDir, read) : null;
    const snapshot = this.snapshotTail(head, tree);
    if (read.incomplete) this.incompleteTreeReads.add(snapshot);
    return snapshot;
  }

  /**
   * The cheap half of a snapshot: two lstats and one bounded creds.json read.
   * The tree is read only when this half ends 'present'.
   */
  private snapshotHead(hardenIssues: readonly string[]): AuthBondSnapshotHead {
    const credsPath = join(this.authDir, 'creds.json');
    const issues: string[] = [];
    issues.push(...hardenIssues);
    const authDir = fileSnapshot(this.authDir);
    const rootKindIssue = authRootKindIssue(this.authDir);
    // A bad root is the finding, and nothing under it can be trusted. Do not
    // open the child at all: O_NOFOLLOW constrains only the final component, so
    // reading creds.json under a symlinked root traverses whatever directory
    // the link points at, and a FIFO planted there is reached through exactly
    // this path.
    const credsRead: CredsRead = rootKindIssue === null
      ? readCredsThroughNoFollow(this.authDir, credsPath)
      : {
          snapshot: { path: credsPath, exists: false, mode: null, size: null, mtime: null, sha256: null, error: null },
          bytes: null,
          kindIssue: null,
        };
    const creds = credsRead.snapshot;
    let status: AuthBondStatus = 'present';
    let meHash: string | null = null;
    const hasSymlinkIssue = issues.some(issue => issue.startsWith('auth_tree_symlink:'));

    // An errno means the path could not be READ, which is not the same as it
    // not being there. The distinction is the operator's next move: 'missing'
    // says re-pair (destructive), 'unreadable' says fix a mode or a disk.
    // Classified ahead of the content checks below, which would otherwise read
    // the null hash of an unread file as "empty" or as a hash mismatch.
    const authDirUnreadable = authDir.error !== null;
    const credsUnreadable = creds.error !== null;

    if (authDirUnreadable) {
      status = 'invalid';
      issues.push(`auth_dir_unreadable:${authDir.error}`);
    } else if (!authDir.exists) {
      status = 'missing';
      issues.push('auth_dir_missing');
    }
    if (rootKindIssue !== null) {
      // The credential was never looked at, so say nothing about it. Reporting
      // `creds_json_missing` here would send an operator to re-pair over a
      // symlinked directory, which is a different and less destructive fix.
      status = 'invalid';
    } else if (credsUnreadable) {
      status = 'invalid';
      issues.push(`creds_json_unreadable:${creds.error}`);
    } else if (!creds.exists && credsRead.kindIssue === null) {
      status = 'missing';
      issues.push('creds_json_missing');
    }
    if (hasSymlinkIssue) {
      status = 'invalid';
    }
    // Live kind checks. These do not depend on the cached tree walk, so they
    // hold even while the digest is stale, absent, or serving a clean result.
    if (rootKindIssue) {
      status = 'invalid';
      issues.push(rootKindIssue);
    }
    if (credsRead.kindIssue) {
      status = 'invalid';
      issues.push(credsRead.kindIssue);
    }
    if (creds.exists && !credsUnreadable && !hasSymlinkIssue && !credsRead.kindIssue) {
      if (creds.size === 0 || creds.sha256 === EMPTY_SHA256) {
        status = 'invalid';
        issues.push('creds_json_empty');
      } else {
        try {
          // The SAME bytes the hash above covers. Re-reading the path here was
          // the second half of the symlink race.
          const parsed = JSON.parse((credsRead.bytes ?? Buffer.alloc(0)).toString('utf8')) as unknown;
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            status = 'invalid';
            issues.push('creds_json_not_object');
          } else {
            meHash = extractMeHash(parsed);
            if (!meHash) {
              status = 'invalid';
              issues.push('creds_json_missing_me');
            }
          }
        } catch {
          status = 'invalid';
          issues.push('creds_json_invalid_json');
        }
      }
    }

    return { issues, authDir, creds, status, meHash };
  }

  /** Everything after the tree read, shared by buildSnapshot and liveSnapshotSteps. */
  private snapshotTail(
    head: AuthBondSnapshotHead,
    tree: AuthTreeObservation | null,
    treeProvenance?: AuthBondTreeProvenance,
    unknownReason?: string | null,
  ): AuthBondSnapshot {
    const { issues, authDir, creds, meHash } = head;
    let status = head.status;
    // Applied AFTER the tree read so a stale digest is still published as
    // evidence, and only over 'present': 'missing' and 'invalid' are specific
    // findings about the credentials themselves and outrank "no tree evidence".
    if (unknownReason && status === 'present') {
      status = 'unknown';
      issues.push(unknownReason);
    }
    const transientRead = this.noteTransientReadState(issues);
    return {
      status,
      authDir,
      creds,
      meHash,
      treeHash: tree?.treeHash ?? null,
      fileCount: tree?.fileCount ?? null,
      totalBytes: tree?.totalBytes ?? null,
      backup: this.backupSnapshot(),
      issues,
      ...(treeProvenance ? { treeProvenance } : {}),
      transientReadPersistent: transientRead.persistent,
      transientReadReason: transientRead.reason,
      transientReadAgeMs: transientRead.ageMs,
    };
  }

  /**
   * Update the transient-read streak and report it.
   *
   * Called at the tail of every buildSnapshot so live and cached snapshots
   * share the same accounting: the streak starts on the first
   * transient-carrying snapshot, is reset by the first snapshot without one,
   * and flips to persistent at the same age the tree observation would flip to
   * `unknown`.
   *
   * KEYED BY THE ISSUE TEXT. A snapshot carrying a different transient reason
   * than the open streak starts a NEW streak rather than continuing the old
   * one, so the reason and the age reported together always describe the same
   * fault. The alternative — one streak spanning a root EAGAIN followed by a
   * child EWOULDBLOCK — reaches the bound sooner and cannot say what the age
   * was accumulated against.
   *
   * The streak also resets whenever the credential is not read at all, which
   * buildSnapshot skips on a bad root: a symlinked root landing on top of a
   * persistent transient zeroes the streak. That is the fail-safe direction —
   * the root fault is the finding — and it is stated here because it is not
   * obvious from the predicate.
   */
  private noteTransientReadState(issues: readonly string[]): {
    persistent: boolean;
    reason: string | null;
    ageMs: number | null;
  } {
    const reason = transientAuthReadIssue(issues);
    if (reason === null) {
      this.transientReadStartedAtMs = null;
      this.transientReadReason = null;
      return { persistent: false, reason: null, ageMs: null };
    }
    const nowMs = this.monotonicNow();
    if (this.transientReadStartedAtMs === null || this.transientReadReason !== reason) {
      this.transientReadStartedAtMs = nowMs;
      this.transientReadReason = reason;
      return { persistent: false, reason, ageMs: 0 };
    }
    const ageMs = nowMs - this.transientReadStartedAtMs;
    return { persistent: ageMs >= this.treeStaleRiskMs, reason, ageMs };
  }

  /**
   * Capture a backup of the auth tree, off the caller's turn.
   *
   * Single-flight: one run at a time per guard. A request made during a run
   * folds into one trailing run that starts when the active run settles, so
   * every caller gets the result of a run that started after its request, and
   * callers folded together share one promise and one result. Never rejects.
   * An idle guard starts the run, and emits `started`, before returning; the
   * run's first slice comes after a yield.
   */
  capture(reason: string): Promise<AuthBondCaptureResult> {
    if (this.capturesShutDown) return Promise.resolve(this.refusedCaptureResult());
    if (this.activeCapture === null) return this.startCaptureRun(reason, 1, 0, null);
    const trailing = this.trailingCapture;
    if (trailing !== null) {
      trailing.reason = reason;
      trailing.requests += 1;
      return trailing.promise;
    }
    const { promise, settle } = settleablePromise<AuthBondCaptureResult>();
    this.trailingCapture = { reason, requests: 1, firstRequestedAtMs: this.monotonicNow(), promise, settle };
    return promise;
  }

  /**
   * Abort the active run, refuse every later request, and settle.
   *
   * The run sees the abort on a microtask through its wake promise, publishes
   * nothing new, and leaves its staging folder for the next process's sweep.
   * A trailing run settles aborted without starting.
   */
  async shutdownCaptures(): Promise<void> {
    this.capturesShutDown = true;
    const trailing = this.trailingCapture;
    this.trailingCapture = null;
    if (trailing !== null) trailing.settle(this.refusedCaptureResult());
    const active = this.activeCapture;
    if (active === null) return;
    this.abortActiveCapture('shutdown');
    await active.promise;
  }

  private abortActiveCapture(cause: CaptureAbortCause): void {
    const run = this.activeCapture;
    if (run === null) return;
    run.abortCause = cause;
    run.woken = true;
    run.wakeUp();
  }

  private rearmCaptureWake(run: CaptureRun): void {
    const wake = settleablePromise<void>();
    run.wake = wake.promise;
    run.wakeUp = () => { wake.settle(); };
    run.woken = false;
  }

  private startCaptureRun(
    reason: string,
    coalescedRequests: number,
    queuedMs: number,
    carried: TrailingCapture | null,
  ): Promise<AuthBondCaptureResult> {
    const { promise, settle } = carried ?? settleablePromise<AuthBondCaptureResult>();
    const wake = settleablePromise<void>();
    const startedAtMs = this.monotonicNow();
    const run: CaptureRun = {
      run: ++this.captureRunCount,
      reason,
      startedAtMs,
      promise,
      settle,
      abortCause: null,
      wake: wake.promise,
      wakeUp: () => { wake.settle(); },
      woken: false,
      attempts: 0,
      slices: 0,
      maxSliceMs: 0,
      sliceStartedAtMs: startedAtMs,
      sliceUnits: 0,
      incompleteRead: false,
      phaseMs: { inspect: 0, sweep: 0, copy: 0, validate: 0, publish: 0, prune: 0 },
      fileCount: null,
      totalBytes: null,
      lastSnapshot: null,
    };
    this.activeCapture = run;
    this.emitCaptureEvent({ kind: 'started', run: run.run, reason, coalescedRequests, queuedMs });
    void this.driveCaptureRun(run);
    return promise;
  }

  private async driveCaptureRun(run: CaptureRun): Promise<void> {
    let result: AuthBondCaptureResult;
    try {
      result = await this.runCaptureAttempts(run);
    } catch (err) {
      result = this.caughtCaptureResult(run, err);
    }
    this.finishCaptureRun(run, result);
  }

  /**
   * Never rejects: an abort becomes an aborted result, and any other throw (a
   * walk, cleanup, captureYield or captureSleep) a failed one. If building that
   * result throws as well, the run still settles, with a result that reads
   * nothing from disk.
   */
  private caughtCaptureResult(run: CaptureRun, err: unknown): AuthBondCaptureResult {
    try {
      return err instanceof CaptureAbortedError
        ? this.abortedCaptureResult(run, err.abortCause)
        : this.thrownCaptureResult(run, err);
    } catch (resultErr) {
      return this.unreadCaptureResult(run, err, resultErr);
    }
  }

  private async runCaptureAttempts(run: CaptureRun): Promise<AuthBondCaptureResult> {
    for (let attempt = 1; ; attempt += 1) {
      run.attempts = attempt;
      run.incompleteRead = false;
      // Every attempt, the first included, starts after a yield, so no capture
      // work runs on the caller's turn. The retry delay is an awaited
      // captureSleep; a delay of 0 is only this yield.
      await this.captureSliceBoundary(run);
      const result = await this.captureAttempt(run);
      if (result.ok || !result.deferred || attempt >= this.captureAttempts) return result;
      if (this.captureRetryDelayMs > 0) {
        // The sleep is not slice time. Close the attempt's last slice before
        // it; raceCaptureWake starts the next slice when the sleep ends.
        this.closeCaptureSlice(run);
        await this.raceCaptureWake(run, this.captureSleep(this.captureRetryDelayMs));
      }
    }
  }

  private finishCaptureRun(run: CaptureRun, result: AuthBondCaptureResult): void {
    let nowMs = run.sliceStartedAtMs;
    try {
      nowMs = this.monotonicNow();
      const outcome = captureOutcome(result);
      if (outcome === 'deferred') this.consecutiveCaptureDeferrals += 1;
      else if (outcome === 'captured' || outcome === 'unchanged') this.consecutiveCaptureDeferrals = 0;
      // Runs, not attempts: only the run's final attempt sets the flag, and any
      // other ending, the bound's own failure included, starts the count over.
      this.consecutiveIncompleteReadRuns = outcome === 'deferred' && run.incompleteRead
        ? this.consecutiveIncompleteReadRuns + 1
        : 0;
      this.lastCaptureRunSnapshot = result.snapshot;
      const { phaseMs } = run;
      this.emitCaptureEvent({
        kind: 'finished',
        run: run.run,
        reason: run.reason,
        outcome,
        elapsedMs: wholeMs(nowMs - run.startedAtMs),
        attempts: run.attempts,
        slices: run.slices,
        maxSliceMs: wholeMs(Math.max(run.maxSliceMs, nowMs - run.sliceStartedAtMs)),
        phaseMs: {
          inspect: wholeMs(phaseMs.inspect),
          sweep: wholeMs(phaseMs.sweep),
          copy: wholeMs(phaseMs.copy),
          validate: wholeMs(phaseMs.validate),
          publish: wholeMs(phaseMs.publish),
          prune: wholeMs(phaseMs.prune),
        },
        fileCount: run.fileCount,
        totalBytes: run.totalBytes,
        error: result.error,
        consecutiveDeferrals: this.consecutiveCaptureDeferrals,
      });
    } finally {
      // Whatever the bookkeeping above did: a run that never settles strands
      // every caller and makes shutdownCaptures() wait forever, and so would a
      // trailing run that never starts.
      this.activeCapture = null;
      run.settle(result);
      this.startTrailingCapture(nowMs);
    }
  }

  /** Start the folded requests' run once the active run has settled, or refuse it after shutdown. */
  private startTrailingCapture(nowMs: number): void {
    const trailing = this.trailingCapture;
    if (trailing === null) return;
    this.trailingCapture = null;
    if (this.capturesShutDown) {
      trailing.settle(this.refusedCaptureResult());
      return;
    }
    void this.startCaptureRun(
      trailing.reason,
      trailing.requests,
      wholeMs(nowMs - trailing.firstRequestedAtMs),
      trailing,
    );
  }

  private emitCaptureEvent(event: AuthBondCaptureEvent): void {
    if (this.onCaptureEvent === null) return;
    try {
      this.onCaptureEvent(event);
    } catch {
      // Intentional: logging must never break a capture.
    }
  }

  /**
   * Hand the loop back once: one slice, and a throw if an abort woke the run.
   * captureYield is called here and nowhere else, once per boundary, in the
   * boundary's own synchronous turn.
   */
  private async captureSliceBoundary(run: CaptureRun): Promise<void> {
    this.closeCaptureSlice(run);
    this.throwIfCaptureWoken(run);
    run.slices += 1;
    run.sliceUnits = 0;
    await this.raceCaptureWake(run, this.captureYield());
  }

  /** Charge the synchronous work since the slice started to maxSliceMs. */
  private closeCaptureSlice(run: CaptureRun): void {
    run.maxSliceMs = Math.max(run.maxSliceMs, this.monotonicNow() - run.sliceStartedAtMs);
  }

  /**
   * Every await in a run goes through here, so an abort ends it on a microtask.
   * The next slice starts when the await ends, however it ends: time parked in
   * a yield, a sleep or a wake is not slice time.
   */
  private async raceCaptureWake(run: CaptureRun, work: Promise<void>): Promise<void> {
    try {
      await Promise.race([work, run.wake]);
    } finally {
      run.sliceStartedAtMs = this.monotonicNow();
    }
    this.throwIfCaptureWoken(run);
  }

  private throwIfCaptureWoken(run: CaptureRun): void {
    if (run.woken) throw new CaptureAbortedError(run.abortCause ?? 'shutdown');
  }

  /**
   * Drive one tree operation as slices, charging its wall time, yields included,
   * to one phase.
   *
   * The run's one yield decision. Every generator a run drives (the walks, the
   * sweep, the copy, the validation, the cleanup and the prune) comes through
   * here and yields the units of each next entry before doing it. The budget is
   * the run's, not this call's, so neither a phase boundary nor the next orphan
   * or history entry restarts the count; only a boundary does.
   */
  private async captureSteps<T>(
    run: CaptureRun,
    phase: keyof AuthBondCapturePhaseMs,
    steps: AuthTreeSteps<T>,
  ): Promise<T> {
    const startedAtMs = this.monotonicNow();
    try {
      for (;;) {
        const step = steps.next();
        if (step.done) return step.value;
        if (run.sliceUnits + step.value > AUTH_TREE_SLICE_UNITS) await this.captureSliceBoundary(run);
        run.sliceUnits += step.value;
      }
    } finally {
      run.phaseMs[phase] += this.monotonicNow() - startedAtMs;
    }
  }

  /** A live snapshot read in slices; it takes the place of each inline inspect() in a run. */
  private async liveCaptureSnapshot(run: CaptureRun): Promise<AuthBondSnapshot> {
    const snapshot = await this.captureSteps(run, 'inspect', this.liveSnapshotSteps());
    run.lastSnapshot = snapshot;
    return snapshot;
  }

  /** The snapshot with its backup half re-read after the guard's capture fields changed. */
  private withCurrentBackup(snapshot: AuthBondSnapshot): AuthBondSnapshot {
    return { ...snapshot, backup: this.backupSnapshot() };
  }

  /** Refused and aborted results never walk: the run's snapshot, the last run's, or the cache. */
  private snapshotWithoutWalk(run: CaptureRun | null): AuthBondSnapshot {
    return run?.lastSnapshot ?? this.lastCaptureRunSnapshot ?? this.inspectCached();
  }

  private refusedCaptureResult(): AuthBondCaptureResult {
    return {
      ok: false,
      snapshot: this.snapshotWithoutWalk(null),
      captured: false,
      deferred: false,
      aborted: true,
      path: null,
      error: 'auth bond capture refused: shutting down',
    };
  }

  private abortedCaptureResult(run: CaptureRun, cause: CaptureAbortCause): AuthBondCaptureResult {
    return this.abortedCaptureResultWith(this.snapshotWithoutWalk(run), cause);
  }

  private abortedCaptureResultWith(snapshot: AuthBondSnapshot, cause: CaptureAbortCause): AuthBondCaptureResult {
    return {
      ok: false,
      snapshot,
      captured: false,
      deferred: false,
      aborted: true,
      path: null,
      error: cause === 'shutdown'
        ? 'auth bond capture aborted: shutting down'
        : 'auth bond capture aborted: auth restore in progress',
    };
  }

  /** A throw the attempt did not classify, recorded as a failure the way today's are. */
  private thrownCaptureResult(run: CaptureRun, err: unknown): AuthBondCaptureResult {
    this.lastCaptureAt = this.now().toISOString();
    this.lastCaptureReason = run.reason;
    this.lastCaptureError = errorMessage(err);
    return {
      ok: false,
      snapshot: this.withCurrentBackup(this.snapshotWithoutWalk(run)),
      captured: false,
      deferred: false,
      path: null,
      error: this.lastCaptureError,
    };
  }

  /**
   * The last-resort result, when building the aborted or failed one threw too.
   *
   * A latest.json whose backupPath is truthy but not a string passes the
   * manifest's object check and then throws on every read of the backup half,
   * the read that builds the failure result included. This result reads nothing
   * from disk, so it cannot throw that way: its snapshot carries no tree data
   * and status 'unknown' (no current evidence), and its backup half comes from
   * the guard's own fields without reading latest.json. An abort stays an abort
   * and leaves the guard's health fields alone; anything else is recorded as a
   * failure, as thrownCaptureResult records one.
   */
  private unreadCaptureResult(run: CaptureRun, err: unknown, resultErr: unknown): AuthBondCaptureResult {
    const unread: AuthBondFileSnapshot = {
      path: this.authDir, exists: false, mode: null, size: null, mtime: null, sha256: null, error: null,
    };
    const snapshotFor = (): AuthBondSnapshot => ({
      status: 'unknown',
      authDir: unread,
      creds: { ...unread, path: join(this.authDir, 'creds.json') },
      meHash: null,
      treeHash: null,
      fileCount: null,
      totalBytes: null,
      backup: this.backupHalf(null, null),
      issues: ['auth_bond_capture_result_unread'],
    });
    if (err instanceof CaptureAbortedError) return this.abortedCaptureResultWith(snapshotFor(), err.abortCause);
    this.lastCaptureAt = this.now().toISOString();
    this.lastCaptureReason = run.reason;
    this.lastCaptureError = `${errorMessage(err)}; failure result unreadable: ${errorMessage(resultErr)}`;
    return {
      ok: false,
      snapshot: snapshotFor(),
      captured: false,
      deferred: false,
      path: null,
      error: this.lastCaptureError,
    };
  }

  private blockedCaptureResult(
    reason: string,
    blockedReason: string,
    resultSnapshot: AuthBondSnapshot,
  ): AuthBondCaptureResult {
    this.lastCaptureAt = this.now().toISOString();
    this.lastCaptureReason = reason;
    this.lastCaptureError = `auth bond capture blocked: ${blockedReason}`;
    return {
      ok: false,
      snapshot: this.withCurrentBackup(resultSnapshot),
      captured: false,
      deferred: false,
      blocked: true,
      path: null,
      error: this.lastCaptureError,
    };
  }

  /**
   * One attempt: the former captureOnce, with every live inspect, the sweep,
   * the copy, the validation, the cleanup and the prune driven as slices.
   * Classification, error texts and deferral rules are unchanged.
   */
  private async captureAttempt(run: CaptureRun): Promise<AuthBondCaptureResult> {
    const { reason } = run;
    const snapshot = await this.liveCaptureSnapshot(run);
    run.fileCount = snapshot.fileCount;
    run.totalBytes = snapshot.totalBytes;
    const blockedReason = this.captureBlockReason();
    if (blockedReason) {
      return this.blockedCaptureResult(reason, blockedReason, await this.liveCaptureSnapshot(run));
    }
    const treeHash = snapshot.treeHash;
    if (snapshot.status !== 'present' || !treeHash) {
      // A transient read is not grounds for a repair alert either.
      //
      // The restore is the destructive consumer of a non-'present' bond; this
      // is the PAGING one. The failure below reports deferred: false, and
      // connection.ts turns that into a local auth-bond alert whose asset
      // carries recoverability 'manual_repair_required' and confidence
      // 'confirmed' — a verdict on the credential's integrity that a read
      // which never finished cannot support, and one /health contradicts at
      // the same moment by classifying the same issue as non-terminal.
      //
      // Deferring is also the useful answer rather than only the safe one:
      // capture() retries a deferred attempt, so a transient that clears is
      // captured on the next look instead of being logged as a repair.
      if (hasTransientAuthReadIssue(snapshot.issues)) {
        return this.deferTransientCapture(reason, snapshot, await this.liveCaptureSnapshot(run));
      }
      if (this.incompleteTreeReads.has(snapshot)) {
        // 'present' with no tree hash because an entry vanished between the
        // walk's listing and its read (#2285), which a sliced walk leaves room
        // for. A root absent at the walk is not this case and still fails below.
        return this.incompleteReadCaptureResult(run, await this.liveCaptureSnapshot(run));
      }
      const freshAgeMs = this.freshInvalidCredentialAgeMs(snapshot);
      if (freshAgeMs !== null && freshAgeMs < this.freshInvalidGraceMs) {
        return this.deferFreshInvalidCapture(
          reason,
          freshAgeMs,
          'auth bond credential write still in flight',
          await this.liveCaptureSnapshot(run),
        );
      }
      const resultSnapshot = await this.liveCaptureSnapshot(run);
      this.lastCaptureAt = this.now().toISOString();
      this.lastCaptureReason = reason;
      this.lastCaptureError = `auth bond is ${snapshot.status}: ${snapshot.issues.join(',')}`;
      return {
        ok: false,
        snapshot: this.withCurrentBackup(resultSnapshot),
        captured: false,
        deferred: false,
        path: null,
        error: this.lastCaptureError,
      };
    }

    let tmp: string | null = null;
    /** Set while the copy sits in history/ under a name latest.json does not give yet. */
    let published: { readonly target: string; readonly staging: string } | null = null;
    try {
      forceEnsurePrivateDirectorySync(this.root, 'auth-bond backup root directory');
      forceEnsurePrivateDirectorySync(this.historyRoot, 'auth-bond backup history directory');
      forceEnsurePrivateDirectorySync(this.stagingRoot, 'auth-bond backup staging directory');
      await this.captureSteps(run, 'sweep', this.sweepOrphanedStagingSteps());

      const latest = readLatestManifest(this.latestManifestPath);
      const latestBackupPath = latest?.backupPath;
      if (
        latest?.treeHash === treeHash
        && latestBackupPath
        && this.backupPathProblem(latestBackupPath) === null
      ) {
        const resultSnapshot = await this.liveCaptureSnapshot(run);
        this.lastCaptureAt = this.now().toISOString();
        this.lastCaptureReason = reason;
        this.lastCaptureError = null;
        return {
          ok: true,
          snapshot: this.withCurrentBackup(resultSnapshot),
          captured: false,
          deferred: false,
          path: latestBackupPath,
          error: null,
        };
      }

      const createdAt = this.now();
      const dirName = `${isoForFileName(createdAt)}.${safeName(reason)}.${treeHash.slice(0, 16)}`;
      const target = join(this.historyRoot, dirName);
      tmp = join(this.stagingRoot, `${dirName}.tmp-${process.pid}`);
      rmSync(tmp, { recursive: true, force: true });
      mkdirSync(tmp, { recursive: true, mode: 0o700 });
      const copiedAuthDir = join(tmp, 'auth');
      await this.captureSteps(run, 'copy', copyPrivateTreeSteps(this.authDir, copiedAuthDir, { skipVanished: true }));
      const copiedAuthError = await this.captureSteps(
        run,
        'validate',
        validateCopiedAuthTreeSteps(copiedAuthDir, snapshot),
      );
      if (copiedAuthError) throw new Error(copiedAuthError);

      // The publish turn. Nothing from here to the latest.json write yields, so
      // the abort and block checks below still hold at the rename.
      const publishStartedAtMs = this.monotonicNow();
      this.throwIfCaptureWoken(run);
      const blockedAtPublish = this.captureBlockReason();
      if (blockedAtPublish) {
        await this.captureSteps(run, 'sweep', removeTreeSteps(tmp));
        tmp = null;
        return this.blockedCaptureResult(reason, blockedAtPublish, await this.liveCaptureSnapshot(run));
      }
      const manifest = {
        instanceName: this.instanceName,
        reason,
        createdAt: createdAt.toISOString(),
        authDir: this.authDir,
        treeHash: snapshot.treeHash,
        credsHash: snapshot.creds.sha256,
        meHash: snapshot.meHash,
      };
      writePrivateJson(join(tmp, 'manifest.json'), manifest);
      renameSync(tmp, target);
      published = { target, staging: tmp };
      tmp = null;

      writePrivateJson(this.latestManifestPath, {
        backupPath: target,
        createdAt: createdAt.toISOString(),
        reason,
        treeHash: snapshot.treeHash,
      });
      published = null;

      this.lastCaptureAt = createdAt.toISOString();
      this.lastCaptureReason = reason;
      this.lastCaptureError = null;
      run.phaseMs.publish += this.monotonicNow() - publishStartedAtMs;

      // Published. An abort from here on only cuts the tidy-up short, so the
      // run still settles as captured; a prune error stays a failure (below).
      try {
        await this.captureSteps(run, 'prune', this.pruneHistorySteps(snapshot.fileCount));
        const resultSnapshot = await this.liveCaptureSnapshot(run);
        return { ok: true, snapshot: resultSnapshot, captured: true, deferred: false, path: target, error: null };
      } catch (err) {
        if (!(err instanceof CaptureAbortedError)) throw err;
        return {
          ok: true,
          snapshot: this.withCurrentBackup(snapshot),
          captured: true,
          deferred: false,
          path: target,
          error: null,
        };
      }
    } catch (err) {
      if (err instanceof CaptureAbortedError) {
        if (err.abortCause === 'auth-restore' && tmp) {
          // Restore owns the live tree now. Remove this run's staging copy,
          // still in slices: re-arm the wake so the cleanup hands the loop
          // back, and a shutdown during it still stops it.
          this.rearmCaptureWake(run);
          await this.captureSteps(run, 'sweep', removeTreeSteps(tmp));
        }
        throw err;
      }
      if (published) {
        // Renamed into history/, but latest.json does not name it. One rename
        // takes it back to its staging name before any of it is removed, so
        // history/ never holds a half-removed entry; the removal below then
        // runs in slices. If the process dies first, the staging name carries
        // this PID, and another process's sweep removes it.
        renameSync(published.target, published.staging);
        tmp = published.staging;
        published = null;
      }
      if (tmp) await this.captureSteps(run, 'sweep', removeTreeSteps(tmp));
      const freshSnapshot = await this.liveCaptureSnapshot(run);
      const captureError = errorMessage(err);
      if (this.isValidSameIdentityTreeChangeDuringCopy(captureError, snapshot, freshSnapshot)) {
        return this.deferValidSameIdentityTreeChangeCapture(reason, freshSnapshot);
      }
      if (this.incompleteTreeReads.has(freshSnapshot)) {
        // The fresh read lost an entry too, so whether the tree changed with
        // the same identity cannot be told. An incomplete read defers.
        return this.incompleteReadCaptureResult(run, await this.liveCaptureSnapshot(run));
      }
      const freshAgeMs = this.freshInvalidCredentialAgeMs(freshSnapshot);
      if (freshAgeMs !== null && freshAgeMs < this.freshInvalidGraceMs) {
        return this.deferFreshInvalidCapture(
          reason,
          freshAgeMs,
          'auth bond changed during capture',
          await this.liveCaptureSnapshot(run),
        );
      }
      const resultSnapshot = await this.liveCaptureSnapshot(run);
      this.lastCaptureAt = this.now().toISOString();
      this.lastCaptureReason = reason;
      this.lastCaptureError = captureError;
      return {
        ok: false,
        snapshot: this.withCurrentBackup(resultSnapshot),
        captured: false,
        deferred: false,
        path: null,
        error: this.lastCaptureError,
      };
    }
  }

  private isValidSameIdentityTreeChangeDuringCopy(
    captureError: string,
    original: AuthBondSnapshot,
    fresh: AuthBondSnapshot,
  ): boolean {
    const sameIdentityTreeChange = original.status === 'present'
      && original.treeHash !== null
      && original.meHash !== null
      && fresh.status === 'present'
      && fresh.treeHash !== null
      && fresh.meHash !== null
      && fresh.meHash === original.meHash
      && fresh.treeHash !== original.treeHash;
    if (!sameIdentityTreeChange) return false;
    if (captureError === 'copied auth tree hash mismatch') return true;
    return captureError === 'copied creds.json hash mismatch'
      && original.creds.sha256 !== null
      && fresh.creds.sha256 !== null
      && fresh.creds.sha256 !== original.creds.sha256;
  }

  private deferValidSameIdentityTreeChangeCapture(
    reason: string,
    snapshot: AuthBondSnapshot,
  ): AuthBondCaptureResult {
    this.lastCaptureDeferredAt = this.now().toISOString();
    this.lastCaptureDeferredReason = reason;
    this.lastCaptureDeferredAgeMs = null;
    return {
      ok: false,
      // The backup half re-read after the deferral fields above changed, as
      // every other deferral does, so a record built from this result is current.
      snapshot: this.withCurrentBackup(snapshot),
      captured: false,
      deferred: true,
      path: null,
      error: 'auth bond auth tree changed during capture with the same identity',
    };
  }

  /**
   * A 'present' read that lost an entry between the walk's listing and its
   * read, so it has no tree hash and describes no tree state.
   *
   * Deferred like a transient read: no alert, no latch, and not written to
   * `lastCaptureError`; the deferral fields record it, and connection.ts
   * re-arms the settled snapshot. The bound: once INCOMPLETE_READ_DEFERRED_RUNS
   * runs in a row have ended this way, the next run that would end this way
   * fails instead, and connection.ts pages it as main paged an incomplete read.
   * Only a run's final attempt can fail on the bound, so a retry that reads the
   * tree completely still captures.
   */
  private incompleteReadCaptureResult(run: CaptureRun, resultSnapshot: AuthBondSnapshot): AuthBondCaptureResult {
    const finalAttempt = run.attempts >= this.captureAttempts;
    if (finalAttempt && this.consecutiveIncompleteReadRuns >= INCOMPLETE_READ_DEFERRED_RUNS) {
      this.lastCaptureAt = this.now().toISOString();
      this.lastCaptureReason = run.reason;
      this.lastCaptureError = INCOMPLETE_READ_BOUND_FAILURE;
      return {
        ok: false,
        snapshot: this.withCurrentBackup(resultSnapshot),
        captured: false,
        deferred: false,
        path: null,
        error: this.lastCaptureError,
      };
    }
    run.incompleteRead = true;
    this.lastCaptureDeferredAt = this.now().toISOString();
    this.lastCaptureDeferredReason = run.reason;
    this.lastCaptureDeferredAgeMs = null;
    return {
      ok: false,
      snapshot: this.withCurrentBackup(resultSnapshot),
      captured: false,
      deferred: true,
      path: null,
      error: INCOMPLETE_READ_DEFERRAL,
    };
  }

  private freshInvalidCredentialAgeMs(snapshot: AuthBondSnapshot): number | null {
    if (snapshot.status === 'present') return null;
    if (!snapshot.creds.exists || !snapshot.creds.mtime) return null;
    if (!snapshot.issues.some(issue => issue === 'creds_json_empty' || issue === 'creds_json_invalid_json')) {
      return null;
    }
    const mtime = Date.parse(snapshot.creds.mtime);
    if (!Number.isFinite(mtime)) return null;
    return Math.max(0, this.now().getTime() - mtime);
  }

  private deferFreshInvalidCapture(
    reason: string,
    ageMs: number,
    message: string,
    resultSnapshot: AuthBondSnapshot,
  ): AuthBondCaptureResult {
    this.lastCaptureDeferredAt = this.now().toISOString();
    this.lastCaptureDeferredReason = reason;
    this.lastCaptureDeferredAgeMs = ageMs;
    return {
      ok: false,
      snapshot: this.withCurrentBackup(resultSnapshot),
      captured: false,
      deferred: true,
      path: null,
      error: `${message}: age_ms=${ageMs}`,
    };
  }

  /**
   * Withhold a capture whose credential could not be read to a verdict.
   *
   * Disclosed through the SAME deferral fields as the fresh-write grace, and
   * deliberately not through `lastCaptureError`: that field is what the failure
   * branch writes and what the health surface reads back, so writing it here
   * would report a withheld attempt as a capture that failed.
   *
   * No age is recorded. The fresh-write grace has one — the credential's mtime
   * — and a transient read has none that means the same thing. The streak age
   * belongs to the read, not to this attempt, and reporting it in a field named
   * for the grace would invite the two to be compared.
   */
  private deferTransientCapture(
    reason: string,
    snapshot: AuthBondSnapshot,
    resultSnapshot: AuthBondSnapshot,
  ): AuthBondCaptureResult {
    this.lastCaptureDeferredAt = this.now().toISOString();
    this.lastCaptureDeferredReason = reason;
    this.lastCaptureDeferredAgeMs = null;
    return {
      ok: false,
      snapshot: this.withCurrentBackup(resultSnapshot),
      captured: false,
      deferred: true,
      path: null,
      error: `auth bond read was transient; capture withheld pending a definite read: ${transientAuthReadIssue(snapshot.issues) ?? 'unknown'}`,
    };
  }

  restoreLatestIfNeeded(): AuthBondRestoreResult {
    const before = this.inspect();
    if (before.status === 'present') {
      return { attempted: false, restored: false, source: null, snapshot: before, error: null };
    }
    // A transient read is not grounds for a destructive repair.
    //
    // Everything below renames the live auth root away and replaces it from a
    // backup. Its only precondition is a non-'present' status, and an
    // EAGAIN/EWOULDBLOCK on a nonblocking open produces exactly that while
    // saying nothing whatever about the credential — it says "not now". Firing
    // the restore on it destroys a healthy tree because one open returned
    // early.
    //
    // Withheld on ANY transient issue, not only on a snapshot whose transient
    // issue is the sole reason. A pass that could not establish the credential
    // has not earned a definite verdict about it, and the correct answer to
    // "I could not look" is to look again. The cost is at most one poll of
    // delay before a genuine fault reaches the restore, and delay is the safe
    // direction for a destructive path.
    if (hasTransientAuthReadIssue(before.issues)) {
      // Withheld until the NEXT CONNECT ATTEMPT produces a definite read.
      //
      // Nothing on the /health path can lift this. A health request re-reads
      // the credential live through inspectCached(), so it does produce a
      // definite read — but it never calls this method, and no other path in
      // this module re-establishes a credential. The connect path is the only
      // caller, which is why `deferred` is reported: connection.ts aborts the
      // activation and schedules a retry under the reconnect policy, so "the
      // next connect attempt" is something this process arranges rather than
      // waits for.
      //
      // No tree walk is armed here: restoreLatestIfNeeded reads through
      // inspect() (the live path), which never consults the cached tree, so
      // a tree walk cannot re-establish the credential and would only defer
      // reader-driven walks in the meantime. The failure streak stays clean
      // deliberately — noteRefreshNeedsRetry() is for tree walks, and a
      // credential read fault is not a walk fault.
      return {
        attempted: false,
        restored: false,
        source: null,
        snapshot: before,
        deferred: true,
        error: 'auth bond read was transient; restore withheld pending a definite read',
      };
    }
    if (!this.autoRestore) {
      return { attempted: false, restored: false, source: null, snapshot: before, error: 'auto-restore disabled' };
    }

    const latest = readLatestManifest(this.latestManifestPath);
    const latestBackupPath = latest?.backupPath ?? null;
    const source = latestBackupPath ? join(latestBackupPath, 'auth') : null;
    if (latestBackupPath) {
      const latestProblem = this.backupPathProblem(latestBackupPath);
      if (latestProblem) {
        this.lastRestoreAt = this.now().toISOString();
        this.lastRestoreSource = latestBackupPath;
        this.lastRestoreError = latestProblem;
        return {
          attempted: true,
          restored: false,
          source: latestBackupPath,
          snapshot: this.inspect(),
          error: latestProblem,
        };
      }
    }
    if (!source || !existsSync(source)) {
      const error = 'no auth-bond backup available';
      this.lastRestoreAt = this.now().toISOString();
      this.lastRestoreSource = null;
      this.lastRestoreError = error;
      return { attempted: true, restored: false, source: null, snapshot: this.inspect(), error };
    }
    const backupError = this.validateBackupForRestore(latestBackupPath!, latest);
    if (backupError) {
      this.lastRestoreAt = this.now().toISOString();
      this.lastRestoreSource = latestBackupPath;
      this.lastRestoreError = backupError;
      return {
        attempted: true,
        restored: false,
        source: latestBackupPath,
        snapshot: this.inspect(),
        error: backupError,
      };
    }

    // Terminal-latch gate: while a terminal revocation latch is active, restore
    // authority comes only from the CANDIDATE's own manifest + V2 generation
    // receipt (exact digest binding). Unbound legacy backups, the exact revoked
    // tree, and corrupt/ambiguous state all refuse — before any mutation.
    const latchState = readTerminalLatchJournal(this.stateRoot);
    const latchDecision = decideRestoreFromCandidate(
      latchState,
      readRestoreCandidateEvidence(latestBackupPath!),
    );
    if (!latchDecision.allow) {
      const error = `terminal_latch_refused:${latchDecision.refusal}`;
      this.lastRestoreAt = this.now().toISOString();
      this.lastRestoreSource = latestBackupPath;
      this.lastRestoreError = error;
      return {
        attempted: true,
        restored: false,
        source: latestBackupPath,
        snapshot: this.inspect(),
        error,
      };
    }

    // Nothing above writes the live tree except inspect's mode repair. Before
    // the first write, stop an in-flight capture: it must not read the live
    // root again once the root is renamed away. A restore that declines above
    // leaves the capture running.
    this.abortActiveCapture('auth-restore');
    forceEnsurePrivateDirectorySync(this.root, 'auth-bond backup root directory');
    const restoredAt = this.now();
    const quarantineRoot = join(this.root, 'quarantine');
    forceEnsurePrivateDirectorySync(quarantineRoot, 'auth-bond quarantine directory');
    const quarantine = join(
      quarantineRoot,
      `${isoForFileName(restoredAt)}.${safeName(basename(this.authDir))}.broken`,
    );
    const tmp = `${this.authDir}.restore-${process.pid}`;
    let movedOriginal = false;

    try {
      rmSync(tmp, { recursive: true, force: true });
      if (existsSync(this.authDir)) {
        // The auth root is about to be replaced. Fence the generation BEFORE
        // the first rename so a refresh already walking the old tree cannot
        // publish its result as a description of the new one. Fence only, no
        // walk: the rename on the next line would move the root out from
        // under it.
        this.markTreeStale('auth-restore-started');
        renameSync(this.authDir, quarantine);
        movedOriginal = true;
      } else {
        forceEnsurePrivateDirectorySync(dirname(this.authDir), 'auth parent directory');
      }
      // Strict: a backup entry that vanishes mid-copy throws, and the catch below rolls back.
      copyPrivateTree(source, tmp);
      const copiedAuthError = this.validateAuthTreeAgainstBackupManifest(tmp, latestBackupPath!, latest, 'copied');
      if (copiedAuthError) throw new Error(copiedAuthError);
      renameSync(tmp, this.authDir);
      this.invalidateTreeCache('auth-restore-committed');
      this.lastRestoreAt = restoredAt.toISOString();
      this.lastRestoreSource = latestBackupPath;
      this.lastRestoreError = null;
      return {
        attempted: true,
        restored: true,
        source: latestBackupPath,
        snapshot: this.inspect(),
        error: null,
      };
    } catch (err) {
      rmSync(tmp, { recursive: true, force: true });
      if (movedOriginal && !existsSync(this.authDir)) {
        try {
          renameSync(quarantine, this.authDir);
        } catch {
          // Preserve the original failure; the alert evidence includes the quarantine path.
        }
      }
      // The start of this attempt called markTreeStale('auth-restore-started'),
      // which cancelled any successor armed against the previous streak and
      // scheduled none of its own. Reaching this catch leaves treeInvalidated
      // true with no walk in flight and no timer queued, so nothing would
      // converge until a later reader arrived — precisely the property
      // invalidateTreeCache's contract removes. Re-enter the normal
      // convergence path so a walk lands under the failure back-off.
      this.invalidateTreeCache('auth-restore-failed');
      const error = errorMessage(err);
      this.lastRestoreAt = restoredAt.toISOString();
      this.lastRestoreSource = latestBackupPath;
      this.lastRestoreError = `${error}; quarantine=${quarantine}`;
      return {
        attempted: true,
        restored: false,
        source: latestBackupPath,
        snapshot: this.inspect(),
        error: this.lastRestoreError,
      };
    }
  }

  private backupSnapshot(): AuthBondBackupSnapshot {
    const latest = readLatestManifest(this.latestManifestPath);
    const latestPath = latest?.backupPath && this.backupPathProblem(latest.backupPath) === null ? latest.backupPath : null;
    return this.backupHalf(latestPath, latest);
  }

  /** The backup half from a latest.json already read, or from none. Reads nothing itself. */
  private backupHalf(latestPath: string | null, latest: LatestManifest | null): AuthBondBackupSnapshot {
    return {
      root: this.root,
      latest: latestPath,
      latestAt: latest?.createdAt ?? null,
      latestReason: latest?.reason ?? null,
      latestTreeHash: latest?.treeHash ?? null,
      lastCaptureAt: this.lastCaptureAt,
      lastCaptureReason: this.lastCaptureReason,
      lastCaptureError: this.lastCaptureError,
      lastCaptureDeferredAt: this.lastCaptureDeferredAt,
      lastCaptureDeferredReason: this.lastCaptureDeferredReason,
      lastCaptureDeferredAgeMs: this.lastCaptureDeferredAgeMs,
      lastRestoreAt: this.lastRestoreAt,
      lastRestoreSource: this.lastRestoreSource,
      lastRestoreError: this.lastRestoreError,
      lastSweepError: this.lastSweepError,
    };
  }

  private validateBackupForRestore(backupPath: string, latest: LatestManifest | null): string | null {
    const pathProblem = this.backupPathProblem(backupPath);
    if (pathProblem) return pathProblem;
    return this.validateAuthTreeAgainstBackupManifest(join(backupPath, 'auth'), backupPath, latest, 'backup');
  }

  private validateAuthTreeAgainstBackupManifest(
    authDir: string,
    backupPath: string,
    latest: LatestManifest | null,
    prefix: string,
  ): string | null {
    const manifestPath = join(backupPath, 'manifest.json');
    let manifest: BackupManifest;
    try {
      const parsed = readJsonOrThrow(manifestPath);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return `backup manifest is not an object: ${manifestPath}`;
      }
      manifest = parsed as BackupManifest;
    } catch (err) {
      return `backup manifest is unreadable: ${manifestPath}: ${errorMessage(err)}`;
    }

    if (manifest.instanceName && safeName(manifest.instanceName) !== this.instanceName) {
      return `backup instance mismatch: manifest=${safeName(manifest.instanceName)} expected=${this.instanceName}`;
    }
    if (latest?.treeHash && manifest.treeHash && latest.treeHash !== manifest.treeHash) {
      return 'latest pointer tree hash does not match backup manifest';
    }

    return authTreeValidationError(authDir, {
      credsHash: manifest.credsHash,
      meHash: manifest.meHash,
      treeHash: manifest.treeHash,
    }, prefix);
  }

  private backupPathProblem(backupPath: string): string | null {
    if (!pathIsInside(this.historyRoot, backupPath)) {
      return `backup path escapes history root: ${backupPath}`;
    }
    try {
      const st = lstatSync(backupPath);
      if (st.isSymbolicLink()) return `backup path is a symlink: ${backupPath}`;
      if (!st.isDirectory()) return `backup path is not a directory: ${backupPath}`;
    } catch (err) {
      return `backup path is unreadable: ${backupPath}: ${errorMessage(err)}`;
    }
    return null;
  }

  /**
   * Remove orphaned staging temp dirs (`<name>.tmp-<pid>`) left behind when a
   * process is SIGKILLed mid-capture. Staging only ever holds in-progress temp
   * copies — never the published backups (those live under historyRoot/latest) —
   * so deleting a dead process's leftovers is always safe and prevents
   * credential-bearing residue from accumulating on disk (#1076/#1078).
   * The current process's own in-flight staging (`.tmp-<our pid>`) is preserved.
   */
  private *sweepOrphanedStagingSteps(): AuthTreeSteps<void> {
    if (!existsSync(this.stagingRoot)) return;
    let entries: string[];
    try {
      entries = readdirSync(this.stagingRoot);
    } catch (err) {
      // Record the sweep failure so it surfaces in the backup snapshot /
      // health status instead of silently abandoning staging cleanup (#2289 M4).
      // Every subsequent capture deposits another credential-tree copy under
      // staging/ if the sweep never runs, so this must be visible to operators.
      this.lastSweepError = `staging sweep failed: ${err instanceof Error ? err.message : String(err)}`;
      return;
    }
    this.lastSweepError = null;
    const ownSuffix = `.tmp-${process.pid}`;
    for (const name of entries) {
      if (!isHistoryStagingDirName(name) || name.endsWith(ownSuffix)) continue;
      yield* removeTreeSteps(join(this.stagingRoot, name));
    }
  }

  private *pruneHistorySteps(snapshotFileCount: number | null): AuthTreeSteps<void> {
    if (this.keepBackups <= 0 || !existsSync(this.historyRoot)) return;
    const fileBound = snapshotFileCount && snapshotFileCount > 0
      ? Math.max(2, Math.floor(this.maxHistoryFiles / snapshotFileCount))
      : this.keepBackups;
    const retainedBackups = Math.min(this.keepBackups, fileBound);
    // One readdirSync and one sort: the named unsliced chunks. Each entry's
    // lstat is a walk entry, in the same order as before.
    const names = readdirSync(this.historyRoot).filter(name => !isHistoryStagingDirName(name));
    const entries: string[] = [];
    for (const name of names) {
      yield WALK_ENTRY_UNITS;
      const path = join(this.historyRoot, name);
      if (isHistoryEntryDir(path)) entries.push(path);
    }
    entries.sort().reverse();
    for (const stale of entries.slice(retainedBackups)) {
      yield* removeTreeSteps(stale);
    }
  }
}
