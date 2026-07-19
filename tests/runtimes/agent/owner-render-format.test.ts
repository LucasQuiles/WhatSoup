import { describe, it, expect } from 'vitest';
import {
  OWNER_BULLET,
  bulletedSection,
  modifierSuffix,
  modelModifierTags,
  formatAvailableModels,
  MODEL_CATALOGUE_CAP,
} from '../../../src/runtimes/agent/owner-render-format.ts';

// b28 r2a/r2d: the pure WhatsApp owner-render formatting seam. Enumerations
// render as a header line + one `• ` bullet per entry (WhatsApp narrow column:
// never a long joined single line); model modifiers are config-derived FACTS
// only (D7) — the catalog is silent for IDs it does not recognize.
describe('owner-render-format', () => {
  describe('bulletedSection', () => {
    it('renders a header followed by one bullet per item, never a joined single line', () => {
      const out = bulletedSection('Fallback chain (configured):', [
        'opencode-cli (kimi/kimi-k3)',
        'opencode-cli (glm/glm-5.2)',
      ]);
      expect(out).toBe(
        'Fallback chain (configured):\n' +
          `${OWNER_BULLET}opencode-cli (kimi/kimi-k3)\n` +
          `${OWNER_BULLET}opencode-cli (glm/glm-5.2)`,
      );
      // The pre-b28 defect: the whole chain crammed onto one ` → `-joined line.
      expect(out).not.toContain(' → ');
      expect(out.split('\n').filter((l) => l.startsWith(OWNER_BULLET))).toHaveLength(2);
    });

    it('distinct same-provider entries stay distinguishable as separate bullets (B23 discriminator preserved)', () => {
      const out = bulletedSection('Fallback chain (configured):', [
        'opencode-cli (glm-4.7)',
        'opencode-cli (kimi-k3)',
      ]);
      expect(out).toContain(`${OWNER_BULLET}opencode-cli (glm-4.7)`);
      expect(out).toContain(`${OWNER_BULLET}opencode-cli (kimi-k3)`);
    });
  });

  describe('modifierSuffix', () => {
    it('is empty for no tags', () => {
      expect(modifierSuffix([])).toBe('');
    });
    it('wraps each tag in brackets, space-separated, with a leading space', () => {
      expect(modifierSuffix(['strongest'])).toBe(' [strongest]');
      expect(modifierSuffix(['newer: claude-opus-4-8', 'strongest'])).toBe(
        ' [newer: claude-opus-4-8] [strongest]',
      );
    });
  });

  describe('modelModifierTags', () => {
    it('tags a legacy model with its newer sibling (config-derived from the ID + catalog)', () => {
      expect(modelModifierTags('claude-opus-4-5', 'claude-cli', null)).toEqual([
        'newer: claude-opus-4-8',
      ]);
    });

    it('is SILENT for an ID the catalog does not recognize (D7 honesty — never invents a fact)', () => {
      expect(modelModifierTags('kimi/kimi-k3', 'opencode-cli', null)).toEqual([]);
      expect(modelModifierTags('glm/glm-5.2', 'opencode-cli', null)).toEqual([]);
    });

    it('emits no advisory for a current model', () => {
      expect(modelModifierTags('claude-opus-4-8', 'claude-cli', null)).toEqual([]);
    });

    it('tags a deprecated model with its successor', () => {
      // claude-opus-4-0 is deprecated in the catalog, successor claude-opus-4-8.
      expect(modelModifierTags('claude-opus-4-0', 'claude-cli', null)).toEqual([
        'deprecated → claude-opus-4-8',
      ]);
    });

    it('tags a retired model with its successor', () => {
      // claude-3-opus-20240229 is retired in the catalog, successor claude-opus-4-8.
      expect(modelModifierTags('claude-3-opus-20240229', 'claude-cli', null)).toEqual([
        'retired → claude-opus-4-8',
      ]);
    });

    it('tags a provider that is a configured tier target (config-derived from nlRoutingTiers)', () => {
      expect(modelModifierTags(undefined, 'anthropic-api', { strongest: 'anthropic-api' })).toEqual([
        'strongest',
      ]);
      expect(modelModifierTags(undefined, 'claude-cli', { strongest: 'anthropic-api' })).toEqual([]);
    });

    it('combines a catalog advisory and a tier tag in order', () => {
      expect(
        modelModifierTags('claude-opus-4-5', 'anthropic-api', { strongest: 'anthropic-api' }),
      ).toEqual(['newer: claude-opus-4-8', 'strongest']);
    });
  });
});

