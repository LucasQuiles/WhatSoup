/**
 * Contract-lock test for src/transport/contract/error-codes.ts.
 *
 * Per the source header: "Adding a new code requires adding it to ErrorCode
 * below, adding a runbook entry under docs/runbooks/transport-error-<code>.md,
 * and ensuring the conformance test parameterized over the code can produce/
 * match it. Removing or renaming a code is a breaking change requiring a
 * deprecation cycle."
 *
 * The existing test in tests/transport/contract/errors.test.ts only asserts
 * "no duplicate codes" and uses ErrorCode constants by name. This file adds
 * an explicit contract lock so silent additions or renames get caught at
 * test time rather than at deprecation review.
 */
import { describe, expect, it } from 'vitest';
import { ErrorCode, allErrorCodes } from '../../../src/transport/contract/error-codes.ts';

const EXPECTED_CODES = [
  'transport.unsupported_capability',
  'transport.payload_too_large',
  'transport.conversation_not_found',
  'transport.auth_required',
  'transport.rate_limited',
  'transport.transient_provider',
  'transport.permanent_provider',
  'transport.send_ambiguous',
] as const;

describe('ErrorCode registry', () => {
  it('exposes the exact 8 registered codes (contract lock)', () => {
    expect(allErrorCodes()).toEqual(EXPECTED_CODES);
  });

  it('every named export resolves to the expected stable string', () => {
    expect(ErrorCode.UNSUPPORTED_CAPABILITY).toBe('transport.unsupported_capability');
    expect(ErrorCode.PAYLOAD_TOO_LARGE).toBe('transport.payload_too_large');
    expect(ErrorCode.CONVERSATION_NOT_FOUND).toBe('transport.conversation_not_found');
    expect(ErrorCode.AUTH_REQUIRED).toBe('transport.auth_required');
    expect(ErrorCode.RATE_LIMITED).toBe('transport.rate_limited');
    expect(ErrorCode.TRANSIENT_PROVIDER).toBe('transport.transient_provider');
    expect(ErrorCode.PERMANENT_PROVIDER).toBe('transport.permanent_provider');
    expect(ErrorCode.SEND_AMBIGUOUS).toBe('transport.send_ambiguous');
  });

  it('all codes follow the `transport.<snake_case>` namespacing convention', () => {
    const pattern = /^transport\.[a-z][a-z0-9_]*$/;
    for (const code of allErrorCodes()) {
      expect(code, `code ${code} does not follow transport.<snake_case> convention`).toMatch(
        pattern,
      );
    }
  });

  it('each code maps to a kebab-case runbook suffix (transport.foo_bar -> foo-bar)', () => {
    // Per source header: "Adding a new code requires adding a runbook entry
    // under docs/runbooks/transport-error-<code>.md". This test pins the
    // suffix derivation rule so the runbook-file naming stays consistent.
    // (As of this commit, the runbook files themselves do NOT exist — that's
    // a separate documentation-gap-closure task.)
    const suffixOf = (code: string) =>
      code.replace(/^transport\./, '').replace(/_/g, '-');
    expect(suffixOf('transport.unsupported_capability')).toBe('unsupported-capability');
    expect(suffixOf('transport.payload_too_large')).toBe('payload-too-large');
    expect(suffixOf('transport.send_ambiguous')).toBe('send-ambiguous');
    for (const code of allErrorCodes()) {
      expect(suffixOf(code)).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it('codes have no duplicates (regression for existing assertion)', () => {
    const codes = allErrorCodes();
    expect(codes.length).toBe(new Set(codes).size);
  });

  it('codes are returned in registration order, not sorted alphabetically', () => {
    // The source declares UNSUPPORTED_CAPABILITY before PAYLOAD_TOO_LARGE
    // in the ErrorCode object. allErrorCodes() must preserve that order.
    const codes = allErrorCodes();
    expect(codes[0]).toBe('transport.unsupported_capability');
    expect(codes[1]).toBe('transport.payload_too_large');
    expect(codes[2]).toBe('transport.conversation_not_found');
  });

  it('count is exactly 8 — adding a code requires updating this lock', () => {
    expect(allErrorCodes()).toHaveLength(EXPECTED_CODES.length);
    expect(allErrorCodes()).toHaveLength(8);
  });
});
