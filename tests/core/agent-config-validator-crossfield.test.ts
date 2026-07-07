/**
 * Cross-field validator coverage for provider fallback and custom-endpoint
 * config:
 *  - an API-type fallbackProvider (openai-api / anthropic-api) must carry an
 *    explicit fallbackModel,
 *  - providerConfig.baseUrl must be an http(s) URL,
 *  - an opencode-cli custom endpoint (providerConfig.baseUrl) without a
 *    resolvable model (top-level `model` / `models.conversation`) is rejected
 *    because the generated opencode provider block would never be referenced.
 *
 * Complements agent-config-validator-fallback.test.ts (single-field shape
 * rules for fallbackProvider / fallbackModel). Accept-cases end on a rejecting
 * control so a vacuous always-null validator cannot pass them.
 */
import { describe, it, expect } from 'vitest';
import { validateInstanceConfig } from '../../src/core/agent-config-validator.ts';

function agentRaw(
  agentOptions: Record<string, unknown>,
  topLevel: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: 'test-line',
    type: 'agent',
    accessMode: 'self_only',
    adminPhones: ['15555550123'],
    healthPort: 9095,
    systemPrompt: 'hi',
    agentOptions: {
      sessionScope: 'single',
      ...agentOptions,
    },
    ...topLevel,
  };
}

const createCtx = { name: 'test-line', mode: 'create' } as const;

describe('validateInstanceConfig — top-level model must match models.conversation', () => {
  it('rejects an agent config when both model fields are set to different values', () => {
    const err = validateInstanceConfig(
      agentRaw(
        { provider: 'claude-cli' },
        { model: 'primary-model-a', models: { conversation: 'primary-model-b' } },
      ),
      createCtx,
    );
    expect(err).not.toBeNull();
    expect(err?.field).toBe('model');
    expect(err?.message).toContain('model');
    expect(err?.message).toContain('models.conversation');
  });

  it('accepts an agent config when both model fields match', () => {
    expect(
      validateInstanceConfig(
        agentRaw(
          { provider: 'claude-cli' },
          { model: 'primary-model-a', models: { conversation: 'primary-model-a' } },
        ),
        createCtx,
      ),
      'matching model fields must validate clean',
    ).toBeNull();
    // Control: changing only models.conversation makes the same config invalid.
    const bad = validateInstanceConfig(
      agentRaw(
        { provider: 'claude-cli' },
        { model: 'primary-model-a', models: { conversation: 'primary-model-b' } },
      ),
      createCtx,
    );
    expect(bad?.field).toBe('model');
  });

  it('accepts single-field legacy configs on either side', () => {
    expect(
      validateInstanceConfig(
        agentRaw({ provider: 'claude-cli' }, { model: 'primary-model-a' }),
        createCtx,
      ),
      'top-level model alone remains valid',
    ).toBeNull();
    expect(
      validateInstanceConfig(
        agentRaw({ provider: 'claude-cli' }, { models: { conversation: 'primary-model-a' } }),
        createCtx,
      ),
      'models.conversation alone remains valid',
    ).toBeNull();
    // Control: adding a disagreeing sibling is rejected.
    const bad = validateInstanceConfig(
      agentRaw(
        { provider: 'claude-cli' },
        { model: 'primary-model-a', models: { conversation: 'primary-model-b' } },
      ),
      createCtx,
    );
    expect(bad?.field).toBe('model');
  });

  it('fires on the load path too so persisted split-brain configs do not boot silently', () => {
    const err = validateInstanceConfig(
      agentRaw(
        { provider: 'claude-cli' },
        { model: 'primary-model-a', models: { conversation: 'primary-model-b' } },
      ),
      { name: 'test-line', mode: 'load' },
    );
    expect(err?.field).toBe('model');
  });
});

