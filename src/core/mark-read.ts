import type { Database } from './database.ts';
import { createChildLogger } from '../logger.ts';
import type { RuntimeConnection } from '../transport/runtime-connection.ts';

const log = createChildLogger('mark-read');

export interface MarkConversationReadResult {
  ok: true;
  jid: string;
  conversation_key: string;
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
    } catch (err) {
      log.warn({ err, chatJid, conversation_key: conversationKey }, 'mark-read chatModify failed');
    }
  }

  db.raw
    .prepare('UPDATE chats SET unread_count = 0 WHERE conversation_key = ?')
    .run(conversationKey);

  return { ok: true, jid: chatJid, conversation_key: conversationKey };
}
