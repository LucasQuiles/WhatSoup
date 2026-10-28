import { describe, expect, it, vi } from 'vitest';
import { inspectRefreshProcess } from '../../../../src/runtimes/agent/providers/claude-refresh-process-identity.ts';

const PID = 4242;
const BOOT = '97a51083-c86a-4b14-a7f8-f6a069947ede';

function darwin(boot = '{ sec = 1793145600, usec = 1234 } Tue Oct 27 00:00:00 2026') {
  return vi.fn((file: string, _args: string[], env: NodeJS.ProcessEnv) => {
    expect(env).toMatchObject({ LANG: 'C', LC_ALL: 'C', TZ: 'UTC' });
    return file === '/usr/sbin/sysctl' ? boot : ' Tue Oct 27  01:02:03 2026\n';
  });
}

describe('refresh process identity', () => {
  it('uses fixed locale and timezone with numeric boot time on macOS', () => {
    const command = darwin();
    const signal = vi.fn();
    expect(inspectRefreshProcess(PID, { platform: 'darwin', signal, command })).toEqual({
      state: 'alive', birthToken: 'refresh-owner-v1:darwin:1793145600.001234:Tue Oct 27 01:02:03 2026',
    });
    expect(command.mock.calls.map(([file, args]) => [file, args])).toEqual([
      ['/usr/sbin/sysctl', ['-n', 'kern.boottime']], ['/bin/ps', ['-p', String(PID), '-o', 'lstart=']],
    ]);
    expect(signal.mock.calls).toEqual([[PID, 0], [PID, 0]]);
  });

  it('distinguishes the same PID and start display after a host reboot', () => {
    const deps = { platform: 'darwin' as const, signal: vi.fn() };
    const before = inspectRefreshProcess(PID, { ...deps, command: darwin() });
    const after = inspectRefreshProcess(PID, { ...deps, command: darwin('{ sec = 1793232000, usec = 1234 }') });
    expect(before.state).toBe('alive');
    expect(after.state).toBe('alive');
    expect(after).not.toEqual(before);
  });

  it('reads Linux start ticks after a process name containing spaces and parentheses', () => {
    const fields = ['S', ...Array.from({ length: 18 }, () => '0'), '8675309', '0'];
    const read = vi.fn((path: string) => path.endsWith('boot_id') ? `${BOOT}\n` : `${PID} (refresh (child)) ${fields.join(' ')}`);
    expect(inspectRefreshProcess(PID, { platform: 'linux', signal: vi.fn(), read })).toEqual({
      state: 'alive', birthToken: `refresh-owner-v1:linux:${BOOT}:8675309`,
    });
    expect(read.mock.calls).toEqual([['/proc/sys/kernel/random/boot_id'], [`/proc/${PID}/stat`]]);
  });

  it.each(['ESRCH', 'EPERM', 'EACCES'])('only ESRCH proves absence, not %s generally', (code) => {
    const read = vi.fn();
    const command = vi.fn();
    const signal = vi.fn(() => { throw Object.assign(new Error('probe unavailable'), { code }); });
    expect(inspectRefreshProcess(PID, { signal, read, command })).toEqual({ state: code === 'ESRCH' ? 'absent' : 'unknown' });
    expect(read).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();
  });

  it('does not retain an alive identity when the child disappears during inspection', () => {
    const signal = vi.fn().mockImplementationOnce(() => undefined).mockImplementationOnce(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    expect(inspectRefreshProcess(PID, { platform: 'darwin', signal, command: darwin() })).toEqual({ state: 'absent' });
  });

  it.each(['ESRCH', 'EPERM', undefined])('rechecks liveness after an identity read failure (%s)', (code) => {
    const signal = vi.fn().mockImplementationOnce(() => undefined).mockImplementationOnce(() => {
      if (code) throw Object.assign(new Error('probe unavailable'), { code });
    });
    const command = vi.fn(() => { throw new Error('command timed out'); });
    expect(inspectRefreshProcess(PID, { platform: 'darwin', signal, command })).toEqual({ state: code === 'ESRCH' ? 'absent' : 'unknown' });
  });

  it.each([0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])('never signals invalid PID %s', (pid) => {
    const signal = vi.fn();
    expect(inspectRefreshProcess(pid, { signal })).toEqual({ state: 'unknown' });
    expect(signal).not.toHaveBeenCalled();
  });

  it.each(['{ sec = 0, usec = 0 }', '{ sec = 1793145600, usec = 1000000 }', 'boot unavailable'])('rejects malformed macOS boot identity %s', (boot) => {
    expect(inspectRefreshProcess(PID, { platform: 'darwin', signal: vi.fn(), command: darwin(boot) })).toEqual({ state: 'unknown' });
  });

  it('does not guess identity on an unsupported platform', () => {
    expect(inspectRefreshProcess(PID, { platform: 'win32', signal: vi.fn() })).toEqual({ state: 'unknown' });
  });
});
