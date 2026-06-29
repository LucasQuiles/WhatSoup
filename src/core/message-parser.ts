/**
 * Message parsing — pure transform from Baileys `WAMessage` to our internal
 * `IncomingMessage` shape. No I/O, no transport concerns. Used by the live
 * ingest path in `src/transport/connection.ts` and the history-sync path in
 * `src/core/history-sync.ts`.
 *
 * Moved here from `src/transport/connection.ts` to resolve a
 * `core/` → `transport/` value-import inversion. A re-export chain in
 * `connection.ts` preserves the prior public entry point.
 */
import { type WAMessage, isJidGroup, jidNormalizedUser } from '@whiskeysockets/baileys';
import type { IncomingMessage } from './types.ts';
import { bareNumber, isLidJid } from './jid-constants.ts';
import { normalizeUnixTimestampSeconds } from '../fleet/time-utils.ts';
import { stripLoneSurrogates } from './sanitize-surrogates.ts';

/**
 * Unwrap Baileys container types to reach the real message payload.
 * Handles ephemeral, view-once (v1 + v2), document-with-caption, and edited
 * message wrappers recursively.
 */
export function unwrapMessage(message: any): any {
  if (!message) return message;
  if (message.ephemeralMessage?.message)            return unwrapMessage(message.ephemeralMessage.message);
  if (message.viewOnceMessage?.message)             return unwrapMessage(message.viewOnceMessage.message);
  if (message.viewOnceMessageV2?.message)           return unwrapMessage(message.viewOnceMessageV2.message);
  if (message.documentWithCaptionMessage?.message)  return unwrapMessage(message.documentWithCaptionMessage.message);
  if (message.editedMessage?.message)               return unwrapMessage(message.editedMessage.message);
  return message;
}

/**
 * Locate the `contextInfo` carried by a (already unwrapped) message payload.
 * Baileys attaches contextInfo to the content node — extendedTextMessage,
 * imageMessage, documentMessage, videoMessage, … — never to the message
 * wrapper itself. Scanning first-level values covers every content type,
 * including ones added later, so caption mentions and media replies are not
 * silently dropped.
 */
export function extractContextInfo(message: any): any | null {
  if (!message || typeof message !== 'object') return null;
  if (message.contextInfo && typeof message.contextInfo === 'object') {
    return message.contextInfo;
  }
  for (const value of Object.values(message)) {
    if (value && typeof value === 'object') {
      const ci = (value as { contextInfo?: unknown }).contextInfo;
      if (ci && typeof ci === 'object') return ci;
    }
  }
  return null;
}

export const MEDIA_CONTENT_TYPES = new Set(['image', 'video', 'audio', 'document', 'sticker']);

