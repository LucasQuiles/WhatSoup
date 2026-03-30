// src/core/blocklist-sync.ts
// Persist Baileys blocklist events to the blocklist table.

import { createChildLogger } from '../logger.ts';
import type { Database } from './database.ts';

const log = createChildLogger('blocklist-sync');

/**
 * Replace the entire persisted blocklist (from blocklist.set event).
 * Deletes all existing rows and re-inserts the full list atomically.
 */
export function handleBlocklistSet(db: Database, jids: string[]): void {
  if (!Array.isArray(jids)) return;
  db.raw.exec('DELETE FROM blocklist');
  const stmt = db.raw.prepare('INSERT OR IGNORE INTO blocklist (jid) VALUES (?)');
  for (const jid of jids) {
    stmt.run(jid);
  }
  log.info({ count: jids.length }, 'blocklist synced');
}

/**
 * Apply an incremental blocklist update (from blocklist.update event).
 * type 'add' inserts new rows; type 'remove' deletes matching rows.
 */
export function handleBlocklistUpdate(
  db: Database,
  data: { blocklist: string[]; type: string },
): void {
  if (!Array.isArray(data?.blocklist)) return;

  if (data.type === 'add') {
    const stmt = db.raw.prepare('INSERT OR IGNORE INTO blocklist (jid) VALUES (?)');
    for (const jid of data.blocklist) {
      stmt.run(jid);
    }
  } else if (data.type === 'remove') {
    const stmt = db.raw.prepare('DELETE FROM blocklist WHERE jid = ?');
    for (const jid of data.blocklist) {
      stmt.run(jid);
    }
  }
  log.debug({ count: data.blocklist.length, type: data.type }, 'blocklist updated');
}
