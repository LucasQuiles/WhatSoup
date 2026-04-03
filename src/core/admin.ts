import { config } from '../config.ts';
import { createChildLogger } from '../logger.ts';
import type { Database } from './database.ts';
import { insertPending, updateAccess } from './access-list.ts';
import type { SubjectType } from './access-list.ts';
import { toPersonalJid, toLidJid, bareNumber } from './jid-constants.ts';
import { getAllLidMappings } from './lid-resolver.ts';
import { getMessagesBySender } from './messages.ts';
import { isAdminPhone } from '../lib/phone.ts';
import type { IncomingMessage, Messenger } from './types.ts';
import type { DurabilityEngine } from './durability.ts';
import { sendTracked } from './durability.ts';

const log = createChildLogger('admin');

export async function handleAdminCommand(
  db: Database,
  messenger: Messenger,
  action: 'allow' | 'block',
  subjectType: SubjectType,
  subjectId: string,
  adminChatJid: string,
  handleMessageFn: (msg: IncomingMessage) => Promise<void>,
  durability?: DurabilityEngine,
): Promise<void> {
  if (action === 'allow') {
    updateAccess(db, subjectType, subjectId, 'allowed');
    log.info({ subjectType, subjectId, action: 'allowed_by_admin' }, 'access granted by admin');

    if (subjectType === 'phone') {
      await sendTracked(messenger, adminChatJid, `Got it, allowed +${subjectId}`, durability, { replayPolicy: 'safe', isTerminal: true });

      // Replay queued messages: try the personal JID, plus any LIDs that map
      // to this phone. toLidJid(phone) is wrong — LIDs are opaque numbers
      // unrelated to phone numbers. We must reverse-lookup from lid_mappings.
      const jidFormats: string[] = [toPersonalJid(subjectId)];
      const lidMap = getAllLidMappings(db);
      for (const [lid, mappedPhone] of lidMap) {
        if (isAdminPhone(mappedPhone, new Set([subjectId]))) {
          jidFormats.push(toLidJid(lid));
        }
      }
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
      await sendTracked(messenger, adminChatJid, `Got it, allowed group ${subjectId}`, durability, { replayPolicy: 'safe', isTerminal: true });
    }
  } else {
    updateAccess(db, subjectType, subjectId, 'blocked');
    log.info({ subjectType, subjectId, action: 'blocked_by_admin' }, 'access blocked by admin');

    if (subjectType === 'phone') {
      await sendTracked(messenger, adminChatJid, `Blocked +${subjectId}`, durability, { replayPolicy: 'safe', isTerminal: true });
    } else {
      await sendTracked(messenger, adminChatJid, `Blocked group ${subjectId}`, durability, { replayPolicy: 'safe', isTerminal: true });
    }
  }
}

// ---------------------------------------------------------------------------
// sendApprovalRequest
// ---------------------------------------------------------------------------

/**
 * Find the admin's chat JID — checks personal JIDs and reverse-mapped LIDs
 * from the lid_mappings table using a targeted query.
 */
function resolveAdminChatJid(db: Database): string | null {
  const msgStmt = db.raw.prepare(
    'SELECT chat_jid FROM messages WHERE sender_jid LIKE ? AND is_from_me = 0 ORDER BY timestamp DESC LIMIT 1',
  );

  // Search by admin phone numbers first (fast path)
  for (const phone of config.adminPhones) {
    const row = msgStmt.get(`${phone}%`) as { chat_jid: string } | undefined;
    if (row) return row.chat_jid;
  }

  // Search by LIDs that map to admin phones (scans lid_mappings — typically small table)
  const lidRows = db.raw.prepare(
    'SELECT lid, phone_jid FROM lid_mappings',
  ).all() as { lid: string; phone_jid: string }[];
  for (const { lid, phone_jid } of lidRows) {
    const mappedPhone = bareNumber(phone_jid);
    if (isAdminPhone(mappedPhone, config.adminPhones)) {
      const row = msgStmt.get(`${lid}%`) as { chat_jid: string } | undefined;
      if (row) return row.chat_jid;
    }
  }

  // Fallback to phone@s.whatsapp.net format
  const firstAdmin = [...config.adminPhones][0];
  if (!firstAdmin) {
    log.error('resolveAdminJid: no admin phones configured — cannot resolve admin JID');
    return null;
  }
  return toPersonalJid(firstAdmin);
}

export async function sendApprovalRequest(
  db: Database,
  messenger: Messenger,
  phone: string,
  displayName: string,
  messagePreview: string,
  durability?: DurabilityEngine,
): Promise<void> {
  insertPending(db, 'phone', phone, displayName);

  const preview = messagePreview.length > 100 ? messagePreview.slice(0, 100) : messagePreview;
  const text =
    `New contact: ${displayName} (+${phone})\nMessage: "${preview}"\nReply ALLOW ${phone} or BLOCK ${phone}`;

  const adminJid = resolveAdminChatJid(db);
  if (!adminJid) {
    log.warn({ phone, displayName }, 'cannot send approval request — no admin phones configured');
    return;
  }
  await sendTracked(messenger, adminJid, text, durability, { replayPolicy: 'safe', isTerminal: true });

  log.info({ phone, displayName, adminJid, action: 'approval_requested' }, 'approval requested');
}
