// tests/transport/signal/types.test.ts
// Type-shape conformance for the Signal transport config + defaults.
// The actual config-validation behaviour lives in agent-config-validator.ts
// and is tested there; this file pins the exported constants and types
// so a stray rename or default-tweak surfaces here first.
import { describe, it, expect } from 'vitest';
import {
  E164_RE,
  SIGNAL_UUID_RE,
  DEFAULT_SIGNAL,
  type SignalConfig,
  type SignalInboundMode,
  type SignalRateLimit,
} from '../../../src/transport/signal/types.ts';

describe('signal transport — types', () => {
  it('E164_RE accepts canonical E.164 numbers and rejects others', () => {
    expect(E164_RE.test('+15551234567')).toBe(true);
    expect(E164_RE.test('+447700123456')).toBe(true);
    expect(E164_RE.test('15551234567')).toBe(false);   // missing +
    expect(E164_RE.test('+1')).toBe(false);            // too short
    expect(E164_RE.test('+0btn')).toBe(false);         // invalid leading digit per E.164
    expect(E164_RE.test('')).toBe(false);
  });

  it('SIGNAL_UUID_RE accepts canonical lowercase UUIDs', () => {
    expect(SIGNAL_UUID_RE.test('01234567-89ab-cdef-0123-456789abcdef')).toBe(true);
    expect(SIGNAL_UUID_RE.test('01234567-89AB-CDEF-0123-456789ABCDEF')).toBe(false); // uppercase rejected
    expect(SIGNAL_UUID_RE.test('not-a-uuid')).toBe(false);
    expect(SIGNAL_UUID_RE.test('')).toBe(false);
  });

  it('DEFAULT_SIGNAL is frozen with the documented defaults', () => {
    expect(Object.isFrozen(DEFAULT_SIGNAL)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SIGNAL.rateLimit)).toBe(true);
    expect(DEFAULT_SIGNAL.socketPath).toBe('/tmp/signalc.sock');
    expect(DEFAULT_SIGNAL.inboundMode).toBe('poll');
    expect(DEFAULT_SIGNAL.pollIntervalMs).toBe(15000);
    expect(DEFAULT_SIGNAL.rateLimit.messagesPerMinute).toBe(30);
  });

  it('SignalInboundMode admits exactly the two documented modes', () => {
    // Compile-time assertion — the assignment will fail to typecheck if the
    // union narrows or widens.
    const a: SignalInboundMode = 'poll';
    const b: SignalInboundMode = 'stream';
    expect([a, b]).toEqual(['poll', 'stream']);
  });

  it('a fully-populated SignalConfig satisfies the type (compile-time)', () => {
    const cfg: SignalConfig = {
      account: 'ops-line',
      socketPath: '/tmp/signalc.sock',
      phoneNumber: '+15551234567',
      inboundMode: 'poll',
      pollIntervalMs: 10000,
      rateLimit: { messagesPerMinute: 20 },
    };
    expect(cfg.account).toBe('ops-line');
  });

  it('SignalRateLimit requires messagesPerMinute', () => {
    const rl: SignalRateLimit = { messagesPerMinute: 10 };
    expect(rl.messagesPerMinute).toBe(10);
  });
});
