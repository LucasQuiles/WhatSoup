// tests/transport/twilio/helpers.ts
// Shared fixtures for the twilio transport test suites.
import type { TwilioSmsConfig } from '../../../src/transport/twilio/types.ts';

/** Canonical valid config; override per test (e.g. pollIntervalMs for fake-timer suites). */
export function makeTwilioConfig(overrides?: Partial<TwilioSmsConfig>): TwilioSmsConfig {
  return {
    account: 'ml-bot',
    accountSid: 'AC00000000000000000000000000000000',
    authTokenService: 'whatsoup-twilio-ml-bot',
    phoneNumber: '+15559990000',
    inboundMode: 'poll',
    pollIntervalMs: 15000,
    rateLimit: { smsPerMinute: 30 },
    ...overrides,
  };
}
