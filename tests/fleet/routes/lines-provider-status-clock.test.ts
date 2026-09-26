/**
 * #2200 (src/fleet slice): GET /api/lines/:name/provider-status decides
 * whether the fallback window is active against the injected Clock carried
 * in LinesDeps, not the raw wall clock.
 *
 * The window ends one minute after a fake "now" that sits months before the
 * real clock. By the injected clock it is still open; by the wall clock it
 * closed long ago, so a handler that reads the wall clock reports inactive.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/lib/keyring.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/keyring.ts')>();
  return { ...actual, lookupCredential: vi.fn() };
});
vi.mock('node:fs', () => {
  const readFile = vi.fn();
  return { promises: { readFile }, readdirSync: vi.fn(() => []) };
});

import * as fs from 'node:fs';
import { handleGetLineProviderStatus, type LinesDeps } from '../../../src/fleet/routes/lines.ts';
import type { DiscoveredInstance } from '../../../src/fleet/discovery.ts';
import type { InstanceStatus } from '../../../src/fleet/health-poller.ts';
import { fakeClock } from '../../../src/lib/clock.ts';
import { mockReq, mockRes } from '../../helpers/http-mocks.ts';

const FAKE_NOW_MS = Date.parse('2026-07-10T14:00:00.000Z');

const INSTANCE: DiscoveredInstance = {
  name: 'agent-line',
  type: 'agent',
  accessMode: 'self_only',
  healthPort: 3010,
  dbPath: '/data/agent-line/bot.db',
  stateRoot: '/state/agent-line',
  logDir: '/data/agent-line/logs',
  healthToken: null,
  configPath: '/config/agent-line/config.json',
  socketPath: null,
};

function statusWithFallbackUntil(activeUntil: number): InstanceStatus {
  return {
    name: 'agent-line',
    health: { instance: { fallbackActiveUntil: activeUntil } },
    lastPollAt: '2026-07-10T14:00:00.000Z',
    consecutiveFailures: 0,
    everReachable: true,
    status: 'online',
    statusConfidence: 'confirmed',
    statusReason: 'health_body_ok',
    statusEvidence: ['health_status=healthy'],
    error: null,
    lastAlertAt: null,
    silencedUntil: null,
    activeAlertSources: [],
  };
}

describe('#2200 provider-status reads time through the injected clock', () => {
  beforeEach(() => {
    vi.mocked(fs.promises.readFile).mockResolvedValue(JSON.stringify({ agentOptions: { provider: 'claude-cli' } }));
  });

  it('reports the fallback window active while the injected clock is inside it', async () => {
    const status = statusWithFallbackUntil(FAKE_NOW_MS + 60_000);
    const deps: LinesDeps = {
      discovery: {
        getInstance: vi.fn(() => INSTANCE),
        getInstances: vi.fn(() => new Map([[INSTANCE.name, INSTANCE]])),
      } as unknown as LinesDeps['discovery'],
      healthPoller: {
        getStatus: vi.fn(() => status),
        getStatuses: vi.fn(() => new Map()),
      } as unknown as LinesDeps['healthPoller'],
      dbReader: { query: vi.fn(() => ({ ok: true, data: [] })) } as unknown as LinesDeps['dbReader'],
      clock: fakeClock(FAKE_NOW_MS),
    };

    const res = mockRes();
    await handleGetLineProviderStatus(mockReq(), res, deps, { name: 'agent-line' });

    expect(res._status).toBe(200);
    const body = JSON.parse(res._body) as { fallback: { active: boolean; activeUntil: number | null } };
    expect(body.fallback.activeUntil).toBe(FAKE_NOW_MS + 60_000);
    expect(body.fallback.active).toBe(true);
  });
});
