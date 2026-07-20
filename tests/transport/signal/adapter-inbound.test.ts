// tests/transport/signal/adapter-inbound.test.ts
// handleInboundRecord dedupe + emit + pollOnce integration + listener isolation.
import { describe, it, expect, vi } from 'vitest';
import { SignalAdapter } from '../../../src/transport/signal/adapter.ts';
import { MockSignalPort, makeSignalConfig } from './mock-port.ts';
import type { InboundMessage } from '../../../src/transport/contract/index.ts';
import type { InboundSignal } from '../../../src/transport/signal/port.ts';

function makeAdapter(port: MockSignalPort = new MockSignalPort()) {
  const adapter = new SignalAdapter(makeSignalConfig({ pollIntervalMs: 0 }), port);
  return { adapter, port };
}

function envelope(overrides: Partial<InboundSignal> = {}): InboundSignal {
  return {
    timestamp: 1000,
    source: '01234567-89ab-cdef-0123-456789abcdef',
    destination: 'fedcba98-7654-3210-fedc-ba9876543210',
    body: 'hello',
    fromMe: false,
    type: 'data',
    ...overrides,
  };
}

describe('SignalAdapter — handleInboundRecord', () => {
  it('emits a data envelope as InboundMessage', async () => {
    const { adapter } = makeAdapter();
    await adapter.connect();
    const received: InboundMessage[] = [];
    adapter.on('message', (m) => received.push(m));

    adapter.handleInboundRecord(envelope({ body: 'hi', timestamp: 12345 }));

    expect(received).toHaveLength(1);
    expect(received[0].text).toBe('hi');
    expect(received[0].ref.id).toBe('12345');
    expect(received[0].ingestSeq).toBe(1);
    await adapter.disconnect();
  });

  it('keys the conversation on the peer (sender for inbound)', async () => {
    const { adapter } = makeAdapter();
    await adapter.connect();
    const received: InboundMessage[] = [];
    adapter.on('message', (m) => received.push(m));

    adapter.handleInboundRecord(envelope({
      source: 'peer-uuid', destination: 'me-uuid', fromMe: false,
    }));

    expect(received[0].conversation.id).toBe('peer-uuid');
    expect(received[0].sender.id).toBe('peer-uuid');
    await adapter.disconnect();
  });

  it('keys the conversation on the peer (recipient for outbound echo)', async () => {
    const { adapter } = makeAdapter();
    await adapter.connect();
    const received: InboundMessage[] = [];
    adapter.on('message', (m) => received.push(m));

    adapter.handleInboundRecord(envelope({
      source: 'me-uuid', destination: 'peer-uuid', fromMe: true,
    }));

    expect(received[0].conversation.id).toBe('peer-uuid');
    expect(received[0].sender.id).toBe(adapter.selfRef().id);  // our phone number
    expect(received[0].fromMe).toBe(true);
    await adapter.disconnect();
  });

  it('dedupes by timestamp (second delivery of same timestamp is dropped)', async () => {
    const { adapter } = makeAdapter();
    await adapter.connect();
    const received: InboundMessage[] = [];
    adapter.on('message', (m) => received.push(m));

    adapter.handleInboundRecord(envelope({ timestamp: 5000 }));
    adapter.handleInboundRecord(envelope({ timestamp: 5000 }));

    expect(received).toHaveLength(1);
    await adapter.disconnect();
  });

  it('does not emit when disconnected', async () => {
    const { adapter } = makeAdapter();
    // Never connected.
    const received: InboundMessage[] = [];
    adapter.on('message', (m) => received.push(m));

    adapter.handleInboundRecord(envelope());
    expect(received).toHaveLength(0);
  });

  it('does not emit non-data envelopes (typing/receipt/etc.) as messages', async () => {
    const { adapter } = makeAdapter();
    await adapter.connect();
    const received: InboundMessage[] = [];
    adapter.on('message', (m) => received.push(m));

    adapter.handleInboundRecord(envelope({ type: 'receipt', body: null }));
    adapter.handleInboundRecord(envelope({ type: 'typing', body: null }));

    expect(received).toHaveLength(0);
    await adapter.disconnect();
  });

  it('does not emit a data envelope with null body', async () => {
    const { adapter } = makeAdapter();
    await adapter.connect();
    const received: InboundMessage[] = [];
    adapter.on('message', (m) => received.push(m));

    adapter.handleInboundRecord(envelope({ type: 'data', body: null }));
    expect(received).toHaveLength(0);
    await adapter.disconnect();
  });

  it('increments ingestSeq monotonically across emissions', async () => {
    const { adapter } = makeAdapter();
    await adapter.connect();
    const received: InboundMessage[] = [];
    adapter.on('message', (m) => received.push(m));

    adapter.handleInboundRecord(envelope({ timestamp: 1 }));
    adapter.handleInboundRecord(envelope({ timestamp: 2 }));
    adapter.handleInboundRecord(envelope({ timestamp: 3 }));

    expect(received.map((m) => m.ingestSeq)).toEqual([1, 2, 3]);
    await adapter.disconnect();
  });
});

