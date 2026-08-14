import { shortHash as shortHashImpl } from '../../../lib/short-hash.ts';
import { z } from 'zod';
import { createChildLogger } from '../../../logger.ts';
import { config } from '../../../config.ts';
import type { Database } from '../../../core/database.ts';
import { queryAll, queryOne } from '../../../lib/db-query.ts';
import { deriveFactUid, getFactUidSalt } from '../../../core/fact-uid.ts';
import type { ValidatedFact } from './validator.ts';

const log = createChildLogger('enrichment');

/**
 * Shape of a row ready to be enqueued for export.
 * The `factId` is the caller-supplied stable identifier; duplicate factIds
 * are silently ignored so the call is safe to retry.
 */
export interface ExportableFact {
  factId: string;
  chatJid: string;
  senderJid: string | null;
  text: string;
  memoryType: ValidatedFact['memoryType'];
  confidence: number;
  senderName: string;
  supersedesText: string;
  sourceMessagePks: number[];
  promotionReason?: string;
  claim?: string;
  evidence?: string;
  warrant?: string;
  confidenceQualifier?: string;
  contradicts?: string;
  namespace?: string;
}

/**
 * Cross-service `fact_id` shape: `{chatJid}:{senderSegment}:{hash(text)}`.
 *
 * Shared here because the UNIQUE constraint on fact_export_queue.fact_id is
 * the only thing preventing duplicate upserts across the live poller, the
 * direct upserter, and the one-shot backfill. If any caller computes a
 * different hash or different layout, retries silently produce duplicate
 * queue rows with distinct fact_ids and the downstream Pinecone upsert
 * loses idempotency. Keep this the single source of truth.
 */
export function shortHash(text: string): string {
  return shortHashImpl(text, 12);
}

/**
 * Map a validated fact to an ExportableFact row using the canonical factId
 * scheme. See `shortHash` for the cross-service contract rationale.
 */
export function toExportable(fact: ValidatedFact): ExportableFact {
  const senderSegment = fact.senderJid || 'group';
  const factId = `${fact.chatJid}:${senderSegment}:${shortHash(fact.text)}`;
  return {
    factId,
    chatJid: fact.chatJid,
    senderJid: fact.senderJid || null,
    text: fact.text,
    memoryType: fact.memoryType,
    confidence: fact.adjustedConfidence,
    senderName: fact.senderName,
    supersedesText: fact.supersedesText,
    sourceMessagePks: fact.sourceMessagePks,
    promotionReason: fact.validationReason ?? '',
    claim: fact.claim ?? '',
    evidence: fact.evidence ?? '',
    warrant: fact.warrant ?? '',
    confidenceQualifier: fact.confidenceQualifier ?? '',
    contradicts: '',
  };
}

/**
 * Accounting summary for a single `enqueueFacts` call.
 *
 * - `attempted`  : rows handed to the function in this call.
 * - `inserted`   : rows that were actually written (changes > 0).
 * - `duplicates` : rows that matched the UNIQUE fact_id constraint and
 *                  were therefore ignored by INSERT OR IGNORE — this is an
 *                  idempotent success path, NOT a failure.
 * - `failed`     : rows that raised a hard DB error inside the loop.
 *                  In the T1 transactional semantics this field should
 *                  normally be 0 because any hard error throws out of the
 *                  function and rolls back the batch; it remains in the
 *                  return shape for the downstream (poller) gate contract.
 *
 * Invariant on successful return: `attempted === inserted + duplicates`.
 */
export interface EnqueueFactsResult {
  attempted: number;
  inserted: number;
  duplicates: number;
  failed: number;
}

/**
 * Zod schema for the payload_json column.
 *
 * The queue's payload is written by enqueueFacts using the ExportableFact
 * subset; this schema must stay in lock-step with that writer. We accept
 * any string for memoryType because historical rows predate the tighter
 * ValidatedFact['memoryType'] union — exporter-side triage handles unknown
 * types rather than failing the claim.
 */
const PayloadSchema = z.object({
  text: z.string(),
  memoryType: z.string(),
  confidence: z.number(),
  senderName: z.string(),
  supersedesText: z.string(),
  sourceMessagePks: z.array(z.number()),
  promotionReason: z.string().optional(),
  claim: z.string().optional(),
  evidence: z.string().optional(),
  warrant: z.string().optional(),
  confidenceQualifier: z.string().optional(),
  contradicts: z.string().optional(),
});

