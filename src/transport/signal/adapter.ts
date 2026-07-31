// src/transport/signal/adapter.ts
// SignalAdapter — implements TransportAdapter plus fail-closed reaction seams,
// SupportsTyping, SupportsReadReceipts, and SupportsDelete against a signal-cli
// backend reached via the SignalPort interface in port.ts.
//
// Shape mirrors TwilioSmsAdapter so the two transports share a common
// operational pattern (capabilities, lifecycle, poll loop, dedupe, error
// mapping). Differences are confined to provider-specific seams.
//
// Extension mix-ins (per spec §3 — capabilities signal-cli actually supports):
//   - typing          (sendTypingIndicator RPC)
//   - read-receipts   (sendReadReceipts RPC)
//   - delete          (signal-cli remoteDelete RPC)
// Not in v1: media, voice-notes, edit, inline-keyboards, presence, and V2 group
// administration. Plain group sends are supported. Reactions fail closed until
// MessageRef can carry target author independently from conversation; group read
// receipts fail closed until the sender can be resolved separately.

import {
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
import { AdapterReasonCode } from '../contract/adapter-reason-codes.ts';
import {
  AuthRequiredError,
  ConversationNotFoundError,
  PayloadTooLargeError,
  PermanentProviderError,
  RateLimitedError,
  UnsupportedCapabilityError,
  TransientProviderError,
} from '../contract/errors.ts';
import type {
  DeleteEvent,
  ReadEvent,
  ReactionEvent,
} from '../contract/events.ts';
import type { SupportsReactions, SupportsTyping, SupportsReadReceipts, SupportsDelete } from '../contract/extensions.ts';
import { E164_RE, SIGNAL_UUID_RE, isSignalGroupAddress, type SignalConfig } from './types.ts';
import type { InboundSignal, SignalPort, SignalPortError } from './port.ts';

// ---------------------------------------------------------------------------
// Listener registry — message/state/error share one map, extension events
// (reaction/read/delete) get their own set. All emission goes through safeEmit
// so a single throwing listener cannot break the loop.
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
// Port-error shape (duck-typed — we never import the JSON-RPC client).
// ---------------------------------------------------------------------------
interface PortErrorLike {
  message: string;
  status?: number;
  code?: string;
  phase?: 'not_started' | 'provider_call_started' | 'ack_received';
}

// signal-cli auth/linked-session failures. The JSON-RPC wrapper synthesizes
// status codes (401 for unlinked, 403 for wrong-account, etc.) and surfaces
// the signal-cli exception class name in `code`.
function isSignalAuth(err: PortErrorLike, operation: string): boolean {
  return err.status === 401
    || err.code === 'NotRegisteredException'
    || err.code === 'NoSuchAccountException'
    || ((operation === 'connect' || operation === 'pollInbound')
      && typeof err.message === 'string'
      && /\b(?:not registered|unregistered)\b/i.test(err.message));
}

// signal-cli local-queue saturation — surfaced as a synthesized 429. Also
// catches the explicit "Too many requests" message that some signal-cli
// versions emit under burst send.
function isSignalRateLimit(err: PortErrorLike): boolean {
  return err.status === 429
    || err.code === '-5'
    || (typeof err.message === 'string' && /rate limit|too many requests/i.test(err.message));
}

// signal-cli transient faults — connection blips to the daemon, JVM hiccups,
// envelope decryption retries that surface as ControllableException with a
// retryable message.
function isSignalTransient(err: PortErrorLike): boolean {
  if (typeof err.status === 'number' && err.status >= 500) return true;
  if (err.code === '-3') return true;
  if (err.code === 'ControllableException') return true;
  // Network-level failure: no status AND no code = the request never reached
  // signal-cli or signal-cli never replied.
  return err.status === undefined && err.code === undefined;
}

// ---------------------------------------------------------------------------
// mapPortError: translate a raw port error to a typed TransportError.
// Mirrors Twilio's contract: ALWAYS throw as a typed error; never swallow;
// never auto-retry.
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

  if (isSignalAuth(pe, operation)) {
    return new AuthRequiredError({ ...base, message: `Signal auth error: ${msg}`, providerCode: String(pe.code ?? pe.status ?? '') });
  }
  if (isSignalRateLimit(pe)) {
    return new RateLimitedError({ ...base, message: `Signal rate limit: ${msg}`, providerCode: String(pe.code ?? pe.status ?? '') });
  }
  if (isSignalTransient(pe)) {
    return new TransientProviderError({ ...base, message: `Signal transient error: ${msg}`, providerCode: String(pe.code ?? pe.status ?? '') });
  }
  return new PermanentProviderError({ ...base, message: `Signal provider error: ${msg}`, providerCode: String(pe.code ?? pe.status ?? '') });
}

