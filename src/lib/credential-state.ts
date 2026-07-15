/**
 * Credential-state classification taxonomy.
 *
 * Centralizes the reason codes for why a stored credential can or cannot be
 * used, plus pure functions for token-expiry state classification. Doctor,
 * health, failure-copy, and credential-verify flows can consume the same
 * taxonomy so "why did this credential fail?" is answerable consistently.
 *
 * Part of docs/security-handoffs/2026-05-09-env-secret-exposure.md (W-2 observability).
 */

/**
 * Structural shape matching the W-1 `CredentialLookupResult` from keyring.ts.
 * Defined locally (not imported) so this module is self-contained and can
 * land independently of the W-1 typed-lookup PR. When both are merged, the
 * real `CredentialLookupResult` satisfies this shape structurally.
 */
interface LookupResultLike {
  value: string | null;
  reason: 'ok' | 'unknown_service' | 'not_found';
  service: string;
}

/**
 * Reason code for why a credential can or cannot be used.
 *
 * Closed enum — every credential-checking path should classify its outcome
 * into one of these. Consumers (doctor, health, failure-copy, logging) can
 * switch on the code without default-fallthrough guessing.
 */
export type CredentialReasonCode =
  | 'ok'                  // credential is present and usable
  | 'missing_credential'  // no credential configured (not_found from lookupCredentialTyped)
  | 'unknown_service'     // service not in the closed registry (closed-id gate rejected it)
  | 'invalid_expires'     // expiry timestamp is present but malformed/non-finite
  | 'expired'             // credential has expired (expiry timestamp is in the past)
  | 'expiring'            // credential will expire within the refresh margin
  | 'malformed';          // credential value is present but empty/whitespace after trim

/**
 * Classification of a token-style credential's expiry timestamp.
 * Used by {@link resolveTokenExpiryState} and {@link hasUsableCredential}.
 */
export type TokenExpiryState = 'missing' | 'valid' | 'expiring' | 'expired' | 'invalid_expires';

/**
 * Default refresh margin before expiry. A credential whose expiry falls
 * within this window is classified as 'expiring' rather than 'valid', so
 * refresh logic can act before the credential actually expires.
 */
export const DEFAULT_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * Maximum plausible timestamp in milliseconds since epoch. Used to reject
 * absurdly large expiry values (e.g. a microseconds timestamp or a garbage
 * number) that would otherwise pass `Number.isFinite`.
 */
const MAX_PLAUSIBLE_TIMESTAMP_MS = 8640000000000000; // ~year 275760

/**
 * Classifies a token expiry timestamp for auth selection and refresh logic.
 *
 * @param expires - The expiry timestamp (ms since epoch), or undefined/null.
 * @param now - Current time (ms since epoch); defaults to Date.now().
 * @param opts.expiringWithinMs - Refresh margin; a credential expiring within
 *   this window is classified as 'expiring'. Defaults to
 *   {@link DEFAULT_REFRESH_MARGIN_MS}.
 * @returns The expiry state: 'missing' (no expiry), 'valid', 'expiring',
 *   'expired', or 'invalid_expires' (malformed timestamp).
 */
export function resolveTokenExpiryState(
  expires: unknown,
  now: number = Date.now(),
  opts?: { expiringWithinMs?: number },
): TokenExpiryState {
  if (expires === undefined || expires === null) {
    return 'missing';
  }
  if (typeof expires !== 'number') {
    return 'invalid_expires';
  }
  if (!Number.isFinite(expires) || expires <= 0 || expires > MAX_PLAUSIBLE_TIMESTAMP_MS) {
    return 'invalid_expires';
  }
  const remainingMs = expires - now;
  if (remainingMs <= 0) {
    return 'expired';
  }
  const expiringWithinMs = Math.max(0, opts?.expiringWithinMs ?? DEFAULT_REFRESH_MARGIN_MS);
  if (expiringWithinMs > 0 && remainingMs <= expiringWithinMs) {
    return 'expiring';
  }
  return 'valid';
}

/**
 * Shape of a credential that may have an expiry. The `value` is the secret
 * string (API key, token, etc.); `expires` is an optional ms-since-epoch
 * timestamp for time-bounded credentials (OAuth tokens, short-lived keys).
 */
export interface CredentialLike {
  value: string | null | undefined;
  expires?: unknown;
}

/**
 * Returns true when a credential has a non-empty value AND (when an expiry is
 * present) a non-expired token state. A credential with no expiry (static API
 * keys) is usable as long as its value is non-empty.
 *
 * @param credential - The credential to check.
 * @param opts.now - Current time (ms since epoch); defaults to Date.now().
 * @param opts.refreshMarginMs - Refresh margin for 'expiring' classification.
 *   A credential in the 'expiring' window is STILL usable (returns true) —
 *   the caller decides whether to refresh proactively.
 */
export function hasUsableCredential(
  credential: CredentialLike | null | undefined,
  opts?: { now?: number; refreshMarginMs?: number },
): boolean {
  if (!credential) return false;
  const value = credential.value;
  if (typeof value !== 'string' || value.trim().length === 0) {
    return false;
  }
  // No expiry → static credential (API key); usable as long as value is non-empty.
  if (credential.expires === undefined || credential.expires === null) {
    return true;
  }
  const now = opts?.now ?? Date.now();
  const refreshMarginMs = Math.max(0, opts?.refreshMarginMs ?? DEFAULT_REFRESH_MARGIN_MS);
  const state = resolveTokenExpiryState(credential.expires, now, { expiringWithinMs: refreshMarginMs });
  // 'expiring' is still usable — the caller may refresh proactively but the
  // credential hasn't expired yet. Only 'expired' and 'invalid_expires' block.
  return state === 'valid' || state === 'expiring';
}

/**
 * Bridge from the W-1 typed lookup result to the Pattern B reason-code
 * taxonomy ({@link CredentialReasonCode}).
 *
 * This lets credential-checking flows that use `lookupCredentialTyped`
 * classify their outcome into the shared taxonomy without re-deriving it.
 * Accepts a structural shape so it works with any result matching
 * {@link LookupResultLike}.
 */
export function classifyLookupResult(result: LookupResultLike): CredentialReasonCode {
  switch (result.reason) {
    case 'ok':
      return 'ok';
    case 'unknown_service':
      return 'unknown_service';
    case 'not_found':
      return 'missing_credential';
    default: {
      // Exhaustive guard: if a new reason code is added to LookupResultLike
      // without updating this switch, the default branch catches it at
      // runtime rather than silently misclassifying.
      const exhaustive: never = result.reason;
      throw new Error(`unhandled lookup result reason: ${String(exhaustive)}`);
    }
  }
}

/**
 * Classify a raw credential value (string | null | undefined) into a reason
 * code. Useful for call sites that have the value but didn't go through
 * `lookupCredentialTyped`.
 */
export function classifyCredentialValue(value: string | null | undefined): CredentialReasonCode {
  if (value === null || value === undefined) {
    return 'missing_credential';
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    return 'malformed';
  }
  return 'ok';
}
