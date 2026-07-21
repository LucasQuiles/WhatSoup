// tests/transport/signal/adapter-lifecycle-events.test.ts
//  slice 2 — real lifecycle event accumulation in the Signal adapter.
//
// Before this slice, signalConnectionStateSnapshot() synthesized a 2-event
// timeline (connect_start + connection_open, or connection_close) on every
// call. That told ops what JUST happened but gave no history — a flapping
// daemon, an auth_required bounce, or a repeated disconnect/reconnect loop
// was invisible.
//
// This file proves the adapter now records every transitionTo() call as a
// CredentialLifecycleEvent in a bounded ring buffer, surfaces them via a new
// recentLifecycleEvents() method, and emits `device_bond_lost` when the
// adapter parks at auth_required (the signal-cli unlinked-account signal).

import { describe, it, expect } from 'vitest';
import { SignalAdapter } from '../../../src/transport/signal/adapter.ts';
import { MockSignalPort, makeSignalConfig } from './mock-port.ts';
import type { CredentialLifecycleEvent } from '../../../src/transport/connection.ts';

describe('SignalAdapter — lifecycle event accumulation', () => {
  it('exposes a recentLifecycleEvents() method returning CredentialLifecycleEvent[]', () => {
    const port = new MockSignalPort();
    const adapter = new SignalAdapter(makeSignalConfig({ pollIntervalMs: 0 }), port);

    const events = adapter.recentLifecycleEvents();
    expect(Array.isArray(events)).toBe(true);
  });

  it('records connect_start + connection_open on a successful connect()', async () => {
    const port = new MockSignalPort();
    const adapter = new SignalAdapter(makeSignalConfig({ pollIntervalMs: 0 }), port);

    await adapter.connect();

    const events = adapter.recentLifecycleEvents();
    const types = events.map((e) => e.event);
    expect(types).toContain('connect_start');
    expect(types).toContain('connection_open');
  });

  it('records connection_close on disconnect()', async () => {
    const port = new MockSignalPort();
    const adapter = new SignalAdapter(makeSignalConfig({ pollIntervalMs: 0 }), port);
    await adapter.connect();
    await adapter.disconnect();

    const events = adapter.recentLifecycleEvents();
    const types = events.map((e) => e.event);
    expect(types).toContain('connection_close');
  });

  it('emits device_bond_lost when the adapter parks at auth_required (unlinked-account signal)', async () => {
    // signal-cli surfaces an unlinked account as a 401 on the next RPC.
    // The adapter detects this in pollOnceInner and transitions to
    // auth_required. That transition MUST be recorded as device_bond_lost
    // so ops dashboards distinguish "daemon unreachable" (transient) from
    // "this device was unlinked and must be re-paired" (operator action).
    const port = new MockSignalPort({
      listError: Object.assign(new Error('Unregistered user'), { status: 401 }),
    });
    const adapter = new SignalAdapter(makeSignalConfig({ pollIntervalMs: 0 }), port);
    await adapter.connect();

    // Trigger one poll — the mock port will reject listInboundSince with 401.
    await (adapter as unknown as { pollOnceInner: () => Promise<void> }).pollOnceInner();

    const events = adapter.recentLifecycleEvents();
    const types = events.map((e) => e.event);
    expect(types).toContain('device_bond_lost');
    const lostEvent = events.find((e) => e.event === 'device_bond_lost');
    expect(lostEvent?.reason).toMatch(/unlinked|auth|signal/i);
  });

  it('caps the event buffer (ring buffer, oldest evicted first)', async () => {
    // A flapping daemon could otherwise grow the buffer unboundedly. The cap
    // mirrors the WhatsApp side's recentEvents bound (currently 50 entries).
    const port = new MockSignalPort();
    const adapter = new SignalAdapter(makeSignalConfig({ pollIntervalMs: 0 }), port);
    // Connect + disconnect 100 times — well over any reasonable cap.
    for (let i = 0; i < 100; i++) {
      await adapter.connect();
      await adapter.disconnect();
    }
    const events = adapter.recentLifecycleEvents();
    expect(events.length).toBeLessThanOrEqual(50);
    expect(events.length).toBeGreaterThan(0);
  });

  it('events carry the canonical CredentialLifecycleEvent shape', async () => {
    const port = new MockSignalPort();
    const adapter = new SignalAdapter(makeSignalConfig({ pollIntervalMs: 0 }), port);
    await adapter.connect();

    const events = adapter.recentLifecycleEvents();
    const sample = events[0] as CredentialLifecycleEvent;
    expect(sample).toHaveProperty('at');
    expect(sample).toHaveProperty('event');
    expect(sample).toHaveProperty('state');
    expect(sample).toHaveProperty('reconnectAttempts');
    expect(sample).toHaveProperty('reconnectPhase');
  });
});
