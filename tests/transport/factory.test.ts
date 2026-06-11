// tests/transport/factory.test.ts
import { describe, it, expect } from 'vitest';
import { createConnection } from '../../src/transport/factory.ts';
import { ConnectionManager } from '../../src/transport/connection.ts';
import { TwilioConnection } from '../../src/transport/twilio/connection-bridge.ts';
import type { TwilioSmsConfig } from '../../src/transport/twilio/types.ts';

function makeTwilioConfig(overrides?: Partial<TwilioSmsConfig>): TwilioSmsConfig {
  return {
    account: 'ml-bot',
    accountSid: 'AC00000000000000000000000000000000',
    authTokenService: 'twilio-ml-bot',
    phoneNumber: '+15559990000',
    inboundMode: 'poll',
    pollIntervalMs: 15000,
    rateLimit: { smsPerMinute: 30 },
    ...overrides,
  };
}

describe('createConnection factory', () => {
  it('baileys config returns a ConnectionManager instance', () => {
    const conn = createConnection({ transport: 'baileys' });
    expect(conn).toBeInstanceOf(ConnectionManager);
  });

  it('twilio config with twilioConfig returns a TwilioConnection instance', () => {
    const conn = createConnection({
      transport: 'twilio',
      twilioConfig: makeTwilioConfig(),
    });
    expect(conn).toBeInstanceOf(TwilioConnection);
  });

  it('twilio transport without twilioConfig throws a loud error', () => {
    expect(() =>
      createConnection({ transport: 'twilio', twilioConfig: undefined }),
    ).toThrow('[createConnection] transport is "twilio" but twilioConfig is undefined');
  });

  it('forged transport id causes assertNeverTransport to throw', () => {
    expect(() =>
      createConnection({ transport: 'unknown-transport' as 'baileys' }),
    ).toThrow(/unknown transport id/);
  });
});
