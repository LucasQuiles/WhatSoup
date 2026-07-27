import { describe, expect, it, vi } from 'vitest';
import { parseImsgRpcRelayArgs, runImsgRpcRelay } from '../../scripts/imsg-rpc-relay.ts';
import type { ImsgRpcRelay } from '../../src/transport/imessage/imsg-rpc-relay.ts';

describe('imsg rpc relay CLI', () => {
  it('requires explicit socket and binary paths', () => {
    expect(parseImsgRpcRelayArgs([
      '--socket', '/var/tmp/whatsoup-test/imsg.sock',
      '--imsg-bin', '/opt/homebrew/bin/imsg',
    ])).toEqual({
      socketPath: '/var/tmp/whatsoup-test/imsg.sock',
      imsgBinary: '/opt/homebrew/bin/imsg',
    });
    expect(() => parseImsgRpcRelayArgs(['--socket', '/tmp/imsg.sock'])).toThrow(/usage/);
    expect(() => parseImsgRpcRelayArgs(['--unknown', 'value'])).toThrow(/unknown/);
  });

  it('remains attached until the relay lifecycle terminates', async () => {
    let resolveStopped: () => void = () => undefined;
    const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });
    const relay: ImsgRpcRelay = {
      ready: Promise.resolve(),
      stopped,
      close: vi.fn(async () => undefined),
    };
    const startRelay = vi.fn(() => relay);
    const initialSigintListeners = process.listenerCount('SIGINT');
    const initialSigtermListeners = process.listenerCount('SIGTERM');
    let outcome: 'pending' | 'resolved' | 'rejected' = 'pending';

    const running = runImsgRpcRelay([
      '--socket', '/var/tmp/whatsoup-test/imsg.sock',
      '--imsg-bin', '/opt/homebrew/bin/imsg',
    ], startRelay).then(
      () => { outcome = 'resolved'; },
      () => { outcome = 'rejected'; },
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(startRelay).toHaveBeenCalledOnce();
    expect(outcome).toBe('pending');
    expect(process.listenerCount('SIGINT')).toBe(initialSigintListeners + 1);
    expect(process.listenerCount('SIGTERM')).toBe(initialSigtermListeners + 1);

    resolveStopped();
    await running;

    expect(outcome).toBe('resolved');
    expect(process.listenerCount('SIGINT')).toBe(initialSigintListeners);
    expect(process.listenerCount('SIGTERM')).toBe(initialSigtermListeners);
  });

  it('propagates runtime relay failure and removes signal listeners', async () => {
    let rejectStopped: (error: Error) => void = () => undefined;
    const stopped = new Promise<void>((_resolve, reject) => { rejectStopped = reject; });
    const relay: ImsgRpcRelay = {
      ready: Promise.resolve(),
      stopped,
      close: vi.fn(async () => undefined),
    };
    const initialSigintListeners = process.listenerCount('SIGINT');
    const initialSigtermListeners = process.listenerCount('SIGTERM');
    let settled = false;
    const running = runImsgRpcRelay([
      '--socket', '/var/tmp/whatsoup-test/imsg.sock',
      '--imsg-bin', '/opt/homebrew/bin/imsg',
    ], () => relay);
    void running.finally(() => { settled = true; }).catch(() => undefined);
    await Promise.resolve();
    await Promise.resolve();

    expect(settled).toBe(false);
    rejectStopped(new Error('injected relay runtime failure'));

    await expect(running).rejects.toThrow(/runtime failure/i);
    expect(process.listenerCount('SIGINT')).toBe(initialSigintListeners);
    expect(process.listenerCount('SIGTERM')).toBe(initialSigtermListeners);
  });
});