// The dynamic per-harness available-models section for `/config model` (Q ruling
// 2026-07-19, CONFIG-MODEL-RENDER-SPEC.md). Pure formatter over a listModelCatalog
// result: (1) the pin renders in the caller's config block ABOVE, so this section
// degrades independently; (2) ranked head pin→fallbacks→rest, not alphabetical;
// (3) `showing N of M` ONLY when M > cap; (4) filter-miss ≠ catalogue-unavailable.
describe('formatAvailableModels', () => {
  const asOf = 'just now';

  it('ranks current → fallbacks → rest, marks current, and omits the truncation line when M ≤ cap', () => {
    const out = formatAvailableModels({
      currentModelId: 'claude-opus-4-8',
      fallbackModelIds: ['minimax/MiniMax-M2'],
      listing: {
        status: 'ok',
        ids: ['deepseek/deepseek-chat', 'minimax/MiniMax-M2', 'claude-opus-4-8', 'openai/gpt-5.4'],
      },
      filter: null,
      cap: 12,
      asOfLabel: asOf,
    });
    expect(out).toBe(
      `*Available models* (as of just now)\n` +
        `${OWNER_BULLET}claude-opus-4-8 [current]\n` +
        `${OWNER_BULLET}minimax/MiniMax-M2\n` +
        `${OWNER_BULLET}deepseek/deepseek-chat\n` +
        `${OWNER_BULLET}openai/gpt-5.4`,
    );
  });

  it('caps the head and appends "showing N of M" when a preference rank exists and M > cap', () => {
    const ids = Array.from({ length: 20 }, (_, i) => `m/model-${i}`);
    const out = formatAvailableModels({
      currentModelId: 'm/model-5',
      fallbackModelIds: [],
      listing: { status: 'ok', ids },
      filter: null,
      cap: 3,
      asOfLabel: asOf,
    });
    const lines = out.split('\n');
    expect(lines[0]).toBe('*Available models* (as of just now)');
    expect(lines[1]).toBe(`${OWNER_BULLET}m/model-5 [current]`);
    expect(lines).toHaveLength(1 + 3 + 1); // header + cap bullets + truncation
    expect(lines[lines.length - 1]).toBe('showing 3 of 20');
  });

  it('says the head is catalogue-order (not the top) when nothing ranks it and M > cap', () => {
    const ids = Array.from({ length: 20 }, (_, i) => `m/model-${i}`);
    const out = formatAvailableModels({
      currentModelId: null,
      fallbackModelIds: [],
      listing: { status: 'ok', ids },
      filter: null,
      cap: 3,
      asOfLabel: asOf,
    });
    expect(out.split('\n').pop()).toBe(
      'showing first 3 of 20 (catalogue order — no configured preference to rank by)',
    );
  });

  it('filters case-insensitively and ranks within the matched set', () => {
    const out = formatAvailableModels({
      currentModelId: null,
      fallbackModelIds: [],
      listing: {
        status: 'ok',
        ids: ['minimax/MiniMax-M2', 'deepseek/deepseek-chat', 'minimax/MiniMax-Text-01'],
      },
      filter: 'minimax',
      cap: 12,
      asOfLabel: asOf,
    });
    expect(out).toBe(
      `*Available models* matching 'minimax' (as of just now)\n` +
        `${OWNER_BULLET}minimax/MiniMax-M2\n` +
        `${OWNER_BULLET}minimax/MiniMax-Text-01`,
    );
  });

  it('renders filter-miss distinctly from catalogue-unavailable (dead-knob defense), counting the full catalogue', () => {
    const out = formatAvailableModels({
      currentModelId: null,
      fallbackModelIds: [],
      listing: { status: 'ok', ids: ['a', 'b', 'c'] },
      filter: 'zzz',
      cap: 12,
      asOfLabel: asOf,
    });
    expect(out).toBe(`*Available models:* no match for 'zzz' in 3 models (as of just now)`);
  });

  it('renders catalogue-unavailable honestly (the pin is shown by the caller above)', () => {
    const out = formatAvailableModels({
      currentModelId: 'claude-opus-4-8',
      fallbackModelIds: [],
      listing: { status: 'unavailable', ids: [] },
      filter: null,
      cap: 12,
      asOfLabel: asOf,
    });
    expect(out).toBe(`*Available models:* catalogue unavailable (as of just now)`);
  });

  it('emits no truncation line when M equals the cap exactly (boundary)', () => {
    const out = formatAvailableModels({
      currentModelId: null,
      fallbackModelIds: [],
      listing: { status: 'ok', ids: ['a', 'b', 'c'] },
      filter: null,
      cap: 3,
      asOfLabel: asOf,
    });
    expect(out.split('\n')).toHaveLength(1 + 3); // header + 3 bullets, NO truncation
  });

  it('dedups a current model that also appears in the catalogue body (listed once, first)', () => {
    const out = formatAvailableModels({
      currentModelId: 'x',
      fallbackModelIds: [],
      listing: { status: 'ok', ids: ['a', 'x', 'b'] },
      filter: null,
      cap: 12,
      asOfLabel: asOf,
    });
    expect(out).toBe(
      `*Available models* (as of just now)\n` +
        `${OWNER_BULLET}x [current]\n` +
        `${OWNER_BULLET}a\n` +
        `${OWNER_BULLET}b`,
    );
  });

  it('exposes one cap constant (number ≥ 1) for uniform use across harnesses', () => {
    expect(typeof MODEL_CATALOGUE_CAP).toBe('number');
    expect(MODEL_CATALOGUE_CAP).toBeGreaterThanOrEqual(1);
  });
});
