/**
 * Direct unit coverage for src/core/agent-config-validator.ts.
 *
 * Indirect coverage exists via tests/fleet/ops-config-patch-validation.test.ts
 * (route-level assertions). This file exercises the validator's branches directly
 * across the 4 modes (create/patch/load/discovery) and the type-specific rules
 * (chat/agent/passive) and cross-field constraints (sessionScope/accessMode).
 */
import { describe, expect, it } from 'vitest';
import {
  VALID_TYPES,
  VALID_ACCESS_MODES,
  VALID_SESSION_SCOPES,
  validateInstanceConfig,
  type ValidatorContext,
} from '../../src/core/agent-config-validator.ts';
import * as validator from '../../src/core/agent-config-validator.ts';

const baseAgent = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'alpha',
  type: 'agent',
  accessMode: 'self_only',
  adminPhones: ['15551234567'],
  agentOptions: { sessionScope: 'single' },
  ...overrides,
});

const baseChat = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'alpha',
  type: 'chat',
  accessMode: 'allowlist',
  adminPhones: ['15551234567'],
  systemPrompt: 'You are helpful.',
  ...overrides,
});

const basePassive = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'alpha',
  type: 'passive',
  accessMode: 'self_only',
  adminPhones: ['15551234567'],
  ...overrides,
});

const ctx = (mode: ValidatorContext['mode'], over: Partial<ValidatorContext> = {}): ValidatorContext => ({
  name: 'alpha',
  mode,
  ...over,
});

describe('VALID_* sets', () => {
  it('exports the canonical type/accessMode/sessionScope sets', () => {
    expect(VALID_TYPES.has('chat')).toBe(true);
    expect(VALID_TYPES.has('agent')).toBe(true);
    expect(VALID_TYPES.has('passive')).toBe(true);
    expect(VALID_TYPES.size).toBe(3);
    expect(VALID_ACCESS_MODES.has('self_only')).toBe(true);
    expect(VALID_ACCESS_MODES.has('allowlist')).toBe(true);
    expect(VALID_ACCESS_MODES.has('open_dm')).toBe(true);
    expect(VALID_ACCESS_MODES.has('groups_only')).toBe(true);
    expect(VALID_ACCESS_MODES.size).toBe(4);
    expect(VALID_SESSION_SCOPES.has('single')).toBe(true);
    expect(VALID_SESSION_SCOPES.has('shared')).toBe(true);
    expect(VALID_SESSION_SCOPES.has('per_chat')).toBe(true);
    expect(VALID_SESSION_SCOPES.size).toBe(3);
  });

  it('derives the valid access mode set from an exported ordered registry', () => {
    expect(validator).toHaveProperty('ACCESS_MODES');
    expect(validator.ACCESS_MODES).toEqual(['self_only', 'allowlist', 'open_dm', 'groups_only']);
    expect([...VALID_ACCESS_MODES]).toEqual(validator.ACCESS_MODES);
  });
});

describe('load-mode required fields', () => {
  it('flags missing name on load', () => {
    const result = validateInstanceConfig({ type: 'chat', accessMode: 'allowlist' }, ctx('load'));
    expect(result?.field).toBe('name');
    expect(result?.message).toContain('Missing required field "name"');
  });

  it('flags missing type on load', () => {
    const result = validateInstanceConfig({ name: 'alpha', accessMode: 'allowlist' }, ctx('load'));
    expect(result?.field).toBe('type');
    expect(result?.message).toContain('Missing required field "type"');
  });

  it('flags missing accessMode on load', () => {
    const result = validateInstanceConfig({ name: 'alpha', type: 'chat' }, ctx('load'));
    expect(result?.field).toBe('accessMode');
    expect(result?.message).toContain('Missing required field "accessMode"');
  });

  it('flags name mismatch between context and raw on load', () => {
    const raw = baseChat({ name: 'beta' });
    const result = validateInstanceConfig(raw, ctx('load'));
    expect(result?.field).toBe('name');
    expect(result?.message).toContain('expected "alpha"');
    expect(result?.message).toContain('"beta"');
  });
});

