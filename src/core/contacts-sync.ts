import { createChildLogger } from '../logger.ts';
import type { Database } from './database.ts';

const log = createChildLogger('contacts-sync');

interface BaileysContact {
  id: string;
  name?: string;
  notify?: string;
}

export function handleContactsUpsert(db: Database, contacts: BaileysContact[]): void {
  const stmt = db.raw.prepare(`
    INSERT INTO contacts (jid, canonical_phone, display_name, notify_name, last_seen_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(jid) DO UPDATE SET
      display_name = COALESCE(excluded.display_name, display_name),
      notify_name = COALESCE(excluded.notify_name, notify_name),
      last_seen_at = datetime('now')
  `);

  for (const c of contacts) {
    const phone = c.id.replace(/@.*$/, '');
    stmt.run(c.id, phone, c.name ?? null, c.notify ?? null);
  }
  log.debug({ count: contacts.length }, 'contacts upserted');
}

export function handleContactsUpdate(db: Database, updates: Array<{ id: string; notify?: string; name?: string }>): void {
  for (const u of updates) {
    if (u.notify !== undefined) {
      db.raw.prepare("UPDATE contacts SET notify_name = ?, last_seen_at = datetime('now') WHERE jid = ?")
        .run(u.notify, u.id);
    }
    if (u.name !== undefined) {
      db.raw.prepare("UPDATE contacts SET display_name = ?, last_seen_at = datetime('now') WHERE jid = ?")
        .run(u.name, u.id);
    }
  }
  log.debug({ count: updates.length }, 'contacts updated');
}