describe('validateInstanceConfig — API fallbackProvider requires fallbackModel', () => {
  for (const apiProvider of ['openai-api', 'anthropic-api'] as const) {
    it(`rejects fallbackProvider ${apiProvider} without fallbackModel, naming both fields`, () => {
      const err = validateInstanceConfig(
        agentRaw({ provider: 'claude-cli', fallbackProvider: apiProvider }),
        createCtx,
      );
      expect(err).not.toBeNull();
      expect(err?.field).toBe('agentOptions.fallbackModel');
      expect(err?.message).toContain('agentOptions.fallbackProvider');
      expect(err?.message).toContain('agentOptions.fallbackModel');
      expect(err?.message).toContain(apiProvider);
    });

    it(`accepts fallbackProvider ${apiProvider} once fallbackModel is set`, () => {
      expect(
        validateInstanceConfig(
          agentRaw({
            provider: 'claude-cli',
            fallbackProvider: apiProvider,
            fallbackModel: 'some-model-id',
          }),
          createCtx,
        ),
        `${apiProvider} with an explicit fallbackModel must validate clean`,
      ).toBeNull();
      // Control: dropping fallbackModel from the identical config is rejected,
      // so the accept above proves the pairing rule (not a vacuous pass).
      const bad = validateInstanceConfig(
        agentRaw({ provider: 'claude-cli', fallbackProvider: apiProvider }),
        createCtx,
      );
      expect(bad?.field).toBe('agentOptions.fallbackModel');
    });
  }

  it('fires on the load path too (discovery/load must reject what restart would mis-run)', () => {
    const err = validateInstanceConfig(
      agentRaw({ provider: 'claude-cli', fallbackProvider: 'openai-api' }),
      { name: 'test-line', mode: 'load' },
    );
    expect(err?.field).toBe('agentOptions.fallbackModel');
  });

  it('still accepts a CLI fallbackProvider without fallbackModel (CLI default model applies)', () => {
    expect(
      validateInstanceConfig(
        agentRaw({ provider: 'claude-cli', fallbackProvider: 'opencode-cli' }),
        createCtx,
      ),
      'opencode-cli without fallbackModel must stay valid (provider default model)',
    ).toBeNull();
    // Control: the same shape with an API fallback provider is rejected — the
    // rule is provider-type-scoped, not dropped.
    const bad = validateInstanceConfig(
      agentRaw({ provider: 'claude-cli', fallbackProvider: 'anthropic-api' }),
      createCtx,
    );
    expect(bad?.field).toBe('agentOptions.fallbackModel');
  });
});

describe('validateInstanceConfig — providerConfig.baseUrl scheme', () => {
  for (const bad of ['ftp://host/v1', 'file:///tmp/endpoint', 'ws://host/v1']) {
    it(`rejects non-http(s) baseUrl ${bad}`, () => {
      const err = validateInstanceConfig(
        agentRaw({ provider: 'openai-api', providerConfig: { baseUrl: bad } }),
        createCtx,
      );
      expect(err).not.toBeNull();
      expect(err?.field).toBe('agentOptions.providerConfig.baseUrl');
      expect(err?.message).toMatch(/http/);
    });
  }

  for (const ok of ['http://localhost:11434/v1', 'https://api.example.com/v1']) {
    it(`accepts http(s) baseUrl ${ok}`, () => {
      expect(
        validateInstanceConfig(
          agentRaw({ provider: 'openai-api', providerConfig: { baseUrl: ok } }),
          createCtx,
        ),
        `${ok} must validate clean`,
      ).toBeNull();
      // Control: swapping only the scheme to ftp on the same config is
      // rejected at the same field.
      const bad = validateInstanceConfig(
        agentRaw({
          provider: 'openai-api',
          providerConfig: { baseUrl: ok.replace(/^https?/, 'ftp') },
        }),
        createCtx,
      );
      expect(bad?.field).toBe('agentOptions.providerConfig.baseUrl');
    });
  }
});

