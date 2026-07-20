/**
 * Transport config validation coverage for agent-config-validator.ts.
 *
 * Mirrors the naming and style of agent-config-validator-provider.test.ts.
 * Covers: transport enum, twilioConfig presence rules, all twilioConfig fields,
 * sender XOR, inboundMode webhook guard, pollIntervalMs bounds.
 */
import { describe, it, expect } from 'vitest';
import { validateInstanceConfig } from '../../src/core/agent-config-validator.ts';
import { TRANSPORT_IDS } from '../../src/transport/registry.ts';
import type { ValidatorContext } from '../../src/core/agent-config-validator.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'test-line',
    type: 'agent',
    accessMode: 'self_only',
    adminPhones: ['15555550123'],
    agentOptions: { sessionScope: 'single' },
    ...overrides,
  };
}

function validTwilioConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    account: 'ml-bot',
    accountSid: 'AC' + 'a'.repeat(32),
    authTokenService: 'twilio-ml-bot-token',
    phoneNumber: '+15559990000',
    inboundMode: 'poll',
    pollIntervalMs: 15000,
    rateLimit: { smsPerMinute: 30 },
    ...overrides,
  };
}

const ctx = (mode: ValidatorContext['mode'] = 'create'): ValidatorContext => ({
  name: 'test-line',
  mode,
});

// ---------------------------------------------------------------------------
// transport field
// ---------------------------------------------------------------------------

describe('validateInstanceConfig — transport field', () => {
  it('accepts every canonical transport ID (baileys with no twilioConfig)', () => {
    const raw = baseRaw({ transport: 'baileys' });
    expect(validateInstanceConfig(raw, ctx())).toBeNull();
  });

  it('accepts absent transport (defaults to baileys)', () => {
    const raw = baseRaw();
    expect(validateInstanceConfig(raw, ctx())).toBeNull();
  });

  it('rejects unknown transport ID', () => {
    const raw = baseRaw({ transport: 'carrier-pigeon' });
    const err = validateInstanceConfig(raw, ctx());
    expect(err).not.toBeNull();
    expect(err?.field).toBe('transport');
    expect(err?.message).toContain('carrier-pigeon');
    expect(err?.message).toContain('baileys');
    expect(err?.message).toContain('twilio');
  });

  it('rejects mis-cased transport ID: Baileys', () => {
    const raw = baseRaw({ transport: 'Baileys' });
    const err = validateInstanceConfig(raw, ctx());
    expect(err).not.toBeNull();
    expect(err?.field).toBe('transport');
  });

  it('rejects mis-cased transport ID: Twilio', () => {
    const raw = baseRaw({ transport: 'Twilio' });
    const err = validateInstanceConfig(raw, ctx());
    expect(err).not.toBeNull();
    expect(err?.field).toBe('transport');
  });

  it('TRANSPORT_IDS contains baileys and twilio (registry sanity)', () => {
    expect([...TRANSPORT_IDS]).toContain('baileys');
    expect([...TRANSPORT_IDS]).toContain('twilio');
  });
});

// ---------------------------------------------------------------------------
// twilioConfig presence rules
// ---------------------------------------------------------------------------

