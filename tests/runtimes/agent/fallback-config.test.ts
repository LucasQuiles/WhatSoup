/**
 * fallback-config.test.ts — branch coverage for the two exported helpers in
 * src/runtimes/agent/fallback-config.ts.
 *
 * `fallbackProviderConfigFor` is fully pure (5 branches):
 *   - provider undefined                  → undefined
 *   - provider === 'opencode-cli'         → inherit except primary endpoint fields
 *   - provider === agentProvider          → agentProviderConfig (inherit)
 *   - provider === 'openai-api'/'anthropic-api' → agentProviderConfig (inherit)
 *   - else                                → undefined
 *
 * `fallbackKeyPresent` delegates to mocked keyring helpers and has 3 branches:
 *   - service resolves falsy              → null (lookupCredential NOT called)
 *   - service truthy, credential present  → true
 *   - service truthy, credential absent   → false
 *
 * The keyring module is fully mocked so no real credential I/O happens. All
 * test scenarios are synchronous; no timers are required.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/lib/keyring.ts', () => ({
  resolveProviderKeyService: vi.fn(),
  lookupCredential: vi.fn(),
}));

import { resolveProviderKeyService, lookupCredential } from '../../../src/lib/keyring.ts';
import { fallbackProviderConfigFor, fallbackKeyPresent } from '../../../src/runtimes/agent/fallback-config.ts';

const mockedResolve = vi.mocked(resolveProviderKeyService);
const mockedLookup = vi.mocked(lookupCredential);

describe('fallback-config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Sensible defaults: an inherited config resolves to a service, and a
    // service lookup returns no credential. Individual tests override as
    // needed.
    mockedResolve.mockReturnValue('service-default');
    mockedLookup.mockReturnValue(null);
  });

  // ─── fallbackProviderConfigFor ──────────────────────────────────────────────

  describe('fallbackProviderConfigFor', () => {
    it('returns undefined when provider is undefined (terminal: inherit-sibling still returns cfg)', () => {
      const cfg: Record<string, unknown> = { api: 'value' };
      // The early-return path: provider === undefined → undefined.
      expect(fallbackProviderConfigFor(undefined, 'openai', cfg)).toBeUndefined();
      // Pair the lone undefined assertion with a concrete positive case so the
      // terminal assertion is strong. The inherit path returns the SAME
      // agentProviderConfig object (identity).
      expect(fallbackProviderConfigFor('openai', 'openai', cfg)).toBe(cfg);
    });

    it('inherits agentProviderConfig when provider equals agentProvider (identity)', () => {
      const cfg: Record<string, unknown> = { model: 'gpt-x', baseUrl: 'https://example.test' };
      // Terminal concrete assertion: identity (same object reference).
      expect(fallbackProviderConfigFor('anthropic', 'anthropic', cfg)).toBe(cfg);
    });

    it('strips primary endpoint fields from every OpenCode fallback execution config', () => {
      const cfg: Record<string, unknown> = {
        baseUrl: 'https://primary-openai.example/v1',
        apiKeyService: 'openai',
        executionProfile: 'whatsoup-headless',
        budget: { requestsPerMinute: 10 },
      };
      const expected = {
        executionProfile: 'whatsoup-headless',
        budget: { requestsPerMinute: 10 },
      };

      expect(fallbackProviderConfigFor('opencode-cli', 'opencode-cli', cfg)).toEqual(expected);
      expect(fallbackProviderConfigFor('opencode-cli', 'openai-api', cfg)).toEqual(expected);
    });

    it('inherits agentProviderConfig when provider is openai-api (identity)', () => {
      const cfg: Record<string, unknown> = { model: 'gpt-x' };
      expect(fallbackProviderConfigFor('openai-api', 'openai', cfg)).toBe(cfg);
    });

    it('inherits agentProviderConfig when provider is anthropic-api (identity)', () => {
      const cfg: Record<string, unknown> = { model: 'claude-x' };
      expect(fallbackProviderConfigFor('anthropic-api', 'openai', cfg)).toBe(cfg);
    });

    it('returns undefined for an unrelated provider (terminal: assert against a concrete cfg too)', () => {
      const cfg: Record<string, unknown> = { foo: 'bar' };
      // Lone-undefined would be a weak terminal. Pair it with a concrete
      // positive assertion: when the unrelated provider happens to equal the
      // agentProvider, the inherit path is reached and returns cfg by
      // identity. That keeps the test bound to real values on its last line.
      expect(fallbackProviderConfigFor('groq', 'openai', cfg)).toBeUndefined();
      expect(fallbackProviderConfigFor('groq', 'groq', cfg)).toBe(cfg);
    });
  });

  // ─── fallbackKeyPresent ────────────────────────────────────────────────────

  describe('fallbackKeyPresent', () => {
    it('returns null and skips lookupCredential when resolveProviderKeyService yields no service', () => {
      // resolveProviderKeyService returns string | null, so the falsy branch
      // is exercised by returning an empty string (also caught by `!service`).
      mockedResolve.mockReturnValueOnce('');

      const result = fallbackKeyPresent('openai', 'gpt-x', 'openai', { model: 'gpt-x' });

      // Terminal concrete assertion: result is null AND the short-circuit
      // (lookupCredential not invoked) is observable.
      expect(result).toBe(null);
      expect(mockedLookup).not.toHaveBeenCalled();
    });

    it('returns true when a credential is present (and threads providerConfig through to resolver)', () => {
      mockedResolve.mockReturnValueOnce('svc-openai');
      mockedLookup.mockReturnValueOnce('present');

      const cfg: Record<string, unknown> = { model: 'gpt-x' };
      const result = fallbackKeyPresent('openai', 'gpt-x', 'openai', cfg);

      // Terminal concrete assertion: result === true AND the resolver was
      // called with the expected provider/model/inherited config object
      // (identity on the 3rd arg).
      expect(result).toBe(true);
      expect(mockedResolve).toHaveBeenCalledWith('openai', 'gpt-x', cfg);
    });

    it('returns false when a credential is absent (lookupCredential returns null)', () => {
      mockedResolve.mockReturnValueOnce('svc-openai');
      mockedLookup.mockReturnValueOnce(null);

      const result = fallbackKeyPresent('openai', 'gpt-x', 'openai', { model: 'gpt-x' });

      // Terminal concrete assertion: result === false.
      expect(result).toBe(false);
    });

    it('forwards the providerConfig that fallbackProviderConfigFor resolves (provider === agentProvider path)', () => {
      // The resolver receives the agentProviderConfig object when the
      // provider matches the agent's own provider.
      mockedResolve.mockReturnValueOnce('svc-inherit');
      mockedLookup.mockReturnValueOnce('present');

      const cfg: Record<string, unknown> = { model: 'gpt-x', extra: 1 };
      const result = fallbackKeyPresent('openai', 'gpt-x', 'openai', cfg);

      // Terminal: 3rd arg to resolveProviderKeyService IS the agent config
      // (identity), and the public result reflects the present credential.
      expect(mockedResolve).toHaveBeenCalledWith('openai', 'gpt-x', cfg);
      expect(result).toBe(true);
    });

    it('resolves an OpenCode fallback credential against the stripped execution config', () => {
      mockedResolve.mockReturnValueOnce('minimax');
      mockedLookup.mockReturnValueOnce('present');

      const result = fallbackKeyPresent(
        'opencode-cli',
        'minimax/MiniMax-M2',
        'opencode-cli',
        {
          baseUrl: 'https://primary-openai.example/v1',
          apiKeyService: 'openai',
          executionProfile: 'whatsoup-headless',
        },
      );

      expect(mockedResolve).toHaveBeenCalledWith(
        'opencode-cli',
        'minimax/MiniMax-M2',
        { executionProfile: 'whatsoup-headless' },
      );
      expect(result).toBe(true);
    });

    it('forwards undefined as the providerConfig when the provider does not inherit', () => {
      // Provider is an unrelated string — fallbackProviderConfigFor returns
      // undefined, so the resolver must receive undefined as its 3rd arg.
      mockedResolve.mockReturnValueOnce('svc-groq');
      mockedLookup.mockReturnValueOnce('present');

      const cfg: Record<string, unknown> = { model: 'gpt-x' };
      const result = fallbackKeyPresent('groq', 'gpt-x', 'openai', cfg);

      // Terminal concrete assertion: 3rd arg === undefined, result === true.
      expect(mockedResolve).toHaveBeenCalledWith('groq', 'gpt-x', undefined);
      expect(result).toBe(true);
    });
  });
});
