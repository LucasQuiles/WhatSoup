// src/transport/signal/types.ts
// Config + provider-domain types for the Signal transport adapter.
//
// Signal transport backend: signal-cli (https://github.com/AsamK/signal-cli)
// running in JSON-RPC daemon mode (`signal-cli -u +1555... daemon`), reached
// over a local UNIX socket. The adapter talks to it via the Port interface
// in port.ts; this file carries only types and defaults — no SDK imports.
//
// Recipient identity: Signal identifies accounts by UUID (post-2022 migration
// away from phone-number routing). The adapter accepts E.164 phone numbers
// for outbound convenience; the Port resolves them to UUIDs internally via
// signal-cli's `resolveRecipient` JSON-RPC. Inbound envelopes carry the
// sender's UUID, which is the canonical addressable identity.

/** E.164 phone shape — shared with the Twilio transport's validator. */
export const E164_RE = /^\+[1-9]\d{6,14}$/;

/**
 * UUID v4 shape used by Signal for account identity. signal-cli emits and
 * accepts canonical 8-4-4-4-12 lowercase hex. Re-exported here so config
 * validation and the Port can share one source of truth.
 */
export const SIGNAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Signal V2 group id shape: base64 (standard alphabet, optional padding),
 * min 16 chars. Distinct from E.164 (leading '+') and UUID (dashes), so a
 * destination can be classified without a resolveRecipient round-trip.
 */
export const SIGNAL_GROUP_ID_RE = /^[A-Za-z0-9+/]{16,}={0,2}$/;

/**
 * Signal connection mode. Mirrors the Twilio inboundMode split:
 * - 'poll'    — adapter polls `receive` at pollIntervalMs
 * - 'stream'  — adapter opens a long-lived receive subscription (signal-cli
 *               `receive` without `timeout` blocks indefinitely and streams
 *               envelopes; one receive call per adapter lifetime)
 */
export type SignalInboundMode = 'poll' | 'stream';

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

  /**
   * UNIX socket path to the signal-cli daemon. Default '/tmp/signalc.sock'.
   * Operator starts the daemon once: `signal-cli -u +1555... daemon --socket /tmp/signalc.sock`.
   */
  readonly socketPath?: string;

  /**
   * TCP port for the signal-cli daemon (alternative to socketPath).
   * If both socketPath and tcpPort are set, socketPath wins.
   */
  readonly tcpPort?: number;

  /** TCP host when tcpPort is set (default '127.0.0.1'). */
  readonly tcpHost?: string;

  /**
   * Our own phone number in E.164 (e.g. '+15551234567'). Used for selfRef.
   * The linked device's number is recorded by signal-cli at link time and
   * surfaced via `getUsername`, but we pin it in config so selfRef is
   * available before the first daemon round-trip.
   */
  readonly phoneNumber: string;

  /** Inbound delivery mode. */
  readonly inboundMode: SignalInboundMode;

  /** Poll interval for 'poll' mode; ignored in 'stream' mode. */
  readonly pollIntervalMs: number;

  /** Per-destination outbound rate cap. */
  readonly rateLimit: SignalRateLimit;
}

/** Defaults applied when an instance config omits the optional fields. */
export const DEFAULT_SIGNAL: Pick<
  SignalConfig,
  'socketPath' | 'inboundMode' | 'pollIntervalMs' | 'rateLimit'
> = Object.freeze({
  socketPath: '/tmp/signalc.sock',
  inboundMode: 'poll',
  pollIntervalMs: 15000,
  rateLimit: Object.freeze({ messagesPerMinute: 30 }),
});
