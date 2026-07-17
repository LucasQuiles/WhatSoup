import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:child_process', async () => {
  const { childProcessMock } = await import('../helpers/child-process.ts');
  return childProcessMock();
});

vi.mock('node:os', () => ({
  userInfo: vi.fn(() => ({
    username: 'local-user',
    uid: 501,
    gid: 20,
    shell: '/bin/zsh',
    homedir: '/Users/local-user',
  })),
}));

import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { lookupCredential, _resetBackendCache } from '../../src/lib/keyring.ts';

const mockedExecFileSync = vi.mocked(execFileSync);
const mockedUserInfo = vi.mocked(userInfo);

describe('health token keyring canonical service', () => {
  const originalPlatform = process.platform;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    _resetBackendCache();
    mockedExecFileSync.mockReset();
    mockedUserInfo.mockReset();
    mockedUserInfo.mockReturnValue({
      username: 'local-user',
      uid: 501,
      gid: 20,
      shell: '/bin/zsh',
      homedir: '/Users/local-user',
    });
    delete process.env.WHATSOUP_HEALTH_TOKEN;
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    process.env = { ...originalEnv };
  });

  it('maps whatsoup-health-token to WHATSOUP_HEALTH_TOKEN', () => {
    process.env.WHATSOUP_HEALTH_TOKEN = ' canonical-env ';
    expect(lookupCredential('whatsoup-health-token')).toBe('canonical-env');
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  it('checks canonical service with instance user before legacy migration fallback on linux', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    mockedExecFileSync.mockReturnValueOnce(Buffer.from(''));
    mockedExecFileSync.mockReturnValueOnce(Buffer.from('canonical-secret\n'));

    expect(lookupCredential('whatsoup-health-token', { user: 'mwlab' })).toBe('canonical-secret');
    expect(mockedExecFileSync).toHaveBeenNthCalledWith(
      2,
      'secret-tool',
      ['lookup', 'service', 'whatsoup-health-token', 'user', 'mwlab'],
      expect.objectContaining({ timeout: 3_000, killSignal: 'SIGKILL' }),
    );
  });

  it('prefers the user-scoped canonical keyring token over shared env on linux', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    process.env.WHATSOUP_HEALTH_TOKEN = 'shared-env-token';
    mockedExecFileSync.mockReturnValueOnce(Buffer.from(''));
    mockedExecFileSync.mockReturnValueOnce(Buffer.from('canonical-secret\n'));

    expect(lookupCredential('whatsoup-health-token', { user: 'mwlab' })).toBe('canonical-secret');
    expect(mockedExecFileSync).toHaveBeenNthCalledWith(
      2,
      'secret-tool',
      ['lookup', 'service', 'whatsoup-health-token', 'user', 'mwlab'],
      expect.objectContaining({ timeout: 3_000, killSignal: 'SIGKILL' }),
    );
  });

  it('keeps the requested user on a secret-tool migration alias after a scoped canonical miss', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    process.env.WHATSOUP_HEALTH_TOKEN = 'shared-env-token';
    mockedExecFileSync.mockReturnValueOnce(Buffer.from(''));
    mockedExecFileSync.mockImplementationOnce(() => { throw new Error('missing canonical'); });
    mockedExecFileSync.mockReturnValueOnce(Buffer.from('legacy-secret\n'));

    expect(lookupCredential('whatsoup-health-token', { user: 'test-user', skipEnv: true })).toBe('legacy-secret');
    expect(mockedExecFileSync).toHaveBeenNthCalledWith(
      2,
      'secret-tool',
      ['lookup', 'service', 'whatsoup-health-token', 'user', 'test-user'],
      expect.objectContaining({ timeout: 3_000, killSignal: 'SIGKILL' }),
    );
    expect(mockedExecFileSync).toHaveBeenNthCalledWith(
      3,
      'secret-tool',
      ['lookup', 'service', 'whatsoup_health', 'user', 'test-user'],
      expect.objectContaining({ timeout: 3_000, killSignal: 'SIGKILL' }),
    );
  });

  it('skips legacy keyring migration fallback when requested', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    mockedExecFileSync.mockReturnValueOnce(Buffer.from(''));
    mockedExecFileSync.mockImplementationOnce(() => { throw new Error('missing canonical'); });
    mockedExecFileSync.mockReturnValueOnce(Buffer.from('legacy-secret\n'));

    expect(lookupCredential('whatsoup-health-token', { user: 'mwlab', skipEnv: true, skipMigrationFallbacks: true })).toBeNull();
    expect(mockedExecFileSync).toHaveBeenCalledTimes(2);
    expect(mockedExecFileSync).toHaveBeenNthCalledWith(
      2,
      'secret-tool',
      ['lookup', 'service', 'whatsoup-health-token', 'user', 'mwlab'],
      expect.objectContaining({ timeout: 3_000, killSignal: 'SIGKILL' }),
    );
  });

  it('falls back to shared env after scoped canonical and legacy keyring miss', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    process.env.WHATSOUP_HEALTH_TOKEN = 'shared-env-token';
    mockedExecFileSync.mockReturnValueOnce(Buffer.from(''));
    mockedExecFileSync.mockImplementationOnce(() => { throw new Error('missing canonical'); });
    mockedExecFileSync.mockImplementationOnce(() => { throw new Error('missing legacy'); });

    expect(lookupCredential('whatsoup-health-token', { user: 'test-user' })).toBe('shared-env-token');
    expect(mockedExecFileSync).toHaveBeenNthCalledWith(
      2,
      'secret-tool',
      ['lookup', 'service', 'whatsoup-health-token', 'user', 'test-user'],
      expect.objectContaining({ timeout: 3_000, killSignal: 'SIGKILL' }),
    );
    expect(mockedExecFileSync).toHaveBeenNthCalledWith(
      3,
      'secret-tool',
      ['lookup', 'service', 'whatsoup_health', 'user', 'test-user'],
      expect.objectContaining({ timeout: 3_000, killSignal: 'SIGKILL' }),
    );
  });

  it('keeps the requested macOS account on a migration alias after a scoped canonical miss', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    mockedExecFileSync.mockImplementationOnce(() => { throw new Error('missing canonical'); });
    mockedExecFileSync.mockReturnValueOnce(Buffer.from('legacy-secret\n'));

    expect(lookupCredential('whatsoup-health-token', { user: 'test-user' })).toBe('legacy-secret');
    expect(mockedExecFileSync).toHaveBeenNthCalledWith(
      1,
      'security',
      ['find-generic-password', '-s', 'whatsoup-health-token', '-a', 'test-user', '-w'],
      expect.objectContaining({ timeout: 3_000, killSignal: 'SIGKILL' }),
    );
    expect(mockedExecFileSync).toHaveBeenNthCalledWith(
      2,
      'security',
      ['find-generic-password', '-s', 'whatsoup_health', '-a', 'test-user', '-w'],
      expect.objectContaining({ timeout: 3_000, killSignal: 'SIGKILL' }),
    );
  });

  it('uses legacy whatsoup_health only as migration fallback', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    mockedExecFileSync.mockReturnValueOnce(Buffer.from(''));
    mockedExecFileSync.mockImplementationOnce(() => { throw new Error('missing canonical'); });
    mockedExecFileSync.mockReturnValueOnce(Buffer.from('legacy-secret\n'));

    expect(lookupCredential('whatsoup-health-token', { user: 'test-user' })).toBe('legacy-secret');
    expect(mockedExecFileSync).toHaveBeenNthCalledWith(
      2,
      'secret-tool',
      ['lookup', 'service', 'whatsoup-health-token', 'user', 'test-user'],
      expect.objectContaining({ timeout: 3_000, killSignal: 'SIGKILL' }),
    );
    expect(mockedExecFileSync).toHaveBeenNthCalledWith(
      3,
      'secret-tool',
      ['lookup', 'service', 'whatsoup_health', 'user', 'test-user'],
      expect.objectContaining({ timeout: 3_000, killSignal: 'SIGKILL' }),
    );
  });
});
