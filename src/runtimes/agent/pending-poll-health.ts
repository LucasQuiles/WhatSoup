/**
 * pending-poll-health.ts — extracted (CAR-20 #2539) durability surfaces for the
 * offline poll-decision fallback path and the runtime health snapshot.
 *
 * Owns three concerns that previously lived inline in AgentRuntime (or did not
 * exist at all):
 *
 *  1. {@link OfflineDecisionRetryScheduler} — the retry OWNER for queued console
 *     decisions that fail to consume at boot. Previously a transient read / parse
 *     / delete failure left rows stranded for "next boot" with no in-process
 *     retry; this scheduler drives a bounded exponential-backoff retry so a
 *     transient failure is retried within the running process, and surfaces
 *     exhaustion so an operator can see that rows are stranded.
 *
 *  2. {@link ConsumptionReceiptRecorder} — durable consumption receipts that
 *     distinguish consumed / moot decisions from pending (still-queued) ones. A
 *     receipt row is the durable proof that a decision reached a terminal
 *     outcome; a `pending_poll_decisions` row with no matching receipt is still
 *     pending. The bare delete-on-consume path left no trace of what had been
 *     consumed, so a reboot could not tell consumed from pending.
 *
 *  3. {@link QueuedDecisionConsumer} — the boot-time consumption loop, extracted
 *     from AgentRuntime so the retry + receipt bookkeeping lives here rather
 *     than in the size-ceilinged runtime.ts. Behavior (moot drops, parse-error
 *     drops, 'invalid' rows retained for operator retry) is preserved verbatim;
 *     this layers durable receipts and a scheduled retry on top.
 *
 * All DB writes are best-effort (swallow + log, never throw), mirroring
 * PendingPollPersistence's discipline — a receipt-table failure must never break
 * the consumption path or strand a queued decision.
 */
import type { Database } from '../../core/database.ts';
import { systemClock } from '../../lib/clock.ts';
import { createChildLogger } from '../../logger.ts';

const log = createChildLogger('agent-runtime');

/** The resolve result shape produced by AgentRuntime.resolvePollDecisionFromConsole. */
export interface PollDecisionResolveResult {
  ok: boolean;
  /** Present when ok=false; the terminal/non-terminal classification of the failure. */
  code?: 'not_found' | 'stale' | 'invalid';
}

/** A queued decision row as read from pending_poll_decisions. */
export interface QueuedDecisionRow {
  map_key: string;
  question_index: number;
  selected_options: string;
  via: string;
}

/** Outcome of a single queued decision, recorded durably as a receipt. */
export type ConsumptionOutcome = 'consumed' | 'moot' | 'failed';

/** Per-call dependencies the consumer needs from the runtime (rehydration + resolution state). */
export interface QueuedDecisionConsumeDeps {
  /** True if a pending poll is in memory for the map key (post-rehydration state). */
  hasPending: (mapKey: string) => boolean;
  /** Resolve a queued decision through the same path as a live console decision / WhatsApp vote. */
  resolve: (decision: {
    mapKey: string;
    questionIndex: number;
    selectedOptions: string[];
  }) => Promise<PollDecisionResolveResult>;
}

/** Summary of one consumption pass; the runtime logs and the retry owner consumes it. */
export interface QueuedDecisionConsumeResult {
  consumed: number;
  moot: number;
  /** Rows retained for operator retry (e.g. 'invalid' — validation may depend on post-boot state). */
  retained: number;
  /** True if the top-level read/iterate path threw (queued rows kept; retry armed). */
  hadError: boolean;
}

/** Structured health surface for the offline-decision retry owner. */
export interface OfflineDecisionRetryHealth {
  /** True while a deferred retry is armed (an in-flight timer). */
  pending: boolean;
  /** Lifetime count of retries that have fired. */
  attempts: number;
  /** True once maxAttempts is reached and retries have stopped (rows then wait for the next boot). */
  exhausted: boolean;
  /** Epoch-ms when the armed retry will fire, or null if none is armed. */
  nextRetryAt: number | null;
}

