import { createHash } from 'node:crypto';
import type { ProtectedDeliveryPins } from '../../src/core/protected-delivery-pins.ts';

/**
 * Neutral protected-delivery fixtures. Production pins hold only digests of the
 * operator's private hosts, so tests pin these reserved `.test` hosts instead:
 * unit tests pass TEST_PROTECTED_DELIVERY_PINS explicitly, and tests that run
 * through production paths replace the pins module with mockProtectedDeliveryPins.
 * This helper imports the pins module for types only, so it is safe to load from
 * inside that module's vi.mock factory.
 */
export const TEST_LINK_HOST = 'links.example.test';
export const TEST_DELIVERY_HOST = 'delivery.example.test';
export const TEST_DELIVERY_ORIGIN = `https://${TEST_DELIVERY_HOST}`;
export const TEST_DELIVERY_BASE_URL = `${TEST_DELIVERY_ORIGIN}/s/api/v1`;

const digest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

export const TEST_PROTECTED_DELIVERY_PINS: ProtectedDeliveryPins = Object.freeze({
  deliveryHostSha256: new Set([digest(TEST_DELIVERY_HOST)]),
  linkHostSha256: new Set([digest(TEST_LINK_HOST), digest(TEST_DELIVERY_HOST)]),
  canonicalLinkHostSha256: new Set([digest(TEST_LINK_HOST)]),
});

type PinsModule = typeof import('../../src/core/protected-delivery-pins.ts');

/** vi.mock factory body: keep the real module, swap only the production pins. */
export async function mockProtectedDeliveryPins(importOriginal: () => Promise<PinsModule>): Promise<PinsModule> {
  return { ...(await importOriginal()), PROTECTED_DELIVERY_PINS: TEST_PROTECTED_DELIVERY_PINS };
}
