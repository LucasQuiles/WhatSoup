// src/transport/imessage/connection-bridge.ts
// ImessageConnection — bridges ImessageAdapter to the RuntimeConnection
// surface consumed by main.ts and core infrastructure.
//
// DESIGN: mirrors twilio/connection-bridge.ts and signal/connection-bridge.ts.
// Only members actually accessed by production consumers are implemented.
// Members with no iMessage v1 equivalent reject with a typed error
// (sendRaw/sendMedia/sendPollMessage); typing indicators are DELEGATED
// (iMessage supports composing/stopped, unlike the SMS no-op).
//
// iMessage JID scheme: `<appleid|e164|chat-guid>@imessage`. The adapter
// addresses raw identifiers; the bridge adds/strips the synthetic suffix at
// the RuntimeConnection boundary, mirroring @sms/@signal.

import { REQUIRES_WHATSAPP_DETAIL, UnsupportedTransportOperationError } from '../unsupported-operation.ts';
import { EventEmitter } from 'node:events';
import { createChildLogger } from '../../logger.ts';
import type { InboundMessage as ContractInboundMessage } from '../contract/events.ts';
import type { RuntimeConnection } from '../runtime-connection.ts';
import type { IncomingMessage, OutboundMedia, SendOptions, SubmissionReceipt, TypingState } from '../../core/types.ts';
import { ContactsDirectory } from '../../core/mentions.ts';
import { PresenceCache } from '../presence-cache.ts';
import type { IdentityStore, GuardMode } from '../../core/outbound-identity/types.ts';
import { applyOutboundIdentityGuard } from '../../core/outbound-identity/guard.ts';
import type { WhatsAppSocket, ConnectionStateSnapshot } from '../connection.ts';
import { emptyConnectionStateSnapshot } from '../twilio/connection-snapshot.ts';
import type { Subscription } from '../contract/subscription.ts';
import { toImessageJid, fromImessageJid } from '../../core/jid-constants.ts';
import type { ImessageAdapter } from './adapter.ts';
import type { ImessagePort } from './port.ts';

/** Error thrown when an operation is not supported by the iMessage transport. */
// #2202: the canonical error lives in transport/unsupported-operation.ts.
// Re-exported here so existing importers of this module keep working.
export { UnsupportedTransportOperationError };

/** Build the iMessage-flavoured unsupported-operation error. */
function unsupported(operation: string): UnsupportedTransportOperationError {
  return new UnsupportedTransportOperationError('ImessageConnection', 'iMessage', operation, REQUIRES_WHATSAPP_DETAIL);
}

/**
 * Translate a contract InboundMessage to the runtime IncomingMessage shape.
 * isGroup is supplied by the caller (bridge) via adapter.isGroupConversation —
 * the contract envelope carries no group flag. rawMessage is omitted (no
 * Baileys proto for iMessage).
 */
function contractToIncoming(msg: ContractInboundMessage, isGroup: boolean): IncomingMessage {
  return {
    messageId: msg.ref.id,
    chatJid: toImessageJid(msg.conversation.id),
    senderJid: toImessageJid(msg.sender.id),
    senderName: null,
    content: msg.text,
    contentText: null,
    contentType: 'text',
    isFromMe: msg.fromMe,
    isGroup,
    mentionedJids: [],
    timestamp: Math.floor(msg.timestamp.getTime() / 1000),
    quotedMessageId: msg.inReplyTo?.id ?? null,
    // Mirrors message-parser's no-content guard: null/blank-body records
    // (reactions, receipts) must not trigger a response.
    isResponseWorthy: msg.text !== null && msg.text.trim().length > 0,
  };
}

/**
 * Bridges ImessageAdapter to the RuntimeConnection surface that main.ts and
 * core infrastructure consume.
 *
 * Consumers:
 *   - main.ts: connect/shutdown/botJid/botLid/onMessage/contactsDir/presenceCache
 *   - src/core/ingest.ts: onMessage callback (Messenger interface)
 *   - src/core/health.ts: botJid/presenceCache/getConnectionState
 *   - src/core/mark-read.ts: getSocket/botJid
 *   - src/core/scheduler.ts: sendRaw/sendMedia (will reject — iMessage v1 is text-only)
 *   - src/core/post-connect-recovery.ts: EventEmitter.once('historySyncComplete')
 *   - src/runtimes/chat/runtime.ts: sendMessage/setTyping (Messenger interface)
 */
