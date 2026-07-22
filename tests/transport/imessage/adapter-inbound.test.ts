// tests/transport/imessage/adapter-inbound.test.ts
import { describe, it, expect, vi } from 'vitest';
import { ImessageAdapter } from '../../../src/transport/imessage/adapter.ts';
import { MockImessagePort, makeImessageConfig } from './mock-port.ts';
import type { InboundMessage } from '../../../src/transport/contract/index.ts';
import type { InboundImessage } from '../../../src/transport/imessage/port.ts';

function makeAdapter(port: MockImessagePort = new MockImessagePort()) {
  const adapter = new ImessageAdapter(makeImessageConfig({ pollIntervalMs: 0 }), port);
  return { adapter, port };
}

function envelope(overrides: Partial<InboundImessage> = {}): InboundImessage {
  return {
    guid: 'guid-default',
    from: 'user@users.noreply.github.com',
    to: 'bot@users.noreply.github.com',
    body: 'hello',
    fromMe: false,
    kind: 'text',
    timestamp: 1000,
    ...overrides,
  };
}

describe('ImessageAdapter — handleInboundRecord', () => {
  it('emits a text envelope as InboundMessage', async () => {
    const { adapter } = makeAdapter();
    await adapter.connect();
    const received: InboundMessage[] = [];
    adapter.on('message', (m) => received.push(m));

    adapter.handleInboundRecord(envelope({ guid: 'guid-1', body: 'hi' }));

    expect(received).toHaveLength(1);
    expect(received[0].text).toBe('hi');
    expect(received[0].ref.id).toBe('guid-1');
    expect(received[0].ingestSeq).toBe(1);
    await adapter.disconnect();
  });

  it('keys the conversation on the peer (sender for inbound)', async () => {
    const { adapter } = makeAdapter();
    await adapter.connect();
    const received: InboundMessage[] = [];
    adapter.on('message', (m) => received.push(m));

    adapter.handleInboundRecord(envelope({ from: 'peer@users.noreply.github.com', to: 'us@users.noreply.github.com', fromMe: false }));

    expect(received[0].conversation.id).toBe('peer@users.noreply.github.com');
    expect(received[0].sender.id).toBe('peer@users.noreply.github.com');
    await adapter.disconnect();
  });

  it('keys the conversation on the peer (recipient for outbound echo)', async () => {
    const { adapter } = makeAdapter();
    await adapter.connect();
    const received: InboundMessage[] = [];
    adapter.on('message', (m) => received.push(m));

    adapter.handleInboundRecord(envelope({ from: 'us@users.noreply.github.com', to: 'peer@users.noreply.github.com', fromMe: true }));

    expect(received[0].conversation.id).toBe('peer@users.noreply.github.com');
    expect(received[0].sender.id).toBe(adapter.selfRef().id);
    expect(received[0].fromMe).toBe(true);
    await adapter.disconnect();
  });

  it('dedupes by guid (second delivery of same guid is dropped)', async () => {
    const { adapter } = makeAdapter();
    await adapter.connect();
    const received: InboundMessage[] = [];
    adapter.on('message', (m) => received.push(m));

    adapter.handleInboundRecord(envelope({ guid: 'same-guid', timestamp: 1000 }));
    adapter.handleInboundRecord(envelope({ guid: 'same-guid', timestamp: 1000 }));

    expect(received).toHaveLength(1);
    await adapter.disconnect();
  });

  it('bounds dedupe state when malformed direct identities are rejected', async () => {
    const { adapter } = makeAdapter();
    await adapter.connect();
    const received: InboundMessage[] = [];
    adapter.on('message', (message) => received.push(message));

    for (let index = 0; index <= 1000; index += 1) {
      expect(adapter.handleInboundRecord(envelope({
        guid: `malformed-${index}`,
        from: 'malformed@example',
      }))).toBe(false);
    }

    expect(received).toHaveLength(0);
    expect(adapter.handleInboundRecord(envelope({
      guid: 'malformed-0',
      from: 'user@users.noreply.github.com',
    }))).toBe(true);
    expect(received).toHaveLength(1);
    await adapter.disconnect();
  });

  it('does not let a rejected identity reserve its guid', async () => {
    const { adapter } = makeAdapter();
    await adapter.connect();
    const received: InboundMessage[] = [];
    adapter.on('message', (message) => received.push(message));

    expect(adapter.handleInboundRecord(envelope({
      guid: 'corrected-guid',
      from: 'malformed@example',
    }))).toBe(false);
    expect(adapter.handleInboundRecord(envelope({
      guid: 'corrected-guid',
      from: 'user@users.noreply.github.com',
    }))).toBe(true);
    expect(adapter.handleInboundRecord(envelope({
      guid: 'corrected-guid',
      from: 'user@users.noreply.github.com',
    }))).toBe(false);
    expect(received).toHaveLength(1);
    await adapter.disconnect();
  });

  it('does not let rejected identities evict an accepted guid', async () => {
    const { adapter } = makeAdapter();
    await adapter.connect();
    const received: InboundMessage[] = [];
    adapter.on('message', (message) => received.push(message));

    expect(adapter.handleInboundRecord(envelope({ guid: 'accepted-guid' }))).toBe(true);
    for (let index = 0; index < 1000; index += 1) {
      expect(adapter.handleInboundRecord(envelope({
        guid: `rejected-${index}`,
        from: 'malformed@example',
      }))).toBe(false);
    }

    expect(adapter.handleInboundRecord(envelope({ guid: 'accepted-guid' }))).toBe(false);
    expect(received).toHaveLength(1);
    await adapter.disconnect();
  });

  it('does not emit when disconnected', async () => {
    const { adapter } = makeAdapter();
    const received: InboundMessage[] = [];
    adapter.on('message', (m) => received.push(m));

    adapter.handleInboundRecord(envelope());
    expect(received).toHaveLength(0);
  });

  it('does not emit non-text envelopes (reaction/typing/read) as messages', async () => {
    const { adapter } = makeAdapter();
    await adapter.connect();
    const received: InboundMessage[] = [];
    adapter.on('message', (m) => received.push(m));

    expect(adapter.handleInboundRecord(envelope({ guid: 'reaction-guid', kind: 'reaction', body: null }))).toBe(false);
    expect(adapter.handleInboundRecord(envelope({ guid: 'typing-guid', kind: 'typing', body: null }))).toBe(false);
    expect(adapter.handleInboundRecord(envelope({ guid: 'read-guid', kind: 'read', body: null }))).toBe(false);

    expect(received).toHaveLength(0);
    await adapter.disconnect();
  });

  it('does not emit a text envelope with null body', async () => {
    const { adapter } = makeAdapter();
    await adapter.connect();
    const received: InboundMessage[] = [];
    adapter.on('message', (m) => received.push(m));

    expect(adapter.handleInboundRecord(envelope({ guid: 'corrected-null-body', kind: 'text', body: null }))).toBe(false);
    expect(adapter.handleInboundRecord(envelope({ guid: 'corrected-null-body', body: 'arrived later' }))).toBe(true);
    expect(received).toHaveLength(1);
    await adapter.disconnect();
  });

  it('does not let unsupported envelopes evict an accepted guid', async () => {
    const { adapter } = makeAdapter();
    await adapter.connect();
    const received: InboundMessage[] = [];
    adapter.on('message', (message) => received.push(message));

    expect(adapter.handleInboundRecord(envelope({ guid: 'accepted-before-unsupported' }))).toBe(true);
    for (let index = 0; index < 1000; index += 1) {
      expect(adapter.handleInboundRecord(envelope({
        guid: `unsupported-${index}`,
        kind: 'reaction',
        body: null,
      }))).toBe(false);
    }

    expect(adapter.handleInboundRecord(envelope({ guid: 'accepted-before-unsupported' }))).toBe(false);
    expect(received).toHaveLength(1);
    await adapter.disconnect();
  });

  it('increments ingestSeq monotonically across emissions', async () => {
    const { adapter } = makeAdapter();
    await adapter.connect();
    const received: InboundMessage[] = [];
    adapter.on('message', (m) => received.push(m));

    adapter.handleInboundRecord(envelope({ guid: 'g1', timestamp: 1 }));
    adapter.handleInboundRecord(envelope({ guid: 'g2', timestamp: 2 }));
    adapter.handleInboundRecord(envelope({ guid: 'g3', timestamp: 3 }));

    expect(received.map((m) => m.ingestSeq)).toEqual([1, 2, 3]);
    await adapter.disconnect();
  });
});

