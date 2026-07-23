export type RestrictedProviderApiErrorOutcome =
  | { kind: 'rate-limit-retry'; retryAfterMs: number }
  | { kind: 'terminal'; text: string };

const MAX_PROVIDER_ERROR_BODY_BYTES = 64 * 1024;

/**
 * Read only the bounded prefix needed by surrogate recovery and trusted error
 * previews. Restricted error mapping is status-only and never exposes it.
 */
export async function readBoundedProviderErrorText(response: Response): Promise<string> {
  if (!response.body) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let retainedBytes = 0;
  try {
    while (retainedBytes < MAX_PROVIDER_ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) {
        chunks.push(decoder.decode());
        return chunks.join('');
      }
      const remaining = MAX_PROVIDER_ERROR_BODY_BYTES - retainedBytes;
      const retained = value.byteLength <= remaining ? value : value.subarray(0, remaining);
      retainedBytes += retained.byteLength;
      chunks.push(decoder.decode(retained, { stream: retainedBytes < MAX_PROVIDER_ERROR_BODY_BYTES }));
      if (value.byteLength > remaining || retainedBytes === MAX_PROVIDER_ERROR_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } finally {
    reader.releaseLock();
  }
}

/** Closed, content-free HTTP error mapping for restricted managed providers. */
export function mapRestrictedProviderApiError(args: {
  readonly status: number;
  readonly retryAfterMs: number | null;
  readonly rateLimitRetryAttempt: boolean;
}): RestrictedProviderApiErrorOutcome {
  if (args.status === 400) {
    return {
      kind: 'terminal',
      text: '_There was an issue with my conversation data. Please try again or send /new to start fresh._',
    };
  }
  if (args.status === 429) {
    if (!args.rateLimitRetryAttempt && args.retryAfterMs !== null) {
      return { kind: 'rate-limit-retry', retryAfterMs: args.retryAfterMs };
    }
    return { kind: 'terminal', text: '_Rate limited - please wait a moment and try again._' };
  }
  if (args.status >= 500) {
    return {
      kind: 'terminal',
      text: '_Service temporarily unavailable - please try again in a moment._',
    };
  }
  return {
    kind: 'terminal',
    text: `_Service error (${args.status}) - please try again._`,
  };
}
