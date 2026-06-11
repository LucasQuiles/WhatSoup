import { config } from '../config.ts';
import { createChildLogger } from '../logger.ts';
import type { Database } from './database.ts';
import { insertPending, updateAccess } from './access-list.ts';
import type { SubjectType } from './access-list.ts';
import { toPersonalJid, toLidJid } from './jid-constants.ts';
import { getAllLidMappings } from './lid-resolver.ts';
import { getMessagesBySender, type StoredMessage } from './messages.ts';
import { isAdminPhone } from '../lib/phone.ts';
import type { IncomingMessage, Messenger } from './types.ts';
import type { DurabilityEngine } from './durability.ts';
import { sendTracked } from './durability.ts';
import type { Runtime } from '../runtimes/types.ts';
import type { AdminCommand } from './command-router.ts';

const log = createChildLogger('admin');

/** Track replayed message IDs to prevent duplicate replays within this process lifetime. */
const MAX_REPLAYED_IDS = 10_000;
const replayedIds = new Set<string>();

function rememberReplayedId(messageId: string): void {
  replayedIds.add(messageId);
  if (replayedIds.size > MAX_REPLAYED_IDS) {
    const oldest = replayedIds.values().next().value;
    if (oldest !== undefined) {
      replayedIds.delete(oldest);
    }
  }
}

/** Test-only helpers for LEAK-10 coverage. */
export function __resetReplayedIdsForTests(): void {
  replayedIds.clear();
}

/** Test-only helpers for LEAK-10 coverage. */
export function __rememberReplayedIdForTests(messageId: string): void {
  rememberReplayedId(messageId);
}

/** Test-only helpers for LEAK-10 coverage. */
export function __getReplayedIdsSizeForTests(): number {
  return replayedIds.size;
}

/** Test-only helpers for LEAK-10 coverage. */
export function __hasReplayedIdForTests(messageId: string): boolean {
  return replayedIds.has(messageId);
}

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

      // Collect all stored messages across JID formats, deduplicate, take most recent N
      const allStored: StoredMessage[] = [];
      for (const senderJid of jidFormats) {
        allStored.push(...getMessagesBySender(db, senderJid));
      }
      const totalQueued = allStored.length;

      // Filter already-replayed, sort by timestamp ascending, take most recent N
      const toReplay = allStored
        .filter(m => !replayedIds.has(m.messageId))
        .slice(-config.adminReplayMax);

      const replayCount = toReplay.length;
      await sendTracked(messenger, adminChatJid, `Allowed +${subjectId} — replaying ${replayCount} of ${totalQueued} queued messages`, durability, { replayPolicy: 'safe', isTerminal: true });

      for (const msg of toReplay) {
        rememberReplayedId(msg.messageId);
        const incomingMsg: IncomingMessage = {
          messageId: msg.messageId,
          chatJid: msg.chatJid,
          senderJid: msg.senderJid,
          senderName: msg.senderName,
          content: msg.content,
          contentText: msg.contentText ?? null,
          contentType: msg.contentType,
          isFromMe: false,
          isGroup: false,
          mentionedJids: [],
          timestamp: msg.timestamp,
          quotedMessageId: msg.quotedMessageId,
          isResponseWorthy: true,
        };
        await handleMessageFn(incomingMsg);
        // Throttle between replayed messages to avoid flooding
        if (config.adminReplayDelayMs > 0) {
          await new Promise(r => setTimeout(r, config.adminReplayDelayMs));
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
  const lidMap = getAllLidMappings(db);
  for (const [lid, mappedPhone] of lidMap) {
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

// ---------------------------------------------------------------------------
// handleFallbackCommand
// ---------------------------------------------------------------------------

/** Format a remaining-time duration for the STATUS reply. */
function formatRelativeWindow(activeUntil: number): string {
  const remainingMs = activeUntil - Date.now();
  const totalMinutes = Math.round(remainingMs / 60_000);
  if (totalMinutes < 90) {
    return `≈${totalMinutes}m`;
  }
  const hours = Math.round(totalMinutes / 60 * 10) / 10;
  return `≈${hours}h`;
}

export async function handleFallbackCommand(
  runtime: Runtime,
  messenger: Messenger,
  cmd: Extract<AdminCommand, { action: 'fallback' }>,
  adminChatJid: string,
  durability?: DurabilityEngine,
): Promise<void> {
  const reply = (text: string) =>
    sendTracked(messenger, adminChatJid, text, durability, { replayPolicy: 'safe', isTerminal: true });

  if (cmd.sub === 'help') {
    await reply(
      'Fallback commands: FALLBACK ON [<n>m|<n>h] — force backup-provider window (default 5h); FALLBACK OFF — revert to primary; FALLBACK STATUS — current provider, window, turn counters. (support varies by instance type)',
    );
    return;
  }

  if (cmd.sub === 'status') {
    const state = runtime.getFallbackState?.();
    if (!state) { await reply('Fallback status not supported on this instance.'); return; }
    const window = state.fallbackActiveUntil
      ? `until ${new Date(state.fallbackActiveUntil).toISOString()} (${formatRelativeWindow(state.fallbackActiveUntil)})`
      : 'none';
    await reply(`Provider: ${state.effectiveProvider}; window: ${window}; fallback turns: ${state.fallbackTurnsServed} served, ${state.fallbackTurnsEmpty} empty`);
    return;
  }

  if (cmd.sub === 'on') {
    if (!runtime.forceFallback) { await reply('Fallback control not supported on this instance.'); return; }
    const result = runtime.forceFallback(cmd.durationMs);
    if (!result.ok) { await reply(`Cannot force fallback: ${result.reason}`); return; }
    await reply(`Fallback forced until ${new Date(result.activeUntil).toISOString()}.` + (result.clamped ? ' (duration clamped to the allowed window)' : ''));
    return;
  }

  // sub === 'off'
  if (!runtime.disableFallback) { await reply('Fallback control not supported on this instance.'); return; }
  runtime.disableFallback();
  await reply('Fallback disabled — primary provider active.');
}
