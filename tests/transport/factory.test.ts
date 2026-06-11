// tests/transport/factory.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTwilioConfig } from './twilio/helpers.ts';
import { createConnection } from '../../src/transport/factory.ts';
import { ConnectionManager } from '../../src/transport/connection.ts';
import { TwilioConnection } from '../../src/transport/twilio/connection-bridge.ts';
import type { TwilioSmsConfig } from '../../src/transport/twilio/types.ts';


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

describe('createConnection factory — webhook mode', () => {
  beforeEach(() => {
    // Stub verifyCredentials so connect() does not hit real keyring/Twilio
    vi.mock('../../src/transport/twilio/twilio-port.ts', async (importOriginal) => {
      const orig = await importOriginal<typeof import('../../src/transport/twilio/twilio-port.ts')>();
      const Stub = class extends orig.SdkTwilioSmsPort {
        override async verifyCredentials() { /* no-op */ }
      };
      return { ...orig, SdkTwilioSmsPort: Stub };
    });
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('webhook-mode bridge binds a port after connect()', async () => {
    const conn = createConnection({
      transport: 'twilio',
      twilioConfig: makeTwilioConfig({
        inboundMode: 'webhook',
        webhook: { publicBaseUrl: 'https://example.test', listenPort: 0, listenAddress: '127.0.0.1' },
        voice: { enabled: false, voicemailMaxLengthSec: 120 },
      }),
    }) as TwilioConnection;
    expect(conn.getBoundPort()).toBeNull();
    await conn.connect();
    expect(typeof conn.getBoundPort()).toBe('number');
    expect(conn.getBoundPort()).toBeGreaterThan(0);
    // TwilioConnection.shutdown returns a promise (deterministic teardown)
    await (conn as TwilioConnection).shutdown();
  });
});
