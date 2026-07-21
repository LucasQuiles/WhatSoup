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
        signalConfig: 'raw-transport-config-secret',
        twilioConfig: {
          account: { password: 'scalar-field-secret-sentinel' },
          authTokenService: 'twilio-keyring-service',
          authToken: 'nested-secret-sentinel',
          webhook: {
            publicBaseUrl: 'https://user:pass@example.test/twilio',
            listenPort: 3000,
          },
        },
      }));
      const res = mockRes();

      await handleGetLine(mockReq(), res, depsFor(instanceAt(configPath)), { name: 'cfgsecret' });

      expect(res._status).toBe(200);
      expect(JSON.parse(res._body).config).toEqual({
        name: 'mybot',
        twilioConfig: {
          authTokenService: 'twilio-keyring-service',
          webhook: { listenPort: 3000 },
        },
      });
      for (const secret of [
        'top-level-secret-sentinel',
        'raw-transport-config-secret',
        'scalar-field-secret-sentinel',
        'nested-secret-sentinel',
        'user:pass',
      ]) {
        expect(res._body).not.toContain(secret);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
