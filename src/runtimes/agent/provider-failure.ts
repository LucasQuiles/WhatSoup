// Single source of truth for recognising terminal provider/CLI failure strings.
//
// Why this exists (PR-A): provider-failure classification was previously duplicated
// inline across the per-chat result handler, the shared-session result handler, the
// `fallbackReasonForResultText` helper, and two `assistant_text` streaming-suppression
// checks. A string class added to one site silently missed the others, and an
// unclassified terminal error (e.g. a rejected conversation model) was forwarded raw
// to the user. This module centralises the matchers so every consumer classifies the
// same way.
//
// Scope: PURE text matching of provider/CLI output. It does NOT decide "unknown
// terminal failure" — that is a handler decision, because only the result handler
// knows the event was an `is_error` result (see stream-parser: a `result` event only
// carries text when `is_error === true`; genuine replies arrive via `assistant_text`).
// Streaming-suppression therefore suppresses only KNOWN failure kinds; the result
// handler additionally default-denies an unmatched error result as unknown-terminal.
//
// The individual matcher bodies below are migrated verbatim from the previous inline
// implementations in `runtime.ts` to guarantee behaviour parity; `model-unavailable`
// is the one added class. Keep matchers conservative so ordinary assistant prose that
// merely mentions a model is never misclassified as a failure.

/** Recognised terminal provider-failure classes. `null` from the classifier means
 *  "not a recognised provider failure" (treat as genuine output / unknown per caller). */
export type ProviderFailureKind =
  | 'usage-limit'
  | 'rate-limit'
  | 'auth-required'
  | 'model-unavailable'
  | 'policy-block'
  | 'context-overflow';

export function isPromptTooLongMessage(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('prompt is too long') ||
    lower.includes('prompt too long') ||
    lower.includes('maximum context length') ||
    lower.includes('context_length_exceeded') ||
    lower.includes('max_tokens_exceeded') ||
    (lower.includes('token') && lower.includes('limit') && lower.includes('exceed'))
  );
}

export function isUsageLimitMessage(text: string): boolean {
  if (isPromptTooLongMessage(text)) return false; // distinct error path

  const lower = text.toLowerCase();
  if (
    lower.includes('out of extra usage') ||
    lower.includes('usage limit reached') ||
    lower.includes('usage cap reached') ||
    lower.includes("you've reached your usage limit") ||
    lower.includes('you have reached your usage limit') ||
    lower.includes('you have hit your usage limit') ||
    lower.includes('claude usage limit')
  ) {
    return true;
  }

  const resetPattern = /\b(claude\s+)?(will\s+be\s+available|resets?|come\s+back)\s+(at\s+|in\s+)?\d{1,2}(:\d{2})?\s*(am|pm)\b/i;
  return resetPattern.test(text) && (
    lower.includes('usage limit') ||
    lower.includes('usage cap') ||
    lower.includes('plan limit') ||
    lower.includes('quota exceeded')
  );
}

export function isProviderAuthRequiredMessage(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('not logged in') ||
    lower.includes('please run /login') ||
    lower.includes('please login') ||
    lower.includes('authentication required') ||
    lower.includes('auth required') ||
    lower.includes('invalid api key') ||
    lower.includes('missing api key') ||
    lower.includes('no api key') ||
    (lower.includes('oauth') && lower.includes('expired'))
  );
}

export function isRateLimitResultMessage(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('rate limited') ||
    lower.includes('rate limit exceeded') ||
    lower.includes('too many requests') ||
    lower.includes('429')
  ) && !isUsageLimitMessage(text);
}

export function isProviderPolicyBlockMessage(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('usage policy') ||
    lower.includes('policy violation') ||
    lower.includes('violates our policy') ||
    lower.includes('violative') ||
    lower.includes('blocked by policy')
  );
}

/**
 * Conservative matcher for "the selected model does not exist / no access" errors —
 * the class behind the production incident where a rejected conversation model's raw
 * CLI error was forwarded to users. Requires provider-style phrasing so ordinary prose
 * ("I couldn't find that model in the docs") is NOT matched.
 */
export function isProviderModelUnavailableMessage(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    (lower.includes('issue with the selected model') &&
      lower.includes('may not exist') &&
      lower.includes('may not have access')) ||
    lower.includes('does not exist or you do not have access') ||
    lower.includes('model not found in provider catalog') ||
    (lower.includes('unknown model') && lower.includes('provider'))
  );
}

/**
 * Classify a provider/CLI output string into a recognised terminal-failure kind, or
 * `null` when no known failure pattern matches.
 *
 * Precedence preserves origin/main semantics: context-overflow is checked before
 * usage-limit (the old `isUsageLimitMessage` returned false for prompt-too-long), and
 * usage-limit before rate-limit (the old `isRateLimitResultMessage` excluded
 * usage-limit messages).
 */
export function classifyProviderFailure(text: string): ProviderFailureKind | null {
  if (!text) return null;
  if (isPromptTooLongMessage(text)) return 'context-overflow';
  if (isUsageLimitMessage(text)) return 'usage-limit';
  if (isProviderAuthRequiredMessage(text)) return 'auth-required';
  if (isRateLimitResultMessage(text)) return 'rate-limit';
  if (isProviderPolicyBlockMessage(text)) return 'policy-block';
  if (isProviderModelUnavailableMessage(text)) return 'model-unavailable';
  return null;
}

/** Kinds that activate provider fallback. policy-block and context-overflow are
 *  suppressed without fallback (mirrors origin/main: kill session, no fallback). */
const FALLBACK_KINDS: ReadonlySet<ProviderFailureKind> = new Set<ProviderFailureKind>([
  'usage-limit',
  'rate-limit',
  'auth-required',
  'model-unavailable',
]);

export function providerFailureArmsFallback(kind: ProviderFailureKind): boolean {
  return FALLBACK_KINDS.has(kind);
}
