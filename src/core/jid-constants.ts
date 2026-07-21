// src/core/jid-constants.ts
// Centralized WhatsApp JID domain constants and low-level JID utilities.
// Bare domains are the source of truth; @-prefixed forms are derived.
//
// Every JID parsing/normalization operation should live here or delegate here.
// Do NOT reimplement .split('@')[0] or .endsWith('@lid') inline — use these.

import {
  canonicalizeImessageDirectIdentity,
  isSignalGroupAddress,
  SIGNAL_UUID_RE,
} from './transport-refs.ts';
import { isE164Wire } from '../lib/phone.ts';

// ── Domain constants ────────────────────────────────────────────────────────

/** Bare domain for personal chats (after the @) */
export const DOMAIN_PERSONAL = 's.whatsapp.net';
/** Bare domain for linked-device IDs (after the @) */
export const DOMAIN_LID = 'lid';
/** Bare domain for group chats (after the @) */
export const DOMAIN_GROUP = 'g.us';
/** Bare domain for SMS transport JIDs (after the @) */
export const DOMAIN_SMS = 'sms';
/** Bare domain for Signal transport JIDs (after the @) */
export const DOMAIN_SIGNAL = 'signal';
/** Bare domain for iMessage transport JIDs (after the @) */
export const DOMAIN_IMESSAGE = 'imessage';

/** WhatsApp personal chat JID suffix */
export const JID_PERSONAL = `@${DOMAIN_PERSONAL}`;
/** WhatsApp linked-device ID JID suffix */
export const JID_LID = `@${DOMAIN_LID}`;
/** WhatsApp group chat JID suffix */
export const JID_GROUP = `@${DOMAIN_GROUP}`;
/** SMS transport JID suffix */
export const JID_SMS = `@${DOMAIN_SMS}`;
/** Signal transport JID suffix */
export const JID_SIGNAL = `@${DOMAIN_SIGNAL}`;
/** iMessage transport JID suffix */
export const JID_IMESSAGE = `@${DOMAIN_IMESSAGE}`;

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

/**
 * Build a Signal JID from a Signal identifier (UUID or E.164 address).
 * Idempotent: already-suffixed addresses are returned as-is.
 */
export function toSignalJid(address: string): string {
  return address.endsWith(JID_SIGNAL) ? address : `${address}${JID_SIGNAL}`;
}

/**
 * Strip the Signal JID suffix from an address (e.g. '<uuid>@signal' → '<uuid>').
 * Tolerates an already-bare address.
 */
export function fromSignalJid(jid: string): string {
  return jid.endsWith(JID_SIGNAL) ? jid.slice(0, -JID_SIGNAL.length) : jid;
}

/**
 * Build an iMessage JID from an iMessage identifier (AppleID email, E.164,
 * or chat GUID). Idempotent: already-suffixed addresses are returned as-is.
 */
export function toImessageJid(address: string): string {
  const bare = address.endsWith(JID_IMESSAGE)
    ? address.slice(0, -JID_IMESSAGE.length)
    : address;
  const canonical = canonicalizeImessageDirectIdentity(bare) ?? bare;
  return `${canonical}${JID_IMESSAGE}`;
}

/**
 * Strip the iMessage JID suffix from an address.
 * Tolerates an already-bare address.
 */
export function fromImessageJid(jid: string): string {
  const bare = jid.endsWith(JID_IMESSAGE) ? jid.slice(0, -JID_IMESSAGE.length) : jid;
  return canonicalizeImessageDirectIdentity(bare) ?? bare;
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
  return jid.endsWith(JID_GROUP)
    || (jid.endsWith(JID_SIGNAL) && isSignalGroupAddress(fromSignalJid(jid)));
}

/** Check if a JID is a Signal transport JID (@signal). */
export function isSignalJid(jid: string | null | undefined): boolean {
  return !!jid && jid.endsWith(JID_SIGNAL);
}

/** Check if a JID is an iMessage transport JID (@imessage). */
export function isImessageJid(jid: string | null | undefined): boolean {
  return !!jid && jid.endsWith(JID_IMESSAGE);
}

/** Check if a JID is an SMS JID (@sms). */
export function isSmsJid(jid: string | null | undefined): boolean {
  return !!jid && jid.endsWith(JID_SMS);
}

const WHATSAPP_PHONE_SENDER_RE = /^\d{7,15}(?::\d+)?$/;
const WHATSAPP_LID_SENDER_RE = /^\d{1,20}(?::\d+)?$/;

function senderLocal(jid: string | null | undefined, suffix: string): string | null {
  if (!jid || !jid.endsWith(suffix)) return null;
  const local = jid.slice(0, -suffix.length);
  return local.length > 0 ? local : null;
}

/**
 * Bind a canonical direct-sender JID to an instance transport. Unlike the
 * authentication predicate below, this includes Twilio's canonical @sms
 * namespace so ordinary allowlist/open-mode policy remains usable there.
 */
export function isSenderJidForTransport(
  jid: string | null | undefined,
  transport: string | null | undefined,
): boolean {
  if (transport === 'baileys' || transport == null) {
    const pn = senderLocal(jid, JID_PERSONAL);
    if (pn !== null) return WHATSAPP_PHONE_SENDER_RE.test(pn);
    const lid = senderLocal(jid, JID_LID);
    return lid !== null && WHATSAPP_LID_SENDER_RE.test(lid);
  }
  if (transport === 'twilio') {
    const sms = senderLocal(jid, JID_SMS);
    return sms !== null && isE164Wire(sms);
  }
  if (transport === 'signal') {
    const signal = senderLocal(jid, JID_SIGNAL);
    return signal !== null && (isE164Wire(signal) || SIGNAL_UUID_RE.test(signal));
  }
  if (transport === 'imessage') {
    const imessage = senderLocal(jid, JID_IMESSAGE);
    return imessage !== null && canonicalizeImessageDirectIdentity(imessage) === imessage;
  }
  return false;
}

/**
 * True for a sender namespace whose provider can authenticate identity:
 * WhatsApp personal/linked-device JIDs, Signal, and iMessage.
 *
 * NON-authenticated transports (e.g. @sms via Twilio) are deliberately excluded:
 * the Twilio webhook signature only authenticates the request is *from Twilio*,
 * NOT that the SMS `From` is the claimed sender — SMS sender-ID is spoofable.
 * This broad classification does not bind a JID to an instance. Admin/allow
 * GRANT decisions MUST use `isAuthenticatedSenderForTransport` so an identity
 * authenticated by one provider cannot inherit another provider's privileges
 * (QR-143). Deny-side checks intentionally stay transport-agnostic.
 */
export function isAuthenticatedSenderJid(jid: string | null | undefined): boolean {
  return isSenderJidForTransport(jid, 'baileys')
    || isSenderJidForTransport(jid, 'signal')
    || isSenderJidForTransport(jid, 'imessage');
}

/** Bind an authenticated sender namespace to the instance's configured transport. */
export function isAuthenticatedSenderForTransport(
  jid: string | null | undefined,
  transport: string | null | undefined,
): boolean {
  if (transport === 'twilio') return false;
  return isSenderJidForTransport(jid, transport);
}

/**
 * Back-compat alias for the old WhatsApp-only name. Do not use this broad alias
 * for grants; bind the sender to the configured transport with
 * `isAuthenticatedSenderForTransport`.
 */
export const isWhatsAppAuthenticatedJid = isAuthenticatedSenderJid;

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
