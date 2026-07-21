import { describe, it, expect } from 'vitest';
import {
  PLAINTEXT_PROVIDER_KEY_FIELDS,
  stripPlaintextProviderKeys,
} from '../../src/lib/config-plaintext-keys.ts';

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

  it('only strips at the top level — nested same-named fields are untouched', () => {
    const { clean, removed } = stripPlaintextProviderKeys({
      memory: { apiKey: 'nested-not-ours' },
    });
    expect(removed).toEqual([]);
    expect(clean).toEqual({ memory: { apiKey: 'nested-not-ours' } });
  });

  it('strips raw transport secrets without mutating safe nested config', () => {
    const input = {
      twilioConfig: {
        accountSid: 'AC00000000000000000000000000000000',
        authTokenService: 'whatsoup-twilio',
        authToken: 'must-not-reach-disk',
      },
      imessageConfig: {
        backend: 'bluebubbles',
        bluebubblesPasswordService: 'whatsoup-bluebubbles',
        bluebubblesPassword: 'must-not-reach-disk',
      },
    };

    const { clean, removed } = stripPlaintextProviderKeys(input);

    expect(removed.sort()).toEqual([
      'imessageConfig.bluebubblesPassword',
      'twilioConfig.authToken',
    ]);
    expect(clean).toEqual({
      twilioConfig: {
        accountSid: 'AC00000000000000000000000000000000',
        authTokenService: 'whatsoup-twilio',
      },
      imessageConfig: {
        backend: 'bluebubbles',
        bluebubblesPasswordService: 'whatsoup-bluebubbles',
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

  it('strips transport-secret aliases and backups while preserving keyring service references', () => {
    const { clean, removed } = stripPlaintextProviderKeys({
      twilioConfig: {
        authTokenService: 'twilio-service',
        auth_token: 'snake-secret',
        token: 'short-secret',
        authTokenBackup: 'backup-secret',
        backupAuthToken: 'prefix-backup-secret',
        secret: 'generic-secret',
        twilioToken: 'provider-prefixed-secret',
      },
      imessageConfig: {
        bluebubblesPasswordService: 'bluebubbles-service',
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
      twilioConfig: { authTokenService: 'twilio-service' },
      imessageConfig: { bluebubblesPasswordService: 'bluebubbles-service' },
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
});
