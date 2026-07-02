import { WhatSoupError } from '../../errors.ts';
import { shortHash } from '../../lib/short-hash.ts';

export type AgentFailureClass =
  | 'provider_usage_limit'
  | 'provider_rate_limit'
  | 'provider_server_error'
  | 'provider_context_overflow'
  | 'provider_model_unavailable'
  | 'provider_policy_block'
  | 'provider_cli_crash'
  | 'provider_timeout'
  | 'provider_network_error'
  | 'provider_silent_hang'
  | 'provider_stream_corrupt'
  | 'provider_auth_required'
  | 'provider_binary_missing'
  | 'provider_permission_denied'
  | 'mcp_transport_failure'
  | 'tool_handler_exception'
  | 'config_or_capability_missing'
  | 'provider_unknown';

export type AgentFailureSource =
  | 'provider_result'
  | 'provider_error'
  | 'provider_process_exit'
  | 'provider_watchdog'
  | 'provider_stream'
  | 'mcp_transport'
  | 'tool_result'
  | 'config';

export type BackupFailureDomain = 'unknown' | 'shared' | 'independent';
export type BackupContextWindow = 'unknown' | 'same_or_smaller' | 'larger';

export interface AgentFailureInput {
  source: AgentFailureSource;
  instanceName: string;
  provider: string;
  chatJid?: string | null;
  mapKey?: string | null;
  sessionId?: string | null;
  toolName?: string | null;
  message?: string | null;
  error?: unknown;
  exitCode?: number | null;
  signal?: string | null;
  backupFailureDomain?: BackupFailureDomain;
  backupContextWindow?: BackupContextWindow;
}

export interface AgentFailureClassification {
  failureClass: AgentFailureClass;
  source: AgentFailureSource;
  instanceName: string;
  provider: string;
  chatJid: string | null;
  mapKey: string | null;
  sessionId: string | null;
  toolName: string | null;
  summary: string;
  incidentId: string;
  fallbackEligible: boolean;
  qAlertRequired: boolean;
  severity: 'critical' | 'warning';
}

export type ProviderFailureKind =
  | 'usage-limit'
  | 'rate-limit'
  | 'auth-required'
  | 'model-unavailable'
  | 'policy-block'
  | 'context-overflow'
  // Transient backend / overload (HTTP 5xx, 529 overloaded_error, "Service
  // temporarily unavailable"). Terminal for the turn but recoverable on retry —
  // arms fallback so the user gets continuity, with a deterministic retry timer.
  | 'server-error'
  // Transient provider streaming-socket drop (ECONNRESET, socket hang up, etc.).
  // Terminal for the turn but recoverable — the next inbound message respawns the
  // session. Does NOT arm fallback (no provider-level action needed).
  | 'transient-network';

/**
 * SSOT registry of the terminal limit-name tokens the agent provider CLI emits.
 * Its limit-name map covers the 5-hour session cap, the 7-day weekly cap, the
 * per-model-tier weekly caps, and the usage-credit overage, plus the API/plan
 * tier caps. Every provider parser and the runtime classifier key off this list,
 * so onboarding a new provider limit name is a one-line edit here rather than a
 * scatter of substrings that silently drift (the "session limit" non-rollover class).
 */
export const LIMIT_NAME_TOKENS: readonly string[] = [
  'session limit',
  'weekly limit',
  'opus limit',
  'sonnet limit',
  'usage credit limit',
  'usage limit',
  'usage cap',
  'plan limit',
  'fast limit',
  'monthly spend limit',
];

/**
 * Detect the agent provider CLI's assembled TERMINAL limit phrasings
 * (`You've hit your ${name}` / `${name} reached` / org `$0` allocation). Anchored
 * on a possessive/terminal verb so a conversational mention of a limit name
 * ("add a weekly limit to the config") never matches. The non-terminal
 * `Approaching ${name}` warning is intentionally NOT matched here — arming
 * fallback on a warning would be a premature-rollover failure mode.
 */
