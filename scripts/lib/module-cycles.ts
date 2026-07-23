/**
 * Cycle detection over a module import graph — Tarjan's SCC algorithm, iterative.
 *
 * WHY THIS EXISTS. `guard:boundaries` checks import DIRECTION (which layer may import
 * which). Nothing in this repo checks for CYCLES. Verified on origin/main `f3bda5941`: the
 * only `cyclic` matches under `scripts/` and `tests/` are unrelated (cyclic object
 * references in fixtures, cyclic error-cause chains).
 *
 * WHY THE GUARD SHIPS WITH AN EMPTY BASELINE. Measured AST-accurately over `src/` before
 * this was written: 433 modules, 1176 runtime import edges, ZERO cycles. A regex prototype
 * had reported 3 candidate cycles; all three were artifacts of counting `import type`
 * edges, which TypeScript erases at runtime and which therefore cannot participate in a
 * runtime cycle (`src/` has 494 of them). The zero was proven non-vacuous: 1190 relative
 * specifiers seen, 1190 resolved, 0 unresolved — no edge was silently dropped.
 *
 * PURE by design: no fs, no ts, no process. The graph is built elsewhere and handed in, so
 * these rules are testable directly and the same function can serve any future consumer
 * that already has a graph.
 *
 * ITERATIVE, not recursive. The textbook Tarjan is written recursively and blows the stack
 * on a deep chain; `src/` is 433 modules today with no guarantee it stays small, and a
 * guard that crashes on growth is worse than no guard. A 5000-node chain is covered by a
 * test, together with a cycle at the END of that chain so the deep case cannot pass merely
 * because traversal gave up early.
 */

/** `module path -> set of module paths it imports at runtime`. */
export type ModuleGraph = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * Every cycle in the graph, each as a sorted list of member paths.
 *
 * Returns strongly-connected components of size > 1, PLUS single nodes that import
 * themselves — a self-import is a real cycle, and the usual "size > 1" filter misses it
 * because its SCC has exactly one member.
 *
 * Components are sorted internally and the result is sorted overall, so output is stable
 * across runs and diffable in a gate log.
 */
export function findCycles(graph: ModuleGraph): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  let nextIndex = 0;

  // Explicit work stack: each frame is a node plus how far through its edges we have got.
  type Frame = { node: string; edges: string[]; edgeIndex: number };

  for (const root of graph.keys()) {
    if (index.has(root)) continue;

    const work: Frame[] = [{ node: root, edges: [...(graph.get(root) ?? [])], edgeIndex: 0 }];
    index.set(root, nextIndex);
    low.set(root, nextIndex);
    nextIndex += 1;
    stack.push(root);
    onStack.add(root);

    while (work.length > 0) {
      const frame = work[work.length - 1]!;

      if (frame.edgeIndex < frame.edges.length) {
        const next = frame.edges[frame.edgeIndex]!;
        frame.edgeIndex += 1;

        // An edge can point outside the scanned scope (node_modules, a .d.ts, a path that
        // did not resolve). Such a target has no entry of its own and cannot close a cycle
        // within the graph, so it is skipped rather than treated as a node.
        if (!graph.has(next)) continue;

        if (!index.has(next)) {
          index.set(next, nextIndex);
          low.set(next, nextIndex);
          nextIndex += 1;
          stack.push(next);
          onStack.add(next);
          work.push({ node: next, edges: [...(graph.get(next) ?? [])], edgeIndex: 0 });
        } else if (onStack.has(next)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(next)!));
        }
        continue;
      }

      // All edges explored: this frame is finished.
      work.pop();
      const parent = work[work.length - 1];
      if (parent) {
        low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
      }

      if (low.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        let member: string;
        do {
          member = stack.pop()!;
          onStack.delete(member);
          component.push(member);
        } while (member !== frame.node);

        const isSelfImport =
          component.length === 1 && (graph.get(component[0]!)?.has(component[0]!) ?? false);
        if (component.length > 1 || isSelfImport) {
          cycles.push(component.sort());
        }
      }
    }
  }

  return cycles.sort((a, b) => a.join(',').localeCompare(b.join(',')));
}
