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
import { AdapterReasonCode } from '../contract/adapter-reason-codes.ts';
import {
  AuthRequiredError,
  ConversationNotFoundError,
  PayloadTooLargeError,
  PermanentProviderError,
  RateLimitedError,
  TransientProviderError,
  UnsupportedCapabilityError,
} from '../contract/errors.ts';
import type { CallRef, VoiceCapableTransport, PlaceCallOptions } from '../contract/voice.ts';
import { isNonEmptyString } from '../../lib/type-guards.ts';
import { E164_RE, DEFAULT_TWILIO_VOICE, type TwilioSmsConfig, type TwilioVoiceConfig } from './types.ts';
import type { InboundSms, TwilioSmsPort } from './port.ts';
import { SmsRateLimiter } from './sms-rate-limiter.ts';
import type { TranscriptDelivery } from './webhook-payloads.ts';

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
  phase?: 'not_started' | 'provider_call_started' | 'ack_received';
}

function isTwilioAuth(err: PortErrorLike): boolean {
  return err.status === 401 || err.code === 20003;
}

function isTwilioRateLimit(err: PortErrorLike): boolean {
  return err.status === 429 || err.code === 20429;
}

function isTwilioTransient(err: PortErrorLike): boolean {
  // 5xx = provider-side fault; no status AND no Twilio code = network-level
  // failure (DNS, timeout, connection reset) that never produced an API reply.
  return (typeof err.status === 'number' && err.status >= 500)
    || (err.status === undefined && err.code === undefined);
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
  // Narrow to duck-typed shape
  const pe = err as PortErrorLike;
  const base = {
    channelId,
    operation,
    correlationId,
    scope,
    phase: pe?.phase ?? 'provider_call_started' as const,
  };
  const msg = (typeof pe?.message === 'string' && pe.message) ? pe.message : String(err);

  if (isTwilioAuth(pe)) {
    return new AuthRequiredError({ ...base, message: `Twilio auth error: ${msg}`, providerCode: String(pe.code ?? pe.status ?? '') });
  }
  if (isTwilioRateLimit(pe)) {
    // retryAfterMs intentionally omitted: the port error shape does not carry
    // Retry-After yet. If the SDK port (twilio-port.ts) ever surfaces it, wire it here.
    return new RateLimitedError({ ...base, message: `Twilio rate limit: ${msg}`, providerCode: String(pe.code ?? pe.status ?? '') });
  }
  if (isTwilioTransient(pe)) {
    // NOTE for send-path callers: a network failure after handoff is ambiguous
    // — Twilio may have accepted the message. Generic retry loops risk
    // duplicate SMS on this class of error.
    return new TransientProviderError({ ...base, message: `Twilio transient error: ${msg}`, providerCode: String(pe.code ?? pe.status ?? '') });
  }
  return new PermanentProviderError({ ...base, message: `Twilio provider error: ${msg}`, providerCode: String(pe.code ?? pe.status ?? '') });
}

// ---------------------------------------------------------------------------
// Dedupe-set capacity.
//
// The seen Set is bounded to DEDUPE_CAP entries (insertion-order eviction).
// Trimming happens per accepted record inside handleInboundRecord — the
// shared seam used by both the poll loop and the webhook push path — by
// removing the oldest entries (first inserted) until the set is back at cap.
//
// Per-record trimming cannot cascade re-emissions here because the poll
// fetch is capped at 500 records per tick (< DEDUPE_CAP), so a single batch
// can never evict entries added earlier in the same batch.
//
// Note: a restart that replays within the lookback window will re-emit any
// message whose SID was evicted — replay within the window is best-effort,
// not exactly-once. For typical polling volumes (≪1000 messages per interval)
// eviction should not occur in practice; the cap is a safety valve.
// ---------------------------------------------------------------------------
const DEDUPE_CAP = 1000;

// Post-record eviction: trim the seen set back to DEDUPE_CAP by removing the
// oldest entries (first inserted, by insertion-order of Set). Shared by both
// dedupe seams (handleInboundRecord, handleTranscript) so the trim policy
// cannot drift between them.
function trimSeenSet(seen: Set<string>): void {
  for (const oldest of seen) {
    if (seen.size <= DEDUPE_CAP) break;
    seen.delete(oldest);
  }
}

