import { config } from '../config.ts';
import { createChildLogger } from '../logger.ts';
import type { Database } from './database.ts';
import { insertPending, updateAccess } from './access-list.ts';
import type { SubjectType } from './access-list.ts';
import { getMessagesBySender } from './messages.ts';
import type { IncomingMessage, Messenger } from './types.ts';

const log = createChildLogger('admin');

// ---------------------------------------------------------------------------
// handleAdminCommand
// ---------------------------------------------------------------------------

export async function handleAdminCommand(
  db: Database,
  messenger: Messenger,
  action: 'allow' | 'block',
  subjectType: SubjectType,
  subjectId: string,
  adminChatJid: string,
  handleMessageFn: (msg: IncomingMessage) => Promise<void>,
): Promise<void> {
  if (action === 'allow') {
    updateAccess(db, subjectType, subjectId, 'allowed');
    log.info({ subjectType, subjectId, action: 'allowed_by_admin' });

    if (subjectType === 'phone') {
      await messenger.sendMessage(adminChatJid, `Got it, allowed +${subjectId}`);

      // Replay queued messages: try both JID formats
      const jidFormats = [`${subjectId}@s.whatsapp.net`, `${subjectId}@lid`];
      for (const senderJid of jidFormats) {
        const stored = getMessagesBySender(db, senderJid);
        for (const msg of stored) {
          const incomingMsg: IncomingMessage = {
            messageId: msg.messageId,
            chatJid: msg.chatJid,
            senderJid: msg.senderJid,
            senderName: msg.senderName,
            content: msg.content,
            contentType: msg.contentType,
            isFromMe: false,
            isGroup: false,
            mentionedJids: [],
            timestamp: msg.timestamp,
            quotedMessageId: msg.quotedMessageId,
            isResponseWorthy: true,
          };
          await handleMessageFn(incomingMsg);
        }
      }
    } else {
      // group subject
      await messenger.sendMessage(adminChatJid, `Got it, allowed group ${subjectId}`);
    }
  } else {
    updateAccess(db, subjectType, subjectId, 'blocked');
    log.info({ subjectType, subjectId, action: 'blocked_by_admin' });

    if (subjectType === 'phone') {
      await messenger.sendMessage(adminChatJid, `Blocked +${subjectId}`);
    } else {
      await messenger.sendMessage(adminChatJid, `Blocked group ${subjectId}`);
    }
  }
}

// ---------------------------------------------------------------------------
// sendApprovalRequest
// ---------------------------------------------------------------------------

/**
 * Find the admin's chat JID — checks both phone@s.whatsapp.net and known LID formats
 * from the access_list (pre-seeded admin phones).
 */
function resolveAdminChatJid(db: Database): string {
  // Try to find a recent message from any admin phone to get their chatJid
  const stmt = db.raw.prepare(
    'SELECT chat_jid FROM messages WHERE sender_jid LIKE ? AND is_from_me = 0 ORDER BY timestamp DESC LIMIT 1',
  );
  for (const phone of config.adminPhones) {
    const row = stmt.get(`${phone}%`) as { chat_jid: string } | undefined;
    if (row) return row.chat_jid;
  }
  // Fallback to phone@s.whatsapp.net format
  const firstAdmin = [...config.adminPhones][0];
  return `${firstAdmin}@s.whatsapp.net`;
}

export async function sendApprovalRequest(
  db: Database,
  messenger: Messenger,
  phone: string,
  displayName: string,
  messagePreview: string,
): Promise<void> {
  insertPending(db, 'phone', phone, displayName);

  const preview = messagePreview.length > 100 ? messagePreview.slice(0, 100) : messagePreview;
  const text =
    `New contact: ${displayName} (+${phone})\nMessage: "${preview}"\nReply ALLOW ${phone} or BLOCK ${phone}`;

  const adminJid = resolveAdminChatJid(db);
  await messenger.sendMessage(adminJid, text);

  log.info({ phone, displayName, adminJid, action: 'approval_requested' });
}
