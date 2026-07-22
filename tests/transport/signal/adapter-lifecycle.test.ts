// tests/transport/signal/adapter-lifecycle.test.ts
// connect / disconnect / state transitions and the poll loop wiring.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SignalAdapter } from '../../../src/transport/signal/adapter.ts';
import { MockSignalPort, makeSignalConfig } from './mock-port.ts';
import type { AdapterHealth } from '../../../src/transport/contract/index.ts';
import type { InboundSignal } from '../../../src/transport/signal/port.ts';

describe('SignalAdapter — lifecycle', () => {
  it('connect() calls verifyCredentials and transitions to connected', async () => {
    const port = new MockSignalPort();
    const adapter = new SignalAdapter(makeSignalConfig({ pollIntervalMs: 60_000 }), port);
    const states: string[] = [];
    adapter.on('state', (e: AdapterHealth) => states.push(e.state));

    await adapter.connect();

    expect(port.verifyCalls).toBe(1);
    expect(adapter.state().state).toBe('connected');
    // starting → connected
    expect(states).toEqual(['starting', 'connected']);
    await adapter.disconnect();
  });

  it('connect() maps a verifyCredentials auth failure to AuthRequiredError and stays disconnected', async () => {
    const port = new MockSignalPort({ verifyError: Object.assign(new Error('unlinked'), { status: 401 }) });
    const adapter = new SignalAdapter(makeSignalConfig(), port);

    await expect(adapter.connect()).rejects.toThrow(/Signal auth error/);
    expect(adapter.state().state).toBe('disconnected');
  });

  it('maps signal-cli numeric RPC errors with an unregistered message to AuthRequiredError', async () => {
    const port = new MockSignalPort({
      verifyError: Object.assign(new Error('User is not registered'), { code: '-1' }),
    });
    const adapter = new SignalAdapter(makeSignalConfig(), port);

    await expect(adapter.connect()).rejects.toThrow(/Signal auth error/);
    expect(adapter.state().state).toBe('disconnected');
  });

  it('connect() maps a transient verify failure to TransientProviderError', async () => {
    const port = new MockSignalPort({ verifyError: new Error('ECONNREFUSED') });
    const adapter = new SignalAdapter(makeSignalConfig(), port);

    await expect(adapter.connect()).rejects.toThrow(/Signal transient error/);
    expect(adapter.state().state).toBe('disconnected');
  });

  it('disconnect() transitions to disconnected and stops the poll loop', async () => {
    const port = new MockSignalPort();
    const adapter = new SignalAdapter(makeSignalConfig(), port);
    const states: string[] = [];
    adapter.on('state', (e: AdapterHealth) => states.push(e.state));

    await adapter.connect();
    await adapter.disconnect();

    expect(adapter.state().state).toBe('disconnected');
    // starting → connected → disconnected
    expect(states).toEqual(['starting', 'connected', 'disconnected']);
  });

  it('connect() is idempotent: a second connect does not leak the previous poll interval', async () => {
    const port = new MockSignalPort();
    const adapter = new SignalAdapter(makeSignalConfig({ pollIntervalMs: 50 }), port);

    await adapter.connect();
    await adapter.connect();
    await adapter.disconnect();

    // No unhandled rejection from a leaked interval proves the guard works.
    expect(adapter.state().state).toBe('disconnected');
  });

  it('ignores a stale in-flight poll failure after a successful reconnect', async () => {
    const port = new MockSignalPort();
    let rejectStalePoll: ((error: Error) => void) | undefined;
    port.listInboundSince = vi.fn(() => new Promise<readonly InboundSignal[]>((_, reject) => {
      rejectStalePoll = reject;
    }));
    const adapter = new SignalAdapter(makeSignalConfig({ pollIntervalMs: 60_000 }), port);

    await adapter.connect();
    const stalePoll = adapter.pollOnce();
    await vi.waitFor(() => expect(rejectStalePoll).toBeTypeOf('function'));

    const reconnect = adapter.connect();
    rejectStalePoll!(Object.assign(new Error('unlinked'), { status: 401 }));
    await Promise.all([stalePoll, reconnect]);

    expect(adapter.state().state).toBe('connected');
    await adapter.disconnect();
  });

  it('does not discard a destructively drained poll batch when reconnect starts', async () => {
    const port = new MockSignalPort();
    let resolveStalePoll: ((records: readonly InboundSignal[]) => void) | undefined;
    port.listInboundSince = vi.fn(() => new Promise<readonly InboundSignal[]>((resolve) => {
      resolveStalePoll = resolve;
    }));
    const adapter = new SignalAdapter(makeSignalConfig({ pollIntervalMs: 60_000 }), port);
    const received: string[] = [];
    adapter.on('message', (message) => received.push(message.text ?? ''));

    await adapter.connect();
    const stalePoll = adapter.pollOnce();
    await vi.waitFor(() => expect(resolveStalePoll).toBeTypeOf('function'));

    const reconnect = adapter.connect();
    resolveStalePoll!([{
      timestamp: 12345,
      source: '+15559990000',
      destination: '+15551234567',
      body: 'already drained',
      fromMe: false,
      type: 'data',
    }]);
    await Promise.all([stalePoll, reconnect]);

    expect(received).toEqual(['already drained']);
    expect(adapter.state().state).toBe('connected');
    await adapter.disconnect();
  });
});

describe('SignalAdapter — poll loop', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('starts a poll interval on connect in poll mode', async () => {
    const port = new MockSignalPort();
    const adapter = new SignalAdapter(makeSignalConfig({ pollIntervalMs: 1000 }), port);
    await adapter.connect();

    // Spy on pollOnce via the adapter's prototype method.
    const spy = vi.spyOn(adapter, 'pollOnce');

    await vi.advanceTimersByTimeAsync(1000);
    expect(spy).toHaveBeenCalledTimes(1);

    await adapter.disconnect();
  });

  it('pollOnce is a no-op when disconnected', async () => {
    const port = new MockSignalPort();
    const adapter = new SignalAdapter(makeSignalConfig(), port);
    // Never connected — state is 'disconnected'.
    await adapter.pollOnce();
    expect(port.verifyCalls).toBe(0);
  });

  it('pollOnce never turns provider timestamps into a destructive receive cursor', async () => {
    const now = 1_700_000_000_000;
    vi.setSystemTime(now);
    const port = new MockSignalPort({
      nextInbound: [
        { timestamp: now - 1000, source: 'peer-a', destination: 'me', body: '1', fromMe: false, type: 'data' },
        { timestamp: now - 500,  source: 'peer-b', destination: 'me', body: '2', fromMe: false, type: 'data' },
      ],
    });
    const adapter = new SignalAdapter(makeSignalConfig({ pollIntervalMs: 60_000 }), port);
    const receive = vi.spyOn(port, 'listInboundSince');
    await adapter.connect();
    await adapter.pollOnce();
    await adapter.pollOnce();

    expect(receive).toHaveBeenNthCalledWith(1, new Date(0), 500);
    expect(receive).toHaveBeenNthCalledWith(2, new Date(0), 500);

    await adapter.disconnect();
  });
});
