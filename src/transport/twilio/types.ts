// src/transport/twilio/types.ts

/** E.164 phone shape — shared by config validation and runtime send guards. */
export const E164_RE = /^\+[1-9]\d{6,14}$/;

/** Inbound delivery mode. Stage 1 supports 'poll'; stage 2 adds 'webhook'. */
export type TwilioInboundMode = 'poll' | 'webhook';

export interface TwilioWebhookConfig {
  /** Public base URL Twilio calls (signature is computed over the FULL public URL). */
  readonly publicBaseUrl: string;        // e.g. 'https://example.ngrok.app'
  readonly listenPort: number;           // dedicated listener; NOT the health port
  readonly listenAddress?: string;       // default '127.0.0.1' — operator fronts with a proxy/tunnel
}

export interface TwilioVoiceConfig {
  readonly enabled: boolean;             // voicemail flow + placeCall
  readonly voicemailGreeting?: string;   // <Say> text; default in webhook-server
  readonly voicemailMaxLengthSec: number;
}

export interface TwilioSmsConfig {
  readonly account: string;              // channel account segment (a-z0-9-), e.g. 'ml-bot'
  readonly accountSid: string;           // AC… (validated AC[0-9a-f]{32})
  readonly authTokenService: string;     // exactly whatsoup-twilio-<account>; never an inline token
  // XOR invariant: exactly one of phoneNumber or messagingServiceSid must be provided.
  // Validation is enforced by src/core/agent-config-validator.ts, not the type.
  readonly phoneNumber?: string;         // E.164 sender — optional; use messagingServiceSid if absent
  readonly messagingServiceSid?: string; // MG… preferred sender if present
  readonly inboundMode: TwilioInboundMode;
  readonly pollIntervalMs: number;
  readonly rateLimit: { readonly smsPerMinute: number };
  readonly webhook?: TwilioWebhookConfig;  // required iff inboundMode === 'webhook'
  readonly voice?: TwilioVoiceConfig;
}

export const DEFAULT_TWILIO_VOICE: TwilioVoiceConfig = Object.freeze({
  enabled: false,
  voicemailMaxLengthSec: 120,
});

/** Defaults applied when an instance config omits the optional fields. */
export const DEFAULT_TWILIO_SMS: Pick<
  TwilioSmsConfig,
  'inboundMode' | 'pollIntervalMs' | 'rateLimit' | 'voice'
> = Object.freeze({
  inboundMode: 'poll',
  pollIntervalMs: 15000,
  rateLimit: Object.freeze({ smsPerMinute: 30 }),
  voice: DEFAULT_TWILIO_VOICE,
});
