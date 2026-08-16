/**
 * Restart-loop guard (C5) — resume-replay circuit breaker.
 *
 * Why this exists: the proactive-resume loop (runtime.ts startup gate,
 * `proactiveResumeOnStartup`) re-resumes every `active`/`suspended`
 * checkpoint on boot. A checkpoint only re-flips to 'active' when its first
 * post-resume turn FINALIZES (runtime-turn-coordinator.ts:455), so a process
 * crash inside the resume window leaves it 'suspended' — resumable — and the
 * next boot replays it again. systemd's StartLimit (10/300s,
 * deploy/whatsoup@.service:6-7) eventually wedges the WHOLE unit FAILED
 * (all chats dark); Docker/NoSystemd backends have no supervisor protection
 * at all. This guard is the app-level breaker: after enough crashy boots
 * inside a window, the startup gate skips proactive resume for that boot —
 * the instance stays up serving inbound traffic, sessions lazy-resume on
 * their next message (the existing fail-safe), and a human gets one notice.
 *
 * Reference shape: Hermes gateway restart_loop_guard.py (adoption candidate
 * C5; quarantine reference, static-read only). Same invariants:
 *  - state is a tiny persisted journal (each boot is a fresh process —
 *    in-memory state is useless)
 *  - only boots that follow an UNCLEAN exit with resumable work pending
 *    count; an operator stop/restart exits cleanly and never trips
 *  - FAIL OPEN on any persistence error — a broken breaker must never
 *    wedge a healthy instance
 *
 * Design/implementation lineage: PR #1929, PR #1969.
 */
import {
  privateJournalPath,
  readPrivateV1JournalSync,
  type PrivateJournalStatus,
  writePrivateJournalSync,
} from '../../lib/private-journal.ts';
import { systemClock } from '../../lib/clock.ts';
import { createChildLogger } from '../../logger.ts';

const log = createChildLogger('restart-loop-guard');

/** Defaults trip the app breaker strictly BEFORE systemd's 10-per-300s wedge:
 *  the 3rd crashy boot inside 5 minutes suppresses resume, while a legitimate
 *  operator restart (or two) never trips it. */
export const RESTART_LOOP_GUARD_DEFAULTS = { maxRestarts: 3, windowMs: 300_000 } as const;

/**
 * Clean-restart THRASH detector — a DETECT-AND-SURFACE signal, separate from the
 * resume-replay breaker above (which it must not disturb).
 *
 * The breaker only counts UNCLEAN (crash) boots and deliberately resets on a clean
 * exit — an operator/supervisor stop must never trip it. But an AUTOMATED supervisor
 * issuing rapid *clean* SIGTERMs (a watchdog `kickstart` loop) is indistinguishable
 * from a legitimate restart at the process level: every cycle runs markCleanExit,
 * which wipes `boots[]`, so the breaker reads `bootsInWindow: 0` and the thrash runs
 * INVISIBLE (observed live: ana-bot/mini1 ~69s clean-SIGTERM loop from a rogue
 * watchdog — ~1900 boots, breaker never tripped). The app cannot refuse an external
 * relaunch, so this does NOT trip anything: it maintains a separate `relaunches[]`
 * track that markCleanExit does NOT wipe, surfaced in health so the bot-errors
 * pipeline can page a clean-restart thrash loop instead of it running silent.
 *
 * Threshold chosen from real fleet cadences over a 1h window: ana-bot ~69s ⇒ ~52/h
 * (fires), rb-bot ~361s ⇒ ~10/h (fires), q ~50min ⇒ ~1/h (quiet), a normal
 * deploy/rollout bounce (a few restarts then quiet) ⇒ well under 8/h (quiet).
 */
export const RESTART_THRASH_DEFAULTS = { threshold: 8, windowMs: 3_600_000 } as const;

/** Hard cap on the persisted relaunch track — bounds file growth independent of the
 *  time prune (a backward clock jump can make the time cutoff a no-op). */
export const RELAUNCH_TRACK_HARD_CAP = 128;

export const RESTART_LOOP_GUARD_FILENAME = 'restart-loop-guard.json';

