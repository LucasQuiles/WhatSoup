import { afterEach, describe, expect, it } from 'vitest';
import { migrateLegacyMemoryConfig } from '../src/config-memory-migration.ts';
import { validateInstanceConfig } from '../src/core/agent-config-validator.ts';

describe('migrateLegacyMemoryConfig', () => {
  it('preserves agentOptions (providerConfig, fallbacks) untouched while migrating legacy fields', () => {
    // Migration runs on BOTH fleet CREATE and PATCH paths; it must never
    // touch provider wiring while moving pinecone/memory legacy fields.
    const agentOptions = {
      sessionScope: 'single',
      provider: 'claude-cli',
      providerConfig: { baseUrl: 'https://api.groq.com/openai/v1', apiKeyService: 'groq' },
      fallbacks: [{ provider: 'openai-api', model: 'llama-3.3-70b-versatile' }],
    };
    const result = migrateLegacyMemoryConfig({
      name: 'byok-line',
      agentOptions,
      pineconeIndex: 'byok-mind',
      retentionDays: 45,
    }, { removeLegacy: true });

    expect(result.config.agentOptions).toEqual(agentOptions);
    // Control: migration actually ran (legacy field moved), so the
    // preservation assert above is not a vacuous no-op pass.
    expect(result.config.pineconeIndex).toBeUndefined();
    expect((result.config.memory as Record<string, any>).pinecone.index).toBe('byok-mind');
  });

  it('projects legacy memory fields into memory.* and removes flat fields when requested', () => {
    const result = migrateLegacyMemoryConfig({
      name: 'mw-bot',
      pineconeApiKeyEnv: 'PINECONE_MWLAB_KEY',
      pineconeProjectId: 'nf9hzvy',
      pineconeExpectedHostSuffix: '-nf9hzvy.svc.aped-4627-b74a.pinecone.io',
      pineconeIndex: 'mw-mind',
      pineconeAllowedIndexes: ['mw-mind'],
      pineconeFactsNamespace: 'mw-facts',
      pineconeChunksNamespace: 'mw-chunks',
      pineconeSummariesNamespace: 'mw-summaries',
      conversationWindow: 60,
      enrichmentBatchSize: 300,
      retentionDays: 45,
    }, { removeLegacy: true });

    expect(result.config.memory).toEqual({
      conversation: { recent: 60 },
      retention: { days: 45 },
      enrichment: { batchSize: 300 },
      pinecone: {
        apiKeyEnv: 'PINECONE_MWLAB_KEY',
        projectId: 'nf9hzvy',
        expectedHostSuffix: '-nf9hzvy.svc.aped-4627-b74a.pinecone.io',
        index: 'mw-mind',
        allowedIndexes: ['mw-mind'],
        namespaces: {
          facts: 'mw-facts',
          chunks: 'mw-chunks',
          summaries: 'mw-summaries',
        },
      },
    });
    expect(result.config).not.toHaveProperty('pineconeIndex');
    expect(result.config).not.toHaveProperty('pineconeAllowedIndexes');
    expect(result.removed).toContain('pineconeIndex');
    expect(result.changed).toBe(true);
  });

  it('keeps canonical memory values ahead of legacy aliases', () => {
    const result = migrateLegacyMemoryConfig({
      pineconeIndex: 'legacy-index',
      pineconeFactsNamespace: 'legacy-facts',
      memory: {
        pinecone: {
          index: 'canonical-index',
          namespaces: { facts: 'canonical-facts' },
        },
      },
    }, { removeLegacy: false });

    expect((result.config.memory as any).pinecone.index).toBe('canonical-index');
    expect((result.config.memory as any).pinecone.namespaces.facts).toBe('canonical-facts');
    expect(result.config.pineconeIndex).toBe('legacy-index');
  });

  it('merges legacy pineconeNamespaces without clobbering canonical namespace keys', () => {
    const result = migrateLegacyMemoryConfig({
      pineconeNamespaces: {
        facts: 'legacy-facts',
        chunks: 'legacy-chunks',
        summaries: 'legacy-summaries',
      },
      pineconeFactsNamespace: 'specific-facts',
      memory: {
        pinecone: {
          namespaces: { summaries: 'canonical-summaries' },
        },
      },
    }, { removeLegacy: true });

    expect((result.config.memory as any).pinecone.namespaces).toEqual({
      facts: 'specific-facts',
      chunks: 'legacy-chunks',
      summaries: 'canonical-summaries',
    });
    expect(result.config).not.toHaveProperty('pineconeNamespaces');
  });
});

