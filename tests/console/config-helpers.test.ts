// Direct coverage for line-detail config-helpers pure utilities.
// Source: console/src/components/line-detail/config-helpers.ts

import { describe, expect, it } from 'vitest';
import {
  AGENT_OPTION_FIELDS,
  CHAT_OPTION_FIELDS,
  CONFIG_EXCLUDE_KEYS,
  CONFIG_PATH_KEYS,
  CUSTOM_ENUM_OPTION,
  CUSTOMIZABLE_ENUM_KEYS,
  ENUM_OPTIONS,
  FIELD_VALIDATORS,
  TYPE_COLOR,
  buildConfigEntries,
  cloneRecord,
  deleteValueAtPath,
  formatConfigValue,
  getConfigEntryType,
  getValueAtPath,
  isEqualValue,
  isRecord,
  setValueAtPath,
  validateAdminPhones,
} from '../../console/src/components/line-detail/config-helpers.ts';
import { CHAT_API_KEY_SERVICE_OPTIONS } from '../../console/src/lib/providers.ts';

describe('isRecord', () => {
  it('accepts plain objects and rejects arrays/null/primitives', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord([1, 2])).toBe(false);
    expect(isRecord('x')).toBe(false);
    expect(isRecord(42)).toBe(false);
    expect(isRecord(true)).toBe(false);
  });
});

describe('getValueAtPath', () => {
  it('reads single segment, deep nested, and dotted key paths', () => {
    const source = { a: 1, b: { c: { d: 'leaf' } }, n: null };
    expect(getValueAtPath(source, 'a')).toBe(1);
    expect(getValueAtPath(source, 'b.c.d')).toBe('leaf');
    expect(getValueAtPath(source, 'b.c')).toEqual({ d: 'leaf' });
  });

  it('returns undefined when intermediate is missing or not a record', () => {
    const source = { a: 1, b: { c: 2 }, arr: [1, 2], n: null };
    expect(getValueAtPath(source, 'missing')).toBeUndefined();
    expect(getValueAtPath(source, 'b.missing.deep')).toBeUndefined();
    // Intermediate is a primitive, not a record
    expect(getValueAtPath(source, 'a.x')).toBeUndefined();
    // Arrays are not records per isRecord, so traversal stops
    expect(getValueAtPath(source, 'arr.0')).toBeUndefined();
    // Null intermediate stops traversal
    expect(getValueAtPath(source, 'n.x')).toBeUndefined();
    // Non-record source short-circuits
    expect(getValueAtPath(null, 'a')).toBeUndefined();
    expect(getValueAtPath('hi', 'length')).toBeUndefined();
  });
});

describe('setValueAtPath', () => {
  it('sets a new top-level key and overwrites an existing value', () => {
    const target: Record<string, unknown> = { existing: 'old' };
    setValueAtPath(target, 'fresh', 1);
    setValueAtPath(target, 'existing', 'new');
    expect(target.fresh).toBe(1);
    expect(target.existing).toBe('new');
  });

  it('creates missing intermediate objects along a deep path', () => {
    const target: Record<string, unknown> = {};
    setValueAtPath(target, 'a.b.c', 'leaf');
    expect(target).toEqual({ a: { b: { c: 'leaf' } } });
  });

  it('replaces a non-record intermediate with an object so the path can be written', () => {
    const target: Record<string, unknown> = { a: 'scalar' };
    setValueAtPath(target, 'a.b', 'leaf');
    expect(target).toEqual({ a: { b: 'leaf' } });
  });

  it('preserves sibling keys at intermediate records', () => {
    const target: Record<string, unknown> = { a: { keep: 1 } };
    setValueAtPath(target, 'a.added', 2);
    expect(target).toEqual({ a: { keep: 1, added: 2 } });
  });
});

