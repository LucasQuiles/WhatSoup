// src/transport/signal/adapter.ts
// SignalAdapter — implements TransportAdapter + SupportsReactions,
// SupportsTyping, SupportsReadReceipts, SupportsDelete against a signal-cli
// backend reached via the SignalPort interface in port.ts.
//
// Shape mirrors TwilioSmsAdapter so the two transports share a common
// operational pattern (capabilities, lifecycle, poll loop, dedupe, error
// mapping). Differences are confined to provider-specific seams.
//
// Extension mix-ins (per spec §3 — capabilities signal-cli actually supports):
//   - reactions       (sendReaction RPC)
//   - typing          (sendTypingIndicator RPC)
//   - read-receipts   (sendReadReceipts RPC)
//   - delete          (signal-cli remote-delete via sendReaction with empty emoji + remove flag)
// Not in v1: media, voice-notes, edit, inline-keyboards, presence, groups (V2 group
// admin operations beyond send-to-group are intentionally deferred).

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
import {
  AuthRequiredError,
  ConversationNotFoundError,
  PayloadTooLargeError,
  PermanentProviderError,
  RateLimitedError,
  TransientProviderError,
} from '../contract/errors.ts';
import type {
  DeleteEvent,
  ReadEvent,
  ReactionEvent,
} from '../contract/events.ts';
import type { SupportsReactions, SupportsTyping, SupportsReadReceipts, SupportsDelete } from '../contract/extensions.ts';
import { E164_RE, SIGNAL_UUID_RE, SIGNAL_GROUP_ID_RE, type SignalConfig } from './types.ts';
import type { InboundSignal, SignalPort, SignalPortError } from './port.ts';
import type { CredentialLifecycleEvent, CredentialLifecycleEventName } from '../connection.ts';

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
}

// signal-cli auth/linked-session failures. The JSON-RPC wrapper synthesizes
// status codes (401 for unlinked, 403 for wrong-account, etc.) and surfaces
// the signal-cli exception class name in `code`.
function isSignalAuth(err: PortErrorLike): boolean {
  return err.status === 401
    || err.code === 'UntrustedIdentityException'
    || err.code === 'NotRegisteredException';
}

// signal-cli local-queue saturation — surfaced as a synthesized 429. Also
// catches the explicit "Too many requests" message that some signal-cli
// versions emit under burst send.
function isSignalRateLimit(err: PortErrorLike): boolean {
  return err.status === 429
    || (typeof err.message === 'string' && /rate limit|too many requests/i.test(err.message));
}

