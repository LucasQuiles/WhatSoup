/**
 * Tests for src/fleet/routes/providers.ts — GET /api/providers catalog.
 */
import { describe, it, expect, vi } from 'vitest';
import { handleGetProviderModels, handleGetProviders } from '../../../src/fleet/routes/providers.ts';
import { PROVIDER_IDS } from '../../../src/runtimes/agent/providers/index.ts';
import { mockReq, mockRes } from '../../helpers/http-mocks.ts';

describe('handleGetProviders', () => {
  it('returns one catalog entry per PROVIDER_IDS id in order', () => {
    const res = mockRes();
    handleGetProviders(mockReq(), res);
    expect(res._status).toBe(200);
    const body = JSON.parse(res._body) as Array<{ id: string }>;
    expect(body.map((p) => p.id)).toEqual([...PROVIDER_IDS]);
  });

  it('marks api providers and opencode-cli as needing an api key, native-auth CLIs as not', () => {
    const res = mockRes();
    handleGetProviders(mockReq(), res);
    const body = JSON.parse(res._body) as Array<{ id: string; needsApiKey: boolean }>;
    const needs = Object.fromEntries(body.map((p) => [p.id, p.needsApiKey]));
    expect(needs).toEqual({
      'claude-cli': false,
      'codex-cli': false,
      'gemini-cli': false,
      'opencode-cli': true,
      'openai-api': true,
      'anthropic-api': true,
    });
  });

  it('exposes display name, type, and advertised providerConfig fields for openai-api', () => {
    const res = mockRes();
    handleGetProviders(mockReq(), res);
    const body = JSON.parse(res._body) as Array<{
      id: string;
      displayName: string;
      type: 'cli' | 'api';
      providerConfig: string[];
    }>;
    const openai = body.find((p) => p.id === 'openai-api');
    expect(openai).toEqual({
      id: 'openai-api',
      displayName: 'OpenAI',
      type: 'api',
      needsApiKey: true,
      credentialService: 'openai',
      providerConfig: ['model', 'baseUrl', 'apiKeyService'],
    });
  });

  it('lists only the model field in providerConfig for native-auth CLI providers', () => {
    const res = mockRes();
    handleGetProviders(mockReq(), res);
    const body = JSON.parse(res._body) as Array<{ id: string; providerConfig: string[] }>;
    const gemini = body.find((p) => p.id === 'gemini-cli');
    expect(gemini?.providerConfig).toEqual(['model']);
  });

  it('advertises the Anthropic response-token control accepted by its adapter', () => {
    const res = mockRes();
    handleGetProviders(mockReq(), res);
    const body = JSON.parse(res._body) as Array<{ id: string; providerConfig: string[] }>;
    const anthropic = body.find((p) => p.id === 'anthropic-api');
    expect(anthropic?.providerConfig).toEqual(['model', 'baseUrl', 'apiKeyService', 'maxTokens']);
  });
});

describe('handleGetProviderModels', () => {
  it('resolves a known provider through the shared live catalogue', async () => {
    const res = mockRes();
    const resolve = vi.fn().mockResolvedValue({
      status: 'ok',
      ids: ['openai/gpt-next', 'acme/new-model'],
      sourceLabel: 'test live catalogue',
      asOfLabel: 'just now',
    });

    await handleGetProviderModels(mockReq(), res, { name: 'codex-cli' }, {
      resolveModelCatalogue: resolve,
      getProviderBinary: vi.fn().mockReturnValue('/opt/codex'),
      nowMs: () => 42,
    });

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({
      status: 'ok',
      ids: ['openai/gpt-next', 'acme/new-model'],
      sourceLabel: 'test live catalogue',
      asOfLabel: 'just now',
    });
    expect(resolve).toHaveBeenCalledWith('codex-cli', '/opt/codex', { nowMs: 42 });
  });

  it('returns an honest unavailable listing without converting it to an empty catalog', async () => {
    const res = mockRes();

    await handleGetProviderModels(mockReq(), res, { name: 'gemini-cli' }, {
      resolveModelCatalogue: vi.fn().mockResolvedValue({
        status: 'unavailable',
        reason: { kind: 'no-adapter', harness: 'gemini-cli' },
        asOfLabel: 'just now',
      }),
      getProviderBinary: vi.fn().mockReturnValue('gemini'),
      nowMs: () => 42,
    });

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({
      status: 'unavailable',
      reason: { kind: 'no-adapter', harness: 'gemini-cli' },
      asOfLabel: 'just now',
    });
  });

  it('rejects unknown execution providers before probing any binary or catalogue', async () => {
    const res = mockRes();
    const resolve = vi.fn();
    const getProviderBinary = vi.fn();

    await handleGetProviderModels(mockReq(), res, { name: 'invented-provider' }, {
      resolveModelCatalogue: resolve,
      getProviderBinary,
      nowMs: () => 42,
    });

    expect(res._status).toBe(404);
    expect(JSON.parse(res._body)).toEqual({ error: "unknown provider 'invented-provider'" });
    expect(resolve).not.toHaveBeenCalled();
    expect(getProviderBinary).not.toHaveBeenCalled();
  });
});
