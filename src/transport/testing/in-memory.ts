// src/transport/testing/in-memory.ts
import {
  makeChannelId, type ChannelId, type ChannelKind, type ConversationRef, type MessageRef,
  type ParticipantRef,
} from '../../core/transport-refs.ts';
import type {
  AdapterHealth, Capabilities, InboundMessage, SendTextOptions, Subscription,
  TransportAdapter, TransportError, InboundEvent,
  AttachmentRef, MediaPayload, MediaBytes, VoicePayload, GroupMetadata, KeyboardButton,
  ReactionEvent, EditEvent, DeleteEvent, PresenceEvent, ReadEvent, GroupUpdateEvent,
  ButtonPressEvent, OutboundStatusEvent, SendMediaOptions, SendVoiceOptions,
  SupportsMedia, SupportsVoiceNotes, SupportsReactions, SupportsEdit, SupportsDelete,
  SupportsTyping, SupportsPresence, SupportsGroups, SupportsReadReceipts,
  SupportsInlineKeyboards, SupportsOutboundStatus,
} from '../contract/index.ts';
import { makeSubscription } from '../contract/subscription.ts';
import { AdapterReasonCode } from '../contract/adapter-reason-codes.ts';
import {
  ConversationNotFoundError, PayloadTooLargeError,
  AuthRequiredError, RateLimitedError, TransientProviderError, SendAmbiguousError,
  type TransportErrorPayload, TransportError as TransportErrorBase,
} from '../contract/errors.ts';

export interface CapturedOutbound {
  readonly operation: 'sendText' | 'sendMedia' | 'sendVoiceNote' | 'react' | 'unreact' | 'editText' | 'deleteMessage' | 'sendWithButtons' | 'setTyping' | 'markRead';
  readonly target: ConversationRef | MessageRef;
  readonly payload?: unknown;
  readonly correlationId: string;
  readonly idempotencyKey?: string;
  readonly at: Date;
  readonly resultRef?: MessageRef;
}

export interface AmbiguousRecord {
  readonly correlationId: string;
  readonly operation: string;
  readonly target: ConversationRef | MessageRef;
  readonly at: Date;
}

interface AllListeners {
  message: Set<(e: InboundMessage) => void>;
  state: Set<(e: AdapterHealth) => void>;
  error: Set<(e: TransportError) => void>;
  reaction: Set<(e: ReactionEvent) => void>;
  edit: Set<(e: EditEvent) => void>;
  delete: Set<(e: DeleteEvent) => void>;
  presence: Set<(e: PresenceEvent) => void>;
  read: Set<(e: ReadEvent) => void>;
  'group-update': Set<(e: GroupUpdateEvent) => void>;
  'button-press': Set<(e: ButtonPressEvent) => void>;
  'outbound-status': Set<(e: OutboundStatusEvent) => void>;
}

