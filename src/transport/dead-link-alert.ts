// src/transport/dead-link-alert.ts
//
// One BOT ERRORS card per WhatsApp outage that a 401 loggedOut starts and no
// reconnect ends within DEAD_LINK_GRACE_MS.
//
// The immediate `whatsapp_device_bond_lost` alert stays as it is. Its incident
// is kept open until a verified relink and outbound send, so a later outage for
// the same bot is folded into the old incident and pages nobody. In 2026-10/11
// four bots stayed linkless for 8-18 days that way. This card has its own
// incident and its own outage identity.
//
// Guarantee: a card is sent AT LEAST ONCE per outage. The worst case is a
// duplicate that the hub collapses by outage ID, never a missed card.
//
// Outage identity. Each outage gets a random `outageId` (a UUID) the moment it
// starts. A UUID, not a start-time derivation, because the marker is the only
// place the identity lives: a clock step or two 401s in one millisecond must not
// be able to merge or split outages. The card and its clear carry the ID in
// `diagnostics.outageId`; the dispatcher collapses repeats of one ID and lets a
// different ID through even while an older incident is open. (The outbox event's
// own `id` is not reused: it is a per-event replay identity paired with
// `createdAt`, and the card and its clear are different events.)
//
// The marker <dataRoot>/dead-link-outage.json records
// {outageId, outageStartedAt, deadline, state, alertedAt?, clearQueuedAt?}
// with state arming | alerted | clearing | cleared. It is written atomically
// (private-fs temp file, fsync, rename) and NEVER deleted: "cleared" is a
// recorded state, and a new outage overwrites it with a new outageId.
//
// Fail toward alerting. In-process memory is authoritative; the file is its
// mirror. A failed write never suppresses a card: memory keeps the state and the
// write is retried on the retry timer. A marker that cannot be trusted (corrupt,
// unreadable, unknown state, or missing while memory says an outage is active)
// is treated as "card not yet confirmed" and the card is sent at the deadline.
// A stale marker never beats memory and never suppresses a NEW outage: a 401
// after an outage that ended starts a new outageId.
//
// Delivery rule, for the card and the clear alike: it is done only when it is
// in the durable outbox (status `durably_queued`). The legacy helper and the
// dry-run sink are never used. Every not-done step is retried every
// DEAD_LINK_RETRY_MS on this alarm's own timer, because a logged-out bot is
// parked and no further close or restart can be relied on.

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { readPrivateFileSync, writePrivateJsonMarkerSync } from '../lib/private-fs.ts';
import { isRecord } from '../lib/type-guards.ts';
import { systemClock } from '../lib/clock.ts';
import { clearAlertSource, emitAlert } from '../lib/emit-alert.ts';
import type { createChildLogger } from '../logger.ts';

export const DEAD_LINK_ALERT_SOURCE = 'whatsapp_link_dead';
export const DEAD_LINK_GRACE_MS = 10 * 60_000;
/** Retry interval for a card, clear or marker write that is not yet done. */
export const DEAD_LINK_RETRY_MS = 60_000;
export const DEAD_LINK_STATE_FILE = 'dead-link-outage.json';
const STATE_MAX_BYTES = 16 * 1024;

