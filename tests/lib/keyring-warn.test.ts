/**
 * Fail-loud logging for keyring.ts:
 *  - warns once when backend probe fails and caches 'env-only'
 *  - warns when a keyring read throws and falls back to env
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const logWarn = vi.hoisted(() => vi.fn());

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({ warn: logWarn }),
}));

vi.mock('node:child_process', async () => {
  const { childProcessMock } = await import('../helpers/child-process.ts');
  return childProcessMock();
});

import { lookupCredential, detectKeyringBackend, _resetBackendCache } from '../../src/lib/keyring.ts';
import { execFileSync } from 'node:child_process';

const mockedExecFileSync = vi.mocked(execFileSync);

describe('keyring fail-loud logging', () => {
  const originalPlatform = process.platform;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    _resetBackendCache();
    vi.clearAllMocks();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.WHATSOUP_HEALTH_TOKEN;
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
    process.env = { ...originalEnv };
  });

  describe('backend probe failure warning', () => {
    it('warns once when secret-tool probe fails and backend falls back to env-only', () => {
      Object.defineProperty(process, 'platform', { value: 'linux', writable: true });
      mockedExecFileSync.mockImplementationOnce(() => { throw new Error('not found'); });

      detectKeyringBackend();

      expect(logWarn).toHaveBeenCalledOnce();
      expect(logWarn).toHaveBeenCalledWith(
        expect.objectContaining({ backend: 'env-only', err: 'not found' }),
        expect.stringContaining('keyring backend probe failed'),
      );
    });

    it('does not warn when backend probe succeeds (secret-tool found)', () => {
      Object.defineProperty(process, 'platform', { value: 'linux', writable: true });
      mockedExecFileSync.mockReturnValueOnce(Buffer.from(''));

      detectKeyringBackend();

      expect(logWarn).not.toHaveBeenCalled();
    });

    it('does not warn on darwin (no probe attempted)', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', writable: true });

      detectKeyringBackend();

      expect(logWarn).not.toHaveBeenCalled();
    });

    it('warns only once per process (cached result — no second probe, no second warn)', () => {
      Object.defineProperty(process, 'platform', { value: 'linux', writable: true });
      mockedExecFileSync.mockImplementationOnce(() => { throw new Error('not found'); });

      detectKeyringBackend();
      detectKeyringBackend();

      expect(logWarn).toHaveBeenCalledOnce();
    });
  });

  describe('keyring read failure warning', () => {
    it('warns with service name and error when secret-tool lookup throws', () => {
      Object.defineProperty(process, 'platform', { value: 'linux', writable: true });
      // First call: probe succeeds (backend = secret-tool)
      mockedExecFileSync.mockReturnValueOnce(Buffer.from(''));
      // Second call: actual lookup throws
      mockedExecFileSync.mockImplementationOnce(() => { throw new Error('secret-tool failed'); });

      lookupCredential('anthropic', { skipEnv: true });

      expect(logWarn).toHaveBeenCalledWith(
        expect.objectContaining({ service: 'anthropic', backend: 'secret-tool', err: 'secret-tool failed' }),
        expect.stringContaining('keyring read failed'),
      );
    });

    it('warns with service name and error when macOS keychain lookup throws', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', writable: true });
      mockedExecFileSync.mockImplementationOnce(() => { throw new Error('keychain error'); });

      lookupCredential('anthropic', { skipEnv: true });

      expect(logWarn).toHaveBeenCalledWith(
        expect.objectContaining({ service: 'anthropic', backend: 'macos-keychain', err: 'keychain error' }),
        expect.stringContaining('keyring read failed'),
      );
    });

    it('does not include secret values in the warn log', () => {
      Object.defineProperty(process, 'platform', { value: 'linux', writable: true });
      mockedExecFileSync.mockReturnValueOnce(Buffer.from(''));
      mockedExecFileSync.mockImplementationOnce(() => { throw new Error('fail'); });

      process.env.ANTHROPIC_API_KEY = 'test-api-key-value-xyz';
      lookupCredential('anthropic', { skipEnv: false });

      for (const call of logWarn.mock.calls) {
        const callStr = JSON.stringify(call);
        expect(callStr).not.toContain('test-api-key-value-xyz');
      }
    });
  });
});
