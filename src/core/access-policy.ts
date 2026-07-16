import type { IncomingMessage } from './types.ts';
import type { Database } from './database.ts';
import { lookupAccess, resolvePhoneFromJid } from './access-list.ts';
import { bareNumber, normalizeLid, isLidJid, isWhatsAppAuthenticatedJid } from './jid-constants.ts';
import { createChildLogger } from '../logger.ts';
import { config, type AccessMode } from '../config.ts';
import { isAdminPhone } from '../lib/phone.ts';

const log = createChildLogger('conversation');

/**
 * Structured result from shouldRespond.
 */
export interface TriggerResult {
  respond: boolean;
  reason: string;
  accessStatus?: string; // 'allowed' | 'blocked' | 'pending' | 'unknown'
}

export type TrustedActorAccessClass =
  | 'administrator'
  | 'authorized_user'
  | 'untrusted_or_unknown'
  | 'system';

/**
 * Derive the model-visible actor class from transport-authenticated identity.
 * This is deliberately narrower than shouldRespond(): permissive modes may
 * admit a message, but they do not make an unknown sender an authorized user.
 */
export function classifyTrustedActorAccess(
  senderJid: string | null | undefined,
  db: Database,
  adminPhones: Set<string>,
): TrustedActorAccessClass {
  if (!senderJid || !isWhatsAppAuthenticatedJid(senderJid)) return 'untrusted_or_unknown';

  const effectivePhone = resolvePhoneFromJid(senderJid, db);
  const lidLocal = normalizeLid(bareNumber(senderJid));
  if (isLidJid(senderJid) && effectivePhone === lidLocal) {
    return 'untrusted_or_unknown';
  }

  if (isAdminPhone(effectivePhone, adminPhones)) return 'administrator';
  if (lookupAccess(db, 'phone', effectivePhone)?.status === 'allowed') {
    return 'authorized_user';
  }
  return 'untrusted_or_unknown';
}

