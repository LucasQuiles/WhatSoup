// tests/transport/signal/inbound-extensions.test.ts
// Inbound routing of non-text envelopes to extension-event listeners.
//
// Closes the documented TODO at adapter.ts:601-602 ("route typing/receipt/
// reaction envelopes to their extension-event listeners"). The port surfaces
// reaction / read-receipt / remote-delete envelopes with discriminant `type`
// + a typed payload; the adapter routes them to the matching listeners.
// Inbound typing envelopes are still dropped in v1 — the contract has no
// `typing` event (typing is outbound-only via SupportsTyping).
//
// Envelope shapes verified against signal-cli-jsonrpc(5) and the
// libsignal protocol: reactions and remote-delete both ride dataMessage
// (with a `reaction` or `delete` sub-object); read receipts ride a
// top-level `receiptMessage` with `type: "READ"` and `timestamps: [...]`.
import { describe, it, expect } from 'vitest';
import { SignalCliPort, type SignalRpcConnection } from '../../../src/transport/signal/signal-cli-port.ts';
import { DEFAULT_SIGNAL, type SignalConfig } from '../../../src/transport/signal/types.ts';
import type { SignalPortError } from '../../../src/transport/signal/port.ts';
import { SignalAdapter } from '../../../src/transport/signal/adapter.ts';
import { MockSignalPort, makeSignalConfig } from './mock-port.ts';
import type {
  ReactionEvent,
  ReadEvent,
  DeleteEvent,
} from '../../../src/transport/contract/events.ts';

// ---------------------------------------------------------------------------
// Port-level scripted mock (mirrors signal-cli-port.test.ts pattern)
// ---------------------------------------------------------------------------

class MockRpcConnection implements SignalRpcConnection {
  readonly calls: { method: string; params?: Record<string, unknown> }[] = [];
  private readonly handlers = new Map<string, (params?: Record<string, unknown>) => unknown>();

  on(method: string, handler: (params?: Record<string, unknown>) => unknown): this {
    this.handlers.set(method, handler);
    return this;
  }
  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params });
    const h = this.handlers.get(method);
    if (!h) throw Object.assign(new Error(`no mock for ${method}`), { code: 'Unmocked' }) satisfies SignalPortError;
    return h(params);
  }
  close(): void {}
}

function makePortConfig(overrides: Partial<SignalConfig> = {}): SignalConfig {
  return { account: 'test', phoneNumber: '+15551110000', ...DEFAULT_SIGNAL, ...overrides };
}

function portWithEnvelope(...envelopes: object[]): { port: SignalCliPort; mock: MockRpcConnection } {
  const mock = new MockRpcConnection();
  mock.on('receive', () => envelopes.map((envelope) => ({ envelope })));
  const port = new SignalCliPort(makePortConfig(), () => mock);
  return { port, mock };
}

// ---------------------------------------------------------------------------
// Adapter helper
// ---------------------------------------------------------------------------

function makeAdapter(port: MockSignalPort = new MockSignalPort()) {
  const adapter = new SignalAdapter(makeSignalConfig({ pollIntervalMs: 0 }), port);
  return { adapter, port };
}

// ===========================================================================
// PORT — surfaces reaction / read / delete envelopes
// ===========================================================================

