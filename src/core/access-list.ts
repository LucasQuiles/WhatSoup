import type { Database } from './database.ts';
import { conversationRefToJid, toConversationKey } from './conversation-key.ts';
import {
  DOMAIN_LID,
  DOMAIN_SIGNAL,
  DOMAIN_SMS,
  JID_GROUP,
  JID_IMESSAGE,
  JID_SIGNAL,
  fromImessageJid,
  hasKnownTransportJidSuffix,
  isGroupJid,
  isImessageJid,
  isLidJid,
  isAuthenticatedSenderForTransport,
  isSenderJidForTransport,
  normalizeLid,
  smsJidToPhone,
} from './jid-constants.ts';
import { resolveLid } from './lid-resolver.ts';
import { normalizePhoneE164Wire } from '../lib/phone.ts';
import {
  canonicalizeImessageDirectIdentity,
  SIGNAL_UUID_RE,
} from './transport-refs.ts';

export type AccessStatus = 'allowed' | 'blocked' | 'pending' | 'seen';
export type SubjectType = 'phone' | 'group';

function isGroupJidForTransport(jid: string, transport: string | null | undefined): boolean {
  if (!isGroupJid(jid)) return false;
  if (transport === 'signal') return jid.endsWith(JID_SIGNAL);
  if (transport === 'imessage') return jid.endsWith(JID_IMESSAGE);
  if (transport === 'twilio') return false;
  return jid.endsWith(JID_GROUP);
}

/** Normalize console/API raw-or-canonical chat references to access-list identities. */
export function normalizeAccessSubjectRef(
  db: Database,
  transport: string | null | undefined,
  subjectType: SubjectType,
  subjectRef: string,
): string | null {
  const jid = conversationRefToJid(subjectRef);
  if (subjectType === 'group') {
    return isGroupJidForTransport(jid, transport) ? jid : null;
  }
  if (isGroupJid(jid)) return null;
  if (!hasKnownTransportJidSuffix(jid)) {
    if (transport === 'signal') {
      const wire = normalizePhoneE164Wire(subjectRef);
      return wire ?? (SIGNAL_UUID_RE.test(subjectRef) ? subjectRef : null);
    }
    if (transport === 'imessage') {
      return canonicalizeImessageDirectIdentity(subjectRef);
    }
    if (transport === 'baileys' || transport === 'twilio' || transport == null) {
      return normalizePhoneE164Wire(subjectRef)?.slice(1) ?? null;
    }
    return null;
  }
  if (!isSenderJidForTransport(jid, transport)) return null;
  return resolvePhoneFromJid(jid, db);
}

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
  if (isImessageJid(jid)) {
    return fromImessageJid(jid);
  }

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

  if (domain === DOMAIN_SIGNAL) {
    // Signal UUIDs/E.164 identities are already canonical local identifiers.
    // Do not route them through toConversationKey, which intentionally encodes
    // non-WhatsApp domains as `<local>_at_<domain>` storage keys.
    return local;
  }

  // Personal JID or other — delegate to extractLocal
  return extractLocal(jid);
}

/**
 * GRANT-direction identity resolution (QR-143). Returns `null` unless the JID's
 * authenticated namespace matches the instance's configured transport, then
 * returns the same canonical identity as `resolvePhoneFromJid(jid, db)`.
 *
 * WHY: `resolvePhoneFromJid` collapses a spoofable `<digits>@sms` JID to the SAME
 * bare identity as a configured phone admin. Every admin/allow GRANT decision
 * MUST gate on the configured transport BEFORE matching the identity (see
 * `isAuthenticatedSenderForTransport` in jid-constants.ts). This primitive collapses
 * the easy-to-forget two-step discipline (call the predicate, THEN the resolver,
 * in the right order, every time) into a single fail-closed call, so a grant site
 * cannot get it wrong.
 *
 * USE THIS at every grant site instead of the general-purpose `resolvePhoneFromJid`.
 * The general resolver stays correct for NON-grant uses — display prefixes, rate
 * limiting, storage keying, directory population, outbound routing — and for
 * DENY-side (blocklist) checks, which must stay transport-agnostic. The CI
 * inventory guard (`scripts/grant-resolver-inventory-guard.ts`) fails the build if
 * a new inline `isAdminPhone(resolvePhoneFromJid(...))` grant composition appears
 * outside the allowlisted deny/display sites.
 */
export function resolvePhoneFromJidForGrant(
  jid: string | null | undefined,
  db: Database,
  transport: string | null | undefined = 'baileys',
): string | null {
  // Explicit null check also narrows `jid` to a non-null string for the resolver.
  if (jid == null || !isAuthenticatedSenderForTransport(jid, transport)) return null;
  return resolvePhoneFromJid(jid, db);
}

/**
 * Canonicalize a raw chat JID to the `conversation_key` that message INGEST
 * stores under, so recent-history reads match what was written.
 *
 * This MUST mirror the store-side keying in `src/core/ingest.ts`:
 *   `(!isGroup && isLidJid(chatJid)) ? resolvePhoneFromJid(chatJid, db) : toConversationKey(chatJid)`
 * `isLidJid` already excludes group JIDs (they are `@g.us`, never `@lid`), so
 * the `!isGroup` guard is subsumed here. For a MAPPED `@lid` DM, ingest keys the
 * row under the resolved PHONE while `toConversationKey('<lid>@lid')` stays the
 * raw LID number — so reading recent history with a bare `toConversationKey`
 * queries the wrong key and returns nothing (QR-050). Use this at every
 * `getRecentMessages` / `getMessagesSince` read site whose key is derived from a
 * raw `msg.key.remoteJid`.
 */
export function canonicalConversationKey(jid: string, db: Database): string {
  return isLidJid(jid) ? resolvePhoneFromJid(jid, db) : toConversationKey(jid);
}
