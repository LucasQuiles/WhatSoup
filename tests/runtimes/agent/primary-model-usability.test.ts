import { describe, expect, it, vi } from 'vitest';
import {
  probePrimaryModelUsability,
  type ApiModelAccessProbeResult,
  type BinaryModelProbeResult,
  type PrimaryModelProbeAdapters,
} from '../../../src/runtimes/agent/providers/primary-model-usability.ts';

describe('probePrimaryModelUsability', () => {
  it('maps a successful binary model probe to usable', async () => {
    const adapters: PrimaryModelProbeAdapters = {
      probeBinaryModel: vi.fn(async () => ({ status: 'ok' as const })),
    };

    await expect(
      probePrimaryModelUsability({ provider: 'claude-cli', model: 'primary-model-a' }, adapters),
    ).resolves.toMatchObject({ status: 'usable', provider: 'claude-cli', model: 'primary-model-a' });
    expect(adapters.probeBinaryModel).toHaveBeenCalledWith({
      provider: 'claude-cli',
      model: 'primary-model-a',
    });
  });

  it('maps a binary model rejection to model-unavailable', async () => {
    const adapters: PrimaryModelProbeAdapters = {
      probeBinaryModel: vi.fn(async () => ({ status: 'model_unavailable' as const })),
    };

    await expect(
      probePrimaryModelUsability({ provider: 'claude-cli', model: 'primary-model-b' }, adapters),
    ).resolves.toMatchObject({ status: 'model-unavailable' });
  });

  it('maps a binary credential failure to credential-unavailable', async () => {
    const adapters: PrimaryModelProbeAdapters = {
      probeBinaryModel: vi.fn(async () => ({ status: 'credential_unavailable' as const })),
    };

    await expect(
      probePrimaryModelUsability({ provider: 'claude-cli', model: 'primary-model-a' }, adapters),
    ).resolves.toMatchObject({ status: 'credential-unavailable' });
  });

  it('maps OpenCode model-addressed binary probe results without using catalog-only checks', async () => {
    const foundAdapters: PrimaryModelProbeAdapters = {
      probeBinaryModel: vi.fn(async () => ({ status: 'ok' as const })),
    };
    await expect(
      probePrimaryModelUsability({ provider: 'opencode-cli', model: 'vendor/model-a' }, foundAdapters),
    ).resolves.toMatchObject({ status: 'usable' });
    expect(foundAdapters.probeBinaryModel).toHaveBeenCalledWith({
      provider: 'opencode-cli',
      model: 'vendor/model-a',
    });

    const missingAdapters: PrimaryModelProbeAdapters = {
      probeBinaryModel: vi.fn(async () => ({ status: 'model_unavailable' as const })),
    };
    await expect(
      probePrimaryModelUsability({ provider: 'opencode-cli', model: 'vendor/model-a' }, missingAdapters),
    ).resolves.toMatchObject({ status: 'model-unavailable' });
  });

  it('maps API model access statuses to the shared usability contract', async () => {
    const apiResults: ApiModelAccessProbeResult[] = [
      { status: 'found' },
      { status: 'not_found' },
      { status: 'credential_failed' },
      { status: 'provider_unavailable' },
    ];
    const adapters: PrimaryModelProbeAdapters = {
      probeApiModelAccess: vi.fn(async (): Promise<ApiModelAccessProbeResult> => {
        return apiResults.shift() ?? { status: 'unknown' };
      }),
    };

    await expect(
      probePrimaryModelUsability({ provider: 'openai-api', model: 'primary-model-a' }, adapters),
    ).resolves.toMatchObject({ status: 'usable' });
    await expect(
      probePrimaryModelUsability({ provider: 'openai-api', model: 'primary-model-b' }, adapters),
    ).resolves.toMatchObject({ status: 'model-unavailable' });
    await expect(
      probePrimaryModelUsability({ provider: 'anthropic-api', model: 'primary-model-a' }, adapters),
    ).resolves.toMatchObject({ status: 'credential-unavailable' });
    await expect(
      probePrimaryModelUsability({ provider: 'anthropic-api', model: 'primary-model-b' }, adapters),
    ).resolves.toMatchObject({ status: 'provider-unavailable' });
  });

  it('returns timeout when an adapter does not settle before the deadline', async () => {
    const adapters: PrimaryModelProbeAdapters = {
      probeApiModelAccess: vi.fn(async (): Promise<ApiModelAccessProbeResult> => new Promise(() => {})),
    };

    await expect(
      probePrimaryModelUsability(
        { provider: 'openai-api', model: 'primary-model-a' },
        adapters,
        { timeoutMs: 1 },
      ),
    ).resolves.toMatchObject({ status: 'timeout' });
  });

  it('keeps the default CLI model probe deadline beyond the old 5s startup window', async () => {
    vi.useFakeTimers();
    try {
      const adapters: PrimaryModelProbeAdapters = {
        probeBinaryModel: vi.fn(async (): Promise<BinaryModelProbeResult> => new Promise(() => {})),
      };

      const probePromise = probePrimaryModelUsability(
        { provider: 'claude-cli', model: 'primary-model-a' },
        adapters,
      );
      let settled = false;
      void probePromise.then(() => { settled = true; });

      await vi.advanceTimersByTimeAsync(5_001);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(10_000);
      await expect(probePromise).resolves.toMatchObject({ status: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns unknown when an adapter throws instead of misclassifying it as a timeout', async () => {
    const adapters: PrimaryModelProbeAdapters = {
      probeApiModelAccess: vi.fn(async () => {
        throw new Error('network unavailable');
      }),
    };

    await expect(
      probePrimaryModelUsability({ provider: 'openai-api', model: 'primary-model-a' }, adapters),
    ).resolves.toMatchObject({ status: 'unknown', reason: 'probe-threw' });
  });

  it('returns unknown when an adapter throws synchronously before returning a promise', async () => {
    const adapters: PrimaryModelProbeAdapters = {
      probeApiModelAccess: vi.fn(() => {
        throw new Error('synchronous adapter failure');
      }),
    };

    await expect(
      probePrimaryModelUsability({ provider: 'openai-api', model: 'primary-model-a' }, adapters),
    ).resolves.toMatchObject({ status: 'unknown', reason: 'probe-threw' });
  });

  it('returns unknown without calling adapters when provider or model is not probeable', async () => {
    const adapters: PrimaryModelProbeAdapters = {
      probeBinaryModel: vi.fn(async (): Promise<BinaryModelProbeResult> => ({ status: 'ok' })),
      probeApiModelAccess: vi.fn(async (): Promise<ApiModelAccessProbeResult> => ({ status: 'found' })),
    };

    await expect(
      probePrimaryModelUsability({ provider: 'unknown-provider', model: 'primary-model-a' }, adapters),
    ).resolves.toMatchObject({ status: 'unknown', reason: 'unsupported-provider' });
    await expect(
      probePrimaryModelUsability({ provider: 'claude-cli', model: '   ' }, adapters),
    ).resolves.toMatchObject({ status: 'unknown', reason: 'model-not-configured' });
    expect(adapters.probeBinaryModel).not.toHaveBeenCalled();
    expect(adapters.probeApiModelAccess).not.toHaveBeenCalled();
  });
});
