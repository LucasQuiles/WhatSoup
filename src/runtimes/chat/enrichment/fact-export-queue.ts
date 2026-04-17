import { createChildLogger } from '../../../logger.ts';
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
  namespace?: string;
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
 * Insert validated facts into the export queue. Duplicate `fact_id` values
 * are ignored (INSERT OR IGNORE) so callers can retry safely.
 *
 * Returns the number of rows actually inserted (excludes duplicates).
 */
export function enqueueFacts(db: Database, facts: ExportableFact[]): number {
  if (facts.length === 0) return 0;

  const stmt = db.raw.prepare(
    `INSERT OR IGNORE INTO fact_export_queue
       (fact_id, chat_jid, sender_jid, namespace, payload_json)
     VALUES (?, ?, ?, ?, ?)`,
  );

  let inserted = 0;
  for (const fact of facts) {
    const payload = {
      text: fact.text,
      memoryType: fact.memoryType,
      confidence: fact.confidence,
      senderName: fact.senderName,
      supersedesText: fact.supersedesText,
      sourceMessagePks: fact.sourceMessagePks,
    };
    try {
      const result = stmt.run(
        fact.factId,
        fact.chatJid,
        fact.senderJid,
        fact.namespace ?? 'whatsapp-facts',
        JSON.stringify(payload),
      );
      if (Number(result.changes) > 0) inserted += 1;
    } catch (err) {
      log.warn({ err, factId: fact.factId }, 'enqueueFacts: insert failed');
    }
  }
  return inserted;
}

/**
 * Read up to `limit` rows in `pending` status, oldest-first. This is a
 * read-only operation — it does NOT mutate row state. The caller
 * (the mw-mind Python pipeline) is responsible for calling
 * `markFactsExported` after Pinecone confirms the upsert.
 */
export function claimPendingFacts(db: Database, limit: number): ClaimedFact[] {
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

  const claimed: ClaimedFact[] = [];
  for (const row of rows) {
    let payload: ClaimedFact['payload'];
    try {
      payload = JSON.parse(row.payload_json);
    } catch (err) {
      log.warn(
        { err, factId: row.fact_id },
        'claimPendingFacts: payload_json parse failed — skipping row',
      );
      continue;
    }
    claimed.push({
      id: row.id,
      factId: row.fact_id,
      chatJid: row.chat_jid,
      senderJid: row.sender_jid,
      namespace: row.namespace,
      payload,
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
