// src/transport/twilio/types.ts

/** Inbound delivery mode. Stage 1 supports 'poll' only; 'webhook' is stage 2. */
export type TwilioInboundMode = 'poll' | 'webhook';

export interface TwilioSmsConfig {
  readonly account: string;              // channel account segment (a-z0-9-), e.g. 'ml-bot'
  readonly accountSid: string;           // AC… (validated AC[0-9a-f]{32})
  readonly authTokenService: string;     // keyring service name (never an inline token)
  // XOR invariant: exactly one of phoneNumber or messagingServiceSid must be provided.
  // Validation is enforced by src/core/agent-config-validator.ts, not the type.
  readonly phoneNumber?: string;         // E.164 sender — optional; use messagingServiceSid if absent
  readonly messagingServiceSid?: string; // MG… preferred sender if present
  readonly inboundMode: TwilioInboundMode; // stage 1 supports 'poll' only
  readonly pollIntervalMs: number;
  readonly rateLimit: { readonly smsPerMinute: number };
}

/** Defaults applied when an instance config omits the optional fields. */
export const DEFAULT_TWILIO_SMS: Pick<
  TwilioSmsConfig,
  'inboundMode' | 'pollIntervalMs' | 'rateLimit'
> = Object.freeze({
  inboundMode: 'poll',
  pollIntervalMs: 15000,
  rateLimit: Object.freeze({ smsPerMinute: 30 }),
});
