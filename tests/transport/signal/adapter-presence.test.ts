// tests/transport/signal/adapter-presence.test.ts
// presence extension (SupportsPresence).
//
// Before this slice, capabilities.extensions did NOT include 'presence'. The
// spec (signal-and-imessage-transports-spec.md §3a line 83) lists 'presence'
// among Signal's natively supported extensions. Signal does not expose
// last-seen timestamps via signal-cli (the protocol intentionally hides
// online state to preserve privacy), but signal-cli DOES emit typing
// indicators via the daemon's subscription stream — we surface those as
// PresenceEvents with state='online'/'offline' (typing → online, stopped →
// offline). This is the same surface WhatsApp exposes via Baileys' chat
// presence events.
//
// This file proves:
//   1. capabilities.extensions includes 'presence' (isPresenceCapable → true)
//   2. the adapter emits a PresenceEvent when an inbound typingMessage arrives
//   3. typing → state='online'; stopped → state='offline'
//   4. a non-typing envelope (data/sync/reaction/etc.) does NOT emit presence

import { describe, it, expect } from 'vitest';
import { SignalAdapter } from '../../../src/transport/signal/adapter.ts';
import { MockSignalPort, makeSignalConfig } from './mock-port.ts';
import { isPresenceCapable } from '../../../src/transport/contract/extensions.ts';
import type { PresenceEvent } from '../../../src/transport/contract/events.ts';

describe('SignalAdapter — presence capabilities', () => {
  it('declares the presence extension (isPresenceCapable → true)', () => {
    const adapter = new SignalAdapter(makeSignalConfig(), new MockSignalPort());
    expect(isPresenceCapable(adapter)).toBe(true);
    expect(adapter.capabilities.extensions.has('presence')).toBe(true);
  });
});

describe('SignalAdapter — presence events', () => {
  it('emits a PresenceEvent with state=online when an inbound typingMessage arrives', async () => {
    const adapter = new SignalAdapter(makeSignalConfig(), new MockSignalPort());
    await adapter.connect();
    const events: PresenceEvent[] = [];
    adapter.on('presence', (e) => events.push(e));

    adapter.handleInboundRecord({
      timestamp: 7000,
      source: 'aaa-bbb-ccc',
      destination: 'self-uuid',
      body: null,
      fromMe: false,
      type: 'typing',
      typing: { composing: true },
    } as any);

    expect(events).toHaveLength(1);
    expect(events[0].state).toBe('online');
    expect(events[0].participant.id).toBe('aaa-bbb-ccc');
    await adapter.disconnect();
  });

  it('emits state=offline when the typing indicator stops', async () => {
    const adapter = new SignalAdapter(makeSignalConfig(), new MockSignalPort());
    await adapter.connect();
    const events: PresenceEvent[] = [];
    adapter.on('presence', (e) => events.push(e));

    adapter.handleInboundRecord({
      timestamp: 7001,
      source: 'aaa-bbb-ccc',
      destination: 'self-uuid',
      body: null,
      fromMe: false,
      type: 'typing',
      typing: { composing: false },
    } as any);

    expect(events).toHaveLength(1);
    expect(events[0].state).toBe('offline');
    await adapter.disconnect();
  });

  it('does NOT emit presence for non-typing envelopes', async () => {
    const adapter = new SignalAdapter(makeSignalConfig(), new MockSignalPort());
    await adapter.connect();
    const events: PresenceEvent[] = [];
    adapter.on('presence', (e) => events.push(e));

    adapter.handleInboundRecord({
      timestamp: 7002,
      source: 'aaa-bbb-ccc',
      destination: 'self-uuid',
      body: 'hi',
      fromMe: false,
      type: 'data',
    });

    expect(events).toHaveLength(0);
    await adapter.disconnect();
  });
});
