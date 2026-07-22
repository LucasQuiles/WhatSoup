export type RestrictedProviderApiErrorOutcome =
  | { kind: 'rate-limit-retry'; retryAfterMs: number }
  | { kind: 'terminal'; text: string };

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
