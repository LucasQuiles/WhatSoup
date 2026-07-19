// src/core/chat-display-name.ts
// Human-readable chat display names for owner-facing renders (the /sessions
// list and the /kill-session ack). Owner ruling (B23, verbatim): "sessions
// should show contact names, group names, etc — not unrecognizable JID/LID
// mappings or phone numbers".
//
// Resolution ladder (most-owner-meaningful first):
//   1. chat_aliases.alias      — the owner's own name for the chat (config
//      `chatAliases` seeds this table at startup: main.ts → seedChatAliases,
//      chats-resolver.ts)
//   2. groups.subject          — WhatsApp group subject (groups metadata)
//      then chats.name         — chat-level name (chat-sync)
//   3. contacts.display_name / notify_name — contact address-book/push name
//      (@lid refs resolve through lid_mappings first, lid-resolver style)
//   4. formatted phone (+digits) for DMs
//   5. the raw ref, unchanged  — last resort; NEVER throws on a miss
//
// Inputs may be a conversation_key ('123_at_g.us' / bare phone local) or a
// raw JID ('123@g.us' / '123@s.whatsapp.net' / '123@lid') — the runtime's
// session maps carry both shapes (per-chat keys vs activeChatJid).
//
// Purity/cost: every step is a single-row read on the local SQLite handle the
// runtime already holds (this.db.raw) — no network, no caching, render-safe.
// Every DB read is individually fail-open (a missing table or a mock handle
// degrades to the next ladder step), matching the "never crash on a miss"
// contract locked by tests/core/chat-display-name.test.ts.

import type { DatabaseSync } from 'node:sqlite';
import { isGroupConversationKey, conversationKeyToJid } from './conversation-key.ts';
import {
  DOMAIN_PERSONAL,
  JID_PERSONAL,
  JID_LID,
  bareNumber,
  normalizeLid,
  isLidJid,
} from './jid-constants.ts';

/** Non-empty trimmed string, else null — blank DB values are misses. */
function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Fail-open single-row read: any throw (missing table, mock db) is a miss. */
function getRow(
  db: DatabaseSync,
  sql: string,
  params: string[],
): Record<string, unknown> | undefined {
  try {
    return db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
  } catch {
    return undefined;
  }
}

/** A phone-shaped local part (7-15 digits, E.164 ballpark). */
function isPhoneLocal(local: string): boolean {
  return /^\d{7,15}$/.test(local);
}

/**
 * Resolve a chat reference (conversation_key or raw JID) to the most
 * owner-meaningful display name available. Falls back to the raw ref;
 * never throws.
 */
export function resolveChatDisplayName(db: DatabaseSync, ref: string): string {
  try {
    return resolveLadder(db, ref) ?? ref;
  } catch {
    return ref;
  }
}

function resolveLadder(db: DatabaseSync, ref: string): string | null {
  const isGroup = isGroupConversationKey(ref);

  // Candidate raw-JID forms for this ref. `refs` (below) additionally keeps
  // the ref itself so aliases keyed either way resolve.
  const jids = new Set<string>();
  const local = normalizeLid(bareNumber(ref)); // local part, device suffix stripped
  if (ref.includes('@')) {
    jids.add(ref);
    const domain = ref.slice(ref.indexOf('@') + 1);
    if (bareNumber(ref) !== local) jids.add(`${local}@${domain}`); // de-deviced form
  } else if (isGroup) {
    jids.add(conversationKeyToJid(ref)); // '…_at_g.us' → '…@g.us'
  } else if (!ref.includes('_at_')) {
    // Bare DM conversation key: personal first; a lid-origin key resolves via
    // the lid_mappings step below.
    jids.add(`${ref}${JID_PERSONAL}`);
    jids.add(`${ref}${JID_LID}`);
  }
  const refs = new Set<string>([ref, ...jids]);

  // 1. Owner alias (config chatAliases → chat_aliases table).
  for (const key of refs) {
    const row = getRow(
      db,
      'SELECT alias FROM chat_aliases WHERE chat_jid = ? ORDER BY alias LIMIT 1',
      [key],
    );
    const alias = nonEmpty(row?.alias);
    if (alias) return alias;
  }

  // 2. Group subject, then chat-level name.
  if (isGroup) {
    for (const jid of jids) {
      const row = getRow(db, 'SELECT subject FROM groups WHERE jid = ? LIMIT 1', [jid]);
      const subject = nonEmpty(row?.subject);
      if (subject) return subject;
    }
  }
  for (const key of refs) {
    const row = getRow(
      db,
      'SELECT name FROM chats WHERE jid = ? OR conversation_key = ? LIMIT 1',
      [key, key],
    );
    const name = nonEmpty(row?.name);
    if (name) return name;
  }
  if (isGroup) return null; // groups have no contact/phone rungs — raw fallback

  // 3. Contact display/push name. @lid candidates go through lid_mappings
  // first (bare-local key, lid-resolver.ts convention); unmapped LIDs are
  // dropped so step 4 can never mint a fake "+<lid>" phone.
  const dmCandidates: string[] = [];
  for (const jid of jids) {
    if (isLidJid(jid)) {
      const row = getRow(db, 'SELECT phone_jid FROM lid_mappings WHERE lid = ?', [
        normalizeLid(bareNumber(jid)),
      ]);
      const phoneJid = nonEmpty(row?.phone_jid);
      if (phoneJid) dmCandidates.push(phoneJid);
    } else {
      dmCandidates.push(jid);
    }
  }
  for (const jid of dmCandidates) {
    const row = getRow(
      db,
      'SELECT display_name, notify_name FROM contacts WHERE jid = ? OR canonical_phone = ? LIMIT 1',
      [jid, bareNumber(jid)],
    );
    const name = nonEmpty(row?.display_name) ?? nonEmpty(row?.notify_name);
    if (name) return name;
  }

  // 4. Formatted phone for DMs — only from a personal-JID candidate (or the
  // bare numeric ref), never from an unmapped @lid local.
  for (const jid of dmCandidates) {
    const digits = normalizeLid(bareNumber(jid));
    if (jid.endsWith(JID_PERSONAL) && isPhoneLocal(digits)) return `+${digits}`;
  }
  if (!ref.includes('@') && isPhoneLocal(local)) return `+${local}`;

  return null; // 5. caller falls back to the raw ref
}
