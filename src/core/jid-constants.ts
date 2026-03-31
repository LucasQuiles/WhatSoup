// src/core/jid-constants.ts
// Centralized WhatsApp JID domain constants.
// Bare domains are the source of truth; @-prefixed forms are derived.

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

/** Build a personal JID from a phone number */
export function toPersonalJid(phone: string): string {
  return `${phone}${JID_PERSONAL}`;
}

/** Build a LID JID from a number */
export function toLidJid(number: string): string {
  return `${number}${JID_LID}`;
}
