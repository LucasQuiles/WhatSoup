import { EventEmitter } from 'node:events';
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