describe('config-memory-migration.ts uncovered-branch coverage', () => {
  it('returns unchanged config for empty input regardless of removeLegacy', () => {
    const noRemove = migrateLegacyMemoryConfig({});
    expect(noRemove.changed).toBe(false);
    expect(noRemove.moved).toEqual([]);
    expect(noRemove.removed).toEqual([]);
    expect(noRemove.config).toEqual({});

    const withRemove = migrateLegacyMemoryConfig({}, { removeLegacy: true });
    expect(withRemove.changed).toBe(false);
    expect(withRemove.moved).toEqual([]);
    expect(withRemove.removed).toEqual([]);
    expect(withRemove.config).toEqual({});
  });

  it('preserves null legacy values and still reports the move', () => {
    const result = migrateLegacyMemoryConfig({
      pineconeApiKeyEnv: null,
    });

    expect(result.changed).toBe(true);
    expect(result.moved).toEqual([
      { from: 'pineconeApiKeyEnv', to: 'memory.pinecone.apiKeyEnv' },
    ]);
    expect((result.config.memory as any).pinecone.apiKeyEnv).toBeNull();
    expect(result.config).toHaveProperty('pineconeApiKeyEnv', null);
  });

  it('skips migrateNamespaceObject when pineconeNamespaces is not a record', () => {
    const result = migrateLegacyMemoryConfig({
      pineconeNamespaces: 'invalid-string-value',
      pineconeApiKeyEnv: 'PINECONE_TEST_KEY',
    });

    expect(result.moved).toEqual([
      { from: 'pineconeApiKeyEnv', to: 'memory.pinecone.apiKeyEnv' },
    ]);
    expect((result.config.memory as any).pinecone.apiKeyEnv).toBe('PINECONE_TEST_KEY');
    expect(result.config).toHaveProperty('pineconeNamespaces', 'invalid-string-value');
  });

  it('skips migrateNamespaceObject when pineconeNamespaces is null', () => {
    const result = migrateLegacyMemoryConfig({
      pineconeNamespaces: null,
    });

    expect(result.moved).toEqual([]);
    expect(result.changed).toBe(false);
    expect(result.config).toHaveProperty('pineconeNamespaces', null);
  });

  it('skips migrateNamespaceObject when pineconeNamespaces is an array', () => {
    const result = migrateLegacyMemoryConfig({
      pineconeNamespaces: ['facts', 'chunks'],
    });

    expect(result.moved).toEqual([]);
    expect(result.changed).toBe(false);
    expect(result.config).toHaveProperty('pineconeNamespaces', ['facts', 'chunks']);
  });

  it('does not record a moved entry when pineconeNamespaces is an empty object', () => {
    const result = migrateLegacyMemoryConfig({
      pineconeNamespaces: {},
    }, { removeLegacy: true });

    expect(result.moved).toEqual([]);
    expect(result.removed).toContain('pineconeNamespaces');
    expect(result.changed).toBe(true);
    expect(result.config).toEqual({});
  });

  it('does not record a moved entry when every pineconeNamespaces key is already canonical', () => {
    const result = migrateLegacyMemoryConfig({
      pineconeNamespaces: {
        facts: 'legacy-facts',
        chunks: 'legacy-chunks',
      },
      memory: {
        pinecone: {
          namespaces: {
            facts: 'canonical-facts',
            chunks: 'canonical-chunks',
          },
        },
      },
    });

    expect(result.moved).toEqual([]);
    expect(result.changed).toBe(false);
    expect((result.config.memory as any).pinecone.namespaces).toEqual({
      facts: 'canonical-facts',
      chunks: 'canonical-chunks',
    });
  });

  it('records only namespaces that were not already canonical', () => {
    const result = migrateLegacyMemoryConfig({
      pineconeNamespaces: {
        facts: 'legacy-facts',
        chunks: 'legacy-chunks',
        summaries: 'legacy-summaries',
      },
      memory: {
        pinecone: {
          namespaces: {
            chunks: 'canonical-chunks',
          },
        },
      },
    });

    expect(result.moved).toEqual([
      { from: 'pineconeNamespaces', to: 'memory.pinecone.namespaces' },
    ]);
    expect((result.config.memory as any).pinecone.namespaces).toEqual({
      facts: 'legacy-facts',
      chunks: 'canonical-chunks',
      summaries: 'legacy-summaries',
    });
  });

  it('leaves removed empty when removeLegacy is false even if legacy fields are present', () => {
    const result = migrateLegacyMemoryConfig({
      pineconeIndex: 'legacy-index',
      conversationWindow: 30,
    }, { removeLegacy: false });

    expect(result.removed).toEqual([]);
    expect(result.moved).toEqual([
      { from: 'conversationWindow', to: 'memory.conversation.recent' },
      { from: 'pineconeIndex', to: 'memory.pinecone.index' },
    ]);
    expect(result.config).toHaveProperty('pineconeIndex', 'legacy-index');
    expect((result.config.memory as any).pinecone.index).toBe('legacy-index');
    expect((result.config.memory as any).conversation.recent).toBe(30);
  });

  it('omits pineconeNamespaces from removed when it is absent from input', () => {
    const result = migrateLegacyMemoryConfig({
      pineconeIndex: 'legacy-index',
    }, { removeLegacy: true });

    expect(result.removed).toEqual(['pineconeIndex']);
    expect(result.removed).not.toContain('pineconeNamespaces');
    expect(result.config).toEqual({
      memory: { pinecone: { index: 'legacy-index' } },
    });
  });

  it('deep-clones nested values so callers cannot mutate the migrated config', () => {
    const originalAllowed = ['mw-mind', 'mw-mind-2'];
    const result = migrateLegacyMemoryConfig({
      pineconeAllowedIndexes: originalAllowed,
    });

    const moved = result.moved.find((m) => m.from === 'pineconeAllowedIndexes');
    expect(moved).toEqual({ from: 'pineconeAllowedIndexes', to: 'memory.pinecone.allowedIndexes' });
    const migratedIndexes = (result.config.memory as any).pinecone.allowedIndexes as string[];
    expect(migratedIndexes).toEqual(['mw-mind', 'mw-mind-2']);
    expect(migratedIndexes).not.toBe(originalAllowed);

    originalAllowed.push('mw-mind-3');
    expect(migratedIndexes).toEqual(['mw-mind', 'mw-mind-2']);
  });

  it('does not mutate the caller-owned input', () => {
    const input: Record<string, unknown> = {
      pineconeIndex: 'legacy-index',
      memory: {
        pinecone: {
          index: 'canonical-index',
        },
      },
    };
    const snapshot = structuredClone(input);

    const result = migrateLegacyMemoryConfig(input, { removeLegacy: true });

    expect(input).toEqual(snapshot);
    expect(result.config.pineconeIndex).toBeUndefined();
    expect((result.config.memory as any).pinecone.index).toBe('canonical-index');
  });
});