describe('deleteValueAtPath', () => {
  it('deletes a top-level leaf', () => {
    const target: Record<string, unknown> = { a: 1, b: 2 };
    deleteValueAtPath(target, 'a');
    expect(target).toEqual({ b: 2 });
  });

  it('deletes a nested leaf and prunes the now-empty parent chain', () => {
    const target: Record<string, unknown> = { a: { b: { c: 'leaf' } }, sibling: 1 };
    deleteValueAtPath(target, 'a.b.c');
    // The whole `a` chain becomes empty and is cleaned up.
    expect(target).toEqual({ sibling: 1 });
  });

  it('keeps parent intact when sibling keys remain after a nested delete', () => {
    const target: Record<string, unknown> = { a: { b: { c: 'leaf', keep: 1 } } };
    deleteValueAtPath(target, 'a.b.c');
    expect(target).toEqual({ a: { b: { keep: 1 } } });
  });

  it('is a no-op when the path traverses through a non-record', () => {
    const target: Record<string, unknown> = { a: 'scalar' };
    deleteValueAtPath(target, 'a.b.c');
    expect(target).toEqual({ a: 'scalar' });
  });
});

describe('cloneRecord', () => {
  it('returns a deep, independent copy', () => {
    const original = { a: 1, nested: { list: [1, 2], inner: { flag: true } } };
    const copy = cloneRecord(original);
    expect(copy).toEqual(original);
    expect(copy).not.toBe(original);
    expect(copy.nested).not.toBe(original.nested);
    // Mutating the clone must not bleed back into the original.
    (copy.nested as { inner: { flag: boolean } }).inner.flag = false;
    expect((original.nested as { inner: { flag: boolean } }).inner.flag).toBe(true);
  });
});