describe('validateInstanceConfig — opencode-cli baseUrl requires a resolvable model', () => {
  const opencodeWithBaseUrl = {
    provider: 'opencode-cli',
    providerConfig: { baseUrl: 'https://api.example.com/v1' },
  };

  it('rejects opencode-cli + baseUrl with no model anywhere (the endpoint block would be inert)', () => {
    const err = validateInstanceConfig(agentRaw(opencodeWithBaseUrl), createCtx);
    expect(err).not.toBeNull();
    expect(err?.field).toBe('agentOptions.providerConfig.baseUrl');
    expect(err?.message).toMatch(/model/);
    expect(err?.message).toMatch(/never be used/);
  });

  it('accepts opencode-cli + baseUrl when a top-level model is set', () => {
    expect(
      validateInstanceConfig(
        agentRaw(opencodeWithBaseUrl, { model: 'whatsoup-cloud/some-model' }),
        createCtx,
      ),
      'top-level model must satisfy the custom-endpoint model requirement',
    ).toBeNull();
    // Control: the identical config minus the model is rejected.
    const bad = validateInstanceConfig(agentRaw(opencodeWithBaseUrl), createCtx);
    expect(bad?.field).toBe('agentOptions.providerConfig.baseUrl');
  });

  it('accepts opencode-cli + baseUrl when models.conversation is set', () => {
    expect(
      validateInstanceConfig(
        agentRaw(opencodeWithBaseUrl, { models: { conversation: 'whatsoup-cloud/some-model' } }),
        createCtx,
      ),
      'models.conversation must satisfy the custom-endpoint model requirement',
    ).toBeNull();
    // Control: an empty models object does NOT satisfy it.
    const bad = validateInstanceConfig(agentRaw(opencodeWithBaseUrl, { models: {} }), createCtx);
    expect(bad?.field).toBe('agentOptions.providerConfig.baseUrl');
  });

  it('does not apply the model requirement to API providers (baseUrl is a direct endpoint override)', () => {
    // openai-api / anthropic-api consume baseUrl in their constructors and
    // fall back to their own default model — the endpoint is always live, so
    // a missing instance model is not a misconfiguration for them.
    for (const apiProvider of ['openai-api', 'anthropic-api']) {
      expect(
        validateInstanceConfig(
          agentRaw({ provider: apiProvider, providerConfig: { baseUrl: 'https://api.example.com/v1' } }),
          createCtx,
        ),
        `${apiProvider} with baseUrl and no model must validate clean`,
      ).toBeNull();
    }
    // Control: only the provider differs from the rejected opencode-cli case.
    const bad = validateInstanceConfig(agentRaw(opencodeWithBaseUrl), createCtx);
    expect(bad?.field).toBe('agentOptions.providerConfig.baseUrl');
  });

  it('fires on the load path too', () => {
    const err = validateInstanceConfig(agentRaw(opencodeWithBaseUrl), {
      name: 'test-line',
      mode: 'load',
    });
    expect(err?.field).toBe('agentOptions.providerConfig.baseUrl');
  });
});

