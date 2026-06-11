// src/transport/twilio/adapter.ts
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
} from '../contract/errors.ts';
import type { TwilioSmsConfig } from './types.ts';
import type { InboundSms, TwilioSmsPort } from './port.ts';

// ---------------------------------------------------------------------------
// Listener registry
// ---------------------------------------------------------------------------
interface Listeners {
  message: Set<(e: InboundMessage) => void>;
  state: Set<(e: AdapterHealth) => void>;
  error: Set<(e: TransportError) => void>;
}

// ---------------------------------------------------------------------------
// Port-error shape (duck-typed — we never import from sdk directly)
// ---------------------------------------------------------------------------
interface PortErrorLike {
  message: string;
  status?: number;
  code?: number;
}

function isTwilioAuth(err: PortErrorLike): boolean {
  return err.status === 401 || err.code === 20003;
}

function isTwilioRateLimit(err: PortErrorLike): boolean {
  return err.status === 429 || err.code === 20429;
}

// ---------------------------------------------------------------------------
// mapPortError: translate a raw port error to a typed TransportError.
// Rule: throw ALWAYS as typed error; never swallow; never retry automatically.
// ---------------------------------------------------------------------------
function mapPortError(
  err: unknown,
  channelId: ChannelId,
  operation: string,
  correlationId: string,
  scope: 'request' | 'channel',
): TransportError {
  const base = { channelId, operation, correlationId, scope };

  // Narrow to duck-typed shape
  const pe = err as PortErrorLike;
  const msg = (typeof pe?.message === 'string' && pe.message) ? pe.message : String(err);

  if (isTwilioAuth(pe)) {
    return new AuthRequiredError({ ...base, message: `Twilio auth error: ${msg}`, providerCode: String(pe.code ?? pe.status ?? '') });
  }
  if (isTwilioRateLimit(pe)) {
    // retryAfterMs intentionally omitted: the port error shape does not carry
    // Retry-After yet. If the SDK port (twilio-port.ts) ever surfaces it, wire it here.
    return new RateLimitedError({ ...base, message: `Twilio rate limit: ${msg}`, providerCode: String(pe.code ?? pe.status ?? '') });
  }
  return new PermanentProviderError({ ...base, message: `Twilio provider error: ${msg}`, providerCode: String(pe.code ?? pe.status ?? '') });
}

// ---------------------------------------------------------------------------
// Dedupe-set capacity.
//
// The seen Set is bounded to DEDUPE_CAP entries (insertion-order eviction).
// After processing each poll batch, the set is trimmed to DEDUPE_CAP by
// removing the oldest entries (first inserted). This bounds memory while
// preserving the dedup guarantee for the most recently seen SIDs.
//
// Eviction is post-batch (not per-record) to prevent cascade: if eviction
// happened mid-iteration, each new entry in the same batch could evict the
// previous entry, turning O(1) dedupe into O(n) re-emission.
//
// Note: a restart that replays within the lookback window will re-emit any
// message whose SID was evicted — replay within the window is best-effort,
// not exactly-once. For typical polling volumes (≪1000 messages per interval)
// eviction should not occur in practice; the cap is a safety valve.
// ---------------------------------------------------------------------------
const DEDUPE_CAP = 1000;

// ---------------------------------------------------------------------------
// TwilioSmsAdapter
// ---------------------------------------------------------------------------
export class TwilioSmsAdapter implements TransportAdapter {
  readonly capabilities: Capabilities;

  private health: AdapterHealth = { state: 'disconnected', since: new Date() };
  private readonly listeners: Listeners = {
    message: new Set(),
    state: new Set(),
    error: new Set(),
  };

  private readonly channelId: ChannelId;
  private readonly self: ParticipantRef;
  private readonly port: TwilioSmsPort;
  private readonly from: string;
  private readonly messagingServiceSid?: string;
  private readonly pollIntervalMs: number;

  // Monotonic per-adapter ingest counter — incremented for each emitted message.
  private ingestSeq = 0;

  // Correlation counter for error payloads (shared with send path).
  private seq = 0;

  // Inbound poll state
  //
  // lastPolledAt: cursor for the next listInboundSince call.
  // Initialized at connect() to (connectTime - pollIntervalMs) as a lookback
  // window so messages that arrived just before connect are not silently lost.
  // After each successful poll, advanced to the maximum sentAt seen (NOT
  // Date.now()) to avoid clock-skew message loss. The inclusive boundary + SID
  // dedupe handles re-delivery of the message at the cursor value.
  private lastPolledAt: Date = new Date(0);

