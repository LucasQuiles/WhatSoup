import type { Database } from './database.ts';
import { toConversationKey } from './conversation-key.ts';
import { DOMAIN_LID, DOMAIN_SMS, isLidJid, normalizeLid, smsJidToPhone } from './jid-constants.ts';
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
 * Seed a declared set of group JIDs as auto-respond ('allowed') access entries.
 *
 * This is the durable, config-driven equivalent of the admin-phone seed in
 * `main.ts`: instead of relying on a hand-inserted `access_list` row per
 * instance (imperative, lost on a DB rebuild, invisible to source), the operator
 * declares `autoRespondGroups` in instance config and the grant is reconstructed
 * from that list at every startup.
 *
 * Insert-only-when-absent: a group that already has ANY row (allowed, blocked, or
 * pending) is left untouched, so a deliberate block or a pending review is never
 * silently overridden by the seed. Returns the number of NEW rows inserted.
 */
export function seedAutoRespondGroups(db: Database, jids: Iterable<string>): number {
  let seeded = 0;
  const seen = new Set<string>();
  for (const raw of jids) {
    const jid = typeof raw === 'string' ? raw.trim() : '';
    if (!jid || seen.has(jid)) continue;
    seen.add(jid);
    if (lookupAccess(db, 'group', jid)) continue; // preserve any explicit decision
    insertAllowed(db, 'group', jid);
    seeded += 1;
  }
  return seeded;
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
 *   '15555550101@s.whatsapp.net' → '15555550101'
 *   '81536414179557@lid'         → '81536414179557'  (opaque LID!)
 *   '120363555555555000@g.us'    → '120363555555555000_at_g.us'
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
 * Resolve a JID to an actual phone number, handling LID→phone translation
 * and SMS E.164→digits normalization.
 *
 * For personal JIDs (`@s.whatsapp.net`), returns the phone digits directly.
 * For LID JIDs (`@lid`), resolves through the lid_mappings DB table to find
 * the real phone number. Returns the raw LID number as fallback only if
 * resolution fails (caller should handle this case).
 * For SMS JIDs (`@sms`), strips the leading '+' from the E.164 local part
 * to match the repo phone-subject convention (digits without leading '+').
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
 *   resolvePhoneFromJid('15555550101@s.whatsapp.net', db) → '15555550101'
 *   resolvePhoneFromJid('11111119999@lid', db)            → '15555551234' (resolved)
 *   resolvePhoneFromJid('99999999@lid', db)               → '99999999'   (unresolvable fallback)
 *   resolvePhoneFromJid('+15555550100@sms', db)           → '15555550100' (E.164 → digits)
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

  if (domain === DOMAIN_SMS) {
    // Delegate to the canonical SMS JID→phone normalization (digits without
    // leading '+', the repo's phone-subject convention).
    return smsJidToPhone(jid);
  }

  // Personal JID or other — delegate to extractLocal
  return extractLocal(jid);
}

/**
 * Canonical conversation_key for a chat JID, mirroring the live-ingest contract
 * (src/core/ingest.ts: `!isGroup && isLidJid(chatJid) ? resolvePhoneFromJid : toConversationKey`).
 * A LID DM resolves to its phone-based key so the same person's history-sync /
 * chat-sync rows share ONE conversation thread with the phone-keyed live messages
 * (QR-037 / QR-043). For non-LID JIDs (personal / group / sms) and UNMAPPED LIDs
 * this is identical to `toConversationKey` — `resolvePhoneFromJid` falls back to the
 * normalized LID number — so the only behavior change is that a MAPPED LID DM,
 * previously split under the raw LID number, now keys to the resolved phone.
 */
export function canonicalConversationKey(jid: string, db: Database): string {
  if (isLidJid(jid)) return resolvePhoneFromJid(jid, db);
  return toConversationKey(jid);
}
