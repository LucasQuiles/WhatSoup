import childProcess, { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import {
  readDarwinUniqueProcessId,
  signalDarwinProcess,
} from '../../src/lib/darwin-process-identity.ts';

/**
 * Structured timing exemption: the kernel must exit both real children while
 * Node's main loop cannot reap them. An asynchronous wait would destroy that
 * state; each bounded pause is followed by a zombie-state assertion.
 */
function TIMING(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}

describe('Darwin process identity boundary', () => {
  it.each(['0', '-1', '+1', '01', '0x1', '1e2', '18446744073709551616', ''])('rejects malformed identity %s', (value) => {
    expect(readDarwinUniqueProcessId(4242, { command: () => value })).toBeNull();
  });

  it.each(['1', '9007199254740993', '18446744073709551615'])('retains exact uint64 identity %s', (value) => {
    expect(readDarwinUniqueProcessId(4242, { command: () => `${value}\n` })).toBe(value);
  });

  it('shares a total helper deadline across missing interpreter fallbacks', () => {
    let now = 0;
    const timeouts: number[] = [];
    const command = vi.fn((_file: string, _args: string[], _env: NodeJS.ProcessEnv, timeout: number) => {
      timeouts.push(timeout);
      if (timeouts.length === 1) {
        now = 800;
        throw Object.assign(new Error('missing interpreter'), { code: 'ENOENT' });
      }
      return '42';
    });
    expect(readDarwinUniqueProcessId(4242, { command, now: () => now })).toBe('42');
    expect(timeouts).toEqual([1000, 200]);
  });

  it('rejects output returned after the shared deadline', () => {
    let now = 0;
    const command = vi.fn(() => { now = 1001; return '42'; });
    expect(readDarwinUniqueProcessId(4242, { command, now: () => now })).toBeNull();
    expect(command).toHaveBeenCalledTimes(1);
  });

  it.each(['EACCES', 'ETIMEDOUT'])('does not retry interpreter failure %s', (code) => {
    const command = vi.fn(() => { throw Object.assign(new Error('unavailable'), { code }); });
    expect(readDarwinUniqueProcessId(4242, { command })).toBeNull();
    expect(command).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, 1.5, 2147483648])('rejects invalid signaling PID %s before launching a helper', (pid) => {
    const command = vi.fn();
    expect(() => signalDarwinProcess(pid, '42', 'SIGTERM', { command })).toThrow();
    expect(command).not.toHaveBeenCalled();
  });

  it('does not report malformed or oversized helper output as delivery', () => {
    for (const output of ['true', 'delivered\nextra', 'x'.repeat(4097)]) {
      expect(() => signalDarwinProcess(4242, '42', 'SIGTERM', { command: () => output })).toThrow();
    }
  });

  it('preserves kernel permission denial without reporting delivery', () => {
    expect(() => signalDarwinProcess(4242, '42', 'SIGTERM', { command: () => 'error:1' })).toThrowError(
      expect.objectContaining({ code: 'EPERM' }),
    );
  });

  it.each(['unavailable', 'retry-exhausted'])('does not confuse %s with a departed process', (result) => {
    expect(() => signalDarwinProcess(4242, '42', 'SIGTERM', { command: () => result })).toThrow();
  });
});

// @skip-env These assertions require Darwin's real process and Mach task interfaces.
describe.skipIf(process.platform !== 'darwin')('Darwin native identity signaling', () => {
  it('never signals a reaped root through a Node handle awaiting its exit callback', async () => {
    const { captureProcessTreeRootAuthority, killSessionTree } = await import('../../src/runtimes/agent/process-tree.ts');
    const actualExec = childProcess.execFileSync;
    const program = "process.stdin.once('data', () => process.exit(0)); process.stdin.on('end', () => process.exit(0)); process.stdout.write('ready'); setTimeout(() => process.exit(2), 15000)";
    const a = spawn(process.execPath, ['-e', program], { stdio: ['pipe', 'pipe', 'ignore'] });
    const b = spawn(process.execPath, ['-e', program], { stdio: ['pipe', 'pipe', 'ignore'] });
    const closed = [once(a, 'close'), once(b, 'close')];
    const originalKill = b.kill.bind(b);
    // A regression may request SIGKILL; this fixture permits only a non-signaling probe.
    const numericKill = vi.spyOn(b, 'kill').mockImplementation(() => originalKill(0));
    let operation: Promise<unknown> | undefined;
    let callbackError: unknown;
    try {
      await Promise.all([once(a.stdout, 'data'), once(b.stdout, 'data')]);
      const authority = captureProcessTreeRootAuthority(b);
      expect(authority).not.toBeNull();
      const start = authority!.birthToken.slice('darwin-lstart:'.length);
      a.once('exit', () => {
        try {
          expect(() => process.kill(b.pid!, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }));
          expect(b.exitCode).toBeNull();
          // Only the census is simulated: a same-second replacement must not inherit authority.
          childProcess.execFileSync = ((file: string, args: string[], options: unknown) => {
            if (file !== 'ps') return Reflect.apply(actualExec, childProcess, [file, args, options]);
            if (args[0] === '-p' && args[3] === 'pid=,lstart=') {
              return args[1]!.split(',').filter((pid) => Number(pid) === b.pid)
                .map((pid) => `${pid} ${start}`).join('\n');
            }
            if (args[0] === '-eo' && args[1] === 'pid,ppid,pgid,lstart,command') {
              return `PID PPID PGID STARTED COMMAND\n${process.pid} 1 ${process.pid} ${start} test-parent\n${b.pid} ${process.pid} ${b.pid} ${start} provider-fixture`;
            }
            throw new Error('Unexpected process census');
          }) as typeof childProcess.execFileSync;
          syncBuiltinESMExports();
          operation = killSessionTree(b, 'SIGKILL', {
            rootAuthority: authority!, generationMarker: 'reaped-darwin-root',
            ambiguityResolveMs: 0, killGraceMs: 0,
          }).then((value) => value, (error: unknown) => error);
        } catch (error) {
          callbackError = error;
        }
      });
      a.stdin.end('exit');
      b.stdin.end('exit');
      const deadline = performance.now() + 5_000;
      let zombies = false;
      while (performance.now() < deadline) {
        const rows = actualExec('ps', ['-p', `${a.pid},${b.pid}`, '-o', 'pid=,stat='], {
          encoding: 'utf8', timeout: 1_000,
        }).trim().split('\n').map((row) => row.trim().split(/\s+/));
        zombies = rows.length === 2 && rows.every(([, state]) => state?.startsWith('Z'));
        if (zombies) break;
        TIMING();
      }
      expect(zombies).toBe(true);
      await Promise.all(closed);
      if (callbackError) throw callbackError;
      expect(operation).toBeDefined();
      expect(await operation).toMatchObject({ code: 'PROCESS_TREE_SIGNAL_FAILED' });
      expect(numericKill).not.toHaveBeenCalled();
    } finally {
      if (operation) await operation;
      childProcess.execFileSync = actualExec;
      syncBuiltinESMExports();
      a.stdin.end();
      b.stdin.end();
      await Promise.allSettled(closed);
      numericKill.mockRestore();
    }
  });

  it('rejects a wrong generation, preserves the child, then signals the captured generation', async () => {
    const child = spawn('/bin/cat', [], { stdio: ['pipe', 'pipe', 'ignore'] });
    const closed = once(child, 'close');
    try {
      const identity = readDarwinUniqueProcessId(child.pid!);
      expect(identity).not.toBeNull();
      const wrong = (BigInt(identity!) + 1n).toString();
      expect(signalDarwinProcess(child.pid!, wrong, 'SIGTERM')).toBe(false);
      const pong = once(child.stdout, 'data');
      child.stdin.write('still alive\n');
      expect(String((await pong)[0])).toBe('still alive\n');
      expect(signalDarwinProcess(child.pid!, identity!, 'SIGTERM')).toBe(true);
      expect(await closed).toEqual([null, 'SIGTERM']);
      expect(signalDarwinProcess(child.pid!, identity!, 'SIGTERM')).toBe(false);
    } finally {
      child.stdin.end();
      await closed;
    }
  });

  it('reacquires a kernel token once after ESRCH and refuses repeated stale tokens', async () => {
    const child = spawn('/bin/cat', [], { stdio: ['pipe', 'pipe', 'ignore'] });
    const closed = once(child, 'close');
    const injectStaleToken = (everyAttempt: boolean) => (
      file: string, args: string[], env: NodeJS.ProcessEnv, timeout: number,
    ): string => {
      const marker = '            result = lib.proc_signal_with_audittoken(ctypes.byref(token), sig)';
      expect(args[3]?.split(marker)).toHaveLength(2);
      // Corrupt only the test child's token after identity checks to force a real kernel ESRCH.
      const injected = args[3]!.replace(marker,
        `            if ${everyAttempt ? 'True' : '_ == 0'}: token.val[7] ^= 0x80000000\n${marker}`);
      return execFileSync(file, args.map((arg, index) => index === 3 ? injected : arg), {
        encoding: 'utf8', env, timeout, killSignal: 'SIGKILL', maxBuffer: 4096,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    };
    try {
      const identity = readDarwinUniqueProcessId(child.pid!);
      expect(identity).not.toBeNull();
      expect(() => signalDarwinProcess(child.pid!, identity!, 'SIGTERM', {
        command: injectStaleToken(true),
      })).toThrow('Darwin process signal identity unavailable');
      const pong = once(child.stdout, 'data');
      child.stdin.write('still alive\n');
      expect(String((await pong)[0])).toBe('still alive\n');
      expect(signalDarwinProcess(child.pid!, identity!, 'SIGTERM', {
        command: injectStaleToken(false),
      })).toBe(true);
      expect(await closed).toEqual([null, 'SIGTERM']);
    } finally {
      child.stdin.end();
      await closed;
    }
  });

  it('retains stable identity across exec and obtains a token for the current image', async () => {
    const child = spawn('/bin/sh', ['-c', 'echo before; read go; exec /bin/cat'], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const closed = once(child, 'close');
    try {
      expect(String((await once(child.stdout, 'data'))[0])).toBe('before\n');
      const identity = readDarwinUniqueProcessId(child.pid!);
      expect(identity).not.toBeNull();
      child.stdin.write('go\n');
      const pong = once(child.stdout, 'data');
      child.stdin.write('after exec\n');
      expect(String((await pong)[0])).toBe('after exec\n');
      expect(readDarwinUniqueProcessId(child.pid!)).toBe(identity);
      expect(signalDarwinProcess(child.pid!, identity!, 'SIGTERM')).toBe(true);
      expect(await closed).toEqual([null, 'SIGTERM']);
    } finally {
      child.stdin.end();
      await closed;
    }
  });
});
