import { config } from '../config.ts';
import { createChildLogger } from '../logger.ts';
import type { Database } from './database.ts';
import { insertPending, updateAccess } from './access-list.ts';
import type { SubjectType } from './access-list.ts';
import { toPersonalJid, toLidJid, toSmsJid, toSignalJid, toImessageJid, isGroupJid } from './jid-constants.ts';
import { getAllLidMappings } from './lid-resolver.ts';
import { getMessagesBySender, type StoredMessage } from './messages.ts';
import { isAdminPhone, isE164Wire, normalizePhoneE164 } from '../lib/phone.ts';
import { APPLEID_EMAIL_RE, SIGNAL_UUID_RE } from './transport-refs.ts';
import type { IncomingMessage, Messenger } from './types.ts';
import type { DurabilityEngine } from './durability.ts';
import { sendTracked } from './durability.ts';
import type { Runtime } from '../runtimes/types.ts';
import type { AdminCommand } from './command-router.ts';
import type { CapabilityGrantManager, GrantAuthorization } from '../lib/capability-grant.ts';
import { sleep } from './retry.ts';

const log = createChildLogger('admin');

/** Track replayed message IDs to prevent duplicate replays within this process lifetime. */
const MAX_REPLAYED_IDS = 10_000;
const replayedIds = new Set<string>();

function normalizeAccessPhoneSubject(subjectId: string): string {
  if (config.transport === 'signal') {
    const lower = subjectId.toLowerCase();
    if (SIGNAL_UUID_RE.test(lower)) return lower;
    if (isE164Wire(subjectId)) return subjectId;
  }
  if (config.transport === 'imessage') {
    const lower = subjectId.toLowerCase();
    if (APPLEID_EMAIL_RE.test(lower)) return lower;
    if (isE164Wire(subjectId)) return subjectId;
  }
  return normalizePhoneE164(subjectId);
}

function formatAccessPhoneSubject(subjectId: string): string {
  return config.transport === 'signal' || config.transport === 'imessage'
    ? subjectId
    : `+${subjectId}`;
}