export class ImessageConnection extends EventEmitter implements RuntimeConnection {
  private readonly adapter: ImessageAdapter;
  private readonly port: ImessagePort | null;
  private readonly log = createChildLogger('imessage-bridge');
  private messageSubscription: Subscription | null = null;
  private errorSubscription: Subscription | null = null;
  // NOTE: the adapter also emits 'state' events, but the bridge deliberately
  // does not subscribe — health reporting is pull-based via
  // getConnectionState() (health.ts polls), matching the Baileys/Twilio paths.

  // ── RuntimeConnection fields ──────────────────────────────────────────────

  /** Consumer: main.ts:337,492; health.ts:86,627; mark-read.ts:41 */
  botJid: string | null = null;

  /** Consumer: main.ts:338,493 — LIDs are WhatsApp-specific; always null */
  botLid: string | null = null;

  /** Consumer: main.ts:333 (createIngestHandler wires this); ingest.ts:138 */
  onMessage: ((msg: IncomingMessage) => void) | null = null;

  /** Consumer: main.ts:745/754/757 */
  readonly contactsDir = new ContactsDirectory();

  /** Consumer: health.ts:509 (read unconditionally) */
  readonly presenceCache = new PresenceCache();

  private identityStore: IdentityStore | null = null;
  private identityMode: GuardMode = 'log-only';

  setIdentityStore(store: IdentityStore, mode: GuardMode): void {
    this.identityStore = store;
    this.identityMode = mode;
  }

