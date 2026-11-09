import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OutboundGovernor, wrapWithOutboundGovernor } from '../../src/transport/outbound-governor.ts';

describe('authority final-send deadline', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('never submits a provider call after delayed admission outlives the send deadline', async () => {
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => { release = resolve; });
    const provider = vi.fn(async (..._args: unknown[]) => ({ key: { id: 'wire' } }));
    const receipt = vi.fn(async () => undefined);
    const socket = { sendMessage: provider };
    wrapWithOutboundGovernor(socket, {
      resolveDest: (jid) => jid,
      authorityGate: {
        admit: async () => {
          await delayed;
          return { attemptId: 'late', payloadDigest: 'digest', content: { text: 'hello' } };
        },
        recordReceipt: receipt,
      },
    });
    const outcome = Promise.resolve(socket.sendMessage('recipient', { text: 'hello' }))
      .then(() => 'accepted', () => 'rejected');
    await vi.advanceTimersByTimeAsync(30_001);
    release();
    await vi.runAllTimersAsync();
    expect(await outcome).toBe('rejected');
    expect(provider).not.toHaveBeenCalled();
    expect(receipt).toHaveBeenCalledWith({ attemptId: 'late', state: 'unknown' });
  });

  it('does not start authority admission after pacing exhausts the send budget', async () => {
    const provider = vi.fn(async (..._args: unknown[]) => ({ key: { id: 'wire' } }));
    const admission = vi.fn(async () => ({
      attemptId: 'admitted', payloadDigest: 'digest', content: { text: 'hello' },
    }));
    const socket = { sendMessage: provider };
    wrapWithOutboundGovernor(socket, {
      resolveDest: (jid) => jid,
      governor: new OutboundGovernor({
        windowMs: 40_000, maxPerWindow: 1, maxWaitMs: 45_000,
        hardCeiling: 100, hardCeilingWindowMs: 60_000,
        globalMaxPerWindow: 100, globalWindowMs: 100,
      }),
      authorityGate: { admit: admission, recordReceipt: async () => undefined },
    });
    await socket.sendMessage('recipient', { text: 'first' });
    const outcome = Promise.resolve(socket.sendMessage('recipient', { text: 'second' }))
      .then(() => 'accepted', () => 'rejected');
    await vi.advanceTimersByTimeAsync(40_001);
    expect(await outcome).toBe('rejected');
    expect(admission).toHaveBeenCalledTimes(1);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('records an unknown outcome when an already invoked provider never settles', async () => {
    let settle!: (result: { key: { id: string } }) => void;
    const provider = vi.fn((..._args: unknown[]) => new Promise<{ key: { id: string } }>((resolve) => {
      settle = resolve;
    }));
    const receipt = vi.fn(async () => undefined);
    const socket = { sendMessage: provider };
    wrapWithOutboundGovernor(socket, {
      resolveDest: (jid) => jid,
      authorityGate: {
        admit: async () => ({ attemptId: 'in-flight', payloadDigest: 'digest', content: { text: 'hello' } }),
        recordReceipt: receipt,
      },
    });
    const outcome = Promise.resolve(socket.sendMessage('recipient', { text: 'hello' }))
      .then(() => 'accepted', () => 'rejected');
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await outcome).toBe('rejected');
    expect(provider).toHaveBeenCalledTimes(1);
    expect(receipt).toHaveBeenCalledWith({ attemptId: 'in-flight', state: 'unknown' });
    settle({ key: { id: 'late-provider-result' } });
    await vi.runAllTimersAsync();
    expect(receipt).toHaveBeenCalledTimes(1);
  });

  it.each(['per-destination', 'global'] as const)('does not burn the long ceiling after expiry during %s pacing', async (bucket) => {
    const provider = vi.fn(async (..._args: unknown[]) => ({ key: { id: 'wire' } }));
    const socket = { sendMessage: provider };
    wrapWithOutboundGovernor(socket, {
      resolveDest: (jid) => jid,
      governor: new OutboundGovernor({
        windowMs: 40_000, maxPerWindow: bucket === 'global' ? 100 : 1, maxWaitMs: 45_000,
        hardCeiling: bucket === 'global' ? 1 : 2, hardCeilingWindowMs: 3_600_000,
        globalMaxPerWindow: bucket === 'global' ? 1 : 100, globalWindowMs: 40_000,
      }),
      authorityGate: {
        admit: async () => ({ attemptId: 'admitted', payloadDigest: 'digest', content: { text: 'hello' } }),
        recordReceipt: async () => undefined,
      },
    });
    await socket.sendMessage(bucket === 'global' ? 'other-recipient' : 'recipient', { text: 'first' });
    const expired = Promise.resolve(socket.sendMessage('recipient', { text: 'expired' }))
      .then(() => 'accepted', () => 'rejected');
    await vi.advanceTimersByTimeAsync(80_001);
    expect(await expired).toBe('rejected');
    await expect(socket.sendMessage('recipient', { text: 'later approved send' })).resolves.toBeDefined();
    expect(provider).toHaveBeenCalledTimes(2);
  });
});
