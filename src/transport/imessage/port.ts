// src/transport/imessage/port.ts
// Narrow provider boundary for iMessage operations — abstracts over the two
// supported backends (macOS-native `imsg rpc` and BlueBubbles HTTP Server).
//
// Both backends implement this interface; the adapter depends only on it.
// One-way dependency: adapter knows contract; port knows provider shapes.

/**
 * Arguments for sending an outbound iMessage. iMessage does NOT have a
 * separate group-send API in the same way Signal does — group conversations
 * are addressed by a chat GUID (e.g. `iMessage;-;chatXXXX`). The `recipient`
 * field accepts either a peer address (1:1) or a chat GUID (group).
 */
export interface SendImessageArgs {
  /**
   * Recipient: AppleID email, E.164 phone, or a chat GUID for group sends.
   * The port forwards the value verbatim; iMessage resolves it.
   */
  readonly recipient: string;
  /** Message body. iMessage supports long messages; no per-message cap here. */
  readonly body: string;
  /** Optional subject. BlueBubbles supports it; the imsg `send` method rejects it. */
  readonly subject?: string;
}

/**
 * A single iMessage envelope returned from the provider. Mirrors what both
 * `imsg rpc` and BlueBubbles `/api/v1/chat/query` surface, narrowed to
 * the fields the adapter actually consumes.
 *
 * The `kind` discriminator selects which optional payload fields are set:
 *   - 'text'     → `body` is non-null
 *   - 'reaction' → `reactionEmoji`, `reactionRemove`, `reactionTargetGuid` set
 *   - 'other'    → none of the above (typing indicators, call events, etc.)
 *
 * Read receipts ride on the `dateRead` field of the ORIGINAL outbound message
 * (state updated in place by the backend when the peer reads it). The adapter
 * detects newly-observed `dateRead` transitions and emits a `ReadEvent`.
 * Typing indicators are pushed via BlueBubbles socket/SSE events rather than
 * surfaced in `/message/query` and remain deferred.
 */
export interface InboundImessage {
  /**
   * Provider message id. BlueBubbles: a GUID string. imsg: a chat.db ROWID
   * stringified. The adapter surfaces this as MessageRef.id.
   */
  readonly guid: string;
  /** Sender identity — AppleID email or E.164 phone. */
  readonly from: string;
  /** Recipient — for 1:1 inbound this is us; for echoes it's the peer. */
  readonly to: string;
  /** Chat GUID iff this envelope is a group message. */
  readonly chatGuid?: string;
  /** Message body. Null for non-text envelopes (reactions, typing, etc.). */
  readonly body: string | null;
  /** True iff this is our own outbound message echoed back. */
  readonly fromMe: boolean;
  /** Envelope kind tag ('text' / 'reaction' / 'other'). */
  readonly kind: string;
  /** Envelope timestamp (epoch ms). */
  readonly timestamp: number;
  /**
   * Reaction emoji (set when `kind === 'reaction'`). One of the 6 iMessage
   * tapback emojis: '❤️' | '👍' | '👎' | '😂' | '‼️' | '❓'. Removal
   * envelopes retain the emoji being removed and set `reactionRemove: true`.
   */
  readonly reactionEmoji?: string;
  /** True iff this tapback removes a prior reaction. Set when kind === 'reaction'. */
  readonly reactionRemove?: boolean;
  /**
   * GUID of the message being reacted to (set when `kind === 'reaction'`).
   * BlueBubbles: `associatedMessageGuid` field. imsg: `associated_guid`.
   */
  readonly reactionTargetGuid?: string;
  /**
   * Epoch ms when a remote peer read this outbound message. Set by the
   * backend on the ORIGINAL outbound record (`fromMe: true`) when the
   * recipient's device reports a read receipt. Undefined if the message
   * has not been read, is inbound (`fromMe: false`), or the backend
   * cannot surface read state. BlueBubbles: `dateRead` field. imsg:
   * `date_read` field (parsed from ISO 8601).
   */
  readonly dateRead?: number;
}

/**
 * One raw-provider page after record normalization.
 *
 * `cursor` is opaque to the adapter and owned by the provider port. It must
 * advance only after the whole raw page has been validated. `hasMore` means
 * the same provider snapshot still has unread rows; a false value leaves the
 * returned cursor as the durable high-water mark for the next poll.
 */
