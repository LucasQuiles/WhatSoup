// src/transport/dead-link-alert.ts
//
// One BOT ERRORS card per WhatsApp outage that a 401 loggedOut starts and no
// reconnect ends within DEAD_LINK_GRACE_MS.
//
// The immediate `whatsapp_device_bond_lost` alert stays as it is. Its incident
// is kept open until a verified relink and outbound send, so a later outage for
// the same bot is folded into the old incident and pages nobody. In 2026-10/11
// four bots stayed linkless for 8-18 days that way. This card has its own
// incident: the transport clears it when the link opens, so the next outage
// opens a new one.
//
// The outage start is persisted beside connection-state.json. A watchdog
// restart inside the same outage therefore keeps the original start, and the
// card is raised at most once per outage.
//
// The clear must be in the durable outbox before the outage counts as over: a
// legacy helper that merely accepted it does not prove the dispatcher closed
// the incident, and a still-open incident would absorb the next outage's card.
// Until the clear is queued the recovered marker stays, the clear is retried
// every DEAD_LINK_CLEAR_RETRY_MS, and a new outage is held in the marker; its
// card is raised, with its own start, once the clear is queued.

import { join } from 'node:path';
import { hostname } from 'node:os';
import {
  deletePrivateFileSync,
  readPrivateFileSync,
  writePrivateJsonMarkerSync,
} from '../lib/private-fs.ts';
import { isRecord } from '../lib/type-guards.ts';
import { systemClock } from '../lib/clock.ts';
import { clearAlertSourceChecked, emitAlertChecked } from '../lib/emit-alert.ts';
import type { createChildLogger } from '../logger.ts';

export const DEAD_LINK_ALERT_SOURCE = 'whatsapp_link_dead';
export const DEAD_LINK_GRACE_MS = 10 * 60_000;
export const DEAD_LINK_CLEAR_RETRY_MS = 60_000;
export const DEAD_LINK_STATE_FILE = 'dead-link-outage.json';
const STATE_MAX_BYTES = 16 * 1024;

interface OutageStart {
  outageStartedAt: string;
  statusCode: number;
  reason: string;
  classification: string;
}

interface DeadLinkOutageState extends OutageStart {
  version: 1;
  alertedAt: string | null;
  /** Set when the link opened but the card's clear is not yet in the outbox. */
  linkOpenedAt: string | null;
  /** A 401 seen while that clear is pending: the outage it starts is held. */
  heldOutage: OutageStart | null;
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

export class DeadLinkAlarm {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private memoryState: DeadLinkOutageState | null = null;
  private readonly deps: DeadLinkAlarmDeps;

  constructor(deps: DeadLinkAlarmDeps) {
    this.deps = deps;
  }

  /** A 401 loggedOut close: start the outage (or continue the persisted one). */
  onLoggedOut(observation: LoggedOutObservation): void {
    const state = this.readState();
    if (state !== null && state.linkOpenedAt !== null) {
      // The previous outage's clear is still pending. Hold this outage in the
      // marker (keeping the first held start) and retry the clear now.
      const heldOutage = state.heldOutage ?? startNow(observation);
      this.settleClear({ ...state, heldOutage });
      return;
    }
    if (state === null) {
      const fresh = newOutage(startNow(observation));
      this.writeState(fresh);
      this.arm(fresh);
      return;
    }
    this.arm(state);
  }

  /**
   * Connect start: a restart inside an outage that has not been reported yet
   * keeps the original deadline even if this process never sees a 401 (for
   * example when it parks before opening a socket). A pending clear resumes
   * its retries.
   */
  resume(): void {
    const state = this.readState();
    if (state !== null) this.arm(state);
  }

  /** The link opened: the outage is over. Clears the card if one was raised. */
  onConnectionOpen(): void {
    this.cancelTimer();
    const state = this.readState();
    if (state === null) return;
    if (state.alertedAt === null) {
      this.deleteState();
      return;
    }
    // A held outage ended before it was reported, so only the clear remains.
    this.settleClear({ ...state, linkOpenedAt: state.linkOpenedAt ?? systemClock.nowIso(), heldOutage: null });
  }

  /** Process shutdown: the persisted outage survives for the next process. */
  dispose(): void {
    this.cancelTimer();
  }

  private fire(): void {
    const state = this.readState();
    if (state === null || state.alertedAt !== null || state.linkOpenedAt !== null) return;
    const summary =
      `WhatsApp link down: whatsoup@${this.deps.instance} logged out (401) at ${state.outageStartedAt}; ` +
      `no reconnect for ${DEAD_LINK_GRACE_MS / 60_000} minutes, relink required`;
    const evidence = [
      `instance: ${this.deps.instance}`,
      `host: ${hostname()}`,
      `outage_started_at: ${state.outageStartedAt}`,
      `status_code: ${state.statusCode}`,
      `reason: ${state.reason}`,
      `disconnect_classification: ${state.classification}`,
      `grace_minutes: ${DEAD_LINK_GRACE_MS / 60_000}`,
      `observed_at: ${systemClock.nowIso()}`,
      'clear: raised once per outage; cleared by the transport when the WhatsApp link opens again',
    ].join('\n');
    if (!emitAlertChecked(this.deps.instance, DEAD_LINK_ALERT_SOURCE, summary, evidence, 'critical')) {
      // Not queued: leave alertedAt unset so the next 401 (or restart) retries.
      this.deps.log.error({ source: DEAD_LINK_ALERT_SOURCE }, 'dead-link alert was not queued');
      return;
    }
    this.writeState({ ...state, alertedAt: systemClock.nowIso() });
  }