// signal-cli transient faults — connection blips to the daemon, JVM hiccups,
// envelope decryption retries that surface as ControllableException with a
// retryable message.
//
// recognize common Node network error codes that surface when the
// signal-cli daemon is unreachable. Without this, a daemon restart would
// escalate to PermanentProviderError (instead of the reconnect engine) and
// burn the bot-errors budget instead of self-healing.
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNREFUSED',   // daemon not running / socket deleted
  'ECONNRESET',     // daemon killed mid-RPC
  'ETIMEDOUT',      // RPC timeout (network or JVM pause)
  'ENOTFOUND',      // DNS resolution failure (TCP mode)
  'EPIPE',          // socket closed mid-write
  'EHOSTUNREACH',   // network-level unreachable
  'EAI_AGAIN',      // temporary DNS failure
]);
function isSignalTransient(err: PortErrorLike): boolean {
  if (typeof err.status === 'number' && err.status >= 500) return true;
  if (err.code === 'ControllableException') return true;
  if (typeof err.code === 'string' && TRANSIENT_NETWORK_CODES.has(err.code)) return true;
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
  const base = { channelId, operation, correlationId, scope };
  const pe = err as PortErrorLike;
  const msg = (typeof pe?.message === 'string' && pe.message) ? pe.message : String(err);

  if (isSignalAuth(pe)) {
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
// eviction. Signal envelopes dedupe on timestamp (epoch ms) which is unique
// per sender within a session — the cap is per-adapter.
// ---------------------------------------------------------------------------
const DEDUPE_CAP = 1000;

function trimSeenSet(seen: Set<number>): void {
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
 * - SupportsReactions (react/unreact/on('reaction'))
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

  /**
   * Bounded ring buffer of recent CredentialLifecycleEvent entries. 
   * slice 2: replaces the synthesized 2-event timeline that
   * signalConnectionStateSnapshot() used to emit. The buffer is drained by
   * SignalConnection.getConnectionState() via recentLifecycleEvents().
   *
   * Cap mirrors the WhatsApp side's recentEvents bound (50 entries). A
   * flapping daemon cannot grow it unboundedly.
   */
  private static readonly LIFECYCLE_EVENT_CAP = 50;
  private readonly lifecycleEvents: CredentialLifecycleEvent[] = [];

  /**
   * Reconnect engine state. mirrors WhatsApp's reconnect engine
   * (MAX_RECONNECT_ATTEMPTS=10, BASE_BACKOFF_MS=1000, MAX_BACKOFF_MS=60000).
   *
   * Consecutive transient poll failures escalate through this state. A
   * successful poll resets it. Hitting MAX_RECONNECT_ATTEMPTS parks the
   * adapter at 'exhausted' (an AdapterState), stops the poll timer, and
   * emits a connection_close lifecycle event so the bot-errors dispatcher
   * can route the alert.
   */
  private static readonly MAX_RECONNECT_ATTEMPTS = 10;
  private static readonly BASE_BACKOFF_MS = 1_000;
  private static readonly MAX_BACKOFF_MS = 60_000;
  private reconnectAttemptCount = 0;
  private reconnectPhaseValue: 'backoff' | 'cooldown' | 'retry' = 'backoff';
  private firstFailureAtMs: number | null = null;

  public readonly channelId: ChannelId;
  private readonly self: ParticipantRef;
  private readonly port: SignalPort;
  private readonly phoneNumber: string;
  private readonly pollIntervalMs: number;
  private readonly inboundMode: string;

  // Monotonic per-adapter ingest counter — incremented for each emitted message.
  private ingestSeq = 0;

  // Correlation counter for error payloads (shared with send path).
  private seq = 0;

  // Inbound poll state. Initialized at connect() to (now - pollIntervalMs)
  // as a lookback window so messages that arrived just before connect are
  // not silently lost. Advanced after each poll to the max timestamp seen
  // (NOT Date.now()) to avoid clock-skew message loss.
  private lastPolledAt: Date = new Date(0);

  // Bounded timestamp dedupe set.
  private readonly seen: Set<number> = new Set();

  // Timer handle for the poll interval; null when not polling.
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  // Disposed flag: set on disconnect to prevent in-flight pollOnce from emitting.
  private disposed = false;

  // Reentrancy guard: a poll that outlasts the interval must not overlap.
  private polling = false;

  constructor(config: SignalConfig, port: SignalPort) {
    // Validation enforces phoneNumber presence upstream, but direct
    // construction can bypass it — fail loud rather than run with an empty
    // selfRef.
    if (!E164_RE.test(config.phoneNumber)) {
      throw new Error(
        `SignalAdapter requires a valid E.164 phoneNumber (got ${JSON.stringify(config.phoneNumber)})`,
      );
    }
    this.channelId = makeChannelId('signal', config.account);
    this.port = port;
    this.phoneNumber = config.phoneNumber;
    this.pollIntervalMs = config.pollIntervalMs;
    this.inboundMode = config.inboundMode;

    const extensions: ReadonlySet<ExtensionName> = new Set<ExtensionName>([
      'reactions', 'typing', 'read-receipts', 'delete',
    ]);

    this.capabilities = {
      channel: this.channelId,
      kind: 'signal',
      extensions,
      maxTextLength: SIGNAL_MAX_TEXT,
      auth: 'qr',                     // signal-cli link emits a QR the operator scans
      readReceipts: 'message',        // per-message read receipts
      reactions: 'single',            // one reaction per user per message
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
    this.disposed = false;
    this.transitionTo({ state: 'starting', since: new Date() });
    try {
      await this.port.verifyCredentials();
    } catch (err) {
      this.transitionTo({ state: 'disconnected', since: new Date() });
      throw mapPortError(err, this.channelId, 'connect', this.nextCorrelationId(), 'channel');
    }
    this.transitionTo({ state: 'connected', since: new Date() });

    if (this.inboundMode === 'poll' && this.pollIntervalMs > 0) {
      this.lastPolledAt = new Date(Date.now() - this.pollIntervalMs);
      this.pollTimer = setInterval(() => {
        void this.pollOnce();
      }, this.pollIntervalMs);
    }
    // 'stream' mode wiring lands with the live port implementation; the
    // signature-only stub port used in tests doesn't exercise it.
  }

  async disconnect(): Promise<void> {
    this.disposed = true;
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.transitionTo({ state: 'disconnected', since: new Date() });
  }

  state(): AdapterHealth {
    return this.health;
  }

  selfRef(): ParticipantRef {
    return this.self;
  }

  /**
   * True iff a conversation ref addresses a Signal V2 group (base64 group id
   * shape). Used by the connection bridge to set IncomingMessage.isGroup —
   * the contract envelope carries no group flag, and the id shape is the
   * only stateless discriminator (E.164 starts '+', UUID has dashes).
   */
  isGroupConversation(ref: ConversationRef): boolean {
    return ref.channel === this.channelId && SIGNAL_GROUP_ID_RE.test(ref.id);
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

    // 1b. Destination must be E.164, a Signal UUID, or a base64 V2 group id.
    // Fail before the network call rather than round-tripping to signal-cli's
    // `resolveRecipient` for an obvious miss.
    const isGroupTarget = SIGNAL_GROUP_ID_RE.test(target.id);
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
    // Signal's react RPC removes a reaction when `remove: true`; the emoji
    // argument is informational only (matches what was previously reacted).
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
    const targetTimestamp = parseSignalTimestamp(target.id, correlationId, this.channelId);
    const targetAuthor = target.conversation;

    try {
      await this.port.sendReaction({
        targetTimestamp,
        targetAuthor,
        targetInGroup: false,
        emoji: remove ? '' : emoji,
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
    if (!E164_RE.test(target.id) && !SIGNAL_UUID_RE.test(target.id)) {
      throw new ConversationNotFoundError({
        channelId: this.channelId,
        operation: 'setTyping',
        correlationId,
        scope: 'conversation',
        message: `target id is not a valid E.164 destination or Signal UUID`,
      });
    }
    try {
      await this.port.sendTypingIndicator({ target: target.id, composing: on });
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
  // Signal implements "delete for everyone" via the remote-delete protocol,
  // which is itself a reaction envelope with the target message's timestamp
  // + author and a special "remove" flag. signal-cli surfaces this as a
  // `delete` RPC over the same port; the adapter models it as a delete()
  // method on SupportsDelete. 'me' scope (delete-for-me) is not supported
  // by signal-cli's RPC today — the adapter throws UnsupportedCapabilityError
  // rather than silently no-op.

  async deleteMessage(target: MessageRef, scope: 'me' | 'everyone'): Promise<void> {
    const correlationId = this.nextCorrelationId();
    if (scope === 'me') {
      // Throw UnsupportedCapabilityError — but to avoid pulling in another
      // import for a single use, use the existing PayloadTooLargeError shape
      // pattern: build a typed PermanentProviderError carrying the semantics.
      // NOTE: replaced below with the proper UnsupportedCapabilityError once
      // the contract re-exports it. For now, PermanentProviderError with a
      // clear message is sufficient (the contract treats it as hard-fail).
      throw new PermanentProviderError({
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
      // Remote-delete is implemented as a "remove" reaction with no emoji;
      // signal-cli translates this to the protocol-level delete envelope.
      await this.port.sendReaction({
        targetTimestamp,
        targetAuthor: target.conversation,
        targetInGroup: false,
        emoji: '',
        remove: true,
      });
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
    this.polling = true;
    try {
      await this.pollOnceInner();
    } finally {
      this.polling = false;
    }
  }

  private async pollOnceInner(): Promise<void> {
    let records: readonly InboundSignal[];
    try {
      records = await this.port.listInboundSince(this.lastPolledAt, 500);
    } catch (err) {
      if (this.disposed) return;
      const mapped = mapPortError(err, this.channelId, 'pollInbound', this.nextCorrelationId(), 'channel');
      this.safeEmit(this.listeners.error, mapped);
      if (mapped instanceof AuthRequiredError) {
        // Auth required is a separate code path: signal-cli reports the
        // account unlinked. Operator action required — no retry escalation.
        if (this.pollTimer !== null) {
          clearInterval(this.pollTimer);
          this.pollTimer = null;
        }
        this.transitionTo({ state: 'auth_required', since: new Date(), reasonCode: 'poll-auth-failure' });
      } else if (mapped instanceof TransientProviderError) {
        // escalate through the reconnect engine. Hitting the ceiling
        // parks at 'exhausted' so the bot-errors dispatcher can alert; below
        // the ceiling the next poll interval tick tries again (the engine
        // could insert a setTimeout-based backoff, but the existing poll
        // interval already provides spacing; the attempt counter + exhausted
        // state are the parity gap that matters for ops dashboards).
        this.recordTransientFailure();
      }
      // RateLimitedError and PermanentProviderError do NOT escalate the
      // reconnect engine on the poll path — rate limits self-heal on the
      // next interval tick (the daemon enforces its own pacing), and
      // permanent errors on a poll are typically a transient envelope-shape
      // issue that will not recur. AuthRequiredError already handled above.
      return;
    }

    if (this.disposed) return;

    // Successful poll — reset the reconnect engine.
    this.resetReconnectEngine();

    let maxTs: number | null = null;
    for (const record of records) {
      if (maxTs === null || record.timestamp > maxTs) maxTs = record.timestamp;
      this.handleInboundRecord(record);
    }
    if (maxTs !== null) {
      this.lastPolledAt = new Date(maxTs);
    }
  }

  /**
   * Record a consecutive transient failure. Escalates reconnectAttemptCount
   * and firstFailureAt. When the count reaches MAX_RECONNECT_ATTEMPTS, parks
   * the adapter at 'exhausted' and stops the poll timer.
   */
  private recordTransientFailure(): void {
    if (this.firstFailureAtMs === null) {
      this.firstFailureAtMs = Date.now();
    }
    this.reconnectAttemptCount += 1;
    this.reconnectPhaseValue = this.reconnectAttemptCount >= 3 ? 'cooldown' : 'backoff';

    if (this.reconnectAttemptCount >= SignalAdapter.MAX_RECONNECT_ATTEMPTS) {
      // Park at exhausted: stop the poll timer so we stop hammering the
      // daemon, transition state, and let the lifecycle event + bot-errors
      // dispatcher surface the alert.
      if (this.pollTimer !== null) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
      this.transitionTo({
        state: 'exhausted',
        since: new Date(),
        reasonCode: `reconnect-exhausted-after-${this.reconnectAttemptCount}-attempts`,
      });
    }
  }

  /**
   * Reset the reconnect engine on a successful poll. Idempotent.
   */
  private resetReconnectEngine(): void {
    if (this.reconnectAttemptCount === 0 && this.firstFailureAtMs === null) return;
    this.reconnectAttemptCount = 0;
    this.reconnectPhaseValue = 'backoff';
    this.firstFailureAtMs = null;
  }

  /** Public accessor: consecutive transient failure count (reconnect engine). */
  reconnectAttempts(): number {
    return this.reconnectAttemptCount;
  }

  /** Public accessor: current reconnect phase (reconnect engine). */
  reconnectPhase(): 'backoff' | 'cooldown' | 'retry' {
    return this.reconnectPhaseValue;
  }

  /** Public accessor: epoch-ms of the first failure in the current run, or null. */
  firstFailureAt(): number | null {
    return this.firstFailureAtMs;
  }

  // ── Shared inbound pipeline ───────────────────────────────────────────────

  /**
   * Process one provider record through the dedupe + emit pipeline. Returns
   * true if emitted. Mirrors Twilio's handleInboundRecord contract so the
   * webhook-equivalent push path (added when the live port supports 'stream'
   * mode) can reuse the same seam.
   *
   * Routing by `type`:
   *   - 'data'           → InboundMessage to message listeners
   *   - 'sync'           → InboundMessage to message listeners (echo of own send)
   *   - 'reaction'       → ReactionEvent to reaction listeners
   *   - 'read'           → one ReadEvent per timestamp to read listeners
   *   - 'delete'         → DeleteEvent to delete listeners
   *   - other            → dropped (typing/call/delivery have no v1 event)
   *
   * All envelope classes share the dedupe set (keyed by envelope timestamp)
   * and the disposed/connected guards.
   */
  handleInboundRecord(record: InboundSignal): boolean {
    if (this.disposed || this.health.state !== 'connected') return false;
    if (this.seen.has(record.timestamp)) return false;
    this.seen.add(record.timestamp);

    switch (record.type) {
      case 'data':
      case 'sync':
        if (record.body !== null) {
          this.safeEmit(this.listeners.message, this.buildInboundMessage(record));
        }
        break;
      case 'reaction':
        if (record.reaction) {
          this.emitReactionEvent(record, record.reaction);
        }
        break;
      case 'read':
        if (record.read) {
          for (const ts of record.read.timestamps) {
            this.emitReadEvent(record, ts);
          }
        }
        break;
      case 'delete':
        if (record.delete) {
          this.emitDeleteEvent(record, record.delete);
        }
        break;
      default:
        // Unknown envelope class — leave seen-marked (so a re-delivery does
        // not re-enter this branch) but emit nothing.
        break;
    }

    trimSeenSet(this.seen);
    return true;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private emitReactionEvent(record: InboundSignal, r: NonNullable<InboundSignal['reaction']>): void {
    // The reaction's target is the reacted-to message; the conversation is
    // the author of that message (1:1 = peer UUID; group = group id).
    const event: ReactionEvent = {
      target: {
        channel: this.channelId,
        conversation: r.targetAuthor,
        id: String(r.targetTimestamp),
      },
      actor: {
        channel: this.channelId,
        // The reactor: the envelope source for inbound reactions; our own id
        // for echoes (signal-cli does not currently echo our outbound reactions
        // as sync messages, so fromMe=true here is theoretical).
        id: record.fromMe ? this.selfRef().id : record.source,
      },
      emoji: r.emoji,
      removed: r.remove,
      at: new Date(record.timestamp),
    };
    this.safeEmit(this.listeners.reaction, event);
  }

  private emitReadEvent(record: InboundSignal, targetTimestamp: number): void {
    const event: ReadEvent = {
      target: {
        channel: this.channelId,
        // The reader is the source; the message they marked read lives in
        // the conversation between them and us.
        conversation: record.source,
        id: String(targetTimestamp),
      },
      reader: {
        channel: this.channelId,
        id: record.source,
      },
      at: new Date(record.timestamp),
    };
    this.safeEmit(this.listeners.read, event);
  }

  private emitDeleteEvent(record: InboundSignal, d: NonNullable<InboundSignal['delete']>): void {
    const event: DeleteEvent = {
      target: {
        channel: this.channelId,
        // signal-cli remote-delete carries only the target timestamp; the
        // port fills targetAuthor with the envelope source. The conversation
        // is that author (1:1 = peer; group = group id).
        conversation: d.targetAuthor,
        id: String(d.targetTimestamp),
      },
      // signal-cli's remote-delete is always delete-for-everyone (the only
      // scope the protocol supports); 'me' would have thrown on the outbound
      // path and never reaches here as an inbound event.
      scope: 'everyone',
      at: new Date(record.timestamp),
    };
    this.safeEmit(this.listeners.delete, event);
  }

  private buildInboundMessage(record: InboundSignal): InboundMessage {
    const channelId = this.channelId;
    // Group envelopes thread under the group id (all members' traffic shares
    // one conversation). 1:1 envelopes key on the PEER: sender for inbound,
    // recipient for our own outbound echoes.
    const peer = record.groupId ?? (record.fromMe ? record.destination : record.source);
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
      inboundEventKey: String(record.timestamp),
      transportTimestamp: ts,
      ingestSeq: ++this.ingestSeq,
    };
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
    const prev = this.health;
    this.health = next;
    this.recordLifecycleEventForTransition(prev, next);
    this.safeEmit(this.listeners.state, next);
  }

  /**
   * Record a CredentialLifecycleEvent for a state transition. Mirrors the
   * WhatsApp side's recordCredentialLifecycle() pattern: each transition
   * produces at least one event. The auth_required transition is special-cased
   * to emit `device_bond_lost` because signal-cli surfaces an unlinked
   * account as a 401 on the next RPC — distinguishing "daemon unreachable"
   * (transient) from "this device was unlinked" (operator action required).
   */
  private recordLifecycleEventForTransition(prev: AdapterHealth, next: AdapterHealth): void {
    const at = next.since.toISOString();
    const reconnectAttempts = 0;
    const reconnectPhase = 'backoff' as const;
    const base = { at, reconnectAttempts, reconnectPhase };

    // Map adapter state → connection state for the CredentialLifecycleEvent.state field.
    // The adapter uses 'auth_required' as a distinct state; the lifecycle event schema
    // uses 'disconnected' for anything not actively connected.
    const eventState: CredentialLifecycleEvent['state'] = next.state === 'connected' ? 'connected' : 'disconnected';

    if (prev.state !== 'starting' && next.state === 'starting') {
      // A fresh connect attempt.
      this.pushLifecycleEvent({ ...base, event: 'connect_start', state: eventState });
    }

    if (next.state === 'connected' && prev.state !== 'connected') {
      this.pushLifecycleEvent({ ...base, event: 'connection_open', state: eventState });
    }

    if (next.state === 'disconnected' && prev.state !== 'disconnected') {
      this.pushLifecycleEvent({
        ...base,
        event: 'connection_close',
        state: eventState,
        reason: next.reasonCode ?? undefined,
      });
    }

    // parking at 'exhausted' is also a connection_close from the
    // lifecycle-event schema's perspective (the connection is no longer
    // usable). The reasonCode carries the cause for dashboards.
    if (next.state === 'exhausted' && prev.state !== 'exhausted') {
      this.pushLifecycleEvent({
        ...base,
        event: 'connection_close',
        state: eventState,
        reason: next.reasonCode ?? 'reconnect-exhausted',
      });
    }

    if (next.state === 'auth_required' && prev.state !== 'auth_required') {
      // The unlinked-account signal: signal-cli returned 401 on a poll.
      // Emit device_bond_lost so dashboards distinguish this from a transient
      // daemon blip — the operator must re-link the device out-of-band.
      this.pushLifecycleEvent({
        ...base,
        event: 'device_bond_lost',
        state: eventState,
        reason: next.reasonCode ?? 'signal_device_unlinked',
      });
    }
  }

  private pushLifecycleEvent(event: CredentialLifecycleEvent): void {
    this.lifecycleEvents.push(event);
    // Ring-buffer eviction: drop oldest while over cap.
    while (this.lifecycleEvents.length > SignalAdapter.LIFECYCLE_EVENT_CAP) {
      this.lifecycleEvents.shift();
    }
  }

  /**
   * Public accessor: returns the recent lifecycle event history (bounded ring
   * buffer, oldest first). Consumer: SignalConnection.getConnectionState()
   * surfaces these as `credentialLifecycle.recentEvents` in health.json.
   */
  recentLifecycleEvents(): CredentialLifecycleEvent[] {
    return this.lifecycleEvents.slice();
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
