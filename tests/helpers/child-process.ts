import { EventEmitter } from 'node:events';
import { vi } from 'vitest';

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

export function mockChildProcess() {
  const child = new EventEmitter() as EventEmitter & {
    on: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
    stdout: EventEmitter;
    stderr: EventEmitter;
    pid: number;
    kill: ReturnType<typeof vi.fn>;
  };
  const on = child.on.bind(child);
  child.on = vi.fn((event: string, listener: (...args: unknown[]) => void) => on(event, listener));
  child.unref = vi.fn(() => child);
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 12345;
  child.kill = vi.fn(() => true);
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
