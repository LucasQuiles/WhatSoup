import { execFileSync } from 'node:child_process';
import type { KillSessionOutcome } from './process-tree.ts';

/**
 * The latest kill-tree outcome a SessionManager recorded. A per-chat reset that
 * times out waiting for the old provider pid reports it, so the timeout says
 * what the shutdown proved. Diagnostic only: no cleanup, state transition or
 * signal decision reads it.
 */
export interface LastKillTreeOutcome {
  readonly rootPid: number | null;
  readonly signal: NodeJS.Signals;
  readonly outcome: KillSessionOutcome['outcome'];
  readonly ambiguousPids: readonly number[];
  readonly durationMs: number;
  readonly escalated: boolean;
  /** Wall-clock ms when the outcome was recorded. */
  readonly at: number;
}

export interface KillTreeOutcomeSource {
  getLastKillTreeOutcome(): LastKillTreeOutcome | null;
}

const MAX_OBSERVATION_CHARS = 160;
const MAX_LISTED_PIDS = 8;

/**
 * One read-only ps observation of `pid`. Never throws: ps exits 1 when the pid
 * is gone, which reads as `not present`; any other failure reads as
 * `observation unavailable`.
 */
export function observeProcessIdentity(pid: number): string {
  try {
    // comm only, never the argument list: this text reaches logs, and argv can carry secrets.
    const output = execFileSync('ps', ['-o', 'pid=,lstart=,stat=,comm=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 1_000,
    });
    // Collapse lstart's padding and drop directory prefixes so a home path never reaches the text.
    const line = output.trim().split('\n')[0]?.replace(/\s+/g, ' ').replace(/\S*\//g, '') ?? '';
    return line === '' ? 'not present' : `ps: ${line.slice(0, MAX_OBSERVATION_CHARS)}`;
  } catch (err) {
    return (err as { status?: unknown } | null)?.status === 1 ? 'not present' : 'observation unavailable';
  }
}

/**
 * Bounded suffix for the reset exit timeout. Reads the outcome lazily and never
 * throws, so the caller's timeout error is raised whatever this finds.
 */
export function describeResetExitTimeout(
  source: KillTreeOutcomeSource,
  observation: string,
  now: number = Date.now(),
): string {
  let outcome: string;
  try {
    const last = source.getLastKillTreeOutcome();
    outcome = last === null ? 'none' : formatKillTreeOutcome(last, now);
  } catch {
    outcome = 'unavailable';
  }
  return `last kill-tree outcome: ${outcome}; pid observation: ${observation}`;
}

function formatKillTreeOutcome(last: LastKillTreeOutcome, now: number): string {
  const listed = last.ambiguousPids.slice(0, MAX_LISTED_PIDS).join(',');
  const unlisted = last.ambiguousPids.length - MAX_LISTED_PIDS;
  return `${last.outcome} rootPid=${last.rootPid ?? 'none'} signal=${last.signal} `
    + `ambiguousPids=[${listed}${unlisted > 0 ? `,+${unlisted} more` : ''}] `
    + `durationMs=${last.durationMs} escalated=${last.escalated} ageMs=${now - last.at}`;
}