const DEFAULT_PLACE_CALL_TWIML = '<Response><Say>This line is text-first. Please leave a message.</Say></Response>';

// ---------------------------------------------------------------------------
// TwilioSmsAdapter
// ---------------------------------------------------------------------------
export class TwilioSmsAdapter implements TransportAdapter, VoiceCapableTransport {
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
  private readonly from: string | undefined;
  private readonly messagingServiceSid?: string;
  private readonly pollIntervalMs: number;
  private readonly voice: TwilioVoiceConfig;
  private readonly inboundMode: string;

  // Per-destination outbound rate cap (rateLimit.smsPerMinute, QR-068).
  private readonly smsRateLimiter: SmsRateLimiter;

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
    // Config validation enforces the sender XOR, but direct construction can
    // bypass it — fail loud rather than run with an empty sender identity.
    if (config.phoneNumber === undefined && config.messagingServiceSid === undefined) {
      throw new Error('TwilioSmsAdapter requires phoneNumber or messagingServiceSid');
    }
    this.channelId = makeChannelId('sms', config.account);
    this.port = port;
    this.from = config.phoneNumber;
    this.messagingServiceSid = config.messagingServiceSid;
    this.pollIntervalMs = config.pollIntervalMs;
    this.voice = config.voice ?? DEFAULT_TWILIO_VOICE;
    this.inboundMode = config.inboundMode;
    this.smsRateLimiter = new SmsRateLimiter(config.rateLimit.smsPerMinute);

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

    // selfRef identity: prefer phoneNumber; fall back to messagingServiceSid
    // (the constructor guard above guarantees one of the two is present)
    this.self = { channel: this.channelId, id: (this.from ?? this.messagingServiceSid) as string };
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    // A repeated connect() must not leak the previous poll interval.
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
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

