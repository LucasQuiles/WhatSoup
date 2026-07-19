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
 * Lane artifacts: oc-re/audits/2026-07-19-c5-restart-loop-guard-map.md,
 * oc-re/specs/2026-07-19-c5-restart-loop-guard-spec.md.
 */
import { join } from 'node:path';
import { readPrivateFileSync, writePrivateJsonMarkerSync } from '../../lib/private-fs.ts';
import { createChildLogger } from '../../logger.ts';

const log = createChildLogger('restart-loop-guard');

/** Defaults trip the app breaker strictly BEFORE systemd's 10-per-300s wedge:
 *  the 3rd crashy boot inside 5 minutes suppresses resume, while a legitimate
 *  operator restart (or two) never trips it. */
export const RESTART_LOOP_GUARD_DEFAULTS = { maxRestarts: 3, windowMs: 300_000 } as const;

export const RESTART_LOOP_GUARD_FILENAME = 'restart-loop-guard.json';

const MAX_STATE_BYTES = 64 * 1024;

interface RestartLoopGuardState {
  v: 1;
  /** true while a boot has not yet reached a clean exit (crash marker). */
  bootInProgress: boolean;
  /** epoch-ms of recent crashy boots, pruned to the window on every write. */
  boots: number[];
  /** epoch-ms of the most recent trip (surfaced in health; survives clean exits). */
  lastTripAt: number | null;
}

export interface RestartLoopGuardTrip {
  tripped: boolean;
  bootsInWindow: number;
}

export interface RestartLoopGuardHealth extends RestartLoopGuardTrip {
  lastTripAt: number | null;
}

/** Canonical state-file location inside an instance state root. */
export function restartLoopGuardPath(stateRoot: string): string {
  return join(stateRoot, RESTART_LOOP_GUARD_FILENAME);
}

function freshState(): RestartLoopGuardState {
  return { v: 1, bootInProgress: false, boots: [], lastTripAt: null };
}

/** Fail-open load: ANY problem (missing, corrupt, wrong shape, fs error) → null. */
function loadState(statePath: string): RestartLoopGuardState | null {
  try {
    const raw = readPrivateFileSync(statePath, { maxBytes: MAX_STATE_BYTES, label: 'restart-loop guard state' });
    if (raw === null) return null;
    const data = JSON.parse(raw) as Partial<RestartLoopGuardState>;
    if (data?.v !== 1 || typeof data.bootInProgress !== 'boolean' || !Array.isArray(data.boots)) return null;
    return {
      v: 1,
      bootInProgress: data.bootInProgress,
      boots: data.boots.filter((t): t is number => typeof t === 'number' && Number.isFinite(t)),
      lastTripAt: typeof data.lastTripAt === 'number' && Number.isFinite(data.lastTripAt) ? data.lastTripAt : null,
    };
  } catch (err) {
    log.warn({ err, statePath }, 'restart-loop guard: state unreadable — failing open');
    return null;
  }
}

/** Fail-open save: returns false instead of throwing on any fs error. */
function saveState(statePath: string, state: RestartLoopGuardState): boolean {
  try {
    writePrivateJsonMarkerSync(statePath, state);
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
export function markBootInProgress(statePath: string, now = Date.now()): boolean {
  const prior = loadState(statePath);
  const wasInterrupted = prior?.bootInProgress === true;
  const state = prior ?? freshState();
  state.bootInProgress = true;
  // Prune opportunistically so the file cannot grow unbounded across crashes.
  const cutoff = now - RESTART_LOOP_GUARD_DEFAULTS.windowMs;
  state.boots = state.boots.filter((t) => t >= cutoff);
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
  const state = loadState(statePath);
  if (state === null) return;
  state.bootInProgress = false;
  state.boots = [];
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
  const now = options.now ?? Date.now();
  if (maxRestarts <= 0) return { tripped: false, bootsInWindow: 0 };

  const state = loadState(options.statePath) ?? freshState();
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
  now: number = Date.now(),
): RestartLoopGuardHealth {
  const state = loadState(statePath);
  if (state === null) return { bootsInWindow: 0, tripped: false, lastTripAt: null };
  const cutoff = now - Math.max(1, windowMs);
  const bootsInWindow = state.boots.filter((t) => t >= cutoff).length;
  return {
    bootsInWindow,
    tripped: bootsInWindow >= RESTART_LOOP_GUARD_DEFAULTS.maxRestarts,
    lastTripAt: state.lastTripAt,
  };
}
