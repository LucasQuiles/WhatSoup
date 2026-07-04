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

describe('Pinecone project guard validation', () => {
  it('rejects explicit Pinecone config on non-q create without a project guard', () => {
    const raw = baseChat({
      memory: { pinecone: { apiKeyEnv: 'PINECONE_MINI3_KEY', index: 'whatsapp-bot' } },
    });

    const result = validateInstanceConfig(raw, ctx('create'));

    expect(result?.field).toBe('memory.pinecone.projectId');
    expect(result?.message).toContain('non-q instances with Pinecone config');
  });

  it('rejects explicit Pinecone config on non-q patch without a project guard', () => {
    const raw = baseChat({
      memory: { pinecone: { apiKeyEnv: 'PINECONE_MINI3_KEY', index: 'whatsapp-bot' } },
    });

    const result = validateInstanceConfig(raw, ctx('patch', { originalType: 'chat' }));

    expect(result?.field).toBe('memory.pinecone.projectId');
    expect(result?.message).toContain('non-q instances with Pinecone config');
  });

  it('does not reject existing non-q load or discovery configs without a project guard', () => {
    const raw = baseChat({
      memory: { pinecone: { apiKeyEnv: 'PINECONE_MINI3_KEY', index: 'whatsapp-bot' } },
    });

    expect(validateInstanceConfig(raw, ctx('load'))).toBeNull();
    expect(validateInstanceConfig(raw, ctx('discovery'))).toBeNull();
  });

  it('accepts explicit Pinecone config on q without a project guard', () => {
    const raw = baseChat({
      name: 'q',
      memory: { pinecone: { apiKeyEnv: 'PINECONE_API_KEY', index: 'whatsapp-bot' } },
    });

    expect(validateInstanceConfig(raw, ctx('create', { name: 'q' }))).toBeNull();
  });

  it('accepts canonical and legacy Pinecone project guards on non-q instances', () => {
    const canonical = baseChat({
      memory: {
        pinecone: {
          apiKeyEnv: 'PINECONE_MINI3_KEY',
          index: 'whatsapp-bot',
          expectedHostSuffix: '-zz9hg2d.svc.aped-4627-b74a.pinecone.io',
        },
      },
    });
    const legacy = baseChat({
      pineconeApiKeyEnv: 'PINECONE_MINI8_KEY',
      pineconeIndex: 'whatsapp-bot',
      pineconeProjectId: 'kdqp9y0',
    });

    expect(validateInstanceConfig(canonical, ctx('create'))).toBeNull();
    expect(validateInstanceConfig(legacy, ctx('create'))).toBeNull();
  });

  it('rejects less common Pinecone aliases on non-q instances without a project guard', () => {
    const legacyNamespaceAlias = baseChat({
      pineconeLocalDocsNamespace: 'local-docs',
    });
    const canonicalTuning = baseChat({
      memory: { pinecone: { topK: 8 } },
    });

    expect(validateInstanceConfig(legacyNamespaceAlias, ctx('create'))?.field).toBe(
      'memory.pinecone.projectId',
    );
    expect(validateInstanceConfig(canonicalTuning, ctx('create'))?.field).toBe(
      'memory.pinecone.projectId',
    );
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
  it('accepts agent without agentOptions on any accessMode (AE1-AE4 protections live)', () => {
    const raw = { ...baseAgent(), accessMode: 'allowlist', agentOptions: undefined };
    expect(validateInstanceConfig(raw, ctx('create'))).toBeNull();
    expect(
      validateInstanceConfig(
        { ...baseAgent(), accessMode: 'open_dm', agentOptions: undefined },
        ctx('create'),
      ),
    ).toBeNull();
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

  it('accepts missing sessionScope on load/discovery (runtime parity: AgentRuntime defaults to "single")', () => {
    // Inverted from the original required-on-load rule: the agent runtime
    // constructor defaults a missing sessionScope to 'single'
    // (src/runtimes/agent/runtime.ts — `options?.sessionScope ?? (options?.shared
    // ? 'shared' : 'single')`), so a config the runtime boots happily must not
    // surface config_error at load or discovery time.
    const raw = baseAgent({ agentOptions: {} });
    expect(validateInstanceConfig(raw, ctx('load'))).toBeNull();
    expect(validateInstanceConfig(raw, ctx('discovery'))).toBeNull();
    // Control: an invalid VALUE is still rejected on load — only absence is allowed.
    const bad = baseAgent({ agentOptions: { sessionScope: 'bogus' } });
    expect(validateInstanceConfig(bad, ctx('load'))?.field).toBe('agentOptions.sessionScope');
  });

  it('rejects invalid sessionScope value on load/discovery', () => {
    const raw = baseAgent({ agentOptions: { sessionScope: 'global' } });
    for (const mode of ['load', 'discovery'] as const) {
      const result = validateInstanceConfig(raw, ctx(mode));
      expect(result?.field).toBe('agentOptions.sessionScope');
      expect(result?.message).toContain('single, shared, or per_chat');
    }
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

  it('accepts agent + sessionScope=single + non-self_only accessModes (AE1-AE4 protections live)', () => {
    for (const accessMode of ['allowlist', 'open_dm', 'groups_only', 'self_only']) {
      const raw = baseAgent({
        accessMode,
        agentOptions: { sessionScope: 'single' },
      });
      expect(validateInstanceConfig(raw, ctx('create'))).toBeNull();
      expect(validateInstanceConfig(raw, ctx('patch'))).toBeNull();
      expect(validateInstanceConfig(raw, ctx('load'))).toBeNull();
    }
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

  it('accepts minimal valid agent on create (any accessMode with or without agentOptions)', () => {
    const raw = baseAgent();
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result).toBeNull();
    expect(
      validateInstanceConfig(
        { ...baseAgent(), accessMode: 'allowlist', agentOptions: undefined },
        ctx('create'),
      ),
    ).toBeNull();
  });
});

describe('agent-config-validator.ts uncovered-branch coverage', () => {
  // ---- validateAgentModelConsistency (lines 176-195) ----
  it('rejects top-level model that disagrees with models.conversation', () => {
    const raw = baseAgent({ model: 'claude-sonnet-4', models: { conversation: 'gpt-4o' } });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result).toMatchObject({ field: 'model', status: 400 });
    expect(result?.message).toContain('must match when both are set');
  });

  it('passes model-consistency when only models.conversation is set (non-string models ignored)', () => {
    const raw = baseAgent({ models: 'not-an-object' });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result).toStrictEqual(null);
  });

  // ---- agentOptions.autoCompactInputTokens (lines 453-467) ----
  it('rejects autoCompactInputTokens below the 50,000 floor', () => {
    const raw = baseAgent({ agentOptions: { sessionScope: 'single', autoCompactInputTokens: 1000 } });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result).toMatchObject({ field: 'agentOptions.autoCompactInputTokens', status: 400 });
    expect(result?.message).toContain('between 50,000 and 100,000,000');
  });

  it('rejects non-integer autoCompactInputTokens', () => {
    const raw = baseAgent({
      agentOptions: { sessionScope: 'single', autoCompactInputTokens: 60000.5 },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('agentOptions.autoCompactInputTokens');
  });

  it('accepts in-range integer autoCompactInputTokens', () => {
    const raw = baseAgent({
      agentOptions: { sessionScope: 'single', autoCompactInputTokens: 60000 },
    });
    expect(validateInstanceConfig(raw, ctx('create'))).toBeNull();
  });

  // ---- agentOptions.allowM365Mutations non-boolean (lines 443-451) ----
  it('rejects non-boolean allowM365Mutations', () => {
    const raw = baseAgent({ agentOptions: { sessionScope: 'single', allowM365Mutations: 'yes' } });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result).toMatchObject({
      field: 'agentOptions.allowM365Mutations',
      status: 400,
    });
    expect(result?.message).toContain('must be a boolean when provided');
  });

  // ---- agentOptions.fallbacks[] (lines 484-537) ----
  it('rejects fallbacks combined with fallbackProvider', () => {
    const raw = baseAgent({
      agentOptions: {
        sessionScope: 'single',
        fallbacks: [{ provider: 'openai-api', model: 'gpt-4o' }],
        fallbackProvider: 'openai-api',
      },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('agentOptions.fallbacks');
    expect(result?.message).toContain('cannot be combined');
  });

  it('rejects non-array fallbacks', () => {
    const raw = baseAgent({ agentOptions: { sessionScope: 'single', fallbacks: 'nope' } });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result).toMatchObject({ field: 'agentOptions.fallbacks', status: 400 });
    expect(result?.message).toContain('must be an array when provided');
  });

  it('rejects fallbacks arrays exceeding 8 entries', () => {
    const raw = baseAgent({
      agentOptions: {
        sessionScope: 'single',
        fallbacks: Array.from({ length: 9 }, () => ({ provider: 'openai-api', model: 'gpt-4o' })),
      },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('agentOptions.fallbacks');
    expect(result?.message).toContain('at most 8 entries');
  });

  it('rejects a non-record fallback entry', () => {
    const raw = baseAgent({
      agentOptions: { sessionScope: 'single', fallbacks: ['not-an-object'] },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('agentOptions.fallbacks[0]');
    expect(result?.message).toContain('must be an object');
  });

  it('rejects a fallback entry with an unknown provider', () => {
    const raw = baseAgent({
      agentOptions: { sessionScope: 'single', fallbacks: [{ provider: 'nope' }] },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('agentOptions.fallbacks[0].provider');
    expect(result?.message).toContain('must be one of');
  });

  it('rejects a fallback entry with an empty-string model', () => {
    const raw = baseAgent({
      agentOptions: {
        sessionScope: 'single',
        fallbacks: [{ provider: 'claude-cli', model: '   ' }],
      },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('agentOptions.fallbacks[0].model');
    expect(result?.message).toContain('non-empty string when provided');
  });

  it('rejects an API-provider fallback entry that omits model', () => {
    const raw = baseAgent({
      agentOptions: { sessionScope: 'single', fallbacks: [{ provider: 'openai-api' }] },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('agentOptions.fallbacks[0].model');
    expect(result?.message).toContain('requires model to be set');
  });

  it('rejects a fallback entry duplicating an earlier entry', () => {
    const raw = baseAgent({
      agentOptions: {
        sessionScope: 'single',
        fallbacks: [
          { provider: 'claude-cli', model: 'sonnet' },
          { provider: 'claude-cli', model: 'sonnet' },
        ],
      },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('agentOptions.fallbacks[1]');
    expect(result?.message).toContain('duplicates an earlier fallback entry');
  });

  it('rejects a fallback entry that matches the primary provider/model pair', () => {
    const raw = baseAgent({
      model: 'claude-sonnet-4',
      agentOptions: {
        sessionScope: 'single',
        provider: 'claude-cli',
        fallbacks: [{ provider: 'claude-cli', model: 'claude-sonnet-4' }],
      },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('agentOptions.fallbacks[0]');
    expect(result?.message).toContain('matches the primary provider/model pair');
  });

  it('accepts a well-formed distinct fallback chain', () => {
    const raw = baseAgent({
      model: 'claude-sonnet-4',
      agentOptions: {
        sessionScope: 'single',
        provider: 'claude-cli',
        fallbacks: [{ provider: 'openai-api', model: 'gpt-4o' }],
      },
    });
    expect(validateInstanceConfig(raw, ctx('create'))).toBeNull();
  });

  // ---- fallbackProvider / fallbackModel cross-field (lines 542-582) ----
  it('rejects unknown fallbackProvider', () => {
    const raw = baseAgent({
      agentOptions: { sessionScope: 'single', fallbackProvider: 'unknown-cli' },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('agentOptions.fallbackProvider');
    expect(result?.message).toContain('must be one of');
  });

  it('rejects blank-string fallbackModel', () => {
    const raw = baseAgent({
      agentOptions: { sessionScope: 'single', fallbackModel: '  ' },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('agentOptions.fallbackModel');
    expect(result?.message).toContain('non-empty string');
  });

  it('rejects API fallbackProvider without a fallbackModel', () => {
    const raw = baseAgent({
      agentOptions: { sessionScope: 'single', fallbackProvider: 'openai-api' },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('agentOptions.fallbackModel');
    expect(result?.message).toContain('requires agentOptions.fallbackModel to be set');
  });

  // ---- providerConfig.baseUrl + apiKeyService (lines 614-675) ----
  it('rejects non-string providerConfig.baseUrl', () => {
    const raw = baseAgent({
      agentOptions: { sessionScope: 'single', providerConfig: { baseUrl: 123 } },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('agentOptions.providerConfig.baseUrl');
    expect(result?.message).toContain('non-empty string');
  });

  it('rejects unparseable providerConfig.baseUrl', () => {
    const raw = baseAgent({
      agentOptions: { sessionScope: 'single', providerConfig: { baseUrl: 'not a url' } },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('agentOptions.providerConfig.baseUrl');
    expect(result?.message).toContain('must be a valid URL');
  });

  it('rejects non-http(s) providerConfig.baseUrl', () => {
    const raw = baseAgent({
      agentOptions: { sessionScope: 'single', providerConfig: { baseUrl: 'ftp://host.example' } },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('agentOptions.providerConfig.baseUrl');
    expect(result?.message).toContain('http or https');
  });

  it('rejects opencode-cli baseUrl without any configured model', () => {
    const raw = baseAgent({
      agentOptions: {
        sessionScope: 'single',
        provider: 'opencode-cli',
        providerConfig: { baseUrl: 'https://host.example' },
      },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('agentOptions.providerConfig.baseUrl');
    expect(result?.message).toContain('no model is configured');
  });

  it('rejects non-string providerConfig.apiKeyService', () => {
    const raw = baseAgent({
      agentOptions: { sessionScope: 'single', providerConfig: { apiKeyService: 5 } },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('agentOptions.providerConfig.apiKeyService');
    expect(result?.message).toContain('non-empty string');
  });

  it('rejects unknown providerConfig.apiKeyService', () => {
    const raw = baseAgent({
      agentOptions: { sessionScope: 'single', providerConfig: { apiKeyService: 'nope-svc' } },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('agentOptions.providerConfig.apiKeyService');
    expect(result?.message).toContain('not a known keyring service');
  });

  it('rejects providerConfig.apiKeyService set without baseUrl', () => {
    const raw = baseAgent({
      agentOptions: {
        sessionScope: 'single',
        providerConfig: { apiKeyService: 'openai' },
      },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('agentOptions.providerConfig.apiKeyService');
    expect(result?.message).toContain('baseUrl is not');
  });

  // ---- validateTransportConfig (lines 685-725) ----
  it('rejects unknown transport id', () => {
    const raw = baseChat({ transport: 'carrier-pigeon' });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result).toMatchObject({ field: 'transport', status: 400 });
    expect(result?.message).toContain('must be one of: baileys, twilio');
    expect(result?.message).toContain('"carrier-pigeon"');
  });

  it('rejects twilioConfig present alongside default (baileys) transport', () => {
    const raw = baseChat({ twilioConfig: { account: 'acme' } });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('twilioConfig');
    expect(result?.message).toContain('inconsistent with transport "baileys"');
  });

  it('rejects twilio transport without a twilioConfig object', () => {
    const raw = baseChat({ transport: 'twilio' });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result).toMatchObject({ field: 'twilioConfig', status: 400 });
    expect(result?.message).toContain('required when transport is "twilio"');
  });

  it('rejects non-object twilioConfig on twilio transport', () => {
    const raw = baseChat({ transport: 'twilio', twilioConfig: ['array'] });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('twilioConfig');
    expect(result?.message).toContain('must be an object');
  });

  // Helper: a fully valid twilioConfig (messagingServiceSid sender).
  const validTwilio = () => ({
    account: 'acme',
    accountSid: 'AC' + '0'.repeat(32),
    authTokenService: 'twilio-auth-token',
    messagingServiceSid: 'MG' + '0'.repeat(32),
  });

  it('accepts a minimal valid twilio transport config', () => {
    const raw = baseChat({ transport: 'twilio', twilioConfig: validTwilio() });
    expect(validateInstanceConfig(raw, ctx('create'))).toBeNull();
  });

  // ---- validateTwilioConfig field rules (lines 727-965) ----
  it('rejects twilioConfig.account that fails ACCOUNT_RE', () => {
    const raw = baseChat({
      transport: 'twilio',
      twilioConfig: { ...validTwilio(), account: 'UPPER' },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('twilioConfig.account');
  });

  it('rejects twilioConfig.accountSid not matching AC + 32 hex', () => {
    const raw = baseChat({
      transport: 'twilio',
      twilioConfig: { ...validTwilio(), accountSid: 'ACdeadbeef' },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('twilioConfig.accountSid');
  });

  it('rejects twilioConfig.authTokenService with whitespace', () => {
    const raw = baseChat({
      transport: 'twilio',
      twilioConfig: { ...validTwilio(), authTokenService: 'has space' },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('twilioConfig.authTokenService');
  });

  it('rejects twilioConfig with both phoneNumber and messagingServiceSid', () => {
    const raw = baseChat({
      transport: 'twilio',
      twilioConfig: {
        ...validTwilio(),
        phoneNumber: '+15550000001',
      },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('twilioConfig.phoneNumber');
    expect(result?.message).toContain('not both');
  });

  it('rejects twilioConfig with neither phoneNumber nor messagingServiceSid', () => {
    const raw = baseChat({
      transport: 'twilio',
      twilioConfig: {
        account: 'acme',
        accountSid: 'AC' + '0'.repeat(32),
        authTokenService: 'twilio-auth-token',
      },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('twilioConfig.phoneNumber');
    expect(result?.message).toContain('exactly one of');
  });

  it('rejects twilioConfig.phoneNumber not matching E.164', () => {
    const raw = baseChat({
      transport: 'twilio',
      twilioConfig: {
        account: 'acme',
        accountSid: 'AC' + '0'.repeat(32),
        authTokenService: 'twilio-auth-token',
        phoneNumber: 'not-a-number',
      },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('twilioConfig.phoneNumber');
    expect(result?.message).toContain('E.164');
  });

  it('rejects twilioConfig.messagingServiceSid not matching MG + 32 hex', () => {
    const raw = baseChat({
      transport: 'twilio',
      twilioConfig: {
        account: 'acme',
        accountSid: 'AC' + '0'.repeat(32),
        authTokenService: 'twilio-auth-token',
        messagingServiceSid: 'MGshort',
      },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('twilioConfig.messagingServiceSid');
  });

  it('rejects twilioConfig.inboundMode other than poll/webhook', () => {
    const raw = baseChat({
      transport: 'twilio',
      twilioConfig: { ...validTwilio(), inboundMode: 'stream' },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('twilioConfig.inboundMode');
  });

  it('rejects webhook block set while inboundMode is poll (fail closed)', () => {
    const raw = baseChat({
      transport: 'twilio',
      twilioConfig: {
        ...validTwilio(),
        inboundMode: 'poll',
        webhook: { publicBaseUrl: 'https://host.example', listenPort: 8080 },
      },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('twilioConfig.webhook');
    expect(result?.message).toContain("must not be set when inboundMode is 'poll'");
  });

  it('rejects webhook mode with a non-https publicBaseUrl', () => {
    const raw = baseChat({
      transport: 'twilio',
      twilioConfig: {
        ...validTwilio(),
        inboundMode: 'webhook',
        webhook: { publicBaseUrl: 'http://host.example', listenPort: 8080 },
      },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('twilioConfig.webhook.publicBaseUrl');
    expect(result?.message).toContain('https://');
  });

  it('rejects webhook mode with out-of-range listenPort', () => {
    const raw = baseChat({
      transport: 'twilio',
      twilioConfig: {
        ...validTwilio(),
        inboundMode: 'webhook',
        webhook: { publicBaseUrl: 'https://host.example', listenPort: 99999 },
      },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('twilioConfig.webhook.listenPort');
  });

  it('rejects webhook listenPort that collides with healthPort', () => {
    const raw = baseChat({
      healthPort: 8080,
      transport: 'twilio',
      twilioConfig: {
        ...validTwilio(),
        inboundMode: 'webhook',
        webhook: { publicBaseUrl: 'https://host.example', listenPort: 8080 },
      },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('twilioConfig.webhook.listenPort');
    expect(result?.message).toContain('conflicts with healthPort');
  });

  it('rejects webhook listenAddress of the wrong type', () => {
    const raw = baseChat({
      transport: 'twilio',
      twilioConfig: {
        ...validTwilio(),
        inboundMode: 'webhook',
        webhook: { publicBaseUrl: 'https://host.example', listenPort: 8080, listenAddress: 5 },
      },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('twilioConfig.webhook.listenAddress');
  });

  it('rejects webhook block being a non-object', () => {
    const raw = baseChat({
      transport: 'twilio',
      twilioConfig: {
        ...validTwilio(),
        inboundMode: 'webhook',
        webhook: ['array'],
      },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('twilioConfig.webhook');
    expect(result?.message).toContain('must be an object');
  });

  it('rejects a non-object twilioConfig.voice block', () => {
    const raw = baseChat({
      transport: 'twilio',
      twilioConfig: { ...validTwilio(), voice: 'loud' },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('twilioConfig.voice');
  });

  it('rejects non-boolean twilioConfig.voice.enabled', () => {
    const raw = baseChat({
      transport: 'twilio',
      twilioConfig: { ...validTwilio(), voice: { enabled: 'yes' } },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('twilioConfig.voice.enabled');
  });

  it('rejects out-of-range twilioConfig.voice.voicemailMaxLengthSec', () => {
    const raw = baseChat({
      transport: 'twilio',
      twilioConfig: { ...validTwilio(), voice: { voicemailMaxLengthSec: 2 } },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('twilioConfig.voice.voicemailMaxLengthSec');
  });

  it('rejects over-long twilioConfig.voice.voicemailGreeting', () => {
    const raw = baseChat({
      transport: 'twilio',
      twilioConfig: { ...validTwilio(), voice: { voicemailGreeting: 'x'.repeat(501) } },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('twilioConfig.voice.voicemailGreeting');
  });

  it('rejects voice.enabled=true without webhook inboundMode', () => {
    const raw = baseChat({
      transport: 'twilio',
      twilioConfig: {
        account: 'acme',
        accountSid: 'AC' + '0'.repeat(32),
        authTokenService: 'twilio-auth-token',
        phoneNumber: '+15550000001',
        voice: { enabled: true },
      },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('twilioConfig.voice');
    expect(result?.message).toContain("inboundMode:'webhook'");
  });

  it('rejects voice.enabled=true on webhook config that lacks phoneNumber', () => {
    const raw = baseChat({
      transport: 'twilio',
      twilioConfig: {
        ...validTwilio(),
        inboundMode: 'webhook',
        webhook: { publicBaseUrl: 'https://host.example', listenPort: 8080 },
        voice: { enabled: true },
      },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('twilioConfig.voice');
    expect(result?.message).toContain('requires phoneNumber');
  });

  it('rejects out-of-range twilioConfig.pollIntervalMs', () => {
    const raw = baseChat({
      transport: 'twilio',
      twilioConfig: { ...validTwilio(), pollIntervalMs: 1000 },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('twilioConfig.pollIntervalMs');
  });

  it('rejects non-object twilioConfig.rateLimit', () => {
    const raw = baseChat({
      transport: 'twilio',
      twilioConfig: { ...validTwilio(), rateLimit: 'nope' },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('twilioConfig.rateLimit');
    expect(result?.message).toContain('must be an object');
  });

  it('rejects out-of-range twilioConfig.rateLimit.smsPerMinute', () => {
    const raw = baseChat({
      transport: 'twilio',
      twilioConfig: { ...validTwilio(), rateLimit: { smsPerMinute: 0 } },
    });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('twilioConfig.rateLimit.smsPerMinute');
  });

  it('accepts a full valid twilio transport with webhook inboundMode + phoneNumber', () => {
    const raw = baseChat({
      transport: 'twilio',
      twilioConfig: {
        account: 'acme',
        accountSid: 'AC' + '0'.repeat(32),
        authTokenService: 'twilio-auth-token',
        phoneNumber: '+15550000001',
        inboundMode: 'webhook',
        webhook: { publicBaseUrl: 'https://host.example', listenPort: 8080 },
        voice: { enabled: true, voicemailMaxLengthSec: 60, voicemailGreeting: 'hi' },
        pollIntervalMs: 30000,
        rateLimit: { smsPerMinute: 30 },
      },
    });
    expect(validateInstanceConfig(raw, ctx('create'))).toBeNull();
  });
});

describe('residual branch coverage — model/pinecone/healthPort/pluginDirs/numeric bounds', () => {
  it('treats a whitespace-only top-level model as unset (no consistency error)', () => {
    // normalizedModelString trims "   " to '' and returns null, so the
    // consistency check sees a single configured source and passes.
    const raw = baseAgent({ model: '   ', models: { conversation: 'sonnet' } });
    expect(validateInstanceConfig(raw, ctx('create'))).toBeNull();
  });

  it('falls back to ctx.name for the pinecone project-guard when raw omits name (patch)', () => {
    // raw has no `name` key, so the guard reads the instance name from ctx.name
    // ('alpha', a non-q instance) and still enforces the project-guard rule.
    const raw: Record<string, unknown> = {
      type: 'chat',
      accessMode: 'self_only',
      adminPhones: ['15551234567'],
      memory: { pinecone: { apiKeyEnv: 'PINECONE_MINI3_KEY', index: 'whatsapp-bot' } },
    };
    const result = validateInstanceConfig(raw, ctx('patch', { originalType: 'chat' }));
    expect(result?.field).toBe('memory.pinecone.projectId');
  });

  it('accepts a healthPort that does not collide with a different existing port', () => {
    // existing map holds a non-matching port for another instance: the dup loop
    // iterates, finds otherPort !== port, and returns null.
    const raw = baseAgent({ healthPort: 9001 });
    const existing = new Map([['beta', 9002]]);
    expect(validateInstanceConfig(raw, ctx('create', { existingHealthPorts: existing }))).toBeNull();
  });

  it('rejects pluginDirs that is an array containing a non-string element', () => {
    const raw = baseAgent({ agentOptions: { sessionScope: 'single', pluginDirs: ['/ok', 42] } });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('agentOptions.pluginDirs');
  });

  it('accepts pluginDirs that is an array of all strings', () => {
    const raw = baseAgent({
      agentOptions: { sessionScope: 'single', pluginDirs: ['/plugins/a', '/plugins/b'] },
    });
    expect(validateInstanceConfig(raw, ctx('create'))).toBeNull();
  });

  it('rejects maxTokens above the 200,000 upper bound', () => {
    const raw = baseAgent({ maxTokens: 200001 });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('maxTokens');
    expect(result?.message).toBe('maxTokens must be between 256 and 200,000');
  });

  it('rejects tokenBudget above the 10,000,000 upper bound', () => {
    const raw = baseAgent({ tokenBudget: 10000001 });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('tokenBudget');
    expect(result?.message).toBe('tokenBudget must be between 1,000 and 10,000,000');
  });
});

describe('agentOptions.nlRouting (F11)', () => {
  it('rejects a non-boolean nlRouting (a string "true" would silently leave the flag off)', () => {
    const raw = baseAgent({ agentOptions: { sessionScope: 'single', nlRouting: 'true' } });
    const result = validateInstanceConfig(raw, ctx('create'));
    expect(result?.field).toBe('agentOptions.nlRouting');
    expect(result?.message).toContain('must be a boolean when provided');
  });

  it('accepts a boolean nlRouting', () => {
    const raw = baseAgent({ agentOptions: { sessionScope: 'single', nlRouting: true } });
    expect(validateInstanceConfig(raw, ctx('create'))).toBeNull();
  });
});
