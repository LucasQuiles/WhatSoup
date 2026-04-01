// src/core/ingest.ts
// Shared ingest pipeline: store → admin command routing → access policy → dispatch.
// Used by all runtimes that receive WhatsApp messages.

import { createChildLogger } from '../logger.ts';
import type { Database } from './database.ts';
import type { IncomingMessage, Messenger } from './types.ts';
import type { Runtime } from '../runtimes/types.ts';
import type { DurabilityEngine } from './durability.ts';
import { storeMessageIfNew } from './messages.ts';
import { isAdminMessage, parseAdminCommand } from './command-router.ts';
import { handleAdminCommand, sendApprovalRequest } from './admin.ts';
import { shouldRespond } from './access-policy.ts';
import { extractPhone } from './access-list.ts';
import { toConversationKey } from './conversation-key.ts';
import { isControlPrefix, extractProtocol, extractPayload, HealCompletePayloadSchema } from './heal-protocol.ts';
import { handleHealComplete, handleHealEscalate } from './heal.ts';
import { config } from '../config.ts';

const log = createChildLogger('ingest');

/**
 * Create a fire-and-forget ingest handler that routes incoming messages
 * through the shared pipeline before dispatching eligible messages to the
 * given runtime.
 *
 * Steps (in order):
 *   0. Control plane intercept — if isControlPrefix and sender is a controlPeer, store in
 *      control_messages (NOT messages), journal as skipped, and return
 *   1. Store the message (always, even if later rejected)
 *   1b. Echo correlation — if isFromMe, call durabilityEngine.matchEcho and return
 *   1c. Passive short-circuit — journal as complete, return (no runtime dispatch)
 *   2. Check admin commands — consumed here, not forwarded to runtime
 *   3. Apply access policy (shouldRespond)
 *   4. Send approval request for unknown senders
 *   5. Journal inbound event via durabilityEngine.journalInbound
 *   6. Dispatch eligible messages to runtime.handleMessage(msg)
 */
export function createIngestHandler(
  db: Database,
  messenger: Messenger,
  runtime: Runtime,
  getBotJid: () => string,
  getBotLid: () => string | null,
  durability?: DurabilityEngine,
  instanceType?: string,
): (msg: IncomingMessage) => void {
  return function ingestMessage(msg: IncomingMessage): void {
    void (async () => {
      // 0. Control plane intercept — before any normal storage
      if (msg.content && isControlPrefix(msg.content)) {
        const phone = extractPhone(msg.senderJid);
        const isPeer = [...config.controlPeers.values()].includes(phone);
        if (isPeer) {
          const protocol = extractProtocol(msg.content);
          // Store in control_messages, NOT messages
          try {
            db.raw.prepare(`
              INSERT OR IGNORE INTO control_messages (message_id, direction, peer_jid, protocol, payload)
              VALUES (?, 'inbound', ?, ?, ?)
            `).run(msg.messageId, msg.senderJid, protocol, msg.content);
          } catch (err) {
            log.error({ err, messageId: msg.messageId }, 'failed to store control message');
          }

          log.debug({ protocol, peer: msg.senderJid, messageId: msg.messageId }, 'control message intercepted');

          // Route HEAL_COMPLETE and HEAL_ESCALATE to the heal state machine
          if (protocol === 'HEAL_COMPLETE' || protocol === 'HEAL_ESCALATE') {
            try {
              const payload = extractPayload(msg.content);
              if (payload) {
                const parsed = HealCompletePayloadSchema.parse(payload);
                if (protocol === 'HEAL_COMPLETE') {
                  handleHealComplete(db, parsed);
                } else {
                  handleHealEscalate(db, parsed);
                }
              }
            } catch (err) {
              log.error({ err, messageId: msg.messageId, protocol }, 'failed to handle control message payload');
            }
          }

          if (durability) {
            const seq = durability.journalInbound(msg.messageId, toConversationKey(msg.chatJid), msg.chatJid, 'control');
            durability.markInboundSkipped(seq, 'control_message');
          }
          return;
        }
      }

      // 1. Store the incoming message — always, even if we later reject it.
      //    Atomic insert: INSERT OR IGNORE returns false if message_id already exists.
      let conversationKey: string;
      try {
        conversationKey = toConversationKey(msg.chatJid);
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
          rawMessage: msg.rawMessage != null ? JSON.stringify(msg.rawMessage) : null,
        });
        if (!isNew) {
          log.debug({ messageId: msg.messageId, reason: 'duplicate' }, 'skipping duplicate message delivery');
          return;
        }
      } catch (err) {
        log.error({ err, messageId: msg.messageId }, 'failed to store message');
        return;
      }

      // 1b. Echo correlation — Baileys echoes our own sent messages back through
      //     messages.upsert with isFromMe=true. Match against submitted outbound_ops
      //     so they transition submitted → echoed. Never route to runtime.
      if (msg.isFromMe) {
        if (durability) {
          durability.matchEcho(msg.messageId);
        }
        return;
      }

      // 1c. Passive short-circuit — store message, journal as complete, no dispatch
      if (instanceType === 'passive') {
        if (durability) {
          const seq = durability.journalInbound(msg.messageId, conversationKey, msg.chatJid, 'passive');
          durability.markInboundSkipped(seq, 'passive_instance');
        }
        return;
      }

      // 2. Check admin commands FIRST (before trigger check)
      if (isAdminMessage(msg) && msg.content) {
        const cmd = parseAdminCommand(msg.content);
        if (cmd) {
          let seq: number | undefined;
          if (durability) {
            seq = durability.journalInbound(msg.messageId, conversationKey, msg.chatJid, 'admin');
          }
          try {
            await handleAdminCommand(
              db,
              messenger,
              cmd.action,
              cmd.subjectType,
              cmd.subjectId,
              msg.chatJid,
              (m) => runtime.handleMessage(m),
              durability,
            );
          } catch (err) {
            log.error({ err, messageId: msg.messageId }, 'failed to handle admin command');
          }
          if (durability && seq !== undefined) {
            durability.markInboundSkipped(seq, 'admin_command');
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
            await sendApprovalRequest(db, messenger, phone, msg.senderName ?? '', msg.content ?? '', durability);
          } catch (err) {
            log.error({ err, phone }, 'failed to send approval request');
          }
        }

        if (durability) {
          const seq = durability.journalInbound(msg.messageId, conversationKey, msg.chatJid, 'none');
          durability.markInboundSkipped(seq, 'access_denied');
        }

        return;
      }

      // 5. Journal inbound event before dispatch so runtime can link outbound ops
      const routedTo = runtime.constructor?.name?.toLowerCase() ?? 'runtime';
      let seq: number | undefined;
      if (durability) {
        seq = durability.journalInbound(msg.messageId, conversationKey, msg.chatJid, routedTo);
        msg.inboundSeq = seq;  // Thread seq into runtime for lifecycle tracking
      }

      // 6. Dispatch to runtime
      try {
        await runtime.handleMessage(msg);
      } catch (err) {
        log.error({ err, messageId: msg.messageId }, 'runtime.handleMessage threw');
        if (durability && seq !== undefined) {
          durability.markInboundFailed(seq);
        }
      }
    })();
  };
}
