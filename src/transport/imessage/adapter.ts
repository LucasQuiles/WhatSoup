// src/transport/imessage/adapter.ts
// ImessageAdapter — implements TransportAdapter + SupportsReactions,
// SupportsTyping, SupportsReadReceipts against the ImessagePort interface.
//
// Shape mirrors SignalAdapter so the two transports share a common
// operational pattern. Differences:
//
//   - Recipient identity accepts BOTH AppleID email and E.164 phone.
//   - Message id is a provider GUID (string), not a parsed timestamp.
//   - Reaction targeting needs both targetGuid AND conversation (iMessage
//     tapback protocol).
//   - No SupportsDelete in v1: iMessage has no remote-delete protocol; once
//     delivered, the recipient controls deletion. The adapter does not
//     declare the 'delete' extension.
//
// Both backends (imsg RPC relay + BlueBubbles HTTP) implement ImessagePort;
// the adapter is backend-agnostic. Backend selection happens at factory time.

import {
  canonicalizeImessageDirectIdentity,
  isImessageGroupAddress,
  makeChannelId,
  type ChannelId,
  type ConversationRef,
  type MessageRef,
  type ParticipantRef,
} from '../../core/transport-refs.ts';
import type {
  AdapterHealth,
  Capabilities,
  ExtensionName,
  InboundMessage,
  SendTextOptions,
  Subscription,
  TransportAdapter,
  TransportError,
} from '../contract/index.ts';
import { makeSubscription } from '../contract/subscription.ts';
import {
  AuthRequiredError,
  ConversationNotFoundError,
  PayloadTooLargeError,
  PermanentProviderError,
  RateLimitedError,
  SendAmbiguousError,
  TransientProviderError,
} from '../contract/errors.ts';
import type {
  DeleteEvent,
  ReadEvent,
  ReactionEvent,
} from '../contract/events.ts';
import type { SupportsReactions, SupportsTyping, SupportsReadReceipts } from '../contract/extensions.ts';
import { APPLEID_EMAIL_RE, E164_RE, type ImessageConfig } from './types.ts';
import type { ImessagePort, ImessagePortError, InboundImessage } from './port.ts';

// ---------------------------------------------------------------------------
// Listener registry
// ---------------------------------------------------------------------------
interface Listeners {
  message: Set<(e: InboundMessage) => void>;
  state: Set<(e: AdapterHealth) => void>;
  error: Set<(e: TransportError) => void>;
  reaction: Set<(e: ReactionEvent) => void>;
  read: Set<(e: ReadEvent) => void>;
  delete: Set<(e: DeleteEvent) => void>;
}

// ---------------------------------------------------------------------------
// Port-error shape (duck-typed — never import the backend client)
// ---------------------------------------------------------------------------
interface PortErrorLike {
  message: string;
  status?: number;
  code?: string;
  phase?: 'not_started' | 'provider_call_started' | 'ack_received';
}

// BlueBubbles returns 401 on bad password; imsg surfaces 'UnlinkedAccount' or
// 'NoSignedInAccount' on a daemon without an active iMessage session.
function isImessageAuth(err: PortErrorLike): boolean {
  return err.status === 401
    || err.code === 'Unauthorized'
    || err.code === 'UnlinkedAccount'
    || err.code === 'NoSignedInAccount';
}

// BlueBubbles returns 429 under burst; imsg surfaces 'QueueFull' when the
// local send queue is saturated.
function isImessageRateLimit(err: PortErrorLike): boolean {
  if (err.status === 429) return true;
  if (err.code === 'QueueFull' || err.code === 'TooManyRequests') return true;
  return typeof err.message === 'string' && /rate limit|too many requests/i.test(err.message);
}

// Transient: 5xx from BlueBubbles, or no-status-no-code network failure
// (daemon unreachable, socket closed, HTTP timeout).
function isImessageTransient(err: PortErrorLike): boolean {
  if (err.status === 501 || err.code === 'UnsupportedMethod') return false;
  if (typeof err.status === 'number' && err.status >= 500) return true;
  if (err.code === 'InternalServerError' || err.code === 'TimeoutError') return true;
  return err.status === undefined && err.code === undefined;
}

