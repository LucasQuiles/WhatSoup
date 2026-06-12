import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createChildLogger } from '../../../logger.ts';
import { config } from '../../../config.ts';
import type { Database } from '../../../core/database.ts';
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
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
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

/** Shape of a claimed row as returned to the caller (payload is parsed). */
export interface ClaimedFact {
  id: number;
  factId: string;
  chatJid: string;
  senderJid: string | null;
  namespace: string;
  payload: Omit<ExportableFact, 'factId' | 'chatJid' | 'senderJid' | 'namespace'>;
  createdAt: string;
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

  const stmt = db.raw.prepare(
    `INSERT OR IGNORE INTO fact_export_queue
       (fact_id, chat_jid, sender_jid, namespace, payload_json)
     VALUES (?, ?, ?, ?, ?)`,
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

/**
 * Read up to `limit` rows in `pending` status, oldest-first. Valid rows are
 * NOT mutated — a deployment-provided bridge is responsible for calling
 * `markFactsExported` after Pinecone confirms the upsert.
 *
 * T1 hardening: corrupted payload_json rows are surfaced at log.error
 * (not silently hidden), omitted from the returned array, AND flipped to
 * status='quarantined'. Without the status write, skipped rows stay at the
 * head of the `ORDER BY id` pending queue and permanently occupy batch
 * slots — once `limit` corrupt rows accumulate, export silently stops.
 * Quarantined rows remain in the table for operator triage.
 */
export function claimPendingFacts(db: Database, limit: number): ClaimedFact[] {
  const runId = process.env.MW_MIND_RUN_ID;

  const rows = db.raw
    .prepare(
      `SELECT id, fact_id, chat_jid, sender_jid, namespace, payload_json, created_at
         FROM fact_export_queue
        WHERE status = 'pending'
        ORDER BY id
        LIMIT ?`,
    )
    .all(limit) as Array<{
      id: number;
      fact_id: string;
      chat_jid: string;
      sender_jid: string | null;
      namespace: string;
      payload_json: string;
      created_at: string;
    }>;

  const quarantineRow = db.raw.prepare(
    `UPDATE fact_export_queue SET status = 'quarantined' WHERE id = ? AND status = 'pending'`,
  );

  const claimed: ClaimedFact[] = [];
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.payload_json);
    } catch (err) {
      log.error(
        {
          err,
          factId: row.fact_id,
          rowId: row.id,
          ...(runId ? { runId } : {}),
        },
        'claimPendingFacts: payload_json not valid JSON -- quarantining row',
      );
      quarantineRow.run(row.id);
      continue;
    }

    const validated = PayloadSchema.safeParse(parsed);
    if (!validated.success) {
      log.error(
        {
          factId: row.fact_id,
          rowId: row.id,
          issues: validated.error.issues,
          ...(runId ? { runId } : {}),
        },
        'claimPendingFacts: payload_json failed schema validation -- quarantining row',
      );
      quarantineRow.run(row.id);
      continue;
    }

    claimed.push({
      id: row.id,
      factId: row.fact_id,
      chatJid: row.chat_jid,
      senderJid: row.sender_jid,
      namespace: row.namespace,
      payload: validated.data as ClaimedFact['payload'],
      createdAt: row.created_at,
    });
  }
  return claimed;
}

/**
 * Mark the given fact IDs as exported. Sets `status='exported'` and
 * `exported_at=datetime('now')`. Does not touch `payload_json`.
 * Unknown fact IDs are silently ignored.
 */
export function markFactsExported(db: Database, factIds: string[]): void {
  if (factIds.length === 0) return;

  const stmt = db.raw.prepare(
    `UPDATE fact_export_queue
        SET status = 'exported',
            exported_at = datetime('now')
      WHERE fact_id = ? AND status = 'pending'`,
  );

  for (const id of factIds) {
    try {
      stmt.run(id);
    } catch (err) {
      log.error({ err, factId: id }, 'markFactsExported: single row update failed');
    }
  }
}
