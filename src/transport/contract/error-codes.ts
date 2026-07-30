/**
 * Stable error code registry. Every TransportError subclass uses one of these.
 * Adding a new code requires:
 *   1. adding it to the core transport error taxonomy
 *   2. adding a runbook entry under docs/runbooks/transport-error-<code>.md
 *   3. ensuring the conformance test parameterized over the code can produce/match it
 *
 * Removing or renaming a code is a breaking change requiring a deprecation cycle.
 */
import {
  allErrorCodes as listErrorCodes,
  ErrorCode as CoreErrorCode,
  type ErrorCode as CoreErrorCodeType,
} from '../../core/transport-error-taxonomy.ts';

export const ErrorCode = CoreErrorCode;
export type ErrorCode = CoreErrorCodeType;

export function allErrorCodes(): readonly ErrorCode[] {
  return listErrorCodes();
}