interface RestartLoopGuardState {
  v: 1;
  /** true while a boot has not yet reached a clean exit (crash marker). */
  bootInProgress: boolean;
  /** epoch-ms of recent crashy boots, pruned to the window on every write. */
  boots: number[];
  /** epoch-ms of the most recent trip (surfaced in health; survives clean exits). */
  lastTripAt: number | null;
  /**
   * Monotonic lifetime counters — NEVER pruned, NEVER reset on clean exit.
   * They make the guard readable by a DECISION it made rather than by silence:
   * `bootsInWindow: 0` alone cannot distinguish "no boots" from "the window
   * rolled past them", so a restart that landed can read as if it never
   * happened. These prove a restart landed at all (`bootsTotal`) and that the
   * breaker was actually consulted and decided (`checksPerformed`/`lastCheckAt`).
   */
  bootsTotal: number;
  checksPerformed: number;
  lastCheckAt: number | null;
  /**
   * epoch-ms of recent boots (clean OR crash), pruned to RESTART_THRASH_DEFAULTS.windowMs.
   * UNLIKE `boots`, markCleanExit does NOT clear this — that is the whole point: it makes
   * a clean-restart thrash loop (which resets `boots` every cycle) visible in health.
   */
  relaunches: number[];
}

export interface RestartLoopGuardTrip {
  tripped: boolean;
  bootsInWindow: number;
}

export interface RestartLoopGuardHealth extends RestartLoopGuardTrip {
  lastTripAt: number | null;
  /** The window `bootsInWindow` was computed over — without it a flat 0 is ambiguous. */
  windowMs: number;
  /** Monotonic: every boot (clean or crash) — proves a restart landed even after it ages out. */
  bootsTotal: number;
  /** Monotonic: crash-recovery decisions the breaker actually made — "asked N, allowed all N". */
  checksPerformed: number;
  lastCheckAt: number | null;
  /** Boots (clean OR crash) within the thrash window — visible even when `boots` reset on clean exit. */
  relaunchesInWindow: number;
  /** true when relaunchesInWindow >= thrash threshold: a rapid relaunch loop (external-supervisor thrash). */
  cleanRestartThrash: boolean;
  /** The window `relaunchesInWindow` was computed over (distinct from the resume-breaker `windowMs`). */
  thrashWindowMs: number;
}

/** Canonical state-file location inside an instance state root. */
export function restartLoopGuardPath(stateRoot: string): string {
  return privateJournalPath(stateRoot, RESTART_LOOP_GUARD_FILENAME);
}