  // Bounded SID dedupe set (see DEDUPE_CAP comment above).
  private readonly seen: Set<string> = new Set();

  // Timer handle for the poll interval; null when not polling.
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  // Disposed flag: set on disconnect to prevent in-flight pollOnce from emitting.
  private disposed = false;

  // Reentrancy guard: a poll that outlasts the interval must not overlap the
  // next tick (overlap would double-list with the same cursor and could
  // regress the cursor when ticks finish out of order).
  private polling = false;

  constructor(config: TwilioSmsConfig, port: TwilioSmsPort) {
    this.channelId = makeChannelId('sms', config.account);
    this.port = port;
    this.from = config.phoneNumber;
    this.messagingServiceSid = config.messagingServiceSid;
    this.pollIntervalMs = config.pollIntervalMs;

    this.capabilities = {
      channel: this.channelId,
      kind: 'sms',
      extensions: new Set(),           // no extensions for SMS
      maxTextLength: 1600,             // Twilio concatenated-SMS API limit
      auth: 'token',
      readReceipts: 'none',
      reactions: 'none',
      media: { maxBytes: 0, mimeAllowlist: [] },
      idempotency: {
        sendText: 'none',
        sendMedia: 'none',
        react: 'none',
        editText: 'none',
        delete: 'none',
      },
    };

    this.self = { channel: this.channelId, id: this.from };
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    this.disposed = false;
    this.transitionTo({ state: 'starting', since: new Date() });
    try {
      await this.port.verifyCredentials();
    } catch (err) {
      // On failure: transition back to disconnected and throw the typed error
      // (auth → AuthRequiredError, 429 → RateLimitedError, else permanent —
      // same mapping as the send path).
      this.transitionTo({ state: 'disconnected', since: new Date() });
      throw mapPortError(err, this.channelId, 'connect', this.nextCorrelationId(), 'channel');
    }
    this.transitionTo({ state: 'connected', since: new Date() });

    // Start inbound poll loop when pollIntervalMs > 0.
    // Cursor initialised to (now - pollIntervalMs) as a lookback window so
    // messages that arrived just before connect are not silently dropped.
    if (this.pollIntervalMs > 0) {
      this.lastPolledAt = new Date(Date.now() - this.pollIntervalMs);
      this.pollTimer = setInterval(() => {
        void this.pollOnce();
      }, this.pollIntervalMs);
    }
  }

