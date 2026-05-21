// src/core/substrate/poller.ts
//
// Substrate slice-3 trigger poller. Drains `bead_triggers.next_fire_at` on
// an interval, runs per-kind executors, writes `trigger_runs`, dispatches
// notifications to the trigger's `report_chat_jid`, and handles
// `terminal_at` expiry.
//
// Scope (per maintainer scoping decision, 2026-05-19):
//   - poll.sqlite     — workhorse kind for personal-line watches
//   - schedule.cron   — fires on cron expression
//   - schedule.at_time — one-shot at fire_at, expires after
//   - terminal_at expiry — sets status='expired', fires on_terminal action
//
// Other kinds in SPEC_REGISTRY (poll.shell, poll.url, poll.email,
// poll.file, poll.pinecone, event.message) are recognised but not yet
// executed; the poller logs a warn and bumps `next_fire_at` so the row
// does not hot-loop. Their executors are tracked as follow-up work.

import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { nowUnixSec } from './time.ts';
import { dueTriggers, validateTriggerSpec } from './triggers.ts';
import { TERMINAL } from './beads.ts';
import { writeBeadEvent } from './events.ts';
import { nextCronRun } from '../cron.ts';
import type { BeadStatus, TriggerKind, TriggerRow } from './types.ts';
import type { Messenger } from '../types.ts';
import { createChildLogger } from '../../logger.ts';

const log = createChildLogger('substrate.trigger-poller');

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_BATCH_SIZE = 50;
/** Cooldown applied when a kind is not yet implemented — avoids tight loops. */
const NOT_IMPLEMENTED_COOLDOWN_SEC = 3_600;
/** Cooldown applied after a transient failure so the poller does not spin. */
const FAILED_RETRY_COOLDOWN_SEC = 60;
/** Auto-pause a trigger after this many consecutive failed runs. */
const MAX_CONSECUTIVE_FAILURES = 5;
/** Minimum seconds between WhatsApp notifications per trigger. */
const NOTIFICATION_THROTTLE_MIN_INTERVAL_SEC = 300;

export interface TriggerPollerOptions {
  /** How often to call dueTriggers. Default 30s. */
  intervalMs?: number;
  /** Max triggers fetched per tick. Default 50. */
  batchSize?: number;
  /** Injectable clock for tests. Returns unix seconds. */
  now?: () => number;
  /** Injectable timers for tests. */
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
  /** Auto-pause threshold for consecutive failed runs. Default 5. */
  maxConsecutiveFailures?: number;
  /** Minimum seconds between dispatches per trigger. Default 300 (5 min). */
  notificationThrottleMinIntervalSec?: number;
}

interface SqliteSpec {
  sql: string;
  binds?: Record<string, unknown>;
  fire_when: 'rows_returned' | 'rowcount_changed';
}

interface ExecuteOutcome {
  status: 'ok' | 'noop' | 'failed';
  fired: boolean;
  outputSummary: string;
  outputJson: Record<string, unknown>;
  errorKind?: string;
  errorMessage?: string;
}

interface PostCommitActions {
  pauseNotificationFailureCount?: number;
}

export class TriggerPoller {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly db: DatabaseSync;
  private readonly messenger: Messenger;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly nowFn: () => number;
  private readonly setTimeoutImpl: typeof setTimeout;
  private readonly clearTimeoutImpl: typeof clearTimeout;
  private readonly maxConsecutiveFailures: number;
  private readonly notificationThrottleMinIntervalSec: number;
  public lastRunAt: string | null = null;

  constructor(db: DatabaseSync, messenger: Messenger, opts: TriggerPollerOptions = {}) {
    this.db = db;
    this.messenger = messenger;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
    this.nowFn = opts.now ?? nowUnixSec;
    this.setTimeoutImpl = opts.setTimeoutImpl ?? setTimeout;
    this.clearTimeoutImpl = opts.clearTimeoutImpl ?? clearTimeout;
    this.maxConsecutiveFailures = opts.maxConsecutiveFailures ?? MAX_CONSECUTIVE_FAILURES;
    this.notificationThrottleMinIntervalSec = opts.notificationThrottleMinIntervalSec ?? NOTIFICATION_THROTTLE_MIN_INTERVAL_SEC;
  }

