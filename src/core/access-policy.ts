import type { IncomingMessage } from './types.ts';
import type { Database } from './database.ts';
import { lookupAccess, extractPhone } from './access-list.ts';
import { createChildLogger } from '../logger.ts';
import { config } from '../config.ts';

const log = createChildLogger('conversation');

export type AccessMode = 'self_only' | 'allowlist' | 'open_dm' | 'groups_only';

/**
 * Structured result from shouldRespond.
 */
export interface TriggerResult {
  respond: boolean;
  reason: string;
  accessStatus?: string; // 'allowed' | 'blocked' | 'pending' | 'unknown'
}

/**
 * Decide whether the bot should respond to an incoming message.
 *
 * Mode-aware access policy (REQ-003):
 *   self_only  — admin DMs only, no groups, no ALLOW
 *   allowlist  — gated DMs, group mentions, blocked denied
 *   open_dm    — anyone can DM, blocked senders still denied, groups by mention
 *   groups_only — no DMs, groups by mention
 *
 * WhatsApp uses two identity formats:
 *   JID  — phone@s.whatsapp.net (traditional)
 *   LID  — number@lid (linked-device ID, used in newer groups)
 * Both must be checked since mentionedJid arrays may contain either format.
 */
export function shouldRespond(
  msg: IncomingMessage,
  botJid: string,
  botLid: string | null,
  db: Database,
): TriggerResult {
  if (msg.isFromMe) {
    log.info({ messageId: msg.messageId }, 'trigger: skipping own message');
    return { respond: false, reason: 'own_message' };
  }

  if (!msg.isResponseWorthy) {
    log.info({ messageId: msg.messageId }, 'trigger: not response worthy');
    return { respond: false, reason: 'not_response_worthy' };
  }

  const phone = extractPhone(msg.senderJid);
  const accessMode: AccessMode = config.accessMode;

  // ── self_only mode (REQ-003.AC-01) ──
  // Only DMs from admin phones respond. Groups always rejected.
  // Admin check uses config.adminPhones directly (not access_list) to handle
  // both JID and LID phone formats.
  if (accessMode === 'self_only') {
    if (msg.isGroup) {
      log.info({ messageId: msg.messageId }, 'trigger: self_only rejects groups');
      return { respond: false, reason: 'self_only_no_groups' };
    }
    if (config.adminPhones.has(phone)) {
      log.info({ messageId: msg.messageId, phone }, 'trigger: self_only admin DM → respond');
      return { respond: true, reason: 'self_only_admin', accessStatus: 'allowed' };
    }
    log.info({ messageId: msg.messageId, phone }, 'trigger: self_only rejects non-admin');
    return { respond: false, reason: 'self_only_rejected', accessStatus: 'blocked' };
  }

  // ── open_dm mode (REQ-003.AC-03) ──
  // Anyone can DM, blocked senders still denied, groups by mention only.
  if (accessMode === 'open_dm') {
    const entry = lookupAccess(db, 'phone', phone);
    if (entry?.status === 'blocked') {
      log.info({ messageId: msg.messageId, phone }, 'trigger: open_dm blocked sender');
      return { respond: false, reason: 'blocked', accessStatus: 'blocked' };
    }
    if (!msg.isGroup) {
      log.info({ messageId: msg.messageId, phone }, 'trigger: open_dm DM → respond');
      return { respond: true, reason: 'open_dm', accessStatus: 'allowed' };
    }
    // Fall through to group mention check below
  }

  // ── allowlist / groups_only / open_dm groups — use access_list ──
  const entry = lookupAccess(db, 'phone', phone);

  if (entry?.status === 'blocked') {
    log.info({ messageId: msg.messageId, phone }, 'trigger: blocked sender');
    return { respond: false, reason: 'blocked', accessStatus: 'blocked' };
  }

  if (msg.isGroup) {
    // Check if this group is set to auto-respond (access_list entry with subject_type='group', status='allowed')
    const groupEntry = lookupAccess(db, 'group', msg.chatJid);
    if (groupEntry?.status === 'allowed') {
      log.info({ messageId: msg.messageId, chatJid: msg.chatJid }, 'trigger: group auto-respond');
      return { respond: true, reason: 'group_auto_respond' };
    }

    // Build set of identifiers the bot is known by (normalized — number before @)
    const botIds = new Set<string>();
    botIds.add(botJid);
    botIds.add(botJid.split('@')[0]);
    if (botLid) {
      botIds.add(botLid);
      botIds.add(botLid.split('@')[0]);
    }

    const mentioned = msg.mentionedJids.some(
      (jid) => botIds.has(jid) || botIds.has(jid.split('@')[0]),
    );

    log.info({ messageId: msg.messageId, chatJid: msg.chatJid, mentioned }, 'trigger: group message');
    return { respond: mentioned, reason: mentioned ? 'mentioned' : 'not_mentioned' };
  }

  // DM — check access list
  if (!entry) {
    log.info({ messageId: msg.messageId, phone }, 'trigger: DM from unknown sender');
    return { respond: false, reason: 'unknown', accessStatus: 'unknown' };
  }

  if (entry.status === 'pending') {
    log.info({ messageId: msg.messageId, phone }, 'trigger: DM from pending sender');
    return { respond: false, reason: 'pending', accessStatus: 'pending' };
  }

  // entry.status === 'allowed'
  log.info({ messageId: msg.messageId, chatJid: msg.chatJid }, 'trigger: DM allowed → respond');
  return { respond: true, reason: 'dm_allowed', accessStatus: 'allowed' };
}
