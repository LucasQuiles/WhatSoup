// src/transport/signal/types.ts
// Config + provider-domain types for the Signal transport adapter.
//
// Signal transport backend: signal-cli (https://github.com/AsamK/signal-cli)
// running in JSON-RPC daemon mode (`signal-cli -u +1555... daemon`), reached
// over a local UNIX socket or loopback TCP endpoint. The adapter talks to it
// via the Port interface in port.ts; this file carries only types and defaults.
//
// Recipient identity: Signal identifies accounts by UUID. signal-cli accepts
// UUID or E.164 recipients for outbound operations. Inbound envelopes prefer
// the provider E.164 when exposed and fall back to UUID when the number is private;
// WhatSoup does not claim a durable UUID↔E.164 alias map.

/** E.164 phone shape — shared with the Twilio transport's validator. */
export const E164_RE = /^\+[1-9]\d{6,14}$/;

export {
  SIGNAL_GROUP_ID_RE,
  SIGNAL_UUID_RE,
  isSignalGroupAddress,
} from '../../core/transport-refs.ts';

/**
 * Signal connection mode. Streaming is deliberately not exposed until a
 * exercised receive-subscription implementation exists.
 */
export type SignalInboundMode = 'poll';

/**
 * Per-destination outbound rate cap. Signal does not surface HTTP 429s —
 * the protocol self-paces — but signal-cli's local queue rejects sends that
 * arrive too fast (per-account heuristic). Mirrors the Twilio rateLimit
 * shape so callers can treat the two transports uniformly.
 */
export interface SignalRateLimit {
  /** Max sends per minute to a single destination UUID. */
  readonly messagesPerMinute: number;
}

/**
 * Signal transport configuration. Mirrors the TwilioSmsConfig shape so
 * validation, resolution, and factory wiring follow the same pattern.
 */
export interface SignalConfig {
  /** Channel account segment (a-z0-9-), e.g. 'ops-line'. */
  readonly account: string;

  /** UNIX socket path to the signal-cli daemon. Mutually exclusive with tcpPort. */
  readonly socketPath?: string;

  /**
   * TCP port for the signal-cli daemon (alternative to socketPath).
   * Mutually exclusive with socketPath.
   */
  readonly tcpPort?: number;

  /** TCP host when tcpPort is set (default '127.0.0.1'). */
  readonly tcpHost?: string;

  /**
   * Our own phone number in E.164 (e.g. '+15551234567'). Used for selfRef.
   * The operator must attest that this matches the single-account daemon's
   * `-a` identity. The daemon does not expose that self identity through the
   * account-bound readiness RPC, so WhatSoup cannot compare it mechanically.
   */
  readonly phoneNumber: string;

  /** Inbound delivery mode. */
  readonly inboundMode: SignalInboundMode;

  /** Poll interval for inbound receive calls. */
  readonly pollIntervalMs: number;

  /** Per-destination outbound rate cap. */
  readonly rateLimit: SignalRateLimit;
}

/** Polling defaults applied after an endpoint is explicitly selected. */
export const DEFAULT_SIGNAL: Pick<
  SignalConfig,
  'inboundMode' | 'pollIntervalMs' | 'rateLimit'
> = Object.freeze({
  inboundMode: 'poll',
  pollIntervalMs: 15000,
  rateLimit: Object.freeze({ messagesPerMinute: 30 }),
});