describe('validateInstanceConfig — providerConfig.apiKeyService', () => {
  const opencodeEndpoint = (apiKeyService: unknown, extra: Record<string, unknown> = {}) =>
    agentRaw(
      {
        provider: 'opencode-cli',
        providerConfig: { baseUrl: 'https://api.example.com/v1', apiKeyService, ...extra },
      },
      { model: 'MiniMax-M2' },
    );

  it('accepts a known keyring service alongside baseUrl (opencode-cli)', () => {
    expect(
      validateInstanceConfig(opencodeEndpoint('minimax'), createCtx),
      'a SERVICE_ENV_MAP service with baseUrl must validate clean',
    ).toBeNull();
    // Control: the identical config with an unknown service is rejected, so
    // the accept proves the membership rule rather than a vacuous pass.
    const bad = validateInstanceConfig(opencodeEndpoint('not-a-service'), createCtx);
    expect(bad?.field).toBe('agentOptions.providerConfig.apiKeyService');
  });

  it('accepts apiKeyService with baseUrl on API providers too', () => {
    expect(
      validateInstanceConfig(
        agentRaw({
          provider: 'openai-api',
          providerConfig: { baseUrl: 'https://api.deepseek.example/v1', apiKeyService: 'deepseek' },
        }),
        createCtx,
      ),
    ).toBeNull();
    // Control: dropping baseUrl from the identical config is rejected.
    const bad = validateInstanceConfig(
      agentRaw({ provider: 'openai-api', providerConfig: { apiKeyService: 'deepseek' } }),
      createCtx,
    );
    expect(bad?.field).toBe('agentOptions.providerConfig.apiKeyService');
  });

  it('rejects a non-string apiKeyService', () => {
    const err = validateInstanceConfig(opencodeEndpoint(42), createCtx);
    expect(err).not.toBeNull();
    expect(err?.field).toBe('agentOptions.providerConfig.apiKeyService');
    expect(err?.message).toMatch(/non-empty string/);
  });

  it('rejects an empty apiKeyService', () => {
    const err = validateInstanceConfig(opencodeEndpoint('   '), createCtx);
    expect(err?.field).toBe('agentOptions.providerConfig.apiKeyService');
    expect(err?.message).toMatch(/non-empty string/);
  });

  it('rejects an apiKeyService that is not a known keyring service, listing the valid ones', () => {
    const err = validateInstanceConfig(opencodeEndpoint('grokcloud'), createCtx);
    expect(err).not.toBeNull();
    expect(err?.field).toBe('agentOptions.providerConfig.apiKeyService');
    expect(err?.message).toContain('grokcloud');
    expect(err?.message).toContain('minimax');
    expect(err?.message).toContain('deepseek');
  });

  it('rejects the BYOK-blocked services nvidia and cerebras until they enter SERVICE_ENV_MAP', () => {
    // Deliberate coupling: the BYOK design note
    // (docs/specs/2026-07-03-openai-compatible-byok-providers-design.md)
    // documents nvidia/cerebras as blocked pending service-map entries and
    // probe qualification. If this flips because you mapped the service,
    // update that note's Blocked/future section and the
    // docs/configuration.md service lists in the same PR.
    for (const service of ['nvidia', 'cerebras']) {
      const err = validateInstanceConfig(opencodeEndpoint(service), createCtx);
      expect(err?.field, `${service} must stay rejected until mapped`).toBe(
        'agentOptions.providerConfig.apiKeyService',
      );
      expect(err?.message).toContain(service);
    }
  });

  it('rejects apiKeyService without baseUrl (the key service would be inert)', () => {
    const err = validateInstanceConfig(
      agentRaw({ provider: 'opencode-cli', providerConfig: { apiKeyService: 'minimax' } }),
      createCtx,
    );
    expect(err).not.toBeNull();
    expect(err?.field).toBe('agentOptions.providerConfig.apiKeyService');
    expect(err?.message).toMatch(/baseUrl/);
  });

  it('fires on the load path too', () => {
    const err = validateInstanceConfig(opencodeEndpoint('not-a-service'), {
      name: 'test-line',
      mode: 'load',
    });
    expect(err?.field).toBe('agentOptions.providerConfig.apiKeyService');
  });
});

// ---------------------------------------------------------------------------
// chatOptions.openaiProviderConfig (QR-218 PR-2 — chat OpenAI provider config)
//
// Same baseUrl/apiKeyService shape rules as agentOptions.providerConfig
// (validateProviderConfigShape is a shared pure helper), but AGENT-ONLY rules
// (budget, opencode-cli "baseUrl needs a routed model") must NOT carry over —
// chat has no opencode-cli concept and no budget field.
// ---------------------------------------------------------------------------

function chatRaw(
  chatOptions: Record<string, unknown>,
  topLevel: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: 'test-line',
    type: 'chat',
    accessMode: 'allowlist',
    adminPhones: ['15555550123'],
    healthPort: 9096,
    systemPrompt: 'hi',
    chatOptions,
    ...topLevel,
  };
}

function transcriptionRaw(
  transcriptionOptions: Record<string, unknown>,
  topLevel: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: 'test-line',
    type: 'agent',
    accessMode: 'self_only',
    adminPhones: ['15555550123'],
    healthPort: 9097,
    agentOptions: { sessionScope: 'single' },
    transcriptionOptions,
    ...topLevel,
  };
}