describe('isEqualValue', () => {
  it('compares primitives with Object.is semantics', () => {
    expect(isEqualValue(1, 1)).toBe(true);
    expect(isEqualValue('a', 'a')).toBe(true);
    expect(isEqualValue(true, true)).toBe(true);
    expect(isEqualValue(null, null)).toBe(true);
    expect(isEqualValue(undefined, undefined)).toBe(true);
    expect(isEqualValue(NaN, NaN)).toBe(true);
    expect(isEqualValue(1, 2)).toBe(false);
    expect(isEqualValue('a', 'b')).toBe(false);
    expect(isEqualValue(1, '1')).toBe(false);
    expect(isEqualValue(null, undefined)).toBe(false);
  });

  it('compares arrays element-wise', () => {
    expect(isEqualValue([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(isEqualValue([], [])).toBe(true);
    expect(isEqualValue([1, 2], [1, 2, 3])).toBe(false);
    expect(isEqualValue([1, 2, 3], [3, 2, 1])).toBe(false);
    expect(isEqualValue([{ a: 1 }], [{ a: 1 }])).toBe(true);
    expect(isEqualValue([{ a: 1 }], [{ a: 2 }])).toBe(false);
  });

  it('compares records deeply by keys and values', () => {
    expect(isEqualValue({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(isEqualValue({ a: { b: [1, 2] } }, { a: { b: [1, 2] } })).toBe(true);
    expect(isEqualValue({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(isEqualValue({ a: 1 }, { a: 2 })).toBe(false);
    expect(isEqualValue({ a: 1 }, { b: 1 })).toBe(false);
  });

  it('rejects cross-type comparisons between arrays and records', () => {
    expect(isEqualValue([], {})).toBe(false);
    expect(isEqualValue({ 0: 'a' }, ['a'])).toBe(false);
  });
});

describe('formatConfigValue', () => {
  it('stringifies primitives via String()', () => {
    expect(formatConfigValue('hi')).toBe('hi');
    expect(formatConfigValue(42)).toBe('42');
    expect(formatConfigValue(true)).toBe('true');
    expect(formatConfigValue(false)).toBe('false');
    expect(formatConfigValue(undefined)).toBe('undefined');
  });

  it('JSON-stringifies objects and arrays, but renders null as the literal "null"', () => {
    expect(formatConfigValue({ a: 1 })).toBe('{"a":1}');
    expect(formatConfigValue([1, 2])).toBe('[1,2]');
    // typeof null === 'object' but the branch guards against null with !== null,
    // so null falls through to String(null) → "null".
    expect(formatConfigValue(null)).toBe('null');
  });

  it('truncates values longer than 80 chars to 77 chars plus ellipsis', () => {
    const long = 'x'.repeat(200);
    const formatted = formatConfigValue(long);
    expect(formatted.length).toBe(80);
    expect(formatted.endsWith('...')).toBe(true);
    expect(formatted.slice(0, 77)).toBe('x'.repeat(77));
    // Right-at-the-boundary inputs are not truncated.
    const eighty = 'y'.repeat(80);
    expect(formatConfigValue(eighty)).toBe(eighty);
  });
});

describe('getConfigEntryType', () => {
  it('returns "boolean" for boolean values or explicit "boolean" type', () => {
    expect(getConfigEntryType('flag', true)).toBe('boolean');
    expect(getConfigEntryType('flag', false)).toBe('boolean');
    // Explicit boolean wins even when value is a string.
    expect(getConfigEntryType('flag', 'truthy', 'boolean')).toBe('boolean');
  });

  it('returns "number" for numeric values', () => {
    expect(getConfigEntryType('count', 0)).toBe('number');
    expect(getConfigEntryType('count', 42)).toBe('number');
    expect(getConfigEntryType('count', -1.5)).toBe('number');
  });

  it('returns "path" for explicit path type or for keys in CONFIG_PATH_KEYS', () => {
    expect(getConfigEntryType('any', 'value', 'path')).toBe('path');
    for (const key of ['cwd', 'instructionsPath', 'socketPath', 'configDir', 'dataDir', 'stateDir']) {
      expect(getConfigEntryType(key, '/tmp/x')).toBe('path');
    }
  });

  it('falls through to "string" for everything else', () => {
    expect(getConfigEntryType('name', 'value')).toBe('string');
    expect(getConfigEntryType('unknown', null)).toBe('string');
    expect(getConfigEntryType('unknown', { obj: 1 })).toBe('string');
    expect(getConfigEntryType('unknown', undefined)).toBe('string');
  });
});

describe('static config tables', () => {
  it('CONFIG_EXCLUDE_KEYS pins the documented top-level skips', () => {
    expect(CONFIG_EXCLUDE_KEYS.has('name')).toBe(true);
    expect(CONFIG_EXCLUDE_KEYS.has('type')).toBe(true);
    expect(CONFIG_EXCLUDE_KEYS.has('paths')).toBe(true);
    expect(CONFIG_EXCLUDE_KEYS.has('healthPort')).toBe(true);
    expect(CONFIG_EXCLUDE_KEYS.has('transport')).toBe(true);
    expect(CONFIG_EXCLUDE_KEYS.has('agentOptions')).toBe(false);
  });

  it('CONFIG_PATH_KEYS covers the documented filesystem keys', () => {
    for (const key of ['cwd', 'instructionsPath', 'socketPath', 'configDir', 'dataDir', 'stateDir']) {
      expect(CONFIG_PATH_KEYS.has(key)).toBe(true);
    }
    expect(CONFIG_PATH_KEYS.has('name')).toBe(false);
  });

  it('AGENT_OPTION_FIELDS exposes the expected typed field schema', () => {
    expect(AGENT_OPTION_FIELDS['agentOptions.sessionScope']).toEqual({
      type: 'enum',
      enum: ['single', 'shared', 'per_chat'],
    });
    expect(AGENT_OPTION_FIELDS['agentOptions.cwd']).toEqual({ type: 'path' });
    expect(AGENT_OPTION_FIELDS['agentOptions.instructionsPath']).toEqual({ type: 'path' });
    expect(AGENT_OPTION_FIELDS['agentOptions.sandboxPerChat']).toEqual({ type: 'boolean' });
    expect(AGENT_OPTION_FIELDS['agentOptions.pluginDirs']).toEqual({ type: 'array' });
    expect(AGENT_OPTION_FIELDS['agentOptions.mcp.inheritUserConfig']).toEqual({ type: 'boolean' });
    // All declared field paths must start with the `agentOptions.` prefix that
    // buildConfigEntries strips when descending into the agentOptions sub-tree.
    for (const key of Object.keys(AGENT_OPTION_FIELDS)) {
      expect(key.startsWith('agentOptions.')).toBe(true);
    }
  });

  it('CHAT_OPTION_FIELDS exposes the chat BYOK editable field schema', () => {
    expect(CHAT_OPTION_FIELDS['chatOptions.openaiProviderConfig.baseUrl']).toEqual({ type: 'string' });
    expect(CHAT_OPTION_FIELDS['chatOptions.openaiProviderConfig.apiKeyService']).toEqual({
      type: 'enum',
      enum: ['', ...CHAT_API_KEY_SERVICE_OPTIONS],
    });
  });

  it('TYPE_COLOR covers every ConfigEntryType returned by getConfigEntryType', () => {
    expect(typeof TYPE_COLOR.string).toBe('string');
    expect(typeof TYPE_COLOR.number).toBe('string');
    expect(typeof TYPE_COLOR.boolean).toBe('string');
    expect(typeof TYPE_COLOR.path).toBe('string');
  });

  it('ENUM_OPTIONS pins the known UI dropdown sets', () => {
    expect(ENUM_OPTIONS.accessMode).toEqual(['self_only', 'allowlist', 'open_dm', 'groups_only']);
    expect(ENUM_OPTIONS.toolUpdateMode).toEqual(['full', 'minimal']);
    expect(ENUM_OPTIONS['chatOptions.openaiProviderConfig.apiKeyService']).toEqual(['', ...CHAT_API_KEY_SERVICE_OPTIONS]);
    // Model list begins with an empty string sentinel so the UI can clear the value.
    expect(ENUM_OPTIONS.model[0]).toBe('');
    expect(ENUM_OPTIONS.model).toContain('claude-opus-4-6');
  });

  it('CUSTOM_ENUM_OPTION sentinel and CUSTOMIZABLE_ENUM_KEYS are wired together', () => {
    expect(CUSTOM_ENUM_OPTION).toBe('__custom__');
    expect(CUSTOMIZABLE_ENUM_KEYS.has('model')).toBe(true);
    expect(CUSTOMIZABLE_ENUM_KEYS.has('accessMode')).toBe(false);
  });
});

describe('FIELD_VALIDATORS', () => {
  it('adminPhones rejects empty arrays and invalid phone strings', () => {
    expect(FIELD_VALIDATORS.adminPhones([])).toMatch(/At least one admin phone/);
    expect(FIELD_VALIDATORS.adminPhones(['not-a-phone'])).toMatch(/10-15 digits/);
    expect(FIELD_VALIDATORS.adminPhones([12345])).toMatch(/10-15 digits/);
    // 10-digit NANP number is accepted by validatePhone after normalization.
    expect(FIELD_VALIDATORS.adminPhones(['5551234567'])).toBeNull();
    // Non-array inputs short-circuit both branches and return null.
    expect(FIELD_VALIDATORS.adminPhones('5551234567')).toBeNull();
  });

  it('maxTokens enforces 256..200000 inclusive bounds', () => {
    expect(FIELD_VALIDATORS.maxTokens(255)).toBe('Min 256');
    expect(FIELD_VALIDATORS.maxTokens(256)).toBeNull();
    expect(FIELD_VALIDATORS.maxTokens(200000)).toBeNull();
    expect(FIELD_VALIDATORS.maxTokens(200001)).toBe('Max 200,000');
    // Non-number inputs are out of scope for this validator.
    expect(FIELD_VALIDATORS.maxTokens('256')).toBeNull();
  });

  it('tokenBudget enforces 1000..10000000 inclusive bounds', () => {
    expect(FIELD_VALIDATORS.tokenBudget(999)).toBe('Min 1,000');
    expect(FIELD_VALIDATORS.tokenBudget(1000)).toBeNull();
    expect(FIELD_VALIDATORS.tokenBudget(10_000_000)).toBeNull();
    expect(FIELD_VALIDATORS.tokenBudget(10_000_001)).toBe('Max 10M');
  });

  it('rateLimitPerHour enforces 1..10000 inclusive bounds', () => {
    expect(FIELD_VALIDATORS.rateLimitPerHour(0)).toBe('Min 1');
    expect(FIELD_VALIDATORS.rateLimitPerHour(1)).toBeNull();
    expect(FIELD_VALIDATORS.rateLimitPerHour(10_000)).toBeNull();
    expect(FIELD_VALIDATORS.rateLimitPerHour(10_001)).toBe('Max 10,000');
  });

  it('chat BYOK baseUrl accepts only non-empty http(s) URLs when edited', () => {
    const validate = FIELD_VALIDATORS['chatOptions.openaiProviderConfig.baseUrl'];
    expect(validate('')).toBeNull();
    expect(validate('not-a-url')).toBe('Enter a valid http:// or https:// URL');
    expect(validate('ftp://api.example.com/v1')).toBe('Enter a valid http:// or https:// URL');
    expect(validate('https://api.groq.com/openai/v1')).toBeNull();
    expect(validate('http://localhost:11434/v1')).toBeNull();
  });

  it('chat BYOK apiKeyService allows the empty sentinel or a provider service', () => {
    const validate = FIELD_VALIDATORS['chatOptions.openaiProviderConfig.apiKeyService'];
    expect(validate('')).toBeNull();
    expect(validate('groq')).toBeNull();
    expect(validate('pinecone')).toBe('Choose a provider keyring service');
  });
});

describe('validateAdminPhones', () => {
  it('validates transport-specific admin identities while preserving the compatibility field', () => {
    expect(validateAdminPhones(['15551234567'], 'twilio')).toBeNull();
    expect(validateAdminPhones(['01234567-89ab-cdef-0123-456789abcdef'], 'signal')).toBeNull();
    expect(validateAdminPhones(['owner@example.com'], 'imessage')).toBeNull();
    expect(validateAdminPhones(['owner@example.com'], 'signal')).toMatch(/Signal/i);
    expect(validateAdminPhones([], 'imessage')).toMatch(/At least one admin/i);
  });
});

describe('buildConfigEntries', () => {
  it('skips CONFIG_EXCLUDE_KEYS and emits a typed entry per remaining key', () => {
    const entries = buildConfigEntries({
      name: 'ignored',
      type: 'ignored',
      paths: { ignored: true },
      healthPort: 9999,
      enabled: true,
      cwd: '/var/lib/whatsoup',
      maxTokens: 4096,
      label: 'primary-line',
    });
    const byKey = Object.fromEntries(entries.map((e) => [e.key, e]));
    expect(byKey.name).toBeUndefined();
    expect(byKey.type).toBeUndefined();
    expect(byKey.paths).toBeUndefined();
    expect(byKey.healthPort).toBeUndefined();
    expect(byKey.enabled).toEqual({ key: 'enabled', value: 'true', type: 'boolean' });
    expect(byKey.cwd).toEqual({ key: 'cwd', value: '/var/lib/whatsoup', type: 'path' });
    expect(byKey.maxTokens).toEqual({ key: 'maxTokens', value: '4096', type: 'number' });
    expect(byKey.label).toEqual({ key: 'label', value: 'primary-line', type: 'string' });
  });

  it('flattens declared agentOptions fields and bundles leftover keys under "agentOptions (other)"', () => {
    const entries = buildConfigEntries({
      agentOptions: {
        sessionScope: 'shared',
        cwd: '/srv/work',
        sandboxPerChat: false,
        mcp: { inheritUserConfig: true, extra: 'kept' },
        custom: 'leftover',
      },
    });
    const keys = entries.map((e) => e.key);
    expect(keys).toContain('agentOptions.sessionScope');
    expect(keys).toContain('agentOptions.cwd');
    expect(keys).toContain('agentOptions.sandboxPerChat');
    expect(keys).toContain('agentOptions.mcp.inheritUserConfig');
    expect(keys).toContain('agentOptions (other)');

    const flatScope = entries.find((e) => e.key === 'agentOptions.sessionScope');
    expect(flatScope).toEqual({ key: 'agentOptions.sessionScope', value: 'shared', type: 'string' });
    const flatCwd = entries.find((e) => e.key === 'agentOptions.cwd');
    expect(flatCwd).toEqual({ key: 'agentOptions.cwd', value: '/srv/work', type: 'path' });
    const flatSandbox = entries.find((e) => e.key === 'agentOptions.sandboxPerChat');
    expect(flatSandbox).toEqual({ key: 'agentOptions.sandboxPerChat', value: 'false', type: 'boolean' });

    const other = entries.find((e) => e.key === 'agentOptions (other)');
    expect(other?.type).toBe('string');
    // Leftover bucket carries the keys that AGENT_OPTION_FIELDS does not flatten,
    // plus any sibling keys inside `mcp` that weren't extracted.
    const leftover = JSON.parse(other!.value) as Record<string, unknown>;
    expect(leftover.custom).toBe('leftover');
    expect((leftover.mcp as Record<string, unknown>).extra).toBe('kept');
    expect((leftover.mcp as Record<string, unknown>).inheritUserConfig).toBeUndefined();
  });

  it('flattens persisted chatOptions.openaiProviderConfig fields and bundles leftover chatOptions keys', () => {
    const entries = buildConfigEntries({
      type: 'chat',
      chatOptions: {
        openaiProviderConfig: {
          baseUrl: 'https://api.groq.com/openai/v1',
          apiKeyService: 'groq',
        },
        futureKnob: true,
      },
    });

    const byKey = Object.fromEntries(entries.map((e) => [e.key, e]));
    expect(byKey['chatOptions.openaiProviderConfig.baseUrl']).toEqual({
      key: 'chatOptions.openaiProviderConfig.baseUrl',
      value: 'https://api.groq.com/openai/v1',
      type: 'string',
    });
    expect(byKey['chatOptions.openaiProviderConfig.apiKeyService']).toEqual({
      key: 'chatOptions.openaiProviderConfig.apiKeyService',
      value: 'groq',
      type: 'string',
    });
    expect(byKey['chatOptions (other)']?.type).toBe('string');
    expect(JSON.parse(byKey['chatOptions (other)']!.value)).toEqual({ futureKnob: true });
  });

  it('does not flatten chatOptions for non-chat configs', () => {
    const entries = buildConfigEntries({
      type: 'agent',
      chatOptions: {
        openaiProviderConfig: {
          baseUrl: 'https://api.groq.com/openai/v1',
          apiKeyService: 'groq',
        },
      },
    });

    const keys = entries.map((e) => e.key);
    expect(keys).not.toContain('chatOptions.openaiProviderConfig.baseUrl');
    expect(keys).not.toContain('chatOptions.openaiProviderConfig.apiKeyService');
    expect(keys).toContain('chatOptions');
  });

  it('omits the leftover bucket when every agentOptions key is flattened', () => {
    const entries = buildConfigEntries({
      agentOptions: {
        sessionScope: 'single',
      },
    });
    const keys = entries.map((e) => e.key);
    expect(keys).toContain('agentOptions.sessionScope');
    expect(keys).not.toContain('agentOptions (other)');
  });

  it('treats agentOptions as an opaque value when it is not a record', () => {
    const entries = buildConfigEntries({ agentOptions: 'disabled' });
    expect(entries).toEqual([{ key: 'agentOptions', value: 'disabled', type: 'string' }]);
  });
});
