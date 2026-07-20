import { describe, it, expect } from 'vitest';
import {
  OWNER_BULLET,
  bulletedSection,
  modifierSuffix,
  modelModifierTags,
  formatAvailableModels,
  isStructuralCatalogueAbsence,
  MODEL_CATALOGUE_CAP,
  type AvailableModelsListing,
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

// The dynamic per-harness available-models section for `/config model`
// (CONFIG-MODEL-RENDER-SPEC.md, Q rulings 2026-07-19/20). Pure formatter over a
// resolver-produced discriminated listing. Encodes: pin renders in the caller's
// block ABOVE (degrades independently); ranked head pin→fallbacks→rest (say so
// when unranked); `showing N of M` only when M>cap; filter-miss ≠ unavailable;
// a `source:` provenance line = the tag on the LIST; the resolved `harness:` is
// named on every state (misresolution visible); distinct unavailable reasons
// (no-key ≠ key-rejected ≠ timeout ≠ empty ≠ no-adapter); as-of = capture time.
describe('formatAvailableModels', () => {
  const base = { harnessLabel: 'opencode-cli', currentModelId: null, fallbackModelIds: [], filter: null, cap: 12 } as const;

  it('ok: names harness + source provenance line, ranks current→fallbacks→rest, marks current, no truncation when M ≤ cap', () => {
    const out = formatAvailableModels({
      ...base,
      currentModelId: 'minimax/MiniMax-M2',
      fallbackModelIds: ['deepseek/deepseek-chat'],
      listing: {
        status: 'ok',
        ids: ['openai/gpt-5.4', 'deepseek/deepseek-chat', 'minimax/MiniMax-M2'],
        sourceLabel: 'opencode CLI',
        asOfLabel: 'just now',
      },
    });
    expect(out).toBe(
      `*Available models* — harness: opencode-cli\n` +
        `_source: opencode CLI, as of just now_\n` +
        `${OWNER_BULLET}minimax/MiniMax-M2 [current]\n` +
        `${OWNER_BULLET}deepseek/deepseek-chat\n` +
        `${OWNER_BULLET}openai/gpt-5.4`,
    );
  });

  it('ok: caps the head and appends "showing N of M" when a preference ranks it and M > cap', () => {
    const ids = Array.from({ length: 20 }, (_, i) => `m/model-${i}`);
    const out = formatAvailableModels({
      ...base,
      currentModelId: 'm/model-5',
      cap: 3,
      listing: { status: 'ok', ids, sourceLabel: 'opencode CLI', asOfLabel: 'just now' },
    });
    const lines = out.split('\n');
    expect(lines[0]).toBe('*Available models* — harness: opencode-cli');
    expect(lines[1]).toBe('_source: opencode CLI, as of just now_');
    expect(lines[2]).toBe(`${OWNER_BULLET}m/model-5 [current]`);
    expect(lines).toHaveLength(2 + 3 + 1); // header + source + cap bullets + truncation
    expect(lines[lines.length - 1]).toBe('showing 3 of 20');
  });

  it('ok: says the head is catalogue order (not "the top") when nothing ranks it and M > cap', () => {
    const ids = Array.from({ length: 20 }, (_, i) => `m/model-${i}`);
    const out = formatAvailableModels({
      ...base,
      cap: 3,
      listing: { status: 'ok', ids, sourceLabel: 'opencode CLI', asOfLabel: 'just now' },
    });
    expect(out.split('\n').pop()).toBe(
      'showing first 3 of 20 (catalogue order — no configured preference to rank by)',
    );
  });

  it('ok: filter matches a subset — header notes the filter, ranks within the matched set', () => {
    const out = formatAvailableModels({
      ...base,
      filter: 'minimax',
      listing: {
        status: 'ok',
        ids: ['minimax/MiniMax-M2', 'deepseek/deepseek-chat', 'minimax/MiniMax-Text-01'],
        sourceLabel: 'opencode CLI',
        asOfLabel: 'just now',
      },
    });
    expect(out).toBe(
      `*Available models* matching 'minimax' — harness: opencode-cli\n` +
        `_source: opencode CLI, as of just now_\n` +
        `${OWNER_BULLET}minimax/MiniMax-M2\n` +
        `${OWNER_BULLET}minimax/MiniMax-Text-01`,
    );
  });

  it('ok: filter-miss is distinct from unavailable, counts the full catalogue, and carries harness+source+as-of', () => {
    const out = formatAvailableModels({
      ...base,
      filter: 'zzz',
      listing: { status: 'ok', ids: ['a', 'b', 'c'], sourceLabel: 'opencode CLI', asOfLabel: 'just now' },
    });
    expect(out).toBe(
      `*Available models:* no match for 'zzz' in 3 models (harness: opencode-cli, source: opencode CLI, as of just now)`,
    );
  });

  it('unavailable no-key: actionable, named harness, distinct from a rejected key', () => {
    const out = formatAvailableModels({
      ...base,
      harnessLabel: 'claude-cli',
      currentModelId: 'claude-opus-4-8',
      listing: { status: 'unavailable', reason: { kind: 'no-key' }, asOfLabel: 'just now' },
    });
    expect(out).toBe(
      `*Available models:* unavailable — no anthropic API key reachable on this host (harness: claude-cli, as of just now)`,
    );
  });

  it('unavailable key-rejected: distinct message (key present but not accepted)', () => {
    const out = formatAvailableModels({
      ...base,
      harnessLabel: 'claude-cli',
      listing: { status: 'unavailable', reason: { kind: 'key-rejected' }, asOfLabel: 'just now' },
    });
    expect(out).toBe(
      `*Available models:* unavailable — anthropic API key present but rejected (401/403) (harness: claude-cli, as of just now)`,
    );
  });

  it('unavailable timeout: labeled as a timeout, not absence (Q#3)', () => {
    const out = formatAvailableModels({
      ...base,
      harnessLabel: 'claude-cli',
      listing: { status: 'unavailable', reason: { kind: 'timeout' }, asOfLabel: 'just now' },
    });
    expect(out).toBe(
      `*Available models:* unavailable — catalogue lookup timed out (harness: claude-cli, as of just now)`,
    );
  });

  it('unavailable empty: honest wording that does NOT assert genuine emptiness (parser cannot distinguish)', () => {
    const out = formatAvailableModels({
      ...base,
      listing: { status: 'unavailable', reason: { kind: 'empty' }, asOfLabel: 'just now' },
    });
    expect(out).toBe(
      `*Available models:* unavailable — harness ran but returned no model lines (harness: opencode-cli, as of just now)`,
    );
  });

  it('unavailable unparseable: points at the parser (format regression), distinct from empty', () => {
    const out = formatAvailableModels({
      ...base,
      listing: { status: 'unavailable', reason: { kind: 'unparseable' }, asOfLabel: 'just now' },
    });
    expect(out).toBe(
      `*Available models:* unavailable — harness output not recognizable as a model list (parser may need updating) (harness: opencode-cli, as of just now)`,
    );
  });

  it('unavailable probe-failed: points at the binary/PATH, distinct from empty and no-adapter', () => {
    const out = formatAvailableModels({
      ...base,
      listing: { status: 'unavailable', reason: { kind: 'probe-failed' }, asOfLabel: 'just now' },
    });
    expect(out).toBe(
      `*Available models:* unavailable — harness catalogue command could not be run (binary missing?) (harness: opencode-cli, as of just now)`,
    );
  });

  it('unavailable lookup-failed: transient vendor failure, distinct from key/timeout reasons', () => {
    const out = formatAvailableModels({
      ...base,
      harnessLabel: 'claude-cli',
      listing: { status: 'unavailable', reason: { kind: 'lookup-failed' }, asOfLabel: 'just now' },
    });
    expect(out).toBe(
      `*Available models:* unavailable — catalogue lookup failed (try again shortly) (harness: claude-cli, as of just now)`,
    );
  });

  it('unavailable no-adapter: names the unadapted harness rather than "unsupported"', () => {
    const out = formatAvailableModels({
      ...base,
      harnessLabel: 'codex-cli',
      listing: { status: 'unavailable', reason: { kind: 'no-adapter', harness: 'codex-cli' }, asOfLabel: 'just now' },
    });
    expect(out).toBe(
      `*Available models:* unavailable — no catalogue adapter for harness 'codex-cli' (harness: codex-cli, as of just now)`,
    );
  });

  it('ok: no truncation line when M equals the cap exactly (boundary)', () => {
    const out = formatAvailableModels({
      ...base,
      cap: 3,
      listing: { status: 'ok', ids: ['a', 'b', 'c'], sourceLabel: 'opencode CLI', asOfLabel: 'just now' },
    });
    expect(out.split('\n')).toHaveLength(2 + 3); // header + source + 3 bullets, no truncation
  });

  it('ok: dedups a current model that also appears in the catalogue body (listed once, first)', () => {
    const out = formatAvailableModels({
      ...base,
      currentModelId: 'x',
      listing: { status: 'ok', ids: ['a', 'x', 'b'], sourceLabel: 'opencode CLI', asOfLabel: 'just now' },
    });
    expect(out).toBe(
      `*Available models* — harness: opencode-cli\n` +
        `_source: opencode CLI, as of just now_\n` +
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

// Render-policy split (advisor 2026-07-20): a STRUCTURAL absence (no catalogue
// SOURCE exists for this harness) has no retry and no reader-actionable fix, so
// the caller SUPPRESSES the whole dynamic section instead of appending a
// permanent dead-end line to every /model list. A TRANSIENT failure (a source
// that exists but hiccupped) stays rendered because "try again" is actionable.
describe('isStructuralCatalogueAbsence', () => {
  const asOf = 'just now';
  const ok: AvailableModelsListing = { status: 'ok', ids: ['x'], sourceLabel: 'opencode CLI', asOfLabel: asOf };

  it('is false for an available (ok) listing — there is a section to render', () => {
    expect(isStructuralCatalogueAbsence(ok)).toBe(false);
  });

  it('is TRUE only for no-key and no-adapter (no source exists on this host)', () => {
    const structural: AvailableModelsListing[] = [
      { status: 'unavailable', reason: { kind: 'no-key' }, asOfLabel: asOf },
      { status: 'unavailable', reason: { kind: 'no-adapter', harness: 'codex-cli' }, asOfLabel: asOf },
    ];
    for (const listing of structural) {
      expect(isStructuralCatalogueAbsence(listing)).toBe(true);
    }
  });

  it('is FALSE for every transient reason — a source exists, "try again" is actionable', () => {
    const transient: AvailableModelsListing[] = [
      { status: 'unavailable', reason: { kind: 'key-rejected' }, asOfLabel: asOf },
      { status: 'unavailable', reason: { kind: 'timeout' }, asOfLabel: asOf },
      { status: 'unavailable', reason: { kind: 'empty' }, asOfLabel: asOf },
      { status: 'unavailable', reason: { kind: 'unparseable' }, asOfLabel: asOf },
      { status: 'unavailable', reason: { kind: 'probe-failed' }, asOfLabel: asOf },
      { status: 'unavailable', reason: { kind: 'lookup-failed' }, asOfLabel: asOf },
    ];
    for (const listing of transient) {
      expect(isStructuralCatalogueAbsence(listing)).toBe(false);
    }
  });
});
