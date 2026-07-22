// tests/config.twilio.test.ts
// Focused tests for T9: transport + twilioConfig loading in src/config.ts
// and type reconciliation for TwilioSmsConfig.phoneNumber (optional).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Env management — mirror the pattern from tests/config.test.ts exactly
// ---------------------------------------------------------------------------

let savedEnv: Record<string, string | undefined>;
let tmpDir: string;

beforeEach(() => {
  savedEnv = {
    INSTANCE_CONFIG: process.env.INSTANCE_CONFIG,
    WHATSOUP_CONFIG_DIR: process.env.WHATSOUP_CONFIG_DIR,
    WHATSOUP_DATA_DIR: process.env.WHATSOUP_DATA_DIR,
    WHATSOUP_STATE_DIR: process.env.WHATSOUP_STATE_DIR,
    TMPDIR: process.env.TMPDIR,
  };

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-twilio-test-'));

  process.env.WHATSOUP_CONFIG_DIR = path.join(tmpDir, 'config');
  process.env.WHATSOUP_DATA_DIR = path.join(tmpDir, 'data');
  process.env.WHATSOUP_STATE_DIR = path.join(tmpDir, 'state');

  delete process.env.INSTANCE_CONFIG;
  delete process.env.TMPDIR;

  vi.resetModules();
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makePaths(): Record<string, string> {
  return {
    configRoot: path.join(tmpDir, 'inst-config'),
    dataRoot: path.join(tmpDir, 'inst-data'),
    stateRoot: path.join(tmpDir, 'inst-state'),
    authDir: path.join(tmpDir, 'inst-config', 'auth_info'),
    dbPath: path.join(tmpDir, 'inst-data', 'bot.db'),
    logDir: path.join(tmpDir, 'inst-data', 'logs'),
    lockPath: path.join(tmpDir, 'inst-state', 'bot.lock'),
    mediaDir: path.join(tmpDir, 'inst-data', 'media', 'tmp'),
    tmpDir: path.join(tmpDir, 'inst-data', 'tmp'),
  };
}

function makeInstanceConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'twilio-test',
    type: 'chat',
    adminPhones: ['15550000001'],
    accessMode: 'allowlist',
    paths: makePaths(),
    ...overrides,
  };
}

// Minimal valid twilioConfig for tests
const MINIMAL_TWILIO_CONFIG = {
  account: 'ml-bot',
  accountSid: 'AC00000000000000000000000000000000',
  authTokenService: 'whatsoup-twilio-ml-bot',
  phoneNumber: '+15559990000',
};

// Full twilioConfig with all fields
// NOTE: carries BOTH senders — XOR-invalid for the validator; used only to
// prove the resolver passes fields through verbatim.
const BOTH_SENDERS_TWILIO_CONFIG = {
  account: 'ml-bot',
  accountSid: 'AC00000000000000000000000000000000',
  authTokenService: 'whatsoup-twilio-ml-bot',
  phoneNumber: '+15559990000',
  messagingServiceSid: 'MGabcdef1234567890abcdef1234567890',
  inboundMode: 'poll',
  pollIntervalMs: 10000,
  rateLimit: { smsPerMinute: 20 },
};

// ---------------------------------------------------------------------------
// Part A: phoneNumber optional in TwilioSmsConfig
// ---------------------------------------------------------------------------

describe('TwilioSmsConfig — phoneNumber is optional (XOR invariant)', () => {
  it('accepts a TwilioSmsConfig without phoneNumber when messagingServiceSid is present', async () => {
    const { resolveTwilioSmsConfig } = await import('../src/config.ts');

    const result = resolveTwilioSmsConfig({
      account: 'ml-bot',
      accountSid: 'AC00000000000000000000000000000000',
      authTokenService: 'whatsoup-twilio-ml-bot',
      messagingServiceSid: 'MGabcdef1234567890abcdef1234567890',
    });

    expect(result).not.toBeUndefined();
    expect(result!.phoneNumber).toBeUndefined();
    expect(result!.messagingServiceSid).toBe('MGabcdef1234567890abcdef1234567890');
  });
});

// ---------------------------------------------------------------------------
// Part B: transport defaults
// ---------------------------------------------------------------------------