describe('name + type immutability on patch', () => {
  it('rejects name change via patch', () => {
    const raw = baseAgent({ name: 'beta' });
    const result = validateInstanceConfig(raw, ctx('patch'));
    expect(result?.field).toBe('name');
    expect(result?.message).toContain('immutable');
  });

  it('rejects type change via patch when originalType differs', () => {
    const raw = baseAgent({ type: 'chat' });
    const result = validateInstanceConfig(raw, ctx('patch', { originalType: 'agent' }));
    expect(result?.field).toBe('type');
    expect(result?.message).toContain('immutable');
  });

  it('accepts type unchanged on patch when originalType matches', () => {
    const raw = baseAgent({ type: 'agent', systemPrompt: 'You are helpful.' });
    const result = validateInstanceConfig(raw, ctx('patch', { originalType: 'agent' }));
    expect(result).toBeNull();
    expect(validateInstanceConfig(raw, ctx('patch', { originalType: 'chat' }))?.field).toBe('type');
  });
});

describe('enum validation', () => {
  it('rejects invalid type on create with create-format message', () => {
    const raw = baseAgent({ type: 'bogus' });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('type');
    expect(result?.message).toContain('must be one of');
  });

  it('rejects invalid type on load with load-format message', () => {
    const raw = baseAgent({ type: 'bogus' });
    const result = validateInstanceConfig(raw, ctx('load'));
    expect(result?.field).toBe('type');
    expect(result?.message).toContain('Invalid type');
  });

  it('rejects invalid accessMode on create', () => {
    const raw = baseAgent({ accessMode: 'public' });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('accessMode');
    expect(result?.message).toContain('must be one of');
  });

  it('rejects invalid accessMode on load with load-format message', () => {
    const raw = baseAgent({ accessMode: 'public' });
    const result = validateInstanceConfig(raw, ctx('load'));
    expect(result?.field).toBe('accessMode');
    expect(result?.message).toContain('Invalid accessMode');
  });
});

describe('healthPort validation', () => {
  it('rejects non-integer healthPort', () => {
    const raw = baseAgent({ healthPort: 8080.5 });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('healthPort');
    expect(result?.message).toContain('integer');
  });

  it('rejects healthPort below 1024', () => {
    const raw = baseAgent({ healthPort: 80 });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('healthPort');
    expect(result?.message).toContain('between 1024 and 65535');
  });

  it('rejects healthPort above 65535', () => {
    const raw = baseAgent({ healthPort: 70000 });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('healthPort');
    expect(result?.message).toContain('between 1024 and 65535');
  });

  it('accepts healthPort at 1024 boundary', () => {
    const raw = baseAgent({ healthPort: 1024 });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result).toBeNull();
    expect(validateInstanceConfig(baseAgent({ healthPort: 1023 }), ctx('create'))?.field).toBe(
      'healthPort',
    );
  });

  it('accepts healthPort at 65535 boundary', () => {
    const raw = baseAgent({ healthPort: 65535 });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result).toBeNull();
    expect(validateInstanceConfig(baseAgent({ healthPort: 65536 }), ctx('create'))?.field).toBe(
      'healthPort',
    );
  });

  it('flags healthPort duplicate with 409 status on create', () => {
    const raw = baseAgent({ healthPort: 9001 });
    const existing = new Map([['beta', 9001]]);
    const result = validateInstanceConfig(raw, ctx('create', { existingHealthPorts: existing }));
    expect(result?.field).toBe('healthPort');
    expect(result?.status).toBe(409);
    expect(result?.message).toContain('already in use');
  });

  it('does not flag duplicate when the entry belongs to the same instance (self-exclusion)', () => {
    const raw = baseAgent({ healthPort: 9001 });
    const existing = new Map([['alpha', 9001]]);
    const result = validateInstanceConfig(raw, ctx('create', { existingHealthPorts: existing }));
    expect(result).toBeNull();
    expect(
      validateInstanceConfig(raw, ctx('create', { existingHealthPorts: new Map([['beta', 9001]]) }))
        ?.status,
    ).toBe(409);
  });
});

describe('adminPhones validation', () => {
  it('rejects empty adminPhones array on create', () => {
    const raw = baseAgent({ adminPhones: [] });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('adminPhones');
    expect(result?.message).toContain('non-empty array');
  });

  it('rejects non-string adminPhones entries on create', () => {
    const raw = baseAgent({ adminPhones: [123] });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('adminPhones');
    expect(result?.message).toContain('non-empty array of strings');
  });

  it('rejects blank-string adminPhones entries on load with instance-path-flavored message', () => {
    const raw = baseAgent({ adminPhones: ['   '] });
    const result = validateInstanceConfig(raw, ctx('load'));
    expect(result?.field).toBe('adminPhones');
    expect(result?.message).toContain('alpha');
  });
});

