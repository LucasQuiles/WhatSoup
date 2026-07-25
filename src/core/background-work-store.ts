import { createChildLogger } from '../logger.ts';
import { formatDurationMs } from '../lib/capability-grant.ts';
import type { Database } from './database.ts';
import { withTransaction } from './db-tx.ts';
// Reused deliberately rather than re-implemented: these are the repo's canonical
// bounded-string / safe-integer guards. A second private copy is exactly the
// duplicate-utility class already filed as debt in #2223.
import { validateBoundedRequired, validatePositiveSafeInteger } from './turn-recovery-store.ts';

const log = createChildLogger('background-work-store');

/** Matches TURN_RECOVERY_MAX_ID_BYTES — same identifier class, same bound. */
export const BACKGROUND_WORK_MAX_ID_BYTES = 2048;
/** Result summaries ride a chat message; keep them bounded well under transport limits. */
export const BACKGROUND_WORK_MAX_SUMMARY_BYTES = 8192;

/**
 * A result that reaches the chat later than this, even from a healthy parent,
 * announces its age. Rationale: this repo has a verified findings class where a
 * delayed delivery read as a false current-state claim (reachability alerts not
 * revalidated at delivery; digest retries not episode-fenced). Silence about age
 * is what made those misleading, so age is stated rather than assumed fresh.
 */
export const STALE_DELIVERY_NOTICE_MS = 300_000;

export type BackgroundWorkState =
  | 'registered'
  | 'running'
  | 'completed'
  | 'failed'
  | 'orphaned';

/** PR1 scope gate. Operator-side scripts join later via a CLI shim (PR3). */
export type BackgroundWorkerKind = 'agent_subagent';

export type WorkResultOutcome = 'completed' | 'failed';
export type WorkResultDeliveryState = 'pending' | 'delivering' | 'delivered' | 'failed';

export interface RegisterBackgroundWorkParams {
  workId: string;
  parentSessionId: string;
  /** Null when the spawner cannot report a pid; orphan sweep then relies on the lease alone. */
  parentPid: number | null;
  conversationKey: string;
  deliveryJid: string;
  workerKind: BackgroundWorkerKind;
  specDigest: string;
  summaryLabel: string | null;
  now: number;
  leaseExpiresAt: number | null;
}

