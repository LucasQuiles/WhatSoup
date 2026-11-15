import { createHash } from 'node:crypto';

/**
 * Digest pins for the hash-pinned approved hosts (owner ruling). The real
 * values live only in the operator's private instance configuration; source
 * keeps their SHA-256 digests so every other host is still refused.
 * Production callers always use these pins; only tests pass their own.
 *
 * This module sits in the shared ring so the log sanitizer can redact protected
 * links without importing domain code; src/core/protected-delivery-pins.ts
 * re-exports it unchanged.
 */
export interface ProtectedDeliveryPins {
  /** SHA-256 of each approved managed-delivery API host. */
  readonly deliveryHostSha256: ReadonlySet<string>;
  /** SHA-256 of each host whose protected links are redacted. */
  readonly linkHostSha256: ReadonlySet<string>;
  /** SHA-256 of each host that a managed link may use to be sent. */
  readonly canonicalLinkHostSha256: ReadonlySet<string>;
}

export const APPROVED_DELIVERY_HOST_SHA256: readonly string[] = Object.freeze([
  '8cb10c0438f97f3dfd2a7bf25d4fcd06c1b912b5cc188ef1a960fe22189c7c5a',
]);
export const APPROVED_CANONICAL_LINK_HOST_SHA256: readonly string[] = Object.freeze([
  '5f91b5911802673da6a4d8a09a7c8effef8a020ce1a1b6672b42b101d71b7844',
]);
export const APPROVED_LINK_HOST_SHA256: readonly string[] = Object.freeze([
  ...APPROVED_CANONICAL_LINK_HOST_SHA256,
  ...APPROVED_DELIVERY_HOST_SHA256,
]);

export const PROTECTED_DELIVERY_PINS: ProtectedDeliveryPins = Object.freeze({
  deliveryHostSha256: new Set(APPROVED_DELIVERY_HOST_SHA256),
  linkHostSha256: new Set(APPROVED_LINK_HOST_SHA256),
  canonicalLinkHostSha256: new Set(APPROVED_CANONICAL_LINK_HOST_SHA256),
});

export function pinDigest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * The one host normalization behind every pin check: lowercase, fold the long
 * s (U+017F, which browsers map to `s`; toLowerCase() already folds the Kelvin
 * sign), then drop one trailing dot and one leading `www.`.
 */
export function normalizePinnedHost(host: string): string {
  let normalized = host.toLowerCase().replace(/ſ/g, 's');
  if (normalized.endsWith('.')) normalized = normalized.slice(0, -1);
  if (normalized.startsWith('www.')) normalized = normalized.slice('www.'.length);
  return normalized;
}

/** True when the normalized host's digest is in `pinned`. */
export function isPinnedHost(host: string, pinned: ReadonlySet<string>): boolean {
  return pinned.has(pinDigest(normalizePinnedHost(host)));
}

/**
 * True only for a host already in normalized form whose digest is pinned. Use
 * it where a spelling must be exact (configuration, a link the service sends).
 */
export function isExactPinnedHost(host: string, pinned: ReadonlySet<string>): boolean {
  return normalizePinnedHost(host) === host && isPinnedHost(host, pinned);
}
