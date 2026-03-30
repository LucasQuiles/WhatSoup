// src/core/label-sync.ts
// Persist Baileys label events to the labels and label_associations tables.

import { createChildLogger } from '../logger.ts';
import type { Database } from './database.ts';

const log = createChildLogger('label-sync');

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LabelRecord {
  id: string;
  name: string;
  color?: number;
  predefinedId?: string;
}

export interface LabelAssociationRecord {
  labelId: string;
  type: string; // 'chat' | 'message'
  chatJid?: string;
  messageId?: string;
  operation?: 'add' | 'remove';
}

// ─── handlers ─────────────────────────────────────────────────────────────────

/**
 * Handle labels.edit event — upsert label records into the labels table.
 */
export function handleLabelsEdit(db: Database, labels: LabelRecord[]): void {
  if (!Array.isArray(labels) || labels.length === 0) return;
  const stmt = db.raw.prepare(`
    INSERT INTO labels (id, name, color, predefined_id, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      color = excluded.color,
      predefined_id = excluded.predefined_id,
      updated_at = datetime('now')
  `);

  for (const label of labels) {
    stmt.run(
      label.id,
      label.name,
      label.color ?? null,
      label.predefinedId ?? null,
    );
  }
  log.debug({ count: labels.length }, 'labels upserted');
}

/**
 * Handle labels.association event — upsert or delete label_association records.
 *
 * When operation is 'remove' (or absent with no meaningful payload), deletes
 * the matching row; otherwise inserts/ignores.
 */
export function handleLabelsAssociation(db: Database, data: LabelAssociationRecord): void {
  // Use empty string as NULL sentinel — SQLite treats NULL as distinct in UNIQUE
  // constraints, so we normalize absent fields to '' to keep dedup working.
  const { labelId, type, operation = 'add' } = data;

  if (!labelId) {
    log.warn({ data }, 'labels association: labelId is empty — skipping');
    return;
  }
  const chatJid = data.chatJid ?? '';
  const messageId = data.messageId ?? '';

  if (operation === 'remove') {
    db.raw
      .prepare(
        `DELETE FROM label_associations
         WHERE label_id = ? AND type = ? AND chat_jid = ? AND message_id = ?`,
      )
      .run(labelId, type, chatJid, messageId);
    log.debug({ labelId, type, chatJid, messageId }, 'label association removed');
    return;
  }

  db.raw
    .prepare(
      `INSERT OR IGNORE INTO label_associations (label_id, type, chat_jid, message_id)
       VALUES (?, ?, ?, ?)`,
    )
    .run(labelId, type, chatJid, messageId);
  log.debug({ labelId, type, chatJid, messageId }, 'label association added');
}

/**
 * Delete any label_associations rows whose label_id no longer exists in labels.
 * Call after each labels.edit event to keep associations consistent.
 * Returns the number of rows deleted.
 */
export function cleanupOrphanedAssociations(db: Database): number {
  const result = db.raw.prepare(`
    DELETE FROM label_associations
    WHERE label_id NOT IN (SELECT id FROM labels)
  `).run();
  const deleted = (result as unknown as { changes: number }).changes ?? 0;
  if (deleted > 0) log.info({ deleted }, 'cleaned up orphaned label associations');
  return deleted;
}
