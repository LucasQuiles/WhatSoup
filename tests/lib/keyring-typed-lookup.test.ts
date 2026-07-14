import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock child_process before importing the module — same pattern as
// tests/lib/keyring.test.ts. The typed wrapper delegates to the real
// lookupCredential, so we control the backend + env rather than mocking
// the function itself.
vi.mock('node:child_process', async () => {
  const { childProcessMock } = await import('../helpers/child-process.ts');
  return childProcessMock();
});

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  lookupCredentialTyped,
  isKnownService,
  SERVICE_ENV_MAP,
  _resetBackendCache,
  _setFileStoreDirForTests,
} from '../../src/lib/keyring.ts';
import { execFileSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';

const mockedExecFileSync = vi.mocked(execFileSync);

describe('isKnownService (closed-id gate)', () => {
  it('returns true for services in SERVICE_ENV_MAP', () => {
    expect(isKnownService('anthropic')).toBe(true);
    expect(isKnownService('openai')).toBe(true);
    expect(isKnownService('pinecone')).toBe(true);
    expect(isKnownService('elevenlabs')).toBe(true);
    expect(isKnownService('whatsoup-health-token')).toBe(true);
  });

  it('returns false for services not in SERVICE_ENV_MAP', () => {
    expect(isKnownService('arbitrary-service')).toBe(false);
    expect(isKnownService('')).toBe(false);
    expect(isKnownService('whatsoup')).toBe(false);
    expect(isKnownService('admin')).toBe(false);
    expect(isKnownService('root-token')).toBe(false);
  });

  it('does NOT accept SERVICE_MIGRATION_FALLBACKS aliases that are not in SERVICE_ENV_MAP', () => {
    // 'zai-api-key' is a fallback alias for 'glm' but is NOT a registry key.
    // Callers must use the canonical name 'glm'.
    expect(isKnownService('zai-api-key')).toBe(false);
    expect(isKnownService('gemini')).toBe(false);
  });
});

describe('lookupCredentialTyped', () => {
  const originalEnv = { ...process.env };
  const tmpDir = path.join(os.tmpdir(), `whatsoup-keyring-typed-test-${process.pid}`);

  beforeEach(() => {
    _resetBackendCache();
    _setFileStoreDirForTests(tmpDir);
    vi.clearAllMocks();
    // Default: secret-tool probe succeeds → backend is 'secret-tool'.
    mockedExecFileSync.mockReturnValueOnce(Buffer.from(''));
    // Clean all known env vars.
    for (const envVar of Object.values(SERVICE_ENV_MAP)) {
      delete process.env[envVar];
    }
  });

  afterEach(() => {
    _setFileStoreDirForTests(null);
    process.env = { ...originalEnv };
  });

  describe('closed-id gate (unknown_service)', () => {
    it('rejects services not in SERVICE_ENV_MAP with reason unknown_service', () => {
      const result = lookupCredentialTyped('arbitrary-service');
      expect(result).toEqual({
        value: null,
        reason: 'unknown_service',
        service: 'arbitrary-service',
      });
      // The gate must NOT reach the keyring backend at all — execFileSync
      // should never be called (not even the backend probe), because the
      // closed-id gate short-circuits before detectKeyringBackend().
      expect(mockedExecFileSync).not.toHaveBeenCalled();
    });

    it('rejects empty string service names', () => {
      const result = lookupCredentialTyped('');
      expect(result.reason).toBe('unknown_service');
    });

    it('rejects service names that look like env var names', () => {
      // An operator might mistakenly pass the env var name instead of the
      // service name. The gate catches this.
      const result = lookupCredentialTyped('ANTHROPIC_API_KEY');
      expect(result.reason).toBe('unknown_service');
    });

    it('rejects service names that look like file paths', () => {
      const result = lookupCredentialTyped('/etc/shadow');
      expect(result.reason).toBe('unknown_service');
    });
  });

  describe('known service — value found via env (ok)', () => {
    it('returns the env value with reason ok', () => {
      process.env.OPENAI_API_KEY = 'sk-test-key';

      const result = lookupCredentialTyped('openai');

      expect(result).toEqual({
        value: 'sk-test-key',
        reason: 'ok',
        service: 'openai',
      });
    });

    it('returns the env value for anthropic', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';

      const result = lookupCredentialTyped('anthropic');

      expect(result.value).toBe('sk-ant-test');
      expect(result.reason).toBe('ok');
    });
  });

  describe('known service — value not found (not_found)', () => {
    it('returns null with reason not_found when no credential is available', () => {
      // No env var set, no keyring entry (execFileSync returns empty → no value),
      // no file store entry. secret-tool lookup throws (item not found).
      mockedExecFileSync.mockImplementation(() => {
        throw new Error('item not found');
      });

      const result = lookupCredentialTyped('pinecone');

      expect(result).toEqual({
        value: null,
        reason: 'not_found',
        service: 'pinecone',
      });
    });

    it('returns null with reason not_found for a service with empty env var', () => {
      // Whitespace-only env var trims to empty → null → not_found.
      process.env.ELEVENLABS_API_KEY = '   ';

      const result = lookupCredentialTyped('elevenlabs');

      expect(result.reason).toBe('not_found');
      expect(result.value).toBe(null);
    });
  });

  describe('options pass-through', () => {
    it('passes skipEnv option through to lookupCredential', () => {
      // With skipEnv: true, even if the env var is set, the lookup should
      // go to the keyring (which throws → not found).
      process.env.OPENAI_API_KEY = 'sk-test';
      mockedExecFileSync.mockImplementation(() => {
        throw new Error('item not found');
      });

      const result = lookupCredentialTyped('openai', { skipEnv: true });

      expect(result.reason).toBe('not_found');
    });

    it('passes user option through to lookupCredential', () => {
      process.env.WHATSOUP_HEALTH_TOKEN = 'health-token';

      const result = lookupCredentialTyped('whatsoup-health-token');

      // env-first lookup for service-wide lookups (user === undefined).
      expect(result.value).toBe('health-token');
      expect(result.reason).toBe('ok');
    });
  });

  describe('every SERVICE_ENV_MAP entry is accepted by the gate', () => {
    // Table-driven: every registered service must pass isKnownService and
    // reach lookupCredential (not be short-circuited by the gate).
    it.each(Object.keys(SERVICE_ENV_MAP))('accepts service "%s"', (service) => {
      // Set the env var for this service so the lookup succeeds.
      const envVar = SERVICE_ENV_MAP[service];
      process.env[envVar] = 'test-value';

      const result = lookupCredentialTyped(service);

      expect(result.reason).toBe('ok');
      expect(result.value).toBe('test-value');
    });
  });
});