export interface OfflineDecisionRetryOptions {
  /** Base backoff delay (ms); doubled each attempt up to maxDelayMs. Default 5_000. */
  baseDelayMs?: number;
  /** Cap on per-retry delay (ms). Default 60_000. */
  maxDelayMs?: number;
  /** Max retries before exhaustion. Default 5. */
  maxAttempts?: number;
  /** Injectable scheduler (tests). Defaults to setTimeout. */
  scheduler?: (fn: () => void, ms: number) => unknown;
  /** Injectable clearer (tests). Defaults to clearTimeout. */
  clearer?: (handle: unknown) => void;
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
}

/**
 * Retry owner for offline poll decisions that fail to consume at boot. Coalesces
 * to a single in-flight retry (scheduling while one is already armed is a no-op),
 * applies exponential backoff, and stops after `maxAttempts` (exhausted) — at
 * which point rows genuinely wait for the next boot and that state is surfaced so
 * an operator can see the strand. The scheduler instance IS the retry owner: it
 * holds the armed timer, the attempt count, and the exhaustion flag.
 */
export class OfflineDecisionRetryScheduler {
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly maxAttempts: number;
  private readonly scheduler: (fn: () => void, ms: number) => unknown;
  private readonly clearer: (handle: unknown) => void;
  private readonly now: () => number;

  private handle: unknown = null;
  private nextRetryAt: number | null = null;
  attempts = 0;
  exhausted = false;

  constructor(opts: OfflineDecisionRetryOptions = {}) {
    this.baseDelayMs = opts.baseDelayMs ?? 5_000;
    this.maxDelayMs = opts.maxDelayMs ?? 60_000;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.scheduler = opts.scheduler ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearer = opts.clearer ?? ((h) => {
      if (h !== null) clearTimeout(h as ReturnType<typeof setTimeout>);
    });
    this.now = opts.now ?? (() => systemClock.now());
  }

  /** True while a deferred retry is armed (in-flight timer). */
  get pendingRetry(): boolean {
    return this.handle !== null;
  }

  /**
   * Arm a deferred retry unless exhausted or already armed. Coalesces: a second
   * scheduleRetry while one is in flight is a no-op (the armed retry already
   * covers it). On the attempt that reaches maxAttempts the scheduler marks
   * itself exhausted and refuses further retries.
   */
  scheduleRetry(retry: () => Promise<void> | void): void {
    if (this.exhausted) return;
    if (this.handle !== null) return; // coalesce into the in-flight retry
    if (this.attempts >= this.maxAttempts) {
      this.exhausted = true;
      this.nextRetryAt = null;
      log.warn(
        { attempts: this.attempts, maxAttempts: this.maxAttempts },
        'offlineDecisionRetry: exhausted; queued console decisions wait for next boot',
      );
      return;
    }
    const attempt = this.attempts + 1;
    const delay = Math.min(this.baseDelayMs * 2 ** (attempt - 1), this.maxDelayMs);
    this.nextRetryAt = this.now() + delay;
    this.handle = this.scheduler(() => {
      this.handle = null;
      this.nextRetryAt = null;
      this.attempts += 1;
      log.info({ attempt }, 'offlineDecisionRetry: firing scheduled retry of queued console decisions');
      try {
        const result = retry();
        if (result instanceof Promise) {
          result.catch((err) => {
            log.error({ err }, 'offlineDecisionRetry: retry callback rejected');
          });
        }
      } catch (err) {
        log.error({ err }, 'offlineDecisionRetry: retry callback threw');
      }
    }, delay);
  }

  /** Cancel any armed retry (clean shutdown / re-arm). Does not reset attempts or exhaustion. */
  clear(): void {
    if (this.handle !== null) {
      this.clearer(this.handle);
      this.handle = null;
      this.nextRetryAt = null;
    }
  }

  /** Structured retry state for the runtime health snapshot. */
  healthDetails(): OfflineDecisionRetryHealth {
    return {
      pending: this.pendingRetry,
      attempts: this.attempts,
      exhausted: this.exhausted,
      nextRetryAt: this.nextRetryAt,
    };
  }
}