describe('chatAliases validation', () => {
  it('rejects non-object chatAliases', () => {
    const raw = baseChat({ chatAliases: ['not an object'] });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('chatAliases');
    expect(result?.message).toContain('alias -> chatJid');
  });

  it('rejects duplicate aliases after trimming', () => {
    const raw = baseChat({ chatAliases: { foo: 'jid1@s.whatsapp.net', ' foo': 'jid2@s.whatsapp.net' } });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('chatAliases');
    expect(result?.message).toContain('duplicate alias');
  });

  it('rejects empty alias key', () => {
    const raw = baseChat({ chatAliases: { '   ': 'jid@s.whatsapp.net' } });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('chatAliases');
    expect(result?.message).toContain('non-empty alias');
  });
});

describe('claudeMd size cap', () => {
  it('rejects claudeMd over 32KB on create', () => {
    const raw = baseAgent({ claudeMd: 'A'.repeat(32_769) });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('claudeMd');
    expect(result?.message).toContain('32KB');
  });

  it('accepts claudeMd exactly at 32KB on create', () => {
    const raw = baseAgent({ claudeMd: 'A'.repeat(32_768) });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result).toBeNull();
    expect(
      validateInstanceConfig(baseAgent({ claudeMd: 'A'.repeat(32_769) }), ctx('create'))?.field,
    ).toBe('claudeMd');
  });
});

describe('numeric bounds', () => {
  it('rejects rateLimitPerHour below 1', () => {
    const raw = baseAgent({ rateLimitPerHour: 0 });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('rateLimitPerHour');
    expect(result?.message).toContain('between 1 and 10,000');
  });

  it('rejects rateLimitPerHour above 10000', () => {
    const raw = baseAgent({ rateLimitPerHour: 10001 });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('rateLimitPerHour');
    expect(result?.message).toContain('between 1 and 10,000');
  });

  it('rejects maxTokens below 256', () => {
    const raw = baseAgent({ maxTokens: 100 });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('maxTokens');
    expect(result?.message).toContain('between 256 and 200,000');
  });

  it('rejects tokenBudget below 1000', () => {
    const raw = baseAgent({ tokenBudget: 500 });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('tokenBudget');
    expect(result?.message).toContain('between 1,000 and 10,000,000');
  });
});

describe('authOnly mode short-circuits type rules', () => {
  it('does not enforce passive systemPrompt rule when authOnly=true', () => {
    const raw = basePassive({ systemPrompt: 'should be rejected normally' });
    const result = validateInstanceConfig(raw, ctx('load', { authOnly: true }));
    expect(result).toBeNull();
    expect(validateInstanceConfig(raw, ctx('load'))?.field).toBe('systemPrompt');
  });
});

describe('chat type rules', () => {
  it('requires systemPrompt for chat on load', () => {
    const raw = baseChat({ systemPrompt: '' });
    const result = validateInstanceConfig(raw, ctx('load'));
    expect(result?.field).toBe('systemPrompt');
    expect(result?.message).toContain('non-empty systemPrompt');
  });

  it('allows chat without systemPrompt on create (deferred)', () => {
    const raw = baseChat({ systemPrompt: undefined });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result).toBeNull();
    expect(validateInstanceConfig(raw, ctx('load'))?.field).toBe('systemPrompt');
  });
});

describe('passive type rules', () => {
  it('rejects systemPrompt on passive instance (create)', () => {
    const raw = basePassive({ systemPrompt: 'not allowed' });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('systemPrompt');
    expect(result?.message).toContain('passive');
  });

  it('rejects non-self_only accessMode on passive', () => {
    const raw = basePassive({ accessMode: 'allowlist' });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('accessMode');
    expect(result?.message).toContain('self_only');
  });

  it('accepts minimal valid passive instance', () => {
    const raw = basePassive();
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result).toBeNull();
    expect(
      validateInstanceConfig(basePassive({ accessMode: 'allowlist' }), ctx('create'))?.field,
    ).toBe('accessMode');
  });
});

