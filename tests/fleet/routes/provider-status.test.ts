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
    everReachable: true,
    status: 'online',
    statusConfidence: 'confirmed',
    statusReason: 'health_body_ok',
    statusEvidence: ['health_status=healthy'],
    error: null,
    lastAlertAt: null,
    silencedUntil: null,
    activeAlertSources: [],
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
    mockedLookup.mockReturnValue('secret-value');

    const res = mockRes();
    await handleGetLineProviderStatus(mockReq(), res, makeDeps(fakeInstance()), { name: 'agent-line' });

    expect(res._status).toBe(200);
    expect(mockedLookup).toHaveBeenCalledWith('openai');
    const body = JSON.parse(res._body);
    expect(body).toEqual({
      primary: { provider: 'openai-api', model: 'gpt-4o', keyPresent: true, endpointHost: null, apiKeyService: null },
      fallback: {
        provider: null,
        model: null,
        keyPresent: null,
        active: false,
        activeUntil: null,
        effectiveProvider: null,
        reason: null,
        resetAt: null,
        recoveryProbeRequired: false,
        turnsServed: null,
        turnsEmpty: null,
        lastFallbackTurnAt: null,
        probeAttempts: null,
        lastProbeAt: null,
        windowCostUsd: null,
        activations: null,
        reverts: null,
        replays: null,
        activeEntry: null,
        chain: [],
      },
      signal: {
        status: null,
        confidence: null,
        reason: 'not_polled',
        evidence: [],
      },
      lineReachable: false,
    });
  });

  it('honors providerConfig.apiKeyService for HTTP primary providers', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        agentOptions: {
          provider: 'openai-api',
          providerConfig: { apiKeyService: 'prod-openai' },
          model: 'gpt-4o',
        },
      }),
    );
    mockedLookup.mockImplementation((service) => service === 'prod-openai' ? 'prod-openai-key' : null);

    const res = mockRes();
    await handleGetLineProviderStatus(mockReq(), res, makeDeps(fakeInstance(), fakeStatus()), { name: 'agent-line' });

    expect(mockedLookup).toHaveBeenCalledWith('prod-openai');
    expect(mockedLookup).not.toHaveBeenCalledWith('openai');
    const body = JSON.parse(res._body);
    expect(body.primary).toEqual({ provider: 'openai-api', model: 'gpt-4o', keyPresent: true, endpointHost: null, apiKeyService: 'prod-openai' });
    expect(res._body).not.toContain('prod-openai-key');
  });

  it('maps anthropic-api to the anthropic keyring service and reports keyPresent', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({ agentOptions: { provider: 'anthropic-api', model: 'claude-sonnet-4-6' } }),
    );
    mockedLookup.mockReturnValue('anthropic-secret-value');

    const res = mockRes();
    await handleGetLineProviderStatus(mockReq(), res, makeDeps(fakeInstance(), fakeStatus()), { name: 'agent-line' });

    expect(mockedLookup).toHaveBeenCalledWith('anthropic');
    const body = JSON.parse(res._body);
    expect(body.primary).toEqual({ provider: 'anthropic-api', model: 'claude-sonnet-4-6', keyPresent: true, endpointHost: null, apiKeyService: null });
    expect(res._body).not.toContain('anthropic-secret-value');
  });

  it('derives the opencode-cli keyring service from the model prefix and never leaks the key value', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({ agentOptions: { provider: 'opencode-cli', model: 'minimax/abab6.5' } }),
    );
    mockedLookup.mockReturnValue('minimax-secret-value');

    const res = mockRes();
    await handleGetLineProviderStatus(mockReq(), res, makeDeps(fakeInstance()), { name: 'agent-line' });

    expect(mockedLookup).toHaveBeenCalledWith('minimax');
    const body = JSON.parse(res._body);
    expect(res._body).not.toContain('minimax-secret-value');
    expect(body.primary).toEqual({ provider: 'opencode-cli', model: 'minimax/abab6.5', keyPresent: true, endpointHost: null, apiKeyService: null });
  });

  it('does not 500 when an invalid opencode model value reaches provider-status', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({ agentOptions: { provider: 'opencode-cli', model: 42 } }),
    );

    const res = mockRes();
    await handleGetLineProviderStatus(mockReq(), res, makeDeps(fakeInstance(), fakeStatus()), { name: 'agent-line' });

    expect(res._status).toBe(200);
    expect(mockedLookup).not.toHaveBeenCalled();
    const body = JSON.parse(res._body);
    expect(body.primary).toEqual({ provider: 'opencode-cli', model: null, keyPresent: null, endpointHost: null, apiKeyService: null });
  });

  it('returns keyPresent=null for native-auth CLI providers without calling lookupCredential', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({ agentOptions: { provider: 'claude-cli' } }),
    );

    const res = mockRes();
    await handleGetLineProviderStatus(mockReq(), res, makeDeps(fakeInstance()), { name: 'agent-line' });

    expect(mockedLookup).not.toHaveBeenCalled();
    const body = JSON.parse(res._body);
    expect(body.primary).toEqual({ provider: 'claude-cli', model: null, keyPresent: null, endpointHost: null, apiKeyService: null });
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
    mockedLookup.mockReturnValue('fallback-secret-value');

    const status = fakeStatus({
      health: {
        instance: {
          effectiveProvider: 'openai-api',
          fallbackActiveUntil: activeUntil,
          fallbackTurnsServed: 7,
          fallbackTurnsEmpty: 2,
          lastFallbackTurnAt: 1_781_087_200_000,
          probeAttempts: 4,
          lastProbeAt: 1_781_087_300_000,
          fallbackWindowCostUsd: 0.0042,
          fallbackActivations: 2,
          fallbackReverts: 1,
          fallbackReplays: 1,
          activeFallbackEntry: { provider: 'openai-api', model: 'gpt-4o' },
          fallbackChain: [{ provider: 'openai-api', model: 'gpt-4o', eligible: true }],
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
      reason: null,
      resetAt: null,
      recoveryProbeRequired: false,
      turnsServed: 7,
      turnsEmpty: 2,
      lastFallbackTurnAt: 1_781_087_200_000,
      probeAttempts: 4,
      lastProbeAt: 1_781_087_300_000,
      windowCostUsd: 0.0042,
      activations: 2,
      reverts: 1,
      replays: 1,
      activeEntry: { provider: 'openai-api', model: 'gpt-4o' },
      chain: [{ provider: 'openai-api', model: 'gpt-4o', eligible: true }],
    });
    expect(body.lineReachable).toBe(true);
  });

  it('uses ordered fallbacks[] as the configured fallback and forwards runtime chain state', async () => {
    const activeUntil = Date.now() + 300_000;
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        agentOptions: {
          provider: 'claude-cli',
          fallbacks: [
            { provider: 'opencode-cli', model: 'minimax/MiniMax-M2' },
            { provider: 'openai-api', model: 'gpt-4o-mini' },
          ],
        },
      }),
    );
    mockedLookup.mockImplementation((service) => service === 'openai' ? 'openai-key' : null);

    const status = fakeStatus({
      health: {
        instance: {
          effectiveProvider: 'openai-api',
          fallbackActiveUntil: activeUntil,
          activeFallbackEntry: { provider: 'openai-api', model: 'gpt-4o-mini' },
          fallbackChain: [
            { provider: 'opencode-cli', model: 'minimax/MiniMax-M2', eligible: false },
            { provider: 'openai-api', model: 'gpt-4o-mini', eligible: true },
          ],
        },
      },
    });

    const res = mockRes();
    await handleGetLineProviderStatus(mockReq(), res, makeDeps(fakeInstance(), status), { name: 'agent-line' });

    const body = JSON.parse(res._body);
    expect(body.fallback).toMatchObject({
      provider: 'opencode-cli',
      model: 'minimax/MiniMax-M2',
      keyPresent: false,
      active: true,
      activeUntil,
      effectiveProvider: 'openai-api',
      activeEntry: { provider: 'openai-api', model: 'gpt-4o-mini' },
      chain: [
        { provider: 'opencode-cli', model: 'minimax/MiniMax-M2', eligible: false },
        { provider: 'openai-api', model: 'gpt-4o-mini', eligible: true },
      ],
    });
  });

  it('uses providerConfig.apiKeyService for same-provider API fallback key presence', async () => {
    const activeUntil = Date.now() + 300_000;
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        agentOptions: {
          provider: 'openai-api',
          providerConfig: { apiKeyService: 'tenant-openai' },
          model: 'gpt-4o',
          fallbackProvider: 'openai-api',
          fallbackModel: 'gpt-4o-mini',
        },
      }),
    );
    mockedLookup.mockImplementation((service) => service === 'tenant-openai' ? 'tenant-openai-key' : null);

    const status = fakeStatus({
      health: { instance: { effectiveProvider: 'openai-api', fallbackActiveUntil: activeUntil } },
    });

    const res = mockRes();
    await handleGetLineProviderStatus(mockReq(), res, makeDeps(fakeInstance(), status), { name: 'agent-line' });

    expect(mockedLookup).toHaveBeenCalledWith('tenant-openai');
    expect(mockedLookup).not.toHaveBeenCalledWith('openai');
    const body = JSON.parse(res._body);
    expect(body.fallback.keyPresent).toBe(true);
    expect(res._body).not.toContain('tenant-openai-key');
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
    mockedLookup.mockReturnValue('fallback-secret-value');

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
      reason: null,
      resetAt: null,
      recoveryProbeRequired: false,
      turnsServed: null,
      turnsEmpty: null,
      lastFallbackTurnAt: null,
      probeAttempts: null,
      lastProbeAt: null,
      windowCostUsd: null,
      activations: null,
      reverts: null,
      replays: null,
      activeEntry: null,
      chain: [{ provider: 'openai-api', model: 'gpt-4o', eligible: null }],
    });
  });

  it.each([
    [{ status: 'online' as const }, true],
    [{ status: 'logged_out' as const }, true],
    [{ status: 'degraded' as const, health: { status: 'unhealthy', instance: {} }, error: null }, true],
    [{ status: 'degraded' as const, health: { stale: true }, error: 'HTTP 500' }, false],
    [{ status: 'unreachable' as const }, false],
  ] as const)('sets lineReachable from poller state %#', async (statusOverrides, reachable) => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({ agentOptions: { provider: 'claude-cli' } }),
    );

    const status = fakeStatus(statusOverrides);

    const res = mockRes();
    await handleGetLineProviderStatus(mockReq(), res, makeDeps(fakeInstance(), status), { name: 'agent-line' });

    const body = JSON.parse(res._body);
    expect(body.lineReachable).toBe(reachable);
  });

  it('surfaces poller signal confidence and evidence for provider diagnostics', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({ agentOptions: { provider: 'claude-cli' } }),
    );

    const status = fakeStatus({
      status: 'degraded',
      statusConfidence: 'ambiguous',
      statusReason: 'whatsapp_backoff_zero_attempts_without_disconnect_corroboration',
      statusEvidence: [
        'health_status=healthy',
        'whatsapp_connected=true',
        'reconnect_phase=backoff',
        'reconnect_attempts=0',
      ],
    });

    const res = mockRes();
    await handleGetLineProviderStatus(mockReq(), res, makeDeps(fakeInstance(), status), { name: 'agent-line' });

    const body = JSON.parse(res._body);
    expect(body.signal).toEqual({
      status: 'degraded',
      confidence: 'ambiguous',
      reason: 'whatsapp_backoff_zero_attempts_without_disconnect_corroboration',
      evidence: [
        'health_status=healthy',
        'whatsapp_connected=true',
        'reconnect_phase=backoff',
        'reconnect_attempts=0',
      ],
    });
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
      endpointHost: null,
      apiKeyService: null,
    });
  });

  it('resolves primary.model from API providerConfig.model when no runtime model is set', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        agentOptions: {
          provider: 'openai-api',
          providerConfig: { model: 'gpt-4o', apiKeyService: 'prod-openai' },
        },
      }),
    );
    mockedLookup.mockImplementation((service) => service === 'prod-openai' ? 'prod-openai-key' : null);

    const res = mockRes();
    await handleGetLineProviderStatus(mockReq(), res, makeDeps(fakeInstance(), fakeStatus()), { name: 'agent-line' });

    const body = JSON.parse(res._body);
    expect(body.primary).toEqual({
      provider: 'openai-api',
      model: 'gpt-4o',
      keyPresent: true,
      endpointHost: null,
      apiKeyService: 'prod-openai',
    });
  });

  it('reports the runtime default primary provider when config omits agentOptions.provider', async () => {
    mockedReadFile.mockResolvedValue(JSON.stringify({ agentOptions: {} }));

    const res = mockRes();
    await handleGetLineProviderStatus(mockReq(), res, makeDeps(fakeInstance(), fakeStatus()), { name: 'agent-line' });

    const body = JSON.parse(res._body);
    expect(body.primary).toEqual({
      provider: 'claude-cli',
      model: null,
      keyPresent: null,
      endpointHost: null,
      apiKeyService: null,
    });
  });

  it('does not report the agent runtime default for non-agent instances', async () => {
    mockedReadFile.mockResolvedValue(JSON.stringify({}));

    const res = mockRes();
    await handleGetLineProviderStatus(
      mockReq(),
      res,
      makeDeps(fakeInstance({ type: 'chat' }), fakeStatus()),
      { name: 'agent-line' },
    );

    const body = JSON.parse(res._body);
    expect(body.primary).toEqual({
      provider: null,
      model: null,
      keyPresent: null,
      endpointHost: null,
      apiKeyService: null,
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
          fallbackReason: 'auth-required',
          fallbackResetAt: activeUntil,
          fallbackRecoveryProbeRequired: true,
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
      endpointHost: null,
      apiKeyService: null,
    });
    const {
      effectiveProvider,
      reason,
      resetAt,
      recoveryProbeRequired,
      turnsServed,
      turnsEmpty,
      lastFallbackTurnAt,
      probeAttempts,
      lastProbeAt,
      windowCostUsd,
      activations,
      reverts,
      replays,
      activeEntry,
      chain,
      ...existingFallback
    } = body.fallback;
    expect(existingFallback).toEqual({
      provider: 'opencode-cli',
      model: 'minimax/minimax-m2',
      keyPresent: false,
      active: true,
      activeUntil,
    });
    expect({ effectiveProvider, reason, resetAt, recoveryProbeRequired, turnsServed, turnsEmpty, lastFallbackTurnAt, probeAttempts, lastProbeAt, windowCostUsd }).toEqual({
      effectiveProvider: 'opencode-cli',
      reason: 'auth-required',
      resetAt: activeUntil,
      recoveryProbeRequired: true,
      turnsServed: 3,
      turnsEmpty: 1,
      lastFallbackTurnAt: 1_781_087_200_000,
      // Health omits the probe-cap and cost fields here — the route tolerates absence (null).
      probeAttempts: null,
      lastProbeAt: null,
      windowCostUsd: null,
    });
    // Old-instance tolerance: health predating the transition counters → null.
    expect({ activations, reverts, replays }).toEqual({
      activations: null,
      reverts: null,
      replays: null,
    });
    expect(activeEntry).toBeNull();
    expect(chain).toEqual([{ provider: 'opencode-cli', model: 'minimax/minimax-m2', eligible: null }]);
  });
});
