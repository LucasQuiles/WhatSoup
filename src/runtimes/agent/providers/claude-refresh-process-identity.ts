import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export type RefreshProcessObservation =
  | { state: 'alive'; birthToken: string }
  | { state: 'absent' | 'unknown' };

interface ProcessIdentityDeps {
  platform?: NodeJS.Platform;
  signal?: (pid: number, signal: 0) => unknown;
  read?: (path: string) => string;
  command?: (file: string, args: string[], env: NodeJS.ProcessEnv) => string;
}

const IDENTITY_ENV = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC' };

// PROC_PIDUNIQIDENTIFIERINFO distinguishes PID reuse even within one clock tick.
const DARWIN_UNIQUE_ID = `
import ctypes
import sys
class Identity(ctypes.Structure):
    _fields_ = [('uuid', ctypes.c_ubyte * 16), ('unique', ctypes.c_uint64),
                ('parent', ctypes.c_uint64), ('version', ctypes.c_int32),
                ('parent_version', ctypes.c_int32), ('reserved2', ctypes.c_uint64),
                ('reserved3', ctypes.c_uint64)]
call = ctypes.CDLL('/usr/lib/libproc.dylib').proc_pidinfo
call.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
call.restype = ctypes.c_int
identity = Identity()
size = ctypes.sizeof(identity)
if size != 56 or call(int(sys.argv[1]), 17, 0, ctypes.byref(identity), size) != size or identity.unique == 0:
    raise SystemExit(1)
print(identity.unique)
`;

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
  const command = deps.command ?? ((file, args, env) => execFileSync(file, args, {
    encoding: 'utf8', env, timeout: 1_000, maxBuffer: 4_096, stdio: ['ignore', 'pipe', 'ignore'],
  }));
  let birthToken: string;
  try {
    const platform = deps.platform ?? process.platform;
    if (platform === 'darwin') {
      const boot = /^\{\s*sec\s*=\s*(\d+),\s*usec\s*=\s*(\d+)\s*\}/.exec(
        command('/usr/sbin/sysctl', ['-n', 'kern.boottime'], IDENTITY_ENV).trim(),
      );
      const birth = command('python3', ['-I', '-S', '-c', DARWIN_UNIQUE_ID, String(pid)], IDENTITY_ENV).trim();
      const unique = birth.length <= 20 ? BigInt(birth) : 0n;
      if (!boot || !Number.isSafeInteger(Number(boot[1])) || Number(boot[1]) <= 0
        || !Number.isSafeInteger(Number(boot[2])) || Number(boot[2]) > 999_999
        || unique <= 0n || unique > 18_446_744_073_709_551_615n || unique.toString() !== birth) {
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