describe('validateInstanceConfig — chatOptions.openaiProviderConfig.baseUrl scheme', () => {
  for (const bad of ['ftp://host/v1', 'file:///tmp/endpoint', 'ws://host/v1']) {
    it(`rejects non-http(s) baseUrl ${bad}`, () => {
      const err = validateInstanceConfig(
        chatRaw({ openaiProviderConfig: { baseUrl: bad } }),
        createCtx,
      );
      expect(err).not.toBeNull();
      expect(err?.field).toBe('chatOptions.openaiProviderConfig.baseUrl');
      expect(err?.message).toMatch(/http/);
    });
  }

  for (const ok of ['http://localhost:11434/v1', 'https://api.example.com/v1']) {
    it(`accepts http(s) baseUrl ${ok}`, () => {
      expect(
        validateInstanceConfig(chatRaw({ openaiProviderConfig: { baseUrl: ok } }), createCtx),
        `${ok} must validate clean`,
      ).toBeNull();
      // Control: swapping only the scheme to ftp on the same config is
      // rejected at the same field.
      const bad = validateInstanceConfig(
        chatRaw({ openaiProviderConfig: { baseUrl: ok.replace(/^https?/, 'ftp') } }),
        createCtx,
      );
      expect(bad?.field).toBe('chatOptions.openaiProviderConfig.baseUrl');
    });
  }

  it('fires on the load path too', () => {
    const err = validateInstanceConfig(
      chatRaw({ openaiProviderConfig: { baseUrl: 'ftp://host/v1' } }),
      { name: 'test-line', mode: 'load' },
    );
    expect(err?.field).toBe('chatOptions.openaiProviderConfig.baseUrl');
  });
});

describe('validateInstanceConfig — chatOptions.openaiProviderConfig.apiKeyService', () => {
  const openaiEndpoint = (apiKeyService: unknown, extra: Record<string, unknown> = {}) =>
    chatRaw({
      openaiProviderConfig: { baseUrl: 'https://api.example.com/v1', apiKeyService, ...extra },
    });

  it('accepts a known keyring service alongside baseUrl', () => {
    expect(
      validateInstanceConfig(openaiEndpoint('openai'), createCtx),
      'a SERVICE_ENV_MAP service with baseUrl must validate clean',
    ).toBeNull();
    // Control: the identical config with an unknown service is rejected, so
    // the accept proves the membership rule rather than a vacuous pass.
    const bad = validateInstanceConfig(openaiEndpoint('not-a-service'), createCtx);
    expect(bad?.field).toBe('chatOptions.openaiProviderConfig.apiKeyService');
  });

  it('rejects a non-string apiKeyService', () => {
    const err = validateInstanceConfig(openaiEndpoint(42), createCtx);
    expect(err).not.toBeNull();
    expect(err?.field).toBe('chatOptions.openaiProviderConfig.apiKeyService');
    expect(err?.message).toMatch(/non-empty string/);
  });

  it('rejects an apiKeyService that is not a known keyring service, listing the valid ones', () => {
    const err = validateInstanceConfig(openaiEndpoint('grokcloud'), createCtx);
    expect(err).not.toBeNull();
    expect(err?.field).toBe('chatOptions.openaiProviderConfig.apiKeyService');
    expect(err?.message).toContain('grokcloud');
    expect(err?.message).toContain('minimax');
  });

  it('rejects apiKeyService without baseUrl (the key service would be inert)', () => {
    const err = validateInstanceConfig(
      chatRaw({ openaiProviderConfig: { apiKeyService: 'openai' } }),
      createCtx,
    );
    expect(err).not.toBeNull();
    expect(err?.field).toBe('chatOptions.openaiProviderConfig.apiKeyService');
    expect(err?.message).toMatch(/baseUrl/);
  });

  it('fires on the load path too', () => {
    const err = validateInstanceConfig(openaiEndpoint('not-a-service'), {
      name: 'test-line',
      mode: 'load',
    });
    expect(err?.field).toBe('chatOptions.openaiProviderConfig.apiKeyService');
  });
});

