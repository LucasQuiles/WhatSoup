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
import type { TwilioSmsPort } from './port.ts';

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
  // Inbound seam for T6 — polling wired in the next task.
  private readonly pollIntervalMs: number;
  private seq = 0;

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
    // T6 will start the poll loop here when pollIntervalMs > 0.
  }

  async disconnect(): Promise<void> {
    // T6 will clear the poll interval here.
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

  // ── Private helpers ───────────────────────────────────────────────────────

  private nextCorrelationId(): string {
    return 'twilio-' + String(++this.seq).padStart(6, '0');
  }

  private transitionTo(next: AdapterHealth): void {
    this.health = next;
    for (const h of this.listeners.state) h(next);
  }
}
