/**
 * Canonical registry for adapter health reason codes (the machine-readable
 * strings carried in `AdapterHealth.reasonCode`). These are downstream
 * classification keys — telemetry, alerting, and operator diagnostics branch
 * on them — so renaming one is a breaking change requiring a deprecation
 * cycle, same as error-codes.ts.
 */
export const AdapterReasonCode = {
  /** A transport poll cycle failed authentication against the provider. */
  PollAuthFailure: 'poll-auth-failure',
  /** State transition injected by the in-memory test transport. */
  InMemoryInjected: 'in-memory-injected',
} as const;

export type AdapterReasonCode = (typeof AdapterReasonCode)[keyof typeof AdapterReasonCode];
