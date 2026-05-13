/**
 * Direct behavior coverage for src/transport/testing/minimal-text.ts.
 *
 * MinimalTextAdapter is the bare-minimum TransportAdapter shipped in the src
 * tree. Shared conformance and capability-negative suites cover the common
 * TransportAdapter contract; these tests pin adapter-specific fixture defaults,
 * state notifications, error payload details, and message-id sequencing.
 */
import { describe, expect, it } from 'vitest';
import { MinimalTextAdapter } from '../../../src/transport/testing/minimal-text.ts';
import { makeChannelId, type ConversationRef } from '../../../src/core/transport-refs.ts';
import {
  ConversationNotFoundError,
  PayloadTooLargeError,
} from '../../../src/transport/contract/errors.ts';

const channel = makeChannelId('whatsapp', 'minimal-test');
const target: ConversationRef = { channel, id: 'peer-1' };

function minIdNumber(id: string): number {
  const match = /^min-(\d+)$/.exec(id);
  expect(match).not.toBeNull();
  return Number(match![1]);
}

describe('MinimalTextAdapter — defaults', () => {
  it('starts in disconnected state with a since timestamp', () => {
    const adapter = new MinimalTextAdapter();
    const s = adapter.state();
    expect(s.state).toBe('disconnected');
    expect(s.since).toBeInstanceOf(Date);
  });

  it('selfRef carries the adapter channel and stable fixture id', () => {
    const adapter = new MinimalTextAdapter();
    const ref = adapter.selfRef();
    expect(ref.channel).toBe(channel);
    expect(ref.id).toBe('minimal-self');
  });

  it('capabilities.kind is derived from the channel prefix', () => {
    const adapter = new MinimalTextAdapter();
    expect(adapter.capabilities.kind).toBe('whatsapp');
  });

  it('uses a default channel when none is supplied', () => {
    const adapter = new MinimalTextAdapter();
    expect(adapter.capabilities.channel).toBe(channel);
  });

  it('accepts an injected channel and reflects it in capabilities + selfRef', () => {
    const custom = makeChannelId('telegram', 'custom');
    const adapter = new MinimalTextAdapter(custom);
    expect(adapter.capabilities.channel).toBe(custom);
    expect(adapter.capabilities.kind).toBe('telegram');
    expect(adapter.selfRef().channel).toBe(custom);
  });
});

describe('MinimalTextAdapter — connect / disconnect', () => {
  it('connect() transitions state to "connected"', async () => {
    const adapter = new MinimalTextAdapter();
    await adapter.connect();
    expect(adapter.state().state).toBe('connected');
  });

  it('disconnect() transitions state back to "disconnected"', async () => {
    const adapter = new MinimalTextAdapter();
    await adapter.connect();
    await adapter.disconnect();
    expect(adapter.state().state).toBe('disconnected');
  });

  it('connect emits a state event with the new health to all listeners', async () => {
    const adapter = new MinimalTextAdapter();
    const events: string[] = [];
    adapter.on('state', (h) => events.push(h.state));
    await adapter.connect();
    await adapter.disconnect();
    expect(events).toEqual(['connected', 'disconnected']);
  });

  it('state subscription supports multiple listeners independently', async () => {
    const adapter = new MinimalTextAdapter();
    const a: string[] = [];
    const b: string[] = [];
    adapter.on('state', (h) => a.push(h.state));
    adapter.on('state', (h) => b.push(h.state));
    await adapter.connect();
    expect(a).toEqual(['connected']);
    expect(b).toEqual(['connected']);
  });

  it('Subscription.dispose() removes the listener', async () => {
    const adapter = new MinimalTextAdapter();
    const events: string[] = [];
    const sub = adapter.on('state', (h) => events.push(h.state));
    sub.dispose();
    await adapter.connect();
    expect(events).toEqual([]);
  });
});

describe('MinimalTextAdapter — sendText happy path', () => {
  it('returns a MessageRef with channel, conversation, and a monotonic id', async () => {
    const adapter = new MinimalTextAdapter();
    const a = await adapter.sendText(target, 'hello');
    const b = await adapter.sendText(target, 'world');
    expect(a.channel).toBe(channel);
    expect(a.conversation).toBe('peer-1');
    expect(a.id).toMatch(/^min-\d+$/);
    expect(b.id).toMatch(/^min-\d+$/);
    expect(minIdNumber(b.id)).toBe(minIdNumber(a.id) + 1);
  });
});

describe('MinimalTextAdapter — sendText error paths', () => {
  it('throws PayloadTooLargeError when text exceeds maxTextLength', async () => {
    const adapter = new MinimalTextAdapter();
    const over = 'a'.repeat(adapter.capabilities.maxTextLength + 1);
    await expect(adapter.sendText(target, over)).rejects.toBeInstanceOf(
      PayloadTooLargeError,
    );
  });

  it('PayloadTooLargeError carries the operation, scope, and channel context', async () => {
    const adapter = new MinimalTextAdapter();
    const over = 'a'.repeat(adapter.capabilities.maxTextLength + 1);
    try {
      await adapter.sendText(target, over);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PayloadTooLargeError);
      const e = err as PayloadTooLargeError;
      expect(e.payload.operation).toBe('sendText');
      expect(e.payload.scope).toBe('request');
      expect(e.payload.channelId).toBe(channel);
      expect(e.payload.correlationId).toMatch(/^min-\d+$/);
      expect(e.payload.code).toBe('transport.payload_too_large');
    }
  });

  it('throws ConversationNotFoundError when target channel does not match', async () => {
    const adapter = new MinimalTextAdapter();
    const wrongChannel = makeChannelId('whatsapp', 'other');
    const wrongTarget: ConversationRef = { channel: wrongChannel, id: 'peer-1' };
    await expect(adapter.sendText(wrongTarget, 'hi')).rejects.toBeInstanceOf(
      ConversationNotFoundError,
    );
  });

  it('error path still increments the msg counter (correlationId monotonic)', async () => {
    const adapter = new MinimalTextAdapter();
    const wrongChannel = makeChannelId('whatsapp', 'other');
    const wrongTarget: ConversationRef = { channel: wrongChannel, id: 'peer-1' };
    let firstId: string | undefined;
    try {
      await adapter.sendText(wrongTarget, 'hi');
    } catch (err) {
      firstId = (err as ConversationNotFoundError).payload.correlationId;
    }
    const next = await adapter.sendText(target, 'hello');
    expect(firstId).toMatch(/^min-\d+$/);
    expect(next.id).toMatch(/^min-\d+$/);
    expect(minIdNumber(next.id)).toBe(minIdNumber(firstId!) + 1);
  });
});
