import { describe, it, expect } from 'vitest';
import { brandOf, resolveBrandProvider, listBrands } from '../../../../src/runtimes/agent/providers/provider-brand.ts';

describe('provider-brand (Slice 2 drill Level-1 brand map)', () => {
  describe('brandOf', () => {
    it('maps each known provider id to its brand', () => {
      expect(brandOf('claude-cli')).toBe('Claude');
      expect(brandOf('anthropic-api')).toBe('Claude');
      expect(brandOf('openai-api')).toBe('OpenAI');
      expect(brandOf('opencode-cli')).toBe('OpenCode');
      expect(brandOf('codex-cli')).toBe('Codex');
      expect(brandOf('gemini-cli')).toBe('Gemini');
    });

    it('returns null for an unknown id, never throws', () => {
      expect(brandOf('not-a-provider')).toBeNull();
      expect(brandOf('')).toBeNull();
    });
  });

  describe('resolveBrandProvider', () => {
    it('prefers the OAuth/CLI path over the API path within a brand when both routable', () => {
      expect(resolveBrandProvider('Claude', ['anthropic-api', 'claude-cli'])).toBe('claude-cli');
    });

    it('falls back to the API path when the CLI path is not routable', () => {
      expect(resolveBrandProvider('Claude', ['anthropic-api'])).toBe('anthropic-api');
    });

    it('returns null for an unknown brand or when nothing in the order is routable', () => {
      expect(resolveBrandProvider('Nope', ['claude-cli'])).toBeNull();
      expect(resolveBrandProvider('Claude', ['opencode-cli'])).toBeNull();
    });
  });

  describe('listBrands', () => {
    it('emits one entry per brand in first-seen order', () => {
      const out = listBrands([{ id: 'claude-cli' }, { id: 'opencode-cli' }, { id: 'codex-cli' }]);
      expect(out).toEqual([
        { brand: 'Claude', provider: 'claude-cli' },
        { brand: 'OpenCode', provider: 'opencode-cli' },
        { brand: 'Codex', provider: 'codex-cli' },
      ]);
    });

    it('dedupes a brand seen twice, and the later-preferred id wins even if a lower-preference sibling appears first', () => {
      // anthropic-api appears FIRST but claude-cli is preferred — the resolved
      // provider is claude-cli (resolved against the full id set), one entry.
      const out = listBrands([{ id: 'anthropic-api' }, { id: 'claude-cli' }]);
      expect(out).toEqual([{ brand: 'Claude', provider: 'claude-cli' }]);
    });

    it('skips an unknown id rather than dropping the whole call', () => {
      const out = listBrands([{ id: 'mystery' }, { id: 'openai-api' }]);
      expect(out).toEqual([{ brand: 'OpenAI', provider: 'openai-api' }]);
    });

    it('returns an empty array when no id is branded', () => {
      expect(listBrands([{ id: 'x' }, { id: 'y' }])).toEqual([]);
    });
  });
});
