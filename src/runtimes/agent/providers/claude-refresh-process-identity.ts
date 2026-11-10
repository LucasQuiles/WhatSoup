import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readDarwinUniqueProcessId } from '../../../lib/darwin-process-identity.ts';

export type RefreshProcessObservation =
  | { state: 'alive'; birthToken: string }
  | { state: 'absent' | 'unknown' };

interface ProcessIdentityDeps {
  platform?: NodeJS.Platform;
  signal?: (pid: number, signal: 0) => unknown;
  read?: (path: string) => string;
  command?: (file: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs?: number) => string;
}

const IDENTITY_ENV = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC' };

/** A boot-bound identity independent of the observing parent's locale and timezone. */
export function inspectRefreshProcess(pid: number, deps: ProcessIdentityDeps = {}): RefreshProcessObservation {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { state: 'unknown' };
  const signal = deps.signal ?? ((target, value) => process.kill(target, value));
  const liveness = (): 'alive' | 'absent' | 'unknown' => {
    try {
      signal(pid, 0);
      return 'alive';
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'absent' : 'unknown';
    }
  };
  const first = liveness();
  if (first !== 'alive') return { state: first };
  const read = deps.read ?? ((path) => readFileSync(path, 'utf8'));
  const command = deps.command ?? ((file, args, env, timeoutMs = 1_000) => execFileSync(file, args, {
    encoding: 'utf8', env, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 4_096, stdio: ['ignore', 'pipe', 'ignore'],
  }));
  let birthToken: string;
  try {
    const platform = deps.platform ?? process.platform;
    if (platform === 'darwin') {
      const boot = /^\{\s*sec\s*=\s*(\d+),\s*usec\s*=\s*(\d+)\s*\}/.exec(
        command('/usr/sbin/sysctl', ['-n', 'kern.boottime'], IDENTITY_ENV).trim(),
      );
      const birth = readDarwinUniqueProcessId(pid, { command });
      if (birth === null) return { state: liveness() === 'absent' ? 'absent' : 'unknown' };
      if (!boot || !Number.isSafeInteger(Number(boot[1])) || Number(boot[1]) <= 0
        || !Number.isSafeInteger(Number(boot[2])) || Number(boot[2]) > 999_999) {
        return { state: 'unknown' };
      }
      birthToken = `refresh-owner-v2:darwin:${Number(boot[1])}.${boot[2]!.padStart(6, '0')}:${birth}`;
    } else if (platform === 'linux') {
      const boot = read('/proc/sys/kernel/random/boot_id').trim();
      const stat = read(`/proc/${pid}/stat`).trim();
      const end = stat.lastIndexOf(')');
      const start = stat.slice(end + 1).trim().split(/\s+/)[19];
      if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(boot)
        || !stat.startsWith(`${pid} (`) || end < 0 || !start || !/^\d+$/.test(start)) return { state: 'unknown' };
      birthToken = `refresh-owner-v1:linux:${boot.toLowerCase()}:${start}`;
    } else {
      return { state: 'unknown' };
    }
  } catch {
    return { state: liveness() === 'absent' ? 'absent' : 'unknown' };
  }
  const last = liveness();
  return last === 'alive' ? { state: 'alive', birthToken } : { state: last };
}
