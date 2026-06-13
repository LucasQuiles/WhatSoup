import { createHash } from 'node:crypto';
import { WhatSoupError } from '../../errors.ts';
import {
  isPromptTooLongMessage,
  isProviderAuthRequiredMessage,
  isProviderModelUnavailableMessage,
  isProviderPolicyBlockMessage,
  isRateLimitResultMessage,
  isUsageLimitMessage,
} from './provider-failure.ts';

export {
  isPromptTooLongMessage,
  isProviderAuthRequiredMessage,
  isProviderModelUnavailableMessage,
  isProviderPolicyBlockMessage,
  isRateLimitResultMessage,
  isUsageLimitMessage,
} from './provider-failure.ts';

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
