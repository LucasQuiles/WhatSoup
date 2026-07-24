import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock child_process before importing the module
vi.mock('node:child_process', async () => {
  const { childProcessMock } = await import('../helpers/child-process.ts');
  return childProcessMock();
});

import {
  lookupCredential,
  detectKeyringBackend,
  resolveProviderKeyService,
  SERVICE_ENV_MAP,
  _resetBackendCache,
  _setFileStoreDirForTests,
  writeCredential,
  deleteCredential,
  KeyringWriteError,
} from '../../src/lib/keyring.ts';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mockedExecFileSync = vi.mocked(execFileSync);

describe('keyring', () => {
  const originalPlatform = process.platform;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    _resetBackendCache();
    vi.clearAllMocks();
    mockedExecFileSync.mockReset();
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
      // Some builds exit 0 for --help; others exit 2 with a usage banner.
      mockedExecFileSync.mockReturnValueOnce(Buffer.from(''));
      expect(detectKeyringBackend()).toBe('secret-tool');
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'secret-tool',
        ['--help'],
        expect.objectContaining({ timeout: 3_000, killSignal: 'SIGKILL' }),
      );
    });

    it('returns secret-tool when --help prints usage but exits 2', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      mockedExecFileSync.mockImplementationOnce(() => {
        const err: Error & { status?: number; stderr?: Buffer } = new Error('Command failed: secret-tool --help');
        err.status = 2;
        err.stderr = Buffer.from('usage: secret-tool lookup attribute value ...\n');
        throw err;
      });

      expect(detectKeyringBackend()).toBe('secret-tool');
    });

    it('captures secret-tool --help stderr so exit-2 usage can be classified', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      mockedExecFileSync.mockImplementationOnce((_command, _args, options) => {
        const err: Error & { status?: number; stderr?: Buffer | null } = new Error('Command failed: secret-tool --help');
        err.status = 2;
        err.stderr = (options as { stdio?: unknown } | undefined)?.stdio === 'ignore'
          ? null
          : Buffer.from('usage: secret-tool lookup attribute value ...\n');
        throw err;
      });

      expect(detectKeyringBackend()).toBe('secret-tool');
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

    it('QR-157: returns null for a whitespace-only env var (trims to empty, not the empty string)', () => {
      // A whitespace-only value is truthy but trims to '' — returning '' is dangerous
      // for HMAC-key consumers (empty key is forgeable). Must yield null, matching the
      // trim-then-check keyring/file paths.
      Object.defineProperty(process, 'platform', { value: 'linux' });
      for (const ws of ['   ', '\t', '\n', ' \t\n ']) {
        process.env.ANTHROPIC_API_KEY = ws;
        expect(lookupCredential('anthropic')).toBeNull();
      }
    });

    it('falls back to secret-tool on linux', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      mockedExecFileSync.mockReturnValueOnce(Buffer.from('/usr/bin/secret-tool'));
      mockedExecFileSync.mockReturnValueOnce(Buffer.from('my-api-key\n'));

      expect(lookupCredential('anthropic')).toBe('my-api-key');
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'secret-tool',
        ['lookup', 'service', 'anthropic'],
        expect.objectContaining({ timeout: 3_000, killSignal: 'SIGKILL' }),
      );
    });

    it('falls back to macOS keychain on darwin', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      mockedExecFileSync.mockReturnValueOnce(Buffer.from('keychain-value\n'));

      expect(lookupCredential('anthropic')).toBe('keychain-value');
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'security',
        ['find-generic-password', '-s', 'anthropic', '-a', expect.any(String), '-w'],
        expect.objectContaining({ timeout: 3_000, killSignal: 'SIGKILL', maxBuffer: 4_096 }),
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

    // Provider IDs and env var names follow opencode's models.dev catalog
    // (the registry opencode reads at runtime to resolve provider auth), so
    // injecting these vars into the opencode child env activates the provider.
    const FALLBACK_PROVIDER_ENV_VARS: ReadonlyArray<[service: string, envVar: string]> = [
      ['xai', 'XAI_API_KEY'],
      ['groq', 'GROQ_API_KEY'],
      ['mistral', 'MISTRAL_API_KEY'],
      ['openrouter', 'OPENROUTER_API_KEY'],
      ['google', 'GOOGLE_API_KEY'],
      ['fireworks-ai', 'FIREWORKS_API_KEY'],
      ['togetherai', 'TOGETHER_API_KEY'],
    ];

    it.each(FALLBACK_PROVIDER_ENV_VARS)(
      'consults %s via the %s environment variable',
      (service, envVar) => {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        delete process.env[envVar];
        process.env[envVar] = `  ${service}-key-123  `;
        expect(lookupCredential(service)).toBe(`${service}-key-123`);
      },
    );

    it('handles unknown service names without env mapping', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      mockedExecFileSync.mockReturnValueOnce(Buffer.from('/usr/bin/secret-tool'));
      mockedExecFileSync.mockReturnValueOnce(Buffer.from('custom-val'));

      expect(lookupCredential('some_custom_service')).toBe('custom-val');
    });
  });

  describe('resolveProviderKeyService', () => {
    it('maps opencode-cli models to the lower-cased provider prefix', () => {
      expect(resolveProviderKeyService('opencode-cli', 'minimax/MiniMax-M2.7')).toBe('minimax');
      expect(resolveProviderKeyService('opencode-cli', ' DeepSeek/deepseek-chat ')).toBe('deepseek');
    });

    it('maps HTTP API providers to their conventional services', () => {
      expect(resolveProviderKeyService('openai-api', undefined)).toBe('openai');
      expect(resolveProviderKeyService('anthropic-api', undefined)).toBe('anthropic');
    });

    it('honors providerConfig.apiKeyService for HTTP API providers', () => {
      expect(resolveProviderKeyService('openai-api', undefined, { apiKeyService: 'prod-openai' })).toBe('prod-openai');
      expect(resolveProviderKeyService('anthropic-api', undefined, { apiKeyService: 'prod-anthropic' })).toBe('prod-anthropic');
      expect(resolveProviderKeyService('openai-api', undefined, { apiKeyService: ' prod-openai ' })).toBe(' prod-openai ');
      expect(resolveProviderKeyService('opencode-cli', 'minimax/x', { apiKeyService: 'ignored' })).toBe('minimax');
    });

    it('resolves expanded opencode fallback provider prefixes to mapped key services', () => {
      // Pairs mirror opencode's models.dev provider ids (the model prefix
      // opencode-cli sessions are configured with) and the env var opencode
      // reads for that provider. Each resolved service must be registered in
      // SERVICE_ENV_MAP so the child env forwards the key.
      const expected: ReadonlyArray<[model: string, service: string, envVar: string]> = [
        ['kimi/kimi-k3', 'kimi', 'KIMI_API_KEY'],
        ['xai/grok-4', 'xai', 'XAI_API_KEY'],
        ['groq/llama-3.3-70b-versatile', 'groq', 'GROQ_API_KEY'],
        ['mistral/mistral-large-latest', 'mistral', 'MISTRAL_API_KEY'],
        ['openrouter/anthropic/claude-sonnet-4', 'openrouter', 'OPENROUTER_API_KEY'],
        ['google/gemini-2.5-pro', 'google', 'GOOGLE_API_KEY'],
        ['fireworks-ai/accounts/fireworks/models/kimi-k2-instruct', 'fireworks-ai', 'FIREWORKS_API_KEY'],
        ['togetherai/meta-llama/Llama-3.3-70B-Instruct-Turbo', 'togetherai', 'TOGETHER_API_KEY'],
      ];
      for (const [model, service, envVar] of expected) {
        expect(resolveProviderKeyService('opencode-cli', model)).toBe(service);
        expect(SERVICE_ENV_MAP[service]).toBe(envVar);
      }
    });

    it('returns null for native-auth providers and opencode models without a prefix', () => {
      expect(resolveProviderKeyService('claude-cli', undefined)).toBeNull();
      expect(resolveProviderKeyService('codex-cli', undefined)).toBeNull();
      expect(resolveProviderKeyService('gemini-cli', undefined)).toBeNull();
      expect(resolveProviderKeyService('opencode-cli', undefined)).toBeNull();
      expect(resolveProviderKeyService('opencode-cli', '   ')).toBeNull();
      expect(resolveProviderKeyService('opencode-cli', 42)).toBeNull();
      expect(resolveProviderKeyService(null, 'minimax/x')).toBeNull();
    });
  });
});

