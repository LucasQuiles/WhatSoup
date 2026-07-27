/**
 * Baseline weight — the measurement behind "a baseline may only shrink".
 *
 * WHY THIS EXISTS. This repo carries 7 committed baseline files that enumerate tolerated
 * debt (known boundary violations, grandfathered lint warnings, accepted test-integrity
 * findings). Every one of them is actively read by a guard, and every one of those guards
 * compares CURRENT CODE against the baseline — which is the wrong direction to catch the
 * failure this module addresses.
 *
 * Measured on origin/main 084908d91 before writing this:
 *   - 7 baseline files, referenced by 1..22 scripts/tests each
 *   - ZERO assertions anywhere in tests/ or scripts/ that a baseline cannot GROW
 *
 * So the debt ceiling is enforced against the code, and nothing enforces the ceiling
 * itself. `check-shadow-baseline.mjs --update` and `check-design-burndown.mjs --update`
 * rewrite their baselines wholesale; a commit that adds a violation and re-runs `--update`
 * passes every gate in the repo. That is the "auto-institutionalized debt" failure class.
 *
 * The weight is deliberately shape-aware rather than byte- or line-based: these files have
 * five distinct shapes, and a line count would move on reformatting while missing a raised
 * ceiling.
 */
import { describe, expect, it } from 'vitest';

import {
  BASELINE_REGISTRY,
  type BaselineShape,
  compareWeights,
  weighBaseline,
} from '../../scripts/lib/baseline-weight.ts';

const weigh = (shape: BaselineShape, json: unknown) => weighBaseline(shape, json);

describe('weighBaseline — one number per shape, higher means more tolerated debt', () => {
  it('flat-array baselines weigh their entry count', () => {
    // boundary-baseline.json, transport-patterns-baseline.json
    expect(weigh('entry-array', [{ file: 'a' }, { file: 'b' }])).toBe(2);
    expect(weigh('entry-array', [])).toBe(0);
  });

  it('single-array-object baselines weigh the wrapped array, whatever its key', () => {
    // .claude/test-integrity/baseline.json uses `findings`; service-units-baseline.json
    // uses `grandfathered` alongside a `_comment` string. Keying on the SHAPE rather than
    // on the property name is what stops a differently-named wrapper from weighing 0.
    expect(weigh('single-array-object', { findings: [{ file: 'a' }, { file: 'b' }, { file: 'c' }] })).toBe(3);
    expect(weigh('single-array-object', { _comment: 'why', grandfathered: [] })).toBe(0);
    expect(weigh('single-array-object', { _comment: 'why', grandfathered: ['a::B'] })).toBe(1);
  });

  it('THROWS when a wrapper object is ambiguous rather than guessing', () => {
    expect(() => weigh('single-array-object', { a: [1], b: [2] })).toThrow(/ambiguous/);
  });

  it('fitness rules weigh violationCount rules as well as measurement rules', () => {
    // .claude/fitness/baseline.json holds BOTH shapes: arch.file-size has `measurements`,
    // every arch.ssot-* rule has a bare `violationCount`. Handling only the first made the
    // whole file unweighable, and the caller then dropped it silently.
    expect(weigh('fitness-rules', { rules: { 'arch.ssot-lid-reads': { violationCount: 4 } } })).toBe(4);
    expect(() => weigh('fitness-rules', { rules: { 'arch.x': { somethingElse: 1 } } })).toThrow(
      /measurements.*violationCount/,
    );
  });

  it('count-map baselines weigh the SUM of their counts, not the number of keys', () => {
    // lint-shadow-baseline.json / design-burndown-baseline.json. Raising one rule's
    // ceiling from 1 to 9 tolerates 8 more violations while the key count is unchanged —
    // counting keys would call that no change.
    expect(weigh('count-map', { rules: { 'a :: x.tsx': 1, 'b :: y.tsx': 2 } })).toBe(3);
    expect(weigh('count-map', { categories: { 'half-step': 55, 'utility-smell': 1 } })).toBe(56);
  });

  it('fitness-rules baselines weigh measurements AND their ceilings', () => {
    // .claude/fitness/baseline.json. A raised maxLines is tolerated debt even though the
    // measurement count is identical, so the ceiling has to be part of the weight.
    const one = { rules: { 'arch.file-size': { measurements: [{ filePath: 'a.ts', lines: 100, maxLines: 100 }] } } };
    const raised = { rules: { 'arch.file-size': { measurements: [{ filePath: 'a.ts', lines: 100, maxLines: 500 }] } } };
    expect(weigh('fitness-rules', raised)).toBeGreaterThan(weigh('fitness-rules', one));
  });

  it('THROWS on a malformed document rather than weighing it as 0', () => {
    // A parse/shape failure must never read as "no tolerated debt" — that is the exact
    // false green this module exists to prevent. Callers turn the throw into INCONCLUSIVE.
    expect(() => weigh('entry-array', { notAnArray: true })).toThrow(/expected an array/i);
    expect(() => weigh('single-array-object', {})).toThrow(/findings/i);
    expect(() => weigh('count-map', { rules: { a: 'not-a-number' } })).toThrow(/numeric/i);
    expect(() => weigh('entry-array', null)).toThrow();
  });
});

