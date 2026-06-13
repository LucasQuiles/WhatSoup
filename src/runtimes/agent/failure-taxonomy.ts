import { createHash } from 'node:crypto';
import { WhatSoupError } from '../../errors.ts';

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
  | 'context-overflow';

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

function isProviderCreditBalanceLimitMessage(lower: string): boolean {
  const providerBillingContext = (
    lower.includes('provider') ||
    lower.includes('api') ||
    lower.includes('billing') ||
    lower.includes('quota') ||
    lower.includes('error')
  );
  return (
    lower.includes('insufficient_quota') ||
    lower.includes('billing quota exceeded') ||
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
    (lower.includes('unknown model') && lower.includes('provider'))
  );
}

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

const FALLBACK_PROVIDER_FAILURE_KINDS: ReadonlySet<ProviderFailureKind> = new Set<ProviderFailureKind>([
  'usage-limit',
  'rate-limit',
  'auth-required',
  'model-unavailable',
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
  return createHash('sha256').update(fingerprint).digest('hex').slice(0, 24);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