  constructor(adapter: ImessageAdapter, port?: ImessagePort) {
    super();
    this.adapter = adapter;
    this.port = port ?? null;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Consumer: main.ts:765 (await connectionManager.connect())
   * Sets botJid from adapter.selfRef(), subscribes to inbound messages,
   * then emits 'historySyncComplete' so post-connect-recovery doesn't stall.
   */
  async connect(): Promise<void> {
    await this.adapter.connect();

    // Set sender identity from adapter after connect (JID-shaped for any
    // consumer that derives a conversation key from it).
    this.botJid = toImessageJid(this.adapter.selfRef().id);

    // Subscribe inbound messages and translate to IncomingMessage for ingest.
    // Dispose any previous subscription first so a double connect() cannot
    // deliver each message twice.
    this.messageSubscription?.dispose();
    this.messageSubscription = this.adapter.on('message', (msg: ContractInboundMessage) => {
      if (this.onMessage !== null) {
        this.onMessage(contractToIncoming(msg, this.adapter.isGroupConversation(msg.conversation)));
      }
    });

    // Surface background transport errors (poll failures, auth-stop) in the
    // logs — without this subscriber an auth-parked poll loop is only visible
    // as health flipping to disconnected.
    this.errorSubscription?.dispose();
    this.errorSubscription = this.adapter.on('error', (err) => {
      const p = err.payload;
      this.log.error(
        {
          code: p.code,
          operation: p.operation,
          correlationId: p.correlationId,
          retryable: p.retryable,
          providerCode: p.providerCode,
          channelId: p.channelId,
          hint: p.hint,
          scope: p.scope,
          phase: p.phase,
          idempotencyKey: p.idempotencyKey,
        },
        `imessage transport error: ${err.message}`,
      );
    });

    // Emit historySyncComplete so waitForHistorySyncThenRecover doesn't wait
    // the full 15s timeout (src/core/post-connect-recovery.ts:20-23).
    // Deferred via setImmediate: main.ts registers its once-listener in the
    // microtask continuation right after connect() resolves — a synchronous
    // emit here would fire before that listener exists and the race would
    // burn the whole timeout.
    setImmediate(() => this.emit('historySyncComplete'));
  }

  /**
   * Consumer: main.ts:850 (connectionManager.shutdown())
   */
  // RuntimeConnection declares shutdown(): void; returning a promise is
  // assignable, lets tests await deterministic teardown, and keeps main.ts's
  // fire-and-forget call site unchanged.
  async shutdown(): Promise<void> {
    this.messageSubscription?.dispose();
    this.messageSubscription = null;
    this.errorSubscription?.dispose();
    this.errorSubscription = null;
    // #2322 H2: the port (e.g. ImsgPort's persistent UNIX socket) is a
    // separate resource from adapter-internal lifecycle state and must be
    // disposed independently, mirroring signal/connection-bridge.ts:158.
    // Optional: BlueBubbles is stateless HTTP and implements no dispose().
    this.port?.dispose?.();
    await this.adapter.disconnect();
  }

  // ── Messenger implementation (src/core/types.ts:42-52) ───────────────────

  /**
   * Consumer: src/runtimes/chat/runtime.ts:424,447; src/core/ingest.ts (via Messenger)
   * Maps runtime chatJid + text to adapter ConversationRef + sendText.
   */
  async sendMessage(chatJid: string, text: string, opts?: SendOptions): Promise<SubmissionReceipt> {
    applyOutboundIdentityGuard(chatJid, { caller: opts?.caller ?? 'agent', mode: this.identityMode }, this.identityStore);
    // Strip the synthetic @imessage suffix — the adapter addresses raw ids.
    const target = { channel: this.adapter.capabilities.channel, id: fromImessageJid(chatJid) };
    const ref = await this.adapter.sendText(target, text);
    return { waMessageId: ref.id };
  }

  /**
   * Consumer: src/runtimes/chat/runtime.ts (optional Messenger field).
   * iMessage supports composing/stopped typing indicators — unlike the SMS
   * bridge's no-op, this delegates to the adapter's SupportsTyping mix-in.
   * 'recording' has no iMessage equivalent and maps to 'composing'.
   */
  async setTyping(chatJid: string, typing: TypingState): Promise<void> {
    const target = { channel: this.adapter.capabilities.channel, id: fromImessageJid(chatJid) };
    const composing = typing !== 'paused' && typing !== false;
    await this.adapter.setTyping(target, composing);
  }

  /**
   * Consumer: src/core/scheduler.ts:203 (media send path)
   * iMessage capabilities.media.maxBytes === 0 in v1; reject so scheduler
   * routes to retry/fail. Media lands in a follow-on phase.
   */
  async sendMedia(_chatJid: string, _media: OutboundMedia): Promise<SubmissionReceipt> {
    return Promise.reject(
      unsupported('sendMedia'),
    );
  }

  // ── RuntimeConnection extended surface ───────────────────────────────────

  /**
   * Consumer: src/core/mark-read.ts:31 (null-checked: `if (lastMsg && sock)`);
   *           src/runtimes/agent/runtime.ts:3904 (null-checked)
   * Always null — Baileys socket is not available on the iMessage transport.
   */
  getSocket(): WhatsAppSocket | null {
    return null;
  }

  /** Synthesises the mandatory ConnectionStateSnapshot from adapter.state(). */
  getConnectionState(): ConnectionStateSnapshot {
    const health = this.adapter.state();
    const connected = health.state === 'connected';
    return emptyConnectionStateSnapshot({
      connected,
      stateChangedAt: health.since.toISOString(),
      lastDisconnectReason: health.reasonCode ?? null,
    });
  }

  /**
   * Consumer: src/core/scheduler.ts:178 (text send path in scheduler)
   * iMessage transport does not accept Baileys raw payloads — reject.
   */
  async sendRaw(_chatJid: string, _content: Record<string, unknown>): Promise<SubmissionReceipt> {
    return Promise.reject(
      unsupported('sendRaw'),
    );
  }

  /**
   * Consumer: src/mcp/tools/messaging.ts:589 (MCP only, agent/passive instances)
   * iMessage has no poll feature in the WhatSoup v1 surface — reject.
   */
  async sendPollMessage(
    _chatJid: string,
    _name: string,
    _values: string[],
    _selectableCount: number,
  ): Promise<{ waMessageId: string | null; hasSecret: boolean }> {
    return Promise.reject(
      unsupported('sendPollMessage'),
    );
  }
}
