// src/transport/connection.ts
// ConnectionManager — Baileys-backed WhatsApp connection with typed event emission.

import { EventEmitter } from 'node:events';

import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  type WAMessage,
  isJidGroup,
  jidNormalizedUser,
} from '@whiskeysockets/baileys';

import { config } from '../config.ts';
import { createChildLogger } from '../logger.ts';
import { WhatSoupError } from '../errors.ts';
import type { Messenger, IncomingMessage, OutboundMedia, SubmissionReceipt } from '../core/types.ts';
import { toConversationKey } from '../core/conversation-key.ts';
import { formatMentions, ContactsDirectory } from '../core/mentions.ts';
import { PresenceCache } from './presence-cache.ts';

export type { IncomingMessage } from '../core/types.ts';

export type WhatsAppSocket = ReturnType<typeof makeWASocket>;

// ---------------------------------------------------------------------------
// Typed transport events
// ---------------------------------------------------------------------------

export interface TransportEvents {
  contactsUpsert: (contacts: Array<{ id: string; name?: string; notify?: string }>) => void;
  contactsUpdate: (updates: Array<{ id: string; notify?: string; name?: string }>) => void;
  messageEdited: (messageId: string, newContent: string) => void;
  messageDeleted: (messageIds: string[]) => void;
  chatCleared: (jid: string) => void;
  presenceUpdate: (jid: string, status: string, lastSeen?: number) => void;
  callReceived: (callId: string, callFrom: string) => void;
  groupParticipantsUpdate: (data: {
    groupJid: string;
    author: string;
    participants: string[];
    action: 'add' | 'remove' | 'promote' | 'demote';
  }) => void;
  jidAliasChanged: (conversationKey: string, newJid: string) => void;
  historySyncComplete: () => void;
  exhausted: () => void;
  reactionReceived: (data: {
    messageId: string;
    conversationKey: string;
    senderJid: string;
    reaction: string;
  }) => void;
  receiptUpdate: (data: {
    messageId: string;
    recipientJid: string;
    type: string;
  }) => void;
  mediaUpdate: (updates: Array<{ key: { id: string }; update: Record<string, unknown> }>) => void;
  chatsUpsert: (chats: Array<{ id: string; [key: string]: unknown }>) => void;
  chatsUpdate: (updates: Array<{ id: string; [key: string]: unknown }>) => void;
  chatsDelete: (jids: string[]) => void;
  historyMessages: (messages: unknown[]) => void;
}

// Typed event emitter augmentation
export declare interface ConnectionManager {
  on<K extends keyof TransportEvents>(event: K, listener: TransportEvents[K]): this;
  emit<K extends keyof TransportEvents>(event: K, ...args: Parameters<TransportEvents[K]>): boolean;
  off<K extends keyof TransportEvents>(event: K, listener: TransportEvents[K]): this;
  once<K extends keyof TransportEvents>(event: K, listener: TransportEvents[K]): this;
}

// ---------------------------------------------------------------------------
// ConnectionManager
// ---------------------------------------------------------------------------

export class ConnectionManager extends EventEmitter implements Messenger {
  private sock: WhatsAppSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private shuttingDown = false;
  private reconnectPhase: 'backoff' | 'cooldown' | 'retry' = 'backoff';
  private firstFailureAt: number | null = null;
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly MAX_FAILURE_DURATION_MS = 30 * 60 * 1000;
  private static readonly COOLDOWN_MS = 5 * 60 * 1000;

  private readonly log = createChildLogger('connection');

  /** The bot's own JID (phone@s.whatsapp.net) — populated on connection open. */
  botJid: string | null = null;

  /** The bot's own LID (number@lid) — used for @mention matching in groups. */
  botLid: string | null = null;

  /** Callback invoked for every parsed incoming message. Set by the conversation layer. */
  onMessage: ((msg: IncomingMessage) => void) | null = null;

  /** Contacts directory built from incoming messages — maps names → phone numbers for @mention resolution. */
  readonly contactsDir = new ContactsDirectory();

  /** In-memory cache of the most recent presence status per JID. */
  readonly presenceCache = new PresenceCache();

  /** When true, incoming calls are automatically rejected via sock.rejectCall(). */
  autoRejectCalls = false;

