// src/transport/twilio/connection-bridge.ts
// TwilioConnection — bridges TwilioSmsAdapter to the RuntimeConnection surface
// consumed by main.ts and core infrastructure.
//
// DESIGN: Only members actually accessed by production consumers are implemented.
// Each member carries a one-line comment naming its consumer.
// Members that have no SMS equivalent reject or no-op with typed errors.

import { REQUIRES_WHATSAPP_DETAIL, UnsupportedTransportOperationError } from '../unsupported-operation.ts';
import { EventEmitter } from 'node:events';
import { createChildLogger } from '../../logger.ts';
import type { TransportAdapter } from '../contract/adapter.ts';
import type { InboundMessage as ContractInboundMessage } from '../contract/events.ts';
import type { RuntimeConnection } from '../runtime-connection.ts';
import type { IncomingMessage, OutboundMedia, SubmissionReceipt, TypingState } from '../../core/types.ts';
import { ContactsDirectory } from '../../core/mentions.ts';
import { PresenceCache } from '../presence-cache.ts';
import type { IdentityStore, GuardMode } from '../../core/outbound-identity/types.ts';
import { applyOutboundIdentityGuard } from '../../core/outbound-identity/guard.ts';
import type { WhatsAppSocket, ConnectionStateSnapshot } from '../connection.ts';
import { emptyConnectionStateSnapshot } from './connection-snapshot.ts';
import type { Subscription } from '../contract/subscription.ts';
import { toSmsJid, fromSmsJid } from '../../core/jid-constants.ts';
import type { TwilioWebhookServer } from './webhook-server.ts';
import type { TwilioSmsAdapter } from './adapter.ts';

/** Error thrown when an operation is not supported by the SMS transport. */
// #2202: the canonical error lives in transport/unsupported-operation.ts.
// Re-exported here so existing importers of this module keep working.
export { UnsupportedTransportOperationError };

/** Build the SMS-flavoured unsupported-operation error. */
function unsupported(operation: string): UnsupportedTransportOperationError {
  return new UnsupportedTransportOperationError('TwilioConnection', 'SMS', operation, REQUIRES_WHATSAPP_DETAIL);
}

// ---------------------------------------------------------------------------
// SMS JID scheme.
//
// Core conversation identity (toConversationKey in src/core/conversation-key.ts)
// requires JID-shaped ids (`local@domain`) and THROWS on raw E.164 strings —
// without this, every inbound SMS would be dropped at the ingest boundary.
// The bridge therefore synthesises `<address>@sms` ids inbound and strips the
// suffix symmetrically on the send path. The resulting conversation key is
// `<address>_at_sms` (toConversationKey's default-domain branch), a keyspace
// that cannot collide with WhatsApp (`@s.whatsapp.net`) keys for the same
// phone number.
//
// The helpers are canonical in src/core/jid-constants.ts (DOMAIN_SMS / JID_SMS).
// ---------------------------------------------------------------------------

/**
 * Maps a contract InboundMessage to the IncomingMessage shape consumed by
 * createIngestHandler (src/core/ingest.ts:138). Only fields that ingest
 * actually reads are populated:
 *   messageId, chatJid, senderJid, senderName, content, contentText,
 *   contentType, isFromMe, isGroup, mentionedJids, timestamp,
 *   quotedMessageId, isResponseWorthy
 * rawMessage is intentionally omitted (no Baileys proto for SMS).
 * chatJid/senderJid are `@sms`-suffixed (see SMS JID scheme above).
 */
function contractToIncoming(msg: ContractInboundMessage): IncomingMessage {
  const voiceAttachment = msg.attachments.find((a) => a.kind === 'voice');
  return {
    messageId: msg.ref.id,
    chatJid: toSmsJid(msg.conversation.id),
    senderJid: toSmsJid(msg.sender.id),
    senderName: null,
    content: msg.text,
    contentText: null,
    contentType: voiceAttachment !== undefined ? 'audio' : 'text',
    isFromMe: msg.fromMe,
    isGroup: false,
    mentionedJids: [],
    timestamp: Math.floor(msg.timestamp.getTime() / 1000),
    quotedMessageId: msg.inReplyTo?.id ?? null,
    // Mirrors message-parser's no-content guard: a null/blank-body record
    // (e.g. a future MMS-only inbound) must not trigger a response.
    isResponseWorthy: msg.text !== null && msg.text.trim().length > 0,
  };
}

/**
 * Bridges TwilioSmsAdapter to the RuntimeConnection surface that main.ts and
 * core infrastructure consume.
 *
 * The bridge is intentionally minimal: every member is either delegated to the
 * adapter, is a safe no-op, or rejects with a typed error. No Baileys-specific
 * behaviour is emulated.
 *
 * Consumers:
 *   - main.ts: connect/shutdown/botJid/botLid/onMessage/contactsDir/presenceCache
 *   - src/core/ingest.ts: onMessage callback (Messenger interface)
 *   - src/core/health.ts: botJid/presenceCache/getConnectionState
 *   - src/core/mark-read.ts: getSocket/botJid
 *   - src/core/scheduler.ts: sendRaw/sendMedia (will reject — SMS is text-only)
 *   - src/core/post-connect-recovery.ts: EventEmitter.once('historySyncComplete')
 *   - src/runtimes/chat/runtime.ts: sendMessage (Messenger interface)
 */