export function parseIncomingMessage(msg: WAMessage): IncomingMessage | null {
  if (!msg.message || !msg.key?.remoteJid) return null;

  // Status broadcasts (status@broadcast) are stored but marked non-response-worthy
  // via the isResponseWorthy check below — they won't trigger agent sessions.

  const innerMessage = unwrapMessage(msg.message);

  // --- Content extraction ---
  let content: string | null = null;
  let contentText: string | null = null;
  let contentType: import('./types.ts').ContentType = 'unknown';

  if (innerMessage.conversation) {
    content = innerMessage.conversation;
    contentText = null;
    contentType = 'text';
  } else if (innerMessage.extendedTextMessage?.text) {
    content = innerMessage.extendedTextMessage.text;
    contentText = null;
    contentType = 'text';
  } else if (innerMessage.imageMessage) {
    const caption = innerMessage.imageMessage.caption ?? null;
    content = caption;
    contentText = caption;
    contentType = 'image';
  } else if (innerMessage.videoMessage) {
    const caption = innerMessage.videoMessage.caption ?? null;
    const vm = innerMessage.videoMessage;
    if (caption) {
      content = caption;
      contentText = caption;
    } else {
      content = JSON.stringify({
        type: 'video',
        duration: vm.seconds ?? null,
        width: vm.width ?? null,
        height: vm.height ?? null,
      });
      contentText = `Video: ${vm.seconds ?? '?'}s`;
    }
    contentType = 'video';
  } else if (innerMessage.documentMessage) {
    const dm = innerMessage.documentMessage;
    const caption = dm.caption ?? null;
    if (caption) {
      content = caption;
      contentText = caption;
    } else {
      content = JSON.stringify({
        type: 'document',
        fileName: dm.fileName ?? null,
        mimetype: dm.mimetype ?? null,
        pageCount: dm.pageCount ?? null,
      });
      contentText = `Document: ${dm.fileName ?? 'file'}`;
    }
    contentType = 'document';
  } else if (innerMessage.audioMessage) {
    const am = innerMessage.audioMessage;
    content = JSON.stringify({
      type: 'audio',
      duration: am.seconds ?? null,
      ptt: am.ptt ?? false,
      transcription: null,
    });
    contentText = null;
    contentType = 'audio';
  } else if (innerMessage.stickerMessage) {
    const sm = innerMessage.stickerMessage;
    const emoji = (sm as any).emoji ?? (sm as any).associatedEmoji ?? null;
    content = JSON.stringify({
      type: 'sticker',
      emoji,
      isAnimated: sm.isAnimated ?? false,
    });
    contentText = emoji ? `Sticker: ${emoji}` : 'Sticker';
    contentType = 'sticker';
  } else if (innerMessage.locationMessage) {
    const lm = innerMessage.locationMessage;
    content = JSON.stringify({
      type: 'location',
      latitude: lm.degreesLatitude ?? null,
      longitude: lm.degreesLongitude ?? null,
      name: lm.name ?? null,
      address: lm.address ?? null,
      url: lm.url ?? null,
    });
    contentText = `Location: ${lm.name || lm.address || 'shared'} (${lm.degreesLatitude}, ${lm.degreesLongitude})`;
    contentType = 'location';
  } else if (innerMessage.liveLocationMessage) {
    const ll = innerMessage.liveLocationMessage;
    const lat = ll.degreesLatitude ?? 0;
    const lng = ll.degreesLongitude ?? 0;
    const accuracy = ll.accuracyInMeters ?? 0;
    content = `Live location: ${lat}, ${lng} (accuracy: ${accuracy}m)`;
    contentText = content;
    contentType = 'live_location';
  } else if (innerMessage.groupInviteMessage) {
    const gi = innerMessage.groupInviteMessage;
    const groupName = gi.groupName ?? 'Unknown group';
    const caption = gi.caption ?? '';
    content = `Group invite: ${groupName}${caption ? ` - ${caption}` : ''}`;
    contentText = content;
    contentType = 'group_invite';
  } else if (innerMessage.productMessage) {
    const pi = innerMessage.productMessage?.product ?? innerMessage.productMessage;
    const title = pi?.title ?? 'Unknown product';
    const description = pi?.description ?? '';
    const currencyCode = pi?.currencyCode ?? '';
    const priceAmount = pi?.priceAmount1000 != null ? (Number(pi.priceAmount1000) / 1000).toString() : '';
    content = `Product: ${title}${description ? ` - ${description}` : ''}${currencyCode || priceAmount ? ` (${currencyCode} ${priceAmount})`.trim() : ''}`;
    contentText = content;
    contentType = 'product';
  } else if (innerMessage.pinInChatMessage) {
    content = 'Pinned a message';
    contentText = content;
    contentType = 'pin';
  } else if (innerMessage.interactiveMessage) {
    const im = innerMessage.interactiveMessage;
    const bodyText = im.body?.text ?? null;
    const type = im.type ?? 'interactive';
    content = `Interactive: ${bodyText || type}`;
    contentText = content;
    contentType = 'interactive';
  } else if (innerMessage.contactMessage) {
    const cm = innerMessage.contactMessage;
    content = JSON.stringify({
      type: 'contact',
      displayName: cm.displayName ?? null,
      vcard: cm.vcard ?? null,
    });
    contentText = `Contact: ${cm.displayName ?? 'Unknown'}`;
    contentType = 'contact';
  } else if (innerMessage.contactsArrayMessage) {
    const contacts = (innerMessage.contactsArrayMessage.contacts ?? []).map((c: any) => ({
      displayName: c.displayName ?? null,
      vcard: c.vcard ?? null,
    }));
    content = JSON.stringify({
      type: 'contacts',
      contacts,
    });
    contentText = `Contacts: ${contacts.map((c: any) => c.displayName).join(', ')}`;
    contentType = 'contact';
  } else if (innerMessage.pollCreationMessage) {
    const pm = innerMessage.pollCreationMessage;
    const options = (pm.options ?? []).map((o: any) => o.optionName);
    content = JSON.stringify({
      type: 'poll',
      name: pm.name ?? null,
      options,
      selectableCount: pm.selectableOptionCount ?? null,
    });
    contentText = `Poll: ${pm.name ?? 'Unnamed'} — ${options.length} options`;
    contentType = 'poll';
  }

  // --- Timestamp ---
  const timestamp = normalizeUnixTimestampSeconds(msg.messageTimestamp);

  // --- Sender resolution ---
  // Groups: participant field carries the real sender JID
  // DMs:    remoteJid is the sender unless it is from us
  let rawSenderJid: string | null | undefined = msg.key.participant;
  if (!msg.key.fromMe && !rawSenderJid && !isJidGroup(msg.key.remoteJid)) {
    rawSenderJid = msg.key.remoteJid;
  }
  if (!rawSenderJid) {
    // fromMe in a DM — senderJid is irrelevant but we need a non-empty value
    rawSenderJid = msg.key.remoteJid;
  }

  const senderJid = jidNormalizedUser(rawSenderJid!);

  // --- Display name ---
  let senderName: string | null = msg.pushName ?? null;
  if (!senderName && !isLidJid(senderJid)) {
    // Fall back to the phone-number portion for personal JIDs only.
    // LID JIDs contain opaque numbers that are meaningless to users —
    // leave senderName null so downstream code can resolve via DB.
    senderName = bareNumber(senderJid) ?? null;
  }

  // --- contextInfo (mentions + quoted reply) ---
  // contextInfo rides on the content node (extendedTextMessage, imageMessage,
  // documentMessage, …), never on the message wrapper. Check the unwrapped
  // payload first, then the original message in case a wrapper carried it.
  const contextInfo =
    extractContextInfo(innerMessage) ?? extractContextInfo(msg.message);

  // --- @mentioned JIDs ---
  const mentionedJids: string[] = contextInfo?.mentionedJid ?? [];

  // --- Quoted message ---
  const quotedMessageId: string | null = contextInfo?.stanzaId ?? null;

  // --- isResponseWorthy ---
  const isStatusBroadcast = msg.key.remoteJid === 'status@broadcast';
  const isReaction = !!(innerMessage as any).reactionMessage;
  const isPollVote = !!(innerMessage as any).pollUpdateMessage;
  const isProtocol = !!(innerMessage as any).protocolMessage;
  // Media types are response-worthy even with null text content (we process them via media pipeline)
  const isMedia = MEDIA_CONTENT_TYPES.has(contentType);
  const hasNoContent = !isMedia && (content === null || (typeof content === 'string' && content.trim() === ''));

  const isResponseWorthy = !isStatusBroadcast && !isReaction && !isPollVote && !isProtocol && !hasNoContent;

  // Sanitize content at ingestion — WhatsApp messages can contain lone surrogates
  // that produce invalid JSON when serialized for LLM API calls.
  const safeContent = content !== null ? stripLoneSurrogates(content) : null;
  const safeContentText = contentText !== null ? stripLoneSurrogates(contentText) : null;
  // QR-056: senderName (pushName) is attacker-controlled and is embedded verbatim
  // into the agent prompt prefix (`[DM from ${senderName} …]`). Sanitize it the same
  // as content so a crafted pushName cannot smuggle a lone surrogate into the agent's
  // API request (which strict server-side JSON parsers reject → turn DoS). The HTTP
  // providers re-sanitize, but the spawned-CLI path does not.
  const safeSenderName = senderName !== null ? stripLoneSurrogates(senderName) : null;

  return {
    messageId: msg.key.id!,
    chatJid: msg.key.remoteJid!,
    senderJid,
    senderName: safeSenderName,
    content: safeContent,
    contentText: safeContentText,
    contentType,
    isFromMe: msg.key.fromMe ?? false,
    isGroup: isJidGroup(msg.key.remoteJid!) ?? false,
    mentionedJids,
    timestamp,
    quotedMessageId,
    isResponseWorthy,
    rawMessage: msg,
  };
}