  async disconnect(): Promise<void> {
    // Set disposed flag BEFORE clearing the timer so any in-flight pollOnce
    // that completes after the interval is cleared will not emit.
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

  // ── Send ─────────────────────────────────────────────────────────────────

  async sendText(
    target: ConversationRef,
    text: string,
    _opts?: SendTextOptions,
  ): Promise<MessageRef> {
    const correlationId = _opts?.correlationId ?? this.nextCorrelationId();

    // Validate BEFORE hitting the port (all throws happen before any port call)

    // 1. Channel must match
    if (target.channel !== this.channelId) {
      throw new ConversationNotFoundError({
        channelId: this.channelId,
        operation: 'sendText',
        correlationId,
        scope: 'conversation',
        message: `target channel ${target.channel} does not match adapter channel ${this.channelId}`,
      });
    }

    // 2. Text must be non-empty (blank is not a valid SMS)
    // 3. Text must not exceed maxTextLength
    // Both cases use PayloadTooLargeError — blank string is a degenerate payload issue
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

    // Build port args: messagingServiceSid preferred over from per types.ts comment
    const sendArgs = this.messagingServiceSid !== undefined
      ? { to: target.id, messagingServiceSid: this.messagingServiceSid, body: text }
      : { to: target.id, from: this.from, body: text };

    let sid: string;
    try {
      const result = await this.port.sendSms(sendArgs);
      sid = result.sid;
    } catch (err) {
      throw mapPortError(err, this.channelId, 'sendText', correlationId, 'request');
    }

    return {
      channel: this.channelId,
      conversation: target.id,
      id: sid,
    };
  }

  // ── Events ───────────────────────────────────────────────────────────────

  on(event: 'message', handler: (e: InboundMessage) => void): Subscription;
  on(event: 'state', handler: (e: AdapterHealth) => void): Subscription;
  on(event: 'error', handler: (e: TransportError) => void): Subscription;
  on(event: 'message' | 'state' | 'error', handler: (e: never) => void): Subscription {
    const set = this.listeners[event] as Set<(e: never) => void>;
    set.add(handler);
    return makeSubscription(() => set.delete(handler));
  }

  // ── Poll loop ────────────────────────────────────────────────────────────

  /**
   * Execute a single poll tick. Called by the setInterval timer.
   * Extracted as a named method so tests can reason about what happens
   * per tick without depending on real clock timing.
   *
   * On auth failure: emits error, stops the poll loop, transitions to
   * auth_required — the failure is loud and permanent; do not retry.
   * On transient/rate-limit failure: emits error, keeps polling (interval
   * cadence is unchanged — no tight loop).
   *
   * Dedupe eviction is post-batch: all new SIDs in a batch are first processed
   * and emitted, then the seen set is trimmed to DEDUPE_CAP oldest-first. This
   * prevents cascade re-emission that would occur if we evicted per-record
   * mid-iteration (each eviction would expose the next record as "unseen").
   */
  async pollOnce(): Promise<void> {
    // Guards: skip if disconnected/disposed, not in a pollable state, or a
    // previous tick is still in flight (reentrancy).
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
    let records: readonly InboundSms[];
    try {
      records = await this.port.listInboundSince(this.lastPolledAt);
    } catch (err) {
      if (this.disposed) return;
      const mapped = mapPortError(err, this.channelId, 'pollInbound', this.nextCorrelationId(), 'channel');
      this.safeEmit(this.listeners.error, mapped);

      // Auth failure is permanent — stop the loop and reflect it in health.
      if (mapped instanceof AuthRequiredError) {
        if (this.pollTimer !== null) {
          clearInterval(this.pollTimer);
          this.pollTimer = null;
        }
        this.transitionTo({ state: 'auth_required', since: new Date(), reasonCode: 'poll-auth-failure' });
      }
      // Transient / rate-limit: stay in current state and keep polling.
      return;
    }

    if (this.disposed) return;

    let maxSentAt: Date | null = null;

    for (const record of records) {
      // SID-based dedupe — skip already-seen records
      if (this.seen.has(record.sid)) continue;

      // Add to seen set (eviction happens post-batch to prevent cascade)
      this.seen.add(record.sid);

      // Track maximum sentAt to advance the cursor after this batch.
      if (maxSentAt === null || record.sentAt > maxSentAt) {
        maxSentAt = record.sentAt;
      }

      // Build the InboundMessage and emit.
      const msg = this.buildInboundMessage(record);
      this.safeEmit(this.listeners.message, msg);
    }

    // Post-batch eviction: trim the seen set to DEDUPE_CAP by removing the
    // oldest entries (first inserted by insertion-order of Set). This is done
    // after the full batch loop to avoid cascade: mid-loop eviction would cause
    // the just-evicted SID to appear "unseen" for the next record in the same tick.
    for (const oldest of this.seen) {
      if (this.seen.size <= DEDUPE_CAP) break;
      this.seen.delete(oldest);
    }

    // Advance cursor to max sentAt seen (not Date.now()) to avoid clock-skew
    // message loss. The inclusive boundary + SID dedupe handles re-delivery.
    if (maxSentAt !== null) {
      this.lastPolledAt = maxSentAt;
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private buildInboundMessage(record: InboundSms): InboundMessage {
    const channelId = this.channelId;
    return {
      ref: {
        channel: channelId,
        conversation: record.from,
        id: record.sid,
      },
      conversation: {
        channel: channelId,
        id: record.from,
      },
      sender: {
        channel: channelId,
        id: record.from,
      },
      fromMe: false,
      text: record.body,
      attachments: [],
      timestamp: record.sentAt,
      // inboundEventKey is stable + unique per SID — used by upstream consumers
      // for idempotent processing; equals the Twilio message SID directly.
      inboundEventKey: record.sid,
      transportTimestamp: record.sentAt,
      ingestSeq: ++this.ingestSeq,
    };
  }

  private nextCorrelationId(): string {
    return 'twilio-' + String(++this.seq).padStart(6, '0');
  }

  /**
   * Fan out to listeners with per-listener isolation: a throwing listener
   * must never break the poll loop, drop the rest of a batch, or starve
   * other listeners. (The background loop has no caller to rethrow to —
   * an unhandled throw here would surface as an unhandled rejection.)
   * The set is snapshotted so listeners that mutate subscriptions during
   * emission do not affect this fan-out.
   */
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