describe('validateInstanceConfig — chatOptions does not inherit agent-only providerConfig rules', () => {
  it('does not require a resolvable model for a baseUrl-only config (no opencode-cli concept in chat)', () => {
    // Unlike agentOptions.providerConfig + provider:'opencode-cli', chat has no
    // "custom endpoint needs a routed model" rule — every chat generate()
    // request carries its own model, so baseUrl alone is never inert.
    expect(
      validateInstanceConfig(
        chatRaw({ openaiProviderConfig: { baseUrl: 'https://api.example.com/v1' } }),
        createCtx,
      ),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Security: apiKeyService must not name a non-provider keyring secret
// (SERVICE_ENV_MAP also holds whatsoup-health-token/whatsoup_health, pinecone,
// elevenlabs). apiKeyService authenticates an operator-supplied custom LLM
// endpoint (baseUrl) — if one of those non-provider services were accepted, a
// BYOK config could name it and exfiltrate that secret to an arbitrary
// endpoint as a Bearer token. PROVIDER_API_KEY_SERVICES restricts the
// membership check to inference providers only, closing both surfaces
// (agentOptions.providerConfig and chatOptions.openaiProviderConfig share the
// same validateProviderConfigShape helper).
// ---------------------------------------------------------------------------

describe('validateInstanceConfig — apiKeyService rejects non-provider keyring secrets (security)', () => {
  const nonProviderServices = ['whatsoup-health-token', 'whatsoup_health', 'pinecone', 'elevenlabs'];

  for (const service of nonProviderServices) {
    it(`rejects apiKeyService ${service} on agentOptions.providerConfig even with a valid baseUrl`, () => {
      // Control: the identical config with an allowlisted provider service is
      // accepted, so the rejection below proves the allowlist rather than
      // baseUrl itself being the problem.
      expect(
        validateInstanceConfig(
          agentRaw({
            provider: 'openai-api',
            providerConfig: { baseUrl: 'https://api.example.com/v1', apiKeyService: 'openai' },
          }),
          createCtx,
        ),
        'an allowlisted provider service with the same baseUrl must validate clean',
      ).toBeNull();

      const err = validateInstanceConfig(
        agentRaw({
          provider: 'openai-api',
          providerConfig: { baseUrl: 'https://api.example.com/v1', apiKeyService: service },
        }),
        createCtx,
      );
      expect(err).not.toBeNull();
      expect(err?.field).toBe('agentOptions.providerConfig.apiKeyService');
      expect(err?.message).toContain(service);
    });

    it(`rejects apiKeyService ${service} on chatOptions.openaiProviderConfig even with a valid baseUrl`, () => {
      // Control: same config with an allowlisted provider service passes, so
      // the rejection below proves the allowlist rather than baseUrl itself.
      expect(
        validateInstanceConfig(
          chatRaw({
            openaiProviderConfig: { baseUrl: 'https://api.example.com/v1', apiKeyService: 'openai' },
          }),
          createCtx,
        ),
        'an allowlisted provider service with the same baseUrl must validate clean',
      ).toBeNull();

      const err = validateInstanceConfig(
        chatRaw({
          openaiProviderConfig: { baseUrl: 'https://api.example.com/v1', apiKeyService: service },
        }),
        createCtx,
      );
      expect(err).not.toBeNull();
      expect(err?.field).toBe('chatOptions.openaiProviderConfig.apiKeyService');
      expect(err?.message).toContain(service);
    });

    it(`rejects apiKeyService ${service} on transcriptionOptions.openaiProviderConfig even with a valid baseUrl`, () => {
      // Control: same transcription config with an allowlisted provider
      // service passes, so the rejection below proves the allowlist rather
      // than baseUrl itself.
      expect(
        validateInstanceConfig(
          transcriptionRaw({
            openaiProviderConfig: { baseUrl: 'https://api.example.com/v1', apiKeyService: 'openai' },
          }),
          createCtx,
        ),
        'an allowlisted provider service with the same baseUrl must validate clean',
      ).toBeNull();

      const err = validateInstanceConfig(
        transcriptionRaw({
          openaiProviderConfig: { baseUrl: 'https://api.example.com/v1', apiKeyService: service },
        }),
        createCtx,
      );
      expect(err).not.toBeNull();
      expect(err?.field).toBe('transcriptionOptions.openaiProviderConfig.apiKeyService');
      expect(err?.message).toContain(service);
    });
  }
});
