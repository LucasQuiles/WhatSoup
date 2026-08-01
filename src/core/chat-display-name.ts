// src/core/chat-display-name.ts
// Human-readable chat display names for owner-facing renders (the /sessions
// list and the /kill-session ack). Owner ruling (B23, verbatim): "sessions
// should show contact names, group names, etc — not unrecognizable JID/LID
// mappings or phone numbers".
//
// Resolution ladder (most-owner-meaningful first):
//   1. chat_aliases.alias      — the owner's own name for the chat (config
//      `chatAliases` seeds this table at startup: main.ts → seedChatAliases,
//      chats-resolver.ts). Most recently updated alias wins. Lid refs are
//      resolved to their phone forms BEFORE this rung so aliases keyed by
//      the phone JID win for lid-keyed sessions (B25 F7).
//   2. groups.subject          — WhatsApp group subject (groups metadata)
//      then chats.name         — chat-level name (chat-sync)
//   3. contacts.display_name / notify_name — contact address-book/push name.
//      Lid refs probe the '@lid'-keyed contact row (contacts-sync stores raw
//      Baileys ids with canonical_phone = bare lid digits, B25 F6) AND the
//      lid_mappings-resolved phone row (via resolveLid — L1.5 disk fallback
//      and heal-back included, B25 F5). Phone-origin refs probe the REVERSE
//      direction too: their known lid alias forms via resolveLidsForPhone
//      (B27 — the real names of a phone-keyed DM often live only under the
//      sibling '<lid>@lid' rows).
//   4. messages.sender_name    — most recent non-blank push name observed on
//      a message from the jid (richly populated per the B25 data survey).
//      DIGIT-ONLY push names are rejected (B27): a name that is nothing but
//      its own number (phone-as-push-name) is not a name — skip to the next
//      candidate/rung instead of rendering the bare digit string.
//   5. formatted phone (+digits) — ONLY for refs proven phone-origin or with
//      a lid→phone mapping; never fabricated from a bare/unmapped lid (B25 F1)
//   6. the raw ref, unchanged  — last resort; NEVER throws on a miss
//
// Inputs may be a conversation_key ('123_at_g.us' / bare DM local) or a raw
// JID ('123@g.us' / '123@s.whatsapp.net' / '123@lid') — the runtime's session
// maps carry both shapes (per-chat keys vs activeChatJid).
//
// Signature note (B25 F5): this module takes the `Database` wrapper, not the
// raw DatabaseSync — resolveLid requires the wrapper (its L1.5 disk fallback
// writes through it), and the runtime call sites already hold `this.db`.
// Threading `.raw` would have forced a reverse adapter at the resolveLid seam.
//
// Purity/cost: every step is a single-row read on the local SQLite handle the
// runtime already holds — no network, render-safe. Prepared statements are
// cached per raw handle (lazy WeakMap); a failed prepare (missing table, mock
// handle) is memoized as a miss so degraded handles never re-prepare. Every
// DB read is individually fail-open (degrades to the next ladder step),
// matching the "never crash on a miss" contract locked by
// tests/core/chat-display-name.test.ts.

import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { Database } from './database.ts';
import { isGroupConversationKey, conversationKeyToJid } from './conversation-key.ts';
import {
  toPersonalJid,
  toLidJid,
  isPnJid,
  isLidJid,
  bareNumber,
  normalizeLid,
} from './jid-constants.ts';
import { resolveLid, resolveLidsForPhone } from './lid-resolver.ts';
import { isPhoneLocal } from '../lib/phone.ts';
import { nonEmptyString } from '../lib/type-guards.ts';

/**
 * Digit floor above which an UNMAPPED bare numeric ref is treated as a
 * probable lid rather than a phone. Residual ambiguity, documented honestly:
 * an unmapped lid is indistinguishable from a phone by shape. E.164 tops out
 * at 15 digits, but the phones this codebase actually renders are 11-digit
 * NANP-style locals, while every observed lid (fixtures, review exhibits,
 * live lid_mappings) is 12-15 digits. A real 12-15-digit international phone
 * that somehow arrives as a BARE unmapped key therefore renders as its raw
 * ref (mildly ugly, still actionable) instead of an unmapped lid rendering
 * as a fabricated '+<lid>' (actively misleading — B25 F1). Phone-origin refs
 * that arrive as full '@s.whatsapp.net' JIDs are unaffected by this cut.
 */
