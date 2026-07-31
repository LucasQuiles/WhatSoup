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
import {
  privateJournalPath,
  readPrivateV1JournalSync,
  type PrivateJournalStatus,
  writePrivateJournalSync,
} from '../lib/private-journal.ts';
import { createChildLogger } from '../logger.ts';

const log = createChildLogger('startup-notify');

export const STARTUP_NOTIFY_FILENAME = 'startup-notify.json';

/** Boots older than this never matter to a "back online" summary. */
const BOOT_RETENTION_MS = 24 * 60 * 60 * 1_000;
/** Hard cap so a pathological crash loop cannot grow the journal unbounded. */
const MAX_BOOTS = 100;
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

export interface StartupNotifyJournalResult {
  status: PrivateJournalStatus;
  /** Usable v1 state; ephemeral when the persisted source is unreadable. */
  state: StartupNotifyState;
}

/**
 * The result of the journal-owned read-modify-write settlement. A false
 * watermark means callers may submit the returned status text for availability,
 * but must not represent the batch as durably settled.
 */
export interface StartupNotificationSettlement {
  status: PrivateJournalStatus;
  watermarkPersisted: boolean;
  state: StartupNotifyState;
  notification: StartupNotification | null;
}

export function startupNotifyPath(stateRoot: string): string {
  return privateJournalPath(stateRoot, STARTUP_NOTIFY_FILENAME);
}

function freshState(): StartupNotifyState {
  return { v: 1, boots: [], lastNotifiedAt: null };
}

function parseV1State(value: Record<string, unknown>): StartupNotifyState | null {
  if (
    !Array.isArray(value.boots)
    || !value.boots.every((boot) => typeof boot === 'number' && Number.isFinite(boot))
    || (value.lastNotifiedAt !== null && (typeof value.lastNotifiedAt !== 'number' || !Number.isFinite(value.lastNotifiedAt)))
  ) {
    return null;
  }
  return { v: 1, boots: value.boots, lastNotifiedAt: value.lastNotifiedAt as number | null };
}

function loadState(statePath: string): StartupNotifyJournalResult {
  const source = readPrivateV1JournalSync(statePath, 'startup-notify journal');
  if (source.status === 'journal_unreadable') {
    log.warn({ statePath }, 'startup-notify: journal unreadable — preserving source (fail-open)');
    return { status: 'journal_unreadable', state: freshState() };
  }
  if (source.version === 'missing') return { status: 'available', state: freshState() };
  const state = parseV1State(source.value);
  if (state === null) {
    log.warn({ statePath }, 'startup-notify: journal malformed — preserving source (fail-open)');
    return { status: 'journal_unreadable', state: freshState() };
  }
  return { status: 'available', state };
}

function persist(statePath: string, state: StartupNotifyState): boolean {
  try {
    writePrivateJournalSync(statePath, state, 'startup-notify journal');
    return true;
  } catch (err) {
    log.warn({ err, statePath }, 'startup-notify: journal not persisted — continuing (fail-open)');
    return false;
  }
}

/** Record this process's boot; prune to retention; persist. Never throws. */
export function recordStartupBoot(statePath: string, now: number): StartupNotifyJournalResult {
  const result = loadState(statePath);
  const { state } = result;
  state.boots = [...state.boots.filter((b) => now - b < BOOT_RETENTION_MS), now].slice(-MAX_BOOTS);
  if (result.status === 'journal_unreadable') return result;
  return { status: persist(statePath, state) ? 'available' : 'journal_unreadable', state };
}

const defaultLocalHm = (ms: number): string =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

/**
 * Compose the message covering every boot since the last notification.
 * One boot → the classic copy; several → one intentional summary that keeps
 * the user informed instead of pinging once per recovery.
 *
 * The composed text depends only on the journal state; callers that render
 * user-facing clocks should inject their presentation formatter (main.ts
 * passes formatClockForUser) so the copy matches the rest of the product.
 */
export function composeStartupNotification(
  state: StartupNotifyState,
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

/**
 * Select unnotified boots, compose their one aggregate, and persist the
 * watermark before the caller submits it. This is deliberately one journal
 * operation: composition and watermark ordering cannot drift into callers.
 *
 * For an unreadable source, `ephemeralState` preserves the boot evidence the
 * current process already recorded in memory while keeping the on-disk source
 * untouched. The notification remains fail-open, but `watermarkPersisted` is
 * false so no caller can claim durable settlement.
 */
export function settleStartupNotification(
  statePath: string,
  now: number,
  formatTime: (ms: number) => string = defaultLocalHm,
  ephemeralState?: StartupNotifyState,
): StartupNotificationSettlement {
  const result = loadState(statePath);
  if (result.status === 'journal_unreadable') {
    const state = ephemeralState ?? result.state;
    const composed = composeStartupNotification(state, formatTime);
    return {
      status: 'journal_unreadable',
      watermarkPersisted: false,
      state,
      notification: composed.bootsCovered > 0 ? composed : null,
    };
  }

  // A record write can fail while leaving a valid older/missing source that
  // later becomes writable. Reconcile just that process's unpersisted state
  // with the recovered source so its boot cannot disappear before settlement.
  const state = ephemeralState === undefined
    ? result.state
    : reconcileRecoveredState(result.state, ephemeralState, now);
  const composed = composeStartupNotification(state, formatTime);
  if (composed.bootsCovered === 0) {
    return {
      status: 'available',
      watermarkPersisted: true,
      state,
      notification: null,
    };
  }

  const nextState: StartupNotifyState = { ...state, lastNotifiedAt: now };
  if (!persist(statePath, nextState)) {
    return {
      status: 'journal_unreadable',
      watermarkPersisted: false,
      state,
      notification: composed,
    };
  }
  return {
    status: 'available',
    watermarkPersisted: true,
    state: nextState,
    notification: composed,
  };
}

function reconcileRecoveredState(
  persistedState: StartupNotifyState,
  ephemeralState: StartupNotifyState,
  now: number,
): StartupNotifyState {
  const lastNotifiedAt = Math.max(
    persistedState.lastNotifiedAt ?? 0,
    ephemeralState.lastNotifiedAt ?? 0,
  ) || null;
  const boots = [...new Set([...persistedState.boots, ...ephemeralState.boots])]
    .filter((boot) => now - boot < BOOT_RETENTION_MS)
    .sort((a, b) => a - b)
    .slice(-MAX_BOOTS);
  return { v: 1, boots, lastNotifiedAt };
}

/**
 * Narrow journal port for the process-local controller. Keeping path I/O and
 * read-modify-write ownership here prevents the controller from knowing about
 * filesystem layouts or persistence mechanics.
 */
export function createStartupNotificationJournalPort(
  statePath: string,
  formatTime: (ms: number) => string = defaultLocalHm,
): {
  recordStartupBoot(now: number): StartupNotifyJournalResult;
  settleStartupNotification(now: number): StartupNotificationSettlement;
} {
  let unpersistedState: StartupNotifyState | undefined;
  return {
    recordStartupBoot(now: number): StartupNotifyJournalResult {
      const result = recordStartupBoot(statePath, now);
      unpersistedState = result.status === 'journal_unreadable' ? result.state : undefined;
      return result;
    },
    settleStartupNotification(now: number): StartupNotificationSettlement {
      const settled = settleStartupNotification(statePath, now, formatTime, unpersistedState);
      if (settled.watermarkPersisted) unpersistedState = undefined;
      return settled;
    },
  };
}