// ---------------------------------------------------------------------------
// mapPortError
// ---------------------------------------------------------------------------
function mapPortError(
  err: unknown,
  channelId: ChannelId,
  operation: string,
  correlationId: string,
  scope: 'request' | 'channel',
): TransportError {
  const pe = err as PortErrorLike;
  const base = {
    channelId,
    operation,
    correlationId,
    scope,
    phase: pe?.phase ?? 'provider_call_started' as const,
  };
  const msg = (typeof pe?.message === 'string' && pe.message) ? pe.message : String(err);

  if (pe.code === 'SendAcceptedWithoutId' || pe.code === 'RequestAbortedAfterWrite') {
    return new SendAmbiguousError({
      ...base,
      message: `iMessage send outcome is ambiguous: ${msg}`,
      providerCode: pe.code,
      phase: pe.phase ?? (pe.code === 'SendAcceptedWithoutId' ? 'ack_received' : 'provider_call_started'),
    });
  }

  if (isImessageAuth(pe)) {
    return new AuthRequiredError({ ...base, message: `iMessage auth error: ${msg}`, providerCode: String(pe.code ?? pe.status ?? '') });
  }
  if (isImessageRateLimit(pe)) {
    return new RateLimitedError({ ...base, message: `iMessage rate limit: ${msg}`, providerCode: String(pe.code ?? pe.status ?? '') });
  }
  if (isImessageTransient(pe)) {
    return new TransientProviderError({ ...base, message: `iMessage transient error: ${msg}`, providerCode: String(pe.code ?? pe.status ?? '') });
  }
  return new PermanentProviderError({ ...base, message: `iMessage provider error: ${msg}`, providerCode: String(pe.code ?? pe.status ?? '') });
}

// ---------------------------------------------------------------------------
// Dedupe-set capacity. Mirrors the Signal/Twilio 1000-entry cap. iMessage
// envelopes dedupe on GUID (string), unique per message across both backends.
// ---------------------------------------------------------------------------
const INBOUND_PAGE_SIZE = 500;
const MAX_INBOUND_PAGES_PER_POLL = 10;
const DEDUPE_CAP = INBOUND_PAGE_SIZE * MAX_INBOUND_PAGES_PER_POLL;

function trimSeenSet(seen: Set<string>): void {
  for (const oldest of seen) {
    if (seen.size <= DEDUPE_CAP) break;
    seen.delete(oldest);
  }
}

/**
 * Bound the read-receipt dedup set to the same cap as `seen`. Only outbound
 * message guids enter this set, so it grows more slowly than `seen`, but it
 * still needs a cap to prevent unbounded growth across a long-running session.
 */
function trimReadReceiptSet(reads: Set<string>): void {
  for (const oldest of reads) {
    if (reads.size <= DEDUPE_CAP) break;
    reads.delete(oldest);
  }
}

// iMessage itself has no hard text cap, but BlueBubbles Server chunks at
// ~64 KiB and imsg's framework bridge truncates above 64 KiB. Match Signal's
// 64 KiB ceiling for cross-transport uniformity.
const IMESSAGE_MAX_TEXT = 65_535;

/**
 * ImessageAdapter — iMessage transport via imsg RPC or BlueBubbles Server.
 *
 * Implements:
 * - TransportAdapter (lifecycle + sendText + on(message|state|error))
 * - SupportsReactions (react/unreact/on('reaction'))
 * - SupportsTyping (setTyping)
 * - SupportsReadReceipts (markRead/on('read'))
 *
 * Does NOT implement SupportsDelete in v1: iMessage has no remote-delete
 * protocol (the recipient controls deletion once delivered), so the adapter
 * does not declare the 'delete' extension. This is the documented v1 parity
 * gap, not an oversight.
 *
 * The adapter is constructed with an {@link ImessagePort} implementation;
 * the factory selects the backend (imsg relay socket port or BlueBubbles
 * HTTP port) based on imessageConfig.backend.
 */