describe('SignalCliPort — extension-envelope surfacing', () => {
  it('surfaces a dataMessage.reaction envelope as type="reaction" with payload', async () => {
    const { port } = portWithEnvelope({
      sourceUuid: 'uuid-peer-1',
      timestamp: 5000,
      dataMessage: {
        reaction: {
          emoji: '👍',
          targetAuthorUuid: 'uuid-me',
          targetSentTimestamp: 4000,
          isRemove: false,
        },
      },
    });
    const out = await port.listInboundSince(new Date(0));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      timestamp: 5000,
      source: 'uuid-peer-1',
      type: 'reaction',
      fromMe: false,
      body: null,
    });
    expect(out[0].reaction).toEqual({
      emoji: '👍',
      remove: false,
      targetTimestamp: 4000,
      targetAuthor: 'uuid-me',
    });
  });

  it('surfaces a reaction removal (isRemove:true) with remove:true in the payload', async () => {
    const { port } = portWithEnvelope({
      sourceUuid: 'uuid-peer-1',
      timestamp: 5000,
      dataMessage: {
        reaction: {
          emoji: '👍',
          targetAuthorUuid: 'uuid-me',
          targetSentTimestamp: 4000,
          isRemove: true,
        },
      },
    });
    const out = await port.listInboundSince(new Date(0));
    expect(out[0]?.reaction?.remove).toBe(true);
  });

  it('surfaces a read receipt as type="read" with the receipt timestamps', async () => {
    const { port } = portWithEnvelope({
      sourceUuid: 'uuid-peer-1',
      timestamp: 5000,
      receiptMessage: {
        type: 'READ',
        timestamps: [4000, 4500],
      },
    });
    const out = await port.listInboundSince(new Date(0));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      timestamp: 5000,
      source: 'uuid-peer-1',
      type: 'read',
      body: null,
    });
    expect(out[0].read).toEqual({ timestamps: [4000, 4500] });
  });

  it('does NOT surface a DELIVERY receipt as a read event (type!="READ")', async () => {
    const { port } = portWithEnvelope({
      sourceUuid: 'uuid-peer-1',
      timestamp: 5000,
      receiptMessage: { type: 'DELIVERY', timestamps: [4000] },
    });
    const out = await port.listInboundSince(new Date(0));
    // Delivery receipts are not read receipts — port drops them (no extension
    // event for delivery in v1; durability tracks delivery via sync echoes).
    expect(out).toHaveLength(0);
  });

  it('surfaces a remote-delete as type="delete" with target timestamp + author', async () => {
    const { port } = portWithEnvelope({
      sourceUuid: 'uuid-peer-1',
      timestamp: 5000,
      dataMessage: {
        delete: {
          targetSentTimestamp: 4000,
        },
      },
    });
    const out = await port.listInboundSince(new Date(0));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      timestamp: 5000,
      source: 'uuid-peer-1',
      type: 'delete',
      body: null,
    });
    // targetAuthor is the deleter (the envelope source) for remote-delete.
    expect(out[0].delete).toEqual({
      targetTimestamp: 4000,
      targetAuthor: 'uuid-peer-1',
    });
  });

  it('still surfaces a normal text dataMessage as type="data" (regression guard)', async () => {
    const { port } = portWithEnvelope({
      sourceUuid: 'uuid-peer-1',
      timestamp: 5000,
      dataMessage: { message: 'plain text' },
    });
    const out = await port.listInboundSince(new Date(0));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'data', body: 'plain text' });
    expect(out[0].reaction).toBeUndefined();
    expect(out[0].read).toBeUndefined();
    expect(out[0].delete).toBeUndefined();
  });
});

// ===========================================================================
// ADAPTER — routes extension envelopes to the matching listeners
// ===========================================================================

