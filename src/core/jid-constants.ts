// src/core/jid-constants.ts
// Centralized WhatsApp JID domain constants and low-level JID utilities.
// Bare domains are the source of truth; @-prefixed forms are derived.
//
// Every JID parsing/normalization operation should live here or delegate here.
// Do NOT reimplement .split('@')[0] or .endsWith('@lid') inline — use these.

// ── Domain constants ────────────────────────────────────────────────────────

/** Bare domain for personal chats (after the @) */
export const DOMAIN_PERSONAL = 's.whatsapp.net';
/** Bare domain for linked-device IDs (after the @) */
export const DOMAIN_LID = 'lid';
/** Bare domain for group chats (after the @) */
export const DOMAIN_GROUP = 'g.us';

/** WhatsApp personal chat JID suffix */
export const JID_PERSONAL = `@${DOMAIN_PERSONAL}`;
/** WhatsApp linked-device ID JID suffix */
export const JID_LID = `@${DOMAIN_LID}`;
/** WhatsApp group chat JID suffix */
export const JID_GROUP = `@${DOMAIN_GROUP}`;
/** WhatsApp newsletter/channel JID suffix */
export const JID_NEWSLETTER = '@newsletter';

// ── JID builders ────────────────────────────────────────────────────────────

/** Build a personal JID from a phone number */
export function toPersonalJid(phone: string): string {
  return `${phone}${JID_PERSONAL}`;
}

/** Build a LID JID from a number */
export function toLidJid(number: string): string {
  return `${number}${JID_LID}`;
}

// ── JID type detection ──────────────────────────────────────────────────────

/** Check if a JID is a LID JID (@lid). */
export function isLidJid(jid: string | null | undefined): boolean {
  return !!jid && jid.endsWith(JID_LID);
}

/** Check if a JID is a personal (phone) JID (@s.whatsapp.net). */
export function isPnJid(jid: string | null | undefined): boolean {
  return !!jid && jid.endsWith(JID_PERSONAL);
}

/** Check if a JID is a group JID (@g.us). */
export function isGroupJid(jid: string | null | undefined): boolean {
  return !!jid && jid.endsWith(JID_GROUP);
}

// ── JID parsing ─────────────────────────────────────────────────────────────

/** Extract the local part (everything before @) from a JID. Returns the input if no @ present. */
export function bareNumber(jid: string): string {
  const at = jid.indexOf('@');
  return at >= 0 ? jid.slice(0, at) : jid;
}

/**
 * Normalize a LID: strip colon-device suffix (e.g. '12345:67' → '12345').
 * Safe to call on non-LID strings (no-op if no colon present).
 */
export function normalizeLid(raw: string): string {
  const colon = raw.indexOf(':');
  return colon >= 0 ? raw.slice(0, colon) : raw;
}
