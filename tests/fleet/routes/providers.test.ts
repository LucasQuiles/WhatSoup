/**
 * Tests for src/fleet/routes/providers.ts — GET /api/providers catalog.
 */
import { describe, it, expect } from 'vitest';
import { handleGetProviders } from '../../../src/fleet/routes/providers.ts';
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

  it('exposes display name, type, and accepted providerConfig fields for openai-api', () => {
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
});