    // Start inbound poll loop when pollIntervalMs > 0 and inboundMode is 'poll'.
    // Cursor initialised to (now - pollIntervalMs) as a lookback window so
    // messages that arrived just before connect are not silently dropped.
    if (this.inboundMode === 'poll' && this.pollIntervalMs > 0) {
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

    // 1b. Destination must be E.164 — fail before the network call rather
    // than paying a round-trip for Twilio's 21211 rejection. Covers every
    // caller (bridge, MCP), not just config-time validation of our own number.
    if (!E164_RE.test(target.id)) {
      throw new ConversationNotFoundError({
        channelId: this.channelId,
        operation: 'sendText',
        correlationId,
        scope: 'conversation',
        message: `target id is not a valid E.164 destination`,
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

    // Rate cap (QR-068): reserve a per-destination send slot AFTER validation
    // (invalid requests must not consume slots) and BEFORE the port call. A
    // full window DELAYS the send rather than throwing — bridge and MCP
    // send_sms callers treat rejection as hard failure; the cap is for cost
    // control, so queueing preserves their contract.
    await this.smsRateLimiter.acquire(target.id);

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

  // ── Voice (VoiceCapableTransport) ─────────────────────────────────────────

  async placeCall(target: ConversationRef, opts?: PlaceCallOptions): Promise<CallRef> {
    const correlationId = opts?.correlationId ?? this.nextCorrelationId();

    if (!this.voice.enabled) {
      throw new UnsupportedCapabilityError({
        channelId: this.channelId,
        operation: 'placeCall',
        correlationId,
        scope: 'request',
        message: 'voice is not enabled for this transport; set voice.enabled: true in twilioConfig',
      });
    }

    if (!E164_RE.test(target.id)) {
      throw new ConversationNotFoundError({
        channelId: this.channelId,
        operation: 'placeCall',
        correlationId,
        scope: 'conversation',
        message: `target id is not a valid E.164 destination`,
      });
    }

    const twiml = opts?.twiml ?? DEFAULT_PLACE_CALL_TWIML;

    let result: { sid: string; status: string };
    try {
      result = await this.port.placeCall({
        to: target.id,
        from: this.from,
        twiml,
      });
    } catch (err) {
      throw mapPortError(err, this.channelId, 'placeCall', correlationId, 'request');
    }

    return {
      id: result.sid,
      status: result.status as CallRef['status'],
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
   * Dedupe eviction happens per accepted record inside handleInboundRecord
   * (shared with the webhook push path); the 500-record fetch cap keeps a
   * single batch below DEDUPE_CAP, so per-record trimming cannot evict
   * same-batch entries.
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
      // Cap the per-tick fetch: DEDUPE_CAP bounds the seen-set, not the batch;
      // an unbounded burst would otherwise arrive as one giant page.
      records = await this.port.listInboundSince(this.lastPolledAt, 500);
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
        this.transitionTo({ state: 'auth_required', since: new Date(), reasonCode: AdapterReasonCode.PollAuthFailure });
      }
      // Transient / rate-limit: stay in current state and keep polling.
      return;
    }

    if (this.disposed) return;

    let maxSentAt: Date | null = null;

    for (const record of records) {
      // Track maximum sentAt to advance the cursor after this batch.
      if (maxSentAt === null || record.sentAt > maxSentAt) {
        maxSentAt = record.sentAt;
      }
      // Delegate dedupe + emit + trim to shared seam
      this.handleInboundRecord(record);
    }

    // Advance cursor to max sentAt seen (not Date.now()) to avoid clock-skew
    // message loss. The inclusive boundary + SID dedupe handles re-delivery.
    if (maxSentAt !== null) {
      this.lastPolledAt = maxSentAt;
    }
  }

  // ── Shared inbound pipeline ───────────────────────────────────────────────

  /**
   * Process one provider record through the shared dedupe + emit pipeline.
   * Used by the poll loop AND (stage 2) the webhook push path, so both
   * modes share one `seen` set and one emitter. Returns true if emitted.
   */
  handleInboundRecord(record: InboundSms): boolean {
    if (this.disposed || this.health.state !== 'connected') return false;
    if (this.seen.has(record.sid)) return false;
    this.seen.add(record.sid);
    const msg = this.buildInboundMessage(record);
    this.safeEmit(this.listeners.message, msg);
    trimSeenSet(this.seen);
    return true;
  }

  /**
   * Process a completed voicemail transcription through the shared dedupe + emit pipeline.
   * Dedupes on recordingSid (same key-space as message SIDs in the seen set).
   * Returns true if emitted.
   */
  handleTranscript(t: TranscriptDelivery): boolean {
    if (this.disposed || this.health.state !== 'connected') return false;
    if (this.seen.has(t.recordingSid)) return false;
    this.seen.add(t.recordingSid);
    const peer = t.from;
    this.safeEmit(this.listeners.message, {
      ref: { channel: this.channelId, conversation: peer, id: t.recordingSid },
      conversation: { channel: this.channelId, id: peer },
      sender: { channel: this.channelId, id: peer },
      fromMe: false,
      text: isNonEmptyString(t.text) ? t.text : null,
      attachments: [{ id: t.recordingSid, kind: 'voice', mime: 'audio/mpeg' }],
      timestamp: new Date(),
      inboundEventKey: t.recordingSid,
      transportTimestamp: new Date(),
      ingestSeq: ++this.ingestSeq,
    });
    trimSeenSet(this.seen);
    return true;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private buildInboundMessage(record: InboundSms): InboundMessage {
    const channelId = this.channelId;
    // For inbound messages, the peer is the sender (record.from).
    // For outbound messages (fromMe: true), the peer is the recipient (record.to).
    // The conversation must always key on the PEER so that send and receive for
    // the same remote number share one conversation thread.
    const peer = record.fromMe ? record.to : record.from;
    // For outbound echoes the sender is us (our own phone number / MSS id).
    const senderId = record.fromMe ? this.selfRef().id : record.from;
    return {
      ref: {
        channel: channelId,
        conversation: peer,
        id: record.sid,
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