/**
 * Durable consumption receipts for queued console poll decisions. A receipt is the
 * durable proof that a decision reached a terminal outcome (consumed / moot /
 * failed); a `pending_poll_decisions` row with no matching receipt is still
 * pending. This distinguishes consumed from pending across reboots — the bare
 * delete-on-consume path left no trace of what had been consumed.
 *
 * Best-effort: a receipt-table write/read failure is swallowed and logged (mirrors
 * PendingPollPersistence); it never breaks the consumption path.
 */
export class ConsumptionReceiptRecorder {
  private readonly db: Database;
  private readonly now: () => number;
  private tableEnsured = false;
  private tableAvailable = true;

  constructor(db: Database, now: () => number = () => systemClock.now()) {
    this.db = db;
    this.now = now;
  }

  /** Idempotently create the receipts table. Latches: a failure disables receipts. */
  private ensureTable(): void {
    if (this.tableEnsured) return;
    try {
      this.db.raw.exec(`
        CREATE TABLE IF NOT EXISTS pending_poll_decision_receipts (
          map_key TEXT NOT NULL,
          question_index INTEGER NOT NULL,
          outcome TEXT NOT NULL,
          reason TEXT,
          consumed_at_ms INTEGER NOT NULL,
          PRIMARY KEY (map_key, question_index, outcome)
        );
      `);
      this.tableAvailable = true;
    } catch (err) {
      log.warn({ err }, 'consumptionReceipts: ensureTable failed (receipts disabled for this process)');
      this.tableAvailable = false;
    }
    this.tableEnsured = true;
  }

