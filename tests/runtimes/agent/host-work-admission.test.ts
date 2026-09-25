import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('node:fs', () => ({ statSync: vi.fn() }));
vi.mock('node:os', () => ({ userInfo: vi.fn() }));

import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { userInfo } from 'node:os';
import {
  isHostWorkAdmissionEnabled,
  HostWorkAdmissionCleanupError,
  spawnHostWorkAdmitted,
} from '../../../src/runtimes/agent/host-work-admission.ts';

function makeQueuedChild() {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdio: Array<EventEmitter | null>;
  };
  child.pid = 31337;
  child.stdio = [new EventEmitter(), new EventEmitter(), new EventEmitter(), new EventEmitter()];
  return child;
}

describe('host work admission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is opt-in only for the explicit Linux setting', () => {
    expect(isHostWorkAdmissionEnabled({}, 'linux')).toBe(false);
    expect(isHostWorkAdmissionEnabled({ WHATSOUP_WORK_ADMISSION: 'other' }, 'linux')).toBe(false);
    expect(isHostWorkAdmissionEnabled({ WHATSOUP_WORK_ADMISSION: 'systemd' }, 'darwin')).toBe(false);
    expect(isHostWorkAdmissionEnabled({ WHATSOUP_WORK_ADMISSION: 'systemd' }, 'linux')).toBe(true);
  });

  it('waits for a valid fd3 admission record before resolving', async () => {
    const child = makeQueuedChild();
    (spawn as ReturnType<typeof vi.fn>).mockReturnValueOnce(child);
    (statSync as ReturnType<typeof vi.fn>).mockReturnValue({ isFile: () => true, mode: 0o755 });
    (userInfo as ReturnType<typeof vi.fn>).mockReturnValue({ uid: 1000 });
    vi.stubEnv('WHATSOUP_WORK_ADMISSION_HELPER', '/host/bin/work-admission');
    const terminate = vi.fn(async () => {});

    let settled = false;
    const admitted = spawnHostWorkAdmitted({
      binary: '/verified/provider',
      args: ['--safe-arg'],
      cwd: '/work',
      env: { PATH: '/usr/bin' },
      expectedExecutableSha256: 'a'.repeat(64),
      onAbort: terminate,
    }).then((value) => {
      settled = true;
      return value;
    });

    expect(spawn).toHaveBeenCalledWith('/host/bin/work-admission', [
      '--profile', 'agent',
      '--class', 'interactive',
      '--notify-fd', '3',
      '--expected-executable-sha256', 'a'.repeat(64),
      '--', '/verified/provider', '--safe-arg',
    ], expect.objectContaining({
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      env: {
        PATH: '/usr/bin',
        XDG_RUNTIME_DIR: '/run/user/1000',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      },
    }));
    await Promise.resolve();
    expect(settled).toBe(false);

    child.stdio[3]!.emit('data', Buffer.from('{"state":"admit'));
    child.stdio[3]!.emit('data', Buffer.from('ted","unit":"scope-1"}\n'));
    expect(settled).toBe(false);
    child.stdio[3]!.emit('end');

    await expect(admitted).resolves.toBe(child);
    expect(terminate).not.toHaveBeenCalled();
  });

  it('derives runtime and D-Bus paths from the actual account UID', async () => {
    const child = makeQueuedChild();
    (spawn as ReturnType<typeof vi.fn>).mockReturnValueOnce(child);
    (statSync as ReturnType<typeof vi.fn>).mockReturnValue({ isFile: () => true, mode: 0o755 });
    (userInfo as ReturnType<typeof vi.fn>).mockReturnValue({ uid: 2001 });
    vi.stubEnv('WHATSOUP_WORK_ADMISSION_HELPER', '/host/bin/work-admission');

    const admitted = spawnHostWorkAdmitted({
      binary: '/verified/provider', args: [], cwd: '/work', env: { PATH: '/usr/bin' }, onAbort: vi.fn(async () => {}),
    });

    expect(spawn).toHaveBeenCalledWith('/host/bin/work-admission', expect.any(Array), expect.objectContaining({
      env: {
        PATH: '/usr/bin',
        XDG_RUNTIME_DIR: '/run/user/2001',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/2001/bus',
      },
    }));
    child.stdio[3]!.emit('data', Buffer.from('{"state":"admitted","unit":"scope-1"}\n'));
    child.stdio[3]!.emit('end');
    await expect(admitted).resolves.toBe(child);
  });

  it('fails closed when the configured helper is missing, relative, or not executable', async () => {
    const options = { binary: '/verified/provider', args: [], cwd: '/work', env: {}, onAbort: vi.fn(async () => {}) };

    vi.stubEnv('WHATSOUP_WORK_ADMISSION_HELPER', '');
    await expect(spawnHostWorkAdmitted(options)).rejects.toThrow('Host work admission rejected');
    vi.stubEnv('WHATSOUP_WORK_ADMISSION_HELPER', 'relative/helper');
    await expect(spawnHostWorkAdmitted(options)).rejects.toThrow('Host work admission rejected');
    vi.stubEnv('WHATSOUP_WORK_ADMISSION_HELPER', '/host/bin/work-admission');
    (statSync as ReturnType<typeof vi.fn>).mockReturnValueOnce({ isFile: () => true, mode: 0o644 });
    await expect(spawnHostWorkAdmitted(options)).rejects.toThrow('Host work admission rejected');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('terminates and rejects malformed, oversized, early-exit, and aborted queued children', async () => {
    const malformed = makeQueuedChild();
    const oversized = makeQueuedChild();
    const exited = makeQueuedChild();
    const aborted = makeQueuedChild();
    (spawn as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(malformed)
      .mockReturnValueOnce(oversized)
      .mockReturnValueOnce(exited)
      .mockReturnValueOnce(aborted);
    const terminateMalformed = vi.fn(async () => {});
    const terminateOversized = vi.fn(async () => {});
    const terminateExited = vi.fn(async () => {});
    const terminateAborted = vi.fn(async () => {});

    (statSync as ReturnType<typeof vi.fn>).mockReturnValue({ isFile: () => true, mode: 0o755 });
    (userInfo as ReturnType<typeof vi.fn>).mockReturnValue({ uid: 1000 });
    vi.stubEnv('WHATSOUP_WORK_ADMISSION_HELPER', '/host/bin/work-admission');
    const malformedStart = spawnHostWorkAdmitted({
      binary: '/verified/provider', args: [], cwd: '/work', env: {}, onAbort: terminateMalformed,
    });
    malformed.stdio[3]!.emit('data', Buffer.from('{not-json}\n'));
    await expect(malformedStart).rejects.toThrow('Host work admission rejected');
    expect(terminateMalformed).toHaveBeenCalledWith(malformed);

    const oversizedStart = spawnHostWorkAdmitted({
      binary: '/verified/provider', args: [], cwd: '/work', env: {}, onAbort: terminateOversized,
    });
    oversized.stdio[3]!.emit('data', Buffer.alloc(8 * 1024 + 1, 0x61));
    await expect(oversizedStart).rejects.toThrow('Host work admission rejected');
    expect(terminateOversized).toHaveBeenCalledWith(oversized);

    const exitedStart = spawnHostWorkAdmitted({
      binary: '/verified/provider', args: [], cwd: '/work', env: {}, onAbort: terminateExited,
    });
    exited.emit('exit', 1, null);
    await expect(exitedStart).rejects.toThrow('Host work admission rejected');
    expect(terminateExited).toHaveBeenCalledWith(exited);

    const controller = new AbortController();
    const abortedStart = spawnHostWorkAdmitted({
      binary: '/verified/provider', args: [], cwd: '/work', env: {}, signal: controller.signal, onAbort: terminateAborted,
    });
    controller.abort();
    await expect(abortedStart).rejects.toThrow('Host work admission rejected');
    expect(terminateAborted).toHaveBeenCalledWith(aborted);
  });

  it.each(['refused', 'queued', 'Admitted'])('rejects a well-formed %s record that is not an admission', async (state) => {
    const child = makeQueuedChild();
    (spawn as ReturnType<typeof vi.fn>).mockReturnValueOnce(child);
    (statSync as ReturnType<typeof vi.fn>).mockReturnValue({ isFile: () => true, mode: 0o755 });
    (userInfo as ReturnType<typeof vi.fn>).mockReturnValue({ uid: 1000 });
    vi.stubEnv('WHATSOUP_WORK_ADMISSION_HELPER', '/host/bin/work-admission');
    const terminate = vi.fn(async () => {});

    const start = spawnHostWorkAdmitted({
      binary: '/verified/provider', args: [], cwd: '/work', env: {}, onAbort: terminate,
    });
    child.stdio[3]!.emit('data', Buffer.from(`${JSON.stringify({ state, unit: 'scope-1' })}\n`));
    child.stdio[3]!.emit('end');

    await expect(start).rejects.toThrow('Host work admission rejected');
    expect(terminate).toHaveBeenCalledWith(child);
  });

  it('requires fd3 EOF without trailing bytes and surfaces an unproven cleanup', async () => {
    const trailing = makeQueuedChild();
    const incomplete = makeQueuedChild();
    const exitedAfterRecord = makeQueuedChild();
    const cleanupFailure = makeQueuedChild();
    (spawn as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(trailing)
      .mockReturnValueOnce(incomplete)
      .mockReturnValueOnce(exitedAfterRecord)
      .mockReturnValueOnce(cleanupFailure);

    (statSync as ReturnType<typeof vi.fn>).mockReturnValue({ isFile: () => true, mode: 0o755 });
    (userInfo as ReturnType<typeof vi.fn>).mockReturnValue({ uid: 1000 });
    vi.stubEnv('WHATSOUP_WORK_ADMISSION_HELPER', '/host/bin/work-admission');
    const trailingStart = spawnHostWorkAdmitted({
      binary: '/verified/provider', args: [], cwd: '/work', env: {}, onAbort: vi.fn(async () => {}),
    });
    trailing.stdio[3]!.emit('data', Buffer.from('{"state":"admitted","unit":"scope-1"}\nextra'));
    await expect(trailingStart).rejects.toThrow('Host work admission rejected');

    const incompleteStart = spawnHostWorkAdmitted({
      binary: '/verified/provider', args: [], cwd: '/work', env: {}, onAbort: vi.fn(async () => {}),
    });
    incomplete.stdio[3]!.emit('error', new Error('fd closed'));
    await expect(incompleteStart).rejects.toThrow('Host work admission rejected');

    const exitedAfterRecordStart = spawnHostWorkAdmitted({
      binary: '/verified/provider', args: [], cwd: '/work', env: {}, onAbort: vi.fn(async () => {}),
    });
    exitedAfterRecord.stdio[3]!.emit('data', Buffer.from('{"state":"admitted","unit":"scope-1"}\n'));
    exitedAfterRecord.emit('exit', 1, null);
    await expect(exitedAfterRecordStart).rejects.toThrow('Host work admission rejected');

    const controller = new AbortController();
    const cleanupStart = spawnHostWorkAdmitted({
      binary: '/verified/provider', args: [], cwd: '/work', env: {}, signal: controller.signal,
      onAbort: vi.fn(async () => { throw new Error('synthetic cleanup failure'); }),
    });
    controller.abort();
    await expect(cleanupStart).rejects.toBeInstanceOf(HostWorkAdmissionCleanupError);
  });
});
