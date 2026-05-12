import { EventEmitter } from 'node:events';
import { vi } from 'vitest';

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

export function mockChildProcess() {
  const child = new EventEmitter() as EventEmitter & {
    on: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
  };
  const on = child.on.bind(child);
  child.on = vi.fn((event: string, listener: (...args: unknown[]) => void) => on(event, listener));
  child.unref = vi.fn(() => child);
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
  const execFileSync = vi.fn(() => Buffer.from(''));

  return {
    spawn: vi.fn((..._args: unknown[]) => mockChildProcess()),
    execFile,
    execFileSync,
  };
}