describe('SignalAdapter — inbound extension-event routing', () => {
  it('emits a ReactionEvent to the "reaction" listener on an inbound reaction', async () => {
    const { adapter } = makeAdapter();
    await adapter.connect();
    const events: ReactionEvent[] = [];
    adapter.on('reaction', (e) => events.push(e));

    adapter.handleInboundRecord({
      timestamp: 5000,
      source: 'uuid-peer-1',
      destination: '+15551234567',
      body: null,
      fromMe: false,
      type: 'reaction',
      reaction: {
        emoji: '👍',
        remove: false,
        targetTimestamp: 4000,
        targetAuthor: '+15551234567',
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      emoji: '👍',
      removed: false,
    });
    // target MessageRef points at the reacted-to message.
    expect(events[0].target.id).toBe('4000');
    expect(events[0].target.conversation).toBe('+15551234567');
    // actor is the reactor.
    expect(events[0].actor.id).toBe('uuid-peer-1');
    await adapter.disconnect();
  });

  it('emits a ReactionEvent with removed:true on an inbound reaction removal', async () => {
    const { adapter } = makeAdapter();
    await adapter.connect();
    const events: ReactionEvent[] = [];
    adapter.on('reaction', (e) => events.push(e));

    adapter.handleInboundRecord({
      timestamp: 5000,
      source: 'uuid-peer-1',
      destination: 'me',
      body: null,
      fromMe: false,
      type: 'reaction',
      reaction: { emoji: '', remove: true, targetTimestamp: 4000, targetAuthor: 'me' },
    });

    expect(events[0]?.removed).toBe(true);
    expect(events[0]?.emoji).toBe('');
    await adapter.disconnect();
  });

  it('emits a ReadEvent to the "read" listener for each read timestamp', async () => {
    const { adapter } = makeAdapter();
    await adapter.connect();
    const events: ReadEvent[] = [];
    adapter.on('read', (e) => events.push(e));

    adapter.handleInboundRecord({
      timestamp: 5000,
      source: 'uuid-peer-1',
      destination: '+15551234567',
      body: null,
      fromMe: false,
      type: 'read',
      read: { timestamps: [4000, 4500] },
    });

    // One ReadEvent per timestamp — the contract's ReadEvent.target is a
    // single MessageRef, so a multi-timestamp receipt fans out.
    expect(events).toHaveLength(2);
    expect(events[0].target.id).toBe('4000');
    expect(events[1].target.id).toBe('4500');
    expect(events[0].reader.id).toBe('uuid-peer-1');
    await adapter.disconnect();
  });

  it('emits a DeleteEvent to the "delete" listener on an inbound remote-delete', async () => {
    const { adapter } = makeAdapter();
    await adapter.connect();
    const events: DeleteEvent[] = [];
    adapter.on('delete', (e) => events.push(e));

    adapter.handleInboundRecord({
      timestamp: 5000,
      source: 'uuid-peer-1',
      destination: 'me',
      body: null,
      fromMe: false,
      type: 'delete',
      delete: { targetTimestamp: 4000, targetAuthor: 'uuid-peer-1' },
    });

    expect(events).toHaveLength(1);
    expect(events[0].target.id).toBe('4000');
    // signal-cli remote-delete is always scope='everyone' (no delete-for-me
    // over the protocol).
    expect(events[0].scope).toBe('everyone');
    await adapter.disconnect();
  });

  it('does not emit a message event for an extension envelope (no double-delivery)', async () => {
    const { adapter } = makeAdapter();
    await adapter.connect();
    const messages: unknown[] = [];
    adapter.on('message', (m) => messages.push(m));
    const reactions: unknown[] = [];
    adapter.on('reaction', (e) => reactions.push(e));

    adapter.handleInboundRecord({
      timestamp: 5000,
      source: 'uuid-peer-1',
      destination: 'me',
      body: null,
      fromMe: false,
      type: 'reaction',
      reaction: { emoji: '👍', remove: false, targetTimestamp: 4000, targetAuthor: 'me' },
    });

    expect(messages).toHaveLength(0);
    expect(reactions).toHaveLength(1);
    await adapter.disconnect();
  });

  it('dedupes extension envelopes by timestamp (redelivery does not double-emit)', async () => {
    const { adapter } = makeAdapter();
    await adapter.connect();
    const reactions: ReactionEvent[] = [];
    adapter.on('reaction', (e) => reactions.push(e));

    const envelope = {
      timestamp: 5000,
      source: 'uuid-peer-1',
      destination: 'me',
      body: null,
      fromMe: false,
      type: 'reaction',
      reaction: { emoji: '👍', remove: false, targetTimestamp: 4000, targetAuthor: 'me' },
    };
    adapter.handleInboundRecord(envelope);
    adapter.handleInboundRecord(envelope);

    expect(reactions).toHaveLength(1);
    await adapter.disconnect();
  });

  it('isolates a throwing reaction listener from sibling listeners', async () => {
    const { adapter } = makeAdapter();
    await adapter.connect();
    const good: ReactionEvent[] = [];
    const bad = (): never => { throw new Error('listener bug'); };
    adapter.on('reaction', bad);
    adapter.on('reaction', (e) => good.push(e));

    adapter.handleInboundRecord({
      timestamp: 5000,
      source: 'uuid-peer-1',
      destination: 'me',
      body: null,
      fromMe: false,
      type: 'reaction',
      reaction: { emoji: '👍', remove: false, targetTimestamp: 4000, targetAuthor: 'me' },
    });

    expect(good).toHaveLength(1);
    await adapter.disconnect();
  });
});
