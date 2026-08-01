import type { Database } from './database.ts';
import { createChildLogger } from '../logger.ts';
import type { RuntimeConnection } from '../transport/runtime-connection.ts';
// Types live in a zero-import leaf module (mark-read-types.ts) so the
// console workspace can share them without pulling this file's transitive
// backend graph into the console's stricter tsconfig — see that file's
// header for why (#2550).
import type { MarkConversationReadResult, MarkReadRemoteStatus } from './mark-read-types.ts';
export type { MarkConversationReadResult, MarkReadRemoteStatus };

const log = createChildLogger('mark-read');

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
