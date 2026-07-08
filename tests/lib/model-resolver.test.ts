import { describe, it, expect } from 'vitest';
import {
  parseSymbolicModel,
  validateModelRoleValue,
  resolveSymbolicFromIds,
  resolveSymbolicFromCatalog,
} from '../../src/lib/model-resolver.ts';

// The acceptance live-list from the bead spec.
const OPENAI_LIVE = ['gpt-5.5', 'gpt-5.5-codex', 'gpt-5.4', 'gpt-5.6-preview'];

describe('parseSymbolicModel', () => {
  it('returns null for literal IDs (exact passthrough, the default)', () => {
    expect(parseSymbolicModel('gpt-5.4')).toBeNull();
    expect(parseSymbolicModel('claude-opus-4-8')).toBeNull();
    expect(parseSymbolicModel('claude-opus-4-6[1m]')).toBeNull();
    expect(parseSymbolicModel('my-custom-local-model')).toBeNull();
  });

  it('returns null for colon-containing values that do not claim the grammar', () => {
    // Neither a symbolic vendor prefix nor a latest[-stable] tail.
    expect(parseSymbolicModel('llama3:70b')).toBeNull();
  });

  it('parses the full <vendor>:<family>:latest[-stable] form', () => {
    expect(parseSymbolicModel('openai:gpt:latest-stable')).toEqual({
      vendor: 'openai', family: 'gpt', stable: true, raw: 'openai:gpt:latest-stable',
    });
    expect(parseSymbolicModel('anthropic:opus:latest')).toEqual({
      vendor: 'anthropic', family: 'opus', stable: false, raw: 'anthropic:opus:latest',
    });
    expect(parseSymbolicModel('anthropic:sonnet:latest-stable')).toMatchObject({
      family: 'sonnet', stable: true,
    });
  });

  it('defaults the family to the vendor flagship line in the shorthand form', () => {
    expect(parseSymbolicModel('openai:latest-stable')).toMatchObject({ vendor: 'openai', family: 'gpt' });
    expect(parseSymbolicModel('anthropic:latest')).toMatchObject({ vendor: 'anthropic', family: 'opus' });
  });

  it('is case/whitespace tolerant', () => {
    expect(parseSymbolicModel(' OpenAI:GPT:Latest-Stable ')).toMatchObject({
      vendor: 'openai', family: 'gpt', stable: true,
    });
  });

  it('rejects unknown vendors instead of passing them through', () => {
    expect(() => parseSymbolicModel('openia:gpt:latest')).toThrow(/unknown vendor "openia"/);
    // A colon-tagged value ending in :latest is claimed by the grammar even
    // when the prefix is not a symbolic vendor — silent passthrough would
    // mask typos of this grammar.
    expect(() => parseSymbolicModel('llama3:latest')).toThrow(/unknown vendor/);
  });

  it('rejects unknown families instead of passing them through', () => {
    expect(() => parseSymbolicModel('openai:gtp:latest-stable')).toThrow(/unknown openai family "gtp"/);
    expect(() => parseSymbolicModel('anthropic:opsu:latest')).toThrow(/unknown anthropic family "opsu"/);
  });

  it('rejects malformed symbolic values (bad mode, empty segments, too many segments)', () => {
    expect(() => parseSymbolicModel('openai:gpt:newest')).toThrow(/invalid symbolic model/);
    expect(() => parseSymbolicModel('openai:gpt')).toThrow(/invalid symbolic model/);
    expect(() => parseSymbolicModel('openai::latest')).toThrow(/invalid symbolic model/);
    expect(() => parseSymbolicModel('openai:gpt:extra:latest')).toThrow(/invalid symbolic model/);
  });
});

describe('validateModelRoleValue', () => {
  it('passes literals and well-formed symbolic values through unchanged', () => {
    expect(validateModelRoleValue('gpt-5.4', 'fallback')).toBe('gpt-5.4');
    expect(validateModelRoleValue('openai:gpt:latest-stable', 'fallback')).toBe('openai:gpt:latest-stable');
  });

  it('throws at config load with the role attached for malformed symbolic values', () => {
    expect(() => validateModelRoleValue('openia:gpt:latest', 'fallback')).toThrow(/^models\.fallback: unknown vendor/);
    expect(() => validateModelRoleValue('anthropic:opsu:latest', 'conversation')).toThrow(/^models\.conversation: unknown anthropic family/);
  });
});

describe('resolveSymbolicFromIds', () => {
  it('latest-stable picks the newest stable ID, excluding preview and variant lines', () => {
    const spec = parseSymbolicModel('openai:gpt:latest-stable')!;
    expect(resolveSymbolicFromIds(spec, OPENAI_LIVE)).toBe('gpt-5.5');
  });

  it('latest picks the newest served ID including preview', () => {
    const spec = parseSymbolicModel('openai:gpt:latest')!;
    expect(resolveSymbolicFromIds(spec, OPENAI_LIVE)).toBe('gpt-5.6-preview');
  });

  it('latest still excludes variant product lines (-codex is a different product, not a newer gpt)', () => {
    const spec = parseSymbolicModel('openai:gpt:latest')!;
    expect(resolveSymbolicFromIds(spec, ['gpt-5.4', 'gpt-5.9-codex'])).toBe('gpt-5.4');
  });

  it('anthropic:opus:latest-stable resolves to claude-opus-4-8', () => {
    const spec = parseSymbolicModel('anthropic:opus:latest-stable')!;
    expect(resolveSymbolicFromIds(spec, [
      'claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-fable-5',
    ])).toBe('claude-opus-4-8');
  });

  it('prefers a live ID newer than the whole catalog', () => {
    const spec = parseSymbolicModel('anthropic:opus:latest-stable')!;
    expect(resolveSymbolicFromIds(spec, ['claude-opus-4-9'])).toBe('claude-opus-4-9');
  });

  it('falls back to catalog current/legacy entries when the live list is empty', () => {
    const spec = parseSymbolicModel('openai:gpt:latest-stable')!;
    expect(resolveSymbolicFromIds(spec, [])).toBe('gpt-5.4');
  });

  it('normalizes dated snapshots to their base ID', () => {
    const spec = parseSymbolicModel('anthropic:haiku:latest')!;
    expect(resolveSymbolicFromIds(spec, ['claude-haiku-4-6-20260401'])).toBe('claude-haiku-4-6');
  });
});

describe('resolveSymbolicFromCatalog', () => {
  it('resolves to the newest current catalog entry for the family (degraded/offline path)', () => {
    expect(resolveSymbolicFromCatalog(parseSymbolicModel('openai:gpt:latest-stable')!)).toBe('gpt-5.4');
    expect(resolveSymbolicFromCatalog(parseSymbolicModel('anthropic:opus:latest')!)).toBe('claude-opus-4-8');
    expect(resolveSymbolicFromCatalog(parseSymbolicModel('anthropic:haiku:latest-stable')!)).toBe('claude-haiku-4-5');
  });
});
