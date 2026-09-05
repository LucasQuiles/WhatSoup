// src/core/scheduler.ts
// SP11 — Message Scheduling: tick-based scheduler that sends pending scheduled_messages.

import { createChildLogger } from '../logger.ts';
import type { Database } from './database.ts';
import type { SubmissionReceipt, OutboundMedia } from './types.ts';
import { nextCronRun } from './cron.ts';
import { type Clock, systemClock } from '../lib/clock.ts';
import { errorMessage } from '../lib/error-message.ts';
import { clearAlertSourceChecked, emitAlertChecked } from '../lib/emit-alert.ts';
import {
  clearRecoveryMarker,
  loadRecoveryMarkers,
  readRecoveryMarkerState,
  setRecoveryMarker,
} from '../lib/recovery-authority-store.ts';

const log = createChildLogger('scheduler');

/**
 * Narrow, CORE-LOCAL view of the transport surface the scheduler consumes.
 * Structural, so `src/core/` need not import from `src/transport/` (the
 * import-boundary guard forbids core→transport). The real RuntimeConnection /
 * ConnectionManager satisfies this by shape — `main.ts` still injects the
 * concrete connection unchanged.
 */
interface SchedulerConnection {
  sendRaw(chatJid: string, content: Record<string, unknown>): Promise<SubmissionReceipt>;
  sendMedia(chatJid: string, media: OutboundMedia): Promise<SubmissionReceipt>;
  /** Optional link-state snapshot; absent on transports without one (e.g. SMS). */
  getConnectionState?(): SchedulerConnectionState;
}

/**
 * Narrow, CORE-LOCAL view of the connection-state fields the #1779 link gate
 * reads. The transport ConnectionStateSnapshot is a structural superset, so a
 * live snapshot satisfies this without a core→transport import.
 */
interface SchedulerConnectionState {
  connected: boolean;
  lastDisconnectReason: string | null;
  authBond?: { status: string };
}

/**
 * #1779 — reason stamped on a due row held because the instance's WhatsApp link
 * is de-linked (logged out / device-bond lost). The row stays `pending` and is
 * NEVER burned to `failed`; it fires on re-link.
 */
const DELINK_HOLD_REASON =
  'Held: instance de-linked from WhatsApp (logged out / device-bond lost); retained until re-link';

/**
 * Link-state classification of the transport, consulted before a fire-time send.
 * - `linked`     — connected; send normally.
 * - `delinked`   — logged out / device-bond lost: TERMINAL, needs human re-pair.
 *                  Hold the send (defer) + raise a loud producer signal — never
 *                  silently burn it (the #1779 defect).
 * - `transient`  — dropped but actively reconnecting: keep trying (existing
 *                  retry path); a daily job must survive a socket blip.
 * - `unknown`    — transport exposes no link state (e.g. SMS): never gate.
 */
type LinkState = 'linked' | 'delinked' | 'transient' | 'unknown';

interface ScheduledRow {
  id: number;
  chat_jid: string;
  content_type: string;
  payload: string;
  retry_count: number;
  media_blob: Uint8Array | null;
  recurrence: string | null;
  next_run_at: number | null;
  run_count: number;
  timezone: string | null;
}

const MISSED_OCCURRENCE_SCAN_CAP = 10_000;

function advanceRecurringRun(
  recurrence: string,
  previousNextRun: number,
  sentAt: number,
  timezone: string,
): { nextRun: number; skippedOccurrences: number; capped: boolean } {
  let skippedOccurrences = 0;
  let cursor = previousNextRun;

  for (let i = 0; i < MISSED_OCCURRENCE_SCAN_CAP; i++) {
    const nextRun = nextCronRun(recurrence, cursor, timezone);
    if (nextRun > sentAt) {
      return { nextRun, skippedOccurrences, capped: false };
    }
    skippedOccurrences += 1;
    cursor = nextRun;
  }

  return {
    nextRun: nextCronRun(recurrence, sentAt, timezone),
    skippedOccurrences,
    capped: true,
  };
}

/**
 * A scheduled row whose stored payload is not decodable.
 *
 * Distinct from a send failure because it is a property of the ROW, not of the
 * transport: no retry and no later occurrence can decode the same bytes. The
 * retry ladder exists for transient conditions, so burning it here costs
 * `maxRetries` attempts and then drops the message with a generic error.
 */
export class ScheduledPayloadError extends Error {
  constructor(reason: string) {
    super(`scheduled payload is not decodable: ${reason}`);
    this.name = 'ScheduledPayloadError';
  }
}

/**
 * A scheduled send that has reached a TERMINAL disposition (#2387).
 *
 * The row is written `failed` and leaves the due query forever, so the operator
 * alert is the only remaining trace of the dropped message. These fields are
 * exactly what re-rendering that alert needs and nothing else — no chat jid, no
 * payload, no message body — because the record is written to DURABLE storage
 * whenever the alert enqueue is rejected.
 */
type TerminalSendFailure =
  | { kind: 'payload_undecodable'; scheduledId: number; error: string; recurring: boolean }
  | { kind: 'retry_exhausted'; scheduledId: number; error: string; attempts: number };

/**
 * Render the `scheduler_send_failed` alert for a terminal disposition.
 *
 * ONE builder for the first attempt and for any later re-emission from a
 * retained record (#2387), so a retried alert is identical to the rejected one
 * by construction rather than by two call sites happening to agree. The text is
 * unchanged from the two inline emissions this replaced; #2386 owns the
 * evidence-redaction boundary, deliberately not this seam.
 */
