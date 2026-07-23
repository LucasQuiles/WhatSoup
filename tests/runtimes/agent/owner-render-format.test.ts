import { describe, it, expect } from 'vitest';
import {
  OWNER_BULLET,
  bulletedSection,
  displayedRoute,
  fallbackReconfirmationOutcome,
  fallbackRouteLabel,
  isDisplayedRoute,
  modifierSuffix,
  modelModifierTags,
  renderPinPreferenceOutcome,
  savedPreferenceLine,
  formatAvailableModels,
  isStructuralCatalogueAbsence,
  resolveModelSelector,
  MODEL_CATALOGUE_CAP,
  type AvailableModelsListing,
} from '../../../src/runtimes/agent/owner-render-format.ts';

// b28 r2a/r2d: the pure WhatsApp owner-render formatting seam. Enumerations
// render as a header line + one `• ` bullet per entry (WhatsApp narrow column:
// never a long joined single line); model modifiers are config-derived FACTS
// only (D7) — the catalog is silent for IDs it does not recognize.
describe('owner-render-format', () => {
  describe('route truth', () => {
    const primary = { provider: 'claude-cli', model: 'claude-opus-4-8' };
    const fallback = { provider: 'opencode-cli', model: 'kimi/kimi-k3' };

    it('marks the live route when one exists and otherwise marks the effective next route', () => {
      expect(displayedRoute(primary, fallback)).toBe(primary);
      expect(displayedRoute(null, fallback)).toBe(fallback);
      expect(isDisplayedRoute({ ...fallback }, displayedRoute(null, fallback))).toBe(true);
      expect(isDisplayedRoute(primary, displayedRoute(null, fallback))).toBe(false);
    });

    it('discloses that a saved pin does not displace an active health fallback', () => {
      const label = fallbackRouteLabel(fallback);
      expect(renderPinPreferenceOutcome('glm/glm-5.2', 'noop', label)).toContain(
        'Health fallback is active; new sessions still use opencode-cli (kimi/kimi-k3)',
      );
      expect(fallbackReconfirmationOutcome('glm/glm-5.2', '_Already set (sticky)._', label)).toContain(
        '(permanent)',
      );
    });

    it('labels a preference as saved while fallback decides the active route', () => {
      const pref = {
        intent: 'provider_specific',
        requestedProvider: 'opencode-cli',
        requestedModel: 'glm/glm-5.2',
        modelPinVerified: true,
        expiresAt: 3_600_000,
      };
      expect(savedPreferenceLine(pref, true, 0)).toBe(
        'Saved preference: glm/glm-5.2 (expires in ~1h) — health fallback currently decides new sessions',
      );
      expect(savedPreferenceLine(null, false, 0)).toBe('Saved preference: none');
    });
  });

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

  it('ok: numbers by STABLE catalogue order (no rerank), marks current IN PLACE, no truncation when M ≤ cap', () => {
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
    // current is index 3 and stays there (annotated), NOT hoisted to the top —
    // ranking would move the coordinate the write is addressed in (Q 2026-07-20).
    expect(out).toBe(
      `*Available models* — harness: opencode-cli\n` +
        `_source: opencode CLI, as of just now_\n` +
        `1. openai/gpt-5.4\n` +
        `2. deepseek/deepseek-chat\n` +
        `3. minimax/MiniMax-M2 (current)`,
    );
  });

  it('ok: caps the browse window, DISCLOSES it, and surfaces current OUT-OF-BAND at its true index when beyond the cap', () => {
    const ids = Array.from({ length: 20 }, (_, i) => `m/model-${i}`);
    const out = formatAvailableModels({
      ...base,
      currentModelId: 'm/model-5', // true index 6, beyond cap 3
      cap: 3,
      listing: { status: 'ok', ids, sourceLabel: 'opencode CLI', asOfLabel: 'just now' },
    });
    expect(out).toBe(
      `*Available models* — harness: opencode-cli\n` +
        `_source: opencode CLI, as of just now_\n` +
        `1. m/model-0\n` +
        `2. m/model-1\n` +
        `3. m/model-2\n` +
        `6. m/model-5 (current)\n` +
        `showing 1–3 of 20 — any number 1–20 works; /model list <text> to narrow`,
    );
  });

  it('ok: window disclosure is value-independent (same when nothing is current)', () => {
    const ids = Array.from({ length: 20 }, (_, i) => `m/model-${i}`);
    const out = formatAvailableModels({
      ...base,
      cap: 3,
      listing: { status: 'ok', ids, sourceLabel: 'opencode CLI', asOfLabel: 'just now' },
    });
    expect(out.split('\n').pop()).toBe(
      'showing 1–3 of 20 — any number 1–20 works; /model list <text> to narrow',
    );
    // no current → no out-of-band line: header + source + 3 + disclosure
    expect(out.split('\n')).toHaveLength(2 + 3 + 1);
  });

  it('ok: filter keeps TRUE stable indices (non-contiguous), never renumbers the subset 1..k', () => {
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
    // matches are catalogue indices 1 and 3 — index 2 (deepseek) filtered out, so
    // the rendered numbers are 1 and 3, NOT 1 and 2 (Q: one number space, one meaning).
    expect(out).toBe(
      `*Available models* matching 'minimax' — harness: opencode-cli\n` +
        `_source: opencode CLI, as of just now_\n` +
        `1. minimax/MiniMax-M2\n` +
        `3. minimax/MiniMax-Text-01`,
    );
  });

  it('ok: filter-miss is distinct from unavailable, counts the full catalogue, and carries harness+source+as-of', () => {
    const out = formatAvailableModels({
      ...base,
      filter: 'zzz',
      listing: { status: 'ok', ids: ['a', 'b', 'c'], sourceLabel: 'opencode CLI', asOfLabel: 'just now' },
    });
    expect(out).toBe(
      `*Available models:* no models match 'zzz' (3 in catalogue) (harness: opencode-cli, source: opencode CLI, as of just now)`,
    );
  });

  it('unavailable no-key: actionable, named harness, credential-neutral wording', () => {
    const out = formatAvailableModels({
      ...base,
      harnessLabel: 'claude-cli',
      currentModelId: 'claude-opus-4-8',
      listing: { status: 'unavailable', reason: { kind: 'no-key' }, asOfLabel: 'just now' },
    });
    expect(out).toBe(
      `*Available models:* unavailable — no anthropic credential reachable on this host (harness: claude-cli, as of just now)`,
    );
  });

  it('unavailable key-rejected: distinct message (credential presented but not accepted)', () => {
    const out = formatAvailableModels({
      ...base,
      harnessLabel: 'claude-cli',
      listing: { status: 'unavailable', reason: { kind: 'key-rejected' }, asOfLabel: 'just now' },
    });
    expect(out).toBe(
      `*Available models:* unavailable — anthropic credential rejected (401/403) (harness: claude-cli, as of just now)`,
    );
  });

  it('unavailable credential-expired: benign self-healing transient, not a rejection', () => {
    const out = formatAvailableModels({
      ...base,
      harnessLabel: 'claude-cli',
      listing: { status: 'unavailable', reason: { kind: 'credential-expired' }, asOfLabel: 'just now' },
    });
    expect(out).toBe(
      `*Available models:* unavailable — anthropic OAuth credential expired — refreshes on the next agent turn, try again shortly (harness: claude-cli, as of just now)`,
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

  it('ok: current is annotated in place at its true index and listed exactly once (no hoist, no dedup)', () => {
    const out = formatAvailableModels({
      ...base,
      currentModelId: 'x',
      listing: { status: 'ok', ids: ['a', 'x', 'b'], sourceLabel: 'opencode CLI', asOfLabel: 'just now' },
    });
    // Stable order: x stays at index 2 (annotated), never hoisted to the top —
    // so it appears exactly once with no dedup step needed.
    expect(out).toBe(
      `*Available models* — harness: opencode-cli\n` +
        `_source: opencode CLI, as of just now_\n` +
        `1. a\n` +
        `2. x (current)\n` +
        `3. b`,
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
      { status: 'unavailable', reason: { kind: 'credential-expired' }, asOfLabel: asOf },
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

// Q 2026-07-20: the ONE shared selector resolver — a numeric pick indexes into
// the STABLE ordering (catalogue order; current is annotated in place, never a
// reorder, so the number doesn't move under the write); an exact id is fail-open
// with a shape gate (obvious typo bounces, a shape-valid id is accepted even if
// the catalogue can't confirm it). Called by both /model <N> and /config model <N>.
describe('resolveModelSelector', () => {
  const ids = ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'];

  it('resolves a numeric selector 1-based against the stable ordering', () => {
    expect(resolveModelSelector('1', ids)).toStrictEqual({ ok: true, id: 'claude-opus-4-8', viaSelector: true });
    expect(resolveModelSelector('2', ids)).toStrictEqual({ ok: true, id: 'claude-sonnet-5', viaSelector: true });
    expect(resolveModelSelector('  3  ', ids)).toStrictEqual({ ok: true, id: 'claude-haiku-4-5-20251001', viaSelector: true });
  });

  it('rejects an out-of-range number with the count (structured, never a silent mis-pick)', () => {
    expect(resolveModelSelector('4', ids)).toStrictEqual({ ok: false, error: 'out-of-range', count: 3 });
    expect(resolveModelSelector('0', ids)).toStrictEqual({ ok: false, error: 'out-of-range', count: 3 });
  });

  it('accepts a shape-valid exact id (fail-open) even when not in the ordered list', () => {
    expect(resolveModelSelector('minimax/MiniMax-M2', ids)).toStrictEqual({ ok: true, id: 'minimax/MiniMax-M2', viaSelector: false });
    expect(resolveModelSelector('claude-opus-4-8', ids)).toStrictEqual({ ok: true, id: 'claude-opus-4-8', viaSelector: false });
  });

  it('bounces an obvious typo (whitespace) or empty input as invalid-shape', () => {
    expect(resolveModelSelector('opus 4 8', ids)).toStrictEqual({ ok: false, error: 'invalid-shape' });
    expect(resolveModelSelector('   ', ids)).toStrictEqual({ ok: false, error: 'invalid-shape' });
  });
});
