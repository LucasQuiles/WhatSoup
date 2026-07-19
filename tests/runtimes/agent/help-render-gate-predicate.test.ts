import { describe, it, expect, vi } from 'vitest';

// RED-first fixture for the T5 tag-predicate bounce (packet §W1-T5 step 3,
// line 811, and the §W1-T3 ripple, line 509: "…so `/new` keeps its tag").
// help-render.ts's `_(admin)_` tag predicate must be `gate !== 'none'`, not
// `gate === 'admin'` — the latter silently drops the tag for any FUTURE gate
// value (T3 regrades `/new`'s gate to `'admin-shared-scope'`; a value outside
// today's CommandGate union — 'none' | 'admin', command-registry.ts:15).
//
// The real COMMAND_REGISTRY has no entry with a third gate value to exercise
// this, so this file mocks command-registry.ts's COMMAND_REGISTRY export and
// drives the PRODUCTION renderHelp/renderHelpDetail against a controlled
// 3-row fixture (gate: 'none' / 'admin' / a future non-none-non-admin value).
// vi.mock's factory return isn't type-checked against the real module shape,
// so no CommandGate cast is needed to hold the future gate literal — the
// fixture below is plain data, not constructed against the CommandSpec type.
vi.mock('../../../src/runtimes/agent/command-registry.ts', () => ({
  COMMAND_REGISTRY: [
    {
      name: 'plain',
      summary: 'fixture: no gate',
      syntax: '/plain',
      tier: 'transport-local',
      gate: 'none',
      visibility: 'end-user',
      errorClasses: [],
    },
    {
      name: 'admin-only',
      // Summary deliberately avoids the substring "admin" so the detail
      // assertion below (checking for the literal gateNote text) can't
      // pass vacuously off the summary text instead of the predicate.
      summary: 'fixture: restricted-gate command',
      syntax: '/admin-only',
      tier: 'transport-local',
      gate: 'admin',
      visibility: 'end-user',
      errorClasses: [],
    },
    {
      // T3's future gate value for /new (packet §W1-T3 ripple, line 509) —
      // outside today's CommandGate union. Proves the predicate is
      // correct-by-construction for any future gate, not just 'admin'.
      // Summary again avoids "admin" for the same reason as above.
      name: 'future-gated',
      summary: 'fixture: future non-none, restricted-gate command',
      syntax: '/future-gated',
      tier: 'transport-local',
      gate: 'admin-shared-scope',
      visibility: 'end-user',
      errorClasses: [],
    },
  ],
}));

const { renderHelp, renderHelpDetail } = await import('../../../src/runtimes/agent/help-render.ts');

// G34: the gate NOTE (renderHelpDetail's trailing text) is scope-accurate per
// gate VALUE, not a single "(admin only)" fired by `gate !== 'none'` — that
// wording is wrong for 'admin-shared-scope' (admin only in groups/shared
// sessions; OPEN in a 1:1 DM). The `_(admin)_` LIST tag stays keyed off
// `gate !== 'none'` (D4, untouched by G34) — expectTag covers that axis;
// gateNote covers the detail-note axis, checked exhaustively below so a
// value can only pass by rendering EXACTLY its own note, never another's.
const ALL_GATE_NOTES = [' (admin only)', ' (admin in groups & shared sessions)'] as const;

const CASES = [
  { name: 'plain', expectTag: false, gateNote: '' },
  { name: 'admin-only', expectTag: true, gateNote: ' (admin only)' },
  { name: 'future-gated', expectTag: true, gateNote: ' (admin in groups & shared sessions)' }, // T3's admin-shared-scope gate value — see mock comment above
] as const;

describe('_(admin)_ tag predicate over a fixture registry (RED bed, packet §W1-T5 step 3 / §W1-T3 ripple line 509)', () => {
  it.each(CASES)(
    '$name: _(admin)_ tag present iff gate !== "none" (expectTag=$expectTag); gate note is scope-accurate per gate value (G34)',
    ({ name, expectTag, gateNote }) => {
      const list = renderHelp({ nlRouting: false });
      const line = list.split('\n').find((l) => l.includes(`*/${name}*`));
      expect(line).toBeDefined();
      expect(line?.includes('_(admin)_')).toBe(expectTag);

      // Check the exact gateNote text, not a bare "admin" substring — the
      // fixture summaries are scrubbed of "admin" (see mock above) so this
      // assertion can only pass via the :89 gateNote predicate itself, not
      // by accidentally matching the summary text (non-vacuous check).
      // Exhaustive over ALL known note wordings: a case can only pass by
      // rendering its OWN note and NEITHER other note (e.g. 'admin-shared-
      // scope' must NOT render the bare "(admin only)" — G34).
      const detail = renderHelpDetail(name);
      for (const note of ALL_GATE_NOTES) {
        expect(detail.includes(note)).toBe(note === gateNote);
      }
    },
  );
});