  /**
   * `state` is a recovered outage. Queue its clear in the durable outbox; on
   * success drop the marker or start the held outage, otherwise keep the
   * marker and retry later.
   */
  private settleClear(state: DeadLinkOutageState): void {
    this.cancelTimer();
    if (!this.queueClear(state)) {
      this.deps.log.error(
        { source: DEAD_LINK_ALERT_SOURCE, heldOutage: state.heldOutage !== null },
        'dead-link clear was not durably queued; keeping the outage marker and retrying',
      );
      this.writeState(state);
      this.arm(state);
      return;
    }
    if (state.heldOutage === null) {
      this.deleteState();
      return;
    }
    const next = newOutage(state.heldOutage);
    this.writeState(next);
    this.arm(next);
  }

  private queueClear(state: DeadLinkOutageState): boolean {
    const evidence = [
      `instance: ${this.deps.instance}`,
      `host: ${hostname()}`,
      `outage_started_at: ${state.outageStartedAt}`,
      `alerted_at: ${state.alertedAt ?? 'none'}`,
      `link_opened_at: ${state.linkOpenedAt ?? systemClock.nowIso()}`,
    ].join('\n');
    return clearAlertSourceChecked(this.deps.instance, DEAD_LINK_ALERT_SOURCE, evidence, undefined, {
      requireDurableOutbox: true,
    });
  }

  private arm(state: DeadLinkOutageState): void {
    if (this.timer !== null) return;
    if (state.linkOpenedAt !== null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        const current = this.readState();
        if (current !== null && current.linkOpenedAt !== null) this.settleClear(current);
      }, DEAD_LINK_CLEAR_RETRY_MS);
      this.timer.unref?.();
      return;
    }
    if (state.alertedAt !== null) return;
    // Clamped so a start stamped in the future (clock step) cannot overflow setTimeout.
    const remaining = Math.min(
      DEAD_LINK_GRACE_MS,
      Date.parse(state.outageStartedAt) + DEAD_LINK_GRACE_MS - systemClock.now(),
    );
    this.timer = setTimeout(() => {
      this.timer = null;
      this.fire();
    }, Math.max(0, remaining));
    this.timer.unref?.();
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private statePath(): string | null {
    return this.deps.dataRoot ? join(this.deps.dataRoot, DEAD_LINK_STATE_FILE) : null;
  }

  private readState(): DeadLinkOutageState | null {
    const path = this.statePath();
    if (path === null) return this.memoryState;
    let text: string | null;
    try {
      text = readPrivateFileSync(path, { maxBytes: STATE_MAX_BYTES, label: 'dead-link outage marker' });
    } catch (err) {
      this.deps.log.warn({ err }, 'dead-link outage marker unreadable; using this process state');
      return this.memoryState;
    }
    // An absent or malformed marker falls back to this process's own copy,
    // so a failed write still leaves one card per outage in this process.
    if (text === null) return this.memoryState;
    try {
      return parseState(JSON.parse(text)) ?? this.memoryState;
    } catch {
      this.deps.log.warn({}, 'dead-link outage marker malformed; using this process state');
      return this.memoryState;
    }
  }

  private writeState(state: DeadLinkOutageState): void {
    this.memoryState = state;
    const path = this.statePath();
    if (path === null) return;
    try {
      writePrivateJsonMarkerSync(path, state, { label: 'dead-link outage marker' });
    } catch (err) {
      // The in-memory copy still gives this process one card per outage.
      this.deps.log.warn({ err }, 'failed to persist dead-link outage marker');
    }
  }

  private deleteState(): void {
    this.memoryState = null;
    const path = this.statePath();
    if (path === null) return;
    try {
      deletePrivateFileSync(path, 'dead-link outage marker');
    } catch (err) {
      this.deps.log.warn({ err }, 'failed to remove dead-link outage marker');
    }
  }
}

function startNow(observation: LoggedOutObservation): OutageStart {
  const { statusCode, reason, classification } = observation;
  return { outageStartedAt: systemClock.nowIso(), statusCode, reason, classification };
}

function newOutage(start: OutageStart): DeadLinkOutageState {
  return { version: 1, ...start, alertedAt: null, linkOpenedAt: null, heldOutage: null };
}

function parseOutageStart(value: unknown): OutageStart | null {
  if (!isRecord(value)) return null;
  const { outageStartedAt, statusCode, reason, classification } = value;
  if (typeof outageStartedAt !== 'string' || !Number.isFinite(Date.parse(outageStartedAt))) return null;
  if (typeof statusCode !== 'number') return null;
  return {
    outageStartedAt,
    statusCode,
    reason: typeof reason === 'string' ? reason : 'unknown',
    classification: typeof classification === 'string' ? classification : 'unknown',
  };
}

function parseState(value: unknown): DeadLinkOutageState | null {
  if (!isRecord(value) || value.version !== 1) return null;
  const start = parseOutageStart(value);
  if (start === null) return null;
  const alertedAt = value.alertedAt ?? null;
  const linkOpenedAt = value.linkOpenedAt ?? null;
  if (!isNullableString(alertedAt) || !isNullableString(linkOpenedAt)) return null;
  const heldOutage = value.heldOutage == null ? null : parseOutageStart(value.heldOutage);
  if (value.heldOutage != null && heldOutage === null) return null;
  return { version: 1, ...start, alertedAt, linkOpenedAt, heldOutage };
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}
