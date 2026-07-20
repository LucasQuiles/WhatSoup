// tests/transport/factory.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTwilioConfig } from './twilio/helpers.ts';
import { createConnection } from '../../src/transport/factory.ts';
import { ConnectionManager } from '../../src/transport/connection.ts';
import { TwilioConnection } from '../../src/transport/twilio/connection-bridge.ts';
import { TwilioSmsAdapter } from '../../src/transport/twilio/adapter.ts';
import type { TwilioSmsConfig } from '../../src/transport/twilio/types.ts';
import type { InboundSms } from '../../src/transport/twilio/port.ts';
import type { TranscriptDelivery } from '../../src/transport/twilio/webhook-payloads.ts';
import type { TwilioWebhookServerOptions } from '../../src/transport/twilio/webhook-server.ts';

const keyringMock = vi.hoisted(() => ({
  lookupCredential: vi.fn(() => 'mock-token'),
}));

vi.mock('../../src/lib/keyring.ts', () => ({
  lookupCredential: keyringMock.lookupCredential,
}));

const twilioPortMock = vi.hoisted(() => ({
  verifyCredentials: vi.fn(async () => undefined),
}));

vi.mock('../../src/transport/twilio/twilio-port.ts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/transport/twilio/twilio-port.ts')>();
  const Stub = class extends orig.SdkTwilioSmsPort {
    override async verifyCredentials() {
      return twilioPortMock.verifyCredentials();
    }
  };
  return { ...orig, SdkTwilioSmsPort: Stub };
});

const webhookServerMock = vi.hoisted(() => ({
  constructedOptions: [] as unknown[],
  start: vi.fn(async () => 31337),
  stop: vi.fn(async () => undefined),
}));

vi.mock('../../src/transport/twilio/webhook-server.ts', () => ({
  TwilioWebhookServer: class {
    constructor(opts: unknown) {
      webhookServerMock.constructedOptions.push(opts);
    }

    start = webhookServerMock.start;
    stop = webhookServerMock.stop;
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  keyringMock.lookupCredential.mockReturnValue('mock-token');
  twilioPortMock.verifyCredentials.mockResolvedValue(undefined);
  webhookServerMock.constructedOptions.length = 0;
  webhookServerMock.start.mockResolvedValue(31337);
  webhookServerMock.stop.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it.each([
    ['accountSid', { accountSid: '' }],
    ['authTokenService', { authTokenService: '' }],
  ] satisfies Array<[string, Partial<TwilioSmsConfig>]>)(
    'twilio transport with empty %s throws a loud error',
    (_field, twilioConfig) => {
      expect(() =>
        createConnection({
          transport: 'twilio',
          twilioConfig: makeTwilioConfig(twilioConfig),
        }),
      ).toThrow('[createConnection] twilioConfig is missing accountSid or authTokenService.');
    },
  );

  it('forged transport id causes assertNeverTransport to throw', () => {
    expect(() =>
      createConnection({ transport: 'unknown-transport' as 'baileys' }),
    ).toThrow(/unknown transport id/);
  });

  it('signal transport throws a not-yet-wired error (foundation stub)', () => {
    expect(() =>
      createConnection({ transport: 'signal' }),
    ).toThrow(/signal.*not yet implemented|not yet wired/i);
  });

  it('imessage transport throws when imessageConfig is missing (defence-in-depth)', () => {
    expect(() =>
      createConnection({ transport: 'imessage' }),
    ).toThrow(/imessage.*imessageConfig is undefined/i);
  });

  it('imessage transport constructs an ImessageConnection with a valid imsg config', () => {
    const conn = createConnection({
      transport: 'imessage',
      imessageConfig: {
        account: 'test',
        backend: 'imsg',
        imsgSocketPath: '/tmp/imsg-test.sock',
        sender: 'me@icloud.com',
        inboundMode: 'poll',
        pollIntervalMs: 60000,
        rateLimit: { messagesPerMinute: 30 },
      },
    });
    expect(conn).toBeDefined();
    expect(typeof conn.connect).toBe('function');
    expect(typeof conn.shutdown).toBe('function');
    expect(conn.getSocket()).toBeNull();
  });

  it('imessage transport throws when imessageConfig.sender is empty', () => {
    expect(() =>
      createConnection({
        transport: 'imessage',
        imessageConfig: {
          account: 'test',
          backend: 'imsg',
          sender: '',
          inboundMode: 'poll',
          pollIntervalMs: 60000,
          rateLimit: { messagesPerMinute: 30 },
        },
      }),
    ).toThrow(/missing sender/i);
  });

  it('imessage transport throws for bluebubbles without a password service', () => {
    expect(() =>
      createConnection({
        transport: 'imessage',
        imessageConfig: {
          account: 'test',
          backend: 'bluebubbles',
          bluebubblesUrl: 'https://bb.example.test',
          sender: 'me@icloud.com',
          inboundMode: 'poll',
          pollIntervalMs: 60000,
          rateLimit: { messagesPerMinute: 30 },
        },
      }),
    ).toThrow(/bluebubblesPasswordService is missing/i);
  });
});

describe('createConnection factory — webhook mode', () => {
  it('webhook-mode bridge records the port returned by the webhook server', async () => {
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
    expect(webhookServerMock.start).toHaveBeenCalledTimes(1);
    expect(conn.getBoundPort()).toBe(31337);
    await conn.shutdown();
    expect(webhookServerMock.stop).toHaveBeenCalledTimes(1);
  });

  it('wires webhook auth lookup, defaults voice, and forwards callbacks to the adapter', () => {
    const inboundSpy = vi.spyOn(TwilioSmsAdapter.prototype, 'handleInboundRecord').mockReturnValue(true);
    const transcriptSpy = vi.spyOn(TwilioSmsAdapter.prototype, 'handleTranscript').mockReturnValue(true);

    createConnection({
      transport: 'twilio',
      twilioConfig: makeTwilioConfig({
        inboundMode: 'webhook',
        webhook: {
          publicBaseUrl: 'https://webhook.example.test/',
          listenPort: 8123,
          listenAddress: '0.0.0.0',
        },
        voice: undefined,
      }),
    });

    const opts = webhookServerMock.constructedOptions[0] as TwilioWebhookServerOptions;
    expect(opts).toMatchObject({
      publicBaseUrl: 'https://webhook.example.test/',
      listenPort: 8123,
      listenAddress: '0.0.0.0',
      voice: { enabled: false, voicemailMaxLengthSec: 120 },
    });
    expect(opts.getAuthToken()).toBe('mock-token');
    expect(keyringMock.lookupCredential).toHaveBeenCalledWith('twilio-ml-bot');

    const sms: InboundSms = {
      sid: 'SM00000000000000000000000000000000',
      from: '+15550001111',
      to: '+15559990000',
      body: 'hello',
      sentAt: new Date('2026-06-15T00:00:00.000Z'),
      fromMe: false,
      status: 'received',
    };
    opts.onSms(sms);
    expect(inboundSpy).toHaveBeenCalledWith(sms);

    const transcript: TranscriptDelivery = {
      text: 'message',
      recordingSid: 'RE00000000000000000000000000000000',
      recordingUrl: 'https://api.example.test/recording',
      callSid: 'CA00000000000000000000000000000000',
      from: '+15550001111',
      to: '+15559990000',
    };
    opts.onTranscript(transcript);
    expect(transcriptSpy).toHaveBeenCalledWith(transcript);
  });
});
