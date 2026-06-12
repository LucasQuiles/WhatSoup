/**
 * Tests for GET /api/lines/:name/provider-status (handleGetLineProviderStatus).
 *
 * Strategy: mock the keyring (lookupCredential) and node:fs so the handler
 * reads a synthetic instance config off disk, then assert the exact
 * primary/fallback/keyPresent/active shape.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/lib/keyring.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/keyring.ts')>();
  return {
    ...actual,
    lookupCredential: vi.fn(),
  };
});

vi.mock('node:fs', () => {
  const readFile = vi.fn();
  return {
    promises: { readFile },
    readdirSync: vi.fn(() => []),
  };
});

import * as fs from 'node:fs';
import { lookupCredential } from '../../../src/lib/keyring.ts';
import { handleGetLineProviderStatus } from '../../../src/fleet/routes/lines.ts';
import type { LinesDeps } from '../../../src/fleet/routes/lines.ts';
import type { DiscoveredInstance } from '../../../src/fleet/discovery.ts';
import type { InstanceStatus } from '../../../src/fleet/health-poller.ts';
import { mockReq, mockRes } from '../../helpers/http-mocks.ts';

const mockedLookup = vi.mocked(lookupCredential);
const mockedReadFile = vi.mocked(fs.promises.readFile);

function fakeInstance(overrides: Partial<DiscoveredInstance> = {}): DiscoveredInstance {
  return {
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
    ...overrides,
  };
}

function fakeStatus(overrides: Partial<InstanceStatus> = {}): InstanceStatus {
  return {
    name: 'agent-line',
    health: { uptime: 1 },
    lastPollAt: '2026-04-01T00:00:00.000Z',
    consecutiveFailures: 0,
    status: 'online',
    error: null,
    lastAlertAt: null,
    silencedUntil: null,
    ...overrides,
  };
}

function makeDeps(inst: DiscoveredInstance | undefined, status?: InstanceStatus): LinesDeps {
  return {
    discovery: {
      getInstance: vi.fn(() => inst),
      getInstances: vi.fn(() => (inst ? new Map([[inst.name, inst]]) : new Map())),
    } as any,
    healthPoller: {
      getStatus: vi.fn(() => status),
      getStatuses: vi.fn(() => new Map()),
    } as any,
    dbReader: {
      query: vi.fn(() => ({ ok: true, data: [] })),
    } as any,
  };
}

beforeEach(() => {
  mockedLookup.mockReset();
  mockedReadFile.mockReset();
});

describe('handleGetLineProviderStatus', () => {
  it('returns 404 for an unknown instance', async () => {
    const res = mockRes();
    await handleGetLineProviderStatus(mockReq(), res, makeDeps(undefined), { name: 'ghost' });
    expect(res._status).toBe(404);
    expect(JSON.parse(res._body).error).toMatch(/not found/);
  });

  it('maps openai-api primary to the openai keyring service and reports keyPresent', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({ agentOptions: { provider: 'openai-api', model: 'gpt-4o' } }),
    );
    mockedLookup.mockReturnValue('sk-secret-value');

    const res = mockRes();
    await handleGetLineProviderStatus(mockReq(), res, makeDeps(fakeInstance()), { name: 'agent-line' });

    expect(res._status).toBe(200);
    expect(mockedLookup).toHaveBeenCalledWith('openai');
    const body = JSON.parse(res._body);
    expect(body).toEqual({
      primary: { provider: 'openai-api', model: 'gpt-4o', keyPresent: true },
      fallback: {
        provider: null,
        model: null,
        keyPresent: null,
        active: false,
        activeUntil: null,
        effectiveProvider: null,
        turnsServed: null,
        turnsEmpty: null,
        lastFallbackTurnAt: null,
      },
      lineReachable: false,
    });
  });

  it('derives the opencode-cli keyring service from the model prefix and never leaks the key value', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({ agentOptions: { provider: 'opencode-cli', model: 'minimax/abab6.5' } }),
    );
    mockedLookup.mockReturnValue(null);

    const res = mockRes();
    await handleGetLineProviderStatus(mockReq(), res, makeDeps(fakeInstance()), { name: 'agent-line' });

    expect(mockedLookup).toHaveBeenCalledWith('minimax');
    const body = JSON.parse(res._body);
    expect(res._body).not.toContain('sk-');
    expect(body.primary).toEqual({ provider: 'opencode-cli', model: 'minimax/abab6.5', keyPresent: false });
  });

  it('returns keyPresent=null for native-auth CLI providers without calling lookupCredential', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({ agentOptions: { provider: 'claude-cli' } }),
    );

    const res = mockRes();
    await handleGetLineProviderStatus(mockReq(), res, makeDeps(fakeInstance()), { name: 'agent-line' });

    expect(mockedLookup).not.toHaveBeenCalled();
    const body = JSON.parse(res._body);
    expect(body.primary).toEqual({ provider: 'claude-cli', model: null, keyPresent: null });
  });

  it('reports an active fallback window from the health snapshot fallbackActiveUntil', async () => {
    const activeUntil = Date.now() + 300_000;
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        agentOptions: {
          provider: 'claude-cli',
          fallbackProvider: 'openai-api',
          fallbackModel: 'gpt-4o',
        },
      }),
    );
    mockedLookup.mockReturnValue('sk-fallback');

    const status = fakeStatus({
      health: {
        instance: {
          effectiveProvider: 'openai-api',
          fallbackActiveUntil: activeUntil,
          fallbackTurnsServed: 7,
          fallbackTurnsEmpty: 2,
          lastFallbackTurnAt: 1_781_087_200_000,
        },
      },
    });

    const res = mockRes();
    await handleGetLineProviderStatus(mockReq(), res, makeDeps(fakeInstance(), status), { name: 'agent-line' });

    const body = JSON.parse(res._body);
    expect(body.fallback).toEqual({
      provider: 'openai-api',
      model: 'gpt-4o',
      keyPresent: true,
      active: true,
      activeUntil,
      effectiveProvider: 'openai-api',
      turnsServed: 7,
      turnsEmpty: 2,
      lastFallbackTurnAt: 1_781_087_200_000,
    });
    expect(body.lineReachable).toBe(true);
  });

  it('reports an inactive fallback window when fallbackActiveUntil has elapsed', async () => {
    const elapsed = Date.now() - 1_000;
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        agentOptions: {
          provider: 'claude-cli',
          fallbackProvider: 'openai-api',
          fallbackModel: 'gpt-4o',
        },
      }),
    );
    mockedLookup.mockReturnValue('sk-fallback');

    const status = fakeStatus({
      health: { instance: { effectiveProvider: 'claude-cli', fallbackActiveUntil: elapsed } },
    });

    const res = mockRes();
    await handleGetLineProviderStatus(mockReq(), res, makeDeps(fakeInstance(), status), { name: 'agent-line' });

    const body = JSON.parse(res._body);
    expect(body.fallback).toEqual({
      provider: 'openai-api',
      model: 'gpt-4o',
      keyPresent: true,
      active: false,
      activeUntil: elapsed,
      effectiveProvider: 'claude-cli',
      turnsServed: null,
      turnsEmpty: null,
      lastFallbackTurnAt: null,
    });
  });

  it.each([
    ['online', true],
    ['unreachable', false],
    ['stopped', false],
  ] as const)('sets lineReachable from poller status %s', async (statusName, reachable) => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({ agentOptions: { provider: 'claude-cli' } }),
    );

    const status = fakeStatus({ status: statusName as InstanceStatus['status'] });

    const res = mockRes();
    await handleGetLineProviderStatus(mockReq(), res, makeDeps(fakeInstance(), status), { name: 'agent-line' });

    const body = JSON.parse(res._body);
    expect(body.lineReachable).toBe(reachable);
  });

  it.each([
    [
      'top-level model',
      { model: 'claude-opus-4-8', agentOptions: { provider: 'claude-cli', model: 'agent-options-model' } },
      'claude-opus-4-8',
    ],
    [
      'models.conversation',
      { models: { conversation: 'claude-sonnet-4-6' }, agentOptions: { provider: 'claude-cli' } },
      'claude-sonnet-4-6',
    ],
    [
      'agentOptions.model fallback',
      { agentOptions: { provider: 'claude-cli', model: 'agent-options-model' } },
      'agent-options-model',
    ],
  ] as const)('resolves primary.model from %s', async (_name, config, expectedModel) => {
    mockedReadFile.mockResolvedValue(JSON.stringify(config));

    const res = mockRes();
    await handleGetLineProviderStatus(mockReq(), res, makeDeps(fakeInstance(), fakeStatus()), { name: 'agent-line' });

    const body = JSON.parse(res._body);
    expect(body.primary).toEqual({
      provider: 'claude-cli',
      model: expectedModel,
      keyPresent: null,
    });
  });

  it('keeps existing provider-status fields and values additive-only', async () => {
    const activeUntil = Date.now() + 120_000;
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        agentOptions: {
          provider: 'openai-api',
          model: 'gpt-4o',
          fallbackProvider: 'opencode-cli',
          fallbackModel: 'minimax/minimax-m2',
        },
      }),
    );
    mockedLookup.mockImplementation((service) => service === 'openai' ? 'openai-key' : null);

    const status = fakeStatus({
      health: {
        instance: {
          effectiveProvider: 'opencode-cli',
          fallbackActiveUntil: activeUntil,
          fallbackTurnsServed: 3,
          fallbackTurnsEmpty: 1,
          lastFallbackTurnAt: 1_781_087_200_000,
        },
      },
    });

    const res = mockRes();
    await handleGetLineProviderStatus(mockReq(), res, makeDeps(fakeInstance(), status), { name: 'agent-line' });

    const body = JSON.parse(res._body);
    expect(body.primary).toEqual({
      provider: 'openai-api',
      model: 'gpt-4o',
      keyPresent: true,
    });
    const { effectiveProvider, turnsServed, turnsEmpty, lastFallbackTurnAt, ...existingFallback } = body.fallback;
    expect(existingFallback).toEqual({
      provider: 'opencode-cli',
      model: 'minimax/minimax-m2',
      keyPresent: false,
      active: true,
      activeUntil,
    });
    expect({ effectiveProvider, turnsServed, turnsEmpty, lastFallbackTurnAt }).toEqual({
      effectiveProvider: 'opencode-cli',
      turnsServed: 3,
      turnsEmpty: 1,
      lastFallbackTurnAt: 1_781_087_200_000,
    });
  });
});
