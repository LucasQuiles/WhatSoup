import { describe, expect, it } from 'vitest';
import { isAuthenticatedAdmin, isBotMentioned } from '../../src/core/access-predicates.ts';

const BOT_JID = '15551230004@s.whatsapp.net';
const BOT_LID = '15559876543@lid';

describe('isBotMentioned', () => {
  it.each([
    ['the bot JID', [BOT_JID], BOT_LID, true],
    ['the bot bare number', ['15551230004'], BOT_LID, true],
    ['the bot number under another domain', ['15551230004@lid'], BOT_LID, true],
    ['the bot LID', [BOT_LID], BOT_LID, true],
    ['the bot LID bare number', ['15559876543@s.whatsapp.net'], BOT_LID, true],
    ['the bot LID when no LID is known', [BOT_LID], null, false],
    ['someone else', ['15551239999@s.whatsapp.net'], BOT_LID, false],
    ['nobody', [], BOT_LID, false],
    ['the bot among others', ['15551239999@s.whatsapp.net', BOT_JID], null, true],
  ] as const)('%s', (_name, mentioned, botLid, expected) => {
    expect(isBotMentioned(mentioned, BOT_JID, botLid)).toBe(expected);
  });
});

describe('isAuthenticatedAdmin', () => {
  const admins = new Set(['15551230008']);

  it.each([
    ['a WhatsApp admin', '15551230008@s.whatsapp.net', '15551230008', true],
    ['a WhatsApp LID admin', '99999@lid', '15551230008', true],
    ['a spoofable @sms sender with the admin phone', '15551230008@sms', '15551230008', false],
    ['a WhatsApp non-admin', '15551230009@s.whatsapp.net', '15551230009', false],
  ] as const)('%s', (_name, senderJid, phone, expected) => {
    expect(isAuthenticatedAdmin(senderJid, phone, admins)).toBe(expected);
  });
});
