/**
 * OAuth refresh-failure diagnostics.
 *
 * Classifies raw OAuth token-refresh error text into a reason taxonomy and
 * formats safe operator-facing copy without trusting raw provider text.
 *
 * Two concerns:
 *
 * 1. **Lock-path redaction.** Refresh failures often include local filesystem
 *    lock paths (`<local>/auth.lock`, `<local>/token.lock`) that leak host
 *    internals. `redactLocalPaths()` replaces them with `<local-path>`.
 * 2. **Duplicate-prefix deduplication.** The same failure surfaced through
 *    multiple layers can accumulate repeated identical prefixes
 *    (`Error: Error: OAuth refresh failed: ...`). `dedupFailurePrefixes()`
 *    collapses them.
 *
 * The classifier keys off well-known substrings (RFC 6749 error codes + common
 * provider phrases) rather than trusting provider text verbatim.
 */

/** Classified reason for an OAuth refresh failure (RFC 6749 + provider-specific). */
export type OAuthRefreshFailureReason =
  | 'refresh_token_reused' // token replay detected
  | 'invalid_grant' // RFC 6749 §5.2
  | 'sign_in_again' // provider wants interactive re-auth
  | 'invalid_refresh_token' // token malformed/expired
  | 'token_invalidated' // revoked server-side
  | 'revoked'; // explicit revocation

/** All reasons, for iteration in tests. */
export const OAUTH_REFRESH_FAILURE_REASONS: readonly OAuthRefreshFailureReason[] = [
  'refresh_token_reused',
  'invalid_grant',
  'sign_in_again',
  'invalid_refresh_token',
  'token_invalidated',
  'revoked',
];

interface ReasonPattern {
  reason: OAuthRefreshFailureReason;
  /** Matched case-insensitively against the lowercased message. */
  pattern: RegExp;
}

const REASON_PATTERNS: readonly ReasonPattern[] = [
  // Order matters: more specific before more general.
  { reason: 'refresh_token_reused', pattern: /refresh.?token.*(reused|replay|already.?used)/ },
  { reason: 'token_invalidated', pattern: /token.*(invalidated|no.?longer.?valid)/ },
  { reason: 'invalid_refresh_token', pattern: /invalid.?refresh.?token/ },
  { reason: 'revoked', pattern: /\brevoked\b/ },
  { reason: 'sign_in_again', pattern: /sign.?in.?again|re.?authenticate|re.?auth.?required/ },
  { reason: 'invalid_grant', pattern: /\binvalid_grant\b/ },
];

/**
 * Classify a raw OAuth refresh error message into a reason, or `null` if no
 * known pattern matches. Case-insensitive.
 */
export function classifyOAuthRefreshFailureReason(
  message: string,
): OAuthRefreshFailureReason | null {
  if (!message) return null;
  const lower = message.toLowerCase();
  for (const { reason, pattern } of REASON_PATTERNS) {
    if (pattern.test(lower)) {
      return reason;
    }
  }
  return null;
}

/** Human-readable label for a reason (for logs / operator copy). */
export function reasonLabel(reason: OAuthRefreshFailureReason): string {
  const labels: Record<OAuthRefreshFailureReason, string> = {
    refresh_token_reused: 'refresh token was reused',
    invalid_grant: 'invalid grant',
    sign_in_again: 'sign-in required',
    invalid_refresh_token: 'invalid refresh token',
    token_invalidated: 'token invalidated',
    revoked: 'token revoked',
  };
  return labels[reason];
}

/**
 * Redact local filesystem paths from text. Replaces absolute Unix paths
 * (matching common lock-file patterns) with `<local-path>`. Does not touch
 * URLs or relative paths.
 */
export function redactLocalPaths(text: string): string {
  if (!text) return text;
  // Match absolute paths that look like lock/auth/token files: /foo/bar/baz.lock
  // or <local>/auth, <local>/token, <local>/credentials, etc.
  return text.replace(
    /(?:\/(?:home|Users|tmp|var|etc|root|opt|app)[\w./-]*)?(?:\/[\w.-]+)*\.(?:lock|token|cred(?:ential)?s?|auth|key)/g,
    '<local-path>',
  );
}

/**
 * Collapse repeated identical prefixes. Turns
 * `Error: Error: OAuth refresh failed: ...` into
 * `Error: OAuth refresh failed: ...`.
 *
 * A "prefix" here is a leading token ending in `:` or ` -` that repeats
 * consecutively at the start of the string.
 */
export function dedupFailurePrefixes(text: string): string {
  if (!text) return text;
  let out = text;
  for (let i = 0; i < 8; i++) {
    // Match a leading "Token: " prefix repeated 2+ times. Capture group 1 is
    // a single prefix instance; (\1)+ matches the subsequent repetitions.
    const m = out.match(/^(\S[^:\n]*?:\s+)(\1)+/);
    if (!m) break;
    // Keep one prefix, drop the rest.
    out = m[1] + out.slice(m[0].length);
  }
  return out.trim();
}

/** Auth mode affects the operator hint (re-auth vs top-up). */
export type AuthMode = 'oauth' | 'api_key';

/** Input to {@link formatOAuthRefreshFailure}. */
export interface OAuthRefreshFailureFormatInput {
  /** Raw provider error message. */
  message: string;
  /** Provider name for the label (e.g. 'anthropic'). */
  provider?: string;
  /** Auth mode, for the operator hint. Default 'oauth'. */
  authMode?: AuthMode;
}

/** Result of formatting a refresh failure for the operator. */
export interface FormattedOAuthRefreshFailure {
  /** Classified reason, or null if unrecognized. */
  reason: OAuthRefreshFailureReason | null;
  /** Cleaned, redacted, single-prefix message. */
  message: string;
  /** Operator-facing hint (re-authenticate / check subscription). */
  hint: string;
}

/**
 * Format a raw OAuth refresh failure into safe operator-facing copy.
 * Classifies the reason, redacts lock paths, dedups prefixes, and emits an
 * auth-mode-aware hint.
 */
export function formatOAuthRefreshFailure(
  input: OAuthRefreshFailureFormatInput,
): FormattedOAuthRefreshFailure {
  const authMode = input.authMode ?? 'oauth';
  const cleaned = dedupFailurePrefixes(redactLocalPaths(input.message ?? ''));
  const reason = classifyOAuthRefreshFailureReason(cleaned);
  const providerLabel = input.provider ? `${input.provider}: ` : '';
  const reasonText = reason ? `${providerLabel}${reasonLabel(reason)}` : `${providerLabel}refresh failed`;

  const hint =
    authMode === 'oauth'
      ? 'Re-authenticate to restore access.'
      : 'Check your API key and top up credits if needed.';

  return {
    reason,
    message: cleaned,
    hint: `${reasonText}. ${hint}`,
  };
}