// A legacy pineconeNamespaces key names a namespace role, not a path. The
// validator, config load and the fleet routes migrate operator-supplied JSON,
// so a key such as "__proto__.x" must never reach Object.prototype or
// reparent an object. Fixtures come from JSON.parse: an object literal's
// __proto__ sets the prototype instead of creating an own key.
describe('migrateLegacyMemoryConfig with hostile legacy namespace keys', () => {
  const probe = 'pollutedByLegacyNamespaceKey';
  const prototype = Object.prototype as unknown as Record<string, unknown>;
  afterEach(() => {
    delete prototype[probe];
    delete prototype['systemPrompt'];
  });

  it.each(['__proto__.', 'constructor.prototype.', 'prototype.'])(
    'never writes through a dotted key starting %s into a shared prototype',
    (prefix) => {
      const input = JSON.parse(`{"pineconeNamespaces": {"${prefix}${probe}": "x"}}`) as Record<string, unknown>;
      migrateLegacyMemoryConfig(input, { removeLegacy: false });
      expect(Object.hasOwn(Object.prototype, probe)).toBe(false);
      expect(Object.hasOwn(Function.prototype, probe)).toBe(false);
      expect(({} as Record<string, unknown>)[probe]).toBeUndefined();
    },
  );

  it('never reparents the namespaces object through a bare __proto__ key', () => {
    const input = JSON.parse(
      `{"pineconeNamespaces": {"__proto__": {"${probe}": "x"}, "facts": "facts-ns"}}`,
    ) as Record<string, unknown>;
    const { config } = migrateLegacyMemoryConfig(input, { removeLegacy: false });
    const namespaces = (config.memory as any).pinecone.namespaces as Record<string, unknown>;
    expect(Object.getPrototypeOf(namespaces)).toBe(Object.prototype);
    expect(namespaces[probe]).toBeUndefined();
    expect(namespaces['facts']).toBe('facts-ns');
  });

  it('maps a dotted legacy namespace key literally, not as a path', () => {
    const { config } = migrateLegacyMemoryConfig({ pineconeNamespaces: { 'team.docs': 'team-docs' } });
    expect((config.memory as any).pinecone.namespaces).toEqual({ 'team.docs': 'team-docs' });
  });

  it('cannot satisfy a required field through the validator migration', () => {
    const raw = JSON.parse(
      '{"name":"alpha","type":"chat","accessMode":"allowlist","adminPhones":["15551234567"],'
      + '"pineconeNamespaces":{"__proto__.systemPrompt":"x"}}',
    ) as Record<string, unknown>;
    expect(validateInstanceConfig(raw, { name: 'alpha', mode: 'load' })?.field).toBe('systemPrompt');
    expect(Object.hasOwn(Object.prototype, 'systemPrompt')).toBe(false);
  });
});
