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
/** Bare domain for SMS transport JIDs (after the @) */
export const DOMAIN_SMS = 'sms';

/** WhatsApp personal chat JID suffix */
export const JID_PERSONAL = `@${DOMAIN_PERSONAL}`;
/** WhatsApp linked-device ID JID suffix */
export const JID_LID = `@${DOMAIN_LID}`;
/** WhatsApp group chat JID suffix */
export const JID_GROUP = `@${DOMAIN_GROUP}`;
/** SMS transport JID suffix */
export const JID_SMS = `@${DOMAIN_SMS}`;

export type WhatsAppDeliveryNamespace =
  | typeof DOMAIN_PERSONAL
  | typeof DOMAIN_LID
  | typeof DOMAIN_GROUP;

const WHATSAPP_DELIVERY_NAMESPACES: ReadonlySet<string> = new Set([
  DOMAIN_PERSONAL,
  DOMAIN_LID,
  DOMAIN_GROUP,
]);

// ── JID builders ────────────────────────────────────────────────────────────

/** Build a personal JID from a phone number */
export function toPersonalJid(phone: string): string {
  return `${phone}${JID_PERSONAL}`;
}

/** Build a LID JID from a number */
export function toLidJid(number: string): string {
  return `${number}${JID_LID}`;
}

/**
 * Build an SMS JID from an E.164 address (e.g. '+15551230000').
 * Idempotent: already-suffixed addresses are returned as-is.
 */
export function toSmsJid(address: string): string {
  return address.endsWith(JID_SMS) ? address : `${address}${JID_SMS}`;
}

/**
 * Resolve an SMS JID to the repo's phone-subject convention: digits without
 * the leading '+' (e.g. '+15551230000@sms' → '15551230000'), matching what
 * personal WhatsApp JIDs yield. Tolerates an already-bare address.
 */
export function smsJidToPhone(jid: string): string {
  const bare = fromSmsJid(jid);
  return bare.startsWith('+') ? bare.slice(1) : bare;
}

/**
 * Strip the SMS JID suffix from an address (e.g. '+15551230000@sms' → '+15551230000').
 * Tolerates an already-bare address.
 */
export function fromSmsJid(jid: string): string {
  return jid.endsWith(JID_SMS) ? jid.slice(0, -JID_SMS.length) : jid;
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

/** Check if a raw JID (not a conversation key) is a group JID. */
export function isGroupJid(jid: string): boolean {
  return jid.endsWith(JID_GROUP);
}

/** Check if a JID is an SMS JID (@sms). */
export function isSmsJid(jid: string | null | undefined): boolean {
  return !!jid && jid.endsWith(JID_SMS);
}

/**
 * True only for WhatsApp-authenticated transports — personal (@s.whatsapp.net)
 * and linked-device (@lid) — whose sender identity WhatsApp verifies via E2E
 * device pairing.
 *
 * NON-authenticated transports (e.g. @sms via Twilio) are deliberately excluded:
 * the Twilio webhook signature only authenticates the request is *from Twilio*,
 * NOT that the SMS `From` is the claimed sender — SMS sender-ID is spoofable.
 * Because `resolvePhoneFromJid` collapses `<num>@sms` to the same bare phone as
 * WhatsApp `<num>`, admin/allow GRANT decisions MUST gate on this predicate
 * before matching the phone, so a spoofed SMS cannot inherit a WhatsApp
 * identity's privileges (QR-143). Deny-side (block) checks intentionally do NOT
 * use this — a blocked number must stay blocked across every transport.
 */
export function isWhatsAppAuthenticatedJid(jid: string | null | undefined): boolean {
  return isPnJid(jid) || isLidJid(jid);
}

// ── JID parsing ─────────────────────────────────────────────────────────────

/**
 * Return the exact namespace of a canonical WhatsApp delivery JID.
 * Completed-turn identity deliberately excludes transport and broadcast
 * pseudo-JIDs, and accepts exactly one local/namespace separator.
 */
export function parseWhatsAppDeliveryNamespace(
  jid: string,
): WhatsAppDeliveryNamespace | null {
  if (typeof jid !== 'string' || jid.length === 0 || jid.trim() !== jid || /\s/.test(jid)) {
    return null;
  }
  const separator = jid.indexOf('@');
  if (
    separator <= 0 ||
    separator !== jid.lastIndexOf('@') ||
    separator === jid.length - 1
  ) {
    return null;
  }
  const namespace = jid.slice(separator + 1);
  return WHATSAPP_DELIVERY_NAMESPACES.has(namespace)
    ? namespace as WhatsAppDeliveryNamespace
    : null;
}

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
