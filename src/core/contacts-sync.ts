import { createChildLogger } from '../logger.ts';
import type { Database } from './database.ts';
import { toConversationKey } from './conversation-key.ts';

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
    // Use toConversationKey to correctly strip LID device suffixes (e.g. 123:5@s.whatsapp.net → 123)
    let phone: string;
    try {
      phone = toConversationKey(c.id);
    } catch {
      phone = c.id.replace(/@.*$/, '');
    }
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