export class ImessageAdapter
  implements TransportAdapter, SupportsReactions, SupportsTyping, SupportsReadReceipts
{
  readonly capabilities: Capabilities;

  private health: AdapterHealth = { state: 'disconnected', since: new Date() };
  private readonly listeners: Listeners = {
    message: new Set(),
    state: new Set(),
    error: new Set(),
    reaction: new Set(),
    read: new Set(),
    delete: new Set(),
  };

  public readonly channelId: ChannelId;
  private readonly self: ParticipantRef;
  private readonly port: ImessagePort;
  private readonly sender: string;
  private readonly pollIntervalMs: number;
  private readonly inboundMode: string;

  private ingestSeq = 0;
  private seq = 0;

  private lastPolledAt: Date = new Date(0);
  private readonly seen: Set<string> = new Set();
  /**
   * Wall-clock time this connection was established. Used by the read-receipt
   * restart-dedup filter: a `dateRead` older than this value was set before
   * this session and is suppressed to avoid replaying reads from a prior run.
   * Unlike `lastPolledAt` (which advances as polls succeed), this is frozen
   * at connect time so mid-session reads always pass the filter.
   */
  private sessionStartedAt: Date = new Date(0);
  /**
   * Outbound-message guids for which a ReadEvent has already been emitted
   * this session. Prevents double-emission of the same read transition if
   * the same record appears in successive poll pages.
   */
  private readonly emittedReadReceipts: Set<string> = new Set();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private cursorInitialized = false;
  private inboundCursor: string | null = null;
  private inboundMaxTimestamp: number | null = null;
  private lifecycleGeneration = 0;
  private pollingGeneration: number | null = null;

  constructor(config: ImessageConfig, port: ImessagePort) {
    // Validation upstream enforces sender presence; direct construction can
    // bypass it — fail loud rather than run with empty selfRef.
    if (!config.sender || (typeof config.sender !== 'string') || config.sender.length === 0) {
      throw new Error(
        `ImessageAdapter requires a non-empty sender (got ${JSON.stringify(config.sender)})`,
      );
    }
    // Sender must be either an AppleID email or E.164 phone.
    if (!APPLEID_EMAIL_RE.test(config.sender) && !E164_RE.test(config.sender)) {
      throw new Error(
        `ImessageAdapter sender must be an AppleID email or E.164 phone (got ${JSON.stringify(config.sender)})`,
      );
    }
    if (config.inboundMode !== 'poll') {
      throw new Error('ImessageAdapter supports only poll inbound mode; webhook inbound is not implemented');
    }

    this.channelId = makeChannelId('imessage', config.account);
    this.port = port;
    this.sender = config.sender;
    this.pollIntervalMs = config.pollIntervalMs;
    this.inboundMode = config.inboundMode;

    const extensions: ReadonlySet<ExtensionName> = config.backend === 'bluebubbles'
      ? new Set<ExtensionName>(['reactions', 'typing', 'read-receipts'])
      : new Set<ExtensionName>();

    this.capabilities = {
      channel: this.channelId,
      kind: 'imessage',
      extensions,
      maxTextLength: IMESSAGE_MAX_TEXT,
      auth: 'token',                  // capability enum has no local-process-trust variant
      readReceipts: config.backend === 'bluebubbles' ? 'conversation' : 'none',
      reactions: config.backend === 'bluebubbles' ? 'single' : 'none',
      media: { maxBytes: 0, mimeAllowlist: [] },  // media deferred to v2
      idempotency: {
        sendText: 'none',
        sendMedia: 'none',
        react: 'none',
        editText: 'none',
        delete: 'none',
      },
    };

    this.self = { channel: this.channelId, id: this.sender };
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    const generation = ++this.lifecycleGeneration;
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.disposed = false;
    this.transitionTo({ state: 'starting', since: new Date() });
    try {
      await this.port.verifyCredentials();
    } catch (err) {
      if (generation === this.lifecycleGeneration) {
        this.transitionTo({ state: 'disconnected', since: new Date() });
      }
      throw mapPortError(err, this.channelId, 'connect', this.nextCorrelationId(), 'channel');
    }
    if (generation !== this.lifecycleGeneration || this.disposed) return;
    if (!this.cursorInitialized && this.inboundMode === 'poll' && this.pollIntervalMs > 0) {
      this.lastPolledAt = new Date(Date.now() - this.pollIntervalMs);
    }
    this.sessionStartedAt = new Date();
    this.cursorInitialized = true;
    this.transitionTo({ state: 'connected', since: new Date() });

    if (this.inboundMode === 'poll' && this.pollIntervalMs > 0) {
      this.pollTimer = setInterval(() => {
        void this.pollOnce();
      }, this.pollIntervalMs);
    }
  }

  async disconnect(): Promise<void> {
    this.lifecycleGeneration += 1;
    this.disposed = true;
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.port.resetConnection?.();
    this.transitionTo({ state: 'disconnected', since: new Date() });
  }

  state(): AdapterHealth {
    return this.health;
  }

  selfRef(): ParticipantRef {
    return this.self;
  }

  /**
   * True iff a conversation ref addresses an iMessage GROUP chat (chat GUID
   * with the `iMessage;+;` form; DMs use `iMessage;-;`). Used by the
   * connection bridge to set IncomingMessage.isGroup — the contract
   * envelope carries no group flag.
   */
  isGroupConversation(ref: ConversationRef): boolean {
    return ref.channel === this.channelId && isImessageGroupAddress(ref.id);
  }

  // ── Send ─────────────────────────────────────────────────────────────────

  async sendText(
    target: ConversationRef,
    text: string,
    opts?: SendTextOptions,
  ): Promise<MessageRef> {
    const correlationId = opts?.correlationId ?? this.nextCorrelationId();

    if (target.channel !== this.channelId) {
      throw new ConversationNotFoundError({
        channelId: this.channelId,
        operation: 'sendText',
        correlationId,
        scope: 'conversation',
        message: `target channel ${target.channel} does not match adapter channel ${this.channelId}`,
      });
    }

    // Recipient must be AppleID email, E.164 phone, or a chat GUID
    // (`iMessage;-;chatXXXX`). The first two are the common case; chat GUID
    // group sends pass through verbatim.
    if (!isImessageRecipient(target.id)) {
      throw new ConversationNotFoundError({
        channelId: this.channelId,
        operation: 'sendText',
        correlationId,
        scope: 'conversation',
        message: `target id is not a valid iMessage recipient (AppleID email, E.164 phone, or chat GUID)`,
      });
    }

    if (text.length === 0 || text.length > this.capabilities.maxTextLength) {
      throw new PayloadTooLargeError({
        channelId: this.channelId,
        operation: 'sendText',
        correlationId,
        scope: 'request',
        message: text.length === 0
          ? 'sendText requires non-empty text'
          : `text length ${text.length} exceeds maxTextLength ${this.capabilities.maxTextLength}`,
      });
    }

    let guid: string;
    try {
      const result = await this.port.send({ recipient: target.id, body: text });
      guid = result.guid;
    } catch (err) {
      throw mapPortError(err, this.channelId, 'sendText', correlationId, 'request');
    }

    return {
      channel: this.channelId,
      conversation: target.id,
      id: guid,
    };
  }

  // ── SupportsReactions ────────────────────────────────────────────────────

  async react(target: MessageRef, emoji: string): Promise<void> {
    await this.sendReactionInternal(target, emoji, false);
  }

  async unreact(target: MessageRef, emoji: string): Promise<void> {
    await this.sendReactionInternal(target, emoji, true);
  }

  private async sendReactionInternal(target: MessageRef, emoji: string, remove: boolean): Promise<void> {
    const correlationId = this.nextCorrelationId();
    if (target.channel !== this.channelId) {
      throw new ConversationNotFoundError({
        channelId: this.channelId,
        operation: 'react',
        correlationId,
        scope: 'conversation',
        message: `target channel ${target.channel} does not match adapter channel ${this.channelId}`,
      });
    }
    try {
      await this.port.sendReaction({
        targetGuid: target.id,
        conversation: target.conversation,
        emoji,
        remove,
      });
    } catch (err) {
      throw mapPortError(err, this.channelId, 'react', correlationId, 'request');
    }
  }

  // ── SupportsTyping ────────────────────────────────────────────────────────

  async setTyping(target: ConversationRef, on: boolean): Promise<void> {
    const correlationId = this.nextCorrelationId();
    if (target.channel !== this.channelId) {
      throw new ConversationNotFoundError({
        channelId: this.channelId,
        operation: 'setTyping',
        correlationId,
        scope: 'conversation',
        message: `target channel ${target.channel} does not match adapter channel ${this.channelId}`,
      });
    }
    if (!isImessageRecipient(target.id)) {
      throw new ConversationNotFoundError({
        channelId: this.channelId,
        operation: 'setTyping',
        correlationId,
        scope: 'conversation',
        message: `target id is not a valid iMessage recipient`,
      });
    }
    try {
      await this.port.sendTypingIndicator({ conversation: target.id, composing: on });
    } catch (err) {
      throw mapPortError(err, this.channelId, 'setTyping', correlationId, 'request');
    }
  }

  // ── SupportsReadReceipts ──────────────────────────────────────────────────

  async markRead(target: MessageRef): Promise<void> {
    const correlationId = this.nextCorrelationId();
    if (target.channel !== this.channelId) {
      throw new ConversationNotFoundError({
        channelId: this.channelId,
        operation: 'markRead',
        correlationId,
        scope: 'conversation',
        message: `target channel ${target.channel} does not match adapter channel ${this.channelId}`,
      });
    }
    try {
      await this.port.sendReadReceipts({
        conversation: target.conversation,
        guids: [target.id],
      });
    } catch (err) {
      throw mapPortError(err, this.channelId, 'markRead', correlationId, 'request');
    }
  }

  // ── Events ───────────────────────────────────────────────────────────────

  on(event: 'message', handler: (e: InboundMessage) => void): Subscription;
  on(event: 'state', handler: (e: AdapterHealth) => void): Subscription;
  on(event: 'error', handler: (e: TransportError) => void): Subscription;
  on(event: 'reaction', handler: (e: ReactionEvent) => void): Subscription;
  on(event: 'read', handler: (e: ReadEvent) => void): Subscription;
  on(event: 'delete', handler: (e: DeleteEvent) => void): Subscription;
  on(event: 'message' | 'state' | 'error' | 'reaction' | 'read' | 'delete', handler: (e: never) => void): Subscription {
    const set = this.listeners[event] as Set<(e: never) => void>;
    set.add(handler);
    return makeSubscription(() => set.delete(handler));
  }

  // ── Poll loop ────────────────────────────────────────────────────────────

  async pollOnce(): Promise<void> {
    if (this.disposed) return;
    if (this.health.state !== 'connected') return;
    const generation = this.lifecycleGeneration;
    if (this.pollingGeneration === generation) return;
    this.pollingGeneration = generation;
    try {
      await this.pollOnceInner(generation);
    } finally {
      if (this.pollingGeneration === generation) {
        this.pollingGeneration = null;
      }
    }
  }

  private async pollOnceInner(generation: number): Promise<void> {
    for (let page = 0; page < MAX_INBOUND_PAGES_PER_POLL; page += 1) {
      if (this.disposed || generation !== this.lifecycleGeneration) return;
      let records: readonly InboundImessage[];
      let cursor: string;
      let hasMore: boolean;
      const requestedCursor = this.inboundCursor;
      try {
        const inboundPage = await this.port.listInboundSince(
          this.lastPolledAt,
          INBOUND_PAGE_SIZE,
          requestedCursor,
        );
        records = inboundPage.records;
        cursor = inboundPage.cursor;
        hasMore = inboundPage.hasMore;
        if (cursor.length === 0 || (hasMore && cursor === requestedCursor)) {
          throw {
            message: 'iMessage provider returned a non-advancing inbound cursor',
            code: 'MalformedResponse',
            status: 502,
          } satisfies ImessagePortError;
        }
      } catch (err) {
        if (this.disposed || generation !== this.lifecycleGeneration) return;
        const mapped = mapPortError(err, this.channelId, 'pollInbound', this.nextCorrelationId(), 'channel');
        this.safeEmit(this.listeners.error, mapped);
        if (mapped instanceof AuthRequiredError) {
          if (this.pollTimer !== null) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
          }
          this.transitionTo({ state: 'auth_required', since: new Date(), reasonCode: 'poll-auth-failure' });
        }
        return;
      }

      if (this.disposed || generation !== this.lifecycleGeneration) return;

      for (const record of records) {
        try {
          if (this.inboundMaxTimestamp === null || record.timestamp > this.inboundMaxTimestamp) {
            this.inboundMaxTimestamp = record.timestamp;
          }
          this.handleInboundRecord(record);
        } catch (err) {
          // A malformed provider record must not crash the poll loop or the
          // process (#2289 M2). Log and continue with the next record.
          this.safeEmit(this.listeners.error, new TransientProviderError({
            channelId: this.channelId,
            operation: 'pollInbound:handleRecord',
            correlationId: this.nextCorrelationId(),
            message: `malformed inbound record: ${err instanceof Error ? err.message : String(err)}`,
            scope: 'channel',
            phase: 'provider_call_started',
          }));
        }
        if (this.disposed || generation !== this.lifecycleGeneration) return;
      }
      this.inboundCursor = cursor;

      if (hasMore) {
        continue;
      }

      if (this.inboundMaxTimestamp !== null) {
        this.lastPolledAt = new Date(this.inboundMaxTimestamp);
        this.inboundMaxTimestamp = null;
      }
      return;
    }

    this.safeEmit(this.listeners.error, new TransientProviderError({
      channelId: this.channelId,
      operation: 'pollInbound',
      correlationId: this.nextCorrelationId(),
      scope: 'channel',
      providerCode: 'InboundPageLimit',
      message: `iMessage inbound scan paused after ${MAX_INBOUND_PAGES_PER_POLL * INBOUND_PAGE_SIZE} raw records; provider cursor retained`,
    }));
  }

  // ── Shared inbound pipeline ───────────────────────────────────────────────

  handleInboundRecord(record: InboundImessage): boolean {
    if (this.disposed || this.health.state !== 'connected') return false;

    // Read receipts ride on the `dateRead` field of outbound messages
    // (fromMe === true). Check before the `seen` dedup so a read transition
    // is detected even if the record was already processed for text.
    if (record.fromMe && typeof record.dateRead === 'number' && record.dateRead > 0) {
      this.maybeEmitReadReceipt(record);
    }

    if (
      record.kind === 'reaction'
      && (
        typeof record.reactionTargetGuid !== 'string'
        || record.reactionTargetGuid === ''
        || typeof record.reactionEmoji !== 'string'
        || record.reactionEmoji === ''
        || typeof record.reactionRemove !== 'boolean'
      )
    ) {
      return false;
    }
    if (this.seen.has(record.guid)) return false;

    // Both branches mark `seen` only after the record has been accepted. A
    // record rejected here stays retryable on the next poll instead of being
    // swallowed permanently by the dedup set — the property this branch adds.
    // Reaction validation already ran above, before the `seen` check, so an
    // invalid tapback is likewise never marked.
    if (record.kind === 'text' && record.body !== null) {
      const message = this.buildInboundMessage(record);
      if (message === null) return false;

      this.seen.add(record.guid);
      trimSeenSet(this.seen);
      this.safeEmit(this.listeners.message, message);
    } else if (record.kind === 'reaction' && record.reactionTargetGuid !== undefined) {
      this.seen.add(record.guid);
      trimSeenSet(this.seen);
      this.emitReactionEvent(record);
    } else {
      return false;
    }

    return true;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private buildInboundMessage(record: InboundImessage): InboundMessage | null {
    const channelId = this.channelId;
    // Group envelopes thread under the chat GUID (all members' traffic shares
    // one conversation). 1:1 envelopes key on the PEER: sender for inbound,
    // recipient for our own outbound echoes.
    const rawPeer = record.chatGuid ?? (record.fromMe ? record.to : record.from);
    const peer = record.chatGuid !== undefined
      ? (isImessageGroupAddress(rawPeer) || rawPeer.startsWith('iMessage;-;') ? rawPeer : null)
      : canonicalizeImessageDirectIdentity(rawPeer);
    const senderId = canonicalizeImessageDirectIdentity(
      record.fromMe ? this.selfRef().id : record.from,
    );
    if (peer === null || senderId === null) return null;
    const ts = new Date(record.timestamp);
    return {
      ref: {
        channel: channelId,
        conversation: peer,
        id: record.guid,
      },
      conversation: {
        channel: channelId,
        id: peer,
      },
      sender: {
        channel: channelId,
        id: senderId,
      },
      fromMe: record.fromMe,
      text: record.body,
      attachments: [],
      timestamp: ts,
      inboundEventKey: record.guid,
      transportTimestamp: ts,
      ingestSeq: ++this.ingestSeq,
    };
  }

  private nextCorrelationId(): string {
    return 'imessage-' + String(++this.seq).padStart(6, '0');
  }

  /**
   * Project an inbound tapback reaction record onto the contract
   * {@link ReactionEvent}. The reaction's `target` references the reacted-to
   * message; `actor` is the reactor (envelope source for inbound, self for
   * echoes of our own outbound reaction). Mirrors Signal's emitReactionEvent.
   */
  private emitReactionEvent(record: InboundImessage): void {
    if (record.reactionTargetGuid === undefined) return;
    const channelId = this.channelId;
    const peer = record.chatGuid ?? (record.fromMe ? record.to : record.from);
    const event: ReactionEvent = {
      target: {
        channel: channelId,
        conversation: peer,
        id: record.reactionTargetGuid,
      },
      actor: {
        channel: channelId,
        // The reactor: the envelope source for inbound tapbacks; our own id
        // for echoes (BlueBubbles does echo our outbound reactions back as
        // inbound associated-message records with isFromMe=true).
        id: record.fromMe ? this.selfRef().id : record.from,
      },
      emoji: record.reactionEmoji ?? '',
      removed: record.reactionRemove === true,
      at: new Date(record.timestamp),
    };
    this.safeEmit(this.listeners.reaction, event);
  }

  /**
   * Emit a `ReadEvent` for a newly-observed remote read transition on an
   * outbound message. iMessage read receipts ride on the `dateRead` field
   * of the original outbound record (state updated in place by the backend
   * when the peer reads it).
   *
   * Dedup: the `emittedReadReceipts` set prevents double-emission within a
   * session. Restart dedup: reads with `dateRead` older than `lastPolledAt`
   * are assumed to have been emitted in a prior session and are suppressed.
   * This is the minimum prior state needed to distinguish a new read from
   * an unchanged record without external persistence (#2189).
   *
   * Limitation: messages read AFTER the inbound cursor advances past their
   * ROWID are not re-fetched and will not trigger an emission. Full coverage
   * requires a streaming/webhook inbound mode (documented in the runbook).
   */
  private maybeEmitReadReceipt(record: InboundImessage): void {
    if (this.emittedReadReceipts.has(record.guid)) return;
    const dateReadMs = record.dateRead!;
    // Restart dedup: suppress reads that predate this session. A `dateRead`
    // set before connect was observed in a prior run and must not replay.
    // sessionStartedAt is frozen at connect time (unlike lastPolledAt which
    // advances with each poll), so mid-session reads always pass this filter.
    if (dateReadMs <= this.sessionStartedAt.getTime()) return;

    const message = this.buildInboundMessage(record);
    if (message === null) return;

    this.emittedReadReceipts.add(record.guid);
    trimReadReceiptSet(this.emittedReadReceipts);

    const channelId = this.channelId;
    // For 1:1: the reader is the peer (the `to` field on our outbound).
    // For groups: iMessage surfaces only one dateRead per message (not
    // per-recipient), so the reader identity is the group conversation.
    const rawReader = record.chatGuid ?? record.to;
    const readerId = isImessageGroupAddress(rawReader) || rawReader.startsWith('iMessage;-;')
      ? rawReader
      : canonicalizeImessageDirectIdentity(rawReader);
    if (readerId === null) return;

    const event: ReadEvent = {
      target: message.ref,
      reader: { channel: channelId, id: readerId },
      at: new Date(dateReadMs),
    };
    this.safeEmit(this.listeners.read, event);
  }

  private safeEmit<T>(set: Set<(e: T) => void>, payload: T): void {
    for (const h of [...set]) {
      try {
        h(payload);
      } catch {
        // Listener errors are the listener's bug; isolating them keeps the
        // transport pipeline alive. Intentionally swallowed.
      }
    }
  }

  private transitionTo(next: AdapterHealth): void {
    this.health = next;
    this.safeEmit(this.listeners.state, next);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * True iff `id` is a valid iMessage recipient: AppleID email, E.164 phone,
 * or a chat GUID for group sends (`iMessage;-;chatXXXX` or `iMessage;+;...`).
 * Used by sendText/setTyping to fail before hitting the port.
 */
export function isImessageRecipient(id: string): boolean {
  if (typeof id !== 'string' || id.length === 0) return false;
  // Chat GUID for group sends — both backends accept this form.
  if (id.startsWith('iMessage;-;') || isImessageGroupAddress(id)) return true;
  return APPLEID_EMAIL_RE.test(id) || E164_RE.test(id);
}

// Re-export the port-error type so consumers can match against it without
// importing the port module directly.
export type { ImessagePortError };
