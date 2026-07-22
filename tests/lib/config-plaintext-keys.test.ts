import { describe, it, expect } from 'vitest';
import {
  findPlaintextInstanceSecretField,
  PLAINTEXT_PROVIDER_KEY_FIELDS,
  stripPlaintextProviderKeys,
} from '../../src/lib/config-plaintext-keys.ts';

describe('findPlaintextInstanceSecretField', () => {
  it('finds credential-shaped fields across top-level, transport, and opaque nested config', () => {
    expect(findPlaintextInstanceSecretField({ openaiKeyBackup: 'sentinel' })).toBe('openaiKeyBackup');
    expect(findPlaintextInstanceSecretField({ twilioConfig: { authToken: 'sentinel' } })).toBe('twilioConfig.authToken');
    expect(findPlaintextInstanceSecretField({ memory: { apiKey: 'sentinel' } })).toBe('memory.apiKey');
  });

  it('preserves only the supported selector and token-budget paths', () => {
    expect(findPlaintextInstanceSecretField({
      tokenBudget: 5000,
      agentOptions: {
        autoCompactInputTokens: 150_000,
        providerConfig: { apiKeyService: 'groq' },
      },
      memory: { pinecone: { apiKeyEnv: 'PINECONE_API_KEY' } },
      twilioConfig: { authTokenService: 'whatsoup-twilio-line-a' },
      imessageConfig: { bluebubblesPasswordService: 'whatsoup-bluebubbles-line-a' },
    })).toBeNull();
  });

  it('rejects unsafe Pinecone environment selectors and credential-bearing embed URLs', () => {
    expect(findPlaintextInstanceSecretField({
      memory: { pinecone: { apiKeyEnv: 'opaque-api-key-value-secret-sentinel' } },
    })).toBe('memory.pinecone.apiKeyEnv');
    expect(findPlaintextInstanceSecretField({
      memory: {
        pinecone: {
          embedUrl: 'https://embed-user:embed-password@embed.example.test/v1',
        },
      },
    })).toBe('memory.pinecone.embedUrl');
    expect(findPlaintextInstanceSecretField({
      memory: {
        pinecone: {
          knowledgeProfiles: {
            docs: { embedUrl: 'https://embed.example.test/v1?token=profile-secret-sentinel' },
          },
        },
      },
    })).toBe('memory.pinecone.knowledgeProfiles.docs.embedUrl');
  });

  it('rejects Pinecone environment selectors outside their exact supported paths', () => {
    const hostile = {
      memory: {
        retention: {
          days: {
            pineconeApiKeyEnv: 'literal-nested-secret-sentinel',
          },
        },
      },
    };

    expect(findPlaintextInstanceSecretField(hostile)).toBe(
      'memory.retention.days.pineconeApiKeyEnv',
    );
    expect(stripPlaintextProviderKeys(hostile)).toEqual({
      clean: { memory: { retention: { days: {} } } },
      removed: ['memory.retention.days.pineconeApiKeyEnv'],
    });
  });

  it('does not let dotted JSON keys impersonate canonical secret exemptions', () => {
    const hostile = {
      'memory.pinecone.knowledgeProfiles': {
        apiKey: 'dotted-map-secret-sentinel',
      },
      'memory.pinecone': {
        apiKeyEnv: 'DOTTED_SELECTOR_SENTINEL',
      },
    };

    expect(findPlaintextInstanceSecretField(hostile)).toBe(
      'memory.pinecone.knowledgeProfiles.apiKey',
    );
    const { clean, removed } = stripPlaintextProviderKeys(hostile);
    expect(clean).toEqual({
      'memory.pinecone.knowledgeProfiles': {},
      'memory.pinecone': {},
    });
    expect(removed).toEqual(expect.arrayContaining([
      'memory.pinecone.knowledgeProfiles.apiKey',
      'memory.pinecone.apiKeyEnv',
    ]));
    expect(JSON.stringify(clean)).not.toContain('dotted-map-secret-sentinel');
    expect(JSON.stringify(clean)).not.toContain('DOTTED_SELECTOR_SENTINEL');
  });

  it('preserves own __proto__ keys in supported dynamic maps without prototype mutation', () => {
    const input = JSON.parse(`{
      "memory": {
        "pinecone": {
          "namespaces": { "__proto__": "proto-namespace" },
          "knowledgeProfiles": {
            "__proto__": { "namespace": "proto-profile", "description": "safe profile" }
          }
        }
      },
      "agentOptions": {
        "providerConfig": {
          "agents": { "__proto__": { "description": "safe agent" } }
        }
      },
      "chatAliases": { "__proto__": "safe-alias" }
    }`);

    const { clean, removed } = stripPlaintextProviderKeys(input);
    const memory = clean.memory as any;
    const agents = (clean.agentOptions as any).providerConfig.agents;
    const aliases = clean.chatAliases as Record<string, unknown>;

    expect(Object.hasOwn(memory.pinecone.namespaces, '__proto__')).toBe(true);
    expect(memory.pinecone.namespaces['__proto__']).toBe('proto-namespace');
    expect(Object.hasOwn(memory.pinecone.knowledgeProfiles, '__proto__')).toBe(true);
    expect(memory.pinecone.knowledgeProfiles['__proto__']).toEqual({
      namespace: 'proto-profile',
      description: 'safe profile',
    });
    expect(Object.hasOwn(agents, '__proto__')).toBe(true);
    expect(agents['__proto__']).toEqual({ description: 'safe agent' });
    expect(Object.hasOwn(aliases, '__proto__')).toBe(true);
    expect(aliases['__proto__']).toBe('safe-alias');
    expect(Object.getPrototypeOf(aliases)).toBe(Object.prototype);
    expect(removed).toEqual([]);
  });
});

