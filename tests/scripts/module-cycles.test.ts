/**
 * Tarjan SCC over a module graph — the pure half of the import-cycle guard.
 *
 * WHY A CYCLE GUARD AT ALL. `guard:boundaries` checks import DIRECTION (which layer may
 * import which); nothing in this repo checks for cycles. Verified on origin/main
 * `f3bda5941`: the only `cyclic` matches under `scripts/` and `tests/` are unrelated
 * (cyclic object references in fixtures, cyclic error-cause chains).
 *
 * WHY THE BASELINE IS EMPTY. Measured AST-accurately over `src/` before writing this:
 * 433 modules, 1176 runtime import edges, **zero** multi-module cycles and zero self-loops.
 * A throwaway regex prototype had previously reported 3 candidate cycles; all three were
 * artifacts of counting `import type` edges, which TypeScript erases at runtime and which
 * therefore cannot participate in a runtime cycle. 494 such imports exist in `src/`.
 *
 * That means the guard ships green with NO baselined debt — the strongest form. Any cycle
 * it reports is new.
 */
import { describe, expect, it } from 'vitest';

import { findCycles, type ModuleGraph } from '../../scripts/lib/module-cycles.ts';

const graph = (entries: Record<string, string[]>): ModuleGraph =>
  new Map(Object.entries(entries).map(([k, v]) => [k, new Set(v)]));

describe('findCycles', () => {
  it('finds nothing in an acyclic graph', () => {
    expect(findCycles(graph({ 'a.ts': ['b.ts'], 'b.ts': ['c.ts'], 'c.ts': [] }))).toEqual([]);
  });

  it('finds a two-module cycle', () => {
    const found = findCycles(graph({ 'a.ts': ['b.ts'], 'b.ts': ['a.ts'] }));
    expect(found).toHaveLength(1);
    expect(found[0]).toEqual(['a.ts', 'b.ts']);
  });

  it('finds a three-module cycle and reports it sorted for stable output', () => {
    const found = findCycles(graph({ 'c.ts': ['a.ts'], 'a.ts': ['b.ts'], 'b.ts': ['c.ts'] }));
    expect(found).toHaveLength(1);
    expect(found[0]).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('reports a self-import as a cycle', () => {
    // A single node whose edge set contains itself is a genuine cycle, but a naive
    // "SCC size > 1" test misses it — the SCC has exactly one member.
    expect(findCycles(graph({ 'a.ts': ['a.ts'] }))).toEqual([['a.ts']]);
  });

  it('separates two independent cycles rather than merging them', () => {
    const found = findCycles(
      graph({ 'a.ts': ['b.ts'], 'b.ts': ['a.ts'], 'x.ts': ['y.ts'], 'y.ts': ['x.ts'], 'z.ts': [] }),
    );
    expect(found).toHaveLength(2);
    expect(found.map((c) => c.join(','))).toEqual(['a.ts,b.ts', 'x.ts,y.ts']);
  });

  it('handles an edge to a module absent from the graph without crashing', () => {
    // A target outside the scanned scope (node_modules, a .d.ts) has no entry of its own.
    expect(findCycles(graph({ 'a.ts': ['outside.ts'] }))).toEqual([]);
  });

  it('does not stack-overflow on a long chain', () => {
    // Recursive Tarjan on a 5000-deep chain is exactly where a naive implementation dies,
    // and src/ is 433 modules today with no guarantee it stays small.
    const entries: Record<string, string[]> = {};
    for (let i = 0; i < 5000; i++) entries[`m${i}.ts`] = [`m${i + 1}.ts`];
    entries['m5000.ts'] = [];
    expect(() => findCycles(graph(entries))).not.toThrow();
    expect(findCycles(graph(entries))).toEqual([]);
  });

  it('finds a cycle at the end of a long chain', () => {
    // Proves the deep-graph case is not passing merely because traversal gave up early.
    const entries: Record<string, string[]> = {};
    for (let i = 0; i < 5000; i++) entries[`m${i}.ts`] = [`m${i + 1}.ts`];
    entries['m5000.ts'] = ['m4999.ts'];
    const found = findCycles(graph(entries));
    expect(found).toHaveLength(1);
    expect(found[0]).toEqual(['m4999.ts', 'm5000.ts']);
  });
});