const LID_SUSPECT_MIN_DIGITS = 12;

/** Non-empty trimmed string, else null — blank DB values are misses. */
function nonEmpty(value: unknown): string | null {
  return nonEmptyString(value);
}

/**
 * Rung-4 guard (B27): a push name that is nothing but digits — its own
 * number, phone-as-push-name — is not a name. Treat it as a miss so the
 * ladder tries the next candidate jid / rung; even the terminal fallbacks
 * (formatted '+phone', raw ref) are more honest than bare digits posing as
 * a resolved name.
 */
function nonDigitName(value: unknown): string | null {
  const name = nonEmpty(value);
  return name !== null && /^\d+$/.test(name) ? null : name;
}

// ── Prepared-statement cache ────────────────────────────────────────────────
// Keyed by the raw handle; `null` memoizes a failed prepare (absent table,
// mock handle) so the fail-open path never re-prepares a known miss.

const stmtCache = new WeakMap<DatabaseSync, Map<string, StatementSync | null>>();

function getStmt(raw: DatabaseSync, sql: string): StatementSync | null {
  let forDb = stmtCache.get(raw);
  if (!forDb) {
    forDb = new Map();
    stmtCache.set(raw, forDb);
  }
  const cached = forDb.get(sql);
  if (cached !== undefined || forDb.has(sql)) return cached ?? null;
  let stmt: StatementSync | null;
  try {
    stmt = raw.prepare(sql);
  } catch {
    stmt = null;
  }
  forDb.set(sql, stmt);
  return stmt;
}

/** Fail-open single-row read: any throw (missing table, mock db) is a miss. */
function getRow(
  raw: DatabaseSync,
  sql: string,
  params: string[],
): Record<string, unknown> | undefined {
  const stmt = getStmt(raw, sql);
  if (!stmt) return undefined;
  try {
    return stmt.get(...params) as Record<string, unknown> | undefined;
  } catch {
    return undefined;
  }
}

// Multi-alias pick: most recently updated, not alphabetical (B25 below-cap).
const SQL_ALIAS =
  'SELECT alias FROM chat_aliases WHERE chat_jid = ? ORDER BY updated_at DESC LIMIT 1';
const SQL_GROUP_SUBJECT = 'SELECT subject FROM groups WHERE jid = ? LIMIT 1';
// OR-lookups order by named-ness so a named row always beats a NULL/blank row
// regardless of rowid order (B25 F9). Blank counts as unnamed, mirroring
// nonEmpty().
const SQL_CHAT_NAME =
  'SELECT name FROM chats WHERE jid = ? OR conversation_key = ? ' +
  "ORDER BY (name IS NULL OR TRIM(name) = '') LIMIT 1";
const SQL_CONTACT_NAME =
  'SELECT display_name, notify_name FROM contacts WHERE jid = ? OR canonical_phone = ? ' +
  "ORDER BY (display_name IS NULL OR TRIM(display_name) = ''), " +
  "(notify_name IS NULL OR TRIM(notify_name) = '') LIMIT 1";
const SQL_SENDER_NAME =
  'SELECT sender_name FROM messages ' +
  "WHERE sender_jid = ? AND sender_name IS NOT NULL AND TRIM(sender_name) <> '' " +
  'ORDER BY timestamp DESC LIMIT 1';
// Sibling-identity evidence probes (see personalIdentityExists).
const SQL_CONTACT_EXISTS = 'SELECT 1 AS present FROM contacts WHERE jid = ? LIMIT 1';
const SQL_CHAT_EXISTS = 'SELECT 1 AS present FROM chats WHERE jid = ? LIMIT 1';

