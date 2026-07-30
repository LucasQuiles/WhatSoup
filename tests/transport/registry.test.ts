// tests/transport/registry.test.ts
// Conformance tests for the transport ID registry — the closed set that
// config validation and the transport factory discriminate on. Mirrors the
// provider registry conformance tests
// (tests/runtimes/agent/providers/registry.test.ts).
import { describe, it, expect } from 'vitest';
import {
  TRANSPORT_IDS, DEFAULT_TRANSPORT_ID, isTransportId, assertNeverTransport,
  type TransportId,
} from '../../src/transport/registry.ts';
import {
  TRANSPORT_IDS as CORE_TRANSPORT_IDS,
  DEFAULT_TRANSPORT_ID as CORE_DEFAULT_TRANSPORT_ID,
  isTransportId as coreIsTransportId,
  assertNeverTransport as coreAssertNeverTransport,
} from '../../src/core/transport-refs.ts';

describe('transport registry', () => {
  it('re-exports the canonical core transport registry contract by identity', () => {
    expect(TRANSPORT_IDS).toBe(CORE_TRANSPORT_IDS);
    expect(DEFAULT_TRANSPORT_ID).toBe(CORE_DEFAULT_TRANSPORT_ID);
    expect(isTransportId).toBe(coreIsTransportId);
    expect(assertNeverTransport).toBe(coreAssertNeverTransport);
  });

  it('is a frozen closed set pinned to the canonical IDs', () => {
    expect([...TRANSPORT_IDS]).toEqual(['baileys', 'twilio', 'signal', 'imessage']);
    expect(Object.isFrozen(TRANSPORT_IDS)).toBe(true);
  });

  it('accepts every canonical ID', () => {
    for (const id of TRANSPORT_IDS) {
      expect(isTransportId(id)).toBe(true);
    }
  });

  it('defaults to baileys', () => {
    expect(DEFAULT_TRANSPORT_ID).toBe('baileys');
    expect(isTransportId(DEFAULT_TRANSPORT_ID)).toBe(true);
  });

  it('rejects unknown, mis-cased, padded, and non-string values', () => {
    expect(isTransportId('nope')).toBe(false);
    expect(isTransportId('Twilio')).toBe(false);
    expect(isTransportId('baileys ')).toBe(false);
    expect(isTransportId('')).toBe(false);
    expect(isTransportId(null)).toBe(false);
    expect(isTransportId(undefined)).toBe(false);
    expect(isTransportId(3)).toBe(false);
    expect(isTransportId({})).toBe(false);
  });

  it('narrows to TransportId after the guard passes', () => {
    const raw: unknown = 'twilio';
    expect(isTransportId(raw)).toBe(true);
    if (isTransportId(raw)) {
      const narrowed: TransportId = raw;
      expect(narrowed).toBe('twilio');
    }
  });

  it('assertNeverTransport throws with context and the valid set', () => {
    expect(() => assertNeverTransport('bogus' as never, 'test-site')).toThrow(
      /\[test-site\] unknown transport id: "bogus"\. Valid: baileys, twilio, signal, imessage\./,
    );
  });

  it('accepts the signal and imessage transport IDs', () => {
    expect(isTransportId('signal')).toBe(true);
    expect(isTransportId('imessage')).toBe(true);
  });
});
