import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PID = 51_001;
export function registerWatchdogCases(): void {
  describe('boundary watchdog process-group proof', () => {
    const spawnMock = vi.fn();
    const execFileSyncMock = vi.fn();
    const probeGroupMock = vi.fn();
    let child: EventEmitter & { pid: number };
    let killSpy: ReturnType<typeof vi.spyOn>;
    let runBoundaryWatchdogForTest: typeof import('../../../scripts/lib/verification/boundary-run/process.ts')['runBoundaryWatchdogForTest'];

    function run() {
      return runBoundaryWatchdogForTest(['fixture'], {
        deadlineMs: 20, killGraceMs: 10, expectedExit: '0',
      }).then((value) => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
    }

    beforeEach(async () => {
      vi.resetModules();
      spawnMock.mockReset();
      execFileSyncMock.mockReset();
      probeGroupMock.mockReset();
      vi.doMock('node:child_process', async () => ({
        ...await vi.importActual<typeof import('node:child_process')>('node:child_process'),
        spawn: spawnMock, execFileSync: execFileSyncMock,
      }));
      vi.doMock('../../../scripts/full-suite-battery.ts', () => ({ probeGroupMembership: probeGroupMock }));
      ({ runBoundaryWatchdogForTest } = await import('../../../scripts/lib/verification/boundary-run/process.ts'));
      vi.useFakeTimers();
      child = Object.assign(new EventEmitter(), { pid: PID });
      spawnMock.mockReturnValue(child);
      execFileSyncMock.mockImplementation(() => { throw new Error('leader has exited'); });
      killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.useRealTimers();
      vi.doUnmock('node:child_process');
      vi.doUnmock('../../../scripts/full-suite-battery.ts');
      vi.resetModules();
    });
    it('retains timeout failure when EPERM is followed by proof of no live group members', async () => {
      probeGroupMock.mockReturnValue('no-live-members');
      killSpy.mockImplementation(() => {
        child.emit('close', null, 'SIGTERM');
        throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
      });
      const pending = run();
      await vi.advanceTimersByTimeAsync(30);
      const outcome = await pending;
      expect(outcome.error).toBeUndefined();
      expect(outcome.value).toMatchObject({ timedOut: true, groupDead: true, result: { ok: false } });
      expect(outcome.value?.result.issues.map((entry) => entry.code)).toContain('watchdog-timeout');
    });

    it.each(['live', 'unknown'])('returns an inconclusive terminal result when EPERM leaves membership %s', async (membership) => {
      probeGroupMock.mockReturnValue(membership);
      const failure = Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
      killSpy.mockImplementation(() => { throw failure; });
      const pending = run();
      await vi.advanceTimersByTimeAsync(700);
      const outcome = await pending;
      expect(outcome.error).toBeUndefined();
      expect(outcome.value).toMatchObject({ groupDead: false, result: { ok: false, verdict: 'Inconclusive' } });
      expect(outcome.value?.result.issues.map((entry) => entry.code)).toContain('watchdog-signal-failed');
      expect(outcome.value?.result.issues.map((entry) => entry.code)).toContain('watchdog-group-survivor');
      expect(killSpy).toHaveBeenCalledWith(-PID, 'SIGKILL');
    });

    it('does not suppress another signal error even when the group has no live members', async () => {
      probeGroupMock.mockReturnValue('no-live-members');
      const failure = Object.assign(new Error('kill EACCES'), { code: 'EACCES' });
      killSpy.mockImplementation(() => { throw failure; });
      const pending = run();
      await vi.advanceTimersByTimeAsync(150);
      const outcome = await pending;
      expect(outcome.error).toBeUndefined();
      expect(outcome.value).toMatchObject({ groupDead: true, result: { ok: false, verdict: 'Inconclusive' } });
      expect(outcome.value?.result.issues.map((entry) => entry.code)).toContain('watchdog-signal-failed');
    });

    it('rejects a surviving descendant after its group leader exits successfully', async () => {
      probeGroupMock.mockReturnValueOnce('live').mockReturnValue('no-live-members');
      const pending = run();
      child.emit('close', 0, null);
      const outcome = await pending;
      expect(outcome.error).toBeUndefined();
      expect(killSpy).toHaveBeenCalledWith(-PID, 'SIGTERM');
      expect(outcome.value).toMatchObject({ rawExit: 0, groupDead: true, result: { ok: false } });
      expect(outcome.value?.result.issues.map((entry) => entry.code)).toContain('watchdog-group-survivor');
    });

    it('never reports cleanup complete when the group inventory remains unreadable', async () => {
      probeGroupMock.mockReturnValue('unknown');
      const pending = run();
      child.emit('close', 0, null);
      await vi.advanceTimersByTimeAsync(600);
      const outcome = await pending;
      expect(outcome.error).toBeUndefined();
      expect(outcome.value).toMatchObject({ groupDead: false, result: { ok: false } });
      expect(outcome.value?.result.issues.map((entry) => entry.code)).toContain('watchdog-group-survivor');
    });

    it('accepts the expected direct exit when the group has no live members', async () => {
      probeGroupMock.mockReturnValue('no-live-members');
      const pending = run();
      child.emit('close', 0, null);
      const outcome = await pending;
      expect(outcome.error).toBeUndefined();
      expect(outcome.value).toMatchObject({ rawExit: 0, groupDead: true, result: { ok: true } });
      expect(killSpy).not.toHaveBeenCalled();
    });
  });
}
