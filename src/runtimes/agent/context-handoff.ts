import { jidNormalizedUser } from '@whiskeysockets/baileys';

import type { StoredMessage } from '../../core/messages.ts';

export function contextMessagesForTurn(
  messages: readonly StoredMessage[],
  activeText?: string,
  actorJid?: string,
): StoredMessage[] {
  const chronological = [...messages];
  if (activeText === undefined || chronological.length === 0) return chronological;

  const newest = chronological.at(-1)!;
  const newestText = newest.content ?? newest.contentText;
  const actorMatches = actorJid === undefined
    || newest.senderJid === actorJid
    || jidNormalizedUser(newest.senderJid) === jidNormalizedUser(actorJid);
  if (newest.isFromMe === false && newestText === activeText && actorMatches) {
    chronological.pop();
  }
  return chronological;
}