/**
 * Decide whether the bot should respond to an incoming message.
 *
 * Mode-aware access policy (REQ-003):
 *   self_only  — admin DMs only, no groups, no ALLOW
 *   allowlist  — gated DMs, group mentions, blocked denied
 *   open_dm    — anyone can DM, blocked senders still denied, groups by mention
 *   groups_only — no DMs, groups by mention
 * Unresolved LID senders fail closed before any permissive path because their
 * real phone identity cannot be compared against the phone blocklist.
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

  const effectivePhone = resolvePhoneFromJid(msg.senderJid, db);
  const lidLocal = normalizeLid(bareNumber(msg.senderJid));
  const isUnresolvedLidSender = isLidJid(msg.senderJid) && effectivePhone === lidLocal;

  const isSiblingBot = msg.isGroup && config.siblingPhones?.size > 0 && config.siblingPhones.has(effectivePhone);
  const accessMode: AccessMode = config.accessMode;

  // ── self_only mode (REQ-003.AC-01) ──
  // Only DMs from admin phones respond. Groups always rejected.
  if (accessMode === 'self_only') {
    if (msg.isGroup) {
      log.debug({ messageId: msg.messageId }, 'trigger: self_only rejects groups');
      return { respond: false, reason: 'self_only_no_groups' };
    }

    // Explicit guard: if this is a LID sender whose LID couldn't be resolved
    // to a real phone, reject with a distinct reason for debuggability.
    if (isUnresolvedLidSender) {
      log.debug({ messageId: msg.messageId, senderJid: msg.senderJid }, 'trigger: self_only — LID unresolvable, rejecting');
      return { respond: false, reason: 'self_only_lid_unresolvable', accessStatus: 'blocked' };
    }

    // QR-143: only a WhatsApp-authenticated sender may be granted the self_only
    // admin path. A spoofable @sms sender resolves to the same bare phone as the
    // WhatsApp admin, so gate on the transport before the adminPhones match.
    if (isWhatsAppAuthenticatedJid(msg.senderJid) && isAdminPhone(effectivePhone, config.adminPhones)) {
      log.debug({ messageId: msg.messageId, phone: effectivePhone }, 'trigger: self_only admin DM → respond');
      return { respond: true, reason: 'self_only_admin', accessStatus: 'allowed' };
    }
    log.debug({ messageId: msg.messageId, phone: effectivePhone }, 'trigger: self_only rejects non-admin');
    return { respond: false, reason: 'self_only_rejected', accessStatus: 'blocked' };
  }

  // ── Shared phone lookup for all remaining modes ──
  const entry = lookupAccess(db, 'phone', effectivePhone);

  if (entry?.status === 'blocked') {
    log.info({ messageId: msg.messageId, phone: effectivePhone }, 'trigger: blocked sender');
    return { respond: false, reason: 'blocked', accessStatus: 'blocked' };
  }

  if (isUnresolvedLidSender && !(accessMode === 'groups_only' && !msg.isGroup)) {
    log.info({ messageId: msg.messageId, senderJid: msg.senderJid }, 'trigger: LID unresolvable, rejecting');
    return { respond: false, reason: 'lid_unresolvable', accessStatus: 'blocked' };
  }

  // ── open_dm mode (REQ-003.AC-03) ──
  // Anyone can DM (unless blocked, already handled above), groups by mention only.
  if (accessMode === 'open_dm' && !msg.isGroup) {
    log.debug({ messageId: msg.messageId, phone: effectivePhone }, 'trigger: open_dm DM → respond');
    return { respond: true, reason: 'open_dm', accessStatus: 'allowed' };
  }

  // ── groups_only mode (REQ-003.AC-04) ── reject all DMs
  if (accessMode === 'groups_only' && !msg.isGroup) {
    log.debug({ messageId: msg.messageId, phone: effectivePhone }, 'trigger: groups_only rejects DMs');
    return { respond: false, reason: 'groups_only_no_dms' };
  }

  if (msg.isGroup) {
    // Build set of identifiers the bot is known by (normalized — number before @)
    const botIds = new Set<string>();
    botIds.add(botJid);
    botIds.add(bareNumber(botJid));
    if (botLid) {
      botIds.add(botLid);
      botIds.add(bareNumber(botLid));
    }

    const mentioned = msg.mentionedJids.some(
      (jid) => botIds.has(jid) || botIds.has(bareNumber(jid)),
    );

    // ── Sibling bot filter (anti-echo-loop) ──
    // Siblings can see all messages (stored by ingest before this check) but
    // only RESPOND when explicitly @mentioned. This prevents infinite reply
    // loops while still allowing orchestrator bots to delegate via mentions.
    if (isSiblingBot) {
      log.debug({ messageId: msg.messageId, phone: effectivePhone, mentioned }, 'trigger: sibling bot in group');
      return { respond: mentioned, reason: mentioned ? 'sibling_mentioned' : 'sibling_bot' };
    }

    // ── R5: strict group-sender gate ──
    // A single guard, placed AFTER the sibling-bot return (so orchestrator delegation is
    // unaffected) and BEFORE group_auto_respond / media / @mention, so it covers every group
    // response path at once. In `allowlisted_only` mode a group message only produces a
    // response if the SENDER (not just the group) is allowlisted (`entry.status === 'allowed'`,
    // reusing the per-sender lookup above) or admin. This closes both #4 (an allowed group
    // auto-responding to a non-allowlisted member) and #20 (an unknown/pending sender
    // @mention-activating the bot in an un-allowlisted group). Default 'any_member' is a no-op.
    if (config.groupSenderPolicy === 'allowlisted_only') {
      // Admin elevation is transport-gated (QR-143), mirroring the self_only admin path:
      // a spoofable non-WhatsApp-authenticated sender must not clear the admin branch.
      const senderAllowed = entry?.status === 'allowed'
        || (isWhatsAppAuthenticatedJid(msg.senderJid) && isAdminPhone(effectivePhone, config.adminPhones));
      if (!senderAllowed) {
        log.info({ messageId: msg.messageId, phone: effectivePhone }, 'trigger: group strict mode rejects non-allowlisted sender');
        return { respond: false, reason: 'strict_group_non_allowlisted', accessStatus: entry?.status ?? 'unknown' };
      }
    }

    // Check if this group is set to auto-respond (access_list entry with subject_type='group', status='allowed')
    const groupEntry = lookupAccess(db, 'group', msg.chatJid);
    if (groupEntry?.status === 'allowed') {
      log.debug({ messageId: msg.messageId, chatJid: msg.chatJid }, 'trigger: group auto-respond');
      return { respond: true, reason: 'group_auto_respond' };
    }

    // (#9) There is deliberately NO media-implicit-mention branch here. An ALLOWED
    // group already responds to every message (group_auto_respond, above), so media
    // in an allowed group is covered. A non-allowed (pending/unknown) group must NOT
    // auto-respond to media: the prior predicate `groupEntry.status !== 'blocked'`
    // wrongly fired for *pending* groups, letting a media message from an
    // un-approved group elicit a reply with no @mention. Media without an @mention in
    // a non-allowed group now falls through to the @mention check below and only
    // responds when the bot is actually mentioned. Do not re-add a status-based media
    // shortcut: `=== 'allowed'` is dead (narrowed out above) and `!== 'blocked'` is the bug.

    log.debug({ messageId: msg.messageId, chatJid: msg.chatJid, mentioned }, 'trigger: group message');
    return { respond: mentioned, reason: mentioned ? 'mentioned' : 'not_mentioned' };
  }

  // DM — check access list
  if (!entry) {
    log.info({ messageId: msg.messageId, phone: effectivePhone }, 'trigger: DM from unknown sender');
    return { respond: false, reason: 'unknown', accessStatus: 'unknown' };
  }

  if (entry.status === 'pending') {
    log.info({ messageId: msg.messageId, phone: effectivePhone }, 'trigger: DM from pending sender');
    return { respond: false, reason: 'pending', accessStatus: 'pending' };
  }

  // entry.status === 'allowed'
  log.debug({ messageId: msg.messageId, chatJid: msg.chatJid }, 'trigger: DM allowed → respond');
  return { respond: true, reason: 'dm_allowed', accessStatus: 'allowed' };
}