export class TwilioConnection extends EventEmitter implements RuntimeConnection {
  private readonly adapter: TwilioSmsAdapter;
  private readonly webhookServer: TwilioWebhookServer | null;
  private readonly log = createChildLogger('twilio-bridge');
  private messageSubscription: Subscription | null = null;
  private errorSubscription: Subscription | null = null;
  private boundPort: number | null = null;
  // NOTE: the adapter also emits 'state' events, but the bridge deliberately
  // does not subscribe — health reporting is pull-based via
  // getConnectionState() (health.ts polls), matching the Baileys path.

  // ── RuntimeConnection fields ──────────────────────────────────────────────

  /** Consumer: main.ts:337,492; health.ts:86,627; mark-read.ts:41 */
  botJid: string | null = null;

  /** Consumer: main.ts:338,493 — LIDs are WhatsApp-specific; always null for SMS */
  botLid: string | null = null;

  /** Consumer: main.ts:333 (createIngestHandler wires this); ingest.ts:138 */
  onMessage: ((msg: IncomingMessage) => void) | null = null;

  /** Consumer: main.ts:745/754/757; mcp/tools/messaging.ts (but MCP is chat-only) */
  readonly contactsDir = new ContactsDirectory();

  /** Consumer: health.ts:509 (read unconditionally) */
  readonly presenceCache = new PresenceCache();

  private identityStore: IdentityStore | null = null;
  private identityMode: GuardMode = 'log-only';

  setIdentityStore(store: IdentityStore, mode: GuardMode): void {
    this.identityStore = store;
    this.identityMode = mode;
  }

  constructor(adapter: TwilioSmsAdapter, webhookServer?: TwilioWebhookServer) {
    super();
    this.adapter = adapter;
    this.webhookServer = webhookServer ?? null;
  }

  /**
   * Returns the bound port of the webhook server after connect(), or null
   * when not in webhook mode. Used by tests and ops tooling.
   */
  getBoundPort(): number | null {
    return this.boundPort;
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
    this.botJid = toSmsJid(this.adapter.selfRef().id);

    // Start webhook server when configured (webhook inbound mode).
    if (this.webhookServer !== null) {
      this.boundPort = await this.webhookServer.start();
    }

    // Subscribe inbound messages and translate to IncomingMessage for ingest.
    // Dispose any previous subscription first so a double connect() cannot
    // deliver each message twice.
    this.messageSubscription?.dispose();
    this.messageSubscription = this.adapter.on('message', (msg: ContractInboundMessage) => {
      if (this.onMessage !== null) {
        this.onMessage(contractToIncoming(msg));
      }
    });

    // Surface background transport errors (poll failures, auth-stop) in the
    // logs — without this subscriber they are silent and an auth-parked poll
    // loop is only visible as health flipping to disconnected.
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
        `twilio transport error: ${err.message}`,
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
  // assignable, lets tests await deterministic teardown (port release), and
  // keeps main.ts's fire-and-forget call site unchanged.
  async shutdown(): Promise<void> {
    this.messageSubscription?.dispose();
    this.messageSubscription = null;
    this.errorSubscription?.dispose();
    this.errorSubscription = null;
    if (this.webhookServer !== null) {
      await this.webhookServer.stop();
    }
    await this.adapter.disconnect();
  }

  // ── Messenger implementation (src/core/types.ts:24-29) ───────────────────

  /**
   * Consumer: src/runtimes/chat/runtime.ts:424,447; src/core/ingest.ts (via Messenger)
   * Maps runtime chatJid + text to adapter ConversationRef + sendText.
   */
  async sendMessage(chatJid: string, text: string): Promise<SubmissionReceipt> {
    applyOutboundIdentityGuard(chatJid, { caller: 'agent', mode: this.identityMode }, this.identityStore);
    // Strip the synthetic @sms suffix — the adapter addresses raw E.164.
    const target = { channel: this.adapter.capabilities.channel, id: fromSmsJid(chatJid) };
    const ref = await this.adapter.sendText(target, text);
    return { waMessageId: ref.id };
  }

  /**
   * Consumer: src/runtimes/chat/runtime.ts (optional Messenger field); no-op.
   * setTyping is optional in the Messenger interface (src/core/types.ts:27).
   */
  async setTyping(_chatJid: string, _typing: TypingState): Promise<void> {
    // SMS does not support typing indicators — intentional no-op.
  }

  /**
   * Consumer: src/core/scheduler.ts:203 (media send path)
   * SMS capabilities.media.maxBytes === 0; reject so scheduler routes to retry/fail.
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
   * Always null — Baileys socket is not available on the SMS transport.
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
   * SMS transport does not support Baileys raw payloads — reject.
   */
  async sendRaw(_chatJid: string, _content: Record<string, unknown>): Promise<SubmissionReceipt> {
    return Promise.reject(
      unsupported('sendRaw'),
    );
  }

  /**
   * Consumer: src/mcp/tools/messaging.ts:589 (MCP only, agent/passive instances)
   * Poll messages are WhatsApp-specific — reject.
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
