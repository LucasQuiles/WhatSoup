// Shared, non-secret provider crash diagnostics for agent runtime alerts.

import type { AgentFailureClass } from './failure-taxonomy.ts';
import { sanitizeProviderPreviewText } from './provider-preview-sanitizer.ts';

const PROVIDER_CRASH_PREVIEW_MAX = 1_000;
const OPENCODE_PERMISSION_PATTERN_RE =
  /permission requested:\s*[^\r\n]*?(?=\s*;\s*auto-rejecting|[\r\n]|$)/gi;
const OPENCODE_PERMISSION_REJECTION_REDACTED =
  'permission requested: [REDACTED_PERMISSION_PATTERN]; auto-rejecting';

export interface ProviderCrashMetadata {
  provider: string;
  crashClass?: string;
  stderrPreview?: string;
}

export function sanitizeProviderCrashText(text: string): string {
  const normalized = text.replace(
    OPENCODE_PERMISSION_PATTERN_RE,
    'permission requested: [REDACTED_PERMISSION_PATTERN]',
  );
  return sanitizeProviderPreviewText(normalized);
}

export function appendProviderCrashPreview(
  existing: string,
  chunk: Buffer | string,
  maxLength = PROVIDER_CRASH_PREVIEW_MAX,
): string {
  const raw = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  if (!raw.trim()) return existing;
  // QR-112: sanitize the JOINED buffer (existing + raw), NOT the raw chunk in
  // isolation. The provider CLI writes stderr in arbitrary byte-sized chunks, so a
  // secret can straddle a chunk boundary — the per-chunk sanitizer then sees `sk`+
  // <12 chars in one chunk and the remainder (no prefix) in the next, redacting
  // NEITHER. Joining first makes the split token contiguous so the whole-token
  // regexes match. No artificial '\n' separator: inserting one at a byte boundary
  // would itself break a boundary-straddling token's `\b…\b` match. The returned
  // buffer stays fully sanitized, so the direct-log sinks (session.ts / claude.ts
  // 'claude stderr', which log this value) remain safe with no per-sink edits.
  return sanitizeProviderCrashText(`${existing}${raw}`).trim().slice(-maxLength);
}

export function classifyProviderCrash(text: string): AgentFailureClass | undefined {
  const lower = text.toLowerCase();
  if (!lower.trim()) return undefined;
  if (lower.includes('enoent') || lower.includes('command not found')) return 'provider_binary_missing';
  if (
    lower.includes('permission denied') ||
    lower.includes('eacces') ||
    lower.includes(OPENCODE_PERMISSION_REJECTION_REDACTED.toLowerCase())
  ) {
    return 'provider_permission_denied';
  }
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
    lower.includes('invalid authentication credentials') ||
    lower.includes('failed to authenticate') ||
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
    // A 5xx number alone is too weak ("line 503", "550 ms"): this class keys
    // heal single-flight, so a false positive suppresses distinct crashes.
    // Require HTTP-ish context immediately before the status number.
    /\b(?:status(?:\s+code)?|http|error)\s*[:=]?\s*5\d\d\b/.test(lower)
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
