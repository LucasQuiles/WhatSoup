// src/core/access-predicates.ts
// Pure predicates shared by the access policy (shouldRespond) and the shadow
// gate's input features, so the gate measures exactly what the policy decides.
// Deliberately free of config and logging: callers pass what they read.

import { bareNumber, isAuthenticatedSenderJid } from './jid-constants.ts';
import { isAdminPhone } from '../lib/phone.ts';

/**
 * True when any mentioned JID names the bot: its JID, its LID, or either's
 * bare number. Mentions may use either identity format.
 */
export function isBotMentioned(mentionedJids: readonly string[], botJid: string, botLid: string | null): boolean {
  const botIds = new Set<string>();
  botIds.add(botJid);
  botIds.add(bareNumber(botJid));
  if (botLid) {
    botIds.add(botLid);
    botIds.add(bareNumber(botLid));
  }
  return mentionedJids.some((jid) => botIds.has(jid) || botIds.has(bareNumber(jid)));
}

/**
 * Transport-gated admin match (QR-143): only a WhatsApp-authenticated sender
 * may clear it, because a spoofable @sms sender resolves to the same bare phone.
 */
export function isAuthenticatedAdmin(senderJid: string, phone: string, adminPhones: Set<string>): boolean {
  return isAuthenticatedSenderJid(senderJid) && isAdminPhone(phone, adminPhones);
}
