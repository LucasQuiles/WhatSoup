import { describe, expect, it } from 'vitest';
import { runChannelChain } from '../../src/transport/chain.ts';
import type { Sink } from '../../src/transport/types.ts';

function fakeSink(name: string, succeed: boolean, calls: string[] = []): Sink {
  return {
    name,
    isDurableLog: name === 'local-log',
    async deliver() {
      calls.push(name);
      return succeed ? { ok: true, channel: name } : { ok: false, channel: name, error: 'forced' };
    },
  };
}

describe('runChannelChain', () => {
  it('returns succeeded on first non-durable sink that delivers', async () => {
    const calls: string[] = [];

    const result = await runChannelChain([
      fakeSink('whatsoup', true, calls),
      fakeSink('local-notify', true, calls),
    ], { body: 'x' });

    expect(result).toEqual({
      deliveries: [{ ok: true, channel: 'whatsoup' }],
      failedAll: false,
    });
    expect(calls).toEqual(['whatsoup']);
  });

  it('falls through on failure', async () => {
    const result = await runChannelChain([
      fakeSink('whatsoup', false),
      fakeSink('local-notify', true),
    ], { body: 'x' });

    expect(result.deliveries.map((delivery) => delivery.channel)).toEqual(['whatsoup', 'local-notify']);
    expect(result.deliveries[0]).toEqual({ ok: false, channel: 'whatsoup', error: 'forced' });
    expect(result.deliveries[1]).toEqual({ ok: true, channel: 'local-notify' });
    expect(result.failedAll).toBe(false);
  });

  it('continues after local-notify degraded delivery when a later sink succeeds', async () => {
    const result = await runChannelChain([
      fakeSink('local-notify', false),
      fakeSink('external-push', true),
    ], { body: 'x' });

    expect(result.deliveries).toEqual([
      { ok: false, channel: 'local-notify', error: 'forced' },
      { ok: true, channel: 'external-push' },
    ]);
    expect(result.failedAll).toBe(false);
  });

  it('continues past durable-log success because disk is audit trail, not delivery', async () => {
    const calls: string[] = [];

    const result = await runChannelChain([
      fakeSink('local-log', true, calls),
      fakeSink('external-push', true, calls),
    ], { body: 'x' });

    expect(result.deliveries.map((delivery) => delivery.channel)).toEqual(['local-log', 'external-push']);
    expect(result.failedAll).toBe(false);
    expect(calls).toEqual(['local-log', 'external-push']);
  });

  it('reports failedAll when only durable-log delivers', async () => {
    const result = await runChannelChain([
      fakeSink('whatsoup', false),
      fakeSink('local-notify', false),
      fakeSink('local-log', true),
    ], { body: 'x' });

    expect(result.deliveries.map((delivery) => delivery.channel)).toEqual(['whatsoup', 'local-notify', 'local-log']);
    expect(result.failedAll).toBe(true);
  });

  it('does not call sinks after a real success', async () => {
    let called = false;
    const probe: Sink = {
      name: 'probe',
      isDurableLog: false,
      async deliver() {
        called = true;
        return { ok: true, channel: 'probe' };
      },
    };

    await runChannelChain([fakeSink('whatsoup', true), probe], { body: 'x' });

    expect(called).toBe(false);
  });

  it('turns sink exceptions into failed deliveries and continues', async () => {
    const throwing: Sink = {
      name: 'throwing',
      isDurableLog: false,
      async deliver() {
        throw new Error('network down');
      },
    };

    const result = await runChannelChain([throwing, fakeSink('local-notify', true)], { body: 'x' });

    expect(result.deliveries).toEqual([
      { ok: false, channel: 'throwing', error: 'network down' },
      { ok: true, channel: 'local-notify' },
    ]);
    expect(result.failedAll).toBe(false);
  });
});
