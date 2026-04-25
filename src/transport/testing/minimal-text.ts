// src/transport/testing/minimal-text.ts
import { makeChannelId, type ChannelId, type ConversationRef, type MessageRef, type ParticipantRef } from '../../core/transport-refs.ts';
import type {
  AdapterHealth, Capabilities, InboundMessage, SendTextOptions,
  Subscription, TransportAdapter, TransportError,
} from '../contract/index.ts';
import { makeSubscription } from '../contract/subscription.ts';
import { ConversationNotFoundError } from '../contract/errors.ts';

interface Listeners {
  message: Set<(e: InboundMessage) => void>;
  state: Set<(e: AdapterHealth) => void>;
  error: Set<(e: TransportError) => void>;
}

/**
 * Implements ONLY core TransportAdapter — no extensions.
 * Used by capability-negative tests to prove that callers handle
 * unsupported capabilities correctly.
 */
export class MinimalTextAdapter implements TransportAdapter {
  readonly capabilities: Capabilities;
  private health: AdapterHealth = { state: 'disconnected', since: new Date() };
  private readonly listeners: Listeners = {
    message: new Set(), state: new Set(), error: new Set(),
  };
  private readonly self: ParticipantRef;
  private msgCounter = 0;

  constructor(channel: ChannelId = makeChannelId('whatsapp', 'minimal-test')) {
    this.capabilities = {
      channel,
      kind: channel.split(':', 1)[0] as 'whatsapp' | 'telegram',
      extensions: new Set(),                      // empty — core only
      maxTextLength: 65536,
      auth: 'qr',
      readReceipts: 'none',
      reactions: 'none',
      media: { maxBytes: 0, mimeAllowlist: [] },
      idempotency: { sendText: 'none', sendMedia: 'none', react: 'none', editText: 'none', delete: 'none' },
    };
    this.self = { channel, id: 'minimal-self' };
  }

  async connect(): Promise<void> {
    this.transitionTo({ state: 'connected', since: new Date() });
  }

  async disconnect(): Promise<void> {
    this.transitionTo({ state: 'disconnected', since: new Date() });
  }

  state(): AdapterHealth {
    return this.health;
  }

  selfRef(): ParticipantRef {
    return this.self;
  }

  async sendText(target: ConversationRef, text: string, _opts?: SendTextOptions): Promise<MessageRef> {
    if (target.channel !== this.capabilities.channel) {
      throw new ConversationNotFoundError({
        channelId: this.capabilities.channel,
        operation: 'sendText',
        correlationId: 'min-' + (++this.msgCounter),
        scope: 'conversation',
        message: `target channel ${target.channel} does not match adapter ${this.capabilities.channel}`,
      });
    }
    return {
      channel: this.capabilities.channel,
      conversation: target.id,
      id: 'min-' + (++this.msgCounter),
    };
  }

  on(event: 'message', handler: (e: InboundMessage) => void): Subscription;
  on(event: 'state', handler: (e: AdapterHealth) => void): Subscription;
  on(event: 'error', handler: (e: TransportError) => void): Subscription;
  on(event: 'message' | 'state' | 'error', handler: (e: never) => void): Subscription {
    const set = this.listeners[event] as Set<(e: never) => void>;
    set.add(handler);
    return makeSubscription(() => set.delete(handler));
  }

  private transitionTo(next: AdapterHealth): void {
    this.health = next;
    for (const h of this.listeners.state) h(next);
  }
}
