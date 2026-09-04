import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PROCESS_IDENTITY_MAX_BATCH = 4_096;
const PROCESS_IDENTITY_DARWIN_TIMEOUT_MS = 250;
const PROCESS_IDENTITY_DARWIN_MAX_BUFFER_BYTES = 1_024 * 1_024;

/**
 * Numeric signaling is permitted only when the birth observation has finer
 * resolution than the PID-reuse interval exposed by the platform adapter.
 */
export function processBirthTokenSupportsNumericSignal(token: string): boolean {
  return /^linux-start:\d+$/u.test(token);
}

function normalizedPids(pids: readonly number[]): number[] | null {
  if (!Array.isArray(pids)) return null;
  const unique = new Set<number>();
  for (const pid of pids) {
    if (!Number.isSafeInteger(pid) || pid <= 1) return null;
    unique.add(pid);
    if (unique.size > PROCESS_IDENTITY_MAX_BATCH) return null;
  }
  return [...unique].sort((left, right) => left - right);
}

function linuxBirthToken(pid: number): string | null {
  try {
    const stat = readFileSync(join('/proc', String(pid), 'stat'), 'utf-8');
    const closeParen = stat.lastIndexOf(')');
    if (closeParen === -1) return null;
    const fields = stat.slice(closeParen + 2).split(' ');
    const starttime = fields[19];
    return starttime && /^\d+$/.test(starttime) ? `linux-start:${starttime}` : null;
  } catch {
    return null;
  }
}

function darwinBirthTokens(pids: readonly number[]): ReadonlyMap<number, string> | null {
  if (pids.length === 0) return new Map();
  try {
    const requested = new Set(pids);
    const output = execFileSync(
      'ps',
      ['-p', pids.join(','), '-o', 'pid=,lstart='],
      {
        encoding: 'utf-8',
        timeout: PROCESS_IDENTITY_DARWIN_TIMEOUT_MS,
        maxBuffer: PROCESS_IDENTITY_DARWIN_MAX_BUFFER_BYTES,
      },
    );
    const observed = new Map<number, string>();
    for (const rawLine of output.split('\n')) {
      const line = rawLine.trim();
      if (line.length === 0) continue;
      const match = line.match(/^(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)$/u);
      if (!match) return null;
      const pid = Number(match[1]);
      if (!requested.has(pid) || observed.has(pid)) return null;
      observed.set(pid, `darwin-lstart:${match[2]}`);
    }
    return observed;
  } catch {
    return null;
  }
}

/**
 * Observe a bounded PID set with one Darwin `ps` invocation or bounded Linux
 * procfs reads. Missing processes are omitted; malformed or unavailable batch
 * observation returns null so callers cannot infer identity from partial text.
 */
export function probeProcessBirthTokens(
  pids: readonly number[],
  platform: NodeJS.Platform = process.platform,
): ReadonlyMap<number, string> | null {
  const normalized = normalizedPids(pids);
  if (normalized === null) return null;
  if (platform === 'darwin') return darwinBirthTokens(normalized);
  if (platform !== 'linux') return null;
  const observed = new Map<number, string>();
  for (const pid of normalized) {
    const token = linuxBirthToken(pid);
    if (token !== null) observed.set(pid, token);
  }
  return observed;
}

/**
 * Probe a process's OS-assigned birth identity so callers can distinguish a
 * live process from a later process that reused the same PID. A null result is
 * inconclusive and must never grant signal or ownership authority.
 */
export function probeProcessBirthToken(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): string | null {
  return probeProcessBirthTokens([pid], platform)?.get(pid) ?? null;
}
