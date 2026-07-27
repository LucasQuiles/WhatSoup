// src/core/scheduler.ts
// SP11 — Message Scheduling: tick-based scheduler that sends pending scheduled_messages.

import { createChildLogger } from '../logger.ts';
import type { Database } from './database.ts';
import type { SubmissionReceipt, OutboundMedia } from './types.ts';
import { nextCronRun } from './cron.ts';
import { nowUnixSec } from '../fleet/time-utils.ts';
import { errorMessage } from '../lib/error-message.ts';
import { emitAlertChecked } from '../lib/emit-alert.ts';

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

export class MessageScheduler {
  private timer: NodeJS.Timeout | null = null;
  private db: Database;
  private connection: SchedulerConnection;
  private config: { intervalMs: number; maxRetries: number; instance?: string };

  /**
   * #1779 latch: true once the de-linked-hold owner alert has fired for the
   * current de-link episode. Re-armed by clearDeLinkLatch() on the first linked
   * tick (evaluated before the empty-candidates return, so it clears even in an
   * idle window) — a later de-link alerts again, but a persistent outage alerts
   * only once (mirrors ConnectionManager.loggedOutAlertEmitted, which clears
   * unconditionally on the 'open' event).
   */
  private deLinkAlertEmitted = false;

  constructor(
    db: Database,
    connection: SchedulerConnection,
    config: { intervalMs: number; maxRetries: number; instance?: string },
  ) {
    this.db = db;
    this.connection = connection;
    this.config = config;
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
      const now = nowUnixSec();
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
    const now = nowUnixSec();

    // #1779 — assess transport link state up front. Clearing the de-link alert
    // latch here, BEFORE the empty-candidates early return, re-arms it on
    // re-link even during a window with no due message — matching
    // ConnectionManager.loggedOutAlertEmitted, which clears on the 'open' event
    // unconditionally rather than being gated on scheduler activity. Without
    // this, a re-link during an idle window would leave the latch stuck and a
    // later de-link episode would hold sends without alerting.
    const linkState = this.assessLinkState();
    if (linkState === 'linked') this.clearDeLinkLatch();

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
      const sendStartedAt = nowUnixSec();
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

      const sentAt = nowUnixSec();
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
      this.deLinkAlertEmitted = true;
      emitAlertChecked(
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
    }
  }

  /** Re-arm the de-link alert latch once the instance is linked again. */
  private clearDeLinkLatch(): void {
    if (!this.deLinkAlertEmitted) return;
    this.deLinkAlertEmitted = false;
    log.info({ event: 'scheduler_relinked' }, 'scheduler: instance re-linked; resuming scheduled sends');
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
      if (this.config.instance) {
        emitAlertChecked(
          this.config.instance,
          'scheduler_send_failed',
          `whatsoup@${this.config.instance} dead-lettered scheduled send (id ${row.id}) — stored payload is undecodable, message DROPPED: ${errorMsg}`,
          [
            `scheduledId=${row.id}`,
            `recurring=${row.recurrence !== null}`,
            `error=${errorMsg}`,
            'ref: #2359 — an undecodable payload is permanent, so it is dead-lettered on the first occurrence rather than consuming the retry budget. Inspect the scheduled_messages row; the payload column is not valid JSON.',
          ].join('\n'),
          'warning',
        );
      }
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
          const now = nowUnixSec();
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
        if (this.config.instance) {
          emitAlertChecked(
            this.config.instance,
            'scheduler_send_failed',
            `whatsoup@${this.config.instance} permanently failed a scheduled send (id ${row.id}) after ${newRetryCount} attempts — message DROPPED: ${errorMsg}`,
            [
              `scheduledId=${row.id}`,
              `attempts=${newRetryCount}`,
              `error=${errorMsg}`,
              'ref: #1779 remediation #3 — a permanent scheduled-send drop is now surfaced as an alert. If the transport is de-linked, re-pair the WhatsApp link; otherwise inspect the send error.',
            ].join('\n'),
            'warning',
          );
        }
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
