// tests/transport/signal/adapter-inbound.test.ts
// handleInboundRecord dedupe + emit + pollOnce integration + listener isolation.
import { describe, it, expect, vi } from 'vitest';
import { SignalAdapter } from '../../../src/transport/signal/adapter.ts';
import { MockSignalPort, makeSignalConfig } from './mock-port.ts';
import type { InboundMessage } from '../../../src/transport/contract/index.ts';
import type { InboundSignal } from '../../../src/transport/signal/port.ts';

function makeAdapter(port: MockSignalPort = new MockSignalPort()) {
  const adapter = new SignalAdapter(makeSignalConfig({ pollIntervalMs: 60_000 }), port);
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
      source: 'me-uuid', destination: 'peer-uuid', fromMe: true, type: 'sync',
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

  it('retains same-timestamp messages from different senders in one group', async () => {
    const { adapter } = makeAdapter();
    await adapter.connect();
    const received: InboundMessage[] = [];
    adapter.on('message', (m) => received.push(m));

    adapter.handleInboundRecord(envelope({
      timestamp: 5000,
      source: 'member-a',
      destination: 'Z3JvdXAtY29udmVyc2F0aW9u',
      groupId: 'Z3JvdXAtY29udmVyc2F0aW9u',
    }));
    adapter.handleInboundRecord(envelope({
      timestamp: 5000,
      source: 'member-b',
      destination: 'Z3JvdXAtY29udmVyc2F0aW9u',
      groupId: 'Z3JvdXAtY29udmVyc2F0aW9u',
    }));

    expect(received.map((message) => message.sender.id)).toEqual(['member-a', 'member-b']);
    expect(received[0]?.inboundEventKey).not.toBe(received[1]?.inboundEventKey);
    await adapter.disconnect();
  });

  it('retains same-timestamp messages from one sender in different conversations', async () => {
    const { adapter } = makeAdapter();
    await adapter.connect();
    const received: InboundMessage[] = [];
    adapter.on('message', (m) => received.push(m));

    for (const groupId of ['Z3JvdXAtY29udmVyc2F0aW9u', 'YW5vdGhlci1jb252ZXJzYXRpb24=']) {
      adapter.handleInboundRecord(envelope({
        timestamp: 5000,
        source: 'member-a',
        destination: groupId,
        groupId,
      }));
    }

    expect(received.map((message) => message.conversation.id)).toEqual([
      'Z3JvdXAtY29udmVyc2F0aW9u',
      'YW5vdGhlci1jb252ZXJzYXRpb24=',
    ]);
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
  it('starts at the epoch so queued messages older than one poll interval are not discarded', async () => {
    const port = new MockSignalPort();
    const listInboundSince = vi.spyOn(port, 'listInboundSince').mockResolvedValue([]);
    const { adapter } = makeAdapter(port);
    await adapter.connect();

    await adapter.pollOnce();

    expect(listInboundSince).toHaveBeenCalledWith(new Date(0), 500);
    await adapter.disconnect();
  });
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

  it('treats poll-time signal-cli unregistration as auth-required without misclassifying send recipients', async () => {
    const authErr = Object.assign(new Error('User is not registered'), { code: '-1' });
    const port = new MockSignalPort();
    port.listInboundSince = vi.fn(async () => { throw authErr; });
    const { adapter } = makeAdapter(port);
    await adapter.connect();

    await adapter.pollOnce();

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
    await adapter.disconnect();
  });
});
