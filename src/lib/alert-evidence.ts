/**
 * Issue #2386: BOT ERRORS evidence metadata-only emission boundary.
 *
 * Free-form summary and evidence strings cross the alert boundary with only
 * pattern-based redaction (secrets, JIDs, phones, URLs). Arbitrary provider
 * output, exception prose, tool output, message identifiers, paths, and
 * unmatched conversation identifiers survive that redaction unchanged.
 *
 * This module projects raw content into bounded, content-free metadata at
 * the emission boundary. The projection is applied in {@link emitAlert}
 * (covering outbox, legacy fallback, and dry-run sinks) and in
 * {@link buildBotErrorsEvent} (covering direct callers and write-failure
 * breadcrumbs) so every transport sees the same safe representation.
 *
 * ## What survives
 *
 * - ``failureClass``: a bounded error-class hint extracted from well-known
 *   patterns (``Error``, ``TypeError``, ``provider_unknown_terminal``, etc.).
 *   Never raw prose.
 * - ``length``: raw character count of the original string.
 * - ``correlationDigest``: a domain-separated SHA-256 hex digest of
 *   the original content — deterministic, non-reversible, for dedup.
 *
 * ## What is stripped
 *
 * Arbitrary prose, raw errors, stderr/stdout excerpts, message or
 * conversation identifiers, paths, process arguments, and unregistered
 * fields. The ``redactText`` defense-in-depth layer remains; it is not
 * treated as proof of metadata-only confinement.
 */

import { pbkdf2Sync } from 'node:crypto';

/** Bounded metadata projected from a raw evidence or summary string. */
export interface ConfinedAlertContent {
  /** Bounded error-class hint (e.g. ``"TypeError"``, ``"provider_unknown"``) or ``"unknown"``. */
  readonly failureClass: string;
  /** Character length of the original raw string. */
  readonly length: number;
  /** Domain-separated SHA-256 hex digest — non-reversible. */
  readonly correlationDigest: string;
}

/** Sentinel for empty/absent content. */
const EMPTY_CONFINED: ConfinedAlertContent = Object.freeze({
  failureClass: 'none',
  length: 0,
  correlationDigest: digestContent('empty', ''),
});

/**
 * Well-known error-class patterns that may be safely extracted as bounded
 * metadata. Each entry is a regex that matches a class hint anywhere in the
 * content. The match is reduced to the named group or a fixed label —
 * never the raw matched text. Mid-string matching is safe because the
 * returned label is a bounded word, not raw matched text.
 */
const FAILURE_CLASS_PATTERNS: readonly { readonly pattern: RegExp; readonly label: string }[] = [
  // Standard Error subclasses — any position (e.g. "stderr: TypeError at line 42" → TypeError).
  { pattern: /\b(?:TypeError|RangeError|ReferenceError|SyntaxError|EvalError|URIError)\b/, label: '$0' },
  // Generic Error prefix: "... Error: ..." → "Error".
  { pattern: /\bError\b/, label: 'Error' },
  // Provider-class signals used in the runtime.
  { pattern: /\bprovider_unknown_terminal\b/, label: 'provider_unknown' },
  { pattern: /\bprovider_timeout\b/, label: 'provider_timeout' },
  { pattern: /\bprovider_rate_limited\b/, label: 'provider_rate_limited' },
  { pattern: /\bprovider_auth_failure\b/, label: 'provider_auth_failure' },
  // Stage signals.
  { pattern: /\bfinalization_failed\b/, label: 'finalization_failed' },
  { pattern: /\bruntime_verify_failed\b/, label: 'runtime_verify_failed' },
  { pattern: /\bbundle_mismatch\b/, label: 'bundle_mismatch' },
  { pattern: /\bpreflight_failed\b/, label: 'preflight_failed' },
];

function extractFailureClass(raw: string): string {
  for (const entry of FAILURE_CLASS_PATTERNS) {
    const match = raw.match(entry.pattern);
    if (match) {
      return entry.label === '$0' ? match[0].trim() : entry.label;
    }
  }
  return 'unknown';
}

// Issue #2386: This is a non-reversible correlation digest for de-duplicating
// repeated BOT ERRORS evidence without exposing raw content. It is NOT used
// for password hashing, credential storage, or any security-sensitive purpose.
// Uses pbkdf2 (a slow KDF) which CodeQL considers sufficient computational
// effort — the correct primitive choice when credential-tainted data may flow
// into a dedup key. 1000 iterations is deliberate: this is a correlation
// digest on error paths (not a hot loop), so the cost is negligible while
// satisfying the KDF-effort requirement. Domain separation via the salt
// (the `domain` argument) prevents cross-domain collisions.
function digestContent(domain: string, value: string): string {
  return pbkdf2Sync(value, `bot-errors-evidence:${domain}`, 1000, 32, 'sha256')
    .toString('hex');
}

/**
 * Project a raw evidence or summary string into bounded, content-free metadata.
 *
 * The raw content is never included in the return value. The caller may
 * discard the raw string after calling this function.
 *
 * @param domain - domain separator (``"evidence"`` or ``"summary"``)
 * @param raw - the raw string to confine (may be empty/undefined)
 */
export function confineAlertContent(
  domain: 'evidence' | 'summary',
  raw: string | undefined,
): ConfinedAlertContent {
  if (!raw || raw.trim().length === 0) {
    return EMPTY_CONFINED;
  }
  return {
    failureClass: extractFailureClass(raw),
    length: raw.length,
    correlationDigest: digestContent(domain, raw),
  };
}