export class InMemoryAdapter implements
  TransportAdapter,
  SupportsMedia, SupportsVoiceNotes, SupportsReactions, SupportsEdit, SupportsDelete,
  SupportsTyping, SupportsPresence, SupportsGroups, SupportsReadReceipts,
  SupportsInlineKeyboards, SupportsOutboundStatus
{
  readonly capabilities: Capabilities;
  private health: AdapterHealth = { state: 'disconnected', since: new Date() };
  private readonly self: ParticipantRef;
  private readonly listeners: AllListeners = {
    message: new Set(), state: new Set(), error: new Set(),
    reaction: new Set(), edit: new Set(), delete: new Set(),
    presence: new Set(), read: new Set(), 'group-update': new Set(),
    'button-press': new Set(), 'outbound-status': new Set(),
  };

  // Test bookkeeping
  private readonly captured: CapturedOutbound[] = [];
  private readonly ambiguous: AmbiguousRecord[] = [];
  private readonly attachmentBytes = new Map<string, MediaBytes>();
  private readonly idempotencyLedger = new Map<string, MessageRef>();
  private readonly knownConversations = new Set<string>();

  // Injection state
  private nextSendError: { op: string; ctor: new (input: any) => TransportErrorBase } | null = null;
  private nextSendAmbiguous: string | null = null;
  private rateLimitRetryAfterMs: number | undefined;

  private msgCounter = 0;

  constructor(channel: ChannelId = makeChannelId('whatsapp', 'in-memory')) {
    this.capabilities = {
      channel,
      kind: channel.split(':', 1)[0] as ChannelKind,
      extensions: new Set([
        'media', 'voice-notes', 'reactions', 'edit', 'delete',
        'typing', 'presence', 'groups', 'read-receipts',
        'inline-keyboards', 'outbound-status',
      ]),
      maxTextLength: 65536,
      auth: 'qr',
      readReceipts: 'message',
      reactions: 'multiple',
      media: { maxBytes: 16 * 1024 * 1024, mimeAllowlist: ['image/jpeg', 'image/png', 'audio/ogg', 'video/mp4', 'application/pdf'] },
      // sendText/sendMedia route through sendCore() which honors idempotencyKey.
      // react/editText/delete do not currently accept idempotency keys; declare 'none' to match behavior.
      idempotency: { sendText: 'simulated', sendMedia: 'simulated', react: 'none', editText: 'none', delete: 'none' },
    };
    this.self = { channel, id: 'in-memory-self' };
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    this.transitionTo({ state: 'starting', since: new Date() });
    this.transitionTo({ state: 'connected', since: new Date() });
  }

  async disconnect(): Promise<void> {
    this.transitionTo({ state: 'stopping', since: new Date() });
    this.transitionTo({ state: 'disconnected', since: new Date() });
  }

  state(): AdapterHealth { return this.health; }
  selfRef(): ParticipantRef { return this.self; }

  // ─── Core sendText ────────────────────────────────────────────────────────

  async sendText(target: ConversationRef, text: string, opts?: SendTextOptions): Promise<MessageRef> {
    return this.sendCore('sendText', target, text, opts);
  }

  // ─── Test injection ────────────────────────────────────────────────────────

  injectInbound(event: InboundEvent): void {
    const callAll = <T>(handlers: ReadonlySet<(e: T) => void>, payload: T): void => {
      // Snapshot via [...handlers] to isolate mid-dispatch dispose (I2).
      // Collect errors so siblings still receive the event, then surface failures.
      const errors: unknown[] = [];
      for (const h of [...handlers]) {
        try { h(payload); } catch (err) { errors.push(err); }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, 'One or more InMemoryAdapter listeners failed');
      }
    };
    switch (event.kind) {
      case 'message':
        this.knownConversations.add(event.data.conversation.id);
        callAll(this.listeners.message, event.data);
        return;
      case 'reaction': callAll(this.listeners.reaction, event.data); return;
      case 'edit': callAll(this.listeners.edit, event.data); return;
      case 'delete': callAll(this.listeners.delete, event.data); return;
      case 'presence': callAll(this.listeners.presence, event.data); return;
      case 'read': callAll(this.listeners.read, event.data); return;
      case 'group-update': callAll(this.listeners['group-update'], event.data); return;
      case 'button-press': callAll(this.listeners['button-press'], event.data); return;
      case 'outbound-status': callAll(this.listeners['outbound-status'], event.data); return;
    }
  }

  injectAuthLoss(): void {
    this.transitionTo({ state: 'auth_required', since: new Date(), reasonCode: AdapterReasonCode.InMemoryInjected });
  }

  injectRateLimit(retryAfterMs: number): void {
    this.rateLimitRetryAfterMs = retryAfterMs;
    this.transitionTo({ state: 'rate_limited', since: new Date(), reasonCode: AdapterReasonCode.InMemoryInjected });
  }

  injectAmbiguousFailure(operation: string): void {
    this.nextSendAmbiguous = operation;
  }

  injectProviderError(operation: string, errorClass: new (input: any) => TransportErrorBase): void {
    this.nextSendError = { op: operation, ctor: errorClass };
  }

  injectKnownConversation(conv: ConversationRef): void {
    this.knownConversations.add(conv.id);
  }

  injectAttachmentBytes(ref: AttachmentRef, bytes: MediaBytes): void {
    this.attachmentBytes.set(ref.id, bytes);
  }

  // ─── Test assertions ───────────────────────────────────────────────────────

  outboundCaptured(): ReadonlyArray<CapturedOutbound> { return [...this.captured]; }
  pendingAmbiguous(): ReadonlyArray<AmbiguousRecord> { return [...this.ambiguous]; }

  // ─── Subscription ──────────────────────────────────────────────────────────

  on(event: 'message', handler: (e: InboundMessage) => void): Subscription;
  on(event: 'state', handler: (e: AdapterHealth) => void): Subscription;
  on(event: 'error', handler: (e: TransportError) => void): Subscription;
  on(event: 'reaction', handler: (e: ReactionEvent) => void): Subscription;
  on(event: 'edit', handler: (e: EditEvent) => void): Subscription;
  on(event: 'delete', handler: (e: DeleteEvent) => void): Subscription;
  on(event: 'presence', handler: (e: PresenceEvent) => void): Subscription;
  on(event: 'read', handler: (e: ReadEvent) => void): Subscription;
  on(event: 'group-update', handler: (e: GroupUpdateEvent) => void): Subscription;
  on(event: 'button-press', handler: (e: ButtonPressEvent) => void): Subscription;
  on(event: 'outbound-status', handler: (e: OutboundStatusEvent) => void): Subscription;
  on(event: keyof AllListeners, handler: (e: never) => void): Subscription {
    const set = this.listeners[event] as Set<(e: never) => void>;
    set.add(handler);
    return makeSubscription(() => set.delete(handler));
  }

  // ─── Internal helpers ──────────────────────────────────────────────────────

  private transitionTo(h: AdapterHealth): void {
    this.health = h;
    for (const fn of this.listeners.state) fn(h);
  }

  private nextCorrId(prefix: string, opts?: SendTextOptions): string {
    return opts?.correlationId ?? `${prefix}-${++this.msgCounter}`;
  }

  private async sendCore(
    operation: 'sendText' | 'sendMedia' | 'sendVoiceNote' | 'sendWithButtons',
    target: ConversationRef,
    text: string | undefined,
    opts: SendTextOptions | undefined,
    payload?: unknown,
  ): Promise<MessageRef> {
    const correlationId = this.nextCorrId(operation, opts);

    // Idempotency replay — keyed by (operation, idempotencyKey) so the same key
    // reused across different operations does not collapse onto the wrong MessageRef.
    if (opts?.idempotencyKey !== undefined) {
      const prior = this.idempotencyLedger.get(`${operation}:${opts.idempotencyKey}`);
      if (prior !== undefined) return prior;
    }

    if (this.health.state === 'rate_limited') {
      throw new RateLimitedError({
        channelId: this.capabilities.channel,
        operation, correlationId, scope: 'provider',
        message: 'in-memory rate limited',
        retryAfterMs: this.rateLimitRetryAfterMs,
      });
    }

    // Injected ambiguous
    if (this.nextSendAmbiguous === operation) {
      this.nextSendAmbiguous = null;
      this.ambiguous.push({ correlationId, operation, target, at: new Date() });
      throw new SendAmbiguousError({
        channelId: this.capabilities.channel,
        operation, correlationId, scope: 'request',
        message: 'in-memory ambiguous (mid-flight injection)',
        phase: 'provider_call_started',
      });
    }

    // Injected error
    if (this.nextSendError?.op === operation) {
      const ctor = this.nextSendError.ctor;
      this.nextSendError = null;
      throw new ctor({
        channelId: this.capabilities.channel,
        operation, correlationId, scope: 'request',
        message: 'in-memory injected error',
      });
    }

    // Validate
    if (text !== undefined && text.length > this.capabilities.maxTextLength) {
      throw new PayloadTooLargeError({
        channelId: this.capabilities.channel,
        operation, correlationId, scope: 'request',
        message: `text length ${text.length} exceeds maxTextLength ${this.capabilities.maxTextLength}`,
      });
    }
    if (!this.knownConversations.has(target.id) && target.id !== 'auto-create') {
      // Auto-known conversations come from prior injectInbound; tests can also bypass with id='auto-create'.
      this.knownConversations.add(target.id);
    }
    if (target.channel !== this.capabilities.channel) {
      throw new ConversationNotFoundError({
        channelId: this.capabilities.channel,
        operation, correlationId, scope: 'conversation',
        message: `target channel ${target.channel} does not match adapter ${this.capabilities.channel}`,
      });
    }

    const ref: MessageRef = {
      channel: this.capabilities.channel,
      conversation: target.id,
      id: 'mem-' + (++this.msgCounter),
    };
    this.captured.push({ operation, target, payload: payload ?? text, correlationId, idempotencyKey: opts?.idempotencyKey, at: new Date(), resultRef: ref });
    if (opts?.idempotencyKey !== undefined) {
      this.idempotencyLedger.set(`${operation}:${opts.idempotencyKey}`, ref);
    }
    // Synchronous outbound-status emission
    for (const h of this.listeners['outbound-status']) {
      h({ correlationId, candidateRef: ref, status: 'sent', at: new Date() });
    }
    return ref;
  }

  // ─── Extensions (filled in tasks 14-16) ────────────────────────────────────

  async sendMedia(target: ConversationRef, payload: MediaPayload, opts?: SendMediaOptions): Promise<MessageRef> {
    if (payload.bytes.byteLength > this.capabilities.media.maxBytes) {
      throw new PayloadTooLargeError({
        channelId: this.capabilities.channel,
        operation: 'sendMedia',
        correlationId: opts?.correlationId ?? `sendMedia-${++this.msgCounter}`,
        scope: 'request',
        message: `media size ${payload.bytes.byteLength} exceeds maxBytes ${this.capabilities.media.maxBytes}`,
      });
    }
    return this.sendCore('sendMedia', target, payload.caption, opts, payload);
  }

  async sendVoiceNote(target: ConversationRef, audio: VoicePayload, opts?: SendVoiceOptions): Promise<MessageRef> {
    return this.sendCore('sendVoiceNote', target, undefined, opts, audio);
  }

  async fetchAttachment(ref: AttachmentRef): Promise<MediaBytes> {
    const got = this.attachmentBytes.get(ref.id);
    if (got === undefined) {
      throw new TransientProviderError({
        channelId: this.capabilities.channel,
        operation: 'fetchAttachment', correlationId: `fetch-${++this.msgCounter}`,
        scope: 'request', message: `unknown attachment ${ref.id}`,
      });
    }
    return got;
  }

  async react(target: MessageRef, emoji: string): Promise<void> {
    this.captured.push({
      operation: 'react', target, payload: emoji,
      correlationId: `react-${++this.msgCounter}`, at: new Date(),
    });
  }

  async unreact(target: MessageRef, emoji: string): Promise<void> {
    this.captured.push({
      operation: 'unreact', target, payload: emoji,
      correlationId: `unreact-${++this.msgCounter}`, at: new Date(),
    });
  }

  async editText(target: MessageRef, newText: string): Promise<void> {
    this.captured.push({
      operation: 'editText', target, payload: newText,
      correlationId: `edit-${++this.msgCounter}`, at: new Date(),
    });
  }

  async deleteMessage(target: MessageRef, scope: 'me' | 'everyone'): Promise<void> {
    this.captured.push({
      operation: 'deleteMessage', target, payload: scope,
      correlationId: `delete-${++this.msgCounter}`, at: new Date(),
    });
  }

  async setTyping(target: ConversationRef, on: boolean): Promise<void> {
    this.captured.push({
      operation: 'setTyping', target, payload: on,
      correlationId: `typing-${++this.msgCounter}`, at: new Date(),
    });
  }

  async getGroupMetadata(target: ConversationRef): Promise<GroupMetadata> {
    return { conversation: target, title: 'in-memory group', memberCount: 1 };
  }

  async markRead(target: MessageRef): Promise<void> {
    this.captured.push({
      operation: 'markRead', target,
      correlationId: `read-${++this.msgCounter}`, at: new Date(),
    });
  }

  async sendWithButtons(target: ConversationRef, text: string, buttons: ReadonlyArray<KeyboardButton>): Promise<MessageRef> {
    return this.sendCore('sendWithButtons', target, text, undefined, { text, buttons });
  }
}