// ---------------------------------------------------------------------------
// Dedupe-set capacity. Mirrors Twilio's 1000-entry cap with insertion-order
// eviction. Signal envelopes dedupe on the composite conversation, source,
// type, and timestamp identity — the cap is per-adapter.
// ---------------------------------------------------------------------------
const DEDUPE_CAP = 1000;

function trimSeenSet(seen: Set<string>): void {
  for (const oldest of seen) {
    if (seen.size <= DEDUPE_CAP) break;
    seen.delete(oldest);
  }
}

// Maximum text body length. Signal's protocol has no hard cap (the envelope
// ciphertext is what's bounded), but 64 KiB is a reasonable ceiling that
// matches what signal-cli will accept in a single `send` call without
// chunking. Outbound payloads above this throw PayloadTooLargeError.
const SIGNAL_MAX_TEXT = 65_535;

/**
 * SignalAdapter — Signal transport via signal-cli.
 *
 * Implements:
 * - TransportAdapter (lifecycle + sendText + on(message|state|error))
 * - fail-closed SupportsReactions methods (not advertised as a capability)
 * - SupportsTyping (setTyping)
 * - SupportsReadReceipts (markRead/on('read'))
 * - SupportsDelete (deleteMessage/on('delete'))
 *
 * The adapter is constructed with a {@link SignalPort} implementation; the
 * live signal-cli-backed port (signal-cli-port.ts) is injected at factory
 * time. Tests inject a mock port.
 */