export interface BackgroundWorkRow {
  id: number;
  workId: string;
  parentSessionId: string;
  parentPid: number | null;
  conversationKey: string;
  deliveryJid: string;
  workerKind: BackgroundWorkerKind;
  specDigest: string;
  summaryLabel: string | null;
  state: BackgroundWorkState;
  leaseExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface WorkResultRow {
  id: number;
  workId: string;
  conversationKey: string;
  deliveryJid: string;
  outcome: WorkResultOutcome;
  summary: string;
  artifactPath: string | null;
  recovered: boolean;
  producedAt: number;
  deliveryState: WorkResultDeliveryState;
  deliveryDedupeKey: string;
  deliveryAttempts: number;
  deliveredAt: number | null;
}

export interface CompleteBackgroundWorkParams {
  workId: string;
  outcome: WorkResultOutcome;
  summary: string;
  artifactPath: string | null;
  now: number;
  /**
   * Caller-stable key making delivery retries idempotent (the bot-errors
   * dispatcher discipline). UNIQUE in the schema, so a duplicate completion
   * is rejected by the database rather than double-delivered.
   */
  deliveryDedupeKey: string;
}

export interface CompleteBackgroundWorkResult {
  work: BackgroundWorkRow;
  result: WorkResultRow;
}

interface RawBackgroundWorkRow {
  id: number;
  work_id: string;
  parent_session_id: string;
  parent_pid: number | null;
  conversation_key: string;
  delivery_jid: string;
  worker_kind: string;
  spec_digest: string;
  summary_label: string | null;
  state: string;
  lease_expires_at: number | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

interface RawWorkResultRow {
  id: number;
  work_id: string;
  conversation_key: string;
  delivery_jid: string;
  outcome: string;
  summary: string;
  artifact_path: string | null;
  recovered: number;
  produced_at: number;
  delivery_state: string;
  delivery_dedupe_key: string;
  delivery_attempts: number;
  delivered_at: number | null;
}

function mapWorkRow(row: RawBackgroundWorkRow): BackgroundWorkRow {
  return {
    id: row.id,
    workId: row.work_id,
    parentSessionId: row.parent_session_id,
    parentPid: row.parent_pid,
    conversationKey: row.conversation_key,
    deliveryJid: row.delivery_jid,
    workerKind: row.worker_kind as BackgroundWorkerKind,
    specDigest: row.spec_digest,
    summaryLabel: row.summary_label,
    state: row.state as BackgroundWorkState,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function mapResultRow(row: RawWorkResultRow): WorkResultRow {
  return {
    id: row.id,
    workId: row.work_id,
    conversationKey: row.conversation_key,
    deliveryJid: row.delivery_jid,
    outcome: row.outcome as WorkResultOutcome,
    summary: row.summary,
    artifactPath: row.artifact_path,
    recovered: row.recovered === 1,
    producedAt: row.produced_at,
    deliveryState: row.delivery_state as WorkResultDeliveryState,
    deliveryDedupeKey: row.delivery_dedupe_key,
    deliveryAttempts: row.delivery_attempts,
    deliveredAt: row.delivered_at,
  };
}

function readWorkRow(db: Database, workId: string): BackgroundWorkRow | null {
  const row = db.raw
    .prepare('SELECT * FROM background_work WHERE work_id = ?')
    .get(workId) as RawBackgroundWorkRow | undefined;
  return row ? mapWorkRow(row) : null;
}

/**
 * Register a background worker at spawn. This is the whole point of the ledger:
 * after this row exists, the work is bound to a `conversation_key` rather than
 * to its parent session's lifetime, so a dead parent no longer means lost work.
 */
export function registerBackgroundWork(
  db: Database,
  params: RegisterBackgroundWorkParams,
): BackgroundWorkRow {
  validateBoundedRequired(params.workId, 'workId', BACKGROUND_WORK_MAX_ID_BYTES);
  validateBoundedRequired(params.parentSessionId, 'parentSessionId', BACKGROUND_WORK_MAX_ID_BYTES);
  validateBoundedRequired(params.conversationKey, 'conversationKey', BACKGROUND_WORK_MAX_ID_BYTES);
  validateBoundedRequired(params.deliveryJid, 'deliveryJid', BACKGROUND_WORK_MAX_ID_BYTES);
  validateBoundedRequired(params.specDigest, 'specDigest', BACKGROUND_WORK_MAX_ID_BYTES);
  validatePositiveSafeInteger(params.now, 'now');
  if (params.parentPid !== null) validatePositiveSafeInteger(params.parentPid, 'parentPid');
  if (params.leaseExpiresAt !== null) {
    validatePositiveSafeInteger(params.leaseExpiresAt, 'leaseExpiresAt');
  }

  db.raw
    .prepare(
      `INSERT INTO background_work (
         work_id, parent_session_id, parent_pid, conversation_key, delivery_jid,
         worker_kind, spec_digest, summary_label, state, lease_expires_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'registered', ?, ?, ?)`,
    )
    .run(
      params.workId,
      params.parentSessionId,
      params.parentPid,
      params.conversationKey,
      params.deliveryJid,
      params.workerKind,
      params.specDigest,
      params.summaryLabel,
      params.leaseExpiresAt,
      params.now,
      params.now,
    );

  const row = readWorkRow(db, params.workId);
  if (!row) throw new Error(`background work ${params.workId} vanished immediately after insert`);
  return row;
}

/** registered → running, taking a lease. Returns false if the row is not in a startable state. */
export function markBackgroundWorkRunning(
  db: Database,
  workId: string,
  leaseExpiresAt: number,
  now: number,
): boolean {
  validatePositiveSafeInteger(leaseExpiresAt, 'leaseExpiresAt');
  validatePositiveSafeInteger(now, 'now');
  const info = db.raw
    .prepare(
      `UPDATE background_work
          SET state = 'running', lease_expires_at = ?, updated_at = ?
        WHERE work_id = ? AND state IN ('registered', 'running')`,
    )
    .run(leaseExpiresAt, now, workId);
  return Number(info.changes) === 1;
}

/**
 * Extend a running worker's lease. A worker that keeps renewing is demonstrably
 * alive; one that stops renewing is what the orphan sweep collects. Renewal is
 * refused for non-running rows so a completed row cannot be resurrected.
 */
export function renewBackgroundWorkLease(
  db: Database,
  workId: string,
  leaseExpiresAt: number,
  now: number,
): boolean {
  validatePositiveSafeInteger(leaseExpiresAt, 'leaseExpiresAt');
  validatePositiveSafeInteger(now, 'now');
  const info = db.raw
    .prepare(
      `UPDATE background_work
          SET lease_expires_at = ?, updated_at = ?
        WHERE work_id = ? AND state = 'running'`,
    )
    .run(leaseExpiresAt, now, workId);
  return Number(info.changes) === 1;
}

/**
 * Terminalize the work AND write its result to the outbox in ONE transaction.
 *
 * The atomicity is the durability guarantee: there is no window in which the
 * ledger says "completed" while the result is missing, nor one where a result
 * exists for work still marked running. If the process dies mid-call the whole
 * thing rolls back and the row stays running — which the orphan sweep then
 * collects, rather than the work silently reading as done with nothing to show.
 *
 * `recovered` is derived, never passed in: it is true exactly when the work had
 * already been swept to 'orphaned' before finishing, i.e. the parent was gone.
 * That is the honest signal the delivery layer needs; letting a caller assert it
 * would make it a claim rather than an observation.
 */
export function completeBackgroundWork(
  db: Database,
  params: CompleteBackgroundWorkParams,
): CompleteBackgroundWorkResult {
  validateBoundedRequired(params.workId, 'workId', BACKGROUND_WORK_MAX_ID_BYTES);
  validateBoundedRequired(params.summary, 'summary', BACKGROUND_WORK_MAX_SUMMARY_BYTES);
  validateBoundedRequired(
    params.deliveryDedupeKey,
    'deliveryDedupeKey',
    BACKGROUND_WORK_MAX_ID_BYTES,
  );
  validatePositiveSafeInteger(params.now, 'now');

  return withTransaction(db, () => {
    const existing = readWorkRow(db, params.workId);
    if (!existing) throw new Error(`unknown background work ${params.workId}`);
    if (existing.state === 'completed' || existing.state === 'failed') {
      throw new Error(`background work ${params.workId} is already terminal (${existing.state})`);
    }

    const recovered = existing.state === 'orphaned' ? 1 : 0;

    db.raw
      .prepare(
        `UPDATE background_work
            SET state = ?, completed_at = ?, updated_at = ?, lease_expires_at = NULL
          WHERE work_id = ?`,
      )
      .run(params.outcome, params.now, params.now, params.workId);

    db.raw
      .prepare(
        `INSERT INTO work_results (
           work_id, conversation_key, delivery_jid, outcome, summary, artifact_path,
           recovered, produced_at, delivery_state, delivery_dedupe_key
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        params.workId,
        existing.conversationKey,
        existing.deliveryJid,
        params.outcome,
        params.summary,
        params.artifactPath,
        recovered,
        params.now,
        params.deliveryDedupeKey,
      );

    const work = readWorkRow(db, params.workId);
    const result = db.raw
      .prepare('SELECT * FROM work_results WHERE delivery_dedupe_key = ?')
      .get(params.deliveryDedupeKey) as RawWorkResultRow | undefined;
    if (!work || !result) {
      throw new Error(`background work ${params.workId} completion did not persist`);
    }
    return { work, result: mapResultRow(result) };
  });
}

/**
 * Collect running work whose lease has expired — the parent is presumed dead.
 *
 * Deliberately does NOT kill or re-run anything: it only relabels, so a worker
 * that is merely slow (and later renews or completes) is not destroyed. Marking
 * orphaned is what makes the eventual result carry `recovered = 1`.
 */
export function sweepOrphanedBackgroundWork(db: Database, now: number): BackgroundWorkRow[] {
  validatePositiveSafeInteger(now, 'now');
  return withTransaction(db, () => {
    const stale = db.raw
      .prepare(
        `SELECT * FROM background_work
          WHERE state = 'running'
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at < ?`,
      )
      .all(now) as unknown as RawBackgroundWorkRow[];
    if (stale.length === 0) return [];

    const mark = db.raw.prepare(
      `UPDATE background_work
          SET state = 'orphaned', updated_at = ?
        WHERE work_id = ? AND state = 'running'`,
    );
    const swept: BackgroundWorkRow[] = [];
    for (const row of stale) {
      if (Number(mark.run(now, row.work_id).changes) === 1) {
        swept.push(mapWorkRow({ ...row, state: 'orphaned', updated_at: now }));
      }
    }
    if (swept.length > 0) {
      log.warn(
        { count: swept.length, workIds: swept.map((w) => w.workId) },
        'background work orphaned — lease expired, parent presumed dead',
      );
    }
    return swept;
  });
}

/**
 * Oldest-first claim of undelivered results for the delivery daemon (PR1b).
 * Claiming flips 'pending' → 'delivering' and bumps the attempt counter inside
 * one transaction so two daemon ticks cannot claim the same row.
 */
export function claimPendingWorkResults(db: Database, limit: number, now: number): WorkResultRow[] {
  validatePositiveSafeInteger(limit, 'limit');
  validatePositiveSafeInteger(now, 'now');
  return withTransaction(db, () => {
    const pending = db.raw
      .prepare(
        `SELECT * FROM work_results
          WHERE delivery_state = 'pending'
          ORDER BY produced_at ASC, id ASC
          LIMIT ?`,
      )
      .all(limit) as unknown as RawWorkResultRow[];
    if (pending.length === 0) return [];

    const claim = db.raw.prepare(
      `UPDATE work_results
          SET delivery_state = 'delivering', delivery_attempts = delivery_attempts + 1
        WHERE id = ? AND delivery_state = 'pending'`,
    );
    const claimed: WorkResultRow[] = [];
    for (const row of pending) {
      if (Number(claim.run(row.id).changes) === 1) {
        claimed.push(
          mapResultRow({
            ...row,
            delivery_state: 'delivering',
            delivery_attempts: row.delivery_attempts + 1,
          }),
        );
      }
    }
    return claimed;
  });
}

/** Terminal success for a claimed result. */
export function markWorkResultDelivered(db: Database, id: number, now: number): boolean {
  validatePositiveSafeInteger(id, 'id');
  validatePositiveSafeInteger(now, 'now');
  const info = db.raw
    .prepare(
      `UPDATE work_results
          SET delivery_state = 'delivered', delivered_at = ?
        WHERE id = ? AND delivery_state = 'delivering'`,
    )
    .run(now, id);
  return Number(info.changes) === 1;
}

/**
 * Release a claimed result. `retryable` returns it to 'pending' for a later tick;
 * otherwise it lands in terminal 'failed'. The attempt counter already advanced
 * at claim time, so a permanently failing row cannot spin invisibly.
 */
export function releaseWorkResultDelivery(db: Database, id: number, retryable: boolean): boolean {
  validatePositiveSafeInteger(id, 'id');
  const info = db.raw
    .prepare(
      `UPDATE work_results
          SET delivery_state = ?
        WHERE id = ? AND delivery_state = 'delivering'`,
    )
    .run(retryable ? 'pending' : 'failed', id);
  return Number(info.changes) === 1;
}

/**
 * The delivery-honesty contract, in one place so PR1b's daemon cannot quietly
 * drop it: returns the prefix a result must carry, or null when the result is
 * both fresh and from a live parent (the only case needing no qualification).
 *
 * A recovered result ALWAYS announces itself and its age — it was produced by a
 * worker whose parent had already died, so it is by construction a statement
 * about the past, not about now.
 */
export function describeResultStaleness(
  result: Pick<WorkResultRow, 'recovered' | 'producedAt'>,
  now: number,
): string | null {
  const age = Math.max(0, now - result.producedAt);
  if (result.recovered) {
    return `[recovered result · produced ${formatDurationMs(age)} ago]`;
  }
  if (age >= STALE_DELIVERY_NOTICE_MS) {
    return `[delayed result · produced ${formatDurationMs(age)} ago]`;
  }
  return null;
}
