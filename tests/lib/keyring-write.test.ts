import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const execFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync: execFileSyncMock,
}));

import {
  writeCredential,
  deleteCredential,
  KeyringWriteError,
  _resetBackendCache,
} from '../../src/lib/keyring.ts';
import * as os from 'node:os';

describe('writeCredential — macos-keychain backend', () => {
  beforeEach(() => {
    _resetBackendCache();
    vi.stubGlobal('process', { ...process, platform: 'darwin' } as unknown as NodeJS.Process);
    execFileSyncMock.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('invokes security add-generic-password with -U, -- separators, and the exact service/account', () => {
    execFileSyncMock.mockReturnValue(Buffer.from(''));
    const out = writeCredential('deepseek', 'sk-test-VALUE');
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = execFileSyncMock.mock.calls[0]!;
    expect(cmd).toBe('security');
    expect(args).toEqual([
      'add-generic-password', '-U',
      '-s', '--', 'deepseek',
      '-a', '--', os.userInfo().username,
      '-w', 'sk-test-VALUE',
    ]);
    expect(out.backend).toBe('macos-keychain');
  });

  it('maps a locked-keychain failure to KeyringWriteError KEYRING_LOCKED with no value in the error', () => {
    const childErr = Object.assign(new Error('User interaction is not allowed.'), {
      status: 36,
      stderr: Buffer.from('security: SecKeychainItemCreateFromContent: User interaction is not allowed.'),
      spawnargs: ['add-generic-password', '-w', 'sk-test-VALUE'],
    });
    execFileSyncMock.mockImplementation(() => { throw childErr; });
    let caught: unknown;
    try { writeCredential('deepseek', 'sk-test-VALUE'); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(KeyringWriteError);
    const err = caught as KeyringWriteError;
    expect(err.code).toBe('KEYRING_LOCKED');
    // The sanitized error must carry NO secret material and NO child-process payload.
    expect(JSON.stringify({ msg: err.message, ...err })).not.toContain('sk-test-VALUE');
    expect((err as unknown as Record<string, unknown>).spawnargs).toBe(undefined);
    expect((err as unknown as Record<string, unknown>).stderr).toBe(undefined);
  });

  it('maps a generic write failure to KEYRING_WRITE_FAILED', () => {
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('boom'), { status: 1 });
    });
    let code = '';
    try { writeCredential('minimax', 'v'); } catch (e) { code = (e as KeyringWriteError).code; }
    expect(code).toBe('KEYRING_WRITE_FAILED');
  });
});
