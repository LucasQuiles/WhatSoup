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

  it('probes OpenCode with a model-addressed run instead of catalog membership only', async () => {
    const probeBinaryCommand = vi.fn(async () => ({
      status: 'failed' as const,
      output: 'The model configured-primary does not exist or you do not have access to it.',
    }));
    const adapters = createPrimaryModelProbeAdapters(undefined, {
      cwd: '/agent-cwd',
      buildChildEnv: vi.fn(() => ({ PATH: '/usr/bin' })),
      getProviderBinary: vi.fn(() => 'opencode'),
      probeBinaryCommand,
    });

    await expect(
      adapters.probeBinaryModel?.({ provider: 'opencode-cli', model: 'configured-primary' }),
    ).resolves.toEqual({ status: 'model_unavailable' });

    expect(probeBinaryCommand).toHaveBeenCalledWith(
      'opencode',
      ['run', '--format', 'json', '--pure', '-m', 'configured-primary', 'Reply with OK only.'],
      expect.any(Object),
      { cwd: '/agent-cwd', timeoutMs: 15_000 },
    );
  });

  it('probes OpenCode custom-endpoint models from cwd config without overriding -m', async () => {
    const probeBinaryCommand = vi.fn(async () => ({
      status: 'ok' as const,
      output: '{"type":"message","role":"assistant","content":"OK"}',
    }));
    const adapters = createPrimaryModelProbeAdapters(
      { baseUrl: 'https://openai-compatible.example/v1', apiKeyService: 'tenant-openai' },
      {
        cwd: '/agent-cwd',
        buildChildEnv: vi.fn(() => ({ PATH: '/usr/bin', OPENAI_API_KEY: 'sk-test-secret' })),
        getProviderBinary: vi.fn(() => 'opencode'),
        probeBinaryCommand,
      },
    );

    await expect(
      adapters.probeBinaryModel?.({ provider: 'opencode-cli', model: 'configured-primary' }),
    ).resolves.toEqual({ status: 'ok' });

    expect(probeBinaryCommand).toHaveBeenCalledWith(
      'opencode',
      ['run', '--format', 'json', '--pure', 'Reply with OK only.'],
      expect.objectContaining({ OPENAI_API_KEY: 'sk-test-secret' }),
      { cwd: '/agent-cwd', timeoutMs: 15_000 },
    );
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
