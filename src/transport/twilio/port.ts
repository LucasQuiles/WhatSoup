// src/transport/twilio/port.ts
// Narrow provider boundary — the adapter depends only on this interface.
// No SDK imports, no contract imports. One-way dependency: adapter knows contract; port knows provider shapes.

/** Arguments for sending an outbound SMS. */
export interface SendSmsArgs {
  readonly to: string;
  readonly from?: string;
  readonly messagingServiceSid?: string;
  readonly body: string;
}

/** A single inbound SMS record as returned from the provider. */
export interface InboundSms {
  readonly sid: string;
  readonly from: string;
  readonly to: string;
  readonly body: string;
  readonly sentAt: Date;
  readonly status?: string;
}

/**
 * Error shape that the provider boundary surfaces on failure.
 * The adapter (not the port) maps these to typed TransportError subclasses.
 */
export interface TwilioPortError {
  readonly message: string;
  readonly code?: number;   // Twilio error code (e.g. 21211)
  readonly status?: number; // HTTP status (e.g. 401, 429)
}

/**
 * Narrow provider seam for Twilio SMS operations.
 * All methods are async and may throw errors matching TwilioPortError shape.
 * The adapter catches these and maps them to contract TransportError subclasses.
 */
export interface TwilioSmsPort {
  /** Verify that stored credentials are valid. Throws on auth failure. */
  verifyCredentials(): Promise<void>;

  /** Send an outbound SMS. Returns the provider message SID. */
  sendSms(args: SendSmsArgs): Promise<{ sid: string }>;

  /**
   * List inbound messages received at or after `since`.
   *
   * Contract:
   * - The boundary is INCLUSIVE (`sentAt >= since`): delivery is at-least-once
   *   so a cursor equal to a message timestamp re-delivers rather than drops.
   *   Callers MUST deduplicate by `sid`.
   * - Results are ordered ascending by `sentAt` (oldest first) so callers can
   *   advance their cursor safely.
   * - `pageSize`, when provided, must be a positive integer and caps the
   *   result count; implementations throw `RangeError` otherwise.
   */
  listInboundSince(since: Date, pageSize?: number): Promise<readonly InboundSms[]>;
}
