// src/core/ingest.ts
// Shared ingest pipeline: store → admin command routing → access policy → dispatch.
// Used by all runtimes that receive WhatsApp messages.

import { createChildLogger } from '../logger.ts';
import type { Database } from './database.ts';
import type { IncomingMessage, Messenger } from './types.ts';
import type { Runtime } from '../runtimes/types.ts';
import { storeMessageIfNew } from './messages.ts';
import { isAdminMessage, parseAdminCommand } from './command-router.ts';
import { handleAdminCommand, sendApprovalRequest } from './admin.ts';
import { shouldRespond } from './access-policy.ts';
import { extractPhone } from './access-list.ts';
import { toConversationKey } from './conversation-key.ts';

const log = createChildLogger('ingest');

/**
 * Create a fire-and-forget ingest handler that routes incoming messages
 * through the shared pipeline before dispatching eligible messages to the
 * given runtime.
 *
 * Steps (in order):
 *   1. Store the message (always, even if later rejected)
 *   2. Check admin commands — consumed here, not forwarded to runtime
 *   3. Apply access policy (shouldRespond)
 *   4. Send approval request for unknown senders
 *   5. Dispatch eligible messages to runtime.handleMessage(msg)
 */
export function createIngestHandler(
  db: Database,
  messenger: Messenger,
  runtime: Runtime,
  getBotJid: () => string,
  getBotLid: () => string | null,
): (msg: IncomingMessage) => void {
  return function ingestMessage(msg: IncomingMessage): void {
    void (async () => {
      // 1. Store the incoming message — always, even if we later reject it.
      //    Atomic insert: INSERT OR IGNORE returns false if message_id already exists.
      try {
        const conversationKey = toConversationKey(msg.chatJid);
        const isNew = storeMessageIfNew(db, {
          chatJid: msg.chatJid,
          conversationKey,
          senderJid: msg.senderJid,
          senderName: msg.senderName,
          messageId: msg.messageId,
          content: msg.content,
          contentType: msg.contentType,
          isFromMe: msg.isFromMe,
          timestamp: msg.timestamp,
          quotedMessageId: msg.quotedMessageId,
        });
        if (!isNew) {
          log.debug({ messageId: msg.messageId, reason: 'duplicate' }, 'skipping duplicate message delivery');
          return;
        }
      } catch (err) {
        log.error({ err, messageId: msg.messageId }, 'failed to store message');
        return;
      }

      // 2. Check admin commands FIRST (before trigger check)
      if (isAdminMessage(msg) && msg.content) {
        const cmd = parseAdminCommand(msg.content);
        if (cmd) {
          try {
            await handleAdminCommand(
              db,
              messenger,
              cmd.action,
              cmd.subjectType,
              cmd.subjectId,
              msg.chatJid,
              (m) => runtime.handleMessage(m),
            );
          } catch (err) {
            log.error({ err, messageId: msg.messageId }, 'failed to handle admin command');
          }
          return;
        }
      }

      // 3. Access policy / trigger check
      const triggerResult = shouldRespond(msg, getBotJid(), getBotLid(), db);
      if (!triggerResult.respond) {
        log.info(
          { messageId: msg.messageId, reason: triggerResult.reason, accessStatus: triggerResult.accessStatus },
          'ingest: not dispatching',
        );

        // 4. Send approval request for unknown senders
        if (triggerResult.accessStatus === 'unknown') {
          const phone = extractPhone(msg.senderJid);
          try {
            await sendApprovalRequest(db, messenger, phone, msg.senderName ?? '', msg.content ?? '');
          } catch (err) {
            log.error({ err, phone }, 'failed to send approval request');
          }
        }

        return;
      }

      // 5. Dispatch to runtime
      try {
        await runtime.handleMessage(msg);
      } catch (err) {
        log.error({ err, messageId: msg.messageId }, 'runtime.handleMessage threw');
      }
    })();
  };
}
