// src/runtimes/agent/tree-liveness.ts
// CPU-progress liveness assessment for a provider process tree.
//
// The stalled-operation kill and the hard turn watchdog both infer "hung" from
// stream silence: no stream-json events for N minutes ⇒ kill. That premise is
// false for long single tool calls: browser automation, long shell steps, or
// tool-protocol operations can block the
// provider's event stream for far longer than any fixed threshold while the
// process tree underneath is doing real work. Killing on stream silence alone
// can terminate healthy jobs mid-run.
//
// This module gives those kill paths a second signal: cumulative CPU time of
// the provider's process tree, sampled twice across a short window. A tree
// that burns CPU or changes shape (new children) between samples is WORKING —
// the caller extends its deadline instead of killing. A flat tree is genuinely
// hung and the existing kill proceeds.
//
// Deliberately kept off any dependency chain that could reach session.ts:
// `ps` is invoked directly (portable across macOS and Linux) rather than via
// process-tree.ts, and the only project import is process-tree-parse.ts, a
// zero-import leaf shared with process-tree.ts's kill path (#2223) — so this
// still cannot import from session.ts (import cycle: session.ts already
// imports both this module and process-tree.ts) and works identically on
// launchd and systemd fleet hosts.

import { execFile } from 'node:child_process';
import { createChildLogger } from '../../logger.ts';
import { bfsFromRoot, buildChildrenIndex, parsePsLines } from './process-tree-parse.ts';

const log = createChildLogger('tree-liveness');

/** One `ps` census of a process tree. */
export interface TreeCpuSample {
  /** PIDs in the tree at sample time (root first, BFS order). */
  pids: number[];
  /** Sum of cumulative CPU time across the tree, in milliseconds. */
  cpuMs: number;
}

/** Verdict from a two-sample liveness assessment. */
export interface TreeLivenessVerdict {
  /** True when the tree showed CPU progress or structural change. */
  alive: boolean;
  /** CPU-time delta between the two samples (ms). Negative deltas clamp to 0. */
  cpuDeltaMs: number;
  /** PID-set change between samples (additions + removals). */
  pidChurn: number;
  /** Tree size at the second sample. */
  pidCount: number;
}

/** Default observation window between the two CPU samples. */
export const TREE_LIVENESS_WINDOW_MS = 5_000;
/** Minimum CPU delta across the window that counts as "working". */
export const TREE_LIVENESS_MIN_CPU_DELTA_MS = 200;

function execPs(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('ps', args, { timeout: 4_000 }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

/** One `ps -o pid=,ppid=` row (no header — `=` suffix suppresses it). */
interface PidPpidRow {
  pid: number;
  ppid: number;
}

/**
 * Enumerate rootPid's descendant tree (root always included, regardless of
 * whether rootPid itself appears in the census — this is an advisory
 * liveness signal, not a kill decision, so it does not require the root to
 * resolve to a unique census row the way process-tree.ts's kill path does).
 */
async function listTreePids(rootPid: number): Promise<number[] | null> {
  const out = await execPs(['-e', '-o', 'pid=,ppid=']);
  if (out === null) return null;
  const rows = parsePsLines<PidPpidRow>(out, (line) => {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!m) return null;
    return { pid: Number(m[1]), ppid: Number(m[2]) };
  });
  const childrenIndex = buildChildrenIndex(rows, (row) => row.ppid);
  // Synthetic root row: rootPid may not appear as its own census entry
  // (already exited), but its children still resolve via the index. -1 is
  // a sentinel ppid that never collides with a real ppid (always >= 0).
  const walked = bfsFromRoot(childrenIndex, { pid: rootPid, ppid: -1 }, (row) => row.pid);
  return walked.map(({ row }) => row.pid);
}

/** Parse a `ps -o time=` value ([[dd-]hh:]mm:ss[.cc]) into milliseconds. */
export function parsePsTimeMs(raw: string): number | null {
  const m = raw.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const days = Number(m[1] ?? 0);
  const hours = Number(m[2] ?? 0);
  const minutes = Number(m[3]);
  const seconds = Number(m[4]);
  return Math.round(((days * 24 + hours) * 3600 + minutes * 60 + seconds) * 1000);
}

/**
 * Sample the cumulative CPU time of rootPid's process tree. Returns null when
 * the root is already gone (nothing to assess — the exit handler owns cleanup).
 */
export async function sampleTreeCpuMs(rootPid: number): Promise<TreeCpuSample | null> {
  const pids = await listTreePids(rootPid);
  if (pids === null || pids.length === 0) return null;
  const out = await execPs(['-o', 'time=', '-p', pids.join(',')]);
  if (out === null) return null;
  let cpuMs = 0;
  let parsed = 0;
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const ms = parsePsTimeMs(line);
    if (ms !== null) {
      cpuMs += ms;
      parsed += 1;
    }
  }
  if (parsed === 0) return null;
  return { pids, cpuMs };
}

/**
 * Two-sample CPU-progress assessment of rootPid's tree.
 *
 * Returns null when the tree cannot be observed (root already exited, `ps`
 * unavailable) — callers MUST treat null as "no exoneration" and proceed with
 * their existing kill, never as proof of life.
 */
export async function assessTreeLiveness(
  rootPid: number,
  opts: { windowMs?: number; minCpuDeltaMs?: number } = {},
): Promise<TreeLivenessVerdict | null> {
  const windowMs = opts.windowMs ?? TREE_LIVENESS_WINDOW_MS;
  const minCpuDeltaMs = opts.minCpuDeltaMs ?? TREE_LIVENESS_MIN_CPU_DELTA_MS;
  const first = await sampleTreeCpuMs(rootPid);
  if (first === null) return null;
  await new Promise((resolve) => setTimeout(resolve, windowMs));
  const second = await sampleTreeCpuMs(rootPid);
  if (second === null) return null;
  const cpuDeltaMs = Math.max(0, second.cpuMs - first.cpuMs);
  const before = new Set(first.pids);
  const after = new Set(second.pids);
  let pidChurn = 0;
  for (const pid of after) if (!before.has(pid)) pidChurn += 1;
  for (const pid of before) if (!after.has(pid)) pidChurn += 1;
  const verdict: TreeLivenessVerdict = {
    alive: cpuDeltaMs >= minCpuDeltaMs || pidChurn > 0,
    cpuDeltaMs,
    pidChurn,
    pidCount: second.pids.length,
  };
  log.debug({ rootPid, ...verdict, windowMs, minCpuDeltaMs }, 'tree liveness assessed');
  return verdict;
}
