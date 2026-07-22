// tests/transport/imessage/adapter-lifecycle.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ImessageAdapter } from '../../../src/transport/imessage/adapter.ts';
import { MockImessagePort, makeImessageConfig } from './mock-port.ts';
import type { AdapterHealth, InboundMessage } from '../../../src/transport/contract/index.ts';
import type { InboundImessage } from '../../../src/transport/imessage/port.ts';

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
    const records = [
      { guid: 'g1', from: 'p1', to: 'me', body: '1', fromMe: false, kind: 'text', timestamp: now - 1000 },
      { guid: 'g2', from: 'p2', to: 'me', body: '2', fromMe: false, kind: 'text', timestamp: now - 500 },
    ];
    const port = new MockImessagePort();
    port.listInboundSince = vi.fn(async (
      since: Date,
      pageSize = 500,
      offset = 0,
    ) => records
      .filter((record) => record.timestamp >= since.getTime())
      .slice(offset, offset + pageSize));
    const adapter = new ImessageAdapter(makeImessageConfig({ pollIntervalMs: 0 }), port);
    await adapter.connect();
    await adapter.pollOnce();
    await adapter.pollOnce();

    expect(port.listInboundSince).toHaveBeenNthCalledWith(1, new Date(0), 500, 0);
    expect(port.listInboundSince).toHaveBeenNthCalledWith(2, new Date(now - 500), 500, 1);

    await adapter.disconnect();
  });

  it('resets an incomplete continuation when reconnecting', async () => {
    const now = 1_700_000_000_000;
    vi.setSystemTime(now);
    let records: InboundImessage[] = Array.from({ length: 5000 }, (_, index) => ({
      guid: `unsupported-${index}`,
      from: 'user@users.noreply.github.com',
      to: 'bot@users.noreply.github.com',
      body: null,
      fromMe: false,
      kind: 'reaction',
      timestamp: now,
    }));
    const port = new MockImessagePort();
    port.listInboundSince = vi.fn(async (
      since: Date,
      pageSize = 500,
      offset = 0,
    ) => records
      .filter((record) => record.timestamp >= since.getTime())
      .slice(offset, offset + pageSize));
    const adapter = new ImessageAdapter(makeImessageConfig({ pollIntervalMs: 1000 }), port);
    const received: InboundMessage[] = [];
    adapter.on('message', (message) => received.push(message));
    await adapter.connect();
    await adapter.pollOnce();
    expect(port.listInboundSince).toHaveBeenCalledTimes(10);

    await adapter.disconnect();
    vi.setSystemTime(now + 10_000);
    records = [{
      guid: 'fresh-after-reconnect',
      from: 'user@users.noreply.github.com',
      to: 'bot@users.noreply.github.com',
      body: 'fresh',
      fromMe: false,
      kind: 'text',
      timestamp: now + 10_000,
    }];
    await adapter.connect();
    await adapter.pollOnce();

    expect(received.map((message) => message.ref.id)).toEqual(['fresh-after-reconnect']);
    expect(port.listInboundSince).toHaveBeenNthCalledWith(
      11,
      new Date(now + 9_000),
      500,
      0,
    );
    await adapter.disconnect();
  });

  it('resets an incomplete continuation after auth-required reconnect', async () => {
    const now = 1_700_000_000_000;
    vi.setSystemTime(now);
    const fullPage = Array.from({ length: 500 }, (_, index) => ({
      guid: `auth-page-${index}`,
      from: 'user@users.noreply.github.com',
      to: 'bot@users.noreply.github.com',
      body: null,
      fromMe: false,
      kind: 'reaction',
      timestamp: now,
    }));
    let authenticated = false;
    const fresh = [{
      guid: 'fresh-after-auth',
      from: 'user@users.noreply.github.com',
      to: 'bot@users.noreply.github.com',
      body: 'fresh',
      fromMe: false,
      kind: 'text',
      timestamp: now + 10_000,
    }];
    const port = new MockImessagePort();
    port.listInboundSince = vi.fn(async (
      since: Date,
      pageSize = 500,
      offset = 0,
    ) => {
      if (authenticated) {
        return fresh
          .filter((record) => record.timestamp >= since.getTime())
          .slice(offset, offset + pageSize);
      }
      if (offset === 0) return fullPage;
      throw Object.assign(new Error('expired credential'), { status: 401 });
    });
    const adapter = new ImessageAdapter(makeImessageConfig({ pollIntervalMs: 1000 }), port);
    const received: InboundMessage[] = [];
    adapter.on('message', (message) => received.push(message));
    await adapter.connect();
    await adapter.pollOnce();
    expect(adapter.state().state).toBe('auth_required');

    authenticated = true;
    vi.setSystemTime(now + 10_000);
    await adapter.connect();
    await adapter.pollOnce();

    expect(received.map((message) => message.ref.id)).toEqual(['fresh-after-auth']);
    expect(port.listInboundSince).toHaveBeenNthCalledWith(
      3,
      new Date(now + 9_000),
      500,
      0,
    );
    await adapter.disconnect();
  });

  it('resets a completed boundary offset when reconnecting beyond its lookback', async () => {
    const now = 1_700_000_000_000;
    vi.setSystemTime(now);
    let records = [{
      guid: 'completed-boundary',
      from: 'user@users.noreply.github.com',
      to: 'bot@users.noreply.github.com',
      body: 'old',
      fromMe: false,
      kind: 'text',
      timestamp: now,
    }];
    const port = new MockImessagePort();
    port.listInboundSince = vi.fn(async (
      since: Date,
      pageSize = 500,
      offset = 0,
    ) => records
      .filter((record) => record.timestamp >= since.getTime())
      .slice(offset, offset + pageSize));
    const adapter = new ImessageAdapter(makeImessageConfig({ pollIntervalMs: 1000 }), port);
    const received: InboundMessage[] = [];
    adapter.on('message', (message) => received.push(message));
    await adapter.connect();
    await adapter.pollOnce();
    expect(received.map((message) => message.ref.id)).toEqual(['completed-boundary']);

    await adapter.disconnect();
    vi.setSystemTime(now + 10_000);
    records = [{
      guid: 'fresh-after-completed-boundary',
      from: 'user@users.noreply.github.com',
      to: 'bot@users.noreply.github.com',
      body: 'fresh',
      fromMe: false,
      kind: 'text',
      timestamp: now + 10_000,
    }];
    await adapter.connect();
    await adapter.pollOnce();

    expect(received.map((message) => message.ref.id)).toEqual([
      'completed-boundary',
      'fresh-after-completed-boundary',
    ]);
    expect(port.listInboundSince).toHaveBeenNthCalledWith(
      2,
      new Date(now + 9_000),
      500,
      0,
    );
    await adapter.disconnect();
  });

  it('resumes a partial continuation after a transient page failure', async () => {
    const fullPage = Array.from({ length: 500 }, (_, index) => ({
      guid: `transient-page-${index}`,
      from: 'user@users.noreply.github.com',
      to: 'bot@users.noreply.github.com',
      body: null,
      fromMe: false,
      kind: 'reaction',
      timestamp: 1000,
    }));
    const valid = {
      guid: 'valid-after-transient-page',
      from: 'user@users.noreply.github.com',
      to: 'bot@users.noreply.github.com',
      body: 'fresh',
      fromMe: false,
      kind: 'text',
      timestamp: 2000,
    };
    let failContinuation = true;
    const port = new MockImessagePort();
    port.listInboundSince = vi.fn(async (
      _since: Date,
      _pageSize = 500,
      offset = 0,
    ) => {
      if (offset === 0) return fullPage;
      if (failContinuation) {
        failContinuation = false;
        throw new Error('ECONNRESET');
      }
      return [valid];
    });
    const adapter = new ImessageAdapter(makeImessageConfig({ pollIntervalMs: 0 }), port);
    const received: InboundMessage[] = [];
    adapter.on('message', (message) => received.push(message));
    await adapter.connect();

    await adapter.pollOnce();
    expect(adapter.state().state).toBe('connected');
    expect(received).toHaveLength(0);
    await adapter.pollOnce();

    expect(received.map((message) => message.ref.id)).toEqual(['valid-after-transient-page']);
    expect(port.listInboundSince).toHaveBeenNthCalledWith(3, new Date(0), 500, 500);
    await adapter.disconnect();
  });

  it('drops an in-flight later page after disconnect and restarts cleanly', async () => {
    const fullPage = Array.from({ length: 500 }, (_, index) => ({
      guid: `in-flight-page-${index}`,
      from: 'user@users.noreply.github.com',
      to: 'bot@users.noreply.github.com',
      body: null,
      fromMe: false,
      kind: 'reaction',
      timestamp: 1000,
    }));
    const stale = {
      guid: 'stale-in-flight',
      from: 'user@users.noreply.github.com',
      to: 'bot@users.noreply.github.com',
      body: 'stale',
      fromMe: false,
      kind: 'text',
      timestamp: 2000,
    };
    const fresh = { ...stale, guid: 'fresh-after-in-flight-disconnect', body: 'fresh', timestamp: 3000 };
    let continuationStarted!: () => void;
    const started = new Promise<void>((resolve) => { continuationStarted = resolve; });
    let resolveContinuation!: (records: readonly typeof stale[]) => void;
    let reconnected = false;
    const port = new MockImessagePort();
    port.listInboundSince = vi.fn(async (
      _since: Date,
      _pageSize = 500,
      offset = 0,
    ) => {
      if (reconnected) return offset === 0 ? [fresh] : [];
      if (offset === 0) return fullPage;
      continuationStarted();
      return new Promise<readonly typeof stale[]>((resolve) => {
        resolveContinuation = resolve;
      });
    });
    const adapter = new ImessageAdapter(makeImessageConfig({ pollIntervalMs: 0 }), port);
    const received: InboundMessage[] = [];
    adapter.on('message', (message) => received.push(message));
    await adapter.connect();

    const polling = adapter.pollOnce();
    await started;
    await adapter.disconnect();
    resolveContinuation([stale]);
    await polling;
    expect(received).toHaveLength(0);

    reconnected = true;
    await adapter.connect();
    await adapter.pollOnce();
    expect(received.map((message) => message.ref.id)).toEqual(['fresh-after-in-flight-disconnect']);
    expect(port.listInboundSince).toHaveBeenNthCalledWith(3, new Date(0), 500, 0);
    await adapter.disconnect();
  });
});