describe('SignalAdapter — pollOnce integration', () => {
  it('emits each record returned by listInboundSince', async () => {
    const port = new MockSignalPort({
      nextInbound: [
        envelope({ timestamp: 1000, body: 'one' }),
        envelope({ timestamp: 2000, body: 'two' }),
      ],
    });
    const { adapter } = makeAdapter(port);
    await adapter.connect();
    const received: InboundMessage[] = [];
    adapter.on('message', (m) => received.push(m));

    await adapter.pollOnce();
    expect(received.map((m) => m.text)).toEqual(['one', 'two']);
    await adapter.disconnect();
  });

  it('emits an error and stays connected on a transient poll failure', async () => {
    const transientErr = Object.assign(new Error('ECONNREFUSED'), {});  // no status, no code
    const port = new MockSignalPort();
    port.listInboundSince = vi.fn(async () => { throw transientErr; });
    const { adapter } = makeAdapter(port);
    await adapter.connect();

    const errors: unknown[] = [];
    adapter.on('error', (e) => errors.push(e));

    await adapter.pollOnce();

    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toMatch(/Signal transient error/);
    expect(adapter.state().state).toBe('connected');  // still polling
    await adapter.disconnect();
  });

  it('emits an error and stops the loop on an auth poll failure', async () => {
    const authErr = Object.assign(new Error('unlinked'), { status: 401 });
    const port = new MockSignalPort();
    port.listInboundSince = vi.fn(async () => { throw authErr; });
    const { adapter } = makeAdapter(port);
    await adapter.connect();

    const errors: unknown[] = [];
    adapter.on('error', (e) => errors.push(e));

    await adapter.pollOnce();

    expect(errors).toHaveLength(1);
    expect(adapter.state().state).toBe('auth_required');
    await adapter.disconnect();
  });
});

describe('SignalAdapter — listener isolation', () => {
  it('a throwing message listener does not break sibling listeners or the loop', async () => {
    const { adapter } = makeAdapter();
    await adapter.connect();
    const good: InboundMessage[] = [];
    const bad = vi.fn(() => { throw new Error('listener bug'); });
    adapter.on('message', bad);
    adapter.on('message', (m) => good.push(m));

    adapter.handleInboundRecord(envelope({ timestamp: 7 }));
    adapter.handleInboundRecord(envelope({ timestamp: 8 }));

    expect(bad).toHaveBeenCalledTimes(2);
    expect(good).toHaveLength(2);  // both records delivered despite the throwing listener
    await adapter.disconnect();
  });

  it('a throwing state listener does not prevent the transition from taking effect', async () => {
    const { adapter } = makeAdapter();
    adapter.on('state', () => { throw new Error('state listener bug'); });
    await adapter.connect();
    expect(adapter.state().state).toBe('connected');  // transition succeeded regardless
  });
});

describe('SignalAdapter — group inbound', () => {
  it('keys a group envelope conversation on the groupId, sender stays the member UUID', async () => {
    const { adapter } = makeAdapter();
    await adapter.connect();
    const received: InboundMessage[] = [];
    adapter.on('message', (m) => received.push(m));

    adapter.handleInboundRecord({
      timestamp: 5000,
      source: 'uuid-member-1',
      destination: 'k28v5L3zR9yX2wQvN1mP7g==',
      groupId: 'k28v5L3zR9yX2wQvN1mP7g==',
      body: 'group msg',
      fromMe: false,
      type: 'data',
    });

    expect(received).toHaveLength(1);
    expect(received[0].conversation.id).toBe('k28v5L3zR9yX2wQvN1mP7g==');
    expect(received[0].sender.id).toBe('uuid-member-1');
    await adapter.disconnect();
  });

  it('isGroupConversation: true for group-id refs, false for UUID/E.164', async () => {
    const { adapter } = makeAdapter();
    const channelId = adapter.channelId;
    expect(adapter.isGroupConversation({ channel: channelId, id: 'k28v5L3zR9yX2wQvN1mP7g==' })).toBe(true);
    expect(adapter.isGroupConversation({ channel: channelId, id: '+15559990000' })).toBe(false);
    expect(adapter.isGroupConversation({ channel: channelId, id: 'a1b2c3d4-1234-1234-1234-a1b2c3d4e5f6' })).toBe(false);
  });
});