  private record(mapKey: string, questionIndex: number, outcome: ConsumptionOutcome, reason: string | null): void {
    try {
      this.ensureTable();
      if (!this.tableAvailable) return;
      this.db.raw
        .prepare(
          `INSERT OR REPLACE INTO pending_poll_decision_receipts
             (map_key, question_index, outcome, reason, consumed_at_ms)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(mapKey, questionIndex, outcome, reason, this.now());
    } catch (err) {
      log.warn({ err, mapKey, outcome }, 'consumptionReceipts: record failed (best-effort)');
    }
  }

  /** Record a successfully consumed decision. */
  recordConsumed(mapKey: string, questionIndex: number): void {
    this.record(mapKey, questionIndex, 'consumed', null);
  }

  /** Record a decision dropped as moot (poll no longer pending / unparseable options). */
  recordMoot(mapKey: string, questionIndex: number, reason: string): void {
    this.record(mapKey, questionIndex, 'moot', reason);
  }

  /** Record a decision that failed to consume and is retained for retry (e.g. 'invalid'). */
  recordFailed(mapKey: string, questionIndex: number, reason: string): void {
    this.record(mapKey, questionIndex, 'failed', reason);
  }

  /** Count receipts of the given outcome written at/after an epoch-ms cutoff. */
  countSince(outcome: ConsumptionOutcome, sinceEpochMs: number): number {
    try {
      this.ensureTable();
      if (!this.tableAvailable) return 0;
      const row = this.db.raw
        .prepare(
          `SELECT COUNT(*) AS cnt FROM pending_poll_decision_receipts
           WHERE outcome = ? AND consumed_at_ms >= ?`,
        )
        .get(outcome, sinceEpochMs) as { cnt: number } | undefined;
      return row?.cnt ?? 0;
    } catch (err) {
      log.warn({ err, outcome }, 'consumptionReceipts: countSince failed (best-effort)');
      return 0;
    }
  }

  /** Count queued decisions still pending in pending_poll_decisions (the unreceipted side). */
  pendingCount(): number {
    try {
      const row = this.db.raw
        .prepare('SELECT COUNT(*) AS cnt FROM pending_poll_decisions')
        .get() as { cnt: number } | undefined;
      return row?.cnt ?? 0;
    } catch (err) {
      log.warn({ err }, 'consumptionReceipts: pendingCount failed (best-effort)');
      return 0;
    }
  }
}

/**
 * Boot-time consumer of queued console poll decisions, extracted from AgentRuntime
 * (CAR-20 #2539). Preserves the prior drop / retain semantics — moot (poll no
 * longer pending) and unparseable rows are deleted visibly; 'invalid' rows are
 * retained for operator retry — and layers durable consumption receipts + a
 * scheduled retry on top, so a transient read / parse / delete failure no longer
 * strands rows for "next boot" only.
 *
 * The consumer holds the durable receipts table and a `scheduleRetry` thunk wired
 * to the runtime's {@link OfflineDecisionRetryScheduler}; per-call deps (the
 * rehydration predicate + the resolve callback) are supplied at consume() time so
 * the consumer never captures runtime state that is initialized after the
 * constructor runs.
 */
export class QueuedDecisionConsumer {
  private readonly db: Database;
  private readonly receipts: ConsumptionReceiptRecorder;
  private readonly scheduleRetry: () => void;

  constructor(db: Database, receipts: ConsumptionReceiptRecorder, scheduleRetry: () => void) {
    this.db = db;
    this.receipts = receipts;
    this.scheduleRetry = scheduleRetry;
  }

  async consume(deps: QueuedDecisionConsumeDeps): Promise<QueuedDecisionConsumeResult> {
    const result: QueuedDecisionConsumeResult = { consumed: 0, moot: 0, retained: 0, hadError: false };
    try {
      const tables = new Set(
        (this.db.raw
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
          .all() as Array<{ name: string }>).map((r) => r.name),
      );
      if (!tables.has('pending_poll_decisions')) return result;
      const rows = this.db.raw.prepare(`
        SELECT map_key, question_index, selected_options, via
        FROM pending_poll_decisions
        ORDER BY created_at ASC, rowid ASC
      `).all() as unknown as QueuedDecisionRow[];
      if (rows.length === 0) return result;

      for (const row of rows) {
        const deleteRow = () => this.db.raw.prepare(`
          DELETE FROM pending_poll_decisions
          WHERE map_key = ? AND question_index = ?
        `).run(row.map_key, row.question_index);

        if (!deps.hasPending(row.map_key)) {
          // The poll expired or resolved while the instance was down — the queued
          // decision is moot; drop it visibly rather than keeping a phantom queue.
          log.info({ mapKey: row.map_key }, 'queued console decision dropped as moot (poll not pending at boot)');
          this.receipts.recordMoot(row.map_key, row.question_index, 'poll_not_pending');
          deleteRow();
          result.moot += 1;
          continue;
        }
        let selectedOptions: string[];
        try {
          selectedOptions = JSON.parse(row.selected_options) as string[];
        } catch {
          log.warn({ mapKey: row.map_key }, 'queued console decision has unparseable options; dropped');
          this.receipts.recordMoot(row.map_key, row.question_index, 'unparseable_options');
          deleteRow();
          result.moot += 1;
          continue;
        }
        const resolved = await deps.resolve({
          mapKey: row.map_key,
          questionIndex: row.question_index,
          selectedOptions,
        });
        if (resolved.ok || resolved.code === 'stale' || resolved.code === 'not_found') {
          if (resolved.ok) {
            this.receipts.recordConsumed(row.map_key, row.question_index);
            result.consumed += 1;
          } else {
            this.receipts.recordMoot(row.map_key, row.question_index, resolved.code ?? 'terminal');
            result.moot += 1;
          }
          deleteRow();
        } else {
          // 'invalid' (or any non-terminal code): retain for operator retry.
          // Validation may depend on post-boot state, e.g. a poll still re-sending
          // its message; record a 'failed' receipt and arm a scheduled retry.
          this.receipts.recordFailed(row.map_key, row.question_index, resolved.code ?? 'invalid');
          result.retained += 1;
        }
      }
      if (result.consumed > 0 || result.moot > 0) {
        log.info(
          { consumed: result.consumed, moot: result.moot, retained: result.retained },
          'queued console decisions consumed at boot',
        );
      }
    } catch (err) {
      result.hadError = true;
      log.error({ err }, 'consumeQueuedPollDecisions: unhandled error (queued rows kept; scheduling retry)');
    }
    // A transient read / parse / delete failure or a retained 'invalid' row gets
    // an in-process retry rather than waiting for the next boot only. The retry
    // owner coalesces and bounds this (maxAttempts → exhausted).
    if (result.hadError || result.retained > 0) {
      this.scheduleRetry();
    }
    return result;
  }
}
