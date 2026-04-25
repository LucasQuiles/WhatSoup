// src/transport/contract/error-codes.ts

/**
 * Stable error code registry. Every TransportError subclass uses one of these.
 * Adding a new code requires:
 *   1. adding it to ErrorCode below
 *   2. adding a runbook entry under docs/runbooks/transport-error-<code>.md
 *   3. ensuring the conformance test parameterized over the code can produce/match it
 *
 * Removing or renaming a code is a breaking change requiring a deprecation cycle.
 */
export const ErrorCode = {
  // capability / wiring
  UNSUPPORTED_CAPABILITY: 'transport.unsupported_capability',
  // payload
  PAYLOAD_TOO_LARGE: 'transport.payload_too_large',
  CONVERSATION_NOT_FOUND: 'transport.conversation_not_found',
  // auth
  AUTH_REQUIRED: 'transport.auth_required',
  // rate
  RATE_LIMITED: 'transport.rate_limited',
  // provider
  TRANSIENT_PROVIDER: 'transport.transient_provider',
  PERMANENT_PROVIDER: 'transport.permanent_provider',
  // ambiguous
  SEND_AMBIGUOUS: 'transport.send_ambiguous',
} as const;

export type ErrorCode = typeof ErrorCode[keyof typeof ErrorCode];

/** Returns all registered codes. Used by CI test that asserts no duplicates. */
export function allErrorCodes(): readonly ErrorCode[] {
  return Object.values(ErrorCode);
}
