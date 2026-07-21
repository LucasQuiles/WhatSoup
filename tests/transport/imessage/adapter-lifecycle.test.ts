// tests/transport/imessage/adapter-lifecycle.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ImessageAdapter } from '../../../src/transport/imessage/adapter.ts';
import { MockImessagePort, makeImessageConfig } from './mock-port.ts';
import type { AdapterHealth } from '../../../src/transport/contract/index.ts';

describe('ImessageAdapter — lifecycle', () => {
  it('connect() calls verifyCredentials and transitions to connected', async () => {
    const port = new MockImessagePort();
    const adapter = new ImessageAdapter(makeImessageConfig({ pollIntervalMs: 0 }), port);
    const states: string[] = [];
    adapter.on('state', (e: AdapterHealth) => states.push(e.state));

    await adapter.connect();

    expect(port.verifyCalls).toBe(1);
    expect(adapter.state().state).toBe('connected');
    expect(states).toEqual(['starting', 'connected']);
  });

  it('connect() maps a verifyCredentials auth failure to AuthRequiredError', async () => {
    const port = new MockImessagePort({
      verifyError: Object.assign(new Error('bad password'), { status: 401 }),
    });
    const adapter = new ImessageAdapter(makeImessageConfig(), port);

    await expect(adapter.connect()).rejects.toThrow(/iMessage auth error/);
    expect(adapter.state().state).toBe('disconnected');
  });

  it('connect() maps a transient verify failure to TransientProviderError', async () => {
    const port = new MockImessagePort({ verifyError: new Error('ECONNREFUSED') });
    const adapter = new ImessageAdapter(makeImessageConfig(), port);

    await expect(adapter.connect()).rejects.toThrow(/iMessage transient error/);
    expect(adapter.state().state).toBe('disconnected');
  });

  it('disconnect() transitions to disconnected and stops the poll loop', async () => {
    const port = new MockImessagePort();
    const adapter = new ImessageAdapter(makeImessageConfig(), port);
    const states: string[] = [];
    adapter.on('state', (e: AdapterHealth) => states.push(e.state));

    await adapter.connect();
    await adapter.disconnect();

    expect(adapter.state().state).toBe('disconnected');
    expect(states).toEqual(['starting', 'connected', 'disconnected']);
  });

  it('connect() is idempotent: a second connect does not leak the previous poll interval', async () => {
    const port = new MockImessagePort();
    const adapter = new ImessageAdapter(makeImessageConfig({ pollIntervalMs: 50 }), port);

    await adapter.connect();
    await adapter.connect();
    await adapter.disconnect();

    expect(adapter.state().state).toBe('disconnected');
  });
});

describe('ImessageAdapter — poll loop', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('starts a poll interval on connect in poll mode', async () => {
    const port = new MockImessagePort();
    const adapter = new ImessageAdapter(makeImessageConfig({ pollIntervalMs: 1000 }), port);
    await adapter.connect();

    const spy = vi.spyOn(adapter, 'pollOnce');
    await vi.advanceTimersByTimeAsync(1000);
    expect(spy).toHaveBeenCalledTimes(1);

    await adapter.disconnect();
  });

  it('does not start a poll interval when pollIntervalMs is 0', async () => {
    const port = new MockImessagePort();
    const adapter = new ImessageAdapter(makeImessageConfig({ pollIntervalMs: 0 }), port);
    await adapter.connect();

    const spy = vi.spyOn(adapter, 'pollOnce');
    await vi.advanceTimersByTimeAsync(5000);
    expect(spy).not.toHaveBeenCalled();

    await adapter.disconnect();
  });

  it('pollOnce is a no-op when disconnected', async () => {
    const port = new MockImessagePort();
    const adapter = new ImessageAdapter(makeImessageConfig(), port);
    await adapter.pollOnce();
    expect(port.verifyCalls).toBe(0);
  });

  it('pollOnce advances the cursor to the max timestamp seen', async () => {
    const now = 1_700_000_000_000;
    vi.setSystemTime(now);
    const port = new MockImessagePort({
      nextInbound: [
        { guid: 'g1', from: 'p1', to: 'me', body: '1', fromMe: false, kind: 'text', timestamp: now - 1000 },
        { guid: 'g2', from: 'p2', to: 'me', body: '2', fromMe: false, kind: 'text', timestamp: now - 500 },
      ],
    });
    const adapter = new ImessageAdapter(makeImessageConfig({ pollIntervalMs: 0 }), port);
    await adapter.connect();
    await adapter.pollOnce();

    // The cursor advanced past both timestamps; second call returns empty.
    const records = await port.listInboundSince(new Date(0));
    expect(records).toEqual([]);

    await adapter.disconnect();
  });
});
