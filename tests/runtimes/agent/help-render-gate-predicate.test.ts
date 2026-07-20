import { describe, it, expect } from 'vitest';
import { renderHelp, renderHelpDetail } from '../../../src/runtimes/agent/help-render.ts';
import { COMMAND_REGISTRY } from '../../../src/runtimes/agent/command-registry.ts';

// B21-B (QB-7 premise refresh + GATE_PRESENTATION conversion): this file
// originally MOCKED command-registry.ts to smuggle a gate value beyond the
// then-2-value CommandGate union ('none' | 'admin') and prove the tag
// predicate handled a future gate at runtime. Both premises are stale:
//  - since T3 the union has THREE values and the real registry exercises
//    every one ('status' → 'none', 'sessions' → 'admin', 'new' →
//    'admin-shared-scope'), so no synthetic future-gate fixture is needed
//    to reach the third branch; and
//  - gate presentation is now a single GATE_PRESENTATION table (a Record
//    over the CommandGate union, command-registry.ts), so "a future gate
//    value renders correctly" is a COMPILE-TIME guarantee — adding a gate
//    value without a table row is a type error, not a silent render gap.
// The mock harness is therefore obsolete; this file now drives the REAL
// registry and asserts each gate value renders EXACTLY its own list tag and
// detail note (G34 wording), never another's.
//
// Non-vacuity: the assertions below check the exact tag/note strings, and no
// real command summary contains ' (admin' or '_(admin' — so a case can only
// pass via the GATE_PRESENTATION lookup itself, not summary text.
const ALL_LIST_TAGS = [' _(admin)_', ' _(admin in groups & shared sessions)_'] as const;
const ALL_GATE_NOTES = [' (admin only)', ' (admin in groups & shared sessions)'] as const;

const CASES = [
  { name: 'status', gate: 'none', listTag: '', gateNote: '' },
  { name: 'sessions', gate: 'admin', listTag: ' _(admin)_', gateNote: ' (admin only)' },
  {
    name: 'new',
    gate: 'admin-shared-scope',
    listTag: ' _(admin in groups & shared sessions)_',
    gateNote: ' (admin in groups & shared sessions)',
  },
] as const;

describe('gate presentation over the real registry (B21-B, ex-mock harness)', () => {
  it('fixture adequacy: the real registry covers all three CommandGate values', () => {
    // Guards the conversion premise: if a regrade ever drops a gate value
    // from the live registry, this test's coverage claim dies loudly instead
    // of silently thinning to two branches.
    expect(new Set(COMMAND_REGISTRY.map((c) => c.gate))).toEqual(
      new Set(['none', 'admin', 'admin-shared-scope']),
    );
  });

  it.each(CASES)(
    '$name (gate: $gate): list line and detail render EXACTLY their own tag/note',
    ({ name, gate, listTag, gateNote }) => {
      // Pin the case's gate to the live registry row so a regrade can't let
      // an expectation drift silently.
      expect(COMMAND_REGISTRY.find((c) => c.name === name)?.gate).toBe(gate);

      const list = renderHelp({ nlRouting: false });
      const line = list.split('\n').find((l) => l.includes(`*/${name}*`));
      expect(line).toBeDefined();
      // Exhaustive over ALL known tag wordings: a case passes only by
      // rendering its OWN tag and NEITHER other — e.g. 'admin-shared-scope'
      // must NOT render the bare '_(admin)_' (the list-side G34 analogue).
      for (const tag of ALL_LIST_TAGS) {
        expect(line?.includes(tag)).toBe(tag === listTag);
      }

      const detail = renderHelpDetail(name, { nlRouting: false });
      // Same exhaustive check on the detail-note axis (G34): exact note text,
      // never another value's note.
      for (const note of ALL_GATE_NOTES) {
        expect(detail.includes(note)).toBe(note === gateNote);
      }
    },
  );
});
