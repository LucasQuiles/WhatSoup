// src/fleet/safe-compare.ts
//
// Constant-time string-compare helper for credential verification.
//
// The naive `a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))`
// pattern throws `RangeError: Input buffers must have the same byte length`
// when an attacker (or a misconfigured caller) supplies a string whose JS
// `.length` matches the expected token but whose UTF-8 byteLength does not —
// e.g. `'é'.repeat(N)` where every code point encodes to 2 bytes, or a string
// containing lone surrogates. Pre-#405 call sites surfaced this as an
// uncaught RangeError (crashing the request handler in `core/health.ts`) or
// as a misleading 500 (`fleet/token-storage.ts` callers expected a boolean).
//
// `safeStringEqual` normalizes both sides to Buffers up front, gates on
// `byteLength` equality (the correct invariant for `timingSafeEqual`), and
// wraps the comparison in try/catch so any future Node-level surprise becomes
// a `false` instead of a 500. Returns `false` for null/undefined/non-string
// inputs and for any pair where both sides are empty — callers must not be
// able to authenticate by supplying nothing on both sides.
//
// Precedent: this is the same shape as `safeEqual` in
// `src/fleet/auth-ticket.ts`. That copy is the template; this module is the
// single source of truth going forward.

import * as crypto from 'node:crypto';

/**
 * Constant-time equality check for two strings.
 *
 * Returns `false` (never throws) on any of:
 *   - either side is not a non-empty string
 *   - the UTF-8 byteLengths differ
 *   - `crypto.timingSafeEqual` raises (defense-in-depth)
 *
 * For valid equal-byte-length inputs the comparison is constant-time over
 * the buffer payload, matching the behaviour of `crypto.timingSafeEqual`.
 */
export function safeStringEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length === 0 || b.length === 0) return false;
  try {
    const aBuf = Buffer.from(a, 'utf8');
    const bBuf = Buffer.from(b, 'utf8');
    if (aBuf.byteLength !== bBuf.byteLength) return false;
    return crypto.timingSafeEqual(aBuf, bBuf);
  } catch {
    return false;
  }
}
