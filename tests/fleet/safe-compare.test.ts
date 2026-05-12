// tests/fleet/safe-compare.test.ts
//
// Covers safeStringEqual — the shared constant-time string-compare helper used
// across token-storage, health bearer, and ws-ticket verification.
//
// Regression boundary: input strings can contain multibyte UTF-8 / lone
// surrogates that yield Buffer.byteLength !== string.length. Pre-#405 code
// gated on `.length` and then called timingSafeEqual on UTF-8 buffers, which
// throws RangeError for equal-char-length-but-unequal-byte-length inputs.
// safeStringEqual MUST return false on every malformed-input path — never
// throw.

import { describe, it, expect } from 'vitest';
import { safeStringEqual } from '../../src/fleet/safe-compare.ts';

describe('safeStringEqual', () => {
  it('returns true for byte-identical ASCII strings', () => {
    expect(safeStringEqual('hello', 'hello')).toBe(true);
  });

  it('returns false for unequal ASCII strings of the same length', () => {
    expect(safeStringEqual('hello', 'world')).toBe(false);
  });

  it('returns false for ASCII strings of different lengths', () => {
    expect(safeStringEqual('hello', 'hello!')).toBe(false);
  });

  it('returns true for byte-identical multibyte strings', () => {
    expect(safeStringEqual('café', 'café')).toBe(true);
    expect(safeStringEqual('日本語', '日本語')).toBe(true);
  });

  it("returns false (does not throw) for equal-char-length but unequal-byte-length multibyte vs ASCII", () => {
    // Pre-fix repro: 'é' is 2 bytes UTF-8, 'a' is 1 byte. Both strings have
    // .length === 10 but byteLength 20 vs 10. timingSafeEqual would throw
    // RangeError on Buffers of unequal length.
    expect(() => safeStringEqual('é'.repeat(10), 'a'.repeat(10))).not.toThrow();
    expect(safeStringEqual('é'.repeat(10), 'a'.repeat(10))).toBe(false);
  });

  it('returns false for lone-surrogate inputs without throwing', () => {
    expect(() => safeStringEqual('\uD800', 'a')).not.toThrow();
    expect(safeStringEqual('\uD800', 'a')).toBe(false);
    // Same lone surrogate on both sides — still false-or-true, but MUST NOT throw.
    expect(() => safeStringEqual('\uD800', '\uD800')).not.toThrow();
  });

  it('returns false for null / undefined / non-string inputs', () => {
    // @ts-expect-error -- exercising runtime null guard.
    expect(safeStringEqual(null, 'hello')).toBe(false);
    // @ts-expect-error -- exercising runtime undefined guard.
    expect(safeStringEqual('hello', undefined)).toBe(false);
    // @ts-expect-error -- exercising runtime null guard.
    expect(safeStringEqual(null, null)).toBe(false);
    // @ts-expect-error -- exercising runtime non-string guard.
    expect(safeStringEqual(42, 'hello')).toBe(false);
  });

  it('returns false for empty strings on either side', () => {
    expect(safeStringEqual('', 'hello')).toBe(false);
    expect(safeStringEqual('hello', '')).toBe(false);
    // Both empty: nothing to compare; reject so callers can't accept a missing
    // credential by passing '' on both sides.
    expect(safeStringEqual('', '')).toBe(false);
  });
});