describe('agent type rules', () => {
  it('requires self_only accessMode when agentOptions is absent', () => {
    const raw = { ...baseAgent(), accessMode: 'allowlist', agentOptions: undefined };
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('accessMode');
    expect(result?.message).toContain('self_only');
  });

  it('rejects non-object agentOptions', () => {
    const raw = { ...baseAgent(), agentOptions: 'oops' };
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('agentOptions');
    expect(result?.message).toContain('must be an object');
  });

  it('rejects invalid sessionScope on create with literal message', () => {
    const raw = baseAgent({ agentOptions: { sessionScope: 'bogus' } });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('agentOptions.sessionScope');
    expect(result?.message).toContain('single, shared, or per_chat');
  });

  it('requires sessionScope on load', () => {
    const raw = baseAgent({ agentOptions: {} });
    const result = validateInstanceConfig(raw, ctx('load'));
    expect(result?.field).toBe('agentOptions.sessionScope');
    expect(result?.message).toContain('required and must be one of');
  });

  it('rejects sandboxPerChat without per_chat sessionScope', () => {
    const raw = baseAgent({
      agentOptions: { sessionScope: 'single', sandboxPerChat: true },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('agentOptions.sandboxPerChat');
    expect(result?.message).toContain('per_chat');
  });

  it('accepts sandboxPerChat with per_chat sessionScope', () => {
    const raw = baseAgent({
      accessMode: 'allowlist',
      agentOptions: { sessionScope: 'per_chat', sandboxPerChat: true },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result).toBeNull();
    expect(
      validateInstanceConfig(
        baseAgent({ agentOptions: { sessionScope: 'single', sandboxPerChat: true } }),
        ctx('create'),
      )?.field,
    ).toBe('agentOptions.sandboxPerChat');
  });

  it('cross-field: sessionScope single requires self_only on create', () => {
    const raw = baseAgent({
      accessMode: 'allowlist',
      agentOptions: { sessionScope: 'single' },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('accessMode');
    expect(result?.message).toContain('self_only');
  });

  it('rejects provider outside canonical provider IDs', () => {
    const raw = baseAgent({
      agentOptions: { sessionScope: 'single', provider: '   ' },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result).toMatchObject({
      field: 'agentOptions.provider',
      status: 400,
    });
    expect(result?.message).toContain('must be one of');
    expect(result?.message).toContain('claude-cli');
    expect(result?.message).toContain('codex-cli');
    expect(result?.message).toContain('openai-api');
  });

  it('rejects non-object providerConfig', () => {
    const raw = baseAgent({
      agentOptions: { sessionScope: 'single', providerConfig: ['array'] },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('agentOptions.providerConfig');
    expect(result?.message).toContain('must be an object');
  });

  it('rejects non-object providerConfig.budget', () => {
    const raw = baseAgent({
      agentOptions: { sessionScope: 'single', providerConfig: { budget: 'nope' } },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('agentOptions.providerConfig.budget');
    expect(result?.message).toContain('must be an object');
  });

  it('rejects non-array pluginDirs', () => {
    const raw = baseAgent({
      agentOptions: { sessionScope: 'single', pluginDirs: 'oops' },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('agentOptions.pluginDirs');
    expect(result?.message).toContain('array of strings');
  });

  it('rejects pluginDirs with non-string entry', () => {
    const raw = baseAgent({
      agentOptions: { sessionScope: 'single', pluginDirs: ['/home/q', 42] },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('agentOptions.pluginDirs');
    expect(result?.message).toContain('array of strings');
  });

  it('rejects non-string cwd', () => {
    const raw = baseAgent({
      agentOptions: { sessionScope: 'single', cwd: 123 },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('agentOptions.cwd');
    expect(result?.message).toContain('must be a string');
  });

  it('rejects non-string instructionsPath', () => {
    const raw = baseAgent({
      agentOptions: { sessionScope: 'single', instructionsPath: { not: 'a string' } },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('agentOptions.instructionsPath');
    expect(result?.message).toContain('must be a string');
  });

  it('accepts minimal valid agent on create', () => {
    const raw = baseAgent();
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result).toBeNull();
    expect(
      validateInstanceConfig(
        { ...baseAgent(), accessMode: 'allowlist', agentOptions: undefined },
        ctx('create'),
      )?.field,
    ).toBe('accessMode');
  });
});
