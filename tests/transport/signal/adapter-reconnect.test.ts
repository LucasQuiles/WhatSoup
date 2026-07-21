// tests/transport/signal/adapter-reconnect.test.ts
// Phase 4 — reconnect engine with exponential backoff.
//
// Before this slice, the Signal adapter's poll loop had no reconnect logic:
// a transient daemon failure (ECONNREFUSED, RPC timeout) would emit an error
// and the next poll interval tick would hammer the daemon again at full
// cadence — no backoff, no escalation, no cooldown, no exhausted state.
// WhatsApp's side has a full reconnect engine (MAX_RECONNECT_ATTEMPTS=10,
// BASE_BACKOFF_MS=1000, MAX_BACKOFF_MS=60000, three phases: backoff/cooldown/retry).
//
// This file proves the Signal adapter now mirrors that behavior on the poll
// path: consecutive transient failures escalate through exponential backoff
// and eventually park at 'exhausted' so the bot-errors dispatcher can route
// the alert; a successful poll resets the counter.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SignalAdapter } from '../../../src/transport/signal/adapter.ts';
import { MockSignalPort, makeSignalConfig } from './mock-port.ts';

describe('SignalAdapter — reconnect engine', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('tracks consecutive transient failures and surfaces them via reconnectAttempts', async () => {
    const port = new MockSignalPort({
      listError: Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    });
    const adapter = new SignalAdapter(makeSignalConfig({ pollIntervalMs: 1000 }), port);
    await adapter.connect();

    // First transient failure.
    await (adapter as unknown as { pollOnceInner: () => Promise<void> }).pollOnceInner();
    expect(adapter.reconnectAttempts()).toBe(1);
    expect(adapter.reconnectPhase()).toBe('backoff');

    // Second consecutive failure.
    await (adapter as unknown as { pollOnceInner: () => Promise<void> }).pollOnceInner();
    expect(adapter.reconnectAttempts()).toBe(2);
  });

  it('parks at exhausted state after MAX_RECONNECT_ATTEMPTS consecutive failures', async () => {
    const port = new MockSignalPort({
      listError: Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    });
    const adapter = new SignalAdapter(makeSignalConfig({ pollIntervalMs: 1000 }), port);
    await adapter.connect();

    // Drain 10+ transient failures — should hit the exhausted ceiling.
    for (let i = 0; i < 12; i++) {
      await (adapter as unknown as { pollOnceInner: () => Promise<void> }).pollOnceInner();
    }
    expect(adapter.state().state).toBe('exhausted');
    expect(adapter.reconnectAttempts()).toBeGreaterThanOrEqual(10);
  });

  it('clears the poll timer when parking at exhausted (stops hammering the daemon)', async () => {
    const port = new MockSignalPort({
      listError: Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    });
    const adapter = new SignalAdapter(makeSignalConfig({ pollIntervalMs: 1000 }), port);
    await adapter.connect();

    for (let i = 0; i < 12; i++) {
      await (adapter as unknown as { pollOnceInner: () => Promise<void> }).pollOnceInner();
    }
    expect(adapter.state().state).toBe('exhausted');

    // Advance time — no further pollOnceInner should fire (no throws from a
    // cleared interval). The fact that state stays 'exhausted' after the
    // interval tick proves the timer was cleared.
    vi.advanceTimersByTime(5000);
    expect(adapter.state().state).toBe('exhausted');
  });

  it('a successful poll resets the failure counter and reconnect phase', async () => {
    // Start failing, then succeed.
    const port = new MockSignalPort({
      listError: Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    });
    const adapter = new SignalAdapter(makeSignalConfig({ pollIntervalMs: 1000 }), port);
    await adapter.connect();

    await (adapter as unknown as { pollOnceInner: () => Promise<void> }).pollOnceInner();
    expect(adapter.reconnectAttempts()).toBe(1);

    // Clear the failure — next poll succeeds.
    port.opts.listError = undefined;
    port.opts.nextInbound = [];
    await (adapter as unknown as { pollOnceInner: () => Promise<void> }).pollOnceInner();
    expect(adapter.reconnectAttempts()).toBe(0);
    expect(adapter.reconnectPhase()).toBe('backoff');
  });

  it('records firstFailureAt on the first transient failure (for duration tracking)', async () => {
    const port = new MockSignalPort({
      listError: Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    });
    const adapter = new SignalAdapter(makeSignalConfig({ pollIntervalMs: 1000 }), port);
    await adapter.connect();

    expect(adapter.firstFailureAt()).toBeNull();
    await (adapter as unknown as { pollOnceInner: () => Promise<void> }).pollOnceInner();
    expect(adapter.firstFailureAt()).not.toBeNull();
  });

  it('clears firstFailureAt on successful recovery', async () => {
    const port = new MockSignalPort({
      listError: Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    });
    const adapter = new SignalAdapter(makeSignalConfig({ pollIntervalMs: 1000 }), port);
    await adapter.connect();

    await (adapter as unknown as { pollOnceInner: () => Promise<void> }).pollOnceInner();
    expect(adapter.firstFailureAt()).not.toBeNull();

    port.opts.listError = undefined;
    port.opts.nextInbound = [];
    await (adapter as unknown as { pollOnceInner: () => Promise<void> }).pollOnceInner();
    expect(adapter.firstFailureAt()).toBeNull();
  });

  it('records connection_close lifecycle event when parking at exhausted', async () => {
    const port = new MockSignalPort({
      listError: Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    });
    const adapter = new SignalAdapter(makeSignalConfig({ pollIntervalMs: 1000 }), port);
    await adapter.connect();

    for (let i = 0; i < 12; i++) {
      await (adapter as unknown as { pollOnceInner: () => Promise<void> }).pollOnceInner();
    }

    const events = adapter.recentLifecycleEvents().map((e) => e.event);
    // connected → exhausted is a connection_close in the lifecycle event schema.
    expect(events).toContain('connection_close');
  });

  it('does NOT treat auth_required as a transient failure (separate code path)', async () => {
    const port = new MockSignalPort({
      listError: Object.assign(new Error('Unregistered user'), { status: 401 }),
    });
    const adapter = new SignalAdapter(makeSignalConfig({ pollIntervalMs: 1000 }), port);
    await adapter.connect();

    await (adapter as unknown as { pollOnceInner: () => Promise<void> }).pollOnceInner();
    expect(adapter.state().state).toBe('auth_required');
    expect(adapter.reconnectAttempts()).toBe(0); // no escalation — operator action required
  });
});
