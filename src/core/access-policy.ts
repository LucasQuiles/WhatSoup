import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage } from './types.ts';
import type { Database } from './database.ts';
import { lookupAccess, extractPhone } from './access-list.ts';
import { createChildLogger } from '../logger.ts';
import { config, type AccessMode } from '../config.ts';
import { isAdminPhone } from '../lib/phone.ts';

/**
 * Resolve a LID number to a phone number via the Baileys reverse-mapping file.
 *
 * Baileys writes `lid-mapping-{lid}_reverse.json` containing the E.164 phone
 * string when it receives a lid-mapping.update event. Returns null if the file
 * doesn't exist or is malformed.
 *
 * The results are cached in memory so repeated calls for the same LID within a
 * process lifetime don't hit the filesystem.
 */
const _lidPhoneCache = new Map<string, string | null>();

export function resolveLidPhone(lidNum: string, authDir: string): string | null {
  if (_lidPhoneCache.has(lidNum)) return _lidPhoneCache.get(lidNum)!;
  const filePath = join(authDir, `lid-mapping-${lidNum}_reverse.json`);
  try {
    const raw = readFileSync(filePath, 'utf8').trim();
    const phone = JSON.parse(raw);
    if (typeof phone === 'string' && phone.length > 0) {
      _lidPhoneCache.set(lidNum, phone);
      return phone;
    }
  } catch {
    // File absent or malformed — treat as unresolvable
  }
  _lidPhoneCache.set(lidNum, null);
  return null;
}

const log = createChildLogger('conversation');

const IMPLICIT_MENTION_TYPES = new Set(['audio', 'image', 'sticker', 'video']);

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
    log.debug({ messageId: msg.messageId }, 'trigger: skipping own message');
    return { respond: false, reason: 'own_message' };
  }

  if (!msg.isResponseWorthy) {
    log.debug({ messageId: msg.messageId }, 'trigger: not response worthy');
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
      log.debug({ messageId: msg.messageId }, 'trigger: self_only rejects groups');
      return { respond: false, reason: 'self_only_no_groups' };
    }

    // For LID senders, the extracted "phone" is an opaque LID number unrelated
    // to the real phone — resolve it from the Baileys reverse-mapping file.
    let effectivePhone = phone;
    if (msg.senderJid.endsWith('@lid')) {
      const resolved = resolveLidPhone(phone, config.authDir);
      if (resolved !== null) {
        effectivePhone = resolved;
        log.debug({ messageId: msg.messageId, lid: phone, resolvedPhone: effectivePhone }, 'trigger: resolved LID → phone');
      } else {
        log.debug({ messageId: msg.messageId, lid: phone }, 'trigger: LID phone unresolvable, self_only rejects');
        return { respond: false, reason: 'self_only_rejected', accessStatus: 'blocked' };
      }
    }

    if (isAdminPhone(effectivePhone, config.adminPhones)) {
      log.debug({ messageId: msg.messageId, phone: effectivePhone }, 'trigger: self_only admin DM → respond');
      return { respond: true, reason: 'self_only_admin', accessStatus: 'allowed' };
    }
    log.debug({ messageId: msg.messageId, phone: effectivePhone }, 'trigger: self_only rejects non-admin');
    return { respond: false, reason: 'self_only_rejected', accessStatus: 'blocked' };
  }

  // ── Shared phone lookup for all remaining modes ──
  const entry = lookupAccess(db, 'phone', phone);

  if (entry?.status === 'blocked') {
    log.info({ messageId: msg.messageId, phone }, 'trigger: blocked sender');
    return { respond: false, reason: 'blocked', accessStatus: 'blocked' };
  }

  // ── open_dm mode (REQ-003.AC-03) ──
  // Anyone can DM (unless blocked, already handled above), groups by mention only.
  if (accessMode === 'open_dm' && !msg.isGroup) {
    log.debug({ messageId: msg.messageId, phone }, 'trigger: open_dm DM → respond');
    return { respond: true, reason: 'open_dm', accessStatus: 'allowed' };
  }

  // ── groups_only mode (REQ-003.AC-04) ── reject all DMs
  if (accessMode === 'groups_only' && !msg.isGroup) {
    log.debug({ messageId: msg.messageId, phone }, 'trigger: groups_only rejects DMs');
    return { respond: false, reason: 'groups_only_no_dms' };
  }

  if (msg.isGroup) {
    // Check if this group is set to auto-respond (access_list entry with subject_type='group', status='allowed')
    const groupEntry = lookupAccess(db, 'group', msg.chatJid);
    if (groupEntry?.status === 'allowed') {
      log.debug({ messageId: msg.messageId, chatJid: msg.chatJid }, 'trigger: group auto-respond');
      return { respond: true, reason: 'group_auto_respond' };
    }

    // Media messages (audio, image, sticker, video) can't contain @mentions in
    // WhatsApp, so treat them as implicit mentions in groups the bot is known to
    // (has an access_list entry). This allows media to reach the bot without
    // requiring a separate text @tag.
    if (IMPLICIT_MENTION_TYPES.has(msg.contentType) && groupEntry && groupEntry.status !== 'blocked') {
      log.debug({ messageId: msg.messageId, chatJid: msg.chatJid, contentType: msg.contentType }, 'trigger: media in known group — implicit mention');
      return { respond: true, reason: 'media_implicit_mention' };
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

    log.debug({ messageId: msg.messageId, chatJid: msg.chatJid, mentioned }, 'trigger: group message');
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
  log.debug({ messageId: msg.messageId, chatJid: msg.chatJid }, 'trigger: DM allowed → respond');
  return { respond: true, reason: 'dm_allowed', accessStatus: 'allowed' };
}