function hasTerminalLimitAssembler(lower: string): boolean {
  for (const name of LIMIT_NAME_TOKENS) {
    if (
      lower.includes(`hit your ${name}`) ||
      lower.includes(`reached your ${name}`) ||
      lower.includes(`${name} reached`) ||
      lower.includes(`${name} is set to $0`)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Detect the agent provider CLI's NON-terminal limit warnings ("Approaching ${name}",
 * "You're now using ${name}", "You're close to your ${name}", "You've used N% of
 * your ${name}"). Anchored on a known limit name so it cannot swallow a genuine
 * terminal message that merely happens to contain the word "approaching" or
 * "now using" in another position — those must still classify as terminal via the
 * reset-cue branch (a false negative here is a silent no-rollover).
 */
function hasApproachingLimitWarning(lower: string): boolean {
  if (lower.includes('% of your')) return true;
  for (const name of LIMIT_NAME_TOKENS) {
    if (
      lower.includes(`approaching ${name}`) ||
      lower.includes(`approaching your ${name}`) ||
      lower.includes(`now using ${name}`) ||
      lower.includes(`close to your ${name}`)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Detect provider usage-limit / quota-exceeded messages that should not be
 * forwarded as normal user-visible agent output.
 */
export function isUsageLimitMessage(text: string): boolean {
  if (isPromptTooLongMessage(text)) return false;

  const lower = text.toLowerCase();
  if (isProviderCreditBalanceLimitMessage(lower)) return true;

  if (
    lower.includes('out of extra usage') ||
    lower.includes('claude usage limit') ||
    // Model-policy credit gate: the account's plan only permits a model that
    // needs usage credits the account lacks (e.g. a Fable-5-only policy). The
    // provider emits this during compaction and it is terminal for the turn —
    // route it to fallback rather than stalling on an unusable model.
    lower.includes('requires usage credits') ||
    (lower.includes('model policy only allows') && lower.includes('usage credit')) ||
    hasTerminalLimitAssembler(lower)
  ) {
    return true;
  }

  // Non-terminal warnings ("Approaching <name>", "You're now using <name>",
  // "You've used N% of your <name>"): the provider can still serve this turn, so
  // they must not arm fallback. Excluded before the reset-cue branch so that a
  // warning carrying a reset time does not get classified as terminal.
  if (hasApproachingLimitWarning(lower)) return false;

  const resetPattern = /\b(claude\s+)?(will\s+be\s+available|resets?|come\s+back)\s+(at\s+|in\s+)?\d{1,2}(:\d{2})?\s*(am|pm)\b/i;
  return resetPattern.test(text) && (
    LIMIT_NAME_TOKENS.some((token) => lower.includes(token)) ||
    lower.includes('quota exceeded')
  );
}

function isProviderCreditBalanceLimitMessage(lower: string): boolean {
  const providerBillingContext = (
    lower.includes('provider') ||
    lower.includes('api') ||
    lower.includes('billing') ||
    lower.includes('quota')
  );
  return (
    lower.includes('insufficient_quota') ||
    // Anthropic 403 billing_error — a quota/billing cap, not a permission issue.
    lower.includes('billing_error') ||
    lower.includes('billing quota exceeded') ||
    // Subscription credit/overage + org-allocation exhaustion. These are
    // terminal for the turn but carry no billing co-word, so match them directly.
    lower.includes('out of usage credits') ||
    (
      lower.includes('out of usage') &&
      (
        lower.includes('add funds') ||
        lower.includes('contact your admin') ||
        lower.includes('your org') ||
        lower.includes('org is') ||
        lower.includes('group')
      )
    ) ||
    (
      providerBillingContext &&
      (
        lower.includes('insufficient credits') ||
        lower.includes('no credits remaining') ||
        lower.includes('credit balance exhausted')
      )
    ) ||
    (
      lower.includes('account balance') &&
      (lower.includes('provider') || lower.includes('api') || lower.includes('billing')) &&
      (lower.includes('too low') || lower.includes('insufficient') || lower.includes('exhausted'))
    )
  );
}

/** Detect context-window overflow errors from agent providers. */
export function isPromptTooLongMessage(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('prompt is too long') ||
    lower.includes('prompt too long') ||
    lower.includes('maximum context length') ||
    lower.includes('context_length_exceeded') ||
    lower.includes('max_tokens_exceeded') ||
    // Canonical structured tokens: Anthropic 413 request_too_large and the
    // model_context_window_exceeded stop reason; OpenAI context_length_exceeded.
    lower.includes('request_too_large') ||
    lower.includes('model_context_window_exceeded') ||
    (lower.includes('token') && lower.includes('limit') && lower.includes('exceed'))
  );
}

/** Detect terminal provider rate-limit result text. */
export function isRateLimitResultMessage(text: string): boolean {
  const normalized = normalizeWhitespace(text).toLowerCase();
  return (
    normalized === '_rate limited - please wait a moment and try again._' ||
    normalized === 'rate limited - please wait a moment and try again.' ||
    normalized.includes('provider rate limited') ||
    normalized.includes('api rate limited') ||
    // Canonical structured tokens for a TRANSIENT rate limit. insufficient_quota
    // is deliberately excluded by the isUsageLimitMessage guard below — a quota
    // cap is a usage-limit (account action), not a transient rate limit.
    normalized.includes('rate_limit_exceeded') ||
    normalized.includes('rate_limit_error') ||
    /\b429\b/.test(normalized)
  ) && !isUsageLimitMessage(text);
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
    // Canonical structured tokens: Anthropic authentication_error (401),
    // OpenAI invalid_api_key (401).
    lower.includes('authentication_error') ||
    lower.includes('invalid_api_key') ||
    // Canonical 401 bodies surfaced by claude-cli / Google-style auth: the literal
    // phrase, never the bare numeric status (the bare '401' substring is deliberately
    // NOT matched — that produced the prior multi-day false storm). These are specific
    // multi-word auth phrases, safe from the substring false-positive.
    lower.includes('invalid authentication credentials') ||
    lower.includes('failed to authenticate') ||
    (lower.includes('oauth') && lower.includes('expired'))
  );
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

export function isProviderModelUnavailableMessage(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    (lower.includes('issue with the selected model') &&
      lower.includes('may not exist') &&
      lower.includes('may not have access')) ||
    lower.includes('does not exist or you do not have access') ||
    lower.includes('model not found in provider catalog') ||
    // Canonical structured tokens: Anthropic not_found_error (404 model id),
    // OpenAI model_not_found.
    lower.includes('not_found_error') ||
    lower.includes('model_not_found') ||
    (lower.includes('unknown model') && lower.includes('provider'))
  );
}

/**
 * Detect transient provider server-side failures: HTTP 5xx, Anthropic's 529
 * overloaded_error, and the friendly compaction/result variants the CLI emits.
 * These are turn-terminal but recoverable on retry — they arm fallback so the
 * user sees continuity instead of silence, with a deterministic retry timer.
 *
 * Ordering: classifyProviderFailure() puts server-error AFTER usage/rate/auth so
 * a 5xx that's actually a quota/auth-tagged response is classified by its richer
 * meaning first.
 */
export function isProviderServerErrorMessage(text: string): boolean {
  const lower = text.toLowerCase();
  if (
    lower.includes('_service temporarily unavailable') ||
    lower.includes('service temporarily unavailable') ||
    lower.includes('_service error (') ||
    lower.includes('overloaded_error') ||
    lower.includes('api_error') ||
    lower.includes('server_error') ||
    lower.includes('server_unavailable') ||
    // "We are experiencing high demand for <model>" — backend capacity message.
    lower.includes('experiencing high demand for')
  ) return true;
  // Bare HTTP status — matches 500/502/503/504/529 with a word boundary so it
  // does not collide with body text like "500 tokens" or "529ms".
  return /\b(50[0-9]|529)\b/.test(lower) && (
    lower.includes('http') ||
    lower.includes('status') ||
    lower.includes('error') ||
    lower.includes('overload')
  );
}

/**
 * Detect the harness's TRANSPARENCY notice that it auto-switched the active
 * model (e.g. "Switched to Opus 4.7 due to high demand for Opus 4.8"). This is
 * NOT a failure — the harness recovered locally — but the user should see it so
 * they understand which model is currently answering. Surface to the conversation
 * for visibility; do NOT arm fallback.
 */
export interface AutoSwitchNotice { from: string | null; to: string; reason: string }
export function detectAutoSwitchNotice(text: string): AutoSwitchNotice | null {
  // The CLI emits two compatible forms:
  //   "Switched to <to> due to high demand for <from>"
  //   "(You're) Now using <to> · resets <time>"
  // Anchored on the literal verbs at start-of-line / start-of-text so ordinary
  // mid-sentence usage ("Now using opus is the default…") never matches.
  // QR-130: the start anchor was `(?:^|\n|\s)` — the `\s` alternative matches at
  // EVERY whitespace, creating O(n) start positions, and at each one the lazy
  // `[^·\n]+?` re-scans for the " due to high demand for " literal → O(n²)
  // catastrophic backtracking on a crafted reply (e.g. "Switched to " repeated:
  // ~4.7s at 480 KB, ~30s at 1.2 MB). This runs synchronously on the FULL agent
  // reply text (enqueueAutoSwitchNotice) BEFORE splitMessage, so a prompt-injected
  // reply freezes the event loop (Node single-thread → all chats/heartbeat). Pin
  // the start to a true line/text anchor plus bounded indent (`[ \t]*`): one start
  // per line, linear. This also matches the code's OWN stated intent
  // (start-of-line/text) — the `\s` form actually violated it by matching mid-line.
  const switched = text.match(/(?:^|\n)[ \t]*Switched to (?<to>[^·\n]+?) due to high demand for (?<from>[^\n·]+?)(?:\s*·|\s*$|\.\s*$|\.\s+(?=[A-Z]))/i);
  if (switched?.groups) {
    return {
      from: switched.groups.from.trim(),
      to: switched.groups.to.trim(),
      reason: 'high-demand',
    };
  }
  // QR-133: the prior capture `(?<to>[^·\n]+?)\s*·` is quadratic — the lazy
  // `[^·\n]+?` overlaps the trailing `\s*` on whitespace (both match spaces), so a
  // crafted "Now using x" + a long space run with no `·` backtracks O(n²) (~1.2s at
  // 50 KB, ~19s at 200 KB). Same synchronous reply-path sink as QR-130 (runs in this
  // same detectAutoSwitchNotice). Use a greedy capture bounded by the `·` delimiter
  // (which the class excludes) — linear — and let the existing `.trim()` drop the
  // trailing space. Verified identical `.trim()` output to the prior regex on real
  // "Now using <model> · resets …" notices.
  const nowUsing = text.match(/(?:^|\n)(?:You're n|N)ow using (?<to>[^·\n]+)·/);
  if (nowUsing?.groups) {
    return { from: null, to: nowUsing.groups.to.trim(), reason: 'auto-routed' };
  }
  return null;
}

/**
 * Detect transient provider streaming-socket drops that are terminal for the
 * turn but immediately recoverable — the next inbound message respawns the
 * session, so these must NOT page CRITICAL or arm fallback.
 *
 * Anchored on literal socket/connection/errno tokens so that ordinary
 * discussion of connection handling ("document how socket timeouts and
 * connection resets are handled") never matches. Mirrors the false-positive
 * guards in isRateLimitResultMessage and isProviderModelUnavailableMessage
 * (anchor on a known-error verb/token, not on ambient prose words).
 *
 * ETIMEDOUT requires a connection/socket context word alongside it to avoid
 * matching generic "request timed out" messages that should fall through to
 * server-error classification.
 */
export function isTransientProviderConnectionMessage(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  if (
    lower.includes('socket connection was closed unexpectedly') ||
    lower.includes('socket hang up') ||
    lower.includes('connection closed unexpectedly') ||
    lower.includes('connection reset by peer') ||
    lower.includes('econnreset')
  ) return true;
  // ETIMEDOUT only in a connection/socket context to avoid swallowing generic
  // request-timeout messages (those are server-error territory).
  if (
    lower.includes('etimedout') &&
    (lower.includes('socket') || lower.includes('connect') || lower.includes('peer'))
  ) return true;
  return false;
}

export function classifyProviderFailure(text: string): ProviderFailureKind | null {
  if (!text) return null;
  if (isPromptTooLongMessage(text)) return 'context-overflow';
  if (isUsageLimitMessage(text)) return 'usage-limit';
  if (isProviderAuthRequiredMessage(text)) return 'auth-required';
  if (isRateLimitResultMessage(text)) return 'rate-limit';
  if (isProviderPolicyBlockMessage(text)) return 'policy-block';
  if (isProviderModelUnavailableMessage(text)) return 'model-unavailable';
  if (isProviderServerErrorMessage(text)) return 'server-error';
  if (isTransientProviderConnectionMessage(text)) return 'transient-network';
  return null;
}

const FALLBACK_PROVIDER_FAILURE_KINDS: ReadonlySet<ProviderFailureKind> = new Set<ProviderFailureKind>([
  'usage-limit',
  'rate-limit',
  'auth-required',
  'model-unavailable',
  'server-error',
]);

export function providerFailureArmsFallback(kind: ProviderFailureKind): boolean {
  return FALLBACK_PROVIDER_FAILURE_KINDS.has(kind);
}

export function isExpectedProviderShutdown(input: {
  source: AgentFailureSource;
  exitCode?: number | null;
  signal?: string | null;
}): boolean {
  if (input.source !== 'provider_process_exit') return false;
  const exitCode = input.exitCode ?? null;
  const signal = input.signal ?? null;
  if (exitCode === 0 && signal === null) return true;
  return signal === 'SIGTERM' || signal === 'SIGINT';
}

export function classifyAgentFailure(input: AgentFailureInput): AgentFailureClassification {
  const message = extractFailureMessage(input);
  const failureClass = classifyFailureClass(input, message);
  const expectedShutdown = isExpectedProviderShutdown(input);
  const normalized: AgentFailureClassification = {
    failureClass,
    source: input.source,
    instanceName: input.instanceName,
    provider: input.provider,
    chatJid: input.chatJid ?? null,
    mapKey: input.mapKey ?? null,
    sessionId: input.sessionId ?? null,
    toolName: input.toolName ?? null,
    summary: summarizeFailure(failureClass, message, input),
    incidentId: '',
    fallbackEligible: isFallbackEligibleForFailureClass(failureClass, {
      failureDomain: input.backupFailureDomain,
      contextWindow: input.backupContextWindow,
    }),
    qAlertRequired: !expectedShutdown,
    severity: severityForFailureClass(failureClass),
  };
  return {
    ...normalized,
    incidentId: buildAgentFailureIncidentId(normalized, message),
  };
}

export interface BackupFallbackPolicy {
  failureDomain?: BackupFailureDomain;
  contextWindow?: BackupContextWindow;
}

export function isFallbackEligibleForFailureClass(
  failureClass: AgentFailureClass,
  policy: BackupFallbackPolicy = {},
): boolean {
  const independent = policy.failureDomain === 'independent';
  switch (failureClass) {
    case 'provider_usage_limit':
    case 'provider_rate_limit':
    case 'provider_server_error':
    case 'provider_cli_crash':
    case 'provider_timeout':
    case 'provider_network_error':
    case 'provider_silent_hang':
    case 'provider_stream_corrupt':
    case 'provider_model_unavailable':
      return independent;
    case 'provider_context_overflow':
      return independent && policy.contextWindow === 'larger';
    case 'provider_policy_block':
    case 'provider_binary_missing':
    case 'provider_permission_denied':
    case 'provider_auth_required':
    case 'mcp_transport_failure':
    case 'tool_handler_exception':
    case 'config_or_capability_missing':
    case 'provider_unknown':
      return false;
  }
}

function classifyFailureClass(input: AgentFailureInput, message: string): AgentFailureClass {
  const statusCode = extractStatusCode(input.error);
  const errno = extractErrno(input.error);
  const lower = message.toLowerCase();

  if (input.source === 'provider_watchdog') return 'provider_silent_hang';
  if (input.source === 'provider_stream') return 'provider_stream_corrupt';

  if (input.source === 'provider_process_exit') {
    if (isExpectedProviderShutdown(input)) return 'provider_unknown';
    if ((input.exitCode ?? null) !== 0 || input.signal) return 'provider_cli_crash';
  }

  if (isPromptTooLongMessage(message)) return 'provider_context_overflow';
  if (isUsageLimitMessage(message)) return 'provider_usage_limit';
  if (isRateLimitResultMessage(message)) return 'provider_rate_limit';
  if (isProviderAuthRequiredMessage(message)) return 'provider_auth_required';
  if (isProviderModelUnavailableMessage(message)) return 'provider_model_unavailable';
  if (isProviderPolicyBlockMessage(message)) return 'provider_policy_block';

  if (input.error instanceof WhatSoupError) {
    switch (input.error.code) {
      case 'LLM_RATE_LIMITED':
        return 'provider_rate_limit';
      case 'LLM_TIMEOUT':
        return 'provider_timeout';
      case 'LLM_AUTH_ERROR':
        return 'provider_auth_required';
      case 'LLM_BAD_REQUEST':
        return 'config_or_capability_missing';
      case 'LLM_UNAVAILABLE':
        if (statusCode !== undefined && statusCode >= 500 && statusCode <= 599) return 'provider_server_error';
        if (errno) return 'provider_network_error';
        return 'provider_server_error';
      default:
        break;
    }
  }

  if (statusCode === 429 || /\b429\b/.test(lower) || lower.includes('rate limit')) {
    return 'provider_rate_limit';
  }
  if (statusCode !== undefined && statusCode >= 500 && statusCode <= 599) {
    return 'provider_server_error';
  }
  if (statusCode === 401 || statusCode === 403 || lower.includes('reauth') || lower.includes('re-auth')) {
    return 'provider_auth_required';
  }
  if (lower.includes('missing api key') || lower.includes('auth failed')) {
    return 'config_or_capability_missing';
  }
  if (lower.includes('no output') || lower.includes('silent hang') || lower.includes('watchdog')) {
    return 'provider_silent_hang';
  }
  if (lower.includes('malformed stream') || lower.includes('stream-json') || lower.includes('partial output') || lower.includes('parse_error')) {
    return 'provider_stream_corrupt';
  }
  if (errno === 'ECONNREFUSED' || errno === 'ENOTFOUND' || errno === 'ECONNRESET' || errno === 'ETIMEDOUT') {
    return input.source === 'mcp_transport' ? 'mcp_transport_failure' : 'provider_network_error';
  }
  if (lower.includes('not installed') || lower.includes('unknown provider') || lower.includes('unknown skill')) {
    return 'config_or_capability_missing';
  }
  if (input.source === 'mcp_transport') return 'mcp_transport_failure';
  if (input.source === 'tool_result') return 'tool_handler_exception';
  if (input.source === 'config') return 'config_or_capability_missing';

  return 'provider_unknown';
}

function extractFailureMessage(input: AgentFailureInput): string {
  if (input.message && input.message.trim()) return input.message.trim();
  if (input.error instanceof Error) return input.error.message;
  if (input.error !== undefined) return String(input.error);
  if (input.exitCode !== undefined || input.signal !== undefined) {
    return `provider exited with code=${input.exitCode ?? 'null'} signal=${input.signal ?? 'none'}`;
  }
  return 'unknown agent failure';
}

function extractStatusCode(error: unknown): number | undefined {
  if (error instanceof WhatSoupError) return extractStatusCode((error as unknown as { cause?: unknown }).cause);
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status: unknown }).status;
    if (typeof status === 'number') return status;
  }
  if (error instanceof Error && 'cause' in error) return extractStatusCode(error.cause);
  return undefined;
}

function extractErrno(error: unknown): string | undefined {
  if (error instanceof WhatSoupError) return extractErrno((error as unknown as { cause?: unknown }).cause);
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === 'string') return code;
  }
  if (error instanceof Error && 'cause' in error) return extractErrno(error.cause);
  return undefined;
}

function summarizeFailure(
  failureClass: AgentFailureClass,
  message: string,
  input: AgentFailureInput,
): string {
  const subject = input.toolName ? `${input.provider}/${input.toolName}` : input.provider;
  const excerpt = normalizeWhitespace(message).slice(0, 180) || 'unknown';
  return `${failureClass} from ${subject}: ${excerpt}`;
}

function severityForFailureClass(failureClass: AgentFailureClass): 'critical' | 'warning' {
  return failureClass === 'config_or_capability_missing' || failureClass === 'provider_unknown'
    ? 'warning'
    : 'critical';
}

function buildAgentFailureIncidentId(
  failure: Omit<AgentFailureClassification, 'incidentId'>,
  message: string,
): string {
  const fingerprint = [
    failure.instanceName,
    failure.chatJid ?? '',
    failure.mapKey ?? '',
    failure.provider,
    failure.source,
    failure.failureClass,
    failure.toolName ?? '',
    normalizeWhitespace(message).slice(0, 300),
  ].join('\n');
  return shortHash(fingerprint, 24);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
