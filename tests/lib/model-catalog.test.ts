import { describe, it, expect } from 'vitest';
import {
  parseModelId,
  latestInFamily,
  adviseModel,
  MODEL_CATALOG,
} from '../../src/lib/model-catalog.ts';

describe('parseModelId', () => {
  it('parses modern Anthropic IDs', () => {
    expect(parseModelId('claude-opus-4-8')).toEqual({
      vendor: 'anthropic', family: 'opus', version: 408, normalized: 'claude-opus-4-8',
    });
    expect(parseModelId('claude-sonnet-4-6')).toMatchObject({ family: 'sonnet', version: 406 });
  });

  it('parses major-only IDs (new tiers like fable)', () => {
    expect(parseModelId('claude-fable-5')).toMatchObject({
      vendor: 'anthropic', family: 'fable', version: 500,
    });
  });

  it('parses FUTURE Anthropic IDs it has never seen', () => {
    // Released-after-this-code models must parse and order correctly.
    expect(parseModelId('claude-opus-4-9')).toMatchObject({ family: 'opus', version: 409 });
    expect(parseModelId('claude-opus-5-0')).toMatchObject({ family: 'opus', version: 500 });
    expect(parseModelId('claude-nova-6-1')).toMatchObject({ family: 'nova', version: 601 });
  });

  it('strips routing suffixes: [1m], -fast, dated snapshots', () => {
    expect(parseModelId('claude-opus-4-6[1m]')).toMatchObject({ family: 'opus', version: 406 });
    expect(parseModelId('claude-opus-4-6-fast')).toMatchObject({ family: 'opus', version: 406 });
    expect(parseModelId('claude-haiku-4-5-20251001')).toMatchObject({ family: 'haiku', version: 405 });
  });

  it('parses legacy claude-<ver>-<family> IDs', () => {
    expect(parseModelId('claude-3-5-sonnet-20241022')).toMatchObject({ family: 'sonnet', version: 305 });
    expect(parseModelId('claude-3-opus-20240229')).toMatchObject({ family: 'opus', version: 300 });
  });

  it('parses OpenAI GPT and o-series IDs, including codex variants', () => {
    expect(parseModelId('gpt-5.4')).toMatchObject({ vendor: 'openai', family: 'gpt', version: 504 });
    expect(parseModelId('gpt-4o')).toMatchObject({ vendor: 'openai', version: 400 });
    expect(parseModelId('gpt-5.1-codex-max')).toMatchObject({ vendor: 'openai', version: 501 });
    expect(parseModelId('o3')).toMatchObject({ vendor: 'openai', family: 'o', version: 300 });
  });

  it('keeps codex variants in their own comparison line', () => {
    const codex = parseModelId('gpt-5.1-codex');
    const plain = parseModelId('gpt-5.4');
    expect(codex).not.toBeNull();
    expect(plain).not.toBeNull();
    expect(codex!.family).not.toBe(plain!.family);
  });

  it('returns null for unrecognized IDs (model-agnostic pass-through)', () => {
    expect(parseModelId('gemini-2.5-pro')).toBeNull();
    expect(parseModelId('llama-3-70b')).toBeNull();
    expect(parseModelId('')).toBeNull();
  });
});

