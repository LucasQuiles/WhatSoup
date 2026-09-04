import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileSyncMock, readFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  readFileSyncMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({ execFileSync: execFileSyncMock }));
vi.mock('node:fs', () => ({ readFileSync: readFileSyncMock }));

import {
  PROCESS_IDENTITY_MAX_BATCH,
  processBirthTokenSupportsNumericSignal,
  probeProcessBirthToken,
  probeProcessBirthTokens,
} from '../../src/lib/process-identity.ts';

beforeEach(() => {
  execFileSyncMock.mockReset();
  readFileSyncMock.mockReset();
});

describe('bounded process birth identity observation', () => {
  it('authorizes numeric signals only from high-resolution Linux birth tokens', () => {
    expect(processBirthTokenSupportsNumericSignal('linux-start:777')).toBe(true);
    expect(processBirthTokenSupportsNumericSignal(
      'darwin-lstart:Mon Sep  3 12:34:56 2026',
    )).toBe(false);
    expect(processBirthTokenSupportsNumericSignal('birth:synthetic')).toBe(false);
  });

  it('observes a Darwin PID set with one bounded ps invocation', () => {
    execFileSyncMock.mockReturnValue([
      '  102 Mon Sep  3 12:34:56 2026',
      '  101 Sun Sep  2 01:02:03 2026',
      '',
    ].join('\n'));

    const result = probeProcessBirthTokens([101, 102, 101], 'darwin');

    expect(result).toEqual(new Map([
      [101, 'darwin-lstart:Sun Sep  2 01:02:03 2026'],
      [102, 'darwin-lstart:Mon Sep  3 12:34:56 2026'],
    ]));
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'ps',
      ['-p', '101,102', '-o', 'pid=,lstart='],
      { encoding: 'utf-8', timeout: 250, maxBuffer: 1024 * 1024 },
    );
  });

  it('fails closed on duplicate or malformed Darwin rows', () => {
    execFileSyncMock.mockReturnValue([
      '101 Sun Sep  2 01:02:03 2026',
      '101 Sun Sep  2 01:02:03 2026',
    ].join('\n'));
    expect(probeProcessBirthTokens([101], 'darwin')).toBeNull();

    execFileSyncMock.mockReturnValue('101 private malformed text');
    expect(probeProcessBirthTokens([101], 'darwin')).toBeNull();
  });

  it('rejects invalid and one-over-limit batches before system access', () => {
    expect(probeProcessBirthTokens([0], 'darwin')).toBeNull();
    expect(probeProcessBirthTokens(
      Array.from({ length: PROCESS_IDENTITY_MAX_BATCH + 1 }, (_, index) => index + 2),
      'darwin',
    )).toBeNull();
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(readFileSyncMock).not.toHaveBeenCalled();
  });

  it('retains exact Linux start ticks and omits processes that disappear', () => {
    readFileSyncMock.mockImplementation((path: string) => {
      if (path.endsWith('/101/stat')) {
        return `101 (provider worker) ${[
          'S', '1', '1', '1', '0', '0', '0', '0', '0', '0',
          '0', '0', '0', '0', '0', '0', '0', '0', '0', '777',
        ].join(' ')}`;
      }
      throw Object.assign(new Error('private path text'), { code: 'ENOENT' });
    });

    expect(probeProcessBirthTokens([101, 102], 'linux')).toEqual(new Map([
      [101, 'linux-start:777'],
    ]));
    expect(probeProcessBirthToken(102, 'linux')).toBeNull();
  });
});
