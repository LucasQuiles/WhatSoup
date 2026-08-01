// src/runtimes/agent/process-tree-parse.ts
// Pure, I/O-free helpers shared by process-tree.ts (sync kill path, 5-field
// `ps` census) and tree-liveness.ts (async liveness path, 2-field `ps`
// census): split `ps` stdout into rows, index rows by parent pid, and BFS
// a tree of descendants from a caller-supplied root. #2223.
//
// Deliberately zero project imports. process-tree.ts and tree-liveness.ts
// must never import from each other (tree-liveness.ts's header documents why:
// session.ts already imports both, so either file importing the other risks
// a future cycle). This module exists so both can share the common
// parse/BFS shape without either depending on the other — it cannot
// participate in an import cycle because it has nothing to import back.
//
// Each call site keeps its own row shape (field count/layout differs) and,
// critically, its own root-resolution semantics: process-tree.ts requires
// the root to resolve to exactly one census row before it will act (a
// kill-path safety invariant — never signal an ambiguous/duplicate-pid
// root), while tree-liveness.ts always includes the root regardless of
// census presence (an advisory liveness signal, not a kill decision). That
// difference is NOT unified here — `bfsFromRoot` takes an already-resolved
// root row and walks from there; how a caller resolves/validates that root
// is entirely up to the caller.

/**
 * Split `ps` stdout into lines, optionally dropping a header line, and
 * collect the non-null results of a per-line parser. The parser owns the
 * field layout/regex for its own `ps` invocation.
 */
export function parsePsLines<T>(
  output: string,
  parseLine: (line: string) => T | null,
  opts: { skipHeaderLine?: boolean } = {},
): T[] {
  const lines = output.split('\n');
  const body = opts.skipHeaderLine ? lines.slice(1) : lines;
  const rows: T[] = [];
  for (const line of body) {
    const row = parseLine(line);
    if (row !== null) rows.push(row);
  }
  return rows;
}

/** Build a parent-pid -> child-rows adjacency index over already-parsed rows. */
export function buildChildrenIndex<T>(
  rows: readonly T[],
  parentPidOf: (row: T) => number,
): Map<number, T[]> {
  const index = new Map<number, T[]>();
  for (const row of rows) {
    const ppid = parentPidOf(row);
    const list = index.get(ppid);
    if (list) list.push(row);
    else index.set(ppid, [row]);
  }
  return index;
}

/**
 * Breadth-first walk of descendants from an already-resolved root row,
 * returning each visited row with its BFS depth (root is depth 0). A
 * `seen` set guards against revisiting a pid (defensive; a well-formed
 * `ps` census has no ppid cycles, but a census race could otherwise repeat
 * a row). Root-resolution/validation is the caller's responsibility — this
 * function only walks from whatever row it is given.
 */
export function bfsFromRoot<T>(
  childrenIndex: ReadonlyMap<number, readonly T[]>,
  rootRow: T,
  pidOf: (row: T) => number,
): Array<{ row: T; depth: number }> {
  const result: Array<{ row: T; depth: number }> = [];
  const queue: Array<{ row: T; depth: number }> = [{ row: rootRow, depth: 0 }];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next || seen.has(pidOf(next.row))) continue;
    seen.add(pidOf(next.row));
    result.push(next);
    for (const child of childrenIndex.get(pidOf(next.row)) ?? []) {
      queue.push({ row: child, depth: next.depth + 1 });
    }
  }
  return result;
}