export function rememberReplayedId(messageId: string): void {
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

/**
 * Select which stored messages should be replayed for a newly-allowed sender.
 *
 * Filters out:
 *   - group-chat messages (chatJid ending in @g.us): group mentions are
 *     dispatched at ingest; unmentioned group messages must not re-enter
 *     dispatch as pseudo-DMs.
 *   - already-replayed message IDs (module-level replayedIds set).
 *
 * Then sorts ascending by timestamp and applies the cap (.slice(-cap)).
 *
 * Callers are responsible for calling rememberReplayedId() per dispatched
 * message so the dedup set is armed after the replay loop.
 */
export function selectReplayableDms(
  stored: StoredMessage[],
  cap: number,
): { toReplay: StoredMessage[]; groupSkipped: number } {
  const dmStored = stored.filter(m => !isGroupJid(m.chatJid));
  const groupSkipped = stored.length - dmStored.length;
  const toReplay = dmStored
    .filter(m => !replayedIds.has(m.messageId))
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-cap);
  return { toReplay, groupSkipped };
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
    // WhatsApp/Twilio use normalized digits. Signal and iMessage preserve
    // their canonical +E.164, UUID, or AppleID access-list identity.
    if (subjectType === 'phone') subjectId = normalizeAccessPhoneSubject(subjectId);
    updateAccess(db, subjectType, subjectId, 'allowed');
    log.info({ subjectType, subjectId, action: 'allowed_by_admin' }, 'access granted by admin');

    if (subjectType === 'phone') {
      // Signal and iMessage each have one canonical sender form. Baileys and
      // Twilio retain personal/SMS/LID access-list keys.
      const jidFormats: string[] = config.transport === 'signal'
        ? [toSignalJid(subjectId)]
        : config.transport === 'imessage'
          ? [toImessageJid(subjectId)]
          : [toPersonalJid(subjectId)];
      // SMS rows are stored under '+<digits>@sms' — include that form so
      // ALLOW over the Twilio transport replays the queued messages too.
      if (config.transport !== 'signal' && config.transport !== 'imessage') {
        jidFormats.push(toSmsJid(`+${normalizePhoneE164(subjectId)}`));
      }
      if (
        config.transport !== 'signal'
        && config.transport !== 'imessage'
        && normalizePhoneE164(subjectId) !== subjectId
      ) {
        // A 10-digit subject (admin typed without country code) must also flip
        // the access row stored under the full-digit key resolvePhoneFromJid
        // produces — otherwise replay succeeds while the sender stays pending.
        jidFormats.push(toPersonalJid(normalizePhoneE164(subjectId)));
      }
      if (config.transport !== 'signal' && config.transport !== 'imessage') {
        const lidMap = getAllLidMappings(db);
        for (const [lid, mappedPhone] of lidMap) {
          if (isAdminPhone(mappedPhone, new Set([subjectId]))) {
            jidFormats.push(toLidJid(lid));
          }
        }
      }

      // Collect all stored messages across JID formats
      const allStored: StoredMessage[] = [];
      for (const senderJid of jidFormats) {
        allStored.push(...getMessagesBySender(db, senderJid));
      }

      // Select replayable DMs: excludes group messages and already-replayed IDs, applies cap.
      const { toReplay, groupSkipped } = selectReplayableDms(allStored, config.adminReplayMax);
      if (groupSkipped > 0) {
        log.info({ subjectId, groupSkipped }, 'replay: skipped group messages');
      }

      const replayCount = toReplay.length;
      // totalQueued is the DM-only count; group rows are excluded from the denominator
      // so the admin sees an accurate N of M without an unexplained gap.
      const totalQueued = allStored.length - groupSkipped;
      const noticeText = groupSkipped > 0
        ? `Allowed ${formatAccessPhoneSubject(subjectId)} — replaying ${replayCount} of ${totalQueued} queued DM messages (${groupSkipped} group message${groupSkipped === 1 ? '' : 's'} skipped)`
        : `Allowed ${formatAccessPhoneSubject(subjectId)} — replaying ${replayCount} of ${totalQueued} queued messages`;
      await sendTracked(messenger, adminChatJid, noticeText, durability, { replayPolicy: 'safe', isTerminal: true });

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
          await sleep(config.adminReplayDelayMs);
        }
      }
    } else {
      // group subject
      await sendTracked(messenger, adminChatJid, `Got it, allowed group ${subjectId}`, durability, { replayPolicy: 'safe', isTerminal: true });
    }
  } else {
    if (subjectType === 'phone') subjectId = normalizeAccessPhoneSubject(subjectId);
    updateAccess(db, subjectType, subjectId, 'blocked');
    log.info({ subjectType, subjectId, action: 'blocked_by_admin' }, 'access blocked by admin');

    if (subjectType === 'phone') {
      await sendTracked(messenger, adminChatJid, `Blocked ${formatAccessPhoneSubject(subjectId)}`, durability, { replayPolicy: 'safe', isTerminal: true });
    } else {
      await sendTracked(messenger, adminChatJid, `Blocked group ${subjectId}`, durability, { replayPolicy: 'safe', isTerminal: true });
    }
  }
}

// ---------------------------------------------------------------------------
// sendApprovalRequest
// ---------------------------------------------------------------------------

/**
 * Find the admin's chat JID — checks SMS senders first (when present),
 * then personal JIDs and reverse-mapped LIDs from the lid_mappings table.
 *
 * SMS sender rows are stored as '+<digits>@sms'. The admin phones config
 * stores digit strings (no leading '+'). We try the exact SMS JID
 * ('+<phone>@sms') for each admin phone, so the approval reply reaches
 * the admin over the same transport they used to contact the bot.
 *
 * WhatsApp fallback: LIKE `<phone>%` matches '<phone>@s.whatsapp.net'.
 * Final fallback: when config.transport is 'twilio' and no message rows
 * exist yet, synthesise a '+<phone>@sms' JID rather than a WhatsApp JID
 * that the Twilio transport cannot deliver to.
 */