/**
 * Resolve a chat reference (conversation_key or raw JID) to the most
 * owner-meaningful display name available. Falls back to the raw ref;
 * never throws.
 */
export function resolveChatDisplayName(db: Database, ref: string): string {
  try {
    return resolveLadder(db, ref) ?? ref;
  } catch {
    return ref;
  }
}

/** Known lid → phone digits via the resolution service; fail-open. */
function lidToPhone(db: Database, lidLocal: string): string | null {
  try {
    return resolveLid(db, lidLocal);
  } catch {
    return null;
  }
}

/**
 * REVERSE direction (B27): the known lid alias forms of a phone-origin ref,
 * as full '@lid' jids, via the resolution service; fail-open to none. The
 * live defect class: a phone-keyed DM whose pn rows carry only a
 * phone-as-push-name while every real name lives under the mapped
 * '<lid>@lid' sibling rows.
 */
function phoneLidAliasJids(db: Database, phoneLocal: string): string[] {
  try {
    return resolveLidsForPhone(db, phoneLocal).map(toLidJid);
  } catch {
    return [];
  }
}

/**
 * The typed origin of a chat ref: which keys to probe the name tables with,
 * which jids may reach the contact/sender-name rungs, and whether a formatted
 * phone may be rendered at all (B25 F1: only refs proven phone-origin, or
 * lid refs with a known mapping — never a fabricated '+<lid>').
 */
interface RefShape {
  /** chat_aliases / chats probe keys, in precedence order. */
  probeKeys: string[];
  /** contacts + messages.sender_name probe jids (DMs only). */
  contactJids: string[];
  /** Rung-5 formatted-phone digits; null = this ref must never mint one. */
  phoneDigits: string | null;
  isGroup: boolean;
}

function dedupe(keys: Array<string | null>): string[] {
  return [...new Set(keys.filter((k): k is string => k !== null && k !== ''))];
}

/**
 * Malformed-@lid sibling fold (B25 addendum): some lids carry the PHONE as
 * their userpart — live class: a '<phone>@lid' chat with zero lid-keyed rows
 * while '<phone>@s.whatsapp.net' holds the contact/chat/named-message history
 * of the same person. Inherit that personal-JID identity ONLY on observed
 * evidence: an existing contacts or chats row keyed by the pn jid, or named
 * sender history from it. NEVER on phone shape alone — shape-alone
 * inheritance would recreate the fabricated-'+<lid>' defect (F1): an unmapped
 * lid is indistinguishable from a phone by shape, only by data.
 */
function personalIdentityExists(raw: DatabaseSync, pnJid: string): boolean {
  return (
    getRow(raw, SQL_CONTACT_EXISTS, [pnJid]) !== undefined ||
    getRow(raw, SQL_CHAT_EXISTS, [pnJid]) !== undefined ||
    getRow(raw, SQL_SENDER_NAME, [pnJid]) !== undefined
  );
}

/** Shape for a ref proven lid-origin ('@lid' input, or a bare KNOWN lid). */
function lidShape(db: Database, ref: string, lidLocal: string): RefShape {
  const lidJid = toLidJid(lidLocal);
  const phone = lidToPhone(db, lidLocal);
  const phoneJid = phone !== null ? toPersonalJid(phone) : null;
  // Unmapped only — a lid_mappings hit is stronger evidence than the fold.
  const siblingJid =
    phone === null && personalIdentityExists(db.raw, toPersonalJid(lidLocal))
      ? toPersonalJid(lidLocal)
      : null;
  return {
    // Mapped phone forms first: owner aliases and chat rows are usually keyed
    // by the phone identity (B25 F7).
    probeKeys: dedupe([phoneJid, phone, siblingJid, ref, lidJid, lidLocal]),
    // '@lid'-keyed contact rows probed alongside the mapped-phone row; the
    // (jid, bare-local) query pairing covers canonical_phone = bare lid (F6).
    contactJids: dedupe([lidJid, phoneJid, siblingJid]),
    phoneDigits:
      phone !== null && isPhoneLocal(phone)
        ? phone
        : siblingJid !== null && isPhoneLocal(lidLocal)
          ? lidLocal // evidence-proven phone identity, not shape-inferred
          : null,
    isGroup: false,
  };
}

