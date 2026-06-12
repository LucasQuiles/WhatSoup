// Shared, non-secret provider crash diagnostics for agent runtime alerts.

export const PROVIDER_CRASH_PREVIEW_MAX = 1_000;

export interface ProviderCrashMetadata {
  provider: string;
  crashClass?: string;
  stderrPreview?: string;
}

export function sanitizeProviderCrashText(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(
      /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|pat|password|secret)\s*[:=]\s*['"]?)[^'"\s]{8,}/gi,
      '$1[REDACTED]',
    )
    .replace(/\b(?:sk|pk|rk|ghp|github_pat|xox[baprs]|ya29|AIza)[-_A-Za-z0-9]{12,}\b/g, '[REDACTED_TOKEN]')
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED_EMAIL]');
}

export function appendProviderCrashPreview(
  existing: string,
  chunk: Buffer | string,
  maxLength = PROVIDER_CRASH_PREVIEW_MAX,
): string {
  const raw = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  const next = sanitizeProviderCrashText(raw).trim();
  if (!next) return existing;
  return `${existing}\n${next}`.trim().slice(-maxLength);
}

export function classifyProviderCrash(text: string): string | undefined {
  const lower = text.toLowerCase();
  if (!lower.trim()) return undefined;
  if (lower.includes('enoent') || lower.includes('command not found')) return 'provider_binary_missing';
  if (lower.includes('permission denied') || lower.includes('eacces')) return 'provider_permission_denied';
  if (
    lower.includes('not logged in') ||
    lower.includes('please run /login') ||
    lower.includes('please login') ||
    lower.includes('authentication required') ||
    lower.includes('auth required') ||
    lower.includes('invalid api key') ||
    lower.includes('missing api key') ||
    lower.includes('no api key') ||
    lower.includes('unauthorized') ||
    (lower.includes('oauth') && lower.includes('expired'))
  ) {
    return 'provider_auth_required';
  }
  if (
    lower.includes('usage limit') ||
    lower.includes('session limit') ||
    lower.includes('out of extra usage') ||
    lower.includes('quota exceeded')
  ) {
    return 'provider_usage_limit';
  }
  if (lower.includes('rate limit') || lower.includes('too many requests') || lower.includes('429')) {
    return 'provider_rate_limit';
  }
  if (
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('etimedout') ||
    lower.includes('socket hang up')
  ) {
    return 'provider_timeout';
  }
  if (
    lower.includes('enotfound') ||
    lower.includes('econnreset') ||
    lower.includes('econnrefused') ||
    lower.includes('network error') ||
    lower.includes('network unreachable')
  ) {
    return 'provider_network_error';
  }
  if (
    lower.includes('internal server error') ||
    lower.includes('service unavailable') ||
    lower.includes('bad gateway') ||
    lower.includes('gateway timeout') ||
    /\b5\d\d\b/.test(lower)
  ) {
    return 'provider_server_error';
  }
  return undefined;
}

export function buildProviderCrashMetadata(options: {
  provider: string;
  existingPreview?: string;
  extraText?: string;
  fallbackClass?: string;
  maxLength?: number;
}): ProviderCrashMetadata {
  const preview = [options.existingPreview, options.extraText ? sanitizeProviderCrashText(options.extraText) : '']
    .filter(Boolean)
    .join('\n')
    .trim()
    .slice(-(options.maxLength ?? PROVIDER_CRASH_PREVIEW_MAX));
  const crashClass = classifyProviderCrash(preview) ?? options.fallbackClass;
  return {
    provider: options.provider,
    ...(crashClass ? { crashClass } : {}),
    ...(preview ? { stderrPreview: preview } : {}),
  };
}