describe('compareWeights — growth blocks, shrink passes', () => {
  it('reports growth as a violation naming the delta', () => {
    const found = compareWeights([{ id: 'x', path: 'p.json', base: 10, head: 14 }]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id: 'x', base: 10, head: 14, delta: 4 });
  });

  it('permits shrinking and permits no change', () => {
    expect(compareWeights([{ id: 'x', path: 'p.json', base: 10, head: 3 }])).toEqual([]);
    expect(compareWeights([{ id: 'x', path: 'p.json', base: 10, head: 10 }])).toEqual([]);
  });

  it('blocks constant-count identity replacement and preserves multiset multiplicity', () => {
    const replaced = compareWeights([{
      id: 'x',
      path: 'p.json',
      base: 2,
      head: 2,
      baseIdentities: ['old', 'kept'],
      headIdentities: ['new', 'kept'],
    }]);
    expect(replaced).toHaveLength(1);
    expect(replaced[0]?.message).toMatch(/new|identity|subset/i);

    const duplicated = compareWeights([{
      id: 'x',
      path: 'p.json',
      base: 2,
      head: 2,
      baseIdentities: ['old', 'kept'],
      headIdentities: ['kept', 'kept'],
    }]);
    expect(duplicated).toHaveLength(1);
  });

  it('permits an identity multiset that is a true subset of the base', () => {
    expect(compareWeights([{
      id: 'x',
      path: 'p.json',
      base: 3,
      head: 2,
      baseIdentities: ['same', 'same', 'removed'],
      headIdentities: ['same', 'same'],
    }])).toEqual([]);
  });

  it('treats an unreadable BASE as inconclusive, never as growth or as clean', () => {
    // null base = "could not look" (new file, or base revision unavailable). Reporting it
    // as growth would be a false alarm; reporting it as clean would be a false green.
    const found = compareWeights([{ id: 'x', path: 'p.json', base: null, head: 14 }]);
    expect(found).toHaveLength(1);
    expect(found[0].inconclusive).toBe(true);
  });
});

describe('BASELINE_REGISTRY — the scan cannot go vacuous', () => {
  it('covers every baseline file that exists in the tree', () => {
    // If a new baseline file is added and not registered, this guard would silently not
    // watch it. The companion CLI test asserts the registry against the real tree.
    expect(BASELINE_REGISTRY.length).toBeGreaterThanOrEqual(7);
  });

  it('every registered entry has a distinct id and path', () => {
    const ids = BASELINE_REGISTRY.map((b) => b.id);
    const paths = BASELINE_REGISTRY.map((b) => b.path);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('pins the catch-ratchet baseline to its audited introduction ceiling', () => {
    expect(
      BASELINE_REGISTRY.find((entry) => entry.id === 'catch-justification'),
    ).toMatchObject({
      path: 'eslint-rules/catch-ratchet-baseline.json',
      shape: 'entry-array',
      initialWeight: 127,
    });
  });
});
