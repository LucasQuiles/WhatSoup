import { EventEmitter } from 'node:events';
import type { ExecFileSyncOptions } from 'node:child_process';
import { vi, type Mock } from 'vitest';

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;
type MockChild = Omit<EventEmitter, 'on'> & {
  on: Mock<(event: string, listener: (...args: unknown[]) => void) => MockChild>;
  unref: Mock<() => MockChild>;
  stdout: EventEmitter;
  stderr: EventEmitter;
  pid: number;
  kill: Mock<(signal?: string) => boolean>;
};

export function mockChildProcess(): MockChild {
  const child = new EventEmitter() as unknown as MockChild;
  const on = EventEmitter.prototype.on.bind(child as unknown as EventEmitter);
  child.on = vi.fn<(event: string, listener: (...args: unknown[]) => void) => MockChild>((event, listener) => {
    on(event, listener);
    return child;
  });
  child.unref = vi.fn<() => MockChild>(() => child);
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 12345;
  child.kill = vi.fn<(signal?: string) => boolean>(() => true);
  return child;
}

export function childProcessMock() {
  const execFile = vi.fn((...args: unknown[]) => {
    const callback = [...args].reverse().find((arg): arg is ExecFileCallback => typeof arg === 'function');
    if (callback) {
      process.nextTick(() => callback(null, '', ''));
    }
    return mockChildProcess();
  });

  // execFileSync defaults to returning an empty Buffer; tests override via
  // .mockReturnValue() / .mockImplementation() for per-call behavior.
  const execFileSync = vi.fn((..._args: unknown[]) => Buffer.from(''));

  return {
    spawn: vi.fn((..._args: unknown[]) => mockChildProcess()),
    execFile,
    execFileSync,
  };
}

/** Lease identity and isolated file writers must observe real processes in route tests. */
export async function childProcessMockWithNativeOwnership(defaultSyncResult = Buffer.from('')) {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const mock = childProcessMock();
  mock.execFileSync.mockReturnValue(defaultSyncResult);
  return {
    ...mock,
    spawnSync: actual.spawnSync,
    execFileSync: vi.fn((command: string, args: readonly string[] = [], options?: ExecFileSyncOptions) => {
      const birth = command === 'ps' && args.length === 4 && args[0] === '-p'
        && /^\d+$/.test(args[1]!) && args[2] === '-o' && args[3] === 'lstart=';
      const boot = ['/usr/sbin/sysctl', '/sbin/sysctl', 'sysctl'].includes(command)
        && args.length === 2 && args[0] === '-n' && args[1] === 'kern.boottime';
      return birth || boot ? actual.execFileSync(command, args, options) : mock.execFileSync(command, args, options);
    }),
  };
}
