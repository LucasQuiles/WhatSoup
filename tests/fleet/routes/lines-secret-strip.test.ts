vi.mock('../../../src/lib/keyring.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/keyring.ts')>();
  return { ...actual, lookupCredential: vi.fn() };
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { handleGetLine, type LinesDeps } from '../../../src/fleet/routes/lines.ts';
import type { DiscoveredInstance } from '../../../src/fleet/discovery.ts';
import { mockReq, mockRes } from '../../helpers/http-mocks.ts';

function instanceAt(configPath: string): DiscoveredInstance {
  return {
    name: 'cfgsecret',
    type: 'chat',
    accessMode: 'self_only',
    healthPort: 3010,
    dbPath: '/data/cfgsecret/bot.db',
    stateRoot: '/state/cfgsecret',
    logDir: '/data/cfgsecret/logs',
    healthToken: null,
    configPath,
    socketPath: null,
  };
}

function depsFor(instance: DiscoveredInstance): LinesDeps {
  return {
    discovery: {
      getInstance: vi.fn(() => instance),
      getInstances: vi.fn(() => new Map([[instance.name, instance]])),
    } as unknown as LinesDeps['discovery'],
    healthPoller: {
      getStatus: vi.fn(() => undefined),
      getStatuses: vi.fn(() => new Map()),
    } as unknown as LinesDeps['healthPoller'],
    dbReader: {
      getSummaryStats: vi.fn(() => ({
        ok: true,
        data: { messageCount: 0, chatCount: 0, pendingAccess: 0 },
      })),
      query: vi.fn(() => ({ ok: true, data: [] })),
    } as unknown as LinesDeps['dbReader'],
  };
}

describe('handleGetLine secret stripping', () => {
  it('never serializes malformed or credential-bearing legacy transport config', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-cfg-secret-'));
    try {
      const configPath = path.join(tmp, 'config.json');
      fs.writeFileSync(configPath, JSON.stringify({
        name: 'mybot',
        backupAuthToken: 'top-level-secret-sentinel',
        chatOptions: {
          openaiProviderConfig: {
            baseUrl: 'https://chat-user:chat-password@chat.example.test/v1',
            apiKeyService: 'openai',
            apiKey: 'nested-provider-secret-sentinel',
            headers: { Authorization: 'chat-header-secret-sentinel' },
          },
        },
        agentOptions: {
          providerConfig: {
            model: 'gpt-test',
            baseUrl: 'https://agent.example.test/v1?api_key=agent-query-secret-sentinel',
            apiKeyService: 'openai',
            cookies: { session: 'agent-cookie-secret-sentinel' },
          },
        },
        transcriptionOptions: {
          openaiProviderConfig: {
            baseUrl: 'https://audio.example.test/v1#audio-fragment-secret-sentinel',
            apiKeyService: 'openai',
            headers: { Authorization: 'audio-header-secret-sentinel' },
          },
        },
        memory: {
          apiKey: 'opaque-memory-secret-sentinel',
          provider: { value: 'opaque-provider-value-secret-sentinel' },
          providers: [
            { name: 'safe-provider', password: 'opaque-array-password-sentinel' },
            [{ Authorization: 'opaque-nested-array-secret-sentinel', label: 'safe-label' }],
            [['opaque-scalar-array-secret-sentinel']],
          ],
          pinecone: {
            apiKeyEnv: 'opaque-api-key-value-secret-sentinel',
            index: 'whatsapp-bot',
            embedUrl: 'https://embed-user:embed-password@embed.example.test/v1?api_key=embed-query-sentinel',
            knowledgeProfiles: {
              secretary: {
                description: 'safe profile',
                embedUrl: 'https://profile.example.test/v1#profile-fragment-sentinel',
              },
            },
          },
        },
        signalConfig: 'raw-transport-config-secret',
        twilioConfig: {
          account: { password: 'scalar-field-secret-sentinel' },
          authTokenService: 'whatsoup-twilio-other-line',
          authToken: 'nested-secret-sentinel',
          webhook: {
            publicBaseUrl: 'https://relay.example.test/twilio?token=url-query-marker',
            listenPort: 3000,
          },
        },
        imessageConfig: {
          account: 'messages',
          backend: 'bluebubbles',
          bluebubblesUrl: 'https://messages.example.test/api#url-fragment-marker',
          bluebubblesPasswordService: 'whatsoup-bluebubbles-messages',
          sender: 'owner@example.com',
        },
      }));
      const res = mockRes();

      await handleGetLine(mockReq(), res, depsFor(instanceAt(configPath)), { name: 'cfgsecret' });

      expect(res._status).toBe(200);
      expect(JSON.parse(res._body).config).toEqual({
        name: 'mybot',
        chatOptions: { openaiProviderConfig: {} },
        agentOptions: { providerConfig: { model: 'gpt-test' } },
        transcriptionOptions: { openaiProviderConfig: {} },
        memory: {
          pinecone: {
            index: 'whatsapp-bot',
            knowledgeProfiles: {
              secretary: { description: 'safe profile' },
            },
          },
        },
        twilioConfig: {
          webhook: { listenPort: 3000 },
        },
        imessageConfig: {
          account: 'messages',
          backend: 'bluebubbles',
          sender: 'owner@example.com',
        },
      });
      for (const secret of [
        'top-level-secret-sentinel',
        'nested-provider-secret-sentinel',
        'chat-password',
        'chat-header-secret-sentinel',
        'agent-query-secret-sentinel',
        'agent-cookie-secret-sentinel',
        'audio-fragment-secret-sentinel',
        'audio-header-secret-sentinel',
        'opaque-memory-secret-sentinel',
        'opaque-provider-value-secret-sentinel',
        'opaque-array-password-sentinel',
        'opaque-nested-array-secret-sentinel',
        'opaque-scalar-array-secret-sentinel',
        'opaque-api-key-value-secret-sentinel',
        'embed-password',
        'embed-query-sentinel',
        'profile-fragment-sentinel',
        'raw-transport-config-secret',
        'scalar-field-secret-sentinel',
        'nested-secret-sentinel',
        'url-query-marker',
        'url-fragment-marker',
      ]) {
        expect(res._body).not.toContain(secret);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
