import { describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { childProcessMock, childProcessMockWithNativeOwnership } from './child-process.ts';
import { trackTmpDirs } from './tmp-dir.ts';

const tmp = trackTmpDirs('child-process-mock-');

describe('childProcessMock', () => {
  it('allows native process identity while keeping other sync commands mocked', async () => {
    const mock = await childProcessMockWithNativeOwnership();
    const birth = mock.execFileSync('ps', ['-p', String(process.pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 2000 });
    expect(birth.toString().trim()).not.toBe('');
    const marker = join(tmp.make('sync'), 'unexpected-command');
    expect(mock.execFileSync(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`]))
      .toEqual(Buffer.from(''));
    expect(existsSync(marker)).toBe(false);
  });

  it('provides spawn and execFile spies matching existing test mocks', () => {
    const mock = childProcessMock();
    const child = mock.spawn('node', ['script.js']);
    const callback = vi.fn();

    child.on('exit', callback);
    child.unref();
    mock.execFile('git', ['status'], callback);

    expect(mock.spawn).toHaveBeenCalledWith('node', ['script.js']);
    expect(child.on).toHaveBeenCalledWith('exit', callback);
    expect(child.unref).toHaveBeenCalled();
    expect(mock.execFile).toHaveBeenCalledWith('git', ['status'], callback);
  });

  it('uses an EventEmitter-like spawn result so registered handlers can be driven', () => {
    const mock = childProcessMock();
    const child = mock.spawn('node', ['script.js']);
    const callback = vi.fn();

    child.on('exit', callback);
    child.emit('exit', 0);

    expect(callback).toHaveBeenCalledWith(0);
  });

  it('provides the child process members used by spawn consumers', () => {
    const mock = childProcessMock();
    const child = mock.spawn('node', ['script.js']);
    const stdoutCallback = vi.fn();
    const stderrCallback = vi.fn();

    child.stdout.on('data', stdoutCallback);
    child.stderr.on('data', stderrCallback);
    child.stdout.emit('data', Buffer.from('out'));
    child.stderr.emit('data', Buffer.from('err'));
    const killed = child.kill('SIGTERM');

    expect(child.pid).toBeGreaterThan(0);
    expect(stdoutCallback).toHaveBeenCalledWith(Buffer.from('out'));
    expect(stderrCallback).toHaveBeenCalledWith(Buffer.from('err'));
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(killed).toBe(true);
  });

  it('completes callback-style execFile calls by default', async () => {
    const mock = childProcessMock();
    const callback = vi.fn();

    mock.execFile('git', ['status'], callback);
    await new Promise<void>((resolve) => process.nextTick(resolve));

    expect(callback).toHaveBeenCalledWith(null, '', '');
  });

  it('exposes a configurable execFileSync spy that returns an empty Buffer by default', () => {
    const mock = childProcessMock();
    const result = mock.execFileSync('security', ['find-generic-password']);

    expect(mock.execFileSync).toHaveBeenCalledWith('security', ['find-generic-password']);
    expect(Buffer.isBuffer(result)).toBe(true);
    expect((result as Buffer).length).toBe(0);
  });

  it('allows per-test execFileSync mockReturnValue overrides', () => {
    const mock = childProcessMock();
    mock.execFileSync.mockReturnValue(Buffer.from('sk-test-key\n'));

    const result = mock.execFileSync('security', ['find-generic-password']);

    expect(result.toString()).toBe('sk-test-key\n');
  });
});
