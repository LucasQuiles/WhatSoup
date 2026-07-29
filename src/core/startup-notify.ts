/**
 * Startup-notification stability journal.
 *
 * Why this exists: the "*Agent back online* ✓" notice used to be a bare
 * trigger fired 3 s after every boot — five consecutive pings reached a real
 * user in 79 minutes during host maintenance (mini11, 2026-07-29), and the
 * config keys that looked like protection (`startupNotificationDedupe`,
 * `startupNotificationCooldownSeconds`) were never consumed by anything.
 * A cooldown cannot work here anyway: each boot is a fresh process, so any
 * suppression state must live on disk (the restart-loop-guard precedent —
 * same journal idiom, same fail-open philosophy).
 *
 * Contract:
 *  - every boot is recorded in a tiny persisted journal;
 *  - the notification is sent only after the instance has stayed up (and
 *    connected — enforced by the caller) for a stability window;
 *  - one message covers EVERY boot since the last notification: a single
 *    boot keeps the classic copy, a flap/maintenance burst becomes one
 *    intentional summary with the restart count and time range;
 *  - all persistence errors fail open — a broken journal must never block
 *    the boot or the notification.
 */
import { join } from 'node:path';
import { readPrivateFileSync, writePrivateJsonMarkerSync } from '../lib/private-fs.ts';
import { createChildLogger } from '../logger.ts';

const log = createChildLogger('startup-notify');

export const STARTUP_NOTIFY_FILENAME = 'startup-notify.json';

/** Boots older than this never matter to a "back online" summary. */
const BOOT_RETENTION_MS = 24 * 60 * 60 * 1_000;
/** Hard cap so a pathological crash loop cannot grow the journal unbounded. */
const MAX_BOOTS = 100;
const MAX_STATE_BYTES = 64 * 1024;

export interface StartupNotifyState {
  v: 1;
  /** epoch-ms of recent boots, pruned to retention on every write. */
  boots: number[];
  /** epoch-ms of the last successfully composed-and-marked notification. */
  lastNotifiedAt: number | null;
}

export interface StartupNotification {
  text: string;
  /** How many un-notified boots this message covers. */
  bootsCovered: number;
}

export function startupNotifyPath(stateRoot: string): string {
  return join(stateRoot, STARTUP_NOTIFY_FILENAME);
}

function freshState(): StartupNotifyState {
  return { v: 1, boots: [], lastNotifiedAt: null };
}

function loadState(statePath: string): StartupNotifyState {
  try {
    const raw = readPrivateFileSync(statePath, { maxBytes: MAX_STATE_BYTES, label: 'startup-notify journal' });
    if (raw === null) return freshState();
    const data = JSON.parse(raw) as Partial<StartupNotifyState>;
    return {
      v: 1,
      boots: Array.isArray(data.boots)
        ? data.boots.filter((b): b is number => typeof b === 'number' && Number.isFinite(b))
        : [],
      lastNotifiedAt: typeof data.lastNotifiedAt === 'number' ? data.lastNotifiedAt : null,
    };
  } catch (err) {
    log.warn({ err, statePath }, 'startup-notify: journal unreadable — starting fresh (fail-open)');
    return freshState();
  }
}

function persist(statePath: string, state: StartupNotifyState): void {
  try {
    writePrivateJsonMarkerSync(statePath, state);
  } catch (err) {
    log.warn({ err, statePath }, 'startup-notify: journal not persisted — continuing (fail-open)');
  }
}

/** Record this process's boot; prune to retention; persist. Never throws. */
export function recordStartupBoot(statePath: string, now: number): StartupNotifyState {
  const state = loadState(statePath);
  state.boots = [...state.boots.filter((b) => now - b < BOOT_RETENTION_MS), now].slice(-MAX_BOOTS);
  persist(statePath, state);
  return state;
}

const defaultLocalHm = (ms: number): string =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

/**
 * Compose the message covering every boot since the last notification.
 * One boot → the classic copy; several → one intentional summary that keeps
 * the user informed instead of pinging once per recovery.
 */
export function composeStartupNotification(
  state: StartupNotifyState,
  now: number,
  formatTime: (ms: number) => string = defaultLocalHm,
): StartupNotification {
  const since = state.lastNotifiedAt ?? 0;
  const covered = state.boots.filter((b) => b > since);
  if (covered.length <= 1) {
    return { text: '*Agent back online* ✓', bootsCovered: covered.length };
  }
  const first = formatTime(covered[0]);
  const last = formatTime(covered[covered.length - 1]);
  return {
    text: `*Agent back online* ✓ — stable now after ${covered.length} restarts (${first}–${last}).`,
    bootsCovered: covered.length,
  };
}

/** Mark boots-through-now as notified. Persisted BEFORE the send so a crash
 *  mid-send loses at most one summary and can never duplicate it. Never throws. */
export function markStartupNotified(statePath: string, now: number): void {
  const state = loadState(statePath);
  state.lastNotifiedAt = now;
  persist(statePath, state);
}
