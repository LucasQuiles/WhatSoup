// src/transport/signal/port.ts
// Narrow provider boundary for signal-cli — the adapter depends only on this
// interface. No SDK imports, no contract imports. One-way dependency:
// adapter knows contract; port knows signal-cli JSON-RPC shapes.
//
// Recipient identifiers:
// - Outbound send args accept E.164 phone numbers or UUIDs and pass them to
//   signal-cli's recipient resolver.
// - Inbound envelopes prefer exposed sender/destination numbers and fall back to UUIDs;
//   this boundary does not invent a durable UUID↔E.164 alias map.
//
// Group identifiers: signal-cli V2 groups use base64 group IDs. The port
// accepts and returns these as opaque strings; group membership decryption
// is signal-cli's responsibility.

/**
 * Arguments for sending an outbound Signal message. Either `recipient` (1:1)
 * or `groupId` (group) must be provided; providing both is rejected by the
 * port implementation.
 */
export interface SendSignalArgs {
  /** E.164 phone (e.g. '+15551234567') or UUID. Port resolves as needed. */
  readonly recipient?: string;
  /** Base64 V2 group id, when sending to a group. */
  readonly groupId?: string;
  /** Message body. Signal supports long messages; no per-message cap here. */
  readonly body: string;
  /** Optional timestamp override (epoch ms). Defaults to Date.now(). */
  readonly timestamp?: number;
}

/**
 * A single Signal envelope returned from the provider. Mirrors the shape
 * signal-cli emits via its `receive` RPC, narrowed to the fields the adapter
 * actually consumes. `fromMe` distinguishes direction; the record set covers
 * both inbound messages and our own outbound echoes (so the durability engine
 * can transition submitted ops to echoed, matching the Twilio pattern).
 */
export interface InboundSignal {
  /** Envelope timestamp (epoch ms) — used as the provider message id. */
  readonly timestamp: number;
  /**
   * Sender identity. For 1:1 messages: the peer's UUID. For group messages:
   * the sender's UUID within the group. For outbound echoes: our own UUID.
   */
  readonly source: string;
  /**
   * Recipient identity. For 1:1 inbound: our UUID. For outbound echoes: the
   * peer's UUID. For group messages: the group id.
   */
  readonly destination: string;
  /** Base64 V2 group id, iff this envelope is a group message. */
  readonly groupId?: string;
  /** Message body. Null for non-text envelopes (reactions, receipts, etc.). */
  readonly body: string | null;
  /** True iff this is our own outbound message echoed back. */
  readonly fromMe: boolean;
  /** Envelope type tag (data/sync/receipt/typing/call/etc.). */
  readonly type: string;
}

/**
 * Error shape the provider boundary surfaces on failure.
 * The adapter (not the port) maps these to typed TransportError subclasses.
 */
export interface SignalPortError {
  readonly message: string;
  readonly code?: string;   // signal-cli JSON-RPC error code (e.g. 'ControllableException')
  readonly status?: number; // HTTP-style code synthesized by the port wrapper
  /** Set only when the port can PROVE the stage; absent when it cannot. */
  readonly phase?: 'not_started' | 'provider_call_started' | 'ack_received';
}

/** Arguments for reacting to a Signal message. */
export interface ReactSignalArgs {
  /** The message's timestamp (epoch ms) — Signal's unique message id. */
  readonly targetTimestamp: number;
  /** The author UUID of the reacted-to message. */
  readonly targetAuthor: string;
  /** Whether the reacted-to message is in a group. */
  readonly targetInGroup: boolean;
  /** Emoji to react with. Empty string removes a previous reaction. */
  readonly emoji: string;
  /** True iff removing a prior reaction (emoji should be '' when true). */
  readonly remove: boolean;
}

/** Arguments for Signal's real remoteDelete JSON-RPC method. */
export interface RemoteDeleteSignalArgs {
  readonly recipient?: string;
  readonly groupId?: string;
  readonly targetTimestamp: number;
}

/** Arguments for sending a read receipt for a Signal message. */
export interface SendReadReceiptArgs {
  /** Peer UUID whose messages are being marked read. */
  readonly target: string;
  /** Timestamps (epoch ms) of the messages to mark read. */
  readonly timestamps: readonly number[];
}

/** Arguments for sending a typing indicator to exactly one peer or group. */
export type SendTypingArgs = ({
  /** Peer UUID or E.164 identity. */
  readonly target: string;
  readonly groupId?: never;
} | {
  readonly target?: never;
  /** Base64 V2 group id. */
  readonly groupId: string;
}) & {
  /** True iff the user is composing (typing started); false for stopped. */
  readonly composing: boolean;
};

/**
 * Narrow provider seam for signal-cli operations.
 * All methods are async and may throw errors matching SignalPortError shape.
 * The adapter catches these and maps them to contract TransportError subclasses.
 */
export interface SignalPort {
  /**
   * Verify that the account-bound daemon is reachable and can execute a local
   * account command. Calls signal-cli's `listDevices` RPC. The single-account
   * daemon does not expose its self E.164 through this command, so matching the
   * configured phoneNumber to the daemon `-a` identity remains an operator
   * attestation rather than a mechanical check.
   */
  verifyCredentials(): Promise<void>;

  /**
   * Send an outbound Signal message. Returns the envelope timestamp
   * (epoch ms) — Signal's canonical message id.
   */
  send(args: SendSignalArgs): Promise<{ timestamp: number }>;

  /**
   * Drain one bounded receive batch in BOTH directions (inbound and our own
   * outbound echoes). `fromMe` on each record distinguishes direction,
   * mirroring the Twilio port's InboundSms.fromMe contract. The historical
   * `since` parameter is validated but MUST NOT filter acceptance: signal-cli
   * receive is destructive, not a timestamp-queryable feed, and clocks can be
   * skewed or out of order across batches.
   *
   * Contract:
   * - Returns both inbound messages (fromMe: false) and our own outbound
   *   echoes (fromMe: true). The adapter uses fromMe records as echo
   *   confirmation so the durability engine can transition submitted ops
   *   to echoed.
   * - Every valid row in the current destructive receive batch is returned,
   *   regardless of timestamp. signal-cli does not redeliver a previously
   *   drained batch, so this is not an at-least-once durability boundary across
   *   a process crash. Callers still deduplicate composite envelope identities
   *   within delivered/replayed input.
   * - Results are ordered ascending by `timestamp` (oldest first) for stable
   *   listener behavior; the order is not a durable cursor.
   * - `pageSize`, when provided, must be a positive integer and is passed to
   *   signal-cli as `maxMessages` before the queue is drained; implementations
   *   throw `RangeError` otherwise and fail if the provider exceeds the bound.
   */
  listInboundSince(since: Date, pageSize?: number): Promise<readonly InboundSignal[]>;

  /**
   * Send a reaction to a prior message. Signal requires the target message's
   * timestamp AND author; this is a stricter contract than iMessage or SMS.
   */
  sendReaction(args: ReactSignalArgs): Promise<void>;

  /**
   * Send read receipts for one or more messages from the same peer. Signal
   * coalesces timestamps in a single receipt per send.
   */
  sendReadReceipts(args: SendReadReceiptArgs): Promise<void>;

  /**
   * Send a typing indicator. Signal has only "composing" / "stopped" states
   * (no "recording audio"); the composing boolean carries both.
   */
  sendTypingIndicator(args: SendTypingArgs): Promise<void>;

  /** Remotely delete one of our previously sent messages. */
  remoteDelete(args: RemoteDeleteSignalArgs): Promise<void>;
}
