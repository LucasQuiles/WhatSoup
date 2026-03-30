import type { Database } from '../../core/database.ts';
import type { ChatMessage } from './providers/types.ts';
import { getRecentMessages } from '../../core/messages.ts';
import { toConversationKey } from '../../core/conversation-key.ts';
import { config } from '../../config.ts';
import { createChildLogger } from '../../logger.ts';

const log = createChildLogger('conversation');

/**
 * Load the conversation window for `chatJid` and map it to ChatMessage[].
 *
 * Starts with `config.conversationWindow` (50) messages. If the oldest
 * message in that window was received within `config.windowExtensionThresholdMs`
 * (10 min) of now, the window is extended to `config.conversationWindowExtended`
 * (100) messages — indicating a fast-moving conversation.
 *
 * Messages with null content are skipped.
 * Bot messages → role 'assistant'.
 * Human messages → role 'user', prefixed with "[SenderName]: ".
 */
export function loadConversationWindow(db: Database, chatJid: string): ChatMessage[] {
  const conversationKey = toConversationKey(chatJid);
  const initial = getRecentMessages(db, conversationKey, config.conversationWindow);

  let messages = initial;

  if (initial.length > 0) {
    const oldestTimestampMs = initial[0].timestamp * 1000;
    const ageMs = Date.now() - oldestTimestampMs;

    if (ageMs <= config.windowExtensionThresholdMs) {
      log.info(
        { chatJid, ageMs, extendedWindow: config.conversationWindowExtended },
        'conversation window: extending due to recent activity',
      );
      messages = getRecentMessages(db, conversationKey, config.conversationWindowExtended);
    }
  }

  const result: ChatMessage[] = [];

  for (const msg of messages) {
    if (msg.content === null) continue;

    if (msg.isFromMe) {
      result.push({ role: 'assistant', content: msg.content });
    } else {
      const name = msg.senderName ?? msg.senderJid.split('@')[0] ?? 'Unknown';
      result.push({ role: 'user', content: `[${name}]: ${msg.content}` });
    }
  }

  // Merge consecutive same-role messages
  const merged: ChatMessage[] = [];
  for (const msg of result) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === msg.role) {
      prev.content += '\n' + msg.content;
    } else {
      merged.push({ ...msg });
    }
  }

  log.info({ chatJid, messageCount: merged.length }, 'conversation window loaded');
  return merged;
}
