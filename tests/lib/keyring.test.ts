import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock child_process before importing the module
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { lookupCredential, detectKeyringBackend, _resetBackendCache } from '../../src/lib/keyring.ts';
import { execFileSync } from 'node:child_process';

const mockedExecFileSync = vi.mocked(execFileSync);

describe('keyring', () => {
  const originalPlatform = process.platform;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    _resetBackendCache();
    vi.clearAllMocks();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    delete process.env.WHATSOUP_HEALTH_TOKEN;
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    process.env = { ...originalEnv };
  });

  describe('detectKeyringBackend', () => {
    it('returns macos-keychain on darwin', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      expect(detectKeyringBackend()).toBe('macos-keychain');
    });

    it('returns secret-tool on linux when available', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      mockedExecFileSync.mockReturnValueOnce(Buffer.from('/usr/bin/secret-tool'));
      expect(detectKeyringBackend()).toBe('secret-tool');
      expect(mockedExecFileSync).toHaveBeenCalledWith('which', ['secret-tool'], expect.any(Object));
    });

    it('returns env-only on linux when secret-tool unavailable', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      mockedExecFileSync.mockImplementationOnce(() => { throw new Error('not found'); });
      expect(detectKeyringBackend()).toBe('env-only');
    });

    it('caches the result', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      detectKeyringBackend();
      detectKeyringBackend();
      expect(mockedExecFileSync).not.toHaveBeenCalled();
    });
  });

  describe('lookupCredential', () => {
    it('prefers environment variable over keyring', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      process.env.ANTHROPIC_API_KEY = '  sk-test-123  ';
      expect(lookupCredential('anthropic')).toBe('sk-test-123');
    });

    it('falls back to secret-tool on linux', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      mockedExecFileSync.mockReturnValueOnce(Buffer.from('/usr/bin/secret-tool'));
      mockedExecFileSync.mockReturnValueOnce(Buffer.from('my-api-key\n'));

      expect(lookupCredential('anthropic')).toBe('my-api-key');
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'secret-tool',
        ['lookup', 'service', 'anthropic'],
        expect.any(Object),
      );
    });

    it('falls back to macOS keychain on darwin', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      mockedExecFileSync.mockReturnValueOnce(Buffer.from('keychain-value\n'));

      expect(lookupCredential('anthropic')).toBe('keychain-value');
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'security',
        ['find-generic-password', '-s', 'anthropic', '-a', expect.any(String), '-w'],
        expect.any(Object),
      );
    });

    it('returns null when keyring lookup fails', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      mockedExecFileSync.mockReturnValueOnce(Buffer.from('/usr/bin/secret-tool'));
      mockedExecFileSync.mockImplementationOnce(() => { throw new Error('not found'); });

      expect(lookupCredential('anthropic')).toBeNull();
    });

    it('returns null for empty keyring value', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      mockedExecFileSync.mockReturnValueOnce(Buffer.from('/usr/bin/secret-tool'));
      mockedExecFileSync.mockReturnValueOnce(Buffer.from('  \n'));

      expect(lookupCredential('anthropic')).toBeNull();
    });

    it('returns null on env-only backend with no env var set', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      mockedExecFileSync.mockImplementationOnce(() => { throw new Error('not found'); });

      expect(lookupCredential('anthropic')).toBeNull();
    });

    it('handles unknown service names without env mapping', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      mockedExecFileSync.mockReturnValueOnce(Buffer.from('/usr/bin/secret-tool'));
      mockedExecFileSync.mockReturnValueOnce(Buffer.from('custom-val'));

      expect(lookupCredential('some_custom_service')).toBe('custom-val');
    });
  });
});
