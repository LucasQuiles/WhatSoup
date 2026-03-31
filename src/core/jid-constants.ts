// src/core/jid-constants.ts
// Centralized WhatsApp JID domain constants.

/** WhatsApp personal chat domain */
export const JID_PERSONAL = '@s.whatsapp.net';
/** WhatsApp linked-device ID domain */
export const JID_LID = '@lid';
/** WhatsApp group chat domain */
export const JID_GROUP = '@g.us';
/** WhatsApp newsletter/channel domain */
export const JID_NEWSLETTER = '@newsletter';

/** Bare domain for @s.whatsapp.net (after the @) — used in JID switch/case parsing */
export const DOMAIN_PERSONAL = 's.whatsapp.net';
/** Bare domain for @lid (after the @) — used in JID switch/case parsing */
export const DOMAIN_LID = 'lid';
/** Bare domain for @g.us (after the @) — used in JID switch/case parsing */
export const DOMAIN_GROUP = 'g.us';

/** Build a personal JID from a phone number */
export function toPersonalJid(phone: string): string {
  return `${phone}${JID_PERSONAL}`;
}

/** Build a LID JID from a number */
export function toLidJid(number: string): string {
  return `${number}${JID_LID}`;
}