export class SignalAdapter
  implements TransportAdapter, SupportsReactions, SupportsTyping, SupportsReadReceipts, SupportsDelete
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

  private readonly channelId: ChannelId;
  private readonly self: ParticipantRef;
  private readonly port: SignalPort;
  private readonly phoneNumber: string;
  private readonly pollIntervalMs: number;
  private readonly rateLimitMessagesPerMinute: number;

  // Monotonic per-adapter ingest counter — incremented for each emitted message.
  private ingestSeq = 0;

  // Correlation counter for error payloads (shared with send path).
  private seq = 0;

  // Bounded composite-envelope dedupe set.
  private readonly seen: Set<string> = new Set();

  // Sliding one-minute send windows, keyed by conversation.
  private readonly sendHistory = new Map<string, number[]>();
  private lastSendHistorySweepAt = 0;

  // Timer handle for the poll interval; null when not polling.
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  // Disposed flag: set on disconnect to prevent in-flight pollOnce from emitting.
  private disposed = false;

  // Reentrancy guard: a poll that outlasts the interval must not overlap.
  private polling = false;
  private activePoll: Promise<void> | null = null;

  // Invalidates asynchronous work started by a previous connect lifecycle.
  private lifecycleGeneration = 0;

  constructor(config: SignalConfig, port: SignalPort) {
    // Validation enforces phoneNumber presence upstream, but direct
    // construction can bypass it — fail loud rather than run with an empty
    // selfRef.
    if (!E164_RE.test(config.phoneNumber)) {
      throw new Error('SignalAdapter requires a valid E.164 phoneNumber (got invalid value)');
    }
    if (config.inboundMode !== 'poll') {
      throw new Error('SignalAdapter inboundMode must be poll');
    }
    if (
      !Number.isInteger(config.pollIntervalMs)
      || config.pollIntervalMs <= 0
      || config.pollIntervalMs > 2_147_483_647
    ) {
      throw new Error('SignalAdapter pollIntervalMs must be a positive 32-bit timer integer');
    }
    if (
      !Number.isInteger(config.rateLimit.messagesPerMinute) ||
      config.rateLimit.messagesPerMinute < 1 ||
      config.rateLimit.messagesPerMinute > 600
    ) {
      throw new Error(
        'SignalAdapter rateLimit.messagesPerMinute must be an integer between 1 and 600',
      );
    }
    this.channelId = makeChannelId('signal', config.account);
    this.port = port;
    this.phoneNumber = config.phoneNumber;
    this.pollIntervalMs = config.pollIntervalMs;
    this.rateLimitMessagesPerMinute = config.rateLimit.messagesPerMinute;

    const extensions: ReadonlySet<ExtensionName> = new Set<ExtensionName>([
      'typing', 'read-receipts', 'delete',
    ]);

    this.capabilities = {
      channel: this.channelId,
      kind: 'signal',
      extensions,
      maxTextLength: SIGNAL_MAX_TEXT,
      auth: 'qr',                     // signal-cli link emits a QR the operator scans
      readReceipts: 'message',        // per-message read receipts
      reactions: 'none',              // MessageRef lacks Signal's target author
      media: { maxBytes: 0, mimeAllowlist: [] },  // media deferred to v2
      idempotency: {
        sendText: 'none',
        sendMedia: 'none',
        react: 'none',
        editText: 'none',
        delete: 'none',
      },
    };

    this.self = { channel: this.channelId, id: this.phoneNumber };
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    // receive is destructive at the provider boundary. Let an in-flight batch
    // finish before changing lifecycle generation so neither a successful
    // drained batch nor its failure can be misapplied to the new connection.
    if (this.activePoll !== null) await this.activePoll;
    const generation = ++this.lifecycleGeneration;
    this.polling = false;
    this.disposed = false;
    this.transitionTo({ state: 'starting', since: new Date() });
    try {
      await this.port.verifyCredentials();
    } catch (err) {
      if (generation !== this.lifecycleGeneration) return;
      this.transitionTo({ state: 'disconnected', since: new Date() });
      throw mapPortError(err, this.channelId, 'connect', this.nextCorrelationId(), 'channel');
    }
    if (generation !== this.lifecycleGeneration) return;
    this.transitionTo({ state: 'connected', since: new Date() });

    // signal-cli receive drains its queued backlog. Provider timestamps never
    // become a cursor because a later destructive batch may be out of order.
    this.pollTimer = setInterval(() => {
      void this.pollOnce();
    }, this.pollIntervalMs);
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.activePoll !== null) await this.activePoll;
    this.lifecycleGeneration++;
    this.polling = false;
    this.disposed = true;
    this.transitionTo({ state: 'disconnected', since: new Date() });
  }

  state(): AdapterHealth {
    return this.health;
  }

  selfRef(): ParticipantRef {
    return this.self;
  }

  isGroupConversation(ref: ConversationRef): boolean {
    return ref.channel === this.channelId && isSignalGroupAddress(ref.id);
  }

  // ── Send ─────────────────────────────────────────────────────────────────

  async sendText(
    target: ConversationRef,
    text: string,
    opts?: SendTextOptions,
  ): Promise<MessageRef> {
    const correlationId = opts?.correlationId ?? this.nextCorrelationId();

    // Validate BEFORE hitting the port.

    // 1. Channel must match.
    if (target.channel !== this.channelId) {
      throw new ConversationNotFoundError({
        channelId: this.channelId,
        operation: 'sendText',
        correlationId,
        scope: 'conversation',
        message: `target channel ${target.channel} does not match adapter channel ${this.channelId}`,
      });
    }

    // 1b. Destination must be E.164 OR a Signal UUID. Fail before the network
    // call rather than asking signal-cli to reject an obvious miss.
    const isGroupTarget = isSignalGroupAddress(target.id);
    if (!isGroupTarget && !E164_RE.test(target.id) && !SIGNAL_UUID_RE.test(target.id)) {
      throw new ConversationNotFoundError({
        channelId: this.channelId,
        operation: 'sendText',
        correlationId,
        scope: 'conversation',
        message: `target id is not a valid E.164 destination, Signal UUID, or group id`,
      });
    }

    // 2/3. Text must be non-empty and within cap.
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

    this.reserveSendSlot(target.id, correlationId);

    let timestamp: number;
    try {
      const result = isGroupTarget
        ? await this.port.send({ groupId: target.id, body: text })
        : await this.port.send({ recipient: target.id, body: text });
      timestamp = result.timestamp;
    } catch (err) {
      throw mapPortError(err, this.channelId, 'sendText', correlationId, 'request');
    }

    return {
      channel: this.channelId,
      conversation: target.id,
      // Signal's canonical message id is the envelope timestamp (epoch ms).
      // We stringify so MessageRef.id stays a string across transports.
      id: String(timestamp),
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
    void emoji;
    void remove;
    throw new UnsupportedCapabilityError({
      channelId: this.channelId,
      operation: 'react',
      correlationId,
      scope: 'request',
      message: 'Signal reactions require a target author that MessageRef does not yet carry',
    });
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
    const isGroup = isSignalGroupAddress(target.id);
    if (!isGroup && !E164_RE.test(target.id) && !SIGNAL_UUID_RE.test(target.id)) {
      throw new ConversationNotFoundError({
        channelId: this.channelId,
        operation: 'setTyping',
        correlationId,
        scope: 'conversation',
        message: `target id is not a valid E.164 destination, Signal UUID, or group id`,
      });
    }
    try {
      await this.port.sendTypingIndicator(isGroup
        ? { groupId: target.id, composing: on }
        : { target: target.id, composing: on });
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
    if (isSignalGroupAddress(target.conversation)) {
      throw new UnsupportedCapabilityError({
        channelId: this.channelId,
        operation: 'markRead',
        correlationId,
        scope: 'request',
        message: 'Signal group read receipts require a sender resolved separately from the group conversation',
      });
    }
    const targetTimestamp = parseSignalTimestamp(target.id, correlationId, this.channelId);
    try {
      await this.port.sendReadReceipts({
        target: target.conversation,
        timestamps: [targetTimestamp],
      });
    } catch (err) {
      throw mapPortError(err, this.channelId, 'markRead', correlationId, 'request');
    }
  }

  // ── SupportsDelete ────────────────────────────────────────────────────────
  //
  // Signal implements "delete for everyone" through signal-cli's remoteDelete
  // RPC. 'me' scope (delete-for-me) is not supported by that RPC, so the
  // adapter throws UnsupportedCapabilityError rather than silently no-op.

  async deleteMessage(target: MessageRef, scope: 'me' | 'everyone'): Promise<void> {
    const correlationId = this.nextCorrelationId();
    if (scope === 'me') {
      throw new UnsupportedCapabilityError({
        channelId: this.channelId,
        operation: 'deleteMessage',
        correlationId,
        scope: 'request',
        message: "Signal delete scope 'me' is not supported by signal-cli; use 'everyone' for remote-delete.",
      });
    }
    if (target.channel !== this.channelId) {
      throw new ConversationNotFoundError({
        channelId: this.channelId,
        operation: 'deleteMessage',
        correlationId,
        scope: 'conversation',
        message: `target channel ${target.channel} does not match adapter channel ${this.channelId}`,
      });
    }
    const targetTimestamp = parseSignalTimestamp(target.id, correlationId, this.channelId);
    try {
      await this.port.remoteDelete(isSignalGroupAddress(target.conversation)
        ? { targetTimestamp, groupId: target.conversation }
        : { targetTimestamp, recipient: target.conversation });
    } catch (err) {
      throw mapPortError(err, this.channelId, 'deleteMessage', correlationId, 'request');
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

  /**
   * Execute a single poll tick. Called by the setInterval timer; extracted as
   * a named method so tests can drive one tick without depending on real clock
   * timing. Behaviour mirrors TwilioSmsAdapter.pollOnce.
   */
  async pollOnce(): Promise<void> {
    if (this.disposed || this.polling) return;
    if (this.health.state !== 'connected') return;
    const generation = this.lifecycleGeneration;
    this.polling = true;
    const operation = this.pollOnceInner(generation);
    this.activePoll = operation;
    try {
      await operation;
    } finally {
      if (this.activePoll === operation) this.activePoll = null;
      if (generation === this.lifecycleGeneration) this.polling = false;
    }
  }

  private async pollOnceInner(generation: number): Promise<void> {
    let records: readonly InboundSignal[];
    try {
      records = await this.port.listInboundSince(new Date(0), 500);
    } catch (err) {
      if (this.disposed || generation !== this.lifecycleGeneration) return;
      const mapped = mapPortError(err, this.channelId, 'pollInbound', this.nextCorrelationId(), 'channel');
      this.safeEmit(this.listeners.error, mapped);
      if (mapped instanceof AuthRequiredError) {
        if (this.pollTimer !== null) {
          clearInterval(this.pollTimer);
          this.pollTimer = null;
        }
        this.transitionTo({ state: 'auth_required', since: new Date(), reasonCode: AdapterReasonCode.PollAuthFailure });
      }
      return;
    }

    if (this.disposed || generation !== this.lifecycleGeneration) return;

    for (const record of records) {
      this.handleInboundRecord(record);
    }
  }

  // ── Shared inbound pipeline ───────────────────────────────────────────────

  /**
   * Process one provider record through the dedupe + emit pipeline. Returns
   * true if emitted. Mirrors Twilio's handleInboundRecord contract so the
   * any future exercised push path can reuse the same seam.
   *
   * Note: Signal envelopes can carry non-text types (typing, receipt, reaction,
   * remote-delete). Data messages and sent-message sync echoes with non-null
   * bodies are emitted as InboundMessage; other types are not emitted here.
   */
  handleInboundRecord(record: InboundSignal): boolean {
    if (this.disposed || this.health.state !== 'connected') return false;
    const conversationId = this.conversationId(record);
    const eventKey = JSON.stringify([
      conversationId,
      record.source,
      record.type,
      record.timestamp,
    ]);
    if (this.seen.has(eventKey)) return false;
    this.seen.add(eventKey);

    if ((record.type === 'data' || record.type === 'sync') && record.body !== null) {
      const msg = this.buildInboundMessage(record, conversationId, eventKey);
      this.safeEmit(this.listeners.message, msg);
      trimSeenSet(this.seen);
      return true;
    }
    // TODO(future): route typing/receipt/reaction envelopes to their
    // extension-event listeners when the live port surfaces them.

    trimSeenSet(this.seen);
    return false;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private buildInboundMessage(
    record: InboundSignal,
    peer: string,
    eventKey: string,
  ): InboundMessage {
    const channelId = this.channelId;
    // For inbound messages, the peer is the sender (record.source).
    // For outbound echoes, the peer is the recipient (record.destination).
    // The conversation keys on the PEER so send/receive for the same remote
    // share one thread.
    const senderId = record.fromMe ? this.selfRef().id : record.source;
    const ts = new Date(record.timestamp);
    return {
      ref: {
        channel: channelId,
        conversation: peer,
        id: String(record.timestamp),
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
      inboundEventKey: eventKey,
      transportTimestamp: ts,
      ingestSeq: ++this.ingestSeq,
    };
  }

  private conversationId(record: InboundSignal): string {
    return record.groupId ?? (record.fromMe ? record.destination : record.source);
  }

  private reserveSendSlot(conversationId: string, correlationId: string): void {
    const now = Date.now();
    const cutoff = now - 60_000;
    if (
      this.lastSendHistorySweepAt === 0
      || now < this.lastSendHistorySweepAt
      || now - this.lastSendHistorySweepAt >= 60_000
    ) {
      for (const [key, timestamps] of this.sendHistory) {
        const active = timestamps.filter((timestamp) => timestamp > cutoff);
        if (active.length === 0) this.sendHistory.delete(key);
        else if (active.length !== timestamps.length) this.sendHistory.set(key, active);
      }
      this.lastSendHistorySweepAt = now;
    }
    const retained = (this.sendHistory.get(conversationId) ?? [])
      .filter((timestamp) => timestamp > cutoff);
    const limit = this.configuredMessagesPerMinute();
    if (retained.length >= limit) {
      const retryAfterMs = Math.max(1, retained[0]! + 60_000 - now);
      throw new RateLimitedError({
        channelId: this.channelId,
        operation: 'sendText',
        correlationId,
        scope: 'conversation',
        phase: 'not_started',
        retryAfterMs,
        message: 'Signal local rate limit reached for this conversation',
      });
    }
    retained.push(now);
    this.sendHistory.set(conversationId, retained);
  }

  private configuredMessagesPerMinute(): number {
    return this.rateLimitMessagesPerMinute;
  }

  private nextCorrelationId(): string {
    return 'signal-' + String(++this.seq).padStart(6, '0');
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
 * Parse a Signal message id back to its epoch-ms timestamp. Signal's
 * canonical id is the envelope timestamp; the adapter stringifies it on
 * outbound (sendText return) so MessageRef.id is uniform across transports.
 * Inbound (react/markRead/deleteMessage) parses it back.
 *
 * Throws ConversationNotFoundError on a non-numeric id — the caller already
 * validated the channel, so a malformed id is a cross-adapter mix-up the
 * operator should hear about.
 */
function parseSignalTimestamp(id: string, correlationId: string, channelId: ChannelId): number {
  const n = Number(id);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ConversationNotFoundError({
      channelId,
      operation: 'parseSignalTimestamp',
      correlationId,
      scope: 'request',
      message: `Signal message id is not a positive epoch-ms timestamp: ${JSON.stringify(id)}`,
    });
  }
  return n;
}

// Re-export the port-error type so consumers can match against it without
// importing the port module directly.
export type { SignalPortError };
