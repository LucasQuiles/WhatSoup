// src/core/blocklist-sync.ts
// Persist Baileys blocklist events to the blocklist table AND propagate
// block/unblock actions to the access_list so access-policy enforces them.

import { createChildLogger } from '../logger.ts';
import type { Database } from './database.ts';
import { upsertAccess, lookupAccess, resolvePhoneFromJid } from './access-list.ts';

const log = createChildLogger('blocklist-sync');

/**
 * Replace the entire persisted blocklist (from blocklist.set event).
 * Deletes all existing rows and re-inserts the full list within a transaction.
 * Also propagates block status to access_list for each JID.
 */
export function handleBlocklistSet(db: Database, jids: string[]): void {
  if (!Array.isArray(jids)) return;
  const stmt = db.raw.prepare('INSERT OR IGNORE INTO blocklist (jid) VALUES (?)');
  db.raw.exec('BEGIN');
  try {
    db.raw.exec('DELETE FROM blocklist');
    for (const jid of jids) {
      stmt.run(jid);
    }
    // Propagate to access_list: mark each blocked phone.
    // resolvePhoneFromJid handles both personal JIDs and LID JIDs.
    for (const jid of jids) {
      const phone = resolvePhoneFromJid(jid, db);
      if (phone && phone.length >= 5) {
        upsertAccess(db, 'phone', phone, 'blocked');
      }
    }
    db.raw.exec('COMMIT');
  } catch (err) {
    db.raw.exec('ROLLBACK');
    throw err;
  }
  log.info({ count: jids.length }, 'blocklist synced');
}

/**
 * Apply an incremental blocklist update (from blocklist.update event).
 * type 'add' inserts new rows; type 'remove' deletes matching rows.
 * Propagates to access_list: 'add' → blocked, 'remove' → allowed (if currently blocked).
 */
export function handleBlocklistUpdate(
  db: Database,
  data: { blocklist: string[]; type: string },
): void {
  if (!Array.isArray(data?.blocklist)) return;

  db.raw.exec('BEGIN');
  try {
    if (data.type === 'add') {
      const stmt = db.raw.prepare('INSERT OR IGNORE INTO blocklist (jid) VALUES (?)');
      for (const jid of data.blocklist) {
        stmt.run(jid);
        const phone = resolvePhoneFromJid(jid, db);
        if (phone && phone.length >= 5) {
          upsertAccess(db, 'phone', phone, 'blocked');
        }
      }
    } else if (data.type === 'remove') {
      const stmt = db.raw.prepare('DELETE FROM blocklist WHERE jid = ?');
      for (const jid of data.blocklist) {
        stmt.run(jid);
        const phone = resolvePhoneFromJid(jid, db);
        if (phone && phone.length >= 5) {
          const entry = lookupAccess(db, 'phone', phone);
          if (entry?.status === 'blocked') {
            upsertAccess(db, 'phone', phone, 'allowed');
          }
        }
      }
    }
    db.raw.exec('COMMIT');
  } catch (err) {
    db.raw.exec('ROLLBACK');
    throw err;
  }
  log.debug({ count: data.blocklist.length, type: data.type }, 'blocklist updated');
}
