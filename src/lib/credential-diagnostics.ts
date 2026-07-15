/**
 * Credential diagnostic enrichment.
 *
 * Bridges the credential-state reason-code taxonomy
 * ({@link CredentialReasonCode} from `credential-state.ts`) into structured
 * diagnostic results that doctor, health, and account-auth-status flows can
 * consume uniformly.
 *
 * Instead of a bare `string | null` from `lookupCredential`, callers get a
 * classified result that distinguishes "no credential configured" from
 * "credential is empty/malformed" — improving diagnostic fidelity without
 * changing the credential resolution path.
 */

import {
  type CredentialReasonCode,
  classifyCredentialValue,
} from './credential-state.ts';

/**
 * Structured result of a credential diagnostic check.
 *
 * Combines the reason-code taxonomy with a human-readable summary suitable
 * for diagnostic-bundle output. The `summary` is pre-redacted (contains only
 * the service identifier, never the credential value).
 */
export interface CredentialDiagnosticResult {
  /** The keyring service name that was checked. */
  service: string;
  /** Why the credential is or is not usable. */
  reasonCode: CredentialReasonCode;
  /** True when the credential is present and well-formed. */
  usable: boolean;
  /** Human-readable, pre-redacted summary for diagnostic output. */
  summary: string;
}

/**
 * Diagnose a credential by its resolved value.
 *
 * Pure function — no keyring or network access. The caller resolves the
 * credential value (via `lookupCredential` or `lookupCredentialTyped`) and
 * passes it here for classification into the shared reason-code taxonomy.
 *
 * @param service - The keyring service name (e.g. 'openai', 'anthropic').
 * @param value - The resolved credential value, or null/undefined if absent.
 * @returns A classified diagnostic result.
 */
export function diagnoseCredential(
  service: string,
  value: string | null | undefined,
): CredentialDiagnosticResult {
  const reasonCode = classifyCredentialValue(value);
  return {
    service,
    reasonCode,
    usable: reasonCode === 'ok',
    summary: credentialSummary(service, reasonCode),
  };
}

/**
 * Produce a human-readable summary for a credential reason code.
 *
 * The summary is pre-redacted: it contains only the `service` identifier
 * (which is a config key, not a secret) and a fixed description string.
 * Never includes the credential value.
 *
 * @param service - The keyring service name.
 * @param reasonCode - The classified reason code.
 * @returns A human-readable summary string.
 * @throws if `reasonCode` is not handled (exhaustive guard — catches future
 *   additions to `CredentialReasonCode` that don't update this switch).
 */
export function credentialSummary(
  service: string,
  reasonCode: CredentialReasonCode,
): string {
  switch (reasonCode) {
    case 'ok':
      return `credential ok for ${service}`;
    case 'missing_credential':
      return `no credential found for ${service}`;
    case 'malformed':
      return `credential for ${service} is empty or whitespace`;
    case 'unknown_service':
      return `unknown service: ${service}`;
    case 'invalid_expires':
      return `credential for ${service} has invalid expiry`;
    case 'expired':
      return `credential for ${service} has expired`;
    case 'expiring':
      return `credential for ${service} expires soon`;
    default: {
      // Exhaustive guard: if a new reason code is added to
      // CredentialReasonCode without updating this switch, the default
      // branch catches it at runtime rather than silently misclassifying.
      const exhaustive: never = reasonCode;
      throw new Error(`unhandled credential reason code: ${String(exhaustive)}`);
    }
  }
}