function terminalSendAlertText(
  instance: string,
  failure: TerminalSendFailure,
): { summary: string; evidence: string } {
  if (failure.kind === 'payload_undecodable') {
    return {
      summary:
        `whatsoup@${instance} dead-lettered scheduled send (id ${failure.scheduledId}) — `
        + `stored payload is undecodable, message DROPPED: ${failure.error}`,
      evidence: [
        `scheduledId=${failure.scheduledId}`,
        `recurring=${failure.recurring}`,
        `error=${failure.error}`,
        'ref: #2359 — an undecodable payload is permanent, so it is dead-lettered on the first occurrence rather than consuming the retry budget. Inspect the scheduled_messages row; the payload column is not valid JSON.',
      ].join('\n'),
    };
  }
  return {
    summary:
      `whatsoup@${instance} permanently failed a scheduled send (id ${failure.scheduledId}) `
      + `after ${failure.attempts} attempts — message DROPPED: ${failure.error}`,
    evidence: [
      `scheduledId=${failure.scheduledId}`,
      `attempts=${failure.attempts}`,
      `error=${failure.error}`,
      'ref: #1779 remediation #3 — a permanent scheduled-send drop is now surfaced as an alert. If the transport is de-linked, re-pair the WhatsApp link; otherwise inspect the send error.',
    ].join('\n'),
  };
}

/**
 * Length bound for the error string stored in a terminal-failure marker. Long
 * enough for the message skeleton and a position, short enough that a pathological
 * error cannot turn a marker into a log.
 */
const MARKER_ERROR_MAX_LENGTH = 200;

/**
 * Strip quoted content from an error string before it is written to a marker.
 *
 * Contract clause 5 (#2387): the durable record may carry only what re-rendering
 * the alert needs, never payload bytes. `errorMessage()` of a `JSON.parse` throw
 * violates that — V8 embeds a prefix of the input, rendering an undecodable
 * payload as `Unexpected token 'H', "Hi Rachel,"... is not valid JSON`.
 *
 * Everything from the first quote to the last goes, and both quote styles go:
 * the single-quoted token in that same message is itself a payload byte, and the
 * exact phrasing is a V8 implementation detail that moves between Node versions.
 * Redacting by quoting rather than by message shape survives that drift, at the
 * cost of also blanking grammar tokens in positional messages
 * (`Expected ',' or '}' …`) — the skeleton and the position, which is what an
 * operator acts on, remain.
 *
 * The span is GREEDY, not quote-pair matched. A payload that contains a double
 * quote makes V8 echo it whole — `{"x":}` renders as `Unexpected token '}',
 * "{"x":}" is not valid JSON` — and pair matching there aligns the quotes wrongly
 * and leaves the payload between two redacted pairs. Since the echo is the only
 * quoted region these messages carry, spanning it whole is both safe and simpler
 * than tracking nesting.
 *
 * An unterminated run redacts to end of string, so a malformed message cannot
 * leak its tail — but the CLOSED form is tried first, so a message that does
 * close its quotes keeps everything after them (the position an operator reads).
 * A single pattern ending in `("|$)` would not: greedy matching reaches the end
 * of the string, where `$` succeeds without ever backtracking to the real
 * closing quote, and the tail is swallowed.
 *
 * Redaction runs BEFORE the length bound: truncating first could sever the span
 * and leave its opening fragment behind unmatched.
 */