describe('config — transport defaults', () => {
  it('absent transport → defaults to "baileys", twilioConfig undefined', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig());
    const { config } = await import('../src/config.ts');

    expect(config.twilioConfig).toBeUndefined();
    expect(config.transport).toBe('baileys');
  });

  it('no INSTANCE_CONFIG → transport "baileys", twilioConfig undefined', async () => {
    delete process.env.INSTANCE_CONFIG;
    const { config } = await import('../src/config.ts');

    expect(config.twilioConfig).toBeUndefined();
    expect(config.transport).toBe('baileys');
  });
});

// ---------------------------------------------------------------------------
// Part B: transport 'twilio' + full twilioConfig → loaded verbatim
// ---------------------------------------------------------------------------

describe('config — transport twilio, full config', () => {
  it('loads twilio transport + full twilioConfig verbatim', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      transport: 'twilio',
      twilioConfig: BOTH_SENDERS_TWILIO_CONFIG,
    }));
    const { config } = await import('../src/config.ts');

    expect(config.transport).toBe('twilio');
    expect(config.twilioConfig).toBeDefined();
    const tc = config.twilioConfig!;
    expect(tc.account).toBe('ml-bot');
    expect(tc.accountSid).toBe('AC00000000000000000000000000000000');
    expect(tc.authTokenService).toBe('whatsoup-twilio-ml-bot');
    expect(tc.phoneNumber).toBe('+15559990000');
    expect(tc.messagingServiceSid).toBe('MGabcdef1234567890abcdef1234567890');
    expect(tc.inboundMode).toBe('poll');
    expect(tc.pollIntervalMs).toBe(10000);
    expect(tc.rateLimit.smsPerMinute).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// Part B: transport 'twilio' + minimal twilioConfig → defaults merged
// ---------------------------------------------------------------------------

describe('config — transport twilio, minimal config (defaults merged)', () => {
  it('merges DEFAULT_TWILIO_SMS values for absent optional fields', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      transport: 'twilio',
      twilioConfig: MINIMAL_TWILIO_CONFIG,
    }));
    const { config } = await import('../src/config.ts');

    expect(config.transport).toBe('twilio');
    expect(config.twilioConfig).toBeDefined();
    const tc = config.twilioConfig!;
    // Required fields preserved
    expect(tc.account).toBe('ml-bot');
    expect(tc.phoneNumber).toBe('+15559990000');
    // Defaults applied
    expect(tc.inboundMode).toBe('poll');
    expect(tc.pollIntervalMs).toBe(15000);
    expect(tc.rateLimit.smsPerMinute).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// Part B: messagingServiceSid-only config loads with phoneNumber undefined
// ---------------------------------------------------------------------------

describe('config — messagingServiceSid-only twilioConfig', () => {
  it('loads with phoneNumber undefined when only messagingServiceSid provided', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      transport: 'twilio',
      twilioConfig: {
        account: 'ml-bot',
        accountSid: 'AC00000000000000000000000000000000',
        authTokenService: 'whatsoup-twilio-ml-bot',
        messagingServiceSid: 'MGabcdef1234567890abcdef1234567890',
      },
    }));
    const { config } = await import('../src/config.ts');

    expect(config.transport).toBe('twilio');
    expect(config.twilioConfig).toBeDefined();
    const tc = config.twilioConfig!;
    expect(tc.phoneNumber).toBeUndefined();
    expect(tc.messagingServiceSid).toBe('MGabcdef1234567890abcdef1234567890');
    // Defaults still applied
    expect(tc.inboundMode).toBe('poll');
    expect(tc.pollIntervalMs).toBe(15000);
    expect(tc.rateLimit.smsPerMinute).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// Part B: absent twilioConfig when transport=twilio → undefined (no crash)
// ---------------------------------------------------------------------------

describe('config — transport twilio without twilioConfig', () => {
  it('does not crash when transport=twilio but twilioConfig is absent', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      transport: 'twilio',
    }));
    // Must not throw; twilioConfig is undefined since no block provided
    const { config } = await import('../src/config.ts');
    expect(config.twilioConfig).toBeUndefined();
    expect(config.transport).toBe('twilio');
  });
});

// ---------------------------------------------------------------------------
// resolveTwilioSmsConfig — exported function tests
// ---------------------------------------------------------------------------