function freshState(): RestartLoopGuardState {
  return { v: 1, bootInProgress: false, boots: [], lastTripAt: null, bootsTotal: 0, checksPerformed: 0, lastCheckAt: null, relaunches: [] };
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Normalize an already-validated in-memory counter. */
function counterField(value: unknown): number {
  return isNonNegativeFiniteNumber(value) ? value : 0;
}

/** Back-compat: counters added after v1 are allowed to be absent, but not malformed. */
function legacyCounterField(value: unknown): number | null {
  if (value === undefined) return 0;
  return isNonNegativeFiniteNumber(value) ? value : null;
}

/** A present timestamp must be null or finite; callers decide whether absence is valid. */
function nullableTimestampField(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseV1State(data: Record<string, unknown>): RestartLoopGuardState | null {
  if (
    typeof data.bootInProgress !== 'boolean'
    || !Array.isArray(data.boots)
    || !data.boots.every((t) => typeof t === 'number' && Number.isFinite(t))
  ) {
    return null;
  }
  const lastTripAt = nullableTimestampField(data.lastTripAt);
  const bootsTotal = legacyCounterField(data.bootsTotal);
  const checksPerformed = legacyCounterField(data.checksPerformed);
  const lastCheckAt = data.lastCheckAt === undefined ? null : nullableTimestampField(data.lastCheckAt);
  // Back-compat: every v:1 file written before the thrash track lacks `relaunches`.
  // Absent => [] (must NOT reject: that fails the guard open fleet-wide on the first
  // boot after deploy); present-but-malformed => reject (fail closed, like `boots`).
  let relaunches: number[] | null;
  if (data.relaunches === undefined) {
    relaunches = [];
  } else if (Array.isArray(data.relaunches) && data.relaunches.every((t) => typeof t === 'number' && Number.isFinite(t))) {
    relaunches = data.relaunches;
  } else {
    relaunches = null;
  }
  if (lastTripAt === undefined || bootsTotal === null || checksPerformed === null || lastCheckAt === undefined || relaunches === null) {
    return null;
  }
  return {
    v: 1,
    bootInProgress: data.bootInProgress,
    boots: data.boots,
    lastTripAt,
    // Back-compat: v:1 files written before observability counters existed
    // lack these fields — default them to 0/null rather than rejecting the state.
    bootsTotal,
    checksPerformed,
    lastCheckAt,
    relaunches,
  };
}

interface RestartLoopGuardLoadResult {
  status: PrivateJournalStatus;
  state: RestartLoopGuardState | null;
}

/** Fail-open load; unreadable sources remain untouched. */
function loadState(statePath: string): RestartLoopGuardLoadResult {
  const source = readPrivateV1JournalSync(statePath, 'restart-loop guard state');
  if (source.status === 'journal_unreadable') {
    log.warn({ statePath }, 'restart-loop guard: state unreadable — preserving source (fail-open)');
    return { status: 'journal_unreadable', state: null };
  }
  if (source.version === 'missing') return { status: 'available', state: null };
  const state = parseV1State(source.value);
  if (state === null) {
    log.warn({ statePath }, 'restart-loop guard: state malformed — preserving source (fail-open)');
    return { status: 'journal_unreadable', state: null };
  }
  return { status: 'available', state };
}

/** Fail-open save: returns false instead of throwing on any fs error. */
function saveState(statePath: string, state: RestartLoopGuardState): boolean {
  try {
    writePrivateJournalSync(statePath, state, 'restart-loop guard state');
    return true;
  } catch (err) {
    log.warn({ err, statePath }, 'restart-loop guard: state not persisted — failing open');
    return false;
  }
}

/**
 * Mark that this process has booted. Returns true when the PREVIOUS recorded
 * boot never reached a clean exit (i.e. this boot follows a crash / SIGKILL /
 * OOM). Call once, as early as the instance dataRoot is known. Best-effort:
 * persistence failure degrades to "not interrupted" (fail-open).
 */
export function markBootInProgress(statePath: string, now = systemClock.now()): boolean {
  const loaded = loadState(statePath);
  if (loaded.status === 'journal_unreadable') return false;
  const wasInterrupted = loaded.state?.bootInProgress === true;
  const state = loaded.state ?? freshState();
  state.bootInProgress = true;
  // Monotonic: count EVERY boot (clean or crash) so a restart is provably
  // visible in health even after it ages out of the window.
  state.bootsTotal = counterField(state.bootsTotal) + 1;
  // Prune opportunistically so the file cannot grow unbounded across crashes.
  const cutoff = now - RESTART_LOOP_GUARD_DEFAULTS.windowMs;
  state.boots = state.boots.filter((t) => t >= cutoff);
  // Clean-restart thrash track: record EVERY boot and prune to the thrash window.
  // markCleanExit intentionally leaves this intact, so a clean-SIGTERM thrash loop
  // (which resets `boots` each cycle) still accumulates here and surfaces in health.
  const thrashCutoff = now - RESTART_THRASH_DEFAULTS.windowMs;
  const relaunches = (state.relaunches ?? []).filter((t) => t >= thrashCutoff);
  relaunches.push(now);
  // Hard cap independent of the time prune (bounds growth on a backward clock jump).
  state.relaunches = relaunches.length > RELAUNCH_TRACK_HARD_CAP
    ? relaunches.slice(-RELAUNCH_TRACK_HARD_CAP)
    : relaunches;
  saveState(statePath, state);
  return wasInterrupted;
}

/**
 * Mark a graceful shutdown. Clears the crash marker AND the boots journal —
 * a clean exit means a human (or a deliberate supervisor stop) is back in
 * the loop, so the crash-cycle count restarts. lastTripAt is retained for
 * health surfacing. No-op on any error.
 */
export function markCleanExit(statePath: string): void {
  const loaded = loadState(statePath);
  if (loaded.status === 'journal_unreadable' || loaded.state === null) return;
  const { state } = loaded;
  state.bootInProgress = false;
  state.boots = [];
  // state.relaunches is deliberately NOT cleared: it must survive clean exits so a
  // clean-restart thrash loop (every cycle of which runs THIS function) stays visible.
  saveState(statePath, state);
}

/**
 * Record one crashy boot (call only when markBootInProgress reported an
 * unclean previous exit AND resumable checkpoints exist) and report whether
 * the loop is now tripped. Tripped ⇒ the startup gate should SKIP proactive
 * resume for this boot. Fail-open: any problem ⇒ {tripped:false}.
 */
export function checkAndRecordInterruptedBoot(options: {
  statePath: string;
  maxRestarts?: number;
  windowMs?: number;
  now?: number;
}): RestartLoopGuardTrip {
  const maxRestarts = options.maxRestarts ?? RESTART_LOOP_GUARD_DEFAULTS.maxRestarts;
  const windowMs = options.windowMs ?? RESTART_LOOP_GUARD_DEFAULTS.windowMs;
  const now = options.now ?? systemClock.now();
  if (maxRestarts <= 0) return { tripped: false, bootsInWindow: 0 };

  const loaded = loadState(options.statePath);
  if (loaded.status === 'journal_unreadable') return { tripped: false, bootsInWindow: 0 };
  const state = loaded.state ?? freshState();
  // Monotonic: this IS the breaker's decision point (reached only on a
  // crash-interrupted boot with resumable work). Counting it turns health from
  // "nothing bad happened" into "asked N times, allowed all but the trips".
  state.checksPerformed = counterField(state.checksPerformed) + 1;
  state.lastCheckAt = now;
  const cutoff = now - Math.max(1, windowMs);
  state.boots = state.boots.filter((t) => t >= cutoff);
  state.boots.push(now);
  const tripped = state.boots.length >= maxRestarts;
  if (tripped) state.lastTripAt = now;
  if (!saveState(options.statePath, state)) {
    // The record did not land — report zeros rather than an in-memory count
    // of state that was never journaled (fail-open AND honest: a breaker
    // that cannot persist must never claim trips it cannot prove).
    return { tripped: false, bootsInWindow: 0 };
  }
  if (tripped) {
    log.warn(
      { bootsInWindow: state.boots.length, maxRestarts, windowMs, statePath: options.statePath },
      'restart-loop guard TRIPPED — suppressing proactive resume for this boot',
    );
  }
  return { tripped, bootsInWindow: state.boots.length };
}

/**
 * Read-only health introspection for the runtime health snapshot. Fail-open:
 * any problem ⇒ zeros. Never mutates state.
 */
export function readRestartLoopGuardHealth(
  statePath: string,
  windowMs: number = RESTART_LOOP_GUARD_DEFAULTS.windowMs,
  now: number = systemClock.now(),
): RestartLoopGuardHealth {
  const loaded = loadState(statePath);
  if (loaded.status === 'journal_unreadable' || loaded.state === null) {
    return {
      bootsInWindow: 0, tripped: false, lastTripAt: null, windowMs,
      bootsTotal: 0, checksPerformed: 0, lastCheckAt: null,
      relaunchesInWindow: 0, cleanRestartThrash: false, thrashWindowMs: RESTART_THRASH_DEFAULTS.windowMs,
    };
  }
  const { state } = loaded;
  const cutoff = now - Math.max(1, windowMs);
  const bootsInWindow = state.boots.filter((t) => t >= cutoff).length;
  // Thrash detection uses its OWN (constant) window — matching markBootInProgress's
  // prune — so the surfaced count never diverges from the persisted track.
  const thrashCutoff = now - Math.max(1, RESTART_THRASH_DEFAULTS.windowMs);
  const relaunchesInWindow = (state.relaunches ?? []).filter((t) => t >= thrashCutoff).length;
  return {
    bootsInWindow,
    tripped: bootsInWindow >= RESTART_LOOP_GUARD_DEFAULTS.maxRestarts,
    lastTripAt: state.lastTripAt,
    windowMs,
    bootsTotal: counterField(state.bootsTotal),
    checksPerformed: counterField(state.checksPerformed),
    lastCheckAt: typeof state.lastCheckAt === 'number' && Number.isFinite(state.lastCheckAt) ? state.lastCheckAt : null,
    relaunchesInWindow,
    cleanRestartThrash: relaunchesInWindow >= RESTART_THRASH_DEFAULTS.threshold,
    thrashWindowMs: RESTART_THRASH_DEFAULTS.windowMs,
  };
}
