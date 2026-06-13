import { describe, expect, it, vi } from 'vitest';
import { createPrimaryModelProbeAdapters } from '../../../src/runtimes/agent/providers/primary-model-usability-adapters.ts';

describe('createPrimaryModelProbeAdapters', () => {
  it('maps the real Claude CLI selected-model rejection through the shared binary status contract', async () => {
    const adapters = createPrimaryModelProbeAdapters(undefined, {
      getProviderBinary: vi.fn(() => 'claude'),
      probeBinaryAuthStatus: vi.fn(async () => ({
        status: 'failed' as const,
        output: "There's an issue with the selected model (configured-primary). It may not exist or you may not have access to it.",
      })),
    });

    await expect(
      adapters.probeBinaryModel?.({ provider: 'claude-cli', model: 'configured-primary' }),
    ).resolves.toEqual({ status: 'model_unavailable' });
  });

  it('uses account-authenticated OpenAI model listings without leaking the key into the result', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ data: [{ id: 'api-live-model' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const adapters = createPrimaryModelProbeAdapters(
      { apiKeyService: 'tenant-openai', baseUrl: 'https://openai.example/v1' },
      {
        fetch: fetchImpl as unknown as typeof fetch,
        resolveApiKey: vi.fn(() => 'sk-test-secret'),
      },
    );

    await expect(
      adapters.probeApiModelAccess?.({ provider: 'openai-api', model: 'api-live-model' }),
    ).resolves.toEqual({ status: 'found' });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://openai.example/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer sk-test-secret' }),
      }),
    );
  });

  it('maps missing API credentials without making a network call', async () => {
    const fetchImpl = vi.fn();
    const adapters = createPrimaryModelProbeAdapters(undefined, {
      fetch: fetchImpl as unknown as typeof fetch,
      resolveApiKey: vi.fn(() => ''),
    });

    await expect(
      adapters.probeApiModelAccess?.({ provider: 'anthropic-api', model: 'api-live-model' }),
    ).resolves.toEqual({ status: 'credential_failed' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('maps authenticated model-list misses to not_found', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ data: [{ id: 'api-other-model' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const adapters = createPrimaryModelProbeAdapters(undefined, {
      fetch: fetchImpl as unknown as typeof fetch,
      resolveApiKey: vi.fn(() => 'sk-test-secret'),
    });

    await expect(
      adapters.probeApiModelAccess?.({ provider: 'openai-api', model: 'api-missing-model' }),
    ).resolves.toEqual({ status: 'not_found' });
  });
});
