// src/transport/imessage/types.ts
// Config + provider-domain types for the iMessage transport adapter.
//
// iMessage has TWO supported backends, selected by `backend`:
//
//   'imsg'        — macOS-native. Uses the `imsg` CLI daemon
//                   (https://github.com/AsamK/signal-cli namesake, but for
//                   iMessage) which reads the local `chat.db` and sends via
//                   the macOS Messages framework. Requires the daemon host
//                   be a signed-in Mac with Full Disk Access granted.
//
//   'bluebubbles' — BlueBubbles Server (https://bluebubbles.app) — an HTTP
//                   API fronting a Mac mini / Mac Studio that signs into
//                   iMessage. Same protocol-level identity, different
//                   transport. Used by the Hermes reference implementation.
//
// Both backends share the iMessage identity model (AppleID email or E.164
// phone tied to the AppleID) and message GUIDs (BlueBubbles) / rowids
// (imsg) which the adapter stringifies as MessageRef.id.
//
// Recipient identity: AppleID email (`user@icloud.com`) or E.164 phone
// (`+15551234567`). The port accepts both forms; iMessage itself routes
// either to the same AppleID-verified destination.

/** E.164 phone shape — shared with the Twilio and Signal transports. */
export const E164_RE = /^\+[1-9]\d{6,14}$/;

/**
 * AppleID email shape — iMessage accepts iCloud / me.com / mac.com
 * addresses plus any email registered against an AppleID. We accept any
 * RFC-5322-ish shape here; the daemon/Server is the final arbiter.
 */
export const APPLEID_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Backend implementation selector. */
export type ImessageBackend = 'imsg' | 'bluebubbles';

/**
 * Per-destination outbound rate cap. iMessage itself does not surface 429s
 * (the protocol self-paces under APNs), but BlueBubbles Server's local
 * queue rejects sends that arrive too fast. Mirrors the Signal/Twilio shape.
 */
export interface ImessageRateLimit {
  /** Max sends per minute to a single destination. */
  readonly messagesPerMinute: number;
}

/**
 * iMessage transport configuration. The `backend` discriminator selects
 * between the macOS-native `imsg` daemon and the BlueBubbles HTTP Server.
 * Backend-specific fields are conditionally required based on `backend`.
 */
export interface ImessageConfig {
  /** Channel account segment (a-z0-9-), e.g. 'mac-mini'. */
  readonly account: string;

  /** Backend selector. */
  readonly backend: ImessageBackend;

  // ── imsg backend fields (required when backend === 'imsg') ──────────────

  /**
   * UNIX socket path to the imsg daemon. Required when backend === 'imsg'.
   * Default '/tmp/imsg.sock'.
   */
  readonly imsgSocketPath?: string;

  // ── bluebubbles backend fields (required when backend === 'bluebubbles') ─

  /**
   * BlueBubbles Server base URL (e.g. 'https://bb.example.test'). Required
   * when backend === 'bluebubbles'.
   */
  readonly bluebubblesUrl?: string;

  /**
   * BlueBubbles password (used for basic auth on every API call). Stored
   * in the keyring via bluebubblesPasswordService; this field is the
   * resolved credential at runtime, populated by the factory.
   */
  readonly bluebubblesPassword?: string;

  /**
   * Keyring service name for the BlueBubbles password. Required when
   * backend === 'bluebubbles'. The factory resolves the credential via
   * lookupCredential() before constructing the port.
   */
  readonly bluebubblesPasswordService?: string;

  // ── common fields ────────────────────────────────────────────────────────

  /**
   * Our own sender identity — AppleID email or E.164 phone. Required for
   * selfRef; the daemon/Server doesn't surface it before the first send.
   */
  readonly sender: string;

  /** Inbound delivery mode. 'poll' (default) or 'webhook' (BlueBubbles only). */
  readonly inboundMode: ImessageInboundMode;

  /** Poll interval for 'poll' mode. */
  readonly pollIntervalMs: number;

  /** Per-destination outbound rate cap. */
  readonly rateLimit: ImessageRateLimit;
}

/** Inbound delivery mode. Stage 1 supports 'poll'; BlueBubbles adds 'webhook'. */
export type ImessageInboundMode = 'poll' | 'webhook';

/** Defaults applied when an instance config omits the optional fields. */
export const DEFAULT_IMESSAGE: Pick<
  ImessageConfig,
  'backend' | 'imsgSocketPath' | 'inboundMode' | 'pollIntervalMs' | 'rateLimit'
> = Object.freeze({
  backend: 'bluebubbles',
  imsgSocketPath: '/tmp/imsg.sock',
  inboundMode: 'poll',
  pollIntervalMs: 15000,
  rateLimit: Object.freeze({ messagesPerMinute: 30 }),
});