describe('validateInstanceConfig — twilioConfig presence rules', () => {
  it('requires twilioConfig object when transport is twilio', () => {
    const raw = baseRaw({ transport: 'twilio' });
    const err = validateInstanceConfig(raw, ctx());
    expect(err).not.toBeNull();
    expect(err?.field).toBe('twilioConfig');
    expect(err?.message).toContain('required');
  });

  it('rejects non-object twilioConfig (string)', () => {
    const raw = baseRaw({ transport: 'twilio', twilioConfig: 'not-an-object' });
    const err = validateInstanceConfig(raw, ctx());
    expect(err).not.toBeNull();
    expect(err?.field).toBe('twilioConfig');
    expect(err?.message).toContain('object');
  });

  it('rejects twilioConfig present when transport is baileys (inconsistent)', () => {
    const raw = baseRaw({ transport: 'baileys', twilioConfig: validTwilioConfig() });
    const err = validateInstanceConfig(raw, ctx());
    expect(err).not.toBeNull();
    expect(err?.field).toBe('twilioConfig');
    expect(err?.message).toContain('inconsistent');
  });

  it('rejects twilioConfig present when transport is absent (defaults to baileys — inconsistent)', () => {
    const raw = baseRaw({ twilioConfig: validTwilioConfig() });
    const err = validateInstanceConfig(raw, ctx());
    expect(err).not.toBeNull();
    expect(err?.field).toBe('twilioConfig');
    expect(err?.message).toContain('inconsistent');
  });

  it('accepts valid twilioConfig with transport: twilio', () => {
    const raw = baseRaw({ transport: 'twilio', twilioConfig: validTwilioConfig() });
    expect(validateInstanceConfig(raw, ctx())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// twilioConfig.account
// ---------------------------------------------------------------------------

describe('validateInstanceConfig — twilioConfig.account', () => {
  it('rejects missing account', () => {
    const cfg = validTwilioConfig({ account: undefined });
    const raw = baseRaw({ transport: 'twilio', twilioConfig: cfg });
    const err = validateInstanceConfig(raw, ctx());
    expect(err?.field).toBe('twilioConfig.account');
  });

  it('rejects empty account', () => {
    const cfg = validTwilioConfig({ account: '' });
    const raw = baseRaw({ transport: 'twilio', twilioConfig: cfg });
    const err = validateInstanceConfig(raw, ctx());
    expect(err?.field).toBe('twilioConfig.account');
  });

  it('rejects account with uppercase letters (ACCOUNT_RE requires lowercase)', () => {
    const cfg = validTwilioConfig({ account: 'ML-Bot' });
    const raw = baseRaw({ transport: 'twilio', twilioConfig: cfg });
    const err = validateInstanceConfig(raw, ctx());
    expect(err?.field).toBe('twilioConfig.account');
  });

  it('rejects account starting with a digit', () => {
    const cfg = validTwilioConfig({ account: '1bot' });
    const raw = baseRaw({ transport: 'twilio', twilioConfig: cfg });
    const err = validateInstanceConfig(raw, ctx());
    expect(err?.field).toBe('twilioConfig.account');
  });

  it('accepts valid account slug', () => {
    const cfg = validTwilioConfig({ account: 'ml-bot' });
    const raw = baseRaw({ transport: 'twilio', twilioConfig: cfg });
    expect(validateInstanceConfig(raw, ctx())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// twilioConfig.accountSid
// ---------------------------------------------------------------------------

describe('validateInstanceConfig — twilioConfig.accountSid', () => {
  it('rejects missing accountSid', () => {
    const cfg = validTwilioConfig({ accountSid: undefined });
    const raw = baseRaw({ transport: 'twilio', twilioConfig: cfg });
    const err = validateInstanceConfig(raw, ctx());
    expect(err?.field).toBe('twilioConfig.accountSid');
  });

  it('rejects accountSid with lowercase ac prefix', () => {
    const cfg = validTwilioConfig({ accountSid: 'ac' + 'a'.repeat(32) });
    const raw = baseRaw({ transport: 'twilio', twilioConfig: cfg });
    expect(validateInstanceConfig(raw, ctx())?.field).toBe('twilioConfig.accountSid');
  });

  it('rejects accountSid with uppercase hex digits', () => {
    const cfg = validTwilioConfig({ accountSid: 'AC' + 'A'.repeat(32) });
    const raw = baseRaw({ transport: 'twilio', twilioConfig: cfg });
    expect(validateInstanceConfig(raw, ctx())?.field).toBe('twilioConfig.accountSid');
  });

  it('rejects accountSid that is too short (31 hex chars)', () => {
    const cfg = validTwilioConfig({ accountSid: 'AC' + 'a'.repeat(31) });
    const raw = baseRaw({ transport: 'twilio', twilioConfig: cfg });
    expect(validateInstanceConfig(raw, ctx())?.field).toBe('twilioConfig.accountSid');
  });

  it('rejects accountSid that is too long (33 hex chars)', () => {
    const cfg = validTwilioConfig({ accountSid: 'AC' + 'a'.repeat(33) });
    const raw = baseRaw({ transport: 'twilio', twilioConfig: cfg });
    expect(validateInstanceConfig(raw, ctx())?.field).toBe('twilioConfig.accountSid');
  });

  it('rejects accountSid with wrong prefix AB', () => {
    const cfg = validTwilioConfig({ accountSid: 'AB' + 'a'.repeat(32) });
    const raw = baseRaw({ transport: 'twilio', twilioConfig: cfg });
    expect(validateInstanceConfig(raw, ctx())?.field).toBe('twilioConfig.accountSid');
  });

  it('rejects empty accountSid', () => {
    const cfg = validTwilioConfig({ accountSid: '' });
    const raw = baseRaw({ transport: 'twilio', twilioConfig: cfg });
    expect(validateInstanceConfig(raw, ctx())?.field).toBe('twilioConfig.accountSid');
  });

  it('accepts valid accountSid with all zeros', () => {
    const cfg = validTwilioConfig({ accountSid: 'AC' + '0'.repeat(32) });
    const raw = baseRaw({ transport: 'twilio', twilioConfig: cfg });
    expect(validateInstanceConfig(raw, ctx())).toBeNull();
  });

  it('accepts valid accountSid with mixed lowercase hex', () => {
    const cfg = validTwilioConfig({ accountSid: 'AC' + 'a'.repeat(32) });
    const raw = baseRaw({ transport: 'twilio', twilioConfig: cfg });
    expect(validateInstanceConfig(raw, ctx())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// twilioConfig.authTokenService
// ---------------------------------------------------------------------------

describe('validateInstanceConfig — twilioConfig.authTokenService', () => {
  it('rejects missing authTokenService', () => {
    const cfg = validTwilioConfig({ authTokenService: undefined });
    const raw = baseRaw({ transport: 'twilio', twilioConfig: cfg });
    expect(validateInstanceConfig(raw, ctx())?.field).toBe('twilioConfig.authTokenService');
  });

  it('rejects empty authTokenService', () => {
    const cfg = validTwilioConfig({ authTokenService: '' });
    const raw = baseRaw({ transport: 'twilio', twilioConfig: cfg });
    expect(validateInstanceConfig(raw, ctx())?.field).toBe('twilioConfig.authTokenService');
  });

  it('rejects authTokenService containing whitespace (inline token guard)', () => {
    const cfg = validTwilioConfig({ authTokenService: 'some inline token value' });
    const raw = baseRaw({ transport: 'twilio', twilioConfig: cfg });
    expect(validateInstanceConfig(raw, ctx())?.field).toBe('twilioConfig.authTokenService');
  });

  it('rejects authTokenService longer than 128 chars', () => {
    const cfg = validTwilioConfig({ authTokenService: 'a'.repeat(129) });
    const raw = baseRaw({ transport: 'twilio', twilioConfig: cfg });
    expect(validateInstanceConfig(raw, ctx())?.field).toBe('twilioConfig.authTokenService');
  });

  it('accepts authTokenService exactly 128 chars (boundary)', () => {
    const cfg = validTwilioConfig({ authTokenService: 'a'.repeat(128) });
    const raw = baseRaw({ transport: 'twilio', twilioConfig: cfg });
    expect(validateInstanceConfig(raw, ctx())).toBeNull();
  });

  it('accepts a normal service name', () => {
    const cfg = validTwilioConfig({ authTokenService: 'twilio-ml-bot-token' });
    const raw = baseRaw({ transport: 'twilio', twilioConfig: cfg });
    expect(validateInstanceConfig(raw, ctx())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// twilioConfig sender XOR (phoneNumber vs messagingServiceSid)
// ---------------------------------------------------------------------------

describe('validateInstanceConfig — twilioConfig sender XOR', () => {
  it('rejects when both phoneNumber and messagingServiceSid are set (ambiguous sender)', () => {
    const cfg = validTwilioConfig({
      phoneNumber: '+15559990000',
      messagingServiceSid: 'MG' + 'b'.repeat(32),
    });
    const raw = baseRaw({ transport: 'twilio', twilioConfig: cfg });
    const err = validateInstanceConfig(raw, ctx());
    expect(err).not.toBeNull();
    expect(err?.field).toMatch(/^twilioConfig\.(phoneNumber|messagingServiceSid)$/);
  });

  it('rejects when neither phoneNumber nor messagingServiceSid is set', () => {
    const cfg = validTwilioConfig({ phoneNumber: undefined, messagingServiceSid: undefined });
    const raw = baseRaw({ transport: 'twilio', twilioConfig: cfg });
    const err = validateInstanceConfig(raw, ctx());
    expect(err).not.toBeNull();
    expect(err?.field).toMatch(/^twilioConfig\.(phoneNumber|messagingServiceSid)$/);
  });

  it('rejects phoneNumber missing + prefix', () => {
    const cfg = validTwilioConfig({ phoneNumber: '15559990000', messagingServiceSid: undefined });
    const raw = baseRaw({ transport: 'twilio', twilioConfig: cfg });
    expect(validateInstanceConfig(raw, ctx())?.field).toBe('twilioConfig.phoneNumber');
  });

  it('rejects phoneNumber too short (+1 = only 2 chars)', () => {
    const cfg = validTwilioConfig({ phoneNumber: '+1', messagingServiceSid: undefined });
    const raw = baseRaw({ transport: 'twilio', twilioConfig: cfg });
    expect(validateInstanceConfig(raw, ctx())?.field).toBe('twilioConfig.phoneNumber');
  });

  it('rejects phoneNumber with leading zero country code', () => {
    const cfg = validTwilioConfig({ phoneNumber: '+0555999000', messagingServiceSid: undefined });
    const raw = baseRaw({ transport: 'twilio', twilioConfig: cfg });
    expect(validateInstanceConfig(raw, ctx())?.field).toBe('twilioConfig.phoneNumber');
  });

  it('rejects phoneNumber too long (>15 digits after +)', () => {
    const cfg = validTwilioConfig({ phoneNumber: '+155599900001234567', messagingServiceSid: undefined });
    const raw = baseRaw({ transport: 'twilio', twilioConfig: cfg });
    expect(validateInstanceConfig(raw, ctx())?.field).toBe('twilioConfig.phoneNumber');
  });

  it('accepts valid E.164 phoneNumber', () => {
    const cfg = validTwilioConfig({ phoneNumber: '+15559990000', messagingServiceSid: undefined });
    const raw = baseRaw({ transport: 'twilio', twilioConfig: cfg });
    expect(validateInstanceConfig(raw, ctx())).toBeNull();
  });

  it('rejects messagingServiceSid with lowercase mg prefix', () => {
    const cfg = validTwilioConfig({ phoneNumber: undefined, messagingServiceSid: 'mg' + 'b'.repeat(32) });
    const raw = baseRaw({ transport: 'twilio', twilioConfig: cfg });
    expect(validateInstanceConfig(raw, ctx())?.field).toBe('twilioConfig.messagingServiceSid');
  });

  it('rejects messagingServiceSid with uppercase hex digits', () => {
    const cfg = validTwilioConfig({ phoneNumber: undefined, messagingServiceSid: 'MG' + 'B'.repeat(32) });
    const raw = baseRaw({ transport: 'twilio', twilioConfig: cfg });
    expect(validateInstanceConfig(raw, ctx())?.field).toBe('twilioConfig.messagingServiceSid');
  });

  it('rejects messagingServiceSid too short (31 hex chars)', () => {
    const cfg = validTwilioConfig({ phoneNumber: undefined, messagingServiceSid: 'MG' + 'b'.repeat(31) });
    const raw = baseRaw({ transport: 'twilio', twilioConfig: cfg });
    expect(validateInstanceConfig(raw, ctx())?.field).toBe('twilioConfig.messagingServiceSid');
  });

  it('rejects messagingServiceSid too long (33 hex chars)', () => {
    const cfg = validTwilioConfig({ phoneNumber: undefined, messagingServiceSid: 'MG' + 'b'.repeat(33) });
    const raw = baseRaw({ transport: 'twilio', twilioConfig: cfg });
    expect(validateInstanceConfig(raw, ctx())?.field).toBe('twilioConfig.messagingServiceSid');
  });

  it('rejects messagingServiceSid with wrong prefix MA', () => {
    const cfg = validTwilioConfig({ phoneNumber: undefined, messagingServiceSid: 'MA' + 'b'.repeat(32) });
    const raw = baseRaw({ transport: 'twilio', twilioConfig: cfg });
    expect(validateInstanceConfig(raw, ctx())?.field).toBe('twilioConfig.messagingServiceSid');
  });

  it('accepts valid messagingServiceSid-only config (no phoneNumber)', () => {
    const cfg = validTwilioConfig({ phoneNumber: undefined, messagingServiceSid: 'MG' + 'b'.repeat(32) });
    const raw = baseRaw({ transport: 'twilio', twilioConfig: cfg });
    expect(validateInstanceConfig(raw, ctx())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// twilioConfig.inboundMode
// ---------------------------------------------------------------------------

describe('validateInstanceConfig — twilioConfig.inboundMode', () => {
  it('accepts inboundMode: webhook with a complete webhook block', () => {
    const cfg = validTwilioConfig({
      inboundMode: 'webhook',
      webhook: { publicBaseUrl: 'https://relay.example.test', listenPort: 8443 },
    });
    const raw = baseRaw({ transport: 'twilio', twilioConfig: cfg });
    expect(validateInstanceConfig(raw, ctx())).toBeNull();
  });

  it('rejects inboundMode: webhook without a webhook block, naming the field', () => {
    const cfg = validTwilioConfig({ inboundMode: 'webhook' });
    const raw = baseRaw({ transport: 'twilio', twilioConfig: cfg });
    const err = validateInstanceConfig(raw, ctx());
    expect(err?.field).toBe('twilioConfig.webhook');
  });

  it('rejects unknown inboundMode value', () => {
    const cfg = validTwilioConfig({ inboundMode: 'streaming' });
    const raw = baseRaw({ transport: 'twilio', twilioConfig: cfg });
    const err = validateInstanceConfig(raw, ctx());
    expect(err?.field).toBe('twilioConfig.inboundMode');
  });

  it('accepts inboundMode: poll', () => {
    const cfg = validTwilioConfig({ inboundMode: 'poll' });
    const raw = baseRaw({ transport: 'twilio', twilioConfig: cfg });
    expect(validateInstanceConfig(raw, ctx())).toBeNull();
  });

  it('accepts absent inboundMode (optional field)', () => {
    const cfg = validTwilioConfig({ inboundMode: undefined });
    const raw = baseRaw({ transport: 'twilio', twilioConfig: cfg });
    expect(validateInstanceConfig(raw, ctx())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// twilioConfig.pollIntervalMs
// ---------------------------------------------------------------------------

describe('validateInstanceConfig — twilioConfig.pollIntervalMs', () => {
  it('rejects pollIntervalMs of 4999 (below 5000)', () => {
    const cfg = validTwilioConfig({ pollIntervalMs: 4999 });
    const raw = baseRaw({ transport: 'twilio', twilioConfig: cfg });
    const err = validateInstanceConfig(raw, ctx());
    expect(err?.field).toBe('twilioConfig.pollIntervalMs');
    expect(err?.message).toContain('5000');
  });

  it('rejects pollIntervalMs as non-integer float', () => {
    const cfg = validTwilioConfig({ pollIntervalMs: 5000.5 });
    const raw = baseRaw({ transport: 'twilio', twilioConfig: cfg });
    expect(validateInstanceConfig(raw, ctx())?.field).toBe('twilioConfig.pollIntervalMs');
  });

  it('rejects pollIntervalMs as non-number string', () => {
    const cfg = validTwilioConfig({ pollIntervalMs: '15000' });
    const raw = baseRaw({ transport: 'twilio', twilioConfig: cfg });
    expect(validateInstanceConfig(raw, ctx())?.field).toBe('twilioConfig.pollIntervalMs');
  });

  it('accepts pollIntervalMs at 5000 boundary', () => {
    const cfg = validTwilioConfig({ pollIntervalMs: 5000 });
    const raw = baseRaw({ transport: 'twilio', twilioConfig: cfg });
    expect(validateInstanceConfig(raw, ctx())).toBeNull();
  });

  it('accepts pollIntervalMs of 15000', () => {
    const cfg = validTwilioConfig({ pollIntervalMs: 15000 });
    const raw = baseRaw({ transport: 'twilio', twilioConfig: cfg });
    expect(validateInstanceConfig(raw, ctx())).toBeNull();
  });

  it('accepts absent pollIntervalMs (optional field)', () => {
    const cfg = validTwilioConfig({ pollIntervalMs: undefined });
    const raw = baseRaw({ transport: 'twilio', twilioConfig: cfg });
    expect(validateInstanceConfig(raw, ctx())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Full valid configs (all modes)
// ---------------------------------------------------------------------------

describe('validateInstanceConfig — full valid twilio configs', () => {
  it('accepts full valid twilio config with phoneNumber', () => {
    const raw = baseRaw({
      transport: 'twilio',
      twilioConfig: {
        account: 'ml-bot',
        accountSid: 'AC' + 'a'.repeat(32),
        authTokenService: 'twilio-ml-bot-token',
        phoneNumber: '+15559990000',
        inboundMode: 'poll',
        pollIntervalMs: 15000,
        rateLimit: { smsPerMinute: 30 },
      },
    });
    expect(validateInstanceConfig(raw, ctx())).toBeNull();
  });

  it('accepts full valid twilio config with messagingServiceSid only', () => {
    const raw = baseRaw({
      transport: 'twilio',
      twilioConfig: {
        account: 'ml-bot',
        accountSid: 'AC' + 'a'.repeat(32),
        authTokenService: 'twilio-ml-bot-token',
        messagingServiceSid: 'MG' + 'c'.repeat(32),
        inboundMode: 'poll',
        pollIntervalMs: 15000,
        rateLimit: { smsPerMinute: 30 },
      },
    });
    expect(validateInstanceConfig(raw, ctx())).toBeNull();
  });

  it('accepts twilio config across all validator modes', () => {
    const raw = baseRaw({
      transport: 'twilio',
      twilioConfig: validTwilioConfig(),
    });
    for (const mode of ['create', 'patch', 'load', 'discovery'] as const) {
      expect(
        validateInstanceConfig(raw, { name: 'test-line', mode }),
        `mode ${mode} should pass`,
      ).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Existing validation must remain unchanged
// ---------------------------------------------------------------------------

describe('validateInstanceConfig — existing validation unaffected by transport rules', () => {
  it('still rejects invalid type', () => {
    const raw = baseRaw({ type: 'bogus' });
    expect(validateInstanceConfig(raw, ctx())?.field).toBe('type');
  });

  it('still rejects invalid provider in agentOptions', () => {
    const raw = baseRaw({
      agentOptions: { sessionScope: 'single', provider: 'not-a-real-provider' },
    });
    expect(validateInstanceConfig(raw, ctx())?.field).toBe('agentOptions.provider');
  });

  it('still rejects healthPort out of range', () => {
    const raw = baseRaw({ healthPort: 80 });
    expect(validateInstanceConfig(raw, ctx())?.field).toBe('healthPort');
  });
});

// ---------------------------------------------------------------------------
// review hardening: shape edge cases, bounds, message pins
// ---------------------------------------------------------------------------

describe('validateInstanceConfig — transport review hardening', () => {
  it('rejects twilioConfig as null when transport is twilio', () => {
    const raw = baseRaw({ transport: 'twilio', twilioConfig: null });
    const err = validateInstanceConfig(raw, ctx());
    expect(err?.field).toBe('twilioConfig');
  });

  it('rejects twilioConfig as an array', () => {
    const raw = baseRaw({ transport: 'twilio', twilioConfig: [validTwilioConfig()] });
    const err = validateInstanceConfig(raw, ctx());
    expect(err?.field).toBe('twilioConfig');
    expect(err?.message).toContain('object');
  });

  it('treats explicit null senders as neither-present (rejected)', () => {
    const raw = baseRaw({
      transport: 'twilio',
      twilioConfig: validTwilioConfig({ phoneNumber: null, messagingServiceSid: null }),
    });
    const err = validateInstanceConfig(raw, ctx());
    expect(err?.field).toBe('twilioConfig.phoneNumber');
  });

  it('pins the both-senders-set error to twilioConfig.phoneNumber', () => {
    const raw = baseRaw({
      transport: 'twilio',
      twilioConfig: validTwilioConfig({
        phoneNumber: '+15559990000',
        messagingServiceSid: 'MG' + 'a'.repeat(32),
      }),
    });
    const err = validateInstanceConfig(raw, ctx());
    expect(err?.field).toBe('twilioConfig.phoneNumber');
  });

  it('accepts pollIntervalMs at the 5000 floor exactly', () => {
    const raw = baseRaw({
      transport: 'twilio',
      twilioConfig: validTwilioConfig({ pollIntervalMs: 5000 }),
    });
    expect(validateInstanceConfig(raw, ctx())).toBeNull();
  });

  it('rejects pollIntervalMs above the 24h ceiling', () => {
    const raw = baseRaw({
      transport: 'twilio',
      twilioConfig: validTwilioConfig({ pollIntervalMs: 86_400_001 }),
    });
    const err = validateInstanceConfig(raw, ctx());
    expect(err?.field).toBe('twilioConfig.pollIntervalMs');
    expect(err?.message).toContain('86400000');
  });

  it('accepts pollIntervalMs at the 24h ceiling exactly', () => {
    const raw = baseRaw({
      transport: 'twilio',
      twilioConfig: validTwilioConfig({ pollIntervalMs: 86_400_000 }),
    });
    expect(validateInstanceConfig(raw, ctx())).toBeNull();
  });

  it('pins the unknown-inboundMode message', () => {
    const raw = baseRaw({
      transport: 'twilio',
      twilioConfig: validTwilioConfig({ inboundMode: 'streaming' }),
    });
    const err = validateInstanceConfig(raw, ctx());
    expect(err?.message).toBe("twilioConfig.inboundMode must be 'poll' or 'webhook'");
  });

  it('requires twilioConfig in load mode too (daemon startup path)', () => {
    const raw = baseRaw({ transport: 'twilio' });
    const err = validateInstanceConfig(raw, ctx('load'));
    expect(err?.field).toBe('twilioConfig');
  });

  it('shares the account pattern with transport-refs (DRY pin)', () => {
    const raw = baseRaw({
      transport: 'twilio',
      twilioConfig: validTwilioConfig({ account: 'UPPER-not-allowed' }),
    });
    const err = validateInstanceConfig(raw, ctx());
    expect(err?.field).toBe('twilioConfig.account');
  });
});

describe('validateInstanceConfig — twilio rateLimit bounds', () => {
  it('rejects zero, negative, and non-integer smsPerMinute', () => {
    for (const bad of [0, -5, 1.5, '30']) {
      const raw = baseRaw({
        transport: 'twilio',
        twilioConfig: validTwilioConfig({ rateLimit: { smsPerMinute: bad } }),
      });
      const err = validateInstanceConfig(raw, ctx());
      expect(err?.field).toBe('twilioConfig.rateLimit.smsPerMinute');
    }
  });

  it('rejects a non-object rateLimit', () => {
    const raw = baseRaw({
      transport: 'twilio',
      twilioConfig: validTwilioConfig({ rateLimit: 'fast' }),
    });
    const err = validateInstanceConfig(raw, ctx());
    expect(err?.field).toBe('twilioConfig.rateLimit');
  });

  it('accepts absent rateLimit and bounds 1 and 600', () => {
    const noRate = validTwilioConfig();
    delete (noRate as Record<string, unknown>)['rateLimit'];
    expect(validateInstanceConfig(baseRaw({ transport: 'twilio', twilioConfig: noRate }), ctx())).toBeNull();
    for (const ok of [1, 600]) {
      const raw = baseRaw({
        transport: 'twilio',
        twilioConfig: validTwilioConfig({ rateLimit: { smsPerMinute: ok } }),
      });
      expect(validateInstanceConfig(raw, ctx())).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// validateInstanceConfig — webhook inbound (stage 2 unlock)
// ---------------------------------------------------------------------------

describe('validateInstanceConfig — webhook inbound (stage 2 unlock)', () => {
  it('accepts inboundMode webhook with a complete webhook block', () => {
    const raw = baseRaw({ transport: 'twilio', twilioConfig: validTwilioConfig({
      inboundMode: 'webhook',
      webhook: { publicBaseUrl: 'https://relay.example.test', listenPort: 8443 },
    }) });
    expect(validateInstanceConfig(raw, ctx())).toBeNull();
  });
  it('rejects webhook mode without a webhook block, naming the field', () => {
    const raw = baseRaw({ transport: 'twilio', twilioConfig: validTwilioConfig({ inboundMode: 'webhook' }) });
    const err = validateInstanceConfig(raw, ctx());
    expect(err?.field).toBe('twilioConfig.webhook');
  });
  it('rejects a non-https publicBaseUrl', () => {
    const raw = baseRaw({ transport: 'twilio', twilioConfig: validTwilioConfig({
      inboundMode: 'webhook', webhook: { publicBaseUrl: 'http://insecure.example', listenPort: 8443 },
    }) });
    expect(validateInstanceConfig(raw, ctx())?.field).toBe('twilioConfig.webhook.publicBaseUrl');
  });
  it('rejects voice.enabled with poll mode (coherence rule, exact remediation)', () => {
    const raw = baseRaw({ transport: 'twilio', twilioConfig: validTwilioConfig({
      voice: { enabled: true, voicemailMaxLengthSec: 120 },
    }) });
    const err = validateInstanceConfig(raw, ctx());
    expect(err?.message).toBe("voice requires inboundMode:'webhook' (transcription arrives via webhook callbacks)");
  });
  it('rejects webhook block when inboundMode is poll (fail closed)', () => {
    const raw = baseRaw({ transport: 'twilio', twilioConfig: validTwilioConfig({
      webhook: { publicBaseUrl: 'https://x.example', listenPort: 8443 },
    }) });
    expect(validateInstanceConfig(raw, ctx())?.field).toBe('twilioConfig.webhook');
  });
  it('rejects voice.enabled:true with no phoneNumber (calls.create requires from: string)', () => {
    const raw = baseRaw({ transport: 'twilio', twilioConfig: {
      ...validTwilioConfig({
        phoneNumber: undefined,
        messagingServiceSid: 'MG' + 'c'.repeat(32),
        inboundMode: 'webhook',
        webhook: { publicBaseUrl: 'https://relay.example.test', listenPort: 8443 },
        voice: { enabled: true, voicemailMaxLengthSec: 120 },
      }),
    } });
    const err = validateInstanceConfig(raw, ctx());
    expect(err?.message).toBe('voice requires phoneNumber (calls cannot originate from a messagingServiceSid)');
  });
});

describe('validateInstanceConfig — residual twilio branch coverage', () => {
  it('rejects a webhook block whose publicBaseUrl is an empty string', () => {
    const raw = baseRaw({
      transport: 'twilio',
      twilioConfig: validTwilioConfig({
        inboundMode: 'webhook',
        webhook: { publicBaseUrl: '', listenPort: 8443 },
      }),
    });
    const err = validateInstanceConfig(raw, ctx());
    expect(err?.field).toBe('twilioConfig.webhook.publicBaseUrl');
    expect(err?.message).toBe('twilioConfig.webhook.publicBaseUrl must be a non-empty string');
  });

  it('accepts a voice block with enabled:false without applying the webhook coherence rule', () => {
    // voiceEnabled !== true takes the else path: the inboundMode/phoneNumber
    // coherence checks are skipped and a poll-mode config stays valid.
    const raw = baseRaw({
      transport: 'twilio',
      twilioConfig: validTwilioConfig({
        inboundMode: 'poll',
        voice: { enabled: false, voicemailMaxLengthSec: 120 },
      }),
    });
    expect(validateInstanceConfig(raw, ctx())).toBeNull();
  });

  it('accepts a rateLimit object that omits smsPerMinute', () => {
    // rateLimit present but smsPerMinute undefined: the bounds check is skipped.
    const raw = baseRaw({
      transport: 'twilio',
      twilioConfig: validTwilioConfig({ rateLimit: {} }),
    });
    expect(validateInstanceConfig(raw, ctx())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// imessageConfig
// ---------------------------------------------------------------------------

function validImessageConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    account: 'mac-mini',
    backend: 'bluebubbles',
    bluebubblesUrl: 'https://bb.example.test',
    bluebubblesPasswordService: 'imessage-bb-pw',
    sender: 'appleid@users.noreply.github.com',
    inboundMode: 'poll',
    pollIntervalMs: 15000,
    rateLimit: { messagesPerMinute: 30 },
    ...overrides,
  };
}

describe('validateInstanceConfig — imessageConfig', () => {
  it('is required when transport is "imessage"', () => {
    const raw = baseRaw({ transport: 'imessage' });
    const err = validateInstanceConfig(raw, ctx());
    expect(err?.field).toBe('imessageConfig');
    expect(err?.message).toBe('imessageConfig is required when transport is "imessage"');
  });

  it('is rejected as inconsistent on non-imessage transports', () => {
    const raw = baseRaw({ transport: 'twilio', twilioConfig: validTwilioConfig(), imessageConfig: validImessageConfig() });
    const err = validateInstanceConfig(raw, ctx());
    expect(err?.field).toBe('imessageConfig');
    expect(err?.message).toMatch(/imessageConfig is inconsistent with transport/);
  });

  it('accepts a valid bluebubbles config', () => {
    const raw = baseRaw({ transport: 'imessage', imessageConfig: validImessageConfig() });
    expect(validateInstanceConfig(raw, ctx())).toBeNull();
  });

  it('accepts a valid imsg config (socket path optional)', () => {
    const raw = baseRaw({
      transport: 'imessage',
      imessageConfig: validImessageConfig({
        backend: 'imsg',
        bluebubblesUrl: undefined,
        bluebubblesPasswordService: undefined,
        sender: '+15551110000',
      }),
    });
    expect(validateInstanceConfig(raw, ctx())).toBeNull();
  });

  it('rejects an unknown backend', () => {
    const raw = baseRaw({ transport: 'imessage', imessageConfig: validImessageConfig({ backend: 'icloud' }) });
    const err = validateInstanceConfig(raw, ctx());
    expect(err?.field).toBe('imessageConfig.backend');
    expect(err?.message).toBe("imessageConfig.backend must be 'imsg' or 'bluebubbles'");
  });

  it('requires bluebubblesUrl when backend is bluebubbles', () => {
    const raw = baseRaw({ transport: 'imessage', imessageConfig: validImessageConfig({ bluebubblesUrl: '' }) });
    expect(validateInstanceConfig(raw, ctx())?.field).toBe('imessageConfig.bluebubblesUrl');
  });

  it('rejects a non-URL bluebubblesUrl', () => {
    const raw = baseRaw({ transport: 'imessage', imessageConfig: validImessageConfig({ bluebubblesUrl: 'not-a-url' }) });
    expect(validateInstanceConfig(raw, ctx())?.field).toBe('imessageConfig.bluebubblesUrl');
  });

  it('requires bluebubblesPasswordService when backend is bluebubbles', () => {
    const raw = baseRaw({ transport: 'imessage', imessageConfig: validImessageConfig({ bluebubblesPasswordService: '' }) });
    expect(validateInstanceConfig(raw, ctx())?.field).toBe('imessageConfig.bluebubblesPasswordService');
  });

  it('rejects a relative imsgSocketPath', () => {
    const raw = baseRaw({
      transport: 'imessage',
      imessageConfig: validImessageConfig({ backend: 'imsg', imsgSocketPath: 'tmp/imsg.sock', bluebubblesUrl: undefined, bluebubblesPasswordService: undefined }),
    });
    expect(validateInstanceConfig(raw, ctx())?.field).toBe('imessageConfig.imsgSocketPath');
  });

  it('rejects a bad sender (not AppleID email or E.164)', () => {
    const raw = baseRaw({ transport: 'imessage', imessageConfig: validImessageConfig({ sender: 'not-a-sender' }) });
    expect(validateInstanceConfig(raw, ctx())?.field).toBe('imessageConfig.sender');
  });

  it('rejects webhook inboundMode on the imsg backend', () => {
    const raw = baseRaw({
      transport: 'imessage',
      imessageConfig: validImessageConfig({ backend: 'imsg', inboundMode: 'webhook', bluebubblesUrl: undefined, bluebubblesPasswordService: undefined }),
    });
    const err = validateInstanceConfig(raw, ctx());
    expect(err?.field).toBe('imessageConfig.inboundMode');
    expect(err?.message).toMatch(/only supported with backend 'bluebubbles'/);
  });

  it('rejects an unknown inboundMode', () => {
    const raw = baseRaw({ transport: 'imessage', imessageConfig: validImessageConfig({ inboundMode: 'stream' }) });
    expect(validateInstanceConfig(raw, ctx())?.field).toBe('imessageConfig.inboundMode');
  });

  it('rejects a non-positive pollIntervalMs', () => {
    const raw = baseRaw({ transport: 'imessage', imessageConfig: validImessageConfig({ pollIntervalMs: -5 }) });
    expect(validateInstanceConfig(raw, ctx())?.field).toBe('imessageConfig.pollIntervalMs');
  });

  it('rejects a non-positive rateLimit.messagesPerMinute', () => {
    const raw = baseRaw({ transport: 'imessage', imessageConfig: validImessageConfig({ rateLimit: { messagesPerMinute: 0 } }) });
    expect(validateInstanceConfig(raw, ctx())?.field).toBe('imessageConfig.rateLimit.messagesPerMinute');
  });
});
