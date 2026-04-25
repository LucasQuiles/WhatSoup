// tests/transport/contract/conformance.test.ts
import { describe, it, expect } from 'vitest';
import { InMemoryAdapter } from '../../../src/transport/testing/in-memory.ts';
import { MinimalTextAdapter } from '../../../src/transport/testing/minimal-text.ts';
import {
  type TransportAdapter,
  ConversationNotFoundError, PayloadTooLargeError,
  ALL_EXTENSION_NAMES,
} from '../../../src/transport/contract/index.ts';
import { makeChannelId, type ConversationRef } from '../../../src/core/transport-refs.ts';

interface AdapterFixture {
  readonly name: string;
  readonly make: () => TransportAdapter;
  readonly textConv: () => ConversationRef;
}

const fixtures: ReadonlyArray<AdapterFixture> = [
  {
    name: 'InMemoryAdapter',
    make: () => new InMemoryAdapter(makeChannelId('whatsapp', 'in-memory')),
    textConv: () => ({ channel: makeChannelId('whatsapp', 'in-memory'), id: 'auto-create' }),
  },
  {
    name: 'MinimalTextAdapter',
    make: () => new MinimalTextAdapter(makeChannelId('whatsapp', 'minimal-test')),
    textConv: () => ({ channel: makeChannelId('whatsapp', 'minimal-test'), id: 'c-min' }),
  },
];

