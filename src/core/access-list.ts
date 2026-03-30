import type { Database } from './database.ts';
import { toConversationKey } from './conversation-key.ts';

export type AccessStatus = 'allowed' | 'blocked' | 'pending' | 'seen';
export type SubjectType = 'phone' | 'group';

export interface AccessEntry {
  subjectType: SubjectType;
  subjectId: string;
  status: AccessStatus;
  displayName: string | null;
  requestedAt: string | null;
  decidedAt: string | null;
}

function rowToAccessEntry(row: Record<string, unknown>): AccessEntry {
  return {
    subjectType: row.subject_type as SubjectType,
    subjectId: row.subject_id as string,
    status: row.status as AccessStatus,
    displayName: (row.display_name as string | null) ?? null,
    requestedAt: (row.requested_at as string | null) ?? null,
    decidedAt: (row.decided_at as string | null) ?? null,
  };
}

export function lookupAccess(db: Database, subjectType: SubjectType, subjectId: string): AccessEntry | null {
  const row = db.raw.prepare(
    'SELECT * FROM access_list WHERE subject_type = ? AND subject_id = ?'
  ).get(subjectType, subjectId) as Record<string, unknown> | undefined;
  return row ? rowToAccessEntry(row) : null;
}

export function insertPending(db: Database, subjectType: SubjectType, subjectId: string, displayName: string | null): void {
  db.raw.prepare(
    `INSERT OR IGNORE INTO access_list (subject_type, subject_id, status, display_name, requested_at)
     VALUES (?, ?, 'pending', ?, datetime('now'))`
  ).run(subjectType, subjectId, displayName);
}

export function updateAccess(db: Database, subjectType: SubjectType, subjectId: string, status: 'allowed' | 'blocked'): void {
  db.raw.prepare(
    `UPDATE access_list SET status = ?, decided_at = datetime('now') WHERE subject_type = ? AND subject_id = ?`
  ).run(status, subjectType, subjectId);
}

export function getPendingCount(db: Database): number {
  const row = db.raw.prepare(
    `SELECT COUNT(*) AS cnt FROM access_list WHERE status = 'pending'`
  ).get() as { cnt: number };
  return row.cnt;
}

/**
 * Extract the canonical phone/identity from a JID using toConversationKey.
 * Replaces the old raw suffix-stripping approach for consistency with the
 * rest of the system.
 *
 * Examples:
 *   '15184194479@s.whatsapp.net' → '15184194479'
 *   '81536414179557@lid'         → '81536414179557'
 *   '120363123456789@g.us'       → '120363123456789_at_g.us'
 *
 * Falls back to the old raw @ stripping if the JID has no @, or if
 * toConversationKey throws (invalid JID).
 */
export function extractPhone(jid: string): string {
  const atIdx = jid.indexOf('@');
  if (atIdx === -1) return jid;
  try {
    return toConversationKey(jid);
  } catch {
    return jid.slice(0, atIdx);
  }
}
