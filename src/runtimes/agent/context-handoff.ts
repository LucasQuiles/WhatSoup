import { jidNormalizedUser } from '@whiskeysockets/baileys';

import type { StoredMessage } from '../../core/messages.ts';

// Recent context for fresh spawns is merged into the active user turn, not
// dispatched as a fresh_session_context system turn. That owner cannot admit
// effects, so action-heavy context can consume the deadline and quarantine the
// provider under the queued user turn. Merging avoids that deadline race and
// the phantom-reply channel while replay/journal capture keeps the pure user
// text. Callers skip this path when resume-failure handling owns recovery.
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
