import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the keyring module BEFORE importing the resolver under test.
vi.mock('../../../../src/lib/keyring.ts', () => ({
  lookupCredential: vi.fn(),
}));

import { resolveApiKey } from '../../../../src/runtimes/agent/providers/api-key-resolver.ts';
import { lookupCredential } from '../../../../src/lib/keyring.ts';

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

    it('falls back to env var when no inline key and no service is set', () => {
      process.env.OPENAI_API_KEY = 'env-key';

      const result = resolveApiKey({
        envVar: 'OPENAI_API_KEY',
      });

      expect(result).toBe('env-key');
      expect(mockedLookup).not.toHaveBeenCalled();
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

    it('does not call lookupCredential when service is undefined', () => {
      process.env.OPENAI_API_KEY = 'env-key';

      const result = resolveApiKey({
        envVar: 'OPENAI_API_KEY',
      });

      expect(result).toBe('env-key');
      expect(mockedLookup).not.toHaveBeenCalled();
    });
  });
});
