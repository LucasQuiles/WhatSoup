import { createHash } from 'node:crypto';

/**
 * Digest pins for the approved managed-delivery endpoint and protected-link
 * hosts. The real values live only in the operator's private instance
 * configuration; source keeps their SHA-256 digests so every other origin or
 * host is still refused. Production callers always use these pins; only tests
 * pass their own.
 */
export interface ProtectedDeliveryPins {
  /** SHA-256 of each approved lowercase API origin, `https://host[:port]`. */
  readonly deliveryOriginSha256: ReadonlySet<string>;
  /** SHA-256 of each lowercase host whose protected links are redacted. */
  readonly linkHostSha256: ReadonlySet<string>;
  /** SHA-256 of the lowercase host that a managed link must use to be sent. */
  readonly canonicalLinkHostSha256: string;
}

export const APPROVED_DELIVERY_ORIGIN_SHA256 = 'de61b6dff9e216a6f7ab7cf58e6c5a2576cae5b1c8d5d49c535c78fdf7d087b1';
export const APPROVED_CANONICAL_LINK_HOST_SHA256 = '5f91b5911802673da6a4d8a09a7c8effef8a020ce1a1b6672b42b101d71b7844';
export const APPROVED_LINK_HOST_SHA256: readonly string[] = Object.freeze([
  APPROVED_CANONICAL_LINK_HOST_SHA256,
  '8cb10c0438f97f3dfd2a7bf25d4fcd06c1b912b5cc188ef1a960fe22189c7c5a',
]);

export const PROTECTED_DELIVERY_PINS: ProtectedDeliveryPins = Object.freeze({
  deliveryOriginSha256: new Set([APPROVED_DELIVERY_ORIGIN_SHA256]),
  linkHostSha256: new Set(APPROVED_LINK_HOST_SHA256),
  canonicalLinkHostSha256: APPROVED_CANONICAL_LINK_HOST_SHA256,
});

export function pinDigest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
