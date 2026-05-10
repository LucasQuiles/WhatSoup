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
});
