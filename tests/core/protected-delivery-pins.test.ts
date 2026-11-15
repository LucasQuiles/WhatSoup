import { describe, expect, it } from 'vitest';
import {
  APPROVED_CANONICAL_LINK_HOST_SHA256,
  APPROVED_DELIVERY_HOST_SHA256,
  APPROVED_LINK_HOST_SHA256,
  isExactPinnedHost,
  isPinnedHost,
  normalizePinnedHost,
  PROTECTED_DELIVERY_PINS,
} from '../../src/core/protected-delivery-pins.ts';
import { TEST_LINK_HOST, TEST_PROTECTED_DELIVERY_PINS as pins } from '../helpers/protected-delivery-pins.ts';

// This file reads the real pins module unmocked. It checks only the shape of
// the production pins; the pinned values stay private.
describe('production protected-delivery pins', () => {
  it.each([
    ['delivery host', APPROVED_DELIVERY_HOST_SHA256, PROTECTED_DELIVERY_PINS.deliveryHostSha256],
    ['link host', APPROVED_LINK_HOST_SHA256, PROTECTED_DELIVERY_PINS.linkHostSha256],
    ['canonical link host', APPROVED_CANONICAL_LINK_HOST_SHA256, PROTECTED_DELIVERY_PINS.canonicalLinkHostSha256],
  ] as const)('pins at least one %s as distinct lowercase SHA-256 digests', (_name, list, set) => {
    expect(list.length).toBeGreaterThanOrEqual(1);
    for (const entry of list) expect(entry).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(list).size).toBe(list.length);
    expect([...set].sort()).toEqual([...list].sort());
  });

  it('pins every canonical and delivery host as a redacted link host', () => {
    for (const entry of [...APPROVED_CANONICAL_LINK_HOST_SHA256, ...APPROVED_DELIVERY_HOST_SHA256]) {
      expect(PROTECTED_DELIVERY_PINS.linkHostSha256.has(entry)).toBe(true);
    }
  });
});

describe('pinned host check', () => {
  it('normalizes case, long s, one trailing dot and one www prefix', () => {
    const spelled = `WWW.${TEST_LINK_HOST.toUpperCase().replace(/S/g, 'ſ')}.`;
    expect(normalizePinnedHost(spelled)).toBe(TEST_LINK_HOST);
    expect(isPinnedHost(spelled, pins.linkHostSha256)).toBe(true);
    expect(isExactPinnedHost(spelled, pins.linkHostSha256)).toBe(false);
    expect(isExactPinnedHost(TEST_LINK_HOST, pins.linkHostSha256)).toBe(true);
  });

  it('refuses hosts that are not pinned, including lookalikes', () => {
    for (const host of [`evil${TEST_LINK_HOST}`, `${TEST_LINK_HOST}.evil.invalid`, `www.www.${TEST_LINK_HOST}`, 'evil.invalid', '']) {
      expect(isPinnedHost(host, pins.linkHostSha256)).toBe(false);
    }
    expect(isPinnedHost(TEST_LINK_HOST, PROTECTED_DELIVERY_PINS.linkHostSha256)).toBe(false);
  });
});