function classifyRef(db: Database, ref: string): RefShape {
  if (isGroupConversationKey(ref)) {
    const jid = ref.includes('@') ? ref : conversationKeyToJid(ref);
    return { probeKeys: dedupe([ref, jid]), contactJids: [], phoneDigits: null, isGroup: true };
  }

  if (ref.includes('@')) {
    const local = normalizeLid(bareNumber(ref)); // device suffix stripped
    if (isLidJid(ref)) return lidShape(db, ref, local);
    if (isPnJid(ref)) {
      // Proven phone-origin: the '@s.whatsapp.net' domain is the proof. The
      // known lid alias forms ride along AFTER the phone's own keys (B27).
      const pnJid = toPersonalJid(local);
      const lidJids = phoneLidAliasJids(db, local);
      return {
        probeKeys: dedupe([ref, pnJid, local, ...lidJids]),
        contactJids: dedupe([pnJid, ...lidJids]),
        phoneDigits: isPhoneLocal(local) ? local : null,
        isGroup: false,
      };
    }
    // Other raw domains (@newsletter, @broadcast, …): name-table probes only.
    return { probeKeys: [ref], contactJids: [], phoneDigits: null, isGroup: false };
  }

  const enc = ref.indexOf('_at_');
  if (enc >= 0) {
    // Non-group conversation-key encoding: reconstruct the raw jid for ANY
    // '_at_' domain so aliases/chat rows keyed by the jid resolve (B25
    // below-cap). Local reverse of toConversationKey's default branch —
    // conversationKeyToJid deliberately stays group-only for its fleet
    // callers.
    const jid = `${ref.slice(0, enc)}@${ref.slice(enc + '_at_'.length)}`;
    return { probeKeys: dedupe([ref, jid]), contactJids: [], phoneDigits: null, isGroup: false };
  }

  // Bare DM ref — the runtime's per_chat mapKeys. toConversationKey collapses
  // BOTH '<n>@s.whatsapp.net' and '<n>@lid' to '<n>', so shape alone cannot
  // type it: consult lid_mappings FIRST (B25 F1).
  const local = normalizeLid(ref);
  if (/^\d+$/.test(local) && lidToPhone(db, local) !== null) {
    return lidShape(db, toLidJid(local), local); // bare KNOWN lid → lid-origin
  }
  if (new RegExp(`^\\d{${LID_SUSPECT_MIN_DIGITS},}$`).test(local)) {
    // Unmapped 12+-digit bare ref: probable lid (see LID_SUSPECT_MIN_DIGITS).
    // Probe the lid-keyed rows; raw-ref fallback — never a fabricated phone.
    // The sibling-evidence fold applies here too: an observed
    // '<local>@s.whatsapp.net' identity (rows, not shape) rescues a real
    // 12-15-digit international phone key from the raw-ref fallback.
    const lidJid = toLidJid(local);
    const siblingJid = personalIdentityExists(db.raw, toPersonalJid(local))
      ? toPersonalJid(local)
      : null;
    return {
      probeKeys: dedupe([ref, lidJid, siblingJid]),
      contactJids: dedupe([lidJid, siblingJid]),
      phoneDigits: siblingJid !== null && isPhoneLocal(local) ? local : null,
      isGroup: false,
    };
  }
  // Plausible phone (or non-numeric residue, which the isPhoneLocal gate
  // keeps off the phone rung). This is the live per_chat session-map shape
  // ('<phone>' bare), so the reverse-lid alias probe applies here too (B27).
  const pnJid = toPersonalJid(local);
  const lidJids = phoneLidAliasJids(db, local);
  return {
    probeKeys: dedupe([ref, pnJid, ...lidJids]),
    contactJids: dedupe([pnJid, ...lidJids]),
    phoneDigits: isPhoneLocal(local) ? local : null,
    isGroup: false,
  };
}