describe('resolveTwilioSmsConfig', () => {
  it('returns undefined when called with null', async () => {
    const { resolveTwilioSmsConfig } = await import('../src/config.ts');
    expect(resolveTwilioSmsConfig(null)).toBeUndefined();
  });

  it('returns undefined when called with undefined', async () => {
    const { resolveTwilioSmsConfig } = await import('../src/config.ts');
    expect(resolveTwilioSmsConfig(undefined)).toBeUndefined();
  });

  it('returns undefined when source has no account field', async () => {
    const { resolveTwilioSmsConfig } = await import('../src/config.ts');
    expect(resolveTwilioSmsConfig({ notAnAccount: 'foo' })).toBeUndefined();
  });

  it('merges defaults for absent optional fields', async () => {
    const { resolveTwilioSmsConfig } = await import('../src/config.ts');
    const result = resolveTwilioSmsConfig({
      account: 'my-bot',
      accountSid: 'AC00000000000000000000000000000000',
      authTokenService: 'whatsoup-twilio-my-bot',
      phoneNumber: '+15550000001',
    });
    expect(result).not.toBeUndefined();
    expect(result!.inboundMode).toBe('poll');
    expect(result!.pollIntervalMs).toBe(15000);
    expect(result!.rateLimit.smsPerMinute).toBe(30);
  });

  it('preserves explicitly provided optional fields over defaults', async () => {
    const { resolveTwilioSmsConfig } = await import('../src/config.ts');
    const result = resolveTwilioSmsConfig({
      account: 'my-bot',
      accountSid: 'AC00000000000000000000000000000000',
      authTokenService: 'whatsoup-twilio-my-bot',
      phoneNumber: '+15550000001',
      inboundMode: 'poll',
      pollIntervalMs: 8000,
      rateLimit: { smsPerMinute: 10 },
    });
    expect(result!.pollIntervalMs).toBe(8000);
    expect(result!.rateLimit.smsPerMinute).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// resolveTwilioSmsConfig — webhook and voice field resolution
// ---------------------------------------------------------------------------

describe('resolveTwilioSmsConfig — webhook and voice fields', () => {
  it('normalizes trailing slash from publicBaseUrl', async () => {
    const { resolveTwilioSmsConfig } = await import('../src/config.ts');
    const result = resolveTwilioSmsConfig({
      account: 'my-bot',
      accountSid: 'AC00000000000000000000000000000000',
      authTokenService: 'whatsoup-twilio-my-bot',
      phoneNumber: '+15550000001',
      inboundMode: 'webhook',
      webhook: { publicBaseUrl: 'https://relay.example.test/', listenPort: 8443 },
    });
    expect(result?.webhook?.publicBaseUrl).toBe('https://relay.example.test');
  });

  it('passes through webhook block without trailing slash unchanged', async () => {
    const { resolveTwilioSmsConfig } = await import('../src/config.ts');
    const result = resolveTwilioSmsConfig({
      account: 'my-bot',
      accountSid: 'AC00000000000000000000000000000000',
      authTokenService: 'whatsoup-twilio-my-bot',
      phoneNumber: '+15550000001',
      inboundMode: 'webhook',
      webhook: { publicBaseUrl: 'https://relay.example.test', listenPort: 8443 },
    });
    expect(result?.webhook?.publicBaseUrl).toBe('https://relay.example.test');
    expect(result?.webhook?.listenPort).toBe(8443);
  });

  it('merges voice defaults when voice block is absent', async () => {
    const { resolveTwilioSmsConfig } = await import('../src/config.ts');
    const result = resolveTwilioSmsConfig({
      account: 'my-bot',
      accountSid: 'AC00000000000000000000000000000000',
      authTokenService: 'whatsoup-twilio-my-bot',
      phoneNumber: '+15550000001',
    });
    expect(result?.voice).toBeUndefined();
    expect(result?.webhook).toBeUndefined();
    expect(result?.phoneNumber).toBe('+15550000001');
  });

  it('passes through voice block with defaults applied', async () => {
    const { resolveTwilioSmsConfig } = await import('../src/config.ts');
    const result = resolveTwilioSmsConfig({
      account: 'my-bot',
      accountSid: 'AC00000000000000000000000000000000',
      authTokenService: 'whatsoup-twilio-my-bot',
      phoneNumber: '+15550000001',
      inboundMode: 'webhook',
      webhook: { publicBaseUrl: 'https://relay.example.test', listenPort: 8443 },
      voice: { enabled: true, voicemailMaxLengthSec: 90, voicemailGreeting: 'Leave a message.' },
    });
    expect(result?.voice?.enabled).toBe(true);
    expect(result?.voice?.voicemailMaxLengthSec).toBe(90);
    expect(result?.voice?.voicemailGreeting).toBe('Leave a message.');
  });
});
