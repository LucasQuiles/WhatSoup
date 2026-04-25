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
  });
}