function resolveLadder(db: Database, ref: string): string | null {
  const shape = classifyRef(db, ref);
  const raw = db.raw;

  // 1. Owner alias (config chatAliases → chat_aliases table).
  for (const key of shape.probeKeys) {
    const alias = nonEmpty(getRow(raw, SQL_ALIAS, [key])?.alias);
    if (alias) return alias;
  }

  // 2. Group subject, then chat-level name.
  if (shape.isGroup) {
    for (const key of shape.probeKeys) {
      if (!key.includes('@')) continue;
      const subject = nonEmpty(getRow(raw, SQL_GROUP_SUBJECT, [key])?.subject);
      if (subject) return subject;
    }
  }
  for (const key of shape.probeKeys) {
    const name = nonEmpty(getRow(raw, SQL_CHAT_NAME, [key, key])?.name);
    if (name) return name;
  }
  if (shape.isGroup) return null; // groups have no contact/phone rungs

  // 3. Contact display/push name.
  for (const jid of shape.contactJids) {
    const row = getRow(raw, SQL_CONTACT_NAME, [jid, bareNumber(jid)]);
    const name = nonEmpty(row?.display_name) ?? nonEmpty(row?.notify_name);
    if (name) return name;
  }

  // 4. Most recent push name observed on a message from this jid. Digit-only
  // push names (phone-as-push-name) are misses, not names (B27).
  for (const jid of shape.contactJids) {
    const name = nonDigitName(getRow(raw, SQL_SENDER_NAME, [jid])?.sender_name);
    if (name) return name;
  }

  // 5. Formatted phone — only when the shape proved it (never from a lid).
  if (shape.phoneDigits !== null) return `+${shape.phoneDigits}`;

  return null; // 6. caller falls back to the raw ref
}

// ── Owner-facing render (B25 F2/F3) ─────────────────────────────────────────

/** Render length cap for a display name (before the ref suffix). */
const DISPLAY_NAME_MAX = 40;

/**
 * Make a resolved display name safe to interpolate into owner-facing
 * WhatsApp-markdown renders. Names (push names, group subjects) are
 * REMOTE-CONTROLLED: any chat peer picks them. Strips control characters
 * (a '\n' forged extra /sessions rows — a kill-wrong-session vector) and
 * WhatsApp markdown metachars (* _ ~ `), collapses whitespace, and caps the
 * length. Stripping over escaping: WhatsApp has no escape syntax, and a
 * literal metachar in a name is cosmetic, not identity.
 */
export function sanitizeDisplayNameForRender(name: string): string {
  let safe = name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
  safe = safe.replace(/[*_~`]/g, '');
  safe = safe.replace(/\s+/g, ' ').trim();
  if (safe.length > DISPLAY_NAME_MAX) {
    safe = `${safe.slice(0, DISPLAY_NAME_MAX - 1).trimEnd()}…`;
  }
  return safe;
}

/**
 * Short stable suffix derived from the RAW ref (last 4 local chars) — never
 * from the resolved name, so it survives name changes and collisions.
 */
function refSuffix(ref: string): string {
  let local = bareNumber(ref);
  const enc = local.indexOf('_at_');
  if (enc >= 0) local = local.slice(0, enc);
  return normalizeLid(local).slice(-4);
}

/**
 * The ONE choke point for owner-facing chat references (/sessions rows, the
 * /kill-session ack): resolves the display name, sanitizes it for render,
 * and ALWAYS appends a short stable ref suffix — e.g. "Lucas (…0919)".
 * Deterministic (not collision-triggered): identical resolved names stay
 * distinguishable, and the kill ack proves WHICH chat died even if names
 * changed between /sessions and /kill-session (TOCTOU evidence). Per-call-site
 * sanitization opt-in is the wrong altitude — route every owner render here.
 */
export function formatChatRefForOwner(db: Database, ref: string): string {
  const name =
    sanitizeDisplayNameForRender(resolveChatDisplayName(db, ref)) ||
    sanitizeDisplayNameForRender(ref) ||
    'unknown';
  const suffix = refSuffix(ref);
  return suffix ? `${name} (…${suffix})` : name;
}