/**
 * Insert validated facts into the export queue. Duplicate `fact_id` values
 * are ignored (INSERT OR IGNORE) so callers can retry safely.
 *
 * Transactional semantics (T1): the entire batch is wrapped in
 * BEGIN / COMMIT / ROLLBACK via `db.raw.exec`. If any row raises a hard
 * DB error during `stmt.run`, the whole batch is rolled back and the
 * error is re-thrown so the caller can decide whether to retry.
 *
 * Returns an accounting summary (`EnqueueFactsResult`) so callers can
 * decide whether downstream message rows are safe to mark processed.
 */
export function enqueueFacts(
  db: Database,
  facts: ExportableFact[],
): EnqueueFactsResult {
  const runId = process.env.MW_MIND_RUN_ID;

  if (facts.length === 0) {
    return { attempted: 0, inserted: 0, duplicates: 0, failed: 0 };
  }

  const attempted = facts.length;

  const salt = getFactUidSalt(db.raw);
  const stmt = db.raw.prepare(
    `INSERT OR IGNORE INTO fact_export_queue
       (fact_uid, fact_id, chat_jid, sender_jid, namespace, payload_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  let inserted = 0;
  let duplicates = 0;

  // BEGIN / COMMIT / ROLLBACK pattern — node:sqlite's DatabaseSync does not
  // expose better-sqlite3's `stmt.transaction(fn)` helper, so we drive the
  // transaction explicitly (same pattern as core/database.ts migrations).
  db.raw.exec('BEGIN');
  try {
    for (const fact of facts) {
      const payload = {
        text: fact.text,
        memoryType: fact.memoryType,
        confidence: fact.confidence,
        senderName: fact.senderName,
        supersedesText: fact.supersedesText,
        sourceMessagePks: fact.sourceMessagePks,
        promotionReason: fact.promotionReason ?? '',
        claim: fact.claim ?? '',
        evidence: fact.evidence ?? '',
        warrant: fact.warrant ?? '',
        confidenceQualifier: fact.confidenceQualifier ?? '',
        contradicts: fact.contradicts ?? '',
      };

      const result = stmt.run(
        deriveFactUid(salt, fact.factId),
        fact.factId,
        fact.chatJid,
        fact.senderJid,
        fact.namespace ?? config.memory.pinecone.namespaces.facts,
        JSON.stringify(payload),
      );
      if (Number(result.changes) > 0) {
        inserted += 1;
      } else {
        // INSERT OR IGNORE returned 0 changes -> unique-constraint collision.
        // This is the idempotent-retry path, not a failure.
        duplicates += 1;
      }
    }
    db.raw.exec('COMMIT');
  } catch (err) {
    // Roll back the whole batch. If ROLLBACK itself fails we still want to
    // surface the original error, so swallow any rollback error here.
    try {
      db.raw.exec('ROLLBACK');
    } catch (rollbackErr) {
      log.error(
        { err: rollbackErr, ...(runId ? { runId } : {}) },
        'enqueueFacts: ROLLBACK failed after batch insert error',
      );
    }
    log.error(
      {
        err,
        attempted,
        ...(runId ? { runId } : {}),
      },
      'enqueueFacts: batch rolled back on hard DB error',
    );
    throw err;
  }

  log.debug(
    {
      attempted,
      inserted,
      duplicates,
      failed: 0,
      ...(runId ? { runId } : {}),
    },
    'enqueueFacts: batch committed',
  );

  return { attempted, inserted, duplicates, failed: 0 };
}

/** Default lease-lifecycle tuning shared by lease, ack, and reconcile. */
export const DEFAULT_FACT_EXPORT_MAX_ATTEMPTS = 8;
export const DEFAULT_FACT_EXPORT_BACKOFF_BASE_SEC = 60;
const BACKOFF_CAP_SEC = 3600;

function backoffSeconds(baseSeconds: number, attemptCount: number): number {
  if (baseSeconds <= 0) return 0;
  const exp = Math.min(attemptCount - 1, 16);
  return Math.min(baseSeconds * 2 ** Math.max(exp, 0), BACKOFF_CAP_SEC);
}

/**
 * Wire shape of a leased row. Deliberately carries the opaque `factUid` and
 * NEVER the legacy identity-bearing `fact_id` — acknowledgements, readers,
 * and logs all key on the uid (see core/fact-uid.ts).
 */
export interface LeasedFact {
  id: number;
  factUid: string;
  chatJid: string;
  senderJid: string | null;
  namespace: string;
  payload: Omit<ExportableFact, 'factId' | 'chatJid' | 'senderJid' | 'namespace'>;
  createdAt: string;
  attemptCount: number;
}

export interface LeaseOptions {
  owner: string;
  limit: number;
  leaseSeconds: number;
  nowUnixSec: number;
}

/**
 * Atomically lease up to `limit` due rows (pending, or retry_wait whose
 * backoff has elapsed), oldest-first. The single guarded UPDATE ... RETURNING
 * transitions rows to `leased` with an owner and expiry and increments
 * attempt_count, so two concurrent claimers can never hold the same row —
 * this replaces the unfenced SELECT that #2567 proved returned the same row
 * to every caller.
 *
 * Rows whose payload_json fails parse/schema validation are quarantined with
 * failure_code='payload_invalid' (surfaced at log.error, no payload echoed)
 * and omitted from the returned batch, so poison rows cannot occupy wire
 * slots or wedge the queue head.
 */
export function leasePendingFacts(db: Database, opts: LeaseOptions): LeasedFact[] {
  const runId = process.env.MW_MIND_RUN_ID;

  const rows = db.raw
    .prepare(
      `UPDATE fact_export_queue
          SET state = 'leased',
              lease_owner = ?,
              lease_expires_at = ?,
              attempt_count = attempt_count + 1,
              failure_code = NULL,
              failure_stage = NULL,
              next_attempt_at = NULL
        WHERE id IN (
          SELECT id FROM fact_export_queue
           WHERE state = 'pending'
              OR (state = 'retry_wait' AND next_attempt_at <= ?)
           ORDER BY id
           LIMIT ?)
        RETURNING id, fact_uid, chat_jid, sender_jid, namespace, payload_json, created_at, attempt_count`,
    )
    .all(opts.owner, opts.nowUnixSec + opts.leaseSeconds, opts.nowUnixSec, opts.limit) as Array<{
      id: number;
      fact_uid: string;
      chat_jid: string;
      sender_jid: string | null;
      namespace: string;
      payload_json: string;
      created_at: string;
      attempt_count: number;
    }>;

  const quarantineRow = db.raw.prepare(
    `UPDATE fact_export_queue
        SET state = 'quarantined',
            failure_code = 'payload_invalid',
            failure_stage = 'claim_validate',
            lease_owner = NULL,
            lease_expires_at = NULL
      WHERE id = ?`,
  );

  const leased: LeasedFact[] = [];
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.payload_json);
    } catch {
      log.error(
        { factUid: row.fact_uid, rowId: row.id, ...(runId ? { runId } : {}) },
        'leasePendingFacts: payload_json not valid JSON -- quarantining row',
      );
      quarantineRow.run(row.id);
      continue;
    }

    const validated = PayloadSchema.safeParse(parsed);
    if (!validated.success) {
      log.error(
        { factUid: row.fact_uid, rowId: row.id, ...(runId ? { runId } : {}) },
        'leasePendingFacts: payload_json failed schema validation -- quarantining row',
      );
      quarantineRow.run(row.id);
      continue;
    }

    leased.push({
      id: row.id,
      factUid: row.fact_uid,
      chatJid: row.chat_jid,
      senderJid: row.sender_jid,
      namespace: row.namespace,
      payload: validated.data as LeasedFact['payload'],
      createdAt: row.created_at,
      attemptCount: row.attempt_count,
    });
  }
  return leased;
}

export type AckResultCode =
  | 'acknowledged'
  | 'already_terminal'
  | 'lease_lost'
  | 'unknown'
  | 'write_failed';

export interface FactAck {
  factUid: string;
  outcome: 'exported' | 'failed';
  /** Stable machine failure code — never raw provider/error prose. */
  failureCode?: string;
  failureStage?: string;
  retryable?: boolean;
  remoteRecordId?: string;
}

export interface AckOptions {
  owner: string;
  acks: FactAck[];
  nowUnixSec: number;
  maxAttempts?: number;
  backoffBaseSeconds?: number;
}

const TERMINAL_STATES = new Set(['exported', 'quarantined', 'retry_exhausted', 'legacy_unclassified']);

/**
 * Acknowledge leased rows with per-ID outcomes — the replacement for the
 * void, error-suppressing markFactsExported. Every ack returns exactly one
 * of: acknowledged, already_terminal, lease_lost, unknown, write_failed;
 * partial failure is never silent.
 *
 * Success writes are fenced (`state='leased' AND lease_owner=?`), so a
 * consumer whose lease expired and was re-issued cannot clobber the new
 * owner. `remoteRecordId` stores the opaque idempotent remote ID for the
 * crash-reconciliation window between remote write and local ack.
 */
export function ackFacts(db: Database, opts: AckOptions): Array<{ factUid: string; result: AckResultCode }> {
  const runId = process.env.MW_MIND_RUN_ID;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_FACT_EXPORT_MAX_ATTEMPTS;
  const backoffBase = opts.backoffBaseSeconds ?? DEFAULT_FACT_EXPORT_BACKOFF_BASE_SEC;

  const readRow = db.raw.prepare(
    'SELECT state, lease_owner, attempt_count FROM fact_export_queue WHERE fact_uid = ?',
  );
  const ackExported = db.raw.prepare(
    `UPDATE fact_export_queue
        SET state = 'exported',
            exported_at = datetime('now'),
            acked_at = ?,
            remote_record_id = ?,
            lease_owner = NULL,
            lease_expires_at = NULL
      WHERE fact_uid = ? AND state = 'leased' AND lease_owner = ?`,
  );
  const ackFailed = db.raw.prepare(
    `UPDATE fact_export_queue
        SET state = ?,
            failure_code = ?,
            failure_stage = ?,
            next_attempt_at = ?,
            lease_owner = NULL,
            lease_expires_at = NULL
      WHERE fact_uid = ? AND state = 'leased' AND lease_owner = ?`,
  );

  const results: Array<{ factUid: string; result: AckResultCode }> = [];
  for (const ack of opts.acks) {
    try {
      const row = readRow.get(ack.factUid) as
        | { state: string; lease_owner: string | null; attempt_count: number }
        | undefined;
      if (!row) {
        results.push({ factUid: ack.factUid, result: 'unknown' });
        continue;
      }
      if (TERMINAL_STATES.has(row.state)) {
        results.push({ factUid: ack.factUid, result: 'already_terminal' });
        continue;
      }
      if (row.state !== 'leased' || row.lease_owner !== opts.owner) {
        results.push({ factUid: ack.factUid, result: 'lease_lost' });
        continue;
      }

      let changes: number;
      if (ack.outcome === 'exported') {
        changes = Number(
          ackExported.run(opts.nowUnixSec, ack.remoteRecordId ?? null, ack.factUid, opts.owner).changes,
        );
      } else {
        const exhausted = ack.retryable === false || row.attempt_count >= maxAttempts;
        const nextState = exhausted ? 'retry_exhausted' : 'retry_wait';
        const nextAttemptAt = exhausted
          ? null
          : opts.nowUnixSec + backoffSeconds(backoffBase, row.attempt_count);
        changes = Number(
          ackFailed.run(
            nextState,
            ack.failureCode ?? 'export_failed',
            ack.failureStage ?? 'export',
            nextAttemptAt,
            ack.factUid,
            opts.owner,
          ).changes,
        );
      }
      // The guarded UPDATE raced a competing transition (e.g. reconcile).
      results.push({ factUid: ack.factUid, result: changes > 0 ? 'acknowledged' : 'lease_lost' });
    } catch (err) {
      log.error(
        { err, factUid: ack.factUid, ...(runId ? { runId } : {}) },
        'ackFacts: acknowledgement write failed',
      );
      results.push({ factUid: ack.factUid, result: 'write_failed' });
    }
  }
  return results;
}

export interface ReconcileOptions {
  nowUnixSec: number;
  maxAttempts?: number;
  backoffBaseSeconds?: number;
}

/**
 * Crash/expiry reconciliation: every leased row whose lease has expired is
 * returned to the retry lane (retry_wait with backoff) or, once attempts are
 * exhausted, parked terminally as retry_exhausted. failure_code records
 * 'lease_expired' so self-healing can distinguish a crashed consumer from a
 * remote rejection. Idempotent; safe to run on every start() and tick.
 */
export function reconcileExpiredLeases(
  db: Database,
  opts: ReconcileOptions,
): { expired: number; exhausted: number } {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_FACT_EXPORT_MAX_ATTEMPTS;
  const backoffBase = opts.backoffBaseSeconds ?? DEFAULT_FACT_EXPORT_BACKOFF_BASE_SEC;

  const rows = db.raw
    .prepare(
      `SELECT id, attempt_count FROM fact_export_queue
        WHERE state = 'leased' AND lease_expires_at < ?
        ORDER BY id`,
    )
    .all(opts.nowUnixSec) as Array<{ id: number; attempt_count: number }>;

  const requeue = db.raw.prepare(
    `UPDATE fact_export_queue
        SET state = ?,
            failure_code = 'lease_expired',
            failure_stage = 'reconcile',
            next_attempt_at = ?,
            lease_owner = NULL,
            lease_expires_at = NULL
      WHERE id = ? AND state = 'leased'`,
  );

  let expired = 0;
  let exhausted = 0;
  for (const row of rows) {
    const isExhausted = row.attempt_count >= maxAttempts;
    const nextAttemptAt = isExhausted
      ? null
      : opts.nowUnixSec + backoffSeconds(backoffBase, row.attempt_count);
    const changes = Number(
      requeue.run(isExhausted ? 'retry_exhausted' : 'retry_wait', nextAttemptAt, row.id).changes,
    );
    if (changes > 0) {
      expired += 1;
      if (isExhausted) exhausted += 1;
    }
  }
  return { expired, exhausted };
}

/** Redacted per-row projection for the operator reader — opaque uid, state,
 * attempt accounting, and stable failure codes only. The identity-bearing
 * fact_id, chat/sender JIDs, payload JSON, and lease owner never cross. */
export interface RedactedFactExportRow {
  fact_uid: string;
  state: string;
  attempt_count: number;
  failure_code: string | null;
  failure_stage: string | null;
  created_at: string;
  next_attempt_at: number | null;
  acked_at: number | null;
}

export interface FactExportQueueSummary {
  counts: Record<string, number>;
  oldest_pending_age_s: number;
  latest_ack_age_s: number | null;
  attempt_histogram: Record<string, number>;
}

export interface ListFactExportQueueOptions {
  state?: string;
  limit?: number;
  nowUnixSec?: number;
}

/**
 * Redacted operator reader (#2567 slice 2). The summary always covers the
 * whole queue (counts by state, oldest pending age, latest ack age, attempt
 * distribution over non-terminal rows); rows are bounded (limit clamp 1..200,
 * default 50, optional state filter), oldest-first.
 */
export function listFactExportQueueRedacted(
  db: Database,
  opts: ListFactExportQueueOptions = {},
): { summary: FactExportQueueSummary; rows: RedactedFactExportRow[] } {
  const now = opts.nowUnixSec ?? Math.floor(Date.now() / 1000);

  const counts: Record<string, number> = {};
  for (const row of queryAll<{ state: string; n: number }>(
    db.raw,
    'SELECT state, COUNT(*) AS n FROM fact_export_queue GROUP BY state',
  )) {
    counts[row.state] = row.n;
  }
  const oldestPending = queryOne<{ t: number | null }>(
    db.raw,
    `SELECT MIN(CAST(strftime('%s', created_at) AS INTEGER)) AS t
       FROM fact_export_queue WHERE state = 'pending'`,
  )?.t ?? null;
  const latestAck = queryOne<{ t: number | null }>(
    db.raw,
    'SELECT MAX(acked_at) AS t FROM fact_export_queue',
  )?.t ?? null;
  const attemptHistogram: Record<string, number> = {};
  for (const row of queryAll<{ attempt_count: number; n: number }>(
    db.raw,
    `SELECT attempt_count, COUNT(*) AS n FROM fact_export_queue
      WHERE attempt_count > 0 AND state IN ('pending', 'leased', 'retry_wait')
      GROUP BY attempt_count`,
  )) {
    attemptHistogram[String(row.attempt_count)] = row.n;
  }

  const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 50)));
  const rows = opts.state
    ? queryAll<RedactedFactExportRow>(
        db.raw,
        `SELECT fact_uid, state, attempt_count, failure_code, failure_stage, created_at, next_attempt_at, acked_at
           FROM fact_export_queue WHERE state = ? ORDER BY id LIMIT ?`,
        opts.state,
        limit,
      )
    : queryAll<RedactedFactExportRow>(
        db.raw,
        `SELECT fact_uid, state, attempt_count, failure_code, failure_stage, created_at, next_attempt_at, acked_at
           FROM fact_export_queue ORDER BY id LIMIT ?`,
        limit,
      );

  return {
    summary: {
      counts,
      oldest_pending_age_s: oldestPending == null ? 0 : Math.max(0, now - oldestPending),
      latest_ack_age_s: latestAck == null ? null : Math.max(0, now - latestAck),
      attempt_histogram: attemptHistogram,
    },
    rows,
  };
}