function resolveAdminChatJid(db: Database): string | null {
  const msgStmt = db.raw.prepare(
    'SELECT chat_jid FROM messages WHERE sender_jid LIKE ? AND is_from_me = 0 ORDER BY timestamp DESC LIMIT 1',
  );
  const exactMsgStmt = db.raw.prepare(
    'SELECT chat_jid FROM messages WHERE sender_jid = ? AND is_from_me = 0 ORDER BY timestamp DESC LIMIT 1',
  );

  if (config.transport === 'signal') {
    for (const identity of config.adminPhones) {
      const row = exactMsgStmt.get(toSignalJid(identity)) as { chat_jid: string } | undefined;
      if (row) return row.chat_jid;
    }
    const firstSignalAdmin = [...config.adminPhones][0];
    if (!firstSignalAdmin) {
      log.error('resolveAdminJid: no admin identities configured — cannot resolve Signal admin JID');
      return null;
    }
    return toSignalJid(firstSignalAdmin);
  }

  if (config.transport === 'imessage') {
    for (const identity of config.adminPhones) {
      const row = exactMsgStmt.get(toImessageJid(identity)) as { chat_jid: string } | undefined;
      if (row) return row.chat_jid;
    }
    const firstImessageAdmin = [...config.adminPhones][0];
    if (!firstImessageAdmin) {
      log.error('resolveAdminJid: no admin identities configured — cannot resolve iMessage admin JID');
      return null;
    }
    return toImessageJid(firstImessageAdmin);
  }

  // Search by admin phone numbers — try SMS JID exact match first, then
  // WhatsApp LIKE prefix (fast path for both transports).
  for (const phone of config.adminPhones) {
    // SMS: sender_jid is '+<phone>@sms' — exact LIKE with no wildcard needed,
    // but LIKE is fine here; we use the exact string for precision.
    const smsRow = msgStmt.get(`+${normalizePhoneE164(phone)}@sms`) as { chat_jid: string } | undefined;
    if (smsRow) return smsRow.chat_jid;

    // WhatsApp: sender_jid starts with '<phone>' (e.g. '15550100001@s.whatsapp.net')
    const waRow = msgStmt.get(`${phone}%`) as { chat_jid: string } | undefined;
    if (waRow) return waRow.chat_jid;
  }

  // Search by LIDs that map to admin phones (scans lid_mappings — typically small table)
  const lidMap = getAllLidMappings(db);
  for (const [lid, mappedPhone] of lidMap) {
    if (isAdminPhone(mappedPhone, config.adminPhones)) {
      const row = msgStmt.get(`${lid}%`) as { chat_jid: string } | undefined;
      if (row) return row.chat_jid;
    }
  }

  // No message rows found — synthesise a fallback JID.
  const firstAdmin = [...config.adminPhones][0];
  if (!firstAdmin) {
    log.error('resolveAdminJid: no admin phones configured — cannot resolve admin JID');
    return null;
  }

  // When running on the Twilio transport, return an @sms JID so the
  // approval message is delivered over SMS rather than failing with a
  // WhatsApp JID that the bridge cannot route.
  if (config.transport === 'twilio') {
    // adminPhones entries may omit the country code (suffix-matching design);
    // normalize so the SMS JID is valid E.164.
    return toSmsJid(`+${normalizePhoneE164(firstAdmin)}`);
  }

  return toPersonalJid(firstAdmin);
}

/**
 * QR-100: sanitize an attacker-controlled display field before it is interpolated
 * into the admin approval prompt. Strips line breaks (incl. LS/PS) so an embedded
 * `\nReply ALLOW <evil>` cannot forge a command line, neuters standalone ALLOW/BLOCK
 * command keywords (word-boundary guarded so substrings like "Blockchain"/"Allowance"
 * are untouched), and length-caps. Exported for unit testing.
 */
export function sanitizeApprovalField(raw: string, maxLen: number): string {
  return raw
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .replace(/\b(?:ALLOW|BLOCK)\b/gi, '*')
    .slice(0, maxLen)
    .trim();
}