  private static readonly MAX_RECONNECT_ATTEMPTS = 10;
  private static readonly BASE_BACKOFF_MS = 1_000;
  private static readonly MAX_BACKOFF_MS = 60_000;

  constructor() {
    super();
    // authDir is sourced from config — no constructor parameters needed
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async connect(): Promise<void> {
    if (this.shuttingDown) return;

    this.log.info('Connecting to WhatsApp');

    try {
      const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
      const { version } = await fetchLatestBaileysVersion();

      // Suppress Baileys internals (handshake material, signal keys, etc.)
      const baileysLogger = this.log.child({ component: 'baileys' });
      (baileysLogger as any).level = 'error';

      const sock = makeWASocket({
        version,
        logger: baileysLogger as any,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, baileysLogger as any),
        },
        generateHighQualityLinkPreview: false,
      });

      this.sock = sock;
      this.registerEventHandlers(sock, saveCreds);
    } catch (err) {
      this.log.error({ err }, 'Failed to create WhatsApp connection');
      if (!this.shuttingDown) {
        this.scheduleReconnect();
      }
    }
  }

  async disconnect(): Promise<void> {
    return this.shutdown();
  }

  async sendMessage(chatJid: string, text: string): Promise<SubmissionReceipt> {
    if (!this.sock) {
      throw new WhatSoupError('WhatsApp is not connected', 'CONNECTION_UNAVAILABLE');
    }
    this.log.info({ chatJid }, 'Sending message');

    // Resolve @name and @number patterns → rewritten text + Baileys mentions array
    const { text: formatted, jids: mentions, hasMentions } = formatMentions(
      text,
      this.contactsDir.contacts,
    );

    let result;
    if (hasMentions) {
      this.log.info({ mentions }, 'Outbound message includes mentions');
      result = await this.sock.sendMessage(chatJid, { text: formatted, mentions });
    } else {
      result = await this.sock.sendMessage(chatJid, { text: formatted });
    }
    return { waMessageId: result?.key?.id ?? null };
  }

  /**
   * Send a raw Baileys message payload. Used by MCP tools that need to send
   * message types not covered by the typed sendMessage/sendMedia helpers.
   */
  async sendRaw(chatJid: string, content: Record<string, unknown>): Promise<SubmissionReceipt> {
    if (!this.sock) throw new Error('WhatsApp is not connected');
    const result = await this.sock.sendMessage(chatJid, content as any);
    return { waMessageId: result?.key?.id ?? null };
  }

  async setTyping(chatJid: string, typing: boolean): Promise<void> {
    if (!this.sock) return;
    try {
      await this.sock.sendPresenceUpdate(typing ? 'composing' : 'paused', chatJid);
    } catch {
      // best-effort — presence failures must never surface to callers
    }
  }

  async sendMedia(chatJid: string, media: OutboundMedia): Promise<SubmissionReceipt> {
    if (!this.sock) {
      throw new WhatSoupError('WhatsApp is not connected', 'CONNECTION_UNAVAILABLE');
    }
    this.log.info({ chatJid, mediaType: media.type }, 'Sending media');

    let result;
    switch (media.type) {
      case 'image':
        result = await this.sock.sendMessage(chatJid, {
          image: media.buffer,
          caption: media.caption,
          mimetype: media.mimetype,
          viewOnce: media.viewOnce,
        });
        break;
      case 'document':
        result = await this.sock.sendMessage(chatJid, {
          document: media.buffer,
          fileName: media.filename,
          mimetype: media.mimetype,
          caption: media.caption,
        });
        break;
      case 'audio':
        result = await this.sock.sendMessage(chatJid, {
          audio: media.buffer,
          mimetype: media.mimetype,
          ptt: media.ptt,
          seconds: media.seconds,
        });
        break;
      case 'video':
        result = await this.sock.sendMessage(chatJid, {
          video: media.buffer,
          caption: media.caption,
          mimetype: media.mimetype,
          ptv: media.ptv,
          gifPlayback: media.gifPlayback,
          viewOnce: media.viewOnce,
        });
        break;
      case 'sticker':
        result = await this.sock.sendMessage(chatJid, {
          sticker: media.buffer,
          mimetype: media.mimetype ?? 'image/webp',
          isAnimated: media.isAnimated,
        });
        break;
    }
    return { waMessageId: result?.key?.id ?? null };
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
    if (this.sock) {
      try {
        this.sock.end(undefined);
      } catch {
        // best-effort
      }
      this.sock = null;
    }
  }

  // -------------------------------------------------------------------------
  // Event registration
  // -------------------------------------------------------------------------

  private registerEventHandlers(sock: WhatsAppSocket, saveCreds: () => Promise<void>): void {
    sock.ev.process(async (events) => {
      // Stale-socket guard: drop events from a socket that is no longer current
      if (this.sock !== sock) return;

      if (events['connection.update']) {
        this.handleConnectionUpdate(sock, events['connection.update']);
      }

      if (events['creds.update']) {
        try {
          await saveCreds();
          this.log.info('Credentials saved');
        } catch (err) {
          this.log.error({ err }, 'Failed to save credentials');
        }
      }

      if (events['messages.upsert']) {
        this.handleMessagesUpsert(events['messages.upsert']);
      }

      if (events['messages.update']) {
        this.handleMessagesUpdate(events['messages.update'] as any[]);
      }

      if (events['messages.delete']) {
        this.handleMessagesDelete(events['messages.delete'] as any);
      }

      if (events['contacts.upsert']) {
        const contacts = events['contacts.upsert'] as Array<{
          id: string;
          name?: string;
          notify?: string;
        }>;
        this.emit('contactsUpsert', contacts);
      }

      if (events['contacts.update']) {
        const updates = events['contacts.update'] as Array<{
          id: string;
          notify?: string;
          name?: string;
        }>;
        this.emit('contactsUpdate', updates);
      }

      if (events['presence.update']) {
        this.handlePresenceUpdate(events['presence.update'] as any);
      }

      if (events['call']) {
        this.handleCall(sock, events['call'] as any[]);
      }

      if (events['group-participants.update']) {
        const update = events['group-participants.update'] as any;
        const { id, author, participants, action } = update;
        this.log.info({ groupJid: id, author, participants, action }, 'group participants update');
        this.emit('groupParticipantsUpdate', {
          groupJid: id,
          author: author ?? '',
          participants: participants ?? [],
          action,
        });

        // Existing bot-removal detection
        if (action === 'remove') {
          const botRemoved = (participants || []).some(
            (p: string) => p === this.botJid || p === this.botLid
          );
          if (botRemoved) {
            this.log.warn({ groupJid: id }, 'bot was removed from group');
          }
        }
      }

      if (events['lid-mapping.update']) {
        const mapping = events['lid-mapping.update'] as { lid?: string; pn?: string };
        if (mapping.lid && mapping.pn) {
          const conversationKey = toConversationKey(mapping.lid);
          this.log.info({ lid: mapping.lid, pn: mapping.pn, conversationKey }, 'LID mapping updated');
          this.emit('jidAliasChanged', conversationKey, mapping.pn);
        }
      }

      if (events['messages.reaction']) {
        const reactions = events['messages.reaction'] as Array<{
          key: { remoteJid?: string; id?: string; fromMe?: boolean };
          reaction: { text: string; key: { remoteJid?: string; participant?: string } };
        }>;
        for (const r of reactions) {
          const messageId = r.key.id;
          const remoteJid = r.key.remoteJid;
          if (!messageId || !remoteJid) continue;
          const conversationKey = toConversationKey(remoteJid);
          const senderJid = r.reaction.key.participant ?? r.reaction.key.remoteJid ?? '';
          this.emit('reactionReceived', {
            messageId,
            conversationKey,
            senderJid,
            reaction: r.reaction.text ?? '',
          });
        }
      }

      if (events['message-receipt.update']) {
        const receipts = events['message-receipt.update'] as Array<{
          key: { id?: string; remoteJid?: string };
          receipt: { receiptTimestamp?: number; readTimestamp?: number; playedTimestamp?: number };
          update: { status?: number };
        }>;
        for (const r of receipts) {
          const messageId = r.key.id;
          const recipientJid = r.key.remoteJid;
          if (!messageId || !recipientJid) continue;
          // Map Baileys receipt status to type string
          const status = r.update?.status;
          let type = 'server';
          if (status === 3) type = 'delivery';
          else if (status === 4) type = 'read';
          else if (status === 5) type = 'played';
          this.emit('receiptUpdate', { messageId, recipientJid, type });
        }
      }

      if (events['messages.media-update']) {
        const updates = events['messages.media-update'] as Array<{
          key: { id: string };
          update: Record<string, unknown>;
        }>;
        this.log.info({ count: updates.length }, 'media update received');
        this.emit('mediaUpdate', updates);
      }

      if (events['chats.upsert']) {
        const chats = events['chats.upsert'] as Array<{ id: string; [key: string]: unknown }>;
        this.emit('chatsUpsert', chats);
      }

      if (events['chats.update']) {
        const updates = events['chats.update'] as Array<{ id: string; [key: string]: unknown }>;
        this.emit('chatsUpdate', updates);
      }

      if (events['chats.delete']) {
        const jids = events['chats.delete'] as string[];
        this.emit('chatsDelete', jids);
      }

      if (events['messaging-history.set']) {
        const data = events['messaging-history.set'] as unknown as {
          messages?: unknown[];
          chats?: Array<{ id: string; [key: string]: unknown }>;
          isLatest?: boolean;
        };
        this.log.info(
          { messageCount: data.messages?.length ?? 0, isLatest: data.isLatest },
          'history sync received',
        );
        if (data.messages && data.messages.length > 0) {
          this.emit('historyMessages', data.messages);
        }
        if (data.chats && data.chats.length > 0) {
          this.emit('chatsUpsert', data.chats);
        }
        this.emit('historySyncComplete');
      }
    });
  }

  // -------------------------------------------------------------------------
  // connection.update
  // -------------------------------------------------------------------------

  private handleConnectionUpdate(sock: WhatsAppSocket, update: any): void {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // QR code means auth state is missing — the auth CLI must be run separately
      this.log.warn('QR code received — run the auth CLI to pair this device');
      return;
    }

    if (connection === 'open') {
      this.reconnectAttempts = 0;
      this.reconnectPhase = 'backoff';
      this.firstFailureAt = null;
      if (this.cooldownTimer !== null) {
        clearTimeout(this.cooldownTimer);
        this.cooldownTimer = null;
      }
      // Extract the bot's own JID and LID from the socket/creds
      const user = (sock as any).user;
      const rawId: string | undefined = user?.id ?? (sock as any).authState?.creds?.me?.id;
      const rawLid: string | undefined = user?.lid ?? (sock as any).authState?.creds?.me?.lid;
      this.botJid = rawId ? jidNormalizedUser(rawId) : null;
      this.botLid = rawLid ? jidNormalizedUser(rawLid) : null;
      this.log.info({ botJid: this.botJid, botLid: this.botLid }, 'WhatsApp connected');
      return;
    }

    if (connection === 'close') {
      const statusCode: number | undefined = (lastDisconnect?.error as any)?.output?.statusCode;
      const reason = statusCode !== undefined ? (DisconnectReason[statusCode] ?? 'Unknown') : 'Unknown';

      this.log.warn({ statusCode, reason }, 'WhatsApp connection closed');

      // Invalidate the stale socket before deciding whether to reconnect
      try { sock.end(undefined); } catch { /* best-effort */ }
      this.sock = null;
      this.botJid = null;
      this.botLid = null;

      if (statusCode === DisconnectReason.loggedOut) {
        this.log.error('Logged out — re-authenticate with the auth CLI');
        // Do NOT reconnect; credentials are invalid
        return;
      }

      if (statusCode === DisconnectReason.restartRequired) {
        // Baileys signals a clean internal restart — reconnect immediately
        if (!this.shuttingDown) {
          void this.connect();
        }
        return;
      }

      if (!this.shuttingDown) {
        this.scheduleReconnect();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Reconnection with three-phase backoff
  // -------------------------------------------------------------------------

  private scheduleReconnect(): void {
    // Single-flight guard
    if (this.reconnectTimer !== null || this.cooldownTimer !== null) return;

    // Record the first failure time for max-duration tracking
    if (this.firstFailureAt === null) {
      this.firstFailureAt = Date.now();
    }

    // Check total elapsed since first failure
    const elapsedMs = Date.now() - this.firstFailureAt;
    if (elapsedMs > ConnectionManager.MAX_FAILURE_DURATION_MS) {
      this.log.fatal({ elapsedMs }, 'Connection failed for over 30 minutes — emitting exhausted');
      this.emit('exhausted');
      return;
    }

    if (this.reconnectPhase === 'backoff' || this.reconnectPhase === 'retry') {
      if (this.reconnectAttempts >= ConnectionManager.MAX_RECONNECT_ATTEMPTS) {
        // Enter cooldown phase
        this.log.info(
          { attempts: this.reconnectAttempts, phase: this.reconnectPhase },
          `Max attempts reached — entering ${ConnectionManager.COOLDOWN_MS / 1000}s cooldown`,
        );
        this.reconnectPhase = 'cooldown';
        this.cooldownTimer = setTimeout(() => {
          this.cooldownTimer = null;
          this.reconnectAttempts = 0;
          this.reconnectPhase = 'retry';
          void this.connect();
        }, ConnectionManager.COOLDOWN_MS);
        return;
      }

      this.reconnectAttempts += 1;
      const backoffMs = Math.min(
        ConnectionManager.BASE_BACKOFF_MS * Math.pow(2, this.reconnectAttempts - 1),
        ConnectionManager.MAX_BACKOFF_MS,
      );

      this.log.info(
        { attempt: this.reconnectAttempts, backoffMs, phase: this.reconnectPhase },
        'Scheduling reconnect',
      );

      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        void this.connect();
      }, backoffMs);
      return;
    }

    // reconnectPhase === 'cooldown' — already waiting, nothing to do
  }

  // -------------------------------------------------------------------------
  // messages.upsert
  // -------------------------------------------------------------------------

  private handleMessagesUpsert(data: any): void {
    const { messages, type } = data;
    // Only process real-time and appended messages, not full history syncs
    if (type !== 'notify' && type !== 'append') return;

    for (const msg of messages as WAMessage[]) {
      const parsed = parseIncomingMessage(msg);
      if (parsed) {
        // Build contacts directory from every incoming sender for @mention resolution
        this.contactsDir.observe(parsed.senderJid, parsed.senderName);

        if (this.onMessage) {
          try {
            this.onMessage(parsed);
          } catch (err) {
            this.log.warn({ err, messageId: parsed.messageId }, 'onMessage callback threw');
          }
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // messages.update — edits and deletions via protocol messages
  // -------------------------------------------------------------------------

  private handleMessagesUpdate(updates: any[]): void {
    for (const update of updates) {
      // Edited message: update.update.message contains editedMessage
      const editedMsg = update.update?.message?.editedMessage?.message;
      if (editedMsg) {
        const newContent =
          editedMsg.conversation ??
          editedMsg.extendedTextMessage?.text ??
          null;
        if (update.key?.id && newContent !== null) {
          this.emit('messageEdited', update.key.id as string, newContent as string);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // messages.delete
  // -------------------------------------------------------------------------

  private handleMessagesDelete(data: any): void {
    // data can be { keys: WAMessageKey[] } or { jid: string; all: true }
    if (data?.keys) {
      const ids: string[] = (data.keys as any[])
        .map((k: any) => k?.id)
        .filter(Boolean);
      if (ids.length > 0) {
        this.emit('messageDeleted', ids);
      }
    }
    if (data?.all && data?.jid) {
      // Clear-chat: mark all messages in this conversation as deleted
      this.emit('chatCleared', data.jid);
    }
  }

  // -------------------------------------------------------------------------
  // presence.update
  // -------------------------------------------------------------------------

  private handlePresenceUpdate(data: any): void {
    // data: { id: string; presences: Record<string, { lastKnownPresence: string; lastSeen?: number }> }
    const { id: chatJid, presences } = data;
    if (!presences) return;

    for (const [participantJid, presence] of Object.entries(presences as Record<string, any>)) {
      const status: string = presence.lastKnownPresence ?? 'unknown';
      const lastSeen: number | undefined = presence.lastSeen;

      this.presenceCache.update(participantJid, { status, lastSeen });
      this.emit('presenceUpdate', participantJid, status, lastSeen);

      void chatJid; // available for future use
    }
  }

  // -------------------------------------------------------------------------
  // call
  // -------------------------------------------------------------------------

  private handleCall(sock: WhatsAppSocket, calls: any[]): void {
    for (const call of calls) {
      const callId: string = call.id ?? '';
      const callFrom: string = call.from ?? '';

      if (this.autoRejectCalls && callId) {
        try {
          void (sock as any).rejectCall(callId, callFrom);
        } catch {
          // best-effort
        }
      }

      if (callId) {
        this.emit('callReceived', callId, callFrom);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Message parsing (module-private)
// ---------------------------------------------------------------------------

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

const MEDIA_CONTENT_TYPES = new Set(['image', 'video', 'audio', 'document', 'sticker']);

export function parseIncomingMessage(msg: WAMessage): IncomingMessage | null {
  if (!msg.message || !msg.key?.remoteJid) return null;

  // Early return for status broadcasts — don't store or process them
  if (msg.key.remoteJid === 'status@broadcast') return null;

  const innerMessage = unwrapMessage(msg.message);

  // --- Content extraction ---
  let content: string | null = null;
  let contentType = 'unknown';

  if (innerMessage.conversation) {
    content = innerMessage.conversation;
    contentType = 'text';
  } else if (innerMessage.extendedTextMessage?.text) {
    content = innerMessage.extendedTextMessage.text;
    contentType = 'text';
  } else if (innerMessage.imageMessage) {
    content = innerMessage.imageMessage.caption ?? null;
    contentType = 'image';
  } else if (innerMessage.videoMessage) {
    content = innerMessage.videoMessage.caption ?? null;
    contentType = 'video';
  } else if (innerMessage.documentMessage) {
    content = innerMessage.documentMessage.caption ?? innerMessage.documentMessage.fileName ?? null;
    contentType = 'document';
  } else if (innerMessage.audioMessage) {
    content = null;
    contentType = 'audio';
  } else if (innerMessage.stickerMessage) {
    content = null;
    contentType = 'sticker';
  } else if (innerMessage.locationMessage) {
    content = innerMessage.locationMessage.address ?? null;
    contentType = 'location';
  } else if (innerMessage.contactMessage) {
    content = innerMessage.contactMessage.displayName ?? null;
    contentType = 'contact';
  } else if (innerMessage.pollCreationMessage) {
    content = innerMessage.pollCreationMessage.name ?? null;
    contentType = 'poll';
  }

  // --- Timestamp ---
  const timestamp =
    msg.messageTimestamp != null ? Number(msg.messageTimestamp) : Math.floor(Date.now() / 1000);

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
  if (!senderName) {
    // Fall back to the phone-number portion of the JID
    senderName = senderJid.split('@')[0] ?? null;
  }

  // --- @mentioned JIDs ---
  // Mentions can live in contextInfo on various message types
  const mentionedJids: string[] =
    innerMessage.extendedTextMessage?.contextInfo?.mentionedJid ??
    (innerMessage as any).contextInfo?.mentionedJid ??
    msg.message?.extendedTextMessage?.contextInfo?.mentionedJid ??
    (msg.message as any)?.contextInfo?.mentionedJid ??
    [];

  // --- Quoted message ---
  // Prefer contextInfo from the unwrapped message, fall back to original
  const quotedMessageId: string | null =
    innerMessage.extendedTextMessage?.contextInfo?.stanzaId ??
    (msg.message?.extendedTextMessage?.contextInfo?.stanzaId) ??
    null;

  // --- isResponseWorthy ---
  const isStatusBroadcast = msg.key.remoteJid === 'status@broadcast';
  const isReaction = !!(innerMessage as any).reactionMessage;
  const isPollVote = !!(innerMessage as any).pollUpdateMessage;
  const isProtocol = !!(innerMessage as any).protocolMessage;
  // Media types are response-worthy even with null text content (we process them via media pipeline)
  const isMedia = MEDIA_CONTENT_TYPES.has(contentType);
  const hasNoContent = !isMedia && (content === null || (typeof content === 'string' && content.trim() === ''));

  const isResponseWorthy = !isStatusBroadcast && !isReaction && !isPollVote && !isProtocol && !hasNoContent;

  return {
    messageId: msg.key.id!,
    chatJid: msg.key.remoteJid!,
    senderJid,
    senderName,
    content,
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
