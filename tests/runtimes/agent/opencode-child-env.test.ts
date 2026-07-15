/**
 * buildChildEnv — opencode-cli forwards the standard fleet provider keys.
 *
 * The opencode-cli branch must forward DEEPSEEK_API_KEY / MINIMAX_API_KEY
 * (resolved from the standard keychain via lookupCredential) so a session
 * launched as `opencode run -m minimax/...` or `deepseek/...` can authenticate.
 * Other providers must NOT receive these keys (per-provider credential
 * isolation — the security rationale documented on buildChildEnv).
 *
 * Additionally, the branch must derive the key service for the session's
 * configured model from its prefix (via resolveProviderKeyService) so a
 * primary/fallback model outside the standard pair (e.g. openai/gpt-4o) gets
 * its key forwarded too — and warn when the prefix resolves to a service that
 * SERVICE_ENV_MAP does not know about.
 *
 * Custom endpoints add one more lane: `providerConfig.apiKeyService` names the
 * service whose key authenticates the endpoint (the opencode.json provider
 * block references it as `{env:<ENVVAR>}`), so buildChildEnv must inject that
 * service's key on top of the defaults.
 *
 * lookupCredential is mocked at the module boundary so the test is
 * deterministic regardless of what the host machine's real keychain holds
 * (the live fleet machine genuinely has deepseek/minimax entries, which would
 * otherwise contaminate the "absent" assertions).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const lookupCredentialMock = vi.fn<(service: string) => string | null>();

vi.mock('../../../src/lib/keyring.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/keyring.ts')>();
  return {
    ...actual,
    lookupCredential: (service: string) => lookupCredentialMock(service),
  };
});

// Capture warn calls from every child logger so the unmapped-service warning
// emitted by buildChildEnv (logger name: session-manager) can be asserted.
const warnMock = vi.fn();

vi.mock('../../../src/logger.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/logger.ts')>();
  return {
    ...actual,
    createChildLogger: () => ({
      info: vi.fn(),
      warn: (...args: unknown[]) => warnMock(...args),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn(),
    }),
  };
});

import { buildChildEnv } from '../../../src/runtimes/agent/session.ts';

function hasKey(env: Record<string, string | undefined>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(env, key);
}

describe('buildChildEnv — opencode-cli standard fleet keys', () => {
  beforeEach(() => {
    lookupCredentialMock.mockReset();
  });

  it('forwards DEEPSEEK_API_KEY and MINIMAX_API_KEY when the keyring resolves them', () => {
    lookupCredentialMock.mockImplementation((service: string) => {
      if (service === 'deepseek') return 'ds-secret-123';
      if (service === 'minimax') return 'mm-secret-456';
      return null;
    });

    const env = buildChildEnv('opencode-cli');
    expect(env.DEEPSEEK_API_KEY).toBe('ds-secret-123');
    expect(env.MINIMAX_API_KEY).toBe('mm-secret-456');
  });

  it('omits DEEPSEEK_API_KEY/MINIMAX_API_KEY when the keyring resolves nothing', () => {
    lookupCredentialMock.mockReturnValue(null);

    const env = buildChildEnv('opencode-cli');
    expect(hasKey(env, 'DEEPSEEK_API_KEY')).toBe(false);
    expect(hasKey(env, 'MINIMAX_API_KEY')).toBe(false);
  });

  it('does NOT forward deepseek/minimax keys to a non-opencode provider (codex-cli)', () => {
    lookupCredentialMock.mockImplementation((service: string) => {
      if (service === 'deepseek') return 'ds-secret-123';
      if (service === 'minimax') return 'mm-secret-456';
      return null;
    });

    const env = buildChildEnv('codex-cli');
    expect(hasKey(env, 'DEEPSEEK_API_KEY')).toBe(false);
    expect(hasKey(env, 'MINIMAX_API_KEY')).toBe(false);
    // codex-cli never consults the keyring for these services.
    expect(lookupCredentialMock).not.toHaveBeenCalledWith('deepseek');
  });
});

const ENV_KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'MINIMAX_API_KEY'] as const;

describe('buildChildEnv — opencode-cli model-derived key', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    lookupCredentialMock.mockReset();
    warnMock.mockReset();
    // Isolate from the host process env — the opencode-cli branch also
    // forwards OPENAI_API_KEY/ANTHROPIC_API_KEY straight from process.env.
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it('injects the key for the configured model prefix via SERVICE_ENV_MAP (openai/gpt-4o → OPENAI_API_KEY)', () => {
    lookupCredentialMock.mockImplementation((service: string) =>
      service === 'openai' ? 'oa-secret-789' : null,
    );

    const env = buildChildEnv('opencode-cli', undefined, 'openai/gpt-4o');
    expect(env.OPENAI_API_KEY).toBe('oa-secret-789');
    expect(lookupCredentialMock).toHaveBeenCalledWith('openai');
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('injects no key and warns once when the model prefix resolves to a service missing from SERVICE_ENV_MAP', () => {
    lookupCredentialMock.mockReturnValue(null);

    // 'unmapped-vendor' stands in for any provider absent from SERVICE_ENV_MAP
    // (xai, the previous fixture, is now a mapped fallback provider).
    const env = buildChildEnv('opencode-cli', undefined, 'unmapped-vendor/model-x');
    expect(hasKey(env, 'UNMAPPED_VENDOR_API_KEY')).toBe(false);
    // The keyring is never consulted for a service with no env-var mapping —
    // there is nowhere to put the result.
    expect(lookupCredentialMock).not.toHaveBeenCalledWith('unmapped-vendor');

    expect(warnMock).toHaveBeenCalledTimes(1);
    const call = JSON.stringify(warnMock.mock.calls[0]);
    expect(call).toContain('unmapped-vendor');
    expect(call).toContain('SERVICE_ENV_MAP');

    // The warning is emitted once per service, not once per spawn.
    buildChildEnv('opencode-cli', undefined, 'unmapped-vendor/model-x');
    expect(warnMock).toHaveBeenCalledTimes(1);
  });

  it('keeps deepseek/minimax forwarding unchanged and dedupes when the model prefix is one of them', () => {
    lookupCredentialMock.mockImplementation((service: string) => {
      if (service === 'deepseek') return 'ds-secret-123';
      if (service === 'minimax') return 'mm-secret-456';
      return null;
    });

    const env = buildChildEnv('opencode-cli', undefined, 'deepseek/deepseek-chat');
    expect(env.DEEPSEEK_API_KEY).toBe('ds-secret-123');
    expect(env.MINIMAX_API_KEY).toBe('mm-secret-456');
    // Deduped: the same service is not resolved twice.
    const deepseekCalls = lookupCredentialMock.mock.calls.filter(([svc]) => svc === 'deepseek');
    expect(deepseekCalls).toHaveLength(1);
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('forwards the fleet fallback trio (deepseek/minimax/glm) when no model is provided', () => {
    lookupCredentialMock.mockImplementation((service: string) => {
      if (service === 'deepseek') return 'ds-secret-123';
      if (service === 'minimax') return 'mm-secret-456';
      if (service === 'glm') return 'zai-secret-789';
      return null;
    });

    const env = buildChildEnv('opencode-cli');
    expect(env.DEEPSEEK_API_KEY).toBe('ds-secret-123');
    expect(env.MINIMAX_API_KEY).toBe('mm-secret-456');
    expect(env.ZAI_API_KEY).toBe('zai-secret-789');
    // W-4: opencode-cli now resolves openai + anthropic via resolveApiKey →
    // lookupCredential (keyring-first) alongside the fleet fallback trio, so the
    // call-list includes them even when unset. Env output above is unchanged —
    // openai/anthropic resolve to null here and are not forwarded.
    expect(lookupCredentialMock.mock.calls.map(([svc]) => svc).sort()).toEqual([
      'anthropic',
      'deepseek',
      'glm',
      'minimax',
      'openai',
    ]);
    expect(warnMock).not.toHaveBeenCalled();
  });
});

describe('buildChildEnv — opencode-cli providerConfig.apiKeyService key injection', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    lookupCredentialMock.mockReset();
    warnMock.mockReset();
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it('injects the key for an explicit apiKeyService (custom endpoint auth lane)', () => {
    lookupCredentialMock.mockImplementation((service: string) =>
      service === 'openai' ? 'oa-endpoint-key' : null,
    );

    const env = buildChildEnv('opencode-cli', undefined, 'Bare-Model-Id', {
      apiKeyService: 'openai',
    });
    expect(env.OPENAI_API_KEY).toBe('oa-endpoint-key');
    expect(lookupCredentialMock).toHaveBeenCalledWith('openai');
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('injects the apiKeyService key on top of the model-prefix key (additive, not replacing)', () => {
    lookupCredentialMock.mockImplementation((service: string) => {
      if (service === 'openai') return 'oa-endpoint-key';
      if (service === 'anthropic') return 'an-model-key';
      return null;
    });

    const env = buildChildEnv('opencode-cli', undefined, 'anthropic/claude-x', {
      apiKeyService: 'openai',
    });
    expect(env.OPENAI_API_KEY).toBe('oa-endpoint-key');
    expect(env.ANTHROPIC_API_KEY).toBe('an-model-key');
  });

  it('warns once and injects nothing for an apiKeyService missing from SERVICE_ENV_MAP', () => {
    lookupCredentialMock.mockReturnValue(null);

    buildChildEnv('opencode-cli', undefined, undefined, { apiKeyService: 'unmapped-endpoint-svc' });
    expect(lookupCredentialMock).not.toHaveBeenCalledWith('unmapped-endpoint-svc');

    expect(warnMock).toHaveBeenCalledTimes(1);
    const call = JSON.stringify(warnMock.mock.calls[0]);
    expect(call).toContain('unmapped-endpoint-svc');
    expect(call).toContain('SERVICE_ENV_MAP');

    // Warned once per service, not once per spawn.
    buildChildEnv('opencode-cli', undefined, undefined, { apiKeyService: 'unmapped-endpoint-svc' });
    expect(warnMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT inject the apiKeyService key for a non-opencode provider (credential isolation pin)', () => {
    lookupCredentialMock.mockImplementation((service: string) =>
      service === 'minimax' ? 'mm-secret-456' : null,
    );

    const env = buildChildEnv('claude-cli', undefined, undefined, { apiKeyService: 'minimax' });
    expect(hasKey(env, 'MINIMAX_API_KEY')).toBe(false);
    expect(lookupCredentialMock).not.toHaveBeenCalledWith('minimax');
  });
});
