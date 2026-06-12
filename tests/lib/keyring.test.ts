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
} from '../../src/lib/keyring.ts';
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
      // --help is intercepted by GLib and exits 0; execFileSync returns empty buffer
      mockedExecFileSync.mockReturnValueOnce(Buffer.from(''));
      expect(detectKeyringBackend()).toBe('secret-tool');
      expect(mockedExecFileSync).toHaveBeenCalledWith('secret-tool', ['--help'], expect.any(Object));
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