describe('stripPlaintextProviderKeys', () => {
  it('locks the exact field list', () => {
    expect([...PLAINTEXT_PROVIDER_KEY_FIELDS].sort()).toEqual(['apiKey', 'openaiKey']);
  });

  it('removes top-level plaintext key fields and reports them', () => {
    const { clean, removed } = stripPlaintextProviderKeys({
      name: 'x', apiKey: 'sk-ant-secret', openaiKey: 'sk-secret', description: 'keep me',
    });
    expect(removed.sort()).toEqual(['apiKey', 'openaiKey']);
    expect(clean).toEqual({ name: 'x', description: 'keep me' });
  });

  it('removes top-level provider-key aliases and backups', () => {
    const { clean, removed } = stripPlaintextProviderKeys({
      name: 'x',
      api_key: 'snake-secret',
      apiKeyBackup: 'backup-secret',
      backupApiKey: 'prefix-backup-secret',
      legacyApiKey: 'legacy-secret',
      providerApiKey: 'provider-secret',
      openai_key: 'openai-snake-secret',
      openaiKeyBackup: 'openai-backup-secret',
      backupOpenaiKey: 'openai-prefix-backup-secret',
      legacyOpenaiKey: 'openai-legacy-secret',
      backupAuthToken: 'twilio-token-secret',
      twilioAuthTokenBackup: 'twilio-token-backup-secret',
      legacyBluebubblesPassword: 'bluebubbles-password-secret',
      providerSecret: 'generic-provider-secret',
      providerSecretBackup: 'generic-provider-secret-backup',
      providerCredential: 'generic-provider-credential',
      providerCredentialCopy: 'generic-provider-credential-copy',
      healthToken: 'runtime-token-secret',
      pineconeApiKeyEnv: 'PINECONE_API_KEY',
      maxTokens: 750,
      tokenBudget: 5000,
    });

    expect(clean).toEqual({
      name: 'x',
      pineconeApiKeyEnv: 'PINECONE_API_KEY',
      maxTokens: 750,
      tokenBudget: 5000,
    });
    expect(removed.sort()).toEqual([
      'apiKeyBackup',
      'api_key',
      'backupApiKey',
      'backupAuthToken',
      'backupOpenaiKey',
      'healthToken',
      'legacyApiKey',
      'legacyBluebubblesPassword',
      'legacyOpenaiKey',
      'openaiKeyBackup',
      'openai_key',
      'providerApiKey',
      'providerCredential',
      'providerCredentialCopy',
      'providerSecret',
      'providerSecretBackup',
      'twilioAuthTokenBackup',
    ]);
  });

  it('is a no-op on clean configs and does not mutate its input', () => {
    const input = { name: 'x', agentOptions: { provider: 'openai-api' } };
    const { clean, removed } = stripPlaintextProviderKeys(input);
    expect(removed).toEqual([]);
    expect(clean).toEqual(input);
    expect(input).toEqual({ name: 'x', agentOptions: { provider: 'openai-api' } });
  });

  it('strips raw keys from provider config blocks and opaque nested data', () => {
    const { clean, removed } = stripPlaintextProviderKeys({
      memory: { apiKey: 'nested-not-ours' },
      agentOptions: {
        provider: 'openai-api',
        providerConfig: {
          baseUrl: 'https://agent.example.test/v1',
          apiKeyService: 'openai',
          apiKey: 'agent-provider-secret',
        },
      },
      chatOptions: {
        openaiProviderConfig: {
          baseUrl: 'https://chat.example.test/v1',
          apiKeyService: 'openai',
          openaiKey: 'chat-provider-secret',
        },
      },
      transcriptionOptions: {
        openaiProviderConfig: {
          baseUrl: 'https://audio.example.test/v1',
          apiKeyService: 'openai',
          backupApiKey: 'audio-provider-secret',
        },
      },
    });
    expect(removed.sort()).toEqual([
      'agentOptions.providerConfig.apiKey',
      'chatOptions.openaiProviderConfig.openaiKey',
      'memory.apiKey',
      'transcriptionOptions.openaiProviderConfig.backupApiKey',
    ]);
    expect(clean).toEqual({
      memory: {},
      agentOptions: {
        provider: 'openai-api',
        providerConfig: {
          baseUrl: 'https://agent.example.test/v1',
          apiKeyService: 'openai',
        },
      },
      chatOptions: {
        openaiProviderConfig: {
          baseUrl: 'https://chat.example.test/v1',
          apiKeyService: 'openai',
        },
      },
      transcriptionOptions: {
        openaiProviderConfig: {
          baseUrl: 'https://audio.example.test/v1',
          apiKeyService: 'openai',
        },
      },
    });
  });

  it('recursively strips credential-shaped fields from opaque objects and arrays', () => {
    const { clean, removed } = stripPlaintextProviderKeys({
      memory: {
        pinecone: { apiKeyEnv: 'PINECONE_API_KEY' },
      },
      agentOptions: {
        providerConfig: {
          agents: {
            reviewer: {
              providers: [
                { label: 'safe', password: 'array-password-sentinel' },
                [{ name: 'nested-array', Authorization: 'array-authorization-sentinel' }],
              ],
            },
          },
        },
      },
      chatOptions: {
        openaiProviderConfig: {
          baseUrl: 'https://chat.example.test/v1',
          apiKeyService: 'openai',
        },
      },
    });

    expect(clean).toEqual({
      memory: {
        pinecone: { apiKeyEnv: 'PINECONE_API_KEY' },
      },
      agentOptions: {
        providerConfig: {
          agents: {
            reviewer: {
              providers: [
                { label: 'safe' },
                [{ name: 'nested-array' }],
              ],
            },
          },
        },
      },
      chatOptions: {
        openaiProviderConfig: {
          baseUrl: 'https://chat.example.test/v1',
          apiKeyService: 'openai',
        },
      },
    });
    expect(removed).toEqual(expect.arrayContaining([
      'agentOptions.providerConfig.agents.reviewer.providers.0.password',
      'agentOptions.providerConfig.agents.reviewer.providers.1.0.Authorization',
    ]));
    expect(JSON.stringify(clean)).not.toContain('sentinel');
  });

  it('drops unsupported opaque memory fields instead of exposing arbitrary scalar values', () => {
    const { clean, removed } = stripPlaintextProviderKeys({
      memory: {
        provider: { value: 'opaque-provider-value-secret-sentinel' },
        providers: [[['opaque-scalar-array-secret-sentinel']]],
        retention: { days: 30 },
      },
    });

    expect(clean).toEqual({ memory: { retention: { days: 30 } } });
    expect(removed).toEqual(expect.arrayContaining(['memory.provider', 'memory.providers']));
    expect(JSON.stringify(clean)).not.toContain('sentinel');
  });

  it('treats provider agent names as map keys while still sanitizing their definitions', () => {
    const input = {
      agentOptions: {
        providerConfig: {
          agents: {
            secretary: { description: 'safe' },
          },
        },
      },
    };

    expect(findPlaintextInstanceSecretField(input)).toBeNull();
    expect(stripPlaintextProviderKeys(input)).toEqual({ clean: input, removed: [] });
  });

  it('preserves legacy Pinecone map keys while sanitizing unsafe selectors and endpoints', () => {
    const input = {
      pineconeNamespaces: {
        secretary: 'secretary-namespace',
      },
      pineconeKnowledgeProfiles: {
        secretary: {
          namespace: 'secretary-namespace',
          description: 'safe profile',
        },
      },
    };

    expect(findPlaintextInstanceSecretField(input)).toBeNull();
    expect(stripPlaintextProviderKeys(input)).toEqual({ clean: input, removed: [] });

    const hostile = stripPlaintextProviderKeys({
      pineconeApiKeyEnv: 'opaque-api-key-value-secret-sentinel',
      pineconeEmbedUrl: 'https://embed.example.test/v1?api_key=query-secret-sentinel',
      pineconeKnowledgeProfiles: {
        secretary: {
          embedUrl: 'https://profile.example.test/v1#fragment-secret-sentinel',
        },
      },
    });
    expect(hostile.clean).toEqual({
      pineconeKnowledgeProfiles: { secretary: {} },
    });
    expect(hostile.removed).toEqual(expect.arrayContaining([
      'pineconeApiKeyEnv',
      'pineconeEmbedUrl',
      'pineconeKnowledgeProfiles.secretary.embedUrl',
    ]));
    expect(JSON.stringify(hostile.clean)).not.toContain('secret-sentinel');
  });

  it('drops unknown provider fields and credential-bearing provider URLs from every persisted path', () => {
    const { clean, removed } = stripPlaintextProviderKeys({
      agentOptions: {
        providerConfig: {
          model: 'gpt-test',
          baseUrl: 'https://agent-user:agent-password@agent.example.test/v1',
          apiKeyService: 'openai',
          headers: { Authorization: 'agent-header-sentinel' },
        },
      },
      chatOptions: {
        openaiProviderConfig: {
          baseUrl: 'https://chat.example.test/v1?api_key=chat-query-sentinel',
          apiKeyService: 'openai',
          cookies: { session: 'chat-cookie-sentinel' },
        },
      },
      transcriptionOptions: {
        openaiProviderConfig: {
          baseUrl: 'https://audio.example.test/v1#audio-fragment-sentinel',
          apiKeyService: 'openai',
          headers: { Authorization: 'audio-header-sentinel' },
        },
      },
    });

    expect(clean).toEqual({
      agentOptions: { providerConfig: { model: 'gpt-test' } },
      chatOptions: { openaiProviderConfig: {} },
      transcriptionOptions: { openaiProviderConfig: {} },
    });
    expect(removed).toEqual(expect.arrayContaining([
      'agentOptions.providerConfig.baseUrl',
      'agentOptions.providerConfig.apiKeyService',
      'agentOptions.providerConfig.headers',
      'chatOptions.openaiProviderConfig.baseUrl',
      'chatOptions.openaiProviderConfig.apiKeyService',
      'chatOptions.openaiProviderConfig.cookies',
      'transcriptionOptions.openaiProviderConfig.baseUrl',
      'transcriptionOptions.openaiProviderConfig.apiKeyService',
      'transcriptionOptions.openaiProviderConfig.headers',
    ]));
  });

  it('drops malformed provider blocks, unknown selectors, and nested opaque-agent credentials', () => {
    const { clean, removed } = stripPlaintextProviderKeys({
      agentOptions: {
        providerConfig: {
          agents: {
            reviewer: {
              description: 'safe description',
              Authorization: 'opaque-agent-secret-sentinel',
            },
          },
          baseUrl: 'https://agent.example.test/v1',
          apiKeyService: 'unknown-provider-service',
        },
      },
      chatOptions: { openaiProviderConfig: 'scalar-provider-secret-sentinel' },
      transcriptionOptions: { openaiProviderConfig: ['array-provider-secret-sentinel'] },
    });

    expect(clean).toEqual({
      agentOptions: {
        providerConfig: {
          agents: { reviewer: { description: 'safe description' } },
          baseUrl: 'https://agent.example.test/v1',
        },
      },
      chatOptions: {},
      transcriptionOptions: {},
    });
    expect(removed).toEqual(expect.arrayContaining([
      'agentOptions.providerConfig.agents.reviewer.Authorization',
      'agentOptions.providerConfig.apiKeyService',
      'chatOptions.openaiProviderConfig',
      'transcriptionOptions.openaiProviderConfig',
    ]));
    expect(JSON.stringify(clean)).not.toContain('secret-sentinel');
  });

  it('strips raw transport secrets without mutating safe nested config', () => {
    const input = {
      name: 'test-line',
      twilioConfig: {
        account: 'test-line',
        accountSid: 'AC00000000000000000000000000000000',
        authTokenService: 'whatsoup-twilio-test-line',
        authToken: 'must-not-reach-disk',
      },
      imessageConfig: {
        account: 'test-line',
        backend: 'bluebubbles',
        bluebubblesPasswordService: 'whatsoup-bluebubbles-test-line',
        bluebubblesPassword: 'must-not-reach-disk',
      },
    };

    const { clean, removed } = stripPlaintextProviderKeys(input);

    expect(removed.sort()).toEqual([
      'imessageConfig.bluebubblesPassword',
      'twilioConfig.authToken',
    ]);
    expect(clean).toEqual({
      name: 'test-line',
      twilioConfig: {
        account: 'test-line',
        accountSid: 'AC00000000000000000000000000000000',
        authTokenService: 'whatsoup-twilio-test-line',
      },
      imessageConfig: {
        account: 'test-line',
        backend: 'bluebubbles',
        bluebubblesPasswordService: 'whatsoup-bluebubbles-test-line',
      },
    });
    expect(input.twilioConfig.authToken).toBe('must-not-reach-disk');
    expect(input.imessageConfig.bluebubblesPassword).toBe('must-not-reach-disk');
  });

  it('drops non-scalar transport fields and credential-bearing provider URLs', () => {
    const { clean, removed } = stripPlaintextProviderKeys({
      twilioConfig: {
        account: { password: 'nested-account-secret' },
        accountSid: 'AC123',
        webhook: {
          publicBaseUrl: 'https://user:pass@example.test/twilio',
          listenPort: 3000,
        },
      },
      imessageConfig: {
        account: 'messages',
        bluebubblesUrl: 'https://user:pass@example.test',
        sender: 'owner@example.com',
      },
      signalConfig: 'raw-transport-config-secret',
    });

    expect(clean).toEqual({
      twilioConfig: {
        accountSid: 'AC123',
        webhook: { listenPort: 3000 },
      },
      imessageConfig: {
        account: 'messages',
        sender: 'owner@example.com',
      },
    });
    expect(removed).toEqual(expect.arrayContaining([
      'twilioConfig.account',
      'twilioConfig.webhook.publicBaseUrl',
      'imessageConfig.bluebubblesUrl',
      'signalConfig',
    ]));
  });

  it('preserves only the Twilio selector bound to the trusted top-level line name', () => {
    const canonical = stripPlaintextProviderKeys({
      name: 'line-a',
      twilioConfig: {
        account: 'line-a',
        authTokenService: 'whatsoup-twilio-line-a',
      },
    });
    expect(canonical.clean.twilioConfig).toMatchObject({
      account: 'line-a',
      authTokenService: 'whatsoup-twilio-line-a',
    });

    const hostile = stripPlaintextProviderKeys({
      name: 'line-a',
      twilioConfig: {
        account: 'line-a',
        authTokenService: 'whatsoup-twilio-line-b',
      },
    });
    expect(hostile.clean.twilioConfig).not.toHaveProperty('authTokenService');
    expect(hostile.removed).toContain('twilioConfig.authTokenService');
  });

  it.each([null, 7, true, { service: 'whatsoup-twilio-line-a' }])(
    'removes a non-string Twilio selector value %#',
    (authTokenService) => {
      const result = stripPlaintextProviderKeys({
        name: 'line-a',
        twilioConfig: { account: 'line-a', authTokenService },
      }, 'line-a');
      expect(result.clean.twilioConfig).not.toHaveProperty('authTokenService');
      expect(result.removed).toContain('twilioConfig.authTokenService');
    },
  );

  it.each([
    ['twilioConfig.webhook.publicBaseUrl', {
      twilioConfig: { webhook: { publicBaseUrl: 'https://relay.example.test/twilio?token=url-query-marker' } },
    }],
    ['twilioConfig.webhook.publicBaseUrl', {
      twilioConfig: { webhook: { publicBaseUrl: 'https://relay.example.test/twilio#url-fragment-marker' } },
    }],
    ['imessageConfig.bluebubblesUrl', {
      imessageConfig: { bluebubblesUrl: 'https://messages.example.test/api?password=url-query-marker' },
    }],
    ['imessageConfig.bluebubblesUrl', {
      imessageConfig: { bluebubblesUrl: 'https://messages.example.test/api#url-fragment-marker' },
    }],
  ])('drops query- or fragment-bearing provider URL %s', (removedField, input) => {
    const { clean, removed } = stripPlaintextProviderKeys(input);

    expect(removed).toContain(removedField);
    expect(JSON.stringify(clean)).not.toContain('url-query-marker');
    expect(JSON.stringify(clean)).not.toContain('url-fragment-marker');
  });

  it('preserves path-only transport URLs while dropping field-incompatible protocols', () => {
    const { clean, removed } = stripPlaintextProviderKeys({
      twilioConfig: {
        webhook: {
          publicBaseUrl: 'https://relay.example.test/twilio/callback',
          listenAddress: '127.0.0.1',
        },
      },
      imessageConfig: {
        bluebubblesUrl: 'http://127.0.0.1:1234/api/v1',
        sender: 'owner@example.com',
      },
    });

    expect(removed).toEqual([]);
    expect(clean).toMatchObject({
      twilioConfig: { webhook: { publicBaseUrl: 'https://relay.example.test/twilio/callback' } },
      imessageConfig: { bluebubblesUrl: 'http://127.0.0.1:1234/api/v1' },
    });

    const unsafe = stripPlaintextProviderKeys({
      twilioConfig: { webhook: { publicBaseUrl: 'http://relay.example.test/twilio' } },
      imessageConfig: { bluebubblesUrl: 'data:text/plain,url-content-marker' },
    });
    expect(unsafe.removed).toEqual(expect.arrayContaining([
      'twilioConfig.webhook.publicBaseUrl',
      'imessageConfig.bluebubblesUrl',
    ]));
    expect(JSON.stringify(unsafe.clean)).not.toContain('url-content-marker');
  });

  it('strips transport-secret aliases and backups while preserving keyring service references', () => {
    const { clean, removed } = stripPlaintextProviderKeys({
      name: 'service',
      twilioConfig: {
        account: 'service',
        authTokenService: 'whatsoup-twilio-service',
        auth_token: 'snake-secret',
        token: 'short-secret',
        authTokenBackup: 'backup-secret',
        backupAuthToken: 'prefix-backup-secret',
        secret: 'generic-secret',
        twilioToken: 'provider-prefixed-secret',
      },
      imessageConfig: {
        account: 'service',
        bluebubblesPasswordService: 'whatsoup-bluebubbles-service',
        bluebubbles_password: 'snake-secret',
        password: 'short-secret',
        passwordBackup: 'backup-secret',
        backupBluebubblesPassword: 'prefix-backup-secret',
        bluebubblesSecret: 'provider-prefixed-secret',
      },
      signalConfig: {
        account: 'signal-line',
        phoneNumber: '+15551230008',
        socketPath: '/tmp/signal.sock',
        credential: 'generic-secret',
        rateLimit: {
          messagesPerMinute: 30,
          token: 'nested-secret',
        },
      },
    });

    expect(clean).toEqual({
      name: 'service',
      twilioConfig: { account: 'service', authTokenService: 'whatsoup-twilio-service' },
      imessageConfig: { account: 'service', bluebubblesPasswordService: 'whatsoup-bluebubbles-service' },
      signalConfig: {
        account: 'signal-line',
        phoneNumber: '+15551230008',
        socketPath: '/tmp/signal.sock',
        rateLimit: { messagesPerMinute: 30 },
      },
    });
    expect(removed.sort()).toEqual([
      'imessageConfig.backupBluebubblesPassword',
      'imessageConfig.bluebubblesSecret',
      'imessageConfig.bluebubbles_password',
      'imessageConfig.password',
      'imessageConfig.passwordBackup',
      'signalConfig.credential',
      'signalConfig.rateLimit.token',
      'twilioConfig.authTokenBackup',
      'twilioConfig.auth_token',
      'twilioConfig.backupAuthToken',
      'twilioConfig.secret',
      'twilioConfig.token',
      'twilioConfig.twilioToken',
    ]);
  });

  it('strips untrusted BlueBubbles credential selectors and cleartext remote endpoints', () => {
    const { clean, removed } = stripPlaintextProviderKeys({
      imessageConfig: {
        backend: 'bluebubbles',
        bluebubblesUrl: 'http://collector.example.test',
        bluebubblesPasswordService: 'whatsoup-health-token',
      },
    });

    expect(clean).toEqual({ imessageConfig: { backend: 'bluebubbles' } });
    expect(removed).toEqual(expect.arrayContaining([
      'imessageConfig.bluebubblesUrl',
      'imessageConfig.bluebubblesPasswordService',
    ]));
  });

  it('strips a BlueBubbles credential selector bound to a different account', () => {
    const { clean, removed } = stripPlaintextProviderKeys({
      imessageConfig: {
        account: 'line-a',
        backend: 'bluebubbles',
        bluebubblesUrl: 'https://collector.example.test',
        bluebubblesPasswordService: 'whatsoup-bluebubbles-line-b',
      },
    });

    expect(clean).toEqual({
      imessageConfig: {
        account: 'line-a',
        backend: 'bluebubbles',
        bluebubblesUrl: 'https://collector.example.test',
      },
    });
    expect(removed).toContain('imessageConfig.bluebubblesPasswordService');
  });

  it('binds a BlueBubbles selector to the top-level line name, not a caller-controlled nested account', () => {
    const { clean, removed } = stripPlaintextProviderKeys({
      name: 'line-a',
      imessageConfig: {
        account: 'line-b',
        backend: 'bluebubbles',
        bluebubblesUrl: 'https://collector.example.test',
        bluebubblesPasswordService: 'whatsoup-bluebubbles-line-b',
      },
    });

    expect((clean.imessageConfig as Record<string, unknown>).bluebubblesPasswordService).toBeUndefined();
    expect(removed).toContain('imessageConfig.bluebubblesPasswordService');
  });

  it.each([
    {
      backend: 'imsg',
      config: {
        account: 'line-a',
        backend: 'imsg',
        imsgSocketPath: '/tmp/imsg.sock',
        bluebubblesUrl: 'https://collector.example.test',
        bluebubblesPasswordService: 'whatsoup-bluebubbles-line-a',
      },
      kept: 'imsgSocketPath',
      removedFields: [
        'imessageConfig.bluebubblesUrl',
        'imessageConfig.bluebubblesPasswordService',
      ],
    },
    {
      backend: 'bluebubbles',
      config: {
        account: 'line-a',
        backend: 'bluebubbles',
        imsgSocketPath: '/tmp/imsg.sock',
        bluebubblesUrl: 'https://collector.example.test',
        bluebubblesPasswordService: 'whatsoup-bluebubbles-line-a',
      },
      kept: 'bluebubblesUrl',
      removedFields: ['imessageConfig.imsgSocketPath'],
    },
  ])('strips fields that do not belong to the selected iMessage backend: $backend', ({
    config,
    kept,
    removedFields,
  }) => {
    const { clean, removed } = stripPlaintextProviderKeys({
      name: 'line-a',
      imessageConfig: config,
    });
    const sanitized = clean.imessageConfig as Record<string, unknown>;

    expect(sanitized).toHaveProperty(kept);
    for (const field of removedFields) {
      expect(removed).toContain(field);
      expect(sanitized).not.toHaveProperty(field.replace('imessageConfig.', ''));
    }
  });

  it('strips every backend-specific field when the iMessage backend is unknown', () => {
    const { clean, removed } = stripPlaintextProviderKeys({
      imessageConfig: {
        backend: 'not-a-backend',
        imsgSocketPath: '/tmp/imsg.sock',
        bluebubblesUrl: 'https://messages.example.test',
        bluebubblesPasswordService: 'whatsoup-bluebubbles-line-a',
      },
    });
    const sanitized = clean.imessageConfig as Record<string, unknown>;

    expect(sanitized.backend).toBe('not-a-backend');
    expect(sanitized).not.toHaveProperty('imsgSocketPath');
    expect(sanitized).not.toHaveProperty('bluebubblesUrl');
    expect(sanitized).not.toHaveProperty('bluebubblesPasswordService');
    expect(removed).toEqual(expect.arrayContaining([
      'imessageConfig.imsgSocketPath',
      'imessageConfig.bluebubblesUrl',
      'imessageConfig.bluebubblesPasswordService',
    ]));
  });
});
