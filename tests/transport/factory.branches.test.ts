// Extension tests for factory.ts — config validation edge cases
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTwilioConfig } from './twilio/helpers.ts';
import { createConnection } from '../../src/transport/factory.ts';

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
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createConnection factory extensions — credential validation', () => {
  it('throws when both accountSid AND authTokenService are empty strings', () => {
    expect(() =>
      createConnection({
        transport: 'twilio',
        twilioConfig: makeTwilioConfig({ accountSid: '', authTokenService: '' }),
      }),
    ).toThrow('twilioConfig is missing accountSid or authTokenService');
  });

  it('throws when only accountSid is empty', () => {
    expect(() =>
      createConnection({
        transport: 'twilio',
        twilioConfig: makeTwilioConfig({ accountSid: '' }),
      }),
    ).toThrow('twilioConfig is missing accountSid or authTokenService');
  });

  it('throws when only authTokenService is empty', () => {
    expect(() =>
      createConnection({
        transport: 'twilio',
        twilioConfig: makeTwilioConfig({ authTokenService: '' }),
      }),
    ).toThrow('twilioConfig is missing accountSid or authTokenService');
  });

  it('succeeds when both accountSid and authTokenService are non-empty', () => {
    const conn = createConnection({
      transport: 'twilio',
      twilioConfig: makeTwilioConfig({ accountSid: 'AC123', authTokenService: 'service' }),
    });
    expect(conn).toBeDefined();
  });
});

describe('createConnection factory extensions — webhook config conditional logic', () => {
  it('does not instantiate WebhookServer when inboundMode is not webhook', () => {
    webhookServerMock.constructedOptions.length = 0;
    createConnection({
      transport: 'twilio',
      twilioConfig: makeTwilioConfig({
        // Typecheck fix during the 2026-07-17 wave-8 land: TwilioInboundMode
        // is 'poll' | 'webhook', unchanged since the wave-8 branch point
        // a36b52e3f (not source drift) — 'polling' was a typo from authoring.
        inboundMode: 'poll',
        webhook: undefined,
      }),
    });
    expect(webhookServerMock.constructedOptions).toHaveLength(0);
  });

  it('does not instantiate WebhookServer when webhook config is undefined despite inboundMode=webhook', () => {
    webhookServerMock.constructedOptions.length = 0;
    createConnection({
      transport: 'twilio',
      twilioConfig: makeTwilioConfig({
        inboundMode: 'webhook',
        webhook: undefined,
      }),
    });
    expect(webhookServerMock.constructedOptions).toHaveLength(0);
  });

  it('instantiates WebhookServer when both inboundMode=webhook and webhook config present', () => {
    webhookServerMock.constructedOptions.length = 0;
    createConnection({
      transport: 'twilio',
      twilioConfig: makeTwilioConfig({
        inboundMode: 'webhook',
        webhook: {
          publicBaseUrl: 'https://example.test',
          listenPort: 8080,
          listenAddress: '127.0.0.1',
        },
      }),
    });
    expect(webhookServerMock.constructedOptions).toHaveLength(1);
  });

  it('defaults voice when undefined', () => {
    webhookServerMock.constructedOptions.length = 0;
    createConnection({
      transport: 'twilio',
      twilioConfig: makeTwilioConfig({
        inboundMode: 'webhook',
        webhook: {
          publicBaseUrl: 'https://example.test',
          listenPort: 8080,
          listenAddress: '127.0.0.1',
        },
        voice: undefined,
      }),
    });
    const opts = webhookServerMock.constructedOptions[0] as any;
    expect(opts.voice).toEqual({ enabled: false, voicemailMaxLengthSec: 120 });
  });

  it('preserves explicit voice config when provided', () => {
    webhookServerMock.constructedOptions.length = 0;
    createConnection({
      transport: 'twilio',
      twilioConfig: makeTwilioConfig({
        inboundMode: 'webhook',
        webhook: {
          publicBaseUrl: 'https://example.test',
          listenPort: 8080,
          listenAddress: '127.0.0.1',
        },
        voice: { enabled: true, voicemailMaxLengthSec: 60 },
      }),
    });
    const opts = webhookServerMock.constructedOptions[0] as any;
    expect(opts.voice).toEqual({ enabled: true, voicemailMaxLengthSec: 60 });
  });
});
