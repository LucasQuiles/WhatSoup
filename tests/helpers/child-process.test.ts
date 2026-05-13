import { describe, expect, it, vi } from 'vitest';

import { childProcessMock } from './child-process.ts';

describe('childProcessMock', () => {
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