describe('latestInFamily', () => {
  it('finds the newest catalog model in the same family', () => {
    const parsed = parseModelId('claude-opus-4-6')!;
    expect(latestInFamily(parsed)?.normalized).toBe('claude-opus-4-8');
  });

  it('prefers a live-discovered model newer than the catalog', () => {
    const parsed = parseModelId('claude-opus-4-8')!;
    expect(latestInFamily(parsed, ['claude-opus-4-9'])?.normalized).toBe('claude-opus-4-9');
  });

  it('ignores live IDs from other families and vendors', () => {
    const parsed = parseModelId('claude-sonnet-4-6')!;
    expect(latestInFamily(parsed, ['claude-opus-4-9', 'gpt-6'])?.normalized).toBe('claude-sonnet-4-6');
  });

  it('excludes pre-release IDs by default (stable comparison)', () => {
    const parsed = parseModelId('gpt-5.4')!;
    expect(latestInFamily(parsed, ['gpt-5.5', 'gpt-5.6-preview'])?.normalized).toBe('gpt-5.5');
  });

  it('admits pre-release IDs with stable: false, keeping the served ID', () => {
    const parsed = parseModelId('gpt-5.4')!;
    expect(latestInFamily(parsed, ['gpt-5.5', 'gpt-5.6-preview'], { stable: false })?.normalized)
      .toBe('gpt-5.6-preview');
    const opus = parseModelId('claude-opus-4-8')!;
    expect(latestInFamily(opus, ['claude-opus-4-9-beta'], { stable: false })?.normalized)
      .toBe('claude-opus-4-9-beta');
  });

  it('keeps variant product lines (-codex, -mini) out of the family even with stable: false', () => {
    const parsed = parseModelId('gpt-5.4')!;
    expect(latestInFamily(parsed, ['gpt-5.9-codex', 'gpt-5.8-mini'], { stable: false })?.normalized)
      .toBe('gpt-5.4');
  });

  it('prefers the stable ID over a pre-release one on a version tie', () => {
    const parsed = parseModelId('gpt-5.4')!;
    expect(latestInFamily(parsed, ['gpt-5.6-preview', 'gpt-5.6'], { stable: false })?.normalized)
      .toBe('gpt-5.6');
  });
});

describe('adviseModel', () => {
  it('is silent for current models', () => {
    expect(adviseModel('claude-opus-4-8')).toBeNull();
    expect(adviseModel('claude-fable-5')).toBeNull();
    expect(adviseModel('claude-sonnet-4-6')).toBeNull();
    expect(adviseModel('claude-haiku-4-5')).toBeNull();
    expect(adviseModel('gpt-5.4')).toBeNull();
  });

  it('is silent for models NEWER than the catalog (future releases)', () => {
    expect(adviseModel('claude-opus-4-9')).toBeNull();
    expect(adviseModel('claude-opus-5-0')).toBeNull();
  });

  it('is silent for unrecognized providers (model-agnostic harness)', () => {
    expect(adviseModel('gemini-2.5-pro')).toBeNull();
    expect(adviseModel('my-custom-local-model')).toBeNull();
  });

  it('recommends an upgrade for legacy models', () => {
    const a = adviseModel('claude-opus-4-6');
    expect(a).toMatchObject({ level: 'upgrade-available', recommended: 'claude-opus-4-8' });
    expect(adviseModel('gpt-4o')).toMatchObject({ level: 'upgrade-available', recommended: 'gpt-5.4' });
  });

  it('handles routing suffixes when advising', () => {
    expect(adviseModel('claude-opus-4-6[1m]')).toMatchObject({ recommended: 'claude-opus-4-8' });
  });

  it('flags deprecated models with retirement dates', () => {
    const a = adviseModel('claude-sonnet-4-20250514');
    expect(a).toMatchObject({
      level: 'deprecated',
      recommended: 'claude-sonnet-4-6',
      retiresAt: '2026-06-15',
    });
  });

  it('flags retired models', () => {
    expect(adviseModel('claude-3-5-sonnet-20241022')).toMatchObject({
      level: 'retired',
      recommended: 'claude-sonnet-4-6',
    });
  });

  it('recommends a live-discovered model newer than the whole catalog', () => {
    const a = adviseModel('claude-opus-4-8', ['claude-opus-4-9']);
    expect(a).toMatchObject({ level: 'upgrade-available', recommended: 'claude-opus-4-9' });
  });
});

describe('MODEL_CATALOG integrity', () => {
  it('every non-current entry names a successor that is current', () => {
    const currentIds = new Set(MODEL_CATALOG.filter((e) => e.status === 'current').map((e) => e.id));
    for (const e of MODEL_CATALOG) {
      if (e.status === 'current') continue;
      expect(e.successor, `${e.id} must have a successor`).toBeTruthy();
      expect(currentIds.has(e.successor!), `${e.id} successor ${e.successor} must be current`).toBe(true);
    }
  });

  it('every catalog ID parses or is intentionally opaque', () => {
    for (const e of MODEL_CATALOG) {
      // All current catalog entries follow parseable vendor conventions.
      expect(parseModelId(e.id), `${e.id} should parse`).not.toBeNull();
    }
  });
});
