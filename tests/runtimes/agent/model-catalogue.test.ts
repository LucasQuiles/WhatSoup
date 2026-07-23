import { describe, it, expect } from 'vitest';
import { configPointer, scopedCatalogue } from '../../../src/runtimes/agent/model-catalogue.ts';

describe('configPointer', () => {
  it('config pointer names the env var for a keyed provider, never a value', () => {
    expect(configPointer('openai')).toMatch(/set OPENAI_API_KEY on the host/);
    expect(configPointer('openai')).not.toMatch(/sk-/); // never a value
  });

  it('resolves a runtime provider id (openai-api) to the same env var as its key service', () => {
    expect(configPointer('openai-api')).toMatch(/set OPENAI_API_KEY on the host/);
  });

  it('resolves anthropic-api to ANTHROPIC_API_KEY', () => {
    expect(configPointer('anthropic-api')).toMatch(/set ANTHROPIC_API_KEY on the host/);
  });

  it('degrades gracefully for a provider with no known key service, never fabricating a var name', () => {
    const text = configPointer('some-unmapped-provider');
    expect(text).toContain('some-unmapped-provider');
    expect(text).not.toMatch(/set undefined/);
  });
});

describe('scopedCatalogue', () => {
  it('configured-only scoping keeps configured providers pickable', () => {
    const list = scopedCatalogue([
      { id: 'kimi', configured: true, state: 'routable', audience: 'keyed' },
      { id: 'openai', configured: false, state: 'unconfigured', audience: 'keyed' },
    ] as any);
    expect(list.pickable.map((p) => p.id)).toEqual(['kimi']);
    expect(list.configPointers).toEqual(['openai']);
  });

  it('never places a native-audience provider in configPointers (fail-open guarantee)', () => {
    const list = scopedCatalogue([
      { id: 'codex-cli', configured: true, state: 'native', audience: 'native' },
      { id: 'gemini-cli', configured: true, state: 'native', audience: 'native' },
    ] as any);
    expect(list.pickable.map((p) => p.id)).toEqual(['codex-cli', 'gemini-cli']);
    expect(list.configPointers).toEqual([]);
  });

  it('handles an empty descriptor list', () => {
    expect(scopedCatalogue([])).toEqual({ pickable: [], configPointers: [] });
  });
});