export interface InboundImessagePage {
  readonly records: readonly InboundImessage[];
  readonly cursor: string;
  readonly hasMore: boolean;
}

/**
 * Error shape the provider boundary surfaces on failure.
 * The adapter (not the port) maps these to typed TransportError subclasses.
 */
export interface ImessagePortError {
  readonly message: string;
  readonly code?: string;   // backend-specific code (BlueBubbles HTTP path, imsg RPC error class)
  readonly status?: number; // HTTP status code (BlueBubbles) or synthesized code (imsg)
  readonly phase?: 'not_started' | 'provider_call_started' | 'ack_received';
}

/** Arguments for reacting to an iMessage. */
export interface ReactImessageArgs {
  /** The message's GUID (provider message id). */
  readonly targetGuid: string;
  /**
   * Conversation the reacted-to message lives in — peer address for 1:1,
   * chat GUID for group. iMessage requires this for reaction targeting.
   */
  readonly conversation: string;
  /** Emoji to react with. Empty string removes a previous reaction. */
  readonly emoji: string;
  /** True iff removing a prior reaction. */
  readonly remove: boolean;
}

/** Arguments for sending a read receipt. */
export interface SendReadReceiptArgs {
  /** Conversation to mark read — peer address or chat GUID. */
  readonly conversation: string;
  /** GUID(s) of the messages to mark read. iMessage coalesces per-conversation. */
  readonly guids: readonly string[];
}

/** Arguments for sending a typing indicator. */
export interface SendTypingArgs {
  /** Conversation — peer address or chat GUID. */
  readonly conversation: string;
  /** True iff composing; false for stopped. */
  readonly composing: boolean;
}

/**
 * Narrow provider seam for iMessage operations. Both the imsg RPC port
 * and the BlueBubbles HTTP port implement this interface.
 *
 * All methods are async and may throw errors matching ImessagePortError.
 * The adapter catches these and maps them to contract TransportError subclasses.
 */
export interface ImessagePort {
  /**
   * Verify the backend is reachable and our credentials/session are valid.
   * For BlueBubbles: GET /api/v1/ping with the configured password.
   * For imsg: reach the local relay and prove chat.db is readable.
   */
  verifyCredentials(): Promise<void>;

  /**
   * Send an outbound iMessage. Returns the provider message GUID.
   */
  send(args: SendImessageArgs): Promise<{ guid: string }>;

  /**
   * List envelopes received at or after `since` in BOTH directions (inbound
   * and our own outbound echoes). `fromMe` on each record distinguishes
   * direction; same contract as Signal/Twilio ports.
   *
   * Boundary is INCLUSIVE (timestamp >= since) for a null bootstrap cursor;
   * callers MUST dedupe by `guid`. Ordered ascending by provider cursor. Once
   * bootstrapped, `cursor` is the authoritative provider high-water mark and
   * `since` is only a compatibility/lookback bound.
   */
  listInboundSince(
    since: Date,
    pageSize?: number,
    cursor?: string | null,
  ): Promise<InboundImessagePage>;

  /** Drop any cached transport connection. Safe to call repeatedly. */
  resetConnection?(): void;

  /**
   * Permanently release any held transport resource (e.g. a persistent
   * socket). Unlike {@link resetConnection}, callers do not reconnect after
   * this — it is the final-teardown counterpart, invoked once at shutdown.
   * Safe to call repeatedly (idempotent), including after `resetConnection`.
   * Backends with no persistent connection (BlueBubbles HTTP) need not
   * implement it.
   */
  dispose?(): void;

  /**
   * Send a reaction to a prior message. iMessage's tapback protocol supports
   * 6 reactions (👍, 👎, ❤️, ‼️, ❓, 😂) plus remove. The port forwards the
   * emoji; the backend rejects unsupported emojis.
   */
  sendReaction(args: ReactImessageArgs): Promise<void>;

  /** Send read receipts for one or more messages in one conversation. */
  sendReadReceipts(args: SendReadReceiptArgs): Promise<void>;

  /** Send a typing indicator. iMessage has composing/stopped states only. */
  sendTypingIndicator(args: SendTypingArgs): Promise<void>;
}
