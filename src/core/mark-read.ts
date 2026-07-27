import type { Database } from './database.ts';
import { createChildLogger } from '../logger.ts';
import type { RuntimeConnection } from '../transport/runtime-connection.ts';

const log = createChildLogger('mark-read');

/**
 * Whether the REMOTE read-receipt was accepted, reported alongside the local
 * result (#2292 L16).
 *
 * The local `unread_count` is zeroed in every case — that is deliberate and
 * pinned by two named tests ("swallows chatModify errors: still returns ok and
 * zeroes unread", "skips chatModify when no socket is available, still zeroes
 * unread"): clearing the badge is what the caller asked for, and WhatsApp
 * re-syncs read state on reconnect. What was missing is that the caller could
 * not TELL whether the remote side agreed, so a local zero and a remote
 * still-unread were indistinguishable.
 */
export type MarkReadRemoteStatus =
  | 'acked'           // chatModify was called and succeeded
  | 'failed'          // chatModify was called and threw — remote may still be unread
  | 'offline'         // no socket; nothing was sent
  | 'nothing_to_ack'; // the chat has no messages, so there is no receipt to send

export interface MarkConversationReadResult {
  ok: true;
  jid: string;
  conversation_key: string;
  /** Remote-side outcome. `ok: true` refers to the LOCAL update only. */
  remote: MarkReadRemoteStatus;
}

export async function markConversationRead(
  db: Database,
  connectionManager: Pick<RuntimeConnection, 'getSocket' | 'botJid'>,
  conversationKey: string,
): Promise<MarkConversationReadResult | { ok: false; error: 'chat_not_found'; conversation_key: string }> {
  const chatRow = db.raw
    .prepare('SELECT jid FROM chats WHERE conversation_key = ? LIMIT 1')
    .get(conversationKey) as { jid: string } | undefined;

  if (!chatRow) {
    return { ok: false, error: 'chat_not_found', conversation_key: conversationKey };
  }

  const chatJid = chatRow.jid;
  const lastMsg = db.raw
    .prepare('SELECT message_id, sender_jid, timestamp FROM messages WHERE conversation_key = ? ORDER BY pk DESC LIMIT 1')
    .get(conversationKey) as { message_id: string; sender_jid: string; timestamp: number } | undefined;

  const sock = connectionManager.getSocket();
  let remote: MarkReadRemoteStatus = lastMsg ? (sock ? 'failed' : 'offline') : 'nothing_to_ack';
  if (lastMsg && sock) {
    try {
      await sock.chatModify(
        {
          markRead: true,
          lastMessages: [
            {
              key: {
                id: lastMsg.message_id,
                fromMe: lastMsg.sender_jid === connectionManager.botJid,
              },
              messageTimestamp: lastMsg.timestamp,
            },
          ],
        },
        chatJid,
      );
      remote = 'acked';
    } catch (err) {
      // Left as a warn, not raised: the local zero below is the specified
      // behaviour. The failure is now also reported in the result, so a caller
      // can see that the remote side may still consider the chat unread.
      log.warn({ err, chatJid, conversation_key: conversationKey }, 'mark-read chatModify failed');
    }
  }

  db.raw
    .prepare('UPDATE chats SET unread_count = 0 WHERE conversation_key = ?')
    .run(conversationKey);

  return { ok: true, jid: chatJid, conversation_key: conversationKey, remote };
}