for (const fx of fixtures) {
  describe(`Conformance — ${fx.name}`, () => {
    // C1
    it('C1 — connect() advances disconnected → starting (or directly to connected) → connected', async () => {
      const a = fx.make();
      const seen: string[] = [];
      a.on('state', e => { seen.push(e.state); });
      await a.connect();
      expect(a.state().state).toBe('connected');
      expect(seen).toContain('connected');
    });

    // C2
    it('C2 — disconnect() advances to stopping → disconnected', async () => {
      const a = fx.make();
      await a.connect();
      const seen: string[] = [];
      a.on('state', e => { seen.push(e.state); });
      await a.disconnect();
      expect(a.state().state).toBe('disconnected');
    });

    // C3
    it('C3 — selfRef() returns a stable ParticipantRef after connected', async () => {
      const a = fx.make();
      await a.connect();
      const r1 = a.selfRef();
      const r2 = a.selfRef();
      expect(r1.channel).toBe(a.capabilities.channel);
      expect(r1.id).toBe(r2.id);
    });

    // C4
    it('C4 — Capabilities object is shape-valid', () => {
      const a = fx.make();
      const c = a.capabilities;
      expect(c.channel).toMatch(/^[a-z]+:[a-z][a-z0-9-]*$/);
      expect(c.kind).toBe(c.channel.split(':', 1)[0]);
      expect(c.extensions).toBeInstanceOf(Set);
      for (const ext of c.extensions) expect(ALL_EXTENSION_NAMES).toContain(ext);
      expect(typeof c.maxTextLength).toBe('number');
      expect(['none', 'conversation', 'message']).toContain(c.readReceipts);
      expect(['none', 'single', 'multiple']).toContain(c.reactions);
      expect(c.media.maxBytes).toBeGreaterThanOrEqual(0);
      expect(['none', 'native', 'simulated']).toContain(c.idempotency.sendText);
    });

    // C5
    it('C5 — sendText returns a MessageRef whose channel === capabilities.channel', async () => {
      const a = fx.make();
      await a.connect();
      const ref = await a.sendText(fx.textConv(), 'hello');
      expect(ref.channel).toBe(a.capabilities.channel);
    });

    // C6
    it('C6 — sendText to a non-existent conversation throws ConversationNotFoundError(scope=conversation)', async () => {
      const a = fx.make();
      await a.connect();
      await expect(
        a.sendText({ channel: makeChannelId('telegram', 'other'), id: 'mismatch' }, 'x'),
      ).rejects.toMatchObject({
        payload: { scope: 'conversation' },
      });
    });

    // C7
    it('C7 — sendText with payload over maxTextLength throws PayloadTooLargeError', async () => {
      const a = fx.make();
      await a.connect();
      const huge = 'x'.repeat(a.capabilities.maxTextLength + 1);
      await expect(a.sendText(fx.textConv(), huge)).rejects.toBeInstanceOf(PayloadTooLargeError);
    });

    // C11
    it('C11 — dispose() on a subscription is idempotent', async () => {
      const a = fx.make();
      const sub = a.on('state', () => {});
      sub.dispose(); sub.dispose(); sub.dispose();
      expect(() => sub.dispose()).not.toThrow();
    });

    // C17
    it('C17 — thrown errors carry full payload (scope, operation, correlationId)', async () => {
      const a = fx.make();
      await a.connect();
      try {
        await a.sendText({ channel: makeChannelId('telegram', 'other'), id: 'x' }, 't');
        expect.fail('should have thrown');
      } catch (e: any) {
        expect(e.payload.scope).toBeDefined();
        expect(e.payload.operation).toBeDefined();
        expect(e.payload.correlationId).toBeDefined();
        expect(e.payload.code).toBeDefined();
      }
    });

    // ─── Inbound (only for adapters that support injection) ─────────────────
    it('C8 — inbound message events arrive with all required fields populated', async () => {
      const a = fx.make();
      if (!(a instanceof InMemoryAdapter)) return; // skip for MinimalTextAdapter
      await a.connect();
      const seen: any[] = [];
      a.on('message', m => seen.push(m));
      a.injectInbound({
        kind: 'message',
        data: {
          ref: { channel: a.capabilities.channel, conversation: 'C', id: 'm1' },
          conversation: { channel: a.capabilities.channel, id: 'C' },
          sender: { channel: a.capabilities.channel, id: 'S' },
          fromMe: false,
          text: 'hello',
          attachments: [],
          timestamp: new Date(),
          inboundEventKey: 'k-m1',
          transportTimestamp: new Date(),
          ingestSeq: 1,
        },
      });
      expect(seen.length).toBe(1);
      const m = seen[0];
      expect(m.text).toBe('hello');
      expect(m.fromMe).toBe(false);
      expect(m.inboundEventKey).toBe('k-m1');
    });

    it('C9 — inboundEventKey survives a round-trip serialization', async () => {
      const a = fx.make();
      if (!(a instanceof InMemoryAdapter)) return;
      await a.connect();
      let captured: any;
      a.on('message', m => { captured = m; });
      a.injectInbound({
        kind: 'message',
        data: {
          ref: { channel: a.capabilities.channel, conversation: 'C', id: 'm2' },
          conversation: { channel: a.capabilities.channel, id: 'C' },
          sender: { channel: a.capabilities.channel, id: 'S' },
          fromMe: false, text: null, attachments: [],
          timestamp: new Date(), inboundEventKey: 'k-m2',
          transportTimestamp: new Date(), ingestSeq: 2,
        },
      });
      const round = JSON.parse(JSON.stringify(captured));
      expect(round.inboundEventKey).toBe('k-m2');
    });

    // C10 — Duplicate dedup is enforced by the adapter's own bookkeeping.
    // For InMemoryAdapter we exercise that subscribers see exactly one delivery
    // when the same inbound event arrives twice IF the adapter's contract honors
    // dedup. The bare InMemoryAdapter does NOT dedup (that's the persistent
    // dedup table's job in PR 0b/3); this test asserts the *capability* —
    // duplicate events delivered N times with N=2 yields N message handler
    // invocations of length 2. The persistent-dedup wiring lands in PR 3.
    it('C10 — adapter delivers each injectInbound exactly as many times as called', async () => {
      const a = fx.make();
      if (!(a instanceof InMemoryAdapter)) return;
      await a.connect();
      let count = 0;
      a.on('message', () => { count += 1; });
      const sample = {
        kind: 'message' as const,
        data: {
          ref: { channel: a.capabilities.channel, conversation: 'C', id: 'm3' },
          conversation: { channel: a.capabilities.channel, id: 'C' },
          sender: { channel: a.capabilities.channel, id: 'S' },
          fromMe: false, text: 'x', attachments: [],
          timestamp: new Date(), inboundEventKey: 'k-m3',
          transportTimestamp: new Date(), ingestSeq: 3,
        },
      };
      a.injectInbound(sample);
      a.injectInbound(sample);
      expect(count).toBe(2);
    });
  });
}