export type DeadLinkOutageStage = 'arming' | 'alerted' | 'clearing' | 'cleared';
const STAGES: readonly string[] = ['arming', 'alerted', 'clearing', 'cleared'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface DeadLinkOutageState {
  version: 2;
  outageId: string;
  outageStartedAt: string;
  /** When the card is due if the link is still down. */
  deadline: string;
  state: DeadLinkOutageStage;
  alertedAt: string | null;
  clearQueuedAt: string | null;
  statusCode: number;
  reason: string;
  classification: string;
}

export interface DeadLinkAlarmDeps {
  instance: string;
  /** Directory that holds the outage marker; null keeps it in memory only. */
  dataRoot: string | null;
  log: Pick<ReturnType<typeof createChildLogger>, 'warn' | 'error'>;
}

export interface LoggedOutObservation {
  statusCode: number;
  reason: string;
  classification: string;
}

type DiskRead = { kind: 'ok'; state: DeadLinkOutageState } | { kind: 'missing' } | { kind: 'unclear' };

export class DeadLinkAlarm {
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Authoritative copy; the marker file mirrors it. */
  private memoryState: DeadLinkOutageState | null = null;
  /** True while memoryState has not been written to the marker. */
  private dirty = false;
  private readonly deps: DeadLinkAlarmDeps;

  constructor(deps: DeadLinkAlarmDeps) {
    this.deps = deps;
  }

  /** A 401 loggedOut close: continue the outage in progress, or start a new one. */
  onLoggedOut(observation: LoggedOutObservation): void {
    this.cancelTimer();
    const state = this.current(observation);
    if (state !== null && (state.state === 'arming' || state.state === 'alerted')) {
      this.plan(state);
      return;
    }
    // An outage that ended (or a marker that cannot be trusted) never absorbs a
    // new one. A clear still owed for the old outage is tried once; the hub lets
    // the new outage's card through whether or not it lands.
    if (state !== null && state.state === 'clearing') this.queueClear(state);
    const fresh = newOutage(observation);
    this.writeState(fresh);
    this.plan(fresh);
  }

  /**
   * Connect start: a restart inside an outage keeps the original deadline even
   * if this process never sees a 401. A pending clear resumes its retries, and a
   * marker that cannot be trusted starts an unconfirmed outage.
   */
  resume(): void {
    this.cancelTimer();
    const state = this.current();
    if (state !== null) this.plan(state);
  }

  /** The link opened: the outage is over. Clears the card if one was raised. */
  onConnectionOpen(): void {
    this.cancelTimer();
    const state = this.current();
    if (state === null || state.state === 'cleared') {
      if (this.dirty) this.plan(state);
      return;
    }
    if (state.state === 'arming') {
      // No card was confirmed queued, so there is nothing to clear.
      this.writeState({ ...state, state: 'cleared' });
      this.plan(this.memoryState);
      return;
    }
    this.settleClear({ ...state, state: 'clearing' });
  }

  /** Process shutdown: the persisted outage survives for the next process. */
  dispose(): void {
    this.cancelTimer();
  }

  /** The grace window passed with the link still down: raise the card. */
  private raise(state: DeadLinkOutageState): void {
    const summary =
      `WhatsApp link down: whatsoup@${this.deps.instance} logged out (401) at ${state.outageStartedAt}; ` +
      `no reconnect for ${DEAD_LINK_GRACE_MS / 60_000} minutes, relink required`;
    const evidence = [
      `instance: ${this.deps.instance}`,
      `host: ${hostname()}`,
      `outage_id: ${state.outageId}`,
      `outage_started_at: ${state.outageStartedAt}`,
      `status_code: ${state.statusCode}`,
      `reason: ${state.reason}`,
      `disconnect_classification: ${state.classification}`,
      `grace_minutes: ${DEAD_LINK_GRACE_MS / 60_000}`,
      `observed_at: ${systemClock.nowIso()}`,
      'clear: raised at least once per outage; repeats carry the same outage_id; cleared by the transport when the WhatsApp link opens again',
    ].join('\n');
    const result = emitAlert(this.deps.instance, DEAD_LINK_ALERT_SOURCE, summary, evidence, 'critical', undefined, {
      requireDurableOutbox: true,
      outageStartedAt: state.outageStartedAt,
      outageId: state.outageId,
    });
    if (result.status !== 'durably_queued') {
      this.deps.log.error(
        { source: DEAD_LINK_ALERT_SOURCE, status: result.status, outboxError: result.outboxError },
        'dead-link alert was not durably queued; retrying',
      );
      this.schedule(DEAD_LINK_RETRY_MS);
      return;
    }
    const alerted: DeadLinkOutageState = { ...state, state: 'alerted', alertedAt: systemClock.nowIso() };
    this.writeState(alerted);
    this.plan(alerted);
  }

  /** `state` is a recovered outage. Queue its clear; record it, or retry later. */
  private settleClear(state: DeadLinkOutageState): void {
    if (!this.queueClear(state)) {
      this.writeState(state);
      this.plan(state);
      return;
    }
    const cleared: DeadLinkOutageState = { ...state, state: 'cleared', clearQueuedAt: systemClock.nowIso() };
    this.writeState(cleared);
    this.plan(cleared);
  }

  private queueClear(state: DeadLinkOutageState): boolean {
    const evidence = [
      `instance: ${this.deps.instance}`,
      `host: ${hostname()}`,
      `outage_id: ${state.outageId}`,
      `outage_started_at: ${state.outageStartedAt}`,
      `alerted_at: ${state.alertedAt ?? 'none'}`,
    ].join('\n');
    const result = clearAlertSource(this.deps.instance, DEAD_LINK_ALERT_SOURCE, evidence, undefined, {
      requireDurableOutbox: true,
      outageId: state.outageId,
    });
    if (result.status !== 'durably_queued') {
      this.deps.log.error(
        { source: DEAD_LINK_ALERT_SOURCE, status: result.status, outboxError: result.outboxError },
        'dead-link clear was not durably queued; keeping the outage marker and retrying',
      );
      return false;
    }
    return true;
  }

  /** Schedule the next step that `state` still owes; nothing once it owes none. */
  private plan(state: DeadLinkOutageState | null): void {
    if (state === null || state.state === 'cleared' || state.state === 'alerted') {
      if (this.dirty) this.schedule(DEAD_LINK_RETRY_MS);
      return;
    }
    if (state.state === 'clearing') {
      this.schedule(DEAD_LINK_RETRY_MS);
      return;
    }
    // Clamped so a deadline stamped in the future (clock step) cannot overflow setTimeout.
    const remaining = Math.min(DEAD_LINK_GRACE_MS, Date.parse(state.deadline) - systemClock.now());
    this.schedule(Math.max(0, remaining));
  }

  private schedule(delayMs: number): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.step();
    }, delayMs);
    this.timer.unref?.();
  }

  /** One timer tick: retry the marker write, then do whatever the state still owes. */
  private step(): void {
    const state = this.current();
    if (state === null) return;
    if (this.dirty) this.writeState(state);
    if (state.state === 'clearing') {
      this.settleClear(state);
      return;
    }
    if (state.state === 'arming') {
      if (Date.parse(state.deadline) <= systemClock.now()) this.raise(state);
      else this.plan(state);
      return;
    }
    this.plan(state);
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * The outage state to act on. Memory wins over the file, so a stale marker
   * cannot override this process. A file that cannot be trusted turns what
   * memory (or a restart) knows into "card not yet confirmed".
   */
  private current(observation?: LoggedOutObservation): DeadLinkOutageState | null {
    const disk = this.readDisk();
    const memory = this.memoryState;
    if (memory === null) {
      if (disk.kind === 'ok') return this.adopt(disk.state);
      if (disk.kind === 'unclear') {
        // Something was recorded here but cannot be read: an outage may be
        // active and its card unconfirmed. Start one; the card is due at the grace deadline.
        this.deps.log.warn({}, 'dead-link outage marker unclear; treating the card as unconfirmed');
        const unknown = newOutage(observation ?? { statusCode: 0, reason: 'marker_unreadable', classification: 'unknown' });
        this.writeState(unknown);
        return unknown;
      }
      return null;
    }
    if (disk.kind === 'ok' && disk.state.outageId === memory.outageId && !this.dirty) return memory;
    // The file is missing, unclear, stale or from another outage: memory stays
    // authoritative and is written back.
    const hadWritten = !this.dirty;
    this.dirty = true;
    if (hadWritten && disk.kind !== 'ok' && memory.state === 'alerted') {
      // The file held this state and no longer does: card not confirmed; resend at the deadline.
      this.deps.log.warn({}, 'dead-link outage marker lost; treating the card as unconfirmed');
      this.memoryState = { ...memory, state: 'arming', alertedAt: null };
    }
    return this.memoryState;
  }

  private adopt(state: DeadLinkOutageState): DeadLinkOutageState {
    this.memoryState = state;
    return state;
  }

  private statePath(): string | null {
    return this.deps.dataRoot ? join(this.deps.dataRoot, DEAD_LINK_STATE_FILE) : null;
  }

  private readDisk(): DiskRead {
    const path = this.statePath();
    if (path === null) return { kind: 'missing' };
    let text: string | null;
    try {
      text = readPrivateFileSync(path, { maxBytes: STATE_MAX_BYTES, label: 'dead-link outage marker' });
    } catch (err) {
      this.deps.log.warn({ err }, 'dead-link outage marker unreadable');
      return { kind: 'unclear' };
    }
    if (text === null) return { kind: 'missing' };
    try {
      const state = parseState(JSON.parse(text));
      return state === null ? { kind: 'unclear' } : { kind: 'ok', state };
    } catch {
      return { kind: 'unclear' };
    }
  }

  private writeState(state: DeadLinkOutageState): void {
    this.memoryState = state;
    const path = this.statePath();
    if (path === null) return;
    try {
      writePrivateJsonMarkerSync(path, state, { label: 'dead-link outage marker' });
      this.dirty = false;
    } catch (err) {
      // Memory stays authoritative and the write is retried on the retry timer.
      this.dirty = true;
      this.deps.log.warn({ err }, 'failed to persist dead-link outage marker; will retry');
    }
  }
}