function redactErrorForMarker(error: string): string {
  const redacted = error
    .replace(/"[\s\S]*"|"[\s\S]*$/, '"<redacted>"')
    .replace(/'[\s\S]*'|'[\s\S]*$/, "'<redacted>'");
  return redacted.length <= MARKER_ERROR_MAX_LENGTH
    ? redacted
    : `${redacted.slice(0, MARKER_ERROR_MAX_LENGTH)}…`;
}

/**
 * Rebuild a terminal-failure record from a marker payload, or null.
 *
 * Validated rather than cast: the marker is durable state that can outlive the
 * code that wrote it, and a half-typed record would re-emit an alert reading
 * `id undefined` — worse than the missing alert this whole path exists to
 * prevent.
 */
function parseTerminalSendFailure(raw: Record<string, unknown>): TerminalSendFailure | null {
  const scheduledId = raw['scheduledId'];
  const error = raw['error'];
  if (typeof scheduledId !== 'number' || typeof error !== 'string') return null;

  const recurring = raw['recurring'];
  if (raw['kind'] === 'payload_undecodable' && typeof recurring === 'boolean') {
    return { kind: 'payload_undecodable', scheduledId, error, recurring };
  }
  const attempts = raw['attempts'];
  if (raw['kind'] === 'retry_exhausted' && typeof attempts === 'number') {
    return { kind: 'retry_exhausted', scheduledId, error, attempts };
  }
  return null;
}

export class MessageScheduler {
  private timer: NodeJS.Timeout | null = null;
  private db: Database;
  private connection: SchedulerConnection;
  private config: { intervalMs: number; maxRetries: number; instance?: string };
  private readonly clock: Clock;

  /**
   * #1779 latch: true once the de-linked-hold owner alert has fired for the
   * current de-link episode. Re-armed by clearDeLinkLatch() on the first linked
   * tick (evaluated before the empty-candidates return, so it clears even in an
   * idle window) — a later de-link alerts again, but a persistent outage alerts
   * only once (mirrors ConnectionManager.loggedOutAlertEmitted, which clears
   * unconditionally on the 'open' event).
   */
  private deLinkAlertEmitted = false;

  /**
   * #2387: marker keys written by THIS process whose operator alert is still
   * owed. A fast path and a fallback, never the source of truth — the drain
   * re-derives the obligation from the marker directory on every tick, because
   * a store read that fails once must not orphan an alert until the next
   * restart. This set is what keeps a just-written marker discoverable while
   * that directory read is failing.
   */
  private readonly pendingTerminalAlerts = new Set<string>();

  /**
   * #2387: keys whose alert this process DELIVERED but whose marker it could
   * not clear. The marker is still on disk and the per-tick re-derivation keeps
   * handing the key back, so without this the operator is paged once a tick
   * until the store heals.
   *
   * Membership suppresses only the RE-EMISSION; the clear is retried on every
   * tick and the key leaves on success. It is not a claim about what is owed —
   * disk still holds that — only a record that this process already delivered
   * this one. A restart therefore re-emits once, which is the honest reading of
   * a marker that is still on disk saying the alert was never cleared.
   */
  private readonly deliveredUnclearable = new Set<string>();

  constructor(
    db: Database,
    connection: SchedulerConnection,
    config: { intervalMs: number; maxRetries: number; instance?: string },
    // Injectable so fire-time timestamps (send_started_at / sent_at and
    // recurring next_run_at anchoring) can be driven to a known instant
    // (#2200). Optional and defaulted, so this slice changes no existing call
    // site.
    clock: Clock = systemClock,
  ) {
    this.db = db;
    this.connection = connection;
    this.config = config;
    this.clock = clock;
    // #2415: a restart mid-de-link-episode must restore clear authority
    // without re-paging — the durable marker survives what the in-memory
    // latch cannot (same restoration shape as ConnectionManager's markers).
    if (config.instance) {
      try {
        this.deLinkAlertEmitted = loadRecoveryMarkers().has(this.deLinkMarkerKey());
      } catch {
        // intentional: marker store unreadable — treat as no prior incident.
      }
    }
  }

  private deLinkMarkerKey(): string {
    return `scheduler_delinked_send_held:${this.config.instance}`;
  }

  /**
   * Namespace for per-row terminal-alert markers (#2387). One key per scheduled
   * id, so two dropped rows are two independent obligations that cannot collapse
   * into one another — the trailing separator is what keeps the restart scan
   * from matching a different source that merely starts the same way.
   */
  private terminalAlertMarkerPrefix(): string {
    return `scheduler_send_failed:${this.config.instance}:`;
  }

  private terminalAlertMarkerKey(scheduledId: number): string {
    return `${this.terminalAlertMarkerPrefix()}${scheduledId}`;
  }

  start(): void {
    // Idempotent: a second start() must not orphan the first interval (matches the
    // guard every sibling scheduler/poller uses, e.g. database-retention, consolidation).
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => log.error({ err }, 'scheduler tick failed'));
    }, this.config.intervalMs);
    this.timer.unref();

    // Run immediately on startup
    this.tick().catch((err) => log.error({ err }, 'scheduler initial tick failed'));
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Recover rows stuck in 'processing' after a crash without blindly replaying uncertain sends. */
  recoverStale(): void {
    // Recurring rows caught mid-send by a crash must NOT be killed wholesale.
    // Fail closed on REPLAY (never re-send the uncertain occurrence) but keep
    // the schedule alive by skipping to the next slot — mirroring the in-tick
    // retry-exhaustion path. A blanket 'failed' would silently destroy the
    // entire recurring schedule on a single crash (#1069 asymmetry).
    const recurringUncertain = this.db.raw
      .prepare(
        `SELECT id, recurrence, next_run_at, timezone
         FROM scheduled_messages
         WHERE status = 'processing' AND send_started_at IS NOT NULL AND recurrence IS NOT NULL`,
      )
      .all() as unknown as Array<{
        id: number;
        recurrence: string;
        next_run_at: number | null;
        timezone: string | null;
      }>;
    for (const row of recurringUncertain) {
      const now = this.clock.nowUnixSec();
      let nextRun: number | null = null;
      try {
        nextRun = advanceRecurringRun(row.recurrence, row.next_run_at ?? now, now, row.timezone ?? 'UTC').nextRun;
      } catch {
        nextRun = null;
      }
      if (nextRun !== null) {
        this.db.raw
          .prepare(
            `UPDATE scheduled_messages
             SET status = 'pending', retry_count = 0, next_run_at = ?, error = ?, send_started_at = NULL
             WHERE id = ?`,
          )
          .run(nextRun, 'Occurrence skipped after crash during send (uncertain delivery); recurring schedule kept alive', row.id);
        log.warn({ id: row.id, nextRun }, 'scheduler: recurring occurrence uncertain after crash, skipped to next slot');
      } else {
        this.db.raw
          .prepare(
            `UPDATE scheduled_messages
             SET status = 'failed', error = ?, send_started_at = NULL
             WHERE id = ?`,
          )
          .run('Recurring failed after crash during send (cannot compute next slot from recurrence)', row.id);
        log.warn({ id: row.id, recurrence: row.recurrence }, 'scheduler: recurring uncertain-send permanently failed (invalid cron)');
      }
    }

    // One-shot uncertain sends stay fail-closed: we cannot know whether the
    // single delivery happened, so manual verification is required before retry.
    const uncertainCount = this.db.raw
      .prepare(
        `UPDATE scheduled_messages
         SET status = 'failed',
             error = 'Recovered after crash during scheduled send; manual verification required before retry',
             send_started_at = NULL
         WHERE status = 'processing' AND send_started_at IS NOT NULL AND recurrence IS NULL`,
      )
      .run().changes;
    if (uncertainCount > 0) {
      log.warn({ count: uncertainCount }, 'scheduler: failed closed stale processing rows with uncertain send status');
    }

    const requeuedCount = this.db.raw
      .prepare(
        `UPDATE scheduled_messages
         SET status = 'pending', send_started_at = NULL
         WHERE status = 'processing' AND send_started_at IS NULL`,
      )
      .run().changes;
    if (requeuedCount > 0) {
      log.info({ count: requeuedCount }, 'scheduler: recovered stale pre-send processing rows to pending');
    }
  }

  async tick(): Promise<void> {
    const now = this.clock.nowUnixSec();

    // #1779 — assess transport link state up front. Clearing the de-link alert
    // latch here, BEFORE the empty-candidates early return, re-arms it on
    // re-link even during a window with no due message — matching
    // ConnectionManager.loggedOutAlertEmitted, which clears on the 'open' event
    // unconditionally rather than being gated on scheduler activity. Without
    // this, a re-link during an idle window would leave the latch stuck and a
    // later de-link episode would hold sends without alerting.
    const linkState = this.assessLinkState();
    if (linkState === 'linked') this.clearDeLinkLatch();

    // #2387 — discharge any terminal send alert whose enqueue was rejected.
    // Placed with the latch clear for the same reason: it must run ABOVE both
    // early returns below, because the row it speaks for is already `failed`
    // and can never appear in the candidate query again. Not gated on link
    // state — an alert travels to the bot-errors outbox, not over WhatsApp.
    this.drainTerminalAlertAuthority();

    // Fetch pending rows whose scheduled_at (one-shot) or next_run_at (recurring)
    // has passed, then claim each by id. Fetching ids first and updating by id
    // ensures we only process rows we explicitly claimed in this tick —
    // pre-existing 'processing' rows (from a crash before recoverStale() ran)
    // are left alone.
    const candidates = this.db.raw
      .prepare(
        `SELECT id, chat_jid, content_type, payload, retry_count, media_blob, recurrence, next_run_at, run_count, timezone
         FROM scheduled_messages
         WHERE status = 'pending'
           AND (
             (recurrence IS NULL AND scheduled_at <= ?)
             OR (recurrence IS NOT NULL AND next_run_at IS NOT NULL AND next_run_at <= ?)
           )`,
      )
      .all(now, now) as unknown as ScheduledRow[];

    if (candidates.length === 0) return;

    // #1779 — fire-time link-state gate. A due send fired against a DE-LINKED
    // instance (logged out / device-bond lost, e.g. an instance left de-linked
    // for weeks) must NOT be accepted-then-silently-burned: hold it pending
    // re-link and raise a loud producer signal. A TRANSIENT reconnect blip is
    // distinguished and still processed (keep trying); unknown transports (no
    // link state) are never gated.
    if (linkState === 'delinked') {
      this.deferForDeLink(candidates, now);
      return;
    }

    // Claim by id to avoid touching pre-existing 'processing' rows
    const ids = candidates.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');
    this.db.raw
      .prepare(
        `UPDATE scheduled_messages SET status = 'processing'
         WHERE id IN (${placeholders}) AND status = 'pending'`,
      )
      .run(...ids);

    // Only process the rows we just claimed (re-fetch to confirm claimed status)
    const rows = this.db.raw
      .prepare(
        `SELECT id, chat_jid, content_type, payload, retry_count, media_blob, recurrence, next_run_at, run_count, timezone
         FROM scheduled_messages
         WHERE id IN (${placeholders}) AND status = 'processing'`,
      )
      .all(...ids) as unknown as ScheduledRow[];

    for (const row of rows) {
      const sendStartedAt = this.clock.nowUnixSec();
      const marked = this.db.raw
        .prepare(
          `UPDATE scheduled_messages
           SET send_started_at = ?
           WHERE id = ? AND status = 'processing'`,
        )
        .run(sendStartedAt, row.id).changes;
      if (marked === 0) continue;

      try {
        await this.executeSend(row);
      } catch (err) {
        this.handleSendFailure(row, err);
        continue;
      }

      const sentAt = this.clock.nowUnixSec();
      try {
        this.persistConfirmedSend(row, sentAt, sendStartedAt);
      } catch (err) {
        log.error(
          { event: 'scheduler_post_send_settlement_failed', id: row.id,
            recurring: row.recurrence !== null, attempts: 2, err },
          'scheduler: transport succeeded but SQLite settlement failed; retained processing marker',
        );
      }
    }
  }

  private runSettlementWithRetry(
    settle: () => number,
    alreadyApplied: () => boolean,
  ): void {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const changes = settle();
        if (changes === 1 || (changes === 0 && alreadyApplied())) return;
        throw new Error('scheduler: confirmed-send settlement ownership lost');
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  private persistConfirmedSend(row: ScheduledRow, sentAt: number, sendStartedAt: number): void {
    if (row.recurrence) {
      let nextRun: number;
      let skippedOccurrences = 0;
      let skippedOccurrencesCapped = false;
      try {
        const advanced = advanceRecurringRun(
          row.recurrence,
          row.next_run_at ?? sentAt,
          sentAt,
          row.timezone ?? 'UTC',
        );
        nextRun = advanced.nextRun;
        skippedOccurrences = advanced.skippedOccurrences;
        skippedOccurrencesCapped = advanced.capped;
      } catch (cronErr) {
        const error = `Invalid recurrence after send: ${errorMessage(cronErr)}`;
        const settle = () => Number(this.db.raw
          .prepare(
            `UPDATE scheduled_messages
             SET status = 'failed', sent_at = ?, error = ?, send_started_at = NULL
             WHERE id = ? AND status = 'processing' AND send_started_at = ?`,
          )
          .run(sentAt, error, row.id, sendStartedAt).changes);
        const alreadyApplied = () => {
          const current = this.db.raw.prepare(
            'SELECT status, sent_at, error, send_started_at FROM scheduled_messages WHERE id = ?',
          ).get(row.id) as { status: string; sent_at: number | null; error: string | null; send_started_at: number | null } | undefined;
          return current?.status === 'failed' && current.sent_at === sentAt && current.error === error && current.send_started_at === null;
        };
        this.runSettlementWithRetry(settle, alreadyApplied);
        log.error({ id: row.id, recurrence: row.recurrence, err: cronErr }, 'scheduler: invalid cron in DB, marked failed after send');
        return;
      }

      const settle = () => Number(this.db.raw
        .prepare(
          `UPDATE scheduled_messages
           SET status = 'pending', sent_at = ?, run_count = ?, next_run_at = ?, retry_count = 0, send_started_at = NULL
           WHERE id = ? AND status = 'processing' AND send_started_at = ?`,
        )
        .run(sentAt, row.run_count + 1, nextRun, row.id, sendStartedAt).changes);
      const alreadyApplied = () => {
        const current = this.db.raw.prepare(
          'SELECT status, sent_at, run_count, next_run_at, retry_count, send_started_at FROM scheduled_messages WHERE id = ?',
        ).get(row.id) as {
          status: string;
          sent_at: number | null;
          run_count: number;
          next_run_at: number | null;
          retry_count: number;
          send_started_at: number | null;
        } | undefined;
        return current?.status === 'pending' && current.sent_at === sentAt && current.run_count === row.run_count + 1 && current.next_run_at === nextRun && current.retry_count === 0 && current.send_started_at === null;
      };
      this.runSettlementWithRetry(settle, alreadyApplied);
      if (skippedOccurrences > 0) {
        log.warn(
          {
            id: row.id,
            chatJid: row.chat_jid,
            previousNextRun: row.next_run_at,
            sentAt,
            nextRun,
            skippedOccurrences,
            skippedOccurrencesCapped,
          },
          'scheduler: recurring message skipped missed occurrences after downtime',
        );
      }
      log.info({ id: row.id, chatJid: row.chat_jid, nextRun }, 'scheduler: recurring message sent, rescheduled');
      return;
    }

    const settle = () => Number(this.db.raw
      .prepare(
        `UPDATE scheduled_messages
         SET status = 'sent', sent_at = ?, send_started_at = NULL
         WHERE id = ? AND status = 'processing' AND send_started_at = ?`,
      )
      .run(sentAt, row.id, sendStartedAt).changes);
    const alreadyApplied = () => {
      const current = this.db.raw.prepare(
        'SELECT status, sent_at, send_started_at FROM scheduled_messages WHERE id = ?',
      ).get(row.id) as { status: string; sent_at: number | null; send_started_at: number | null } | undefined;
      return current?.status === 'sent' && current.sent_at === sentAt && current.send_started_at === null;
    };
    this.runSettlementWithRetry(settle, alreadyApplied);
    log.info({ id: row.id, chatJid: row.chat_jid }, 'scheduler: message sent');
  }

  /**
   * Classify the transport's link state for the fire-time gate. De-linked is the
   * TERMINAL logged-out / device-bond-lost state (a human must re-pair) — the
   * definitive signal is `lastDisconnectReason === 'loggedOut'` (Baileys maps
   * DisconnectReason.loggedOut → the 'loggedOut' key) or an absent/poisoned auth
   * bond. `connected` false without those is a transient reconnect blip. A
   * transport that exposes no snapshot is never gated (fail-safe 'unknown').
   */
  private assessLinkState(): LinkState {
    const getState = this.connection.getConnectionState;
    if (typeof getState !== 'function') return 'unknown';
    let snap: SchedulerConnectionState;
    try {
      snap = getState.call(this.connection);
    } catch {
      return 'unknown';
    }
    if (snap.connected) return 'linked';
    const deLinked =
      snap.lastDisconnectReason === 'loggedOut' ||
      snap.authBond?.status === 'missing' ||
      snap.authBond?.status === 'invalid';
    return deLinked ? 'delinked' : 'transient';
  }

  /**
   * #1779 — hold every due row for a de-linked instance instead of dropping it.
   * Rows stay `pending` (never claimed to `processing`, never burned to
   * `failed`); retry_count is untouched so a de-link can never walk a send to
   * permanent failure. They fire on the first tick after re-link. A loud,
   * latched owner alert (the producer-feedback seam shared with #1745) fires
   * once per de-link episode.
   */
  private deferForDeLink(candidates: ScheduledRow[], now: number): void {
    const ids = candidates.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');
    this.db.raw
      .prepare(
        `UPDATE scheduled_messages SET error = ?
         WHERE id IN (${placeholders}) AND status = 'pending'`,
      )
      .run(DELINK_HOLD_REASON, ...ids);

    log.warn(
      { heldCount: ids.length, ids, event: 'scheduler_delink_hold' },
      'scheduler: instance de-linked from WhatsApp; scheduled sends held until re-link (not dropped)',
    );

    if (!this.deLinkAlertEmitted && this.config.instance) {
      // #2415: arm the latch (and its durable marker) only on ACCEPTED
      // emission — a rejected enqueue must retry on the next tick, never
      // strand the episode alert-less behind a pre-armed latch.
      const accepted = emitAlertChecked(
        this.config.instance,
        'scheduler_delinked_send_held',
        `whatsoup@${this.config.instance} is DE-LINKED from WhatsApp (logged out) — holding ${ids.length} due scheduled send(s) until re-link; nothing dropped`,
        [
          `heldCount=${ids.length}`,
          `firstHeldId=${ids[0]}`,
          `detectedAt=${new Date(now * 1000).toISOString()}`,
          'ref: #1779 — a scheduled send fired against a de-linked instance was previously retried 3× then silently marked permanently-failed. It is now held pending re-link. Re-pair the WhatsApp link (auth CLI) to resume delivery, or delete the scheduled_messages row to cancel.',
        ].join('\n'),
        'warning',
      );
      if (accepted) {
        this.deLinkAlertEmitted = true;
        try {
          setRecoveryMarker(this.deLinkMarkerKey());
        } catch (err) {
          // intentional: marker durability is best-effort; the in-memory
          // latch still governs this process, only restart restoration degrades.
          log.warn({ err }, 'scheduler: de-link recovery marker write failed');
        }
      }
    }
  }

  /**
   * Clear the de-link owner alert once the instance is linked again (#2415).
   * The latch releases only on an ACCEPTED durable clear — a rejected enqueue
   * keeps it armed so the next linked tick retries (no orphaned incident).
   */
  private clearDeLinkLatch(): void {
    if (!this.deLinkAlertEmitted) return;
    if (this.config.instance) {
      const cleared = clearAlertSourceChecked(this.config.instance, 'scheduler_delinked_send_held');
      if (!cleared) {
        log.warn({ event: 'scheduler_relink_clear_rejected' }, 'scheduler: de-link clear enqueue rejected; retrying next linked tick');
        return;
      }
      try {
        clearRecoveryMarker(this.deLinkMarkerKey());
      } catch (err) {
        // intentional: marker cleanup is best-effort; a stale marker only
        // re-arms clear authority on a future restart (idempotent clear).
        log.warn({ err }, 'scheduler: de-link recovery marker clear failed');
      }
    }
    this.deLinkAlertEmitted = false;
    log.info({ event: 'scheduler_relinked' }, 'scheduler: instance re-linked; resuming scheduled sends');
  }

  /**
   * Emit the terminal `scheduler_send_failed` alert, RETAINING durable
   * notification authority if the checked enqueue is rejected (#2387).
   *
   * By the time this runs the row is `failed` and has left the due query, so a
   * discarded rejection has no retry owner at all: the operator alert for a
   * permanently dropped scheduled message would be lost for good, and silently.
   * A rejected enqueue therefore writes a marker that `drainTerminalAlertAuthority`
   * retries on a later tick.
   *
   * This is the de-link seam above (#2415) inverted. There an ACCEPTED emission
   * writes the marker, and the marker means "an alert is active"; here a
   * REJECTED emission writes it, and it means "an alert is still owed".
   */
  private emitTerminalSendAlert(failure: TerminalSendFailure): void {
    const instance = this.config.instance;
    if (!instance) return;

    const { summary, evidence } = terminalSendAlertText(instance, failure);
    if (emitAlertChecked(instance, 'scheduler_send_failed', summary, evidence, 'warning')) return;

    const key = this.terminalAlertMarkerKey(failure.scheduledId);
    try {
      // The alert just emitted carried the raw error, exactly as at baseline.
      // What goes to DISK is redacted: an undecodable payload puts its own first
      // bytes into the JSON.parse message, and clause 5 forbids those in the
      // record. A retry therefore re-emits the redacted form — the operator sees
      // the same failure, minus a payload fragment.
      setRecoveryMarker(key, { ...failure, error: redactErrorForMarker(failure.error) });
      this.pendingTerminalAlerts.add(key);
      log.warn(
        { event: 'scheduler_terminal_alert_retained', id: failure.scheduledId },
        'scheduler: terminal send alert enqueue rejected; notification authority retained for a later tick',
      );
    } catch (err) {
      // Loud, and error-level: the marker store is the ONLY owner left for this
      // notification, so a failed write is the moment the alert is actually lost.
      log.error(
        { err, event: 'scheduler_terminal_alert_authority_lost', id: failure.scheduledId },
        'scheduler: could not retain terminal send alert authority; the operator alert for a dropped message is lost',
      );
    }
  }

  /**
   * Re-emit terminal send alerts whose enqueue was previously rejected (#2387).
   *
   * Runs above BOTH of tick()'s early returns — the empty-candidates return and
   * the de-linked return — for the same reason clearDeLinkLatch() does: the rows
   * these alerts speak for are terminal, so anywhere below either gate the
   * obligation would only be discharged when unrelated work happened to be due.
   *
   * Re-emits the ALERT alone. Nothing here reads or writes scheduled_messages,
   * which is what makes "do not replay the scheduled send merely to recreate an
   * alert" structural rather than a promise.
   */
  private drainTerminalAlertAuthority(): void {
    const instance = this.config.instance;
    if (!instance) return;

    for (const key of this.retainedTerminalAlertKeys()) {
      if (this.deliveredUnclearable.has(key)) {
        // Delivered already; only the clear is still owed. Retry it and say
        // nothing further — the entry warned once when it was recorded.
        if (this.discardTerminalAlertMarker(key)) {
          this.deliveredUnclearable.delete(key);
          log.info(
            { event: 'scheduler_terminal_alert_marker_cleared_late', key },
            'scheduler: previously unclearable terminal send alert marker cleared',
          );
        }
        continue;
      }

      const stored = readRecoveryMarkerState(key);

      if (stored.state === 'missing') {
        // The end of a marker's normal life: the clear landed, or another
        // process discharged it. Nothing owed and nothing wrong.
        this.pendingTerminalAlerts.delete(key);
        continue;
      }

      if (stored.state === 'unreadable') {
        // Bytes exist that this process could not read. Never unlink what could
        // not be interpreted — the same rule readLegacyMarkersStrict follows in
        // the store — so the obligation stays on disk for a luckier reader.
        this.pendingTerminalAlerts.delete(key);
        log.warn(
          { event: 'scheduler_terminal_alert_marker_unusable', key, reason: 'unreadable' },
          'scheduler: retained terminal send alert could not be read; leaving the marker in place',
        );
        continue;
      }

      const failure = stored.state === 'ok' ? parseTerminalSendFailure(stored.payload) : null;
      if (failure === null) {
        // Bytes were read and can never render an alert. Discarding is safe here
        // precisely because they were seen.
        this.pendingTerminalAlerts.delete(key);
        log.warn(
          { event: 'scheduler_terminal_alert_marker_unusable', key, reason: stored.state === 'ok' ? 'unparseable' : 'invalid' },
          'scheduler: retained terminal send alert is not re-emittable; discarding the marker',
        );
        this.discardTerminalAlertMarker(key);
        continue;
      }

      const { summary, evidence } = terminalSendAlertText(instance, failure);
      if (!emitAlertChecked(instance, 'scheduler_send_failed', summary, evidence, 'warning')) {
        continue; // still owed; the next tick retries
      }
      this.pendingTerminalAlerts.delete(key);
      if (!this.discardTerminalAlertMarker(key)) this.noteUnclearable(key);
      log.info(
        { event: 'scheduler_terminal_alert_drained', id: failure.scheduledId },
        'scheduler: retained terminal send alert delivered',
      );
    }
  }

  /**
   * Terminal-alert keys still owed, re-derived from the marker directory and
   * unioned with what this process wrote.
   *
   * Disk is the source of truth on every tick, not just at construction. The
   * directory scan returns an EMPTY set rather than throwing when it fails, so a
   * seed taken once could not distinguish a failed read from "nothing owed" — and
   * these rows are terminal, so no later event could ever re-seed it. Re-deriving
   * costs one readdir of a directory holding one entry per active alert, and it
   * makes the drain a function of durable state rather than of process history.
   */
  private retainedTerminalAlertKeys(): string[] {
    const prefix = this.terminalAlertMarkerPrefix();
    const keys = new Set(this.pendingTerminalAlerts);
    try {
      for (const key of loadRecoveryMarkers()) {
        if (key.startsWith(prefix)) keys.add(key);
      }
    } catch {
      // intentional: an unreadable store leaves this process's own writes as the
      // only view; the next tick re-derives from disk again.
    }
    return [...keys];
  }

  /** Clear one marker. False means the bytes are still on disk. */
  private discardTerminalAlertMarker(key: string): boolean {
    try {
      clearRecoveryMarker(key);
      return true;
    } catch (err) {
      // Quiet here on purpose: this runs on every tick while the store is
      // faulted, and the loud line belongs at the moment the condition STARTS
      // (noteUnclearable), not once per retry.
      log.debug({ err, key }, 'scheduler: terminal send alert marker clear failed');
      return false;
    }
  }

  /**
   * Record that a delivered alert's marker could not be cleared, once (#2387).
   *
   * Before this, a failed clear left the marker on disk and the per-tick
   * re-derivation re-emitted the alert every tick for as long as the store
   * stayed faulted — over-notification with no restart involved. Suppressing the
   * re-emission is process-local, which is the correct scope: it says only
   * "I already sent this", never "nothing is owed". Disk keeps the obligation,
   * so a restart re-emits once and a healed store clears on the next tick.
   */
  private noteUnclearable(key: string): void {
    if (this.deliveredUnclearable.has(key)) return;
    this.deliveredUnclearable.add(key);
    log.warn(
      { event: 'scheduler_terminal_alert_marker_unclearable', key },
      'scheduler: terminal send alert delivered but its marker could not be cleared; '
      + 'suppressing re-emission in this process and retrying the clear each tick',
    );
  }

  private handleSendFailure(row: ScheduledRow, err: unknown): void {
    const newRetryCount = row.retry_count + 1;
    const errorMsg = errorMessage(err);

    // An undecodable payload is permanent: the same bytes fail identically on
    // every attempt, so the retry ladder can only delay the drop while
    // producing `maxRetries` indistinguishable warnings. Dead-letter it on the
    // first occurrence instead, with a reason that names the actual cause.
    //
    // This applies to recurring rows too. The recurrence-preservation path
    // below deliberately refuses to destroy a schedule over transient
    // per-occurrence failures — but a corrupt payload is not transient, and
    // advancing to the next slot would re-fail forever rather than heal.
    if (err instanceof ScheduledPayloadError) {
      this.db.raw
        .prepare(
          `UPDATE scheduled_messages
           SET status = 'failed', retry_count = ?, error = ?, send_started_at = NULL
           WHERE id = ?`,
        )
        .run(row.retry_count, errorMsg, row.id);
      log.error(
        { event: 'scheduler_payload_undecodable', id: row.id, recurring: row.recurrence !== null, err },
        'scheduler: scheduled payload is undecodable; dead-lettered without retry',
      );
      this.emitTerminalSendAlert({
        kind: 'payload_undecodable',
        scheduledId: row.id,
        error: errorMsg,
        recurring: row.recurrence !== null,
      });
      return;
    }

    if (newRetryCount >= this.config.maxRetries) {
      if (row.recurrence) {
        // Recurring: a recurring schedule must not be permanently destroyed by
        // transient per-occurrence failures. Skip the current occurrence, advance to
        // the next cron slot, and reset retry_count so failures don't accumulate
        // across occurrences. Only mark 'failed' if the next slot is uncomputable.
        let nextRun: number | null = null;
        let skippedOccurrences = 0;
        let skippedOccurrencesCapped = false;
        try {
          const now = this.clock.nowUnixSec();
          const advanced = advanceRecurringRun(
            row.recurrence,
            row.next_run_at ?? now,
            now,
            row.timezone ?? 'UTC',
          );
          nextRun = advanced.nextRun;
          skippedOccurrences = advanced.skippedOccurrences;
          skippedOccurrencesCapped = advanced.capped;
        } catch {
          nextRun = null;
        }
        if (nextRun !== null) {
          this.db.raw
            .prepare(
              `UPDATE scheduled_messages
               SET status = 'pending', retry_count = 0, next_run_at = ?, error = ?, send_started_at = NULL
               WHERE id = ?`,
            )
            .run(nextRun, `Occurrence skipped after ${newRetryCount} failures: ${errorMsg}`, row.id);
          log.warn(
            {
              id: row.id,
              retries: newRetryCount,
              nextRun,
              skippedOccurrences,
              skippedOccurrencesCapped,
              err,
            },
            'scheduler: recurring occurrence failed, skipped to next slot',
          );
        } else {
          this.db.raw
            .prepare(
              `UPDATE scheduled_messages
               SET status = 'failed', retry_count = ?, error = ?, send_started_at = NULL
               WHERE id = ?`,
            )
            .run(newRetryCount, `Recurring failed (cannot compute next slot): ${errorMsg}`, row.id);
          log.warn(
            { id: row.id, retries: newRetryCount, err },
            'scheduler: recurring message permanently failed (invalid cron)',
          );
        }
      } else {
        this.db.raw
          .prepare(
            `UPDATE scheduled_messages
             SET status = 'failed', retry_count = ?, error = ?, send_started_at = NULL
             WHERE id = ?`,
          )
          .run(newRetryCount, errorMsg, row.id);
        log.warn({ id: row.id, retries: newRetryCount, err }, 'scheduler: message permanently failed');
        // #1779 remediation #3 — a permanent one-shot drop must be LOUD, not
        // merely a log line found later by log mining. This is also the backstop
        // for a de-link the fire-time gate could not classify (e.g. an SMS
        // transport with no link-state snapshot, or creds rejected with no
        // logout event this lifetime).
        this.emitTerminalSendAlert({
          kind: 'retry_exhausted',
          scheduledId: row.id,
          error: errorMsg,
          attempts: newRetryCount,
        });
      }
    } else {
      this.db.raw
        .prepare(
          `UPDATE scheduled_messages
           SET status = 'pending', retry_count = ?, send_started_at = NULL
           WHERE id = ?`,
        )
        .run(newRetryCount, row.id);
      log.warn({ id: row.id, retryCount: newRetryCount, err }, 'scheduler: message send failed, will retry');
    }
  }

  private async executeSend(row: ScheduledRow): Promise<void> {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.payload) as Record<string, unknown>;
    } catch (err) {
      // Tagged so handleSendFailure can tell "this row can never send" from
      // "the transport is having a bad minute".
      throw new ScheduledPayloadError(errorMessage(err));
    }

    if (row.content_type === 'text') {
      await this.connection.sendRaw(row.chat_jid, payload);
    } else {
      // media types: image, video, audio, document, sticker
      const { type, ...rest } = payload as { type: string; [key: string]: unknown };

      // SP9: media is stored as a BLOB column, not in the JSON payload
      let buf: Buffer;
      if (row.media_blob) {
        buf = Buffer.from(row.media_blob);
      } else {
        // Legacy fallback: deserialize Buffer from JSON payload
        const { buffer: bufferData, ...legacyRest } = rest as {
          buffer?: { type: 'Buffer'; data: number[] } | number[];
          [key: string]: unknown;
        };
        if (bufferData && typeof bufferData === 'object' && 'data' in bufferData) {
          buf = Buffer.from((bufferData as { type: 'Buffer'; data: number[] }).data);
        } else if (Array.isArray(bufferData)) {
          buf = Buffer.from(bufferData as number[]);
        } else {
          throw new Error(`scheduler: no media_blob and no buffer in payload for id=${row.id}`);
        }
        Object.assign(rest, legacyRest);
      }

      await this.connection.sendMedia(row.chat_jid, { type, buffer: buf, ...rest } as OutboundMedia);
    }
  }
}
