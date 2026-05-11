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
});