  start(): void {
    if (this.timer !== null) {
      log.warn(
        { intervalMs: this.intervalMs, batchSize: this.batchSize },
        'TriggerPoller.start() called while already running',
      );
      return;
    }
    this.stopped = false;
    log.info({ intervalMs: this.intervalMs, batchSize: this.batchSize }, 'trigger poller starting');
    this.scheduleNext();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      this.clearTimeoutImpl(this.timer);
      this.timer = null;
      log.info({ intervalMs: this.intervalMs }, 'trigger poller stopped');
    }
  }

  /**
   * Run one cycle synchronously. Returns the number of triggers processed
   * (sum of expirations + dispatched runs). Public for tests; production
   * code goes through start()/tick().
   */
  async tickOnce(): Promise<number> {
    const now = this.nowFn();
    let processed = 0;
    // 1. Expiry sweep — dueTriggers filters out triggers past terminal_at,
    //    so without this sweep they would stay status='active' forever.
    const overdue = this.db.prepare(
      `SELECT * FROM bead_triggers
       WHERE status = 'active' AND terminal_at IS NOT NULL AND terminal_at <= ?
       LIMIT ?`,
    ).all(now, this.batchSize) as unknown as TriggerRow[];
    for (const t of overdue) {
      try {
        this.expireTrigger(t, now);
        processed++;
      } catch (err) {
        log.error({ err, triggerId: t.id }, 'trigger expiry failed unexpectedly');
      }
    }
    // 2. Due triggers — normal poll/schedule execution path.
    const due = dueTriggers(this.db, now, this.batchSize);
    for (const t of due) {
      try {
        await this.processTrigger(t, now);
        processed++;
      } catch (err) {
        log.error(
          { err, triggerId: t.id, kind: t.kind },
          'trigger run failed unexpectedly',
        );
      }
    }
    this.lastRunAt = new Date(now * 1000).toISOString();
    return processed;
  }

  private scheduleNext(): void {
    this.timer = this.setTimeoutImpl(() => void this.tick(), this.intervalMs);
  }

  private async tick(): Promise<void> {
    this.timer = null;
    try {
      await this.tickOnce();
    } catch (err) {
      log.error({ err }, 'unexpected error in tick — rescheduling');
    }
    if (!this.stopped) this.scheduleNext();
  }

  private async processTrigger(t: TriggerRow, now: number): Promise<void> {
    // Terminal-at expiry is handled by the expiry sweep in tickOnce; dueTriggers
    // already filters out rows past terminal_at, so we should never see one here.
    let outcome: ExecuteOutcome;
    try {
      outcome = await this.executeTrigger(t);
    } catch (err) {
      outcome = {
        status: 'failed',
        fired: false,
        outputSummary: 'executor threw',
        outputJson: {},
        errorKind: 'execute_throw',
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }

    let shouldDispatchNotification = false;
    if (outcome.fired) {
      const throttleRemaining = this.throttleRemainingFor(t.id, now);
      if (throttleRemaining > 0) {
        // Suppress the WhatsApp dispatch but still record fired=true on the
        // run with a throttled marker. Operators inspecting trigger_runs see
        // that the watch matched without their report chat getting spammed.
        outcome.outputJson = {
          ...outcome.outputJson,
          throttled: true,
          throttleRemainingSec: throttleRemaining,
        };
      } else {
        shouldDispatchNotification = true;
      }
    }

    const finishedAt = this.nowFn();
    let runId = 0;
    const postCommitActions: PostCommitActions = {};
    this.db.exec('BEGIN');
    try {
      runId = this.insertRun(t, now);
      this.finishRun(runId, now, finishedAt, outcome, null);
      this.scheduleNextFire(t, now, outcome, postCommitActions);
      this.db.exec('COMMIT');
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* best effort */ }
      throw err;
    }

    if (postCommitActions.pauseNotificationFailureCount != null) {
      await this.dispatchPauseNotification(t, postCommitActions.pauseNotificationFailureCount);
    }
    if (shouldDispatchNotification) {
      // Notification dispatch is intentionally post-commit. A crash between
      // COMMIT and sendMessage is at-most-once delivery for this poller tick.
      const deliveredWaId = await this.dispatchNotification(t, outcome);
      if (deliveredWaId) {
        try {
          this.recordDeliveredWaMessageId(runId, deliveredWaId);
        } catch (err) {
          log.error({ err, triggerId: t.id, runId }, 'failed to record trigger notification receipt');
        }
      }
    }
  }

  /**
   * Seconds remaining until the next dispatch is allowed for this trigger.
   * 0 means no throttle (no prior dispatch in trigger_runs, or window elapsed).
   */
  private throttleRemainingFor(triggerId: number, now: number): number {
    const row = this.db.prepare(
      `SELECT started_at FROM trigger_runs
       WHERE trigger_id = ? AND status = 'ok' AND output_json LIKE '%deliveredWaMessageId%'
       ORDER BY started_at DESC, id DESC
       LIMIT 1`,
    ).get(triggerId) as { started_at: number } | undefined;
    if (!row) return 0;
    const elapsed = now - row.started_at;
    if (elapsed >= this.notificationThrottleMinIntervalSec) return 0;
    return this.notificationThrottleMinIntervalSec - elapsed;
  }

  private async executeTrigger(t: TriggerRow): Promise<ExecuteOutcome> {
    const kind = t.kind as TriggerKind;
    let spec: unknown;
    try {
      spec = JSON.parse(t.spec_json);
    } catch (err) {
      return {
        status: 'failed',
        fired: false,
        outputSummary: 'spec_json is not valid JSON',
        outputJson: {},
        errorKind: 'spec_parse',
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
    try {
      spec = validateTriggerSpec(kind, spec);
    } catch (err) {
      return {
        status: 'failed',
        fired: false,
        outputSummary: 'spec_json failed SPEC_REGISTRY validation',
        outputJson: { kind },
        errorKind: 'spec_invalid',
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }

    if (kind === 'poll.sqlite') return this.executeSqlite(t, spec as SqliteSpec);
    if (kind === 'schedule.cron' || kind === 'schedule.at_time') {
      return {
        status: 'ok',
        fired: true,
        outputSummary: kind === 'schedule.at_time' ? 'scheduled one-shot fired' : 'cron tick fired',
        outputJson: { kind },
      };
    }
    // Other kinds: recognised but not yet wired.
    return {
      status: 'noop',
      fired: false,
      outputSummary: `kind ${kind} not yet implemented`,
      outputJson: { kind, reason: 'not_implemented' },
    };
  }

  private executeSqlite(t: TriggerRow, spec: SqliteSpec): ExecuteOutcome {
    let rows: Record<string, unknown>[];
    try {
      // Operator-stored SQL runs against the live bot.db. Bound the blast
      // radius of a compromised or confused-deputy spec by flipping the
      // connection to read-only for the duration of this query. The OFF
      // restoration MUST be in finally so the poller's own follow-up writes
      // (UPDATE bead_triggers, INSERT trigger_runs) still succeed.
      this.db.exec('PRAGMA query_only = ON');
      try {
        const stmt = this.db.prepare(spec.sql);
        const bindArgs = spec.binds ? toBindArgs(spec.binds) : [];
        rows = stmt.all(...bindArgs) as unknown as Record<string, unknown>[];
      } finally {
        this.db.exec('PRAGMA query_only = OFF');
      }
    } catch (err) {
      return {
        status: 'failed',
        fired: false,
        outputSummary: 'SQL execution failed',
        outputJson: { sql: spec.sql },
        errorKind: 'sql_error',
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
    const rowCount = rows.length;

    if (spec.fire_when === 'rows_returned') {
      return {
        status: rowCount > 0 ? 'ok' : 'noop',
        fired: rowCount > 0,
        outputSummary: rowCount > 0
          ? `SQL returned ${rowCount} row${rowCount === 1 ? '' : 's'}`
          : 'SQL returned 0 rows',
        outputJson: { rowCount, sampleRow: rows[0] ?? null },
      };
    }

    // rowcount_changed: compare to the previous run's rowCount.
    const lastRowCount = this.lastRowCountFor(t.id);
    const changed = lastRowCount === null ? rowCount > 0 : rowCount !== lastRowCount;
    return {
      status: changed ? 'ok' : 'noop',
      fired: changed,
      outputSummary: changed
        ? `rowcount changed: ${lastRowCount ?? 'first run'} -> ${rowCount}`
        : `rowcount unchanged at ${rowCount}`,
      outputJson: { rowCount, lastRowCount },
    };
  }

  private lastRowCountFor(triggerId: number): number | null {
    const row = this.db.prepare(
      `SELECT output_json FROM trigger_runs
       WHERE trigger_id = ? AND status IN ('ok','noop')
       ORDER BY started_at DESC
       LIMIT 1`,
    ).get(triggerId) as { output_json: string | null } | undefined;
    if (!row?.output_json) return null;
    try {
      const parsed = JSON.parse(row.output_json) as { rowCount?: unknown };
      return typeof parsed.rowCount === 'number' ? parsed.rowCount : null;
    } catch {
      return null;
    }
  }

  private async dispatchNotification(t: TriggerRow, outcome: ExecuteOutcome): Promise<string | null> {
    const text = formatNotification(t, outcome);
    try {
      const receipt = await this.messenger.sendMessage(t.report_chat_jid, text);
      return receipt.waMessageId ?? null;
    } catch (err) {
      log.error(
        { err, triggerId: t.id, reportChatJid: t.report_chat_jid },
        'failed to dispatch trigger notification',
      );
      return null;
    }
  }

  private insertRun(t: TriggerRow, startedAt: number): number {
    const info = this.db.prepare(
      `INSERT INTO trigger_runs (
         trigger_id, bead_id, status, started_at, attempt, metadata_json
       ) VALUES (?, ?, 'running', ?, 1, '{}')`,
    ).run(t.id, t.bead_id, startedAt);
    return Number(info.lastInsertRowid);
  }

  private finishRun(
    runId: number,
    startedAt: number,
    finishedAt: number,
    outcome: ExecuteOutcome,
    deliveredWaId: string | null,
  ): void {
    const durationMs = Math.max(0, (finishedAt - startedAt) * 1000);
    const outputJson = deliveredWaId
      ? { ...outcome.outputJson, deliveredWaMessageId: deliveredWaId }
      : outcome.outputJson;
    this.db.prepare(
      `UPDATE trigger_runs
       SET status = ?, finished_at = ?, duration_ms = ?,
           output_summary = ?, output_json = ?,
           error_kind = ?, error_message = ?
       WHERE id = ?`,
    ).run(
      outcome.status,
      finishedAt,
      durationMs,
      outcome.outputSummary,
      JSON.stringify(outputJson),
      outcome.errorKind ?? null,
      outcome.errorMessage ?? null,
      runId,
    );
  }

  private recordDeliveredWaMessageId(runId: number, deliveredWaId: string): void {
    this.db.prepare(
      `UPDATE trigger_runs
       SET output_json = json_set(COALESCE(output_json, '{}'), '$.deliveredWaMessageId', ?)
       WHERE id = ?`,
    ).run(deliveredWaId, runId);
  }

  private scheduleNextFire(
    t: TriggerRow,
    now: number,
    outcome: ExecuteOutcome,
    postCommitActions: PostCommitActions,
  ): void {
    let nextFireAt: number | null = null;

    if (t.kind === 'schedule.at_time') {
      // One-shot: expire after firing rather than rescheduling.
      this.markExpired(t, now, 'one_shot_completed');
      return;
    }

    if (t.kind === 'schedule.cron') {
      try {
        const parsed = JSON.parse(t.spec_json) as { expr: string };
        nextFireAt = nextCronRun(parsed.expr, now);
      } catch (err) {
        log.error({ err, triggerId: t.id }, 'cron next-fire computation failed');
        nextFireAt = now + FAILED_RETRY_COOLDOWN_SEC;
      }
    } else if (outcome.outputJson.reason === 'not_implemented') {
      nextFireAt = now + NOT_IMPLEMENTED_COOLDOWN_SEC;
    } else if (outcome.status === 'failed') {
      // Circuit breaker: count consecutive failures including this one.
      // If we've hit the threshold, pause the trigger instead of scheduling
      // another retry — otherwise auto-compact-style retry storms blow up
      // when a target table disappears or a remote service stays down.
      const consecutiveFailures = this.countConsecutiveFailures(t.id);
      if (consecutiveFailures >= this.maxConsecutiveFailures) {
        if (this.markPausedOnFailures(t, now, consecutiveFailures)) {
          postCommitActions.pauseNotificationFailureCount = consecutiveFailures;
        }
        return;
      }
      nextFireAt = now + FAILED_RETRY_COOLDOWN_SEC;
    } else if (t.interval_seconds && t.interval_seconds > 0) {
      nextFireAt = now + t.interval_seconds;
    } else {
      // No interval and not a schedule — disable to avoid re-firing.
      nextFireAt = null;
    }

    this.db.prepare(
      `UPDATE bead_triggers
       SET next_fire_at = ?, last_fire_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(nextFireAt, now, now, t.id);
  }

  /**
   * Counts consecutive failed runs in trigger_runs, ordered by most recent
   * first, stopping at the first non-failed run. A successful or noop run
   * resets the implicit counter.
   */
  private countConsecutiveFailures(triggerId: number): number {
    const recent = this.db.prepare(
      `SELECT status FROM trigger_runs
       WHERE trigger_id = ?
       ORDER BY started_at DESC, id DESC
       LIMIT ?`,
    ).all(triggerId, this.maxConsecutiveFailures) as Array<{ status: string }>;
    let count = 0;
    for (const row of recent) {
      if (row.status === 'failed') count++;
      else break;
    }
    return count;
  }

  private markPausedOnFailures(t: TriggerRow, now: number, failureCount: number): boolean {
    this.db.prepare(
      `UPDATE bead_triggers
       SET status = 'paused', next_fire_at = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(now, t.id);
    writeBeadEvent(this.db, {
      beadId: t.bead_id,
      eventType: 'trigger_paused',
      actor: 'trigger-poller',
      payload: { trigger_id: t.id, reason: 'consecutive_failures', failure_count: failureCount },
      at: now,
    });
    return t.on_terminal !== 'silent';
  }

  private async dispatchPauseNotification(t: TriggerRow, failureCount: number): Promise<void> {
    try {
      await this.messenger.sendMessage(
        t.report_chat_jid,
        formatPauseNotification(t, failureCount),
      );
    } catch (err) {
      log.error({ err, triggerId: t.id }, 'failed to dispatch pause notification');
    }
  }

  private expireTrigger(t: TriggerRow, now: number): void {
    let shouldDispatchExpiryNotification = false;
    this.db.exec('BEGIN');
    try {
      shouldDispatchExpiryNotification = this.markExpired(t, now, 'terminal_at_reached');
      this.db.exec('COMMIT');
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* best effort */ }
      throw err;
    }
    if (shouldDispatchExpiryNotification) {
      void this.messenger.sendMessage(
        t.report_chat_jid,
        formatExpiryNotification(t, 'terminal_at_reached'),
      ).catch((err: unknown) => {
        log.error({ err, triggerId: t.id }, 'failed to dispatch expiry notification');
      });
    }
  }

  /**
   * Reasons that should NOT trigger an on_terminal='notify' message because
   * the trigger just successfully fired and the user already received the
   * fire notification. Adding a second "expired" message would double-notify.
   */
  private static readonly SILENT_EXPIRY_REASONS = new Set(['one_shot_completed']);

  private markExpired(t: TriggerRow, now: number, reason: string): boolean {
    this.db.prepare(
      `UPDATE bead_triggers
       SET status = 'expired', next_fire_at = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(now, t.id);
    writeBeadEvent(this.db, {
      beadId: t.bead_id,
      eventType: 'trigger_expired',
      actor: 'trigger-poller',
      payload: { trigger_id: t.id, reason, on_terminal: t.on_terminal },
      at: now,
    });
    this.db.prepare(
      `INSERT INTO trigger_runs (
         trigger_id, bead_id, status, started_at, finished_at, duration_ms,
         output_summary, output_json, attempt, metadata_json
       ) VALUES (?, ?, 'terminal_fired', ?, ?, 0, ?, ?, 1, '{}')`,
    ).run(
      t.id, t.bead_id, now, now,
      `trigger expired: ${reason}`,
      JSON.stringify({ reason, on_terminal: t.on_terminal }),
    );
    if (t.on_terminal === 'reopen_bead') {
      this.reopenTerminalBead(t, now, reason);
    }
    return t.on_terminal === 'notify' && !TriggerPoller.SILENT_EXPIRY_REASONS.has(reason);
  }

  private reopenTerminalBead(t: TriggerRow, now: number, reason: string): void {
    const bead = this.db.prepare(
      `SELECT status FROM beads WHERE id = ?`,
    ).get(t.bead_id) as { status: BeadStatus } | undefined;
    if (!bead || !TERMINAL.includes(bead.status)) return;

    // This is the inverse of the normal terminal transition: transition()
    // intentionally rejects terminal beads, so reopen_bead writes the status
    // and matching status_change event directly inside the expiry transaction.
    this.db.prepare(
      `UPDATE beads
       SET status = 'active', completed_at = NULL, cancelled_at = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(now, t.bead_id);
    writeBeadEvent(this.db, {
      beadId: t.bead_id,
      eventType: 'status_change',
      actor: 'trigger-poller',
      payload: {
        from: bead.status,
        to: 'active',
        reason: 'trigger_terminal_reopen',
        trigger_id: t.id,
        trigger_reason: reason,
      },
      at: now,
    });
  }
}

function formatNotification(t: TriggerRow, outcome: ExecuteOutcome): string {
  const heading = t.kind === 'schedule.at_time'
    ? 'Scheduled fire'
    : t.kind === 'schedule.cron'
      ? 'Cron tick'
      : 'Watch fired';
  return `*${heading}* (trigger ${t.id}) — ${outcome.outputSummary}`;
}

function formatExpiryNotification(t: TriggerRow, reason: string): string {
  return `*Watch expired* (trigger ${t.id}, bead ${t.bead_id}) — ${reason}`;
}

function formatPauseNotification(t: TriggerRow, failureCount: number): string {
  return `*Watch paused* (trigger ${t.id}, bead ${t.bead_id}) — paused after ${failureCount} consecutive failures. Inspect via list_triggers; resume with extend_trigger or recreate.`;
}

function toBindArgs(binds: Record<string, unknown>): SQLInputValue[] {
  // node:sqlite supports positional binds via .all(...args); named binds are
  // not part of the public API. Callers must build SQL with positional `?`
  // and pass a plain object whose enumeration order matches placeholder order.
  // For watch recipes this is typically empty; binds are reserved for
  // future use.
  return Object.values(binds) as SQLInputValue[];
}