describe('ImessageAdapter — pollOnce integration', () => {
  it('emits each record returned by listInboundSince', async () => {
    const port = new MockImessagePort({
      nextInbound: [
        envelope({ guid: 'g1', timestamp: 1000, body: 'one' }),
        envelope({ guid: 'g2', timestamp: 2000, body: 'two' }),
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

  it('continues past a full rejected page without starving a later message', async () => {
    const records = [
      ...Array.from({ length: 500 }, (_, index) => envelope({
        guid: `rejected-page-${index}`,
        from: 'malformed@example',
        timestamp: 1000,
      })),
      envelope({ guid: 'valid-after-rejected-page', timestamp: 2000 }),
    ];
    const port = new MockImessagePort();
    port.listInboundSince = vi.fn(async (
      since: Date,
      pageSize = 500,
      offset = 0,
    ) => records
      .filter((record) => record.timestamp >= since.getTime())
      .slice(offset, offset + pageSize));
    const { adapter } = makeAdapter(port);
    await adapter.connect();
    const received: InboundMessage[] = [];
    adapter.on('message', (message) => received.push(message));

    await adapter.pollOnce();

    expect(received.map((message) => message.ref.id)).toEqual(['valid-after-rejected-page']);
    expect(port.listInboundSince).toHaveBeenNthCalledWith(1, new Date(0), 500, 0);
    expect(port.listInboundSince).toHaveBeenNthCalledWith(2, new Date(0), 500, 500);
    await adapter.disconnect();
  });

  it('drains same-timestamp records across the page boundary without loss', async () => {
    const records = Array.from({ length: 501 }, (_, index) => envelope({
      guid: `same-timestamp-${index}`,
      timestamp: 1000,
    }));
    const port = new MockImessagePort();
    port.listInboundSince = vi.fn(async (
      since: Date,
      pageSize = 500,
      offset = 0,
    ) => records
      .filter((record) => record.timestamp >= since.getTime())
      .slice(offset, offset + pageSize));
    const { adapter } = makeAdapter(port);
    await adapter.connect();
    const received: InboundMessage[] = [];
    adapter.on('message', (message) => received.push(message));

    await adapter.pollOnce();

    expect(received).toHaveLength(501);
    expect(new Set(received.map((message) => message.ref.id)).size).toBe(501);
    expect(port.listInboundSince).toHaveBeenNthCalledWith(1, new Date(0), 500, 0);
    expect(port.listInboundSince).toHaveBeenNthCalledWith(2, new Date(0), 500, 500);
    await adapter.disconnect();
  });

  it('bounds pages per poll and resumes the continuation on the next tick', async () => {
    const records = [
      ...Array.from({ length: 5000 }, (_, index) => envelope({
        guid: `unsupported-page-${index}`,
        kind: 'reaction',
        body: null,
        timestamp: 1000,
      })),
      envelope({ guid: 'valid-after-bounded-drain', timestamp: 2000 }),
    ];
    const port = new MockImessagePort();
    port.listInboundSince = vi.fn(async (
      since: Date,
      pageSize = 500,
      offset = 0,
    ) => records
      .filter((record) => record.timestamp >= since.getTime())
      .slice(offset, offset + pageSize));
    const { adapter } = makeAdapter(port);
    await adapter.connect();
    const received: InboundMessage[] = [];
    adapter.on('message', (message) => received.push(message));

    await adapter.pollOnce();
    expect(received).toHaveLength(0);
    expect(port.listInboundSince).toHaveBeenCalledTimes(10);

    await adapter.pollOnce();
    expect(received.map((message) => message.ref.id)).toEqual(['valid-after-bounded-drain']);
    expect(port.listInboundSince).toHaveBeenNthCalledWith(11, new Date(0), 500, 5000);
    await adapter.disconnect();
  });

  it('emits an error and stays connected on a transient poll failure', async () => {
    const port = new MockImessagePort();
    port.listInboundSince = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const { adapter } = makeAdapter(port);
    await adapter.connect();

    const errors: unknown[] = [];
    adapter.on('error', (e) => errors.push(e));

    await adapter.pollOnce();

    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toMatch(/iMessage transient error/);
    expect(adapter.state().state).toBe('connected');
    await adapter.disconnect();
  });

  it('emits an error and stops the loop on an auth poll failure', async () => {
    const port = new MockImessagePort();
    port.listInboundSince = vi.fn(async () => {
      throw Object.assign(new Error('Unauthorized'), { status: 401 });
    });
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

describe('ImessageAdapter — listener isolation', () => {
  it('a throwing message listener does not break sibling listeners', async () => {
    const { adapter } = makeAdapter();
    await adapter.connect();
    const good: InboundMessage[] = [];
    const bad = vi.fn(() => { throw new Error('listener bug'); });
    adapter.on('message', bad);
    adapter.on('message', (m) => good.push(m));

    adapter.handleInboundRecord(envelope({ guid: 'g1', timestamp: 7 }));
    adapter.handleInboundRecord(envelope({ guid: 'g2', timestamp: 8 }));

    expect(bad).toHaveBeenCalledTimes(2);
    expect(good).toHaveLength(2);
    await adapter.disconnect();
  });
});

describe('ImessageAdapter — group inbound', () => {
  it('keys a group envelope conversation on the chatGuid, sender stays the member address', async () => {
    const { adapter } = makeAdapter();
    await adapter.connect();
    const received: InboundMessage[] = [];
    adapter.on('message', (m) => received.push(m));

    adapter.handleInboundRecord({
      guid: 'g-group-1',
      from: 'member@users.noreply.github.com',
      to: 'iMessage;+;chatABC',
      chatGuid: 'iMessage;+;chatABC',
      body: 'group msg',
      fromMe: false,
      kind: 'text',
      timestamp: 5000,
    });

    expect(received).toHaveLength(1);
    expect(received[0].conversation.id).toBe('iMessage;+;chatABC');
    expect(received[0].sender.id).toBe('member@users.noreply.github.com');
    await adapter.disconnect();
  });

  it('isGroupConversation: true for iMessage;+; refs, false for DM guids and plain addresses', async () => {
    const { adapter } = makeAdapter();
    const channelId = adapter.channelId;
    expect(adapter.isGroupConversation({ channel: channelId, id: 'iMessage;+;chatABC' })).toBe(true);
    expect(adapter.isGroupConversation({ channel: channelId, id: 'iMessage;-;friend@users.noreply.github.com' })).toBe(false);
    expect(adapter.isGroupConversation({ channel: channelId, id: 'friend@users.noreply.github.com' })).toBe(false);
  });
});
