/**
 * Makes silent history-sync loss visible.
 *
 * Baileys persists each HISTORY_SYNC_NOTIFICATION envelope via messages.upsert
 * and, separately, downloads it and emits messaging-history.set. When the
 * second step never happens the database still shows envelopes, so the loss is
 * invisible. Under Baileys 7.0.0-rc12 every self-sent notification was dropped
 * this way by the self-only guard, with only a warn from a logger we run at
 * error level.
 *
 * This watch observes both sides and reports, with no message content:
 *   - a notification not marked fromMe: the self-only guard drops it
 *     (a spoof, or a decoder regression like rc12's);
 *   - eligible notifications followed by no messaging-history.set at all
 *     within the timeout (a liveness check, not a per-notification count).
 * FULL notifications are expected to be skipped (Baileys' default
 * shouldSyncHistoryMessage, which WhatSoup does not override) and are only
 * counted, never alarmed on.
 */

/**
 * WhatsApp wire-protocol enum values (proto.Message.ProtocolMessage.Type and
 * proto.HistorySync.HistorySyncType). Kept literal because the transport tests
 * replace the Baileys module; tests/transport/history-sync-watch.test.ts pins
 * them against the real vendored proto.
 */
export const HISTORY_SYNC_NOTIFICATION_TYPE = 5;
export const HISTORY_SYNC_TYPE_FULL = 2;

export const HISTORY_BATCH_TIMEOUT_MS = 5 * 60_000;

interface WatchLog {
  warn(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: Timers = {
  set: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface UpsertedMessage {
  key?: { fromMe?: boolean | null } | null;
  message?: {
    protocolMessage?: {
      type?: number | null;
      historySyncNotification?: { syncType?: number | null } | null;
    } | null;
  } | null;
}

export class HistorySyncWatch {
  private readonly log: WatchLog;
  private readonly timeoutMs: number;
  private readonly timers: Timers;
  private pending = 0;
  private pendingSyncTypes: number[] = [];
  private timer: unknown = null;

  constructor(log: WatchLog, timeoutMs: number = HISTORY_BATCH_TIMEOUT_MS, timers: Timers = realTimers) {
    this.log = log;
    this.timeoutMs = timeoutMs;
    this.timers = timers;
  }

  /** Call for every message delivered in messages.upsert. */
  observeUpsert(msg: UpsertedMessage): void {
    const protocol = msg.message?.protocolMessage;
    if (protocol?.type !== HISTORY_SYNC_NOTIFICATION_TYPE) return;
    const syncType = protocol.historySyncNotification?.syncType ?? null;

    if (msg.key?.fromMe !== true) {
      this.log.warn(
        { syncType },
        'history sync notification is not marked as ours; the self-only guard drops it',
      );
      return;
    }
    if (syncType === HISTORY_SYNC_TYPE_FULL) {
      this.log.debug({ syncType }, 'history sync notification skipped by policy (FULL)');
      return;
    }

    this.pending++;
    this.pendingSyncTypes.push(syncType ?? -1);
    if (this.timer === null) {
      this.timer = this.timers.set(() => this.expire(), this.timeoutMs);
    }
  }

  /**
   * Call for every messaging-history.set event, empty or not. Baileys' event
   * buffer merges the history of several notifications into one event, so a
   * batch proves the history path is alive for everything observed before it,
   * not a one-to-one match. Completeness is checked per message ID instead
   * (docs/runbook.md "Verify history backfill after a relink").
   */
  observeBatch(): void {
    this.pending = 0;
    this.pendingSyncTypes = [];
    this.clearTimer();
  }

  /** Call when the socket is replaced or shut down. */
  reset(): void {
    this.pending = 0;
    this.pendingSyncTypes = [];
    this.clearTimer();
  }

  private expire(): void {
    this.timer = null;
    if (this.pending === 0) return;
    this.log.warn(
      { pending: this.pending, syncTypes: [...this.pendingSyncTypes], timeoutMs: this.timeoutMs },
      'history sync notifications received but no history batch arrived',
    );
    this.pending = 0;
    this.pendingSyncTypes = [];
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.timers.clear(this.timer);
      this.timer = null;
    }
  }
}
