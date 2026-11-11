import { execFileSync } from 'node:child_process';
import { constants } from 'node:os';
import { SIGNAL } from './signals.ts';

type IdentityCommand = (file: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) => string;
interface IdentityDependencies {
  command?: IdentityCommand;
  now?: () => number;
}

const ENV = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC' };
const PYTHONS = ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'] as const;
const DEADLINE_MS = 1_000;
const OUTPUT_BYTES = 4_096;

// The stable unique ID survives exec; audit tokens are refreshed for each signal.
const HELPER = `
import ctypes
import errno
import sys

class Identity(ctypes.Structure):
    _fields_ = [('uuid', ctypes.c_ubyte * 16), ('unique', ctypes.c_uint64),
                ('parent', ctypes.c_uint64), ('version', ctypes.c_int32),
                ('reserved', ctypes.c_uint32), ('reserved2', ctypes.c_uint64),
                ('reserved3', ctypes.c_uint64)]

class AuditToken(ctypes.Structure):
    _fields_ = [('val', ctypes.c_uint32 * 8)]

lib = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
lib.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
lib.proc_pidinfo.restype = ctypes.c_int
pid = int(sys.argv[1])

def unique_id():
    identity = Identity()
    size = ctypes.sizeof(identity)
    if size != 56:
        raise RuntimeError('Unsupported identity layout')
    ctypes.set_errno(0)
    result = lib.proc_pidinfo(pid, 17, 0, ctypes.byref(identity), size)
    if result != size:
        if ctypes.get_errno() == errno.ESRCH:
            raise ProcessLookupError('Process absent')
        raise RuntimeError('Process identity unavailable')
    if identity.unique == 0:
        raise RuntimeError('Invalid process identity')
    return identity.unique

def signal_owned():
    expected = int(sys.argv[2])
    sig = int(sys.argv[3])
    system = ctypes.CDLL('/usr/lib/libSystem.B.dylib')
    task_self = ctypes.c_uint32.in_dll(system, 'mach_task_self_').value
    system.task_name_for_pid.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.POINTER(ctypes.c_uint32)]
    system.task_name_for_pid.restype = ctypes.c_int
    system.task_info.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32)]
    system.task_info.restype = ctypes.c_int
    system.mach_port_deallocate.argtypes = [ctypes.c_uint32, ctypes.c_uint32]
    system.mach_port_deallocate.restype = ctypes.c_int
    lib.proc_signal_with_audittoken.argtypes = [ctypes.POINTER(AuditToken), ctypes.c_int]
    lib.proc_signal_with_audittoken.restype = ctypes.c_int
    for _ in range(2):
        identity = unique_id()
        if identity != expected:
            return 'identity-changed'
        port = ctypes.c_uint32()
        try:
            if system.task_name_for_pid(task_self, pid, ctypes.byref(port)) != 0:
                return 'unavailable'
            token = AuditToken()
            count = ctypes.c_uint32(ctypes.sizeof(token) // ctypes.sizeof(ctypes.c_uint32))
            if system.task_info(port.value, 15, ctypes.byref(token), ctypes.byref(count)) != 0 or count.value != 8:
                return 'unavailable'
            identity = unique_id()
            if identity != expected:
                return 'identity-changed'
            # libproc converts syscall failure to an errno return value, not -1.
            result = lib.proc_signal_with_audittoken(ctypes.byref(token), sig)
            if result == 0:
                return 'delivered'
            if result != errno.ESRCH:
                return 'error:' + str(result)
        finally:
            if port.value:
                if system.mach_port_deallocate(task_self, port.value) != 0:
                    raise RuntimeError('Task port release failed')
    return 'retry-exhausted'

if len(sys.argv) == 2:
    identity = unique_id()
    print(identity)
else:
    try:
        print(signal_owned())
    except ProcessLookupError:
        print('absent')
`;

function validPid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0 && pid <= 2_147_483_647;
}

function validUniqueId(value: string): boolean {
  if (value.length === 0 || value.length > 20 || value[0] === '0' || /[^0-9]/u.test(value)) return false;
  return BigInt(value) <= 18_446_744_073_709_551_615n;
}

function command(args: string[], deps: IdentityDependencies): string {
  const now = deps.now ?? (() => performance.now());
  const deadline = now() + DEADLINE_MS;
  const execute: IdentityCommand = deps.command ?? ((file, argv, env, timeout) => execFileSync(file, argv, {
    encoding: 'utf8', env, timeout, killSignal: SIGNAL.KILL, maxBuffer: OUTPUT_BYTES,
    stdio: ['ignore', 'pipe', 'ignore'],
  }));
  for (const python of PYTHONS) {
    const timeout = Math.ceil(deadline - now());
    if (timeout <= 0) throw Object.assign(new Error('Darwin identity deadline exceeded'), { code: 'ETIMEDOUT' });
    try {
      const output = execute(python, ['-I', '-S', '-c', HELPER, ...args], ENV, timeout);
      if (now() > deadline) throw Object.assign(new Error('Darwin identity deadline exceeded'), { code: 'ETIMEDOUT' });
      if (typeof output !== 'string' || Buffer.byteLength(output, 'utf8') > OUTPUT_BYTES) {
        throw new Error('Darwin identity output exceeded its bound');
      }
      return output.trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  throw Object.assign(new Error('Darwin identity interpreter unavailable'), { code: 'ENOENT' });
}

export function readDarwinUniqueProcessId(pid: number, deps: IdentityDependencies = {}): string | null {
  if (!validPid(pid)) return null;
  try {
    const identity = command([String(pid)], deps);
    return validUniqueId(identity) ? identity : null;
  } catch {
    return null;
  }
}

export function signalDarwinProcess(
  pid: number,
  expectedUniqueId: string,
  signal: NodeJS.Signals,
  deps: IdentityDependencies = {},
): boolean {
  if (!validPid(pid) || pid <= 1 || !validUniqueId(expectedUniqueId) || !Object.hasOwn(constants.signals, signal)) {
    throw new Error('Invalid Darwin signal authority');
  }
  const result = command([String(pid), expectedUniqueId, String(constants.signals[signal])], deps);
  if (result === 'delivered') return true;
  if (result === 'absent' || result === 'identity-changed') return false;
  const errno = /^error:(\d+)$/u.exec(result);
  if (errno && Number(errno[1]) === constants.errno.EPERM) {
    throw Object.assign(new Error('Darwin process signal permission denied'), { code: 'EPERM' });
  }
  if (errno && Number(errno[1]) === constants.errno.EACCES) {
    throw Object.assign(new Error('Darwin process signal permission denied'), { code: 'EACCES' });
  }
  throw new Error('Darwin process signal identity unavailable');
}