function newOutage(observation: LoggedOutObservation): DeadLinkOutageState {
  const { statusCode, reason, classification } = observation;
  const startedAt = systemClock.nowIso();
  return {
    version: 2,
    outageId: randomUUID(),
    outageStartedAt: startedAt,
    deadline: new Date(Date.parse(startedAt) + DEAD_LINK_GRACE_MS).toISOString(),
    state: 'arming',
    alertedAt: null,
    clearQueuedAt: null,
    statusCode,
    reason,
    classification,
  };
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || isTimestamp(value);
}

/** Null for anything that is not a complete version-2 marker: it is then "unclear". */
function parseState(value: unknown): DeadLinkOutageState | null {
  if (!isRecord(value) || value.version !== 2) return null;
  const { outageId, outageStartedAt, deadline, state, statusCode, reason, classification } = value;
  if (typeof outageId !== 'string' || !UUID_RE.test(outageId)) return null;
  if (!isTimestamp(outageStartedAt) || !isTimestamp(deadline)) return null;
  if (typeof state !== 'string' || !STAGES.includes(state)) return null;
  const alertedAt = value.alertedAt ?? null;
  const clearQueuedAt = value.clearQueuedAt ?? null;
  if (!isNullableTimestamp(alertedAt) || !isNullableTimestamp(clearQueuedAt)) return null;
  if (typeof statusCode !== 'number') return null;
  return {
    version: 2,
    outageId,
    outageStartedAt,
    deadline,
    state: state as DeadLinkOutageStage,
    alertedAt,
    clearQueuedAt,
    statusCode,
    reason: typeof reason === 'string' ? reason : 'unknown',
    classification: typeof classification === 'string' ? classification : 'unknown',
  };
}
