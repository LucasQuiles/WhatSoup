import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the keyring module BEFORE importing the resolver under test.
vi.mock('../../src/lib/keyring.ts', () => ({
  lookupCredential: vi.fn(),
}));

// Mock the logger so the QR-104 observability warn can be asserted. Hoisted so
// the vi.mock factory (which is hoisted above imports) can reference it.
const { mockLog } = vi.hoisted(() => ({
  mockLog: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => mockLog,
}));

import { resolveApiKey } from '../../src/lib/api-key-resolver.ts';
import { lookupCredential } from '../../src/lib/keyring.ts';

const mockedLookup = vi.mocked(lookupCredential);

describe('resolveApiKey', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('precedence', () => {
    it('prefers inline apiKey when non-empty (over service and env)', () => {
      process.env.OPENAI_API_KEY = 'env-key';
      mockedLookup.mockReturnValue('keyring-key');

      const result = resolveApiKey({
        inline: 'inline-key',
        service: 'my-service',
        envVar: 'OPENAI_API_KEY',
      });

      expect(result).toBe('inline-key');
      // Inline wins — should not have consulted keyring or env.
      expect(mockedLookup).not.toHaveBeenCalled();
    });

    it('resolves apiKeyService via lookupCredential when no inline key is provided', () => {
      process.env.OPENAI_API_KEY = 'env-key';
      mockedLookup.mockReturnValue('keyring-key');

      const result = resolveApiKey({
        service: 'my-service',
        envVar: 'OPENAI_API_KEY',
      });

      expect(result).toBe('keyring-key');
      expect(mockedLookup).toHaveBeenCalledWith('my-service');
    });

    it('uses the canonical keyring service when no explicit service is set', () => {
      process.env.OPENAI_API_KEY = 'env-key';
      mockedLookup.mockReturnValue('canonical-keyring-key');

      const result = resolveApiKey({
        envVar: 'OPENAI_API_KEY',
      });

      expect(result).toBe('canonical-keyring-key');
      expect(mockedLookup).toHaveBeenCalledWith('openai', { skipEnv: true });
    });

    it('uses the canonical Pinecone keyring service before its env fallback', () => {
      process.env.PINECONE_API_KEY = 'pinecone-env-key';
      mockedLookup.mockReturnValue('pinecone-keyring-key');

      const result = resolveApiKey({ envVar: 'PINECONE_API_KEY' });

      expect(result).toBe('pinecone-keyring-key');
      expect(mockedLookup).toHaveBeenCalledWith('pinecone', { skipEnv: true });
    });

    it('falls back to env var when service resolves to null (misconfigured service)', () => {
      process.env.ANTHROPIC_API_KEY = 'env-key';
      mockedLookup.mockReturnValue(null);

      const result = resolveApiKey({
        service: 'missing-service',
        envVar: 'ANTHROPIC_API_KEY',
      });

      expect(result).toBe('env-key');
      expect(mockedLookup).toHaveBeenCalledWith('missing-service');
    });

    it('falls back to env var when service resolves to empty string', () => {
      process.env.ANTHROPIC_API_KEY = 'env-key';
      mockedLookup.mockReturnValue('');

      const result = resolveApiKey({
        service: 'misconfigured',
        envVar: 'ANTHROPIC_API_KEY',
      });

      expect(result).toBe('env-key');
    });

    it('treats empty inline apiKey as absent and continues resolution chain', () => {
      process.env.OPENAI_API_KEY = 'env-key';
      mockedLookup.mockReturnValue('keyring-key');

      const result = resolveApiKey({
        inline: '',
        service: 'my-service',
        envVar: 'OPENAI_API_KEY',
      });

      expect(result).toBe('keyring-key');
    });

    it('returns empty string when nothing is configured', () => {
      mockedLookup.mockReturnValue(null);
      const result = resolveApiKey({
        envVar: 'OPENAI_API_KEY',
      });

      expect(result).toBe('');
    });

    it('does not call lookupCredential when service is empty string', () => {
      process.env.OPENAI_API_KEY = 'env-key';

      const result = resolveApiKey({
        service: '',
        envVar: 'OPENAI_API_KEY',
      });

      expect(result).toBe('env-key');
      expect(mockedLookup).not.toHaveBeenCalled();
    });

    it('falls back to env when the inferred canonical service misses', () => {
      process.env.OPENAI_API_KEY = 'env-key';
      mockedLookup.mockReturnValue(null);

      const result = resolveApiKey({
        envVar: 'OPENAI_API_KEY',
      });

      expect(result).toBe('env-key');
      expect(mockedLookup).toHaveBeenCalledWith('openai', { skipEnv: true });
    });
  });

  // QR-104: the configured-service → env fallback must be OBSERVABLE, so a
  // silent wrong-account (account-isolation break) is detectable to operators.
  describe('observability (QR-104)', () => {
    it('warns when a configured service misses and the env fallback is used', () => {
      process.env.ANTHROPIC_API_KEY = 'env-key';
      mockedLookup.mockReturnValue(null);

      const result = resolveApiKey({
        service: 'missing-service',
        envVar: 'ANTHROPIC_API_KEY',
      });

      // Behavior is unchanged (still returns the env key)…
      expect(result).toBe('env-key');
      // …but the fallback is now logged with the service + envVar for triage.
      expect(mockLog.warn).toHaveBeenCalledTimes(1);
      expect(mockLog.warn).toHaveBeenCalledWith(
        { service: 'missing-service', envVar: 'ANTHROPIC_API_KEY' },
        expect.stringContaining('keyring lookup missed'),
      );
    });

    it('does NOT warn when the keyring hit resolves the key (no fallback)', () => {
      process.env.ANTHROPIC_API_KEY = 'env-key';
      mockedLookup.mockReturnValue('keyring-key');

      const result = resolveApiKey({
        service: 'good-service',
        envVar: 'ANTHROPIC_API_KEY',
      });

      expect(result).toBe('keyring-key');
      expect(mockLog.warn).not.toHaveBeenCalled();
    });

    it('does NOT warn when the service misses AND the env is also empty (visible missing-key, not silent)', () => {
      // No ANTHROPIC_API_KEY set → fallback yields '' → surfaced downstream, no warn.
      mockedLookup.mockReturnValue(null);

      const result = resolveApiKey({
        service: 'missing-service',
        envVar: 'ANTHROPIC_API_KEY',
      });

      expect(result).toBe('');
      expect(mockLog.warn).not.toHaveBeenCalled();
    });

    it('warns when the inferred canonical service misses and env is used', () => {
      process.env.ANTHROPIC_API_KEY = 'env-key';
      mockedLookup.mockReturnValue(null);

      const result = resolveApiKey({ envVar: 'ANTHROPIC_API_KEY' });

      expect(result).toBe('env-key');
      expect(mockLog.warn).toHaveBeenCalledWith(
        { service: 'anthropic', envVar: 'ANTHROPIC_API_KEY' },
        expect.stringContaining('keyring lookup missed'),
      );
    });
  });

  // W-3 (Phase C): allowEnvFallback flag restricts the resolver to keyring-only.
  describe('allowEnvFallback (W-3 precedence reversal)', () => {
    it('uses the inferred canonical service when allowEnvFallback is false', () => {
      process.env.OPENAI_API_KEY = 'env-key';
      mockedLookup.mockReturnValue('keyring-key');

      const result = resolveApiKey({
        envVar: 'OPENAI_API_KEY',
        allowEnvFallback: false,
      });

      expect(result).toBe('keyring-key');
      expect(mockedLookup).toHaveBeenCalledWith('openai', { skipEnv: true });
    });

    it('returns empty string when allowEnvFallback is false, service is set, and keyring misses', () => {
      process.env.ANTHROPIC_API_KEY = 'env-key';
      mockedLookup.mockReturnValue(null);

      const result = resolveApiKey({
        service: 'anthropic',
        envVar: 'ANTHROPIC_API_KEY',
        allowEnvFallback: false,
      });

      expect(result).toBe('');
      // Keyring was consulted, env was NOT.
      expect(mockedLookup).toHaveBeenCalledWith('anthropic');
    });

    it('returns the keyring value when allowEnvFallback is false and keyring hits', () => {
      process.env.ANTHROPIC_API_KEY = 'env-key';
      mockedLookup.mockReturnValue('keyring-key');

      const result = resolveApiKey({
        service: 'anthropic',
        envVar: 'ANTHROPIC_API_KEY',
        allowEnvFallback: false,
      });

      expect(result).toBe('keyring-key');
    });

    it('does NOT warn about env fallback when allowEnvFallback is false (no fallback happened)', () => {
      process.env.ANTHROPIC_API_KEY = 'env-key';
      mockedLookup.mockReturnValue(null);

      resolveApiKey({
        service: 'anthropic',
        envVar: 'ANTHROPIC_API_KEY',
        allowEnvFallback: false,
      });

      expect(mockLog.warn).not.toHaveBeenCalled();
    });

    it('inline key still wins when allowEnvFallback is false', () => {
      process.env.OPENAI_API_KEY = 'env-key';

      const result = resolveApiKey({
        inline: 'inline-key',
        envVar: 'OPENAI_API_KEY',
        allowEnvFallback: false,
      });

      expect(result).toBe('inline-key');
    });

    it('defaults to true (backward-compatible env fallback) when not specified', () => {
      process.env.OPENAI_API_KEY = 'env-key';

      const result = resolveApiKey({
        envVar: 'OPENAI_API_KEY',
      });

      expect(result).toBe('env-key');
    });
  });
});