describe('keyring.ts uncovered-branch coverage', () => {
  const originalPlatform = process.platform;
  const originalEnv = { ...process.env };
  let tmpDir: string;

  beforeEach(() => {
    _resetBackendCache();
    vi.clearAllMocks();
    mockedExecFileSync.mockReset();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.WHATSOUP_HEALTH_TOKEN;
    delete process.env.REQUIRE_OS_KEYRING;
    delete process.env.XDG_CONFIG_HOME;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keyring-cov-'));
    _setFileStoreDirForTests(tmpDir);
  });

  afterEach(() => {
    _setFileStoreDirForTests(null);
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    process.env = { ...originalEnv };
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('detectKeyringBackend — probe-error branches', () => {
    it('warns on benign ENOENT (genuinely absent keyring) and falls back to env-only', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const enoent = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
      mockedExecFileSync.mockImplementationOnce(() => { throw enoent; });
      expect(detectKeyringBackend()).toBe('env-only');
    });

    it('throws when probe errored (non-ENOENT) and REQUIRE_OS_KEYRING is set', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      process.env.REQUIRE_OS_KEYRING = '1';
      mockedExecFileSync.mockImplementationOnce(() => { throw new Error('probe timed out'); });
      expect(() => detectKeyringBackend()).toThrow(/REQUIRE_OS_KEYRING/);
    });

    it('downgrades to env-only on errored probe (non-ENOENT) without REQUIRE_OS_KEYRING', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      mockedExecFileSync.mockImplementationOnce(() => { throw new Error('EACCES boom'); });
      expect(detectKeyringBackend()).toBe('env-only');
    });

    it('treats non-Error probe rejections as env-only downgrade', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      mockedExecFileSync.mockImplementationOnce(() => { throw 'string-error-not-error-instance'; });
      expect(detectKeyringBackend()).toBe('env-only');
    });
  });

  describe('lookupCredential — file store, migration, and user-scope branches', () => {
    it('reads an unscoped private file before consulting the macOS keychain', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      fs.writeFileSync(path.join(tmpDir, 'anthropic.key'), 'private-file-value\n', { mode: 0o600 });

      expect(lookupCredential('anthropic', { skipEnv: true })).toBe('private-file-value');
      expect(mockedExecFileSync).not.toHaveBeenCalled();
    });

    it('reads from file store on env-only backend when env var is absent', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const enoent = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
      mockedExecFileSync.mockImplementationOnce(() => { throw enoent; });
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'anthropic.key'), 'fake-secret-value\n', { mode: 0o600 });
      expect(lookupCredential('anthropic', { skipEnv: true })).toBe('fake-secret-value');
    });

    it('returns null when env-only backend has no file and no env var', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const enoent = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
      mockedExecFileSync.mockImplementationOnce(() => { throw enoent; });
      expect(lookupCredential('anthropic', { skipEnv: true })).toBeNull();
    });

    it('skips migration fallbacks when skipMigrationFallbacks is set', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      mockedExecFileSync.mockReturnValueOnce(Buffer.from('')); // probe
      mockedExecFileSync.mockImplementationOnce(() => { throw new Error('not found'); });
      expect(lookupCredential('whatsoup-health-token', { skipMigrationFallbacks: true })).toBeNull();
      // Only one lookup call should have happened (no migration candidate).
      const lookupCalls = mockedExecFileSync.mock.calls.filter(
        (c) => c[0] === 'secret-tool' && (c[1] as string[])[0] === 'lookup',
      );
      expect(lookupCalls).toHaveLength(1);
    });

    it('tries migration fallback service when primary misses on secret-tool', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      mockedExecFileSync.mockReturnValueOnce(Buffer.from('')); // probe
      mockedExecFileSync.mockImplementationOnce(() => { throw new Error('not found'); }); // primary
      mockedExecFileSync.mockReturnValueOnce(Buffer.from('migrated-token-xyz\n')); // fallback
      // Set the env var so it would short-circuit if envFirst; use user scope to force keyring first.
      process.env.WHATSOUP_HEALTH_TOKEN = 'env-would-win';
      expect(lookupCredential('whatsoup-health-token', { user: 'bot' })).toBe('migrated-token-xyz');
    });

    it('user-scoped lookup consults env after keyring miss (lookupEnvAfterKeyringMiss)', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const enoent = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
      mockedExecFileSync.mockImplementationOnce(() => { throw enoent; });
      process.env.ANTHROPIC_API_KEY = 'env-after-miss-val';
      expect(lookupCredential('anthropic', { user: 'operator' })).toBe('env-after-miss-val');
    });

    it('user-scoped lookup with skipEnv returns null when keyring has nothing', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const enoent = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
      mockedExecFileSync.mockImplementationOnce(() => { throw enoent; });
      expect(lookupCredential('anthropic', { user: 'operator', skipEnv: true })).toBeNull();
    });

    it('does not use an unscoped private file after a user-scoped macOS keychain miss', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      mockedExecFileSync.mockImplementationOnce(() => { throw new Error('keychain miss'); });
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'anthropic.key'), 'mac-fallback-val', { mode: 0o600 });
      expect(lookupCredential('anthropic', { user: 'bot', skipEnv: true })).toBeNull();
      expect(fs.readFileSync(path.join(tmpDir, 'anthropic.key'), 'utf-8')).toBe('mac-fallback-val');
    });

    it('secret-tool lookup with user passes user on primary candidate', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      mockedExecFileSync.mockReturnValueOnce(Buffer.from('')); // probe
      mockedExecFileSync.mockReturnValueOnce(Buffer.from('user-scoped-key\n'));
      expect(lookupCredential('anthropic', { user: 'alice', skipEnv: true })).toBe('user-scoped-key');
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'secret-tool',
        ['lookup', 'service', 'anthropic', 'user', 'alice'],
        expect.objectContaining({ timeout: 3_000, killSignal: 'SIGKILL' }),
      );
    });
  });

  describe('writeCredential — all backends and error classifications', () => {
    it('writes to macOS keychain and reports the backend', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      mockedExecFileSync.mockReturnValueOnce(Buffer.from(''));
      expect(writeCredential('anthropic', 'fake-secret-value')).toEqual({ backend: 'macos-keychain' });
    });

    it('classifies macOS keychain lock (status 36) as KEYRING_LOCKED', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      const err = Object.assign(new Error('locked'), { status: 36, stderr: 'interaction is not allowed' });
      mockedExecFileSync.mockImplementationOnce(() => { throw err; });
      expect(() => writeCredential('anthropic', 'fake-secret-value')).toThrow(KeyringWriteError);
      try {
        writeCredential('anthropic', 'fake-secret-value');
      } catch (e) {
        expect((e as KeyringWriteError).code).toBe('KEYRING_LOCKED');
      }
    });

    it('classifies macOS status 45 / errSecAuthFailed as KEYRING_ACCESS_DENIED', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      const err = Object.assign(new Error('denied'), { status: 45, stderr: 'errSecAuthFailed' });
      mockedExecFileSync.mockImplementationOnce(() => { throw err; });
      try {
        writeCredential('anthropic', 'fake-secret-value');
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(KeyringWriteError);
        expect((e as KeyringWriteError).code).toBe('KEYRING_ACCESS_DENIED');
      }
    });

    it('classifies unknown macOS failure as KEYRING_WRITE_FAILED', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      const err = Object.assign(new Error('boom'), { status: 99, stderr: 'something else' });
      mockedExecFileSync.mockImplementationOnce(() => { throw err; });
      try {
        writeCredential('anthropic', 'fake-secret-value');
        throw new Error('should have thrown');
      } catch (e) {
        expect((e as KeyringWriteError).code).toBe('KEYRING_WRITE_FAILED');
      }
    });

    it('writes to secret-tool and reports secret-tool backend', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      mockedExecFileSync.mockReturnValueOnce(Buffer.from('')); // probe
      mockedExecFileSync.mockReturnValueOnce(Buffer.from(''));
      expect(writeCredential('anthropic', 'fake-secret-value')).toEqual({ backend: 'secret-tool' });
    });

    it('throws KEYRING_WRITE_FAILED when secret-tool store fails', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      mockedExecFileSync.mockReturnValueOnce(Buffer.from('')); // probe
      mockedExecFileSync.mockImplementationOnce(() => { throw new Error('store failed'); });
      expect(() => writeCredential('anthropic', 'fake-secret-value')).toThrow(/secret-tool store failed/);
    });

    it('writes to 0600 file store on env-only backend', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const enoent = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
      mockedExecFileSync.mockImplementationOnce(() => { throw enoent; });
      expect(writeCredential('anthropic', 'fake-secret-value')).toEqual({ backend: 'env-only' });
      const stored = fs.readFileSync(path.join(tmpDir, 'anthropic.key'), 'utf-8');
      expect(stored).toBe('fake-secret-value');
    });

    it('throws KEYRING_WRITE_FAILED when file-store write fails', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const enoent = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
      mockedExecFileSync.mockImplementationOnce(() => { throw enoent; });
      // Point file store at a path whose parent cannot be created (a file blocks mkdir).
      const blocker = path.join(tmpDir, 'blocker-file');
      fs.writeFileSync(blocker, 'x', { mode: 0o600 });
      _setFileStoreDirForTests(path.join(blocker, 'credentials'));
      expect(() => writeCredential('anthropic', 'fake-secret-value')).toThrow(/file-store write failed/);
    });
  });

  describe('deleteCredential — all backends', () => {
    it('deletes from macOS keychain and reports deleted=true', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      mockedExecFileSync.mockReturnValueOnce(Buffer.from(''));
      expect(deleteCredential('anthropic')).toEqual({ deleted: true, backend: 'macos-keychain' });
    });

    it('returns deleted=false when macOS keychain delete throws', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      mockedExecFileSync.mockImplementationOnce(() => { throw new Error('not found'); });
      expect(deleteCredential('anthropic')).toEqual({ deleted: false, backend: 'macos-keychain' });
    });

    it('deletes from secret-tool and reports deleted=true', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      mockedExecFileSync.mockReturnValueOnce(Buffer.from('')); // probe
      mockedExecFileSync.mockReturnValueOnce(Buffer.from(''));
      expect(deleteCredential('anthropic')).toEqual({ deleted: true, backend: 'secret-tool' });
    });

    it('returns deleted=false when secret-tool clear throws', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      mockedExecFileSync.mockReturnValueOnce(Buffer.from('')); // probe
      mockedExecFileSync.mockImplementationOnce(() => { throw new Error('clear failed'); });
      expect(deleteCredential('anthropic')).toEqual({ deleted: false, backend: 'secret-tool' });
    });

    it('deletes the file-store entry on env-only backend', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const enoent = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
      mockedExecFileSync.mockImplementationOnce(() => { throw enoent; });
      fs.mkdirSync(tmpDir, { recursive: true });
      const file = path.join(tmpDir, 'anthropic.key');
      fs.writeFileSync(file, 'fake-secret-value', { mode: 0o600 });
      expect(deleteCredential('anthropic')).toEqual({ deleted: true, backend: 'env-only' });
      expect(fs.existsSync(file)).toBe(false);
    });

    it('returns deleted=false on env-only when the file is absent', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const enoent = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
      mockedExecFileSync.mockImplementationOnce(() => { throw enoent; });
      expect(deleteCredential('anthropic')).toEqual({ deleted: false, backend: 'env-only' });
    });

    it('honors explicit user option in macOS keychain delete', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      mockedExecFileSync.mockReturnValueOnce(Buffer.from(''));
      deleteCredential('anthropic', { user: 'bot' });
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'security',
        ['delete-generic-password', '-s', 'anthropic', '-a', 'bot'],
        expect.objectContaining({ timeout: 3_000, killSignal: 'SIGKILL' }),
      );
    });
  });

  describe('file-store write/read round-trip via _setFileStoreDirForTests', () => {
    it('round-trips a value through the file store on env-only backend', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const enoent = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
      mockedExecFileSync.mockImplementationOnce(() => { throw enoent; });
      writeCredential('elevenlabs', 'stub-token-xyz');
      // Subsequent lookup on env-only reads from the file store.
      mockedExecFileSync.mockImplementationOnce(() => { throw enoent; });
      expect(lookupCredential('elevenlabs', { skipEnv: true })).toBe('stub-token-xyz');
    });
  });
});
