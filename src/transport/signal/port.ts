// src/transport/signal/port.ts
// Narrow provider boundary for signal-cli — the adapter depends only on this
// interface. No SDK imports, no contract imports. One-way dependency:
// adapter knows contract; port knows signal-cli JSON-RPC shapes.
//
// Recipient identifiers:
// - Outbound send args accept E.164 phone numbers; the port resolves them to
//   UUIDs internally via signal-cli's `resolveRecipient` RPC. This keeps the
//   adapter and config ergonomic for operators while preserving UUID-canonical
//   identity internally.
// - Inbound envelopes carry sender UUIDs; the adapter surfaces them to the
//   contract as JID local-parts (e.g. `<uuid>@signal`).
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
 *
 * `type` discriminates the envelope class. Text content (data/sync) carries
 * `body`; reaction/read/delete envelopes carry their matching typed payload
 * field. The adapter routes each non-text type to its extension-event
 * listener (data → message, reaction → reaction, read → read, delete → delete).
 * Typing/call envelopes are still dropped in v1 — the contract has no
 * inbound typing event (typing is outbound-only via SupportsTyping) and no
 * call event at all.
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
  /**
   * Envelope type tag. One of: 'data' (text inbound), 'sync' (our outbound
   * echo), 'reaction', 'read', 'delete'. Other envelope classes (typing,
   * call, delivery receipts) are dropped by the port and never appear here.
   */
  readonly type: string;
  /** Payload for type='reaction' envelopes; undefined otherwise. */
  readonly reaction?: InboundReaction;
  /** Payload for type='read' envelopes; undefined otherwise. */
  readonly read?: InboundRead;
  /** Payload for type='delete' envelopes; undefined otherwise. */
  readonly delete?: InboundDelete;
}

/** Reaction envelope payload (signal-cli `dataMessage.reaction` shape). */
export interface InboundReaction {
  /** Emoji codepoint(s) the reactor sent ('' on removal). */
  readonly emoji: string;
  /** True iff this is a removal of a prior reaction. */
  readonly remove: boolean;
  /** Timestamp (epoch ms) of the reacted-to message. */
  readonly targetTimestamp: number;
  /** Author UUID of the reacted-to message. */
  readonly targetAuthor: string;
}

/** Read-receipt envelope payload (signal-cli `receiptMessage.type='READ'`). */
export interface InboundRead {
  /** Timestamps (epoch ms) of the messages the sender marked read. */
  readonly timestamps: readonly number[];
}

/** Remote-delete envelope payload (signal-cli `dataMessage.delete`). */
export interface InboundDelete {
  /** Timestamp (epoch ms) of the deleted message. */
  readonly targetTimestamp: number;
  /** Author of the deleted message (signal-cli does not echo this field;
   *  the port fills it with the envelope source — the deleter — for the
   *  common case where actor==author. The adapter surfaces it as target.conversation. */
  readonly targetAuthor: string;
}

/**
 * Error shape the provider boundary surfaces on failure.
 * The adapter (not the port) maps these to typed TransportError subclasses.
 */
export interface SignalPortError {
  readonly message: string;
  readonly code?: string;   // signal-cli JSON-RPC error code (e.g. 'ControllableException')
  readonly status?: number; // HTTP-style code synthesized by the port wrapper
}

/** Arguments for reacting to a Signal message. */
export interface ReactSignalArgs {
  /** The message's timestamp (epoch ms) — Signal's unique message id. */
  readonly targetTimestamp: number;
  /** The peer UUID or group id the reacted-to message lives in. */
  readonly targetAuthor: string;
  /** Whether the reacted-to message is in a group. */
  readonly targetInGroup: boolean;
  /** Emoji to react with. Empty string removes a previous reaction. */
  readonly emoji: string;
  /** True iff removing a prior reaction (emoji should be '' when true). */
  readonly remove: boolean;
}

/** Arguments for sending a read receipt for a Signal message. */
export interface SendReadReceiptArgs {
  /** Peer UUID whose messages are being marked read. */
  readonly target: string;
  /** Timestamps (epoch ms) of the messages to mark read. */
  readonly timestamps: readonly number[];
}

/** Arguments for sending a typing indicator. */
export interface SendTypingArgs {
  /** Peer UUID. */
  readonly target: string;
  /** True iff the user is composing (typing started); false for stopped. */
  readonly composing: boolean;
}

/**
 * Narrow provider seam for signal-cli operations.
 * All methods are async and may throw errors matching SignalPortError shape.
 * The adapter catches these and maps them to contract TransportError subclasses.
 */
export interface SignalPort {
  /**
   * Verify that the daemon is reachable and our linked-device session is
   * still valid. Pings signal-cli's `getUsername` RPC; throws on connection
   * failure, daemon-not-running, or unlinked session.
   */
  verifyCredentials(): Promise<void>;

  /**
   * Send an outbound Signal message. Returns the envelope timestamp
   * (epoch ms) — Signal's canonical message id.
   */
  send(args: SendSignalArgs): Promise<{ timestamp: number }>;

  /**
   * List envelopes received at or after `since` in BOTH directions (inbound
   * and our own outbound echoes). `fromMe` on each record distinguishes
   * direction, mirroring the Twilio port's InboundSms.fromMe contract.
   *
   * Contract:
   * - Returns both inbound messages (fromMe: false) and our own outbound
   *   echoes (fromMe: true). The adapter uses fromMe records as echo
   *   confirmation so the durability engine can transition submitted ops
   *   to echoed.
   * - The boundary is INCLUSIVE (timestamp >= since): delivery is
   *   at-least-once so a cursor equal to a message timestamp re-delivers
   *   rather than drops. Callers MUST deduplicate by `timestamp`.
   * - Results are ordered ascending by `timestamp` (oldest first) so callers
   *   can advance their cursor safely.
   * - `pageSize`, when provided, must be a positive integer and caps the
   *   result count; implementations throw `RangeError` otherwise.
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
}
