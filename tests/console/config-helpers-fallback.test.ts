// Fallback provider/model become typed, editable rows in ConfigEditDialog.
//
// Before this change, agentOptions.fallbackProvider / fallbackModel fell into
// the read-only "agentOptions (other)" JSON blob. They are now declared in
// AGENT_OPTION_FIELDS so buildConfigEntries flattens them into typed entries.
//
// Source: console/src/components/line-detail/config-helpers.ts

import { describe, expect, it } from 'vitest';
import {
  AGENT_OPTION_FIELDS,
  buildConfigEntries,
} from '../../console/src/components/line-detail/config-helpers.ts';
import { PROVIDERS } from '../../console/src/lib/providers.ts';

describe('AGENT_OPTION_FIELDS — fallback fields', () => {
  it('classifies agentOptions.fallbackModel as a typed string field', () => {
    expect(AGENT_OPTION_FIELDS['agentOptions.fallbackModel']).toEqual({ type: 'string' });
  });

  it('classifies agentOptions.fallbackProvider as an enum sourced from the provider catalog', () => {
    const def = AGENT_OPTION_FIELDS['agentOptions.fallbackProvider'];
    expect(def.type).toBe('enum');
    // Enum options are derived from the single console PROVIDERS catalog — never
    // a second hardcoded provider-id list.
    expect(def.enum).toEqual(PROVIDERS.map((p) => p.id));
    expect(def.enum).toContain('openai-api');
    expect(def.enum).toContain('claude-cli');
  });
});

describe('buildConfigEntries — fallback flattening', () => {
  it('flattens fallbackProvider/fallbackModel as typed entries instead of the "other" blob', () => {
    const entries = buildConfigEntries({
      agentOptions: {
        provider: 'claude-cli',
        fallbackProvider: 'openai-api',
        fallbackModel: 'gpt-4o',
      },
    });
    const byKey = Object.fromEntries(entries.map((e) => [e.key, e]));

    // Typed rows present...
    expect(byKey['agentOptions.fallbackProvider']).toEqual({
      key: 'agentOptions.fallbackProvider',
      value: 'openai-api',
      type: 'string', // enum fields render through the string entry type
    });
    expect(byKey['agentOptions.fallbackModel']).toEqual({
      key: 'agentOptions.fallbackModel',
      value: 'gpt-4o',
      type: 'string',
    });

    // ...and the leftover blob carries ONLY the still-unflattened key (provider),
    // never the now-typed fallback fields.
    const other = byKey['agentOptions (other)'];
    const leftover = JSON.parse(other.value) as Record<string, unknown>;
    expect(leftover).toEqual({ provider: 'claude-cli' });
  });

  it('omits the leftover blob entirely when fallback fields are the only agentOptions', () => {
    const entries = buildConfigEntries({
      agentOptions: {
        fallbackProvider: 'anthropic-api',
        fallbackModel: 'claude-sonnet-4-6',
      },
    });
    const keys = entries.map((e) => e.key);
    expect(keys).toContain('agentOptions.fallbackProvider');
    expect(keys).toContain('agentOptions.fallbackModel');
    expect(keys).not.toContain('agentOptions (other)');
  });
});