export async function sendApprovalRequest(
  db: Database,
  messenger: Messenger,
  phone: string,
  displayName: string,
  messagePreview: string,
  durability?: DurabilityEngine,
): Promise<void> {
  const subjectId = config.transport === 'signal' || config.transport === 'imessage'
    ? normalizeAccessPhoneSubject(phone)
    : phone;
  insertPending(db, 'phone', subjectId, displayName);

  // QR-100: displayName (=sender pushName) and messagePreview (=sender content) are
  // attacker-controlled and were previously interpolated RAW into this admin
  // security-decision prompt — an embedded newline + forged `Reply ALLOW <evil>` line
  // could spoof the ALLOW/BLOCK command grammar. Defense: (A) STRUCTURE — label the
  // untrusted fields as sender-provided, each on its own line, with the ALLOW/BLOCK
  // instruction on a FIXED trailing line referencing only the trusted `phone`; and
  // (B) SANITIZE both untrusted spans (strip line breaks so they cannot introduce a
  // new command line, neuter standalone ALLOW/BLOCK keywords, length-cap).
  const safeName = sanitizeApprovalField(displayName, 60);
  const safePreview = sanitizeApprovalField(messagePreview, 100);
  const text =
    `New contact request — Name and Message below are SENDER-PROVIDED (untrusted):\n` +
    `Name: "${safeName}"\n` +
    `Message: "${safePreview}"\n` +
    `To respond, reply exactly: ALLOW ${subjectId} or BLOCK ${subjectId}`;

  const adminJid = resolveAdminChatJid(db);
  if (!adminJid) {
    log.warn({ phone: subjectId, displayName }, 'cannot send approval request — no admin phones configured');
    return;
  }
  await sendTracked(messenger, adminJid, text, durability, { replayPolicy: 'safe', isTerminal: true });

  log.info({ phone: subjectId, displayName, adminJid, action: 'approval_requested' }, 'approval requested');
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
    const chain = Array.isArray(state.fallbackChain) && state.fallbackChain.length > 1
      ? `; chain: ${state.fallbackChain.map((entry) => {
          const target = entry.model ? `${entry.provider} ${entry.model}` : entry.provider;
          const readiness =
            entry.eligible === true ? 'ready' :
            entry.eligible === false ? 'unavailable' :
            'unknown';
          return `${target} (${readiness})`;
        }).join(' -> ')}`
      : '';
    const probes = (state.probeAttempts ?? 0) > 0 ? `; probes: ${state.probeAttempts}` : '';
    const acts = typeof state.fallbackActivations === 'number'
      ? `; activations: ${state.fallbackActivations}; reverts: ${state.fallbackReverts ?? 'n/a'}`
      : '';
    const costUsd = typeof state.fallbackWindowCostUsd === 'number' && state.fallbackWindowCostUsd > 0
      ? `; window cost: $${state.fallbackWindowCostUsd.toFixed(2)}`
      : '';
    await reply(`Provider: ${state.effectiveProvider}; window: ${window}; fallback turns: ${state.fallbackTurnsServed} served, ${state.fallbackTurnsEmpty} empty${probes}${acts}${costUsd}${chain}`);
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

// ---------------------------------------------------------------------------
// handleGrantCommand
// ---------------------------------------------------------------------------

/**
 * Handle a `/grant` admin command by driving the capability-grant manager.
 * Reached ONLY past the isAdminMessage gate in ingest, so the caller is the
 * WhatsApp-authenticated admin — authorize as owner.
 */
export async function handleGrantCommand(
  manager: CapabilityGrantManager,
  messenger: Messenger,
  cmd: Extract<AdminCommand, { action: 'grant' }>,
  adminChatJid: string,
  durability?: DurabilityEngine,
): Promise<void> {
  const reply = (text: string) =>
    sendTracked(messenger, adminChatJid, text, durability, { replayPolicy: 'safe', isTerminal: true });
  const auth: GrantAuthorization = { isOwner: true };

  if (cmd.sub === 'help') {
    await reply(
      'Grant commands: GRANT <group> [<n>m|<n>h] — temporarily unlock a capability group (auto-reverts on expiry, default manual); GRANT DISARM — revert the active grant now; GRANT STATUS — show the active grant.',
    );
    return;
  }

  if (cmd.sub === 'status') {
    const s = await manager.status();
    if (!s.armed) { await reply('No capability grant active.'); return; }
    const window =
      s.remainingMs == null
        ? 'manual (no expiry)'
        : `until ${new Date(Date.now() + s.remainingMs).toISOString()} (${formatRelativeWindow(Date.now() + s.remainingMs)})`;
    await reply(`Grant active: ${s.group} — ${(s.capabilities ?? []).join(', ')}; expires: ${window}.`);
    return;
  }

  if (cmd.sub === 'disarm') {
    const r = await manager.disarm(auth);
    if (r.reason === 'unauthorized') { await reply('Not authorized to disarm capability grants.'); return; }
    await reply(r.changed ? `Grant reverted (removed: ${r.removed.join(', ') || 'none'}).` : 'No capability grant was active.');
    return;
  }

  if (cmd.sub === 'arm') {
    const result = await manager.arm(cmd.group, cmd.durationMs ?? null, auth);
    if (!result.ok) { await reply(`Cannot grant '${cmd.group}': ${result.error}`); return; }
    const exp = result.record.expiresAtMs;
    await reply(
      `Granted '${cmd.group}' — ${result.record.capabilities.join(', ')}` +
        (exp ? `; auto-reverts ${new Date(exp).toISOString()}.` : '; manual (no expiry) — GRANT DISARM to revert.'),
    );
  }
}
