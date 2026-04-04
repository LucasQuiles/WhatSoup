import type { Database } from './database.ts';
import { toConversationKey } from './conversation-key.ts';
import { DOMAIN_LID, normalizeLid } from './jid-constants.ts';
import { resolveLid } from './lid-resolver.ts';

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

export function insertAllowed(db: Database, subjectType: SubjectType, subjectId: string): void {
  db.raw.prepare(
    `INSERT OR IGNORE INTO access_list (subject_type, subject_id, status, display_name, decided_at)
     VALUES (?, ?, 'allowed', NULL, datetime('now'))`
  ).run(subjectType, subjectId);
}

/**
 * Insert-or-update a subject as 'allowed'.
 * If the row already exists (any status), updates to 'allowed' with a fresh decided_at.
 * If it does not exist, inserts a new row.
 */
export function upsertAllowed(db: Database, subjectType: SubjectType, subjectId: string): void {
  const existing = lookupAccess(db, subjectType, subjectId);
  if (existing) {
    updateAccess(db, subjectType, subjectId, 'allowed');
  } else {
    insertAllowed(db, subjectType, subjectId);
  }
}

export function updateAccess(db: Database, subjectType: SubjectType, subjectId: string, status: 'allowed' | 'blocked'): void {
  db.raw.prepare(
    `UPDATE access_list SET status = ?, decided_at = datetime('now') WHERE subject_type = ? AND subject_id = ?`
  ).run(status, subjectType, subjectId);
}

/**
 * Insert-or-update access entry. Used by POST /access for subjects
 * that may or may not already exist in the access list.
 */
export function upsertAccess(
  db: Database,
  subjectType: SubjectType,
  subjectId: string,
  status: 'allowed' | 'blocked',
): { action: 'inserted' | 'updated' } {
  const existing = lookupAccess(db, subjectType, subjectId);
  if (existing) {
    updateAccess(db, subjectType, subjectId, status);
    return { action: 'updated' };
  }
  db.raw.prepare(
    `INSERT INTO access_list (subject_type, subject_id, status, decided_at)
     VALUES (?, ?, ?, datetime('now'))`
  ).run(subjectType, subjectId, status);
  return { action: 'inserted' };
}

export function getPendingCount(db: Database): number {
  const row = db.raw.prepare(
    `SELECT COUNT(*) AS cnt FROM access_list WHERE status = 'pending'`
  ).get() as { cnt: number };
  return row.cnt;
}

/**
 * Extract the local part of a JID (the portion before the @).
 *
 * WARNING: For LID JIDs this returns the opaque LID number, NOT a phone
 * number. If you need an actual phone number for identity checks (admin
 * verification, access control, approval requests, display names), use
 * `resolvePhoneFromJid(jid, db)` instead.
 *
 * Examples:
 *   '15184194479@s.whatsapp.net' → '15184194479'
 *   '81536414179557@lid'         → '81536414179557'  (opaque LID!)
 *   '120363123456789@g.us'       → '120363123456789_at_g.us'
 */
export function extractLocal(jid: string): string {
  const atIdx = jid.indexOf('@');
  if (atIdx === -1) return jid;
  try {
    return toConversationKey(jid);
  } catch {
    return jid.slice(0, atIdx);
  }
}

/**
 * @deprecated Use `extractLocal()` for local parts or `resolvePhoneFromJid()` for identity checks.
 * Kept as alias to avoid breaking external callers during migration.
 */
export const extractPhone = extractLocal;

/**
 * Resolve a JID to an actual phone number, handling LID→phone translation.
 *
 * For personal JIDs (`@s.whatsapp.net`), returns the phone digits directly.
 * For LID JIDs (`@lid`), resolves through the lid_mappings DB table to find
 * the real phone number. Returns the raw LID number as fallback only if
 * resolution fails (caller should handle this case).
 *
 * This is the ONLY function that should be used when you need an actual
 * phone number for:
 *   - Admin phone checks (isAdminPhone)
 *   - Access list lookups
 *   - Approval requests
 *   - Display to users or LLMs
 *   - Contact directory population
 *
 * Examples:
 *   resolvePhoneFromJid('15184194479@s.whatsapp.net', db) → '15184194479'
 *   resolvePhoneFromJid('81536414179557@lid', db)         → '18455880337' (resolved)
 *   resolvePhoneFromJid('99999999@lid', db)               → '99999999'   (unresolvable fallback)
 */
export function resolvePhoneFromJid(jid: string, db: Database): string {
  const atIdx = jid.indexOf('@');
  if (atIdx === -1) return jid;

  const local = jid.slice(0, atIdx);
  const domain = jid.slice(atIdx + 1);

  if (domain === DOMAIN_LID) {
    // resolveLid handles colon-device suffix normalization internally
    const resolved = resolveLid(db, local);
    // Fallback: return normalized LID (colon-device suffix stripped)
    return resolved ?? normalizeLid(local);
  }

  // Personal JID or other — delegate to extractLocal
  return extractLocal(jid);
}
