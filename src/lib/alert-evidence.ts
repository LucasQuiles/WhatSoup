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
 * - ``conversationScope`` (see {@link confineConversationScope}): a bounded,
 *   domain-separated digest of the conversation a per-conversation fault
 *   belongs to. Emitted as its own event field, never inside prose. It exists
 *   because the bot-errors dispatcher keys incidents on
 *   machine|instance|source and otherwise cannot tell one wedged conversation
 *   from another under the same instance — so one chat's open incident
 *   silently absorbs every other chat's outage. The digest is the smallest
 *   value that restores that distinction without shipping an identifier.
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

/**
 * Hex length of an emitted conversation digest. Matches the dispatcher's
 * existing ``incident_source_fingerprint`` convention (16 hex chars), which
 * is what the incident-state file is already sized and validated for.
 */
const CONVERSATION_SCOPE_HEX_LENGTH = 16;

/**
 * Project a raw conversation identifier into a bounded, non-reversible scope
 * digest.
 *
 * Uses the same slow KDF as {@link confineAlertContent} under its own domain
 * salt, and domain separation keeps this digest from colliding with an
 * evidence or summary digest of the same bytes.
 *
 * What this provides, stated precisely: the emitted value is not a plaintext
 * identifier, it is deterministic so the dispatcher can compare two events,
 * and it is domain-separated. What it does NOT provide is secrecy against a
 * determined offline attacker. The salt is fixed and public, the iteration
 * count is 1000, and the output is truncated to 16 hex characters, so against
 * a conversation-identifier space of roughly 10^10 candidates an exhaustive
 * search remains tractable on commodity hardware — 1000 iterations raises the
 * cost by about three orders of magnitude, which is a real but not decisive
 * margin. Treat this as a bounded, non-reversible-in-practice value for logs
 * and alert routing, never as a secret. Raising the cost was considered and
 * not done here: this is an error path that must stay cheap, and the value's
 * job is de-duplication rather than confidentiality.
 *
 * Returns ``null`` — never an empty string or a placeholder — when the caller
 * has no conversation, so the field can be omitted from the event entirely and
 * the emitted shape stays backward compatible.
 *
 * @param conversationKey - raw conversation identifier (never emitted)
 */
export function confineConversationScope(
  conversationKey: string | undefined | null,
): string | null {
  const trimmed = conversationKey?.trim() ?? '';
  if (trimmed.length === 0) return null;
  return digestContent('conversation', trimmed).slice(0, CONVERSATION_SCOPE_HEX_LENGTH);
}
