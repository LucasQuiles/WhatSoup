import { describe, expect, it, vi } from 'vitest';
import {
  primaryModelUsabilityRequiresAlert,
  probePrimaryModelUsability,
  type ApiModelAccessProbeResult,
  type BinaryModelProbeResult,
  type PrimaryModelProbeAdapters,
  type PrimaryModelUsabilityResult,
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
      probePrimaryModelUsability({ provider: 'codex-cli', model: '   ' }, adapters),
    ).resolves.toMatchObject({ status: 'unknown', reason: 'model-not-configured' });
    expect(adapters.probeBinaryModel).not.toHaveBeenCalled();
    expect(adapters.probeApiModelAccess).not.toHaveBeenCalled();
  });
});

describe('primary-model-usability.ts uncovered-branch coverage', () => {
  it('returns unknown with api-model-probe-unavailable when an openai-api target has no api adapter', async () => {
    const adapters: PrimaryModelProbeAdapters = {};

    const result = await probePrimaryModelUsability(
      { provider: 'openai-api', model: 'primary-model-a' },
      adapters,
    );
    expect(result).toEqual({
      status: 'unknown',
      provider: 'openai-api',
      model: 'primary-model-a',
      reason: 'api-model-probe-unavailable',
    });
  });

  it('returns unknown with api-model-probe-unavailable for anthropic-api when no api adapter is provided', async () => {
    const adapters: PrimaryModelProbeAdapters = {};

    const result = await probePrimaryModelUsability(
      { provider: 'anthropic-api', model: 'claude-sonnet-test' },
      adapters,
    );
    expect(result).toEqual({
      status: 'unknown',
      provider: 'anthropic-api',
      model: 'claude-sonnet-test',
      reason: 'api-model-probe-unavailable',
    });
  });

  it('returns unknown with binary-model-probe-unavailable when a claude-cli target has no binary adapter', async () => {
    const adapters: PrimaryModelProbeAdapters = {};

    const result = await probePrimaryModelUsability(
      { provider: 'claude-cli', model: 'primary-model-a' },
      adapters,
    );
    expect(result).toEqual({
      status: 'unknown',
      provider: 'claude-cli',
      model: 'primary-model-a',
      reason: 'binary-model-probe-unavailable',
    });
  });

  it('returns unknown with binary-model-probe-unavailable for opencode-cli when no binary adapter is provided', async () => {
    const adapters: PrimaryModelProbeAdapters = {};

    const result = await probePrimaryModelUsability(
      { provider: 'opencode-cli', model: 'vendor/model-a' },
      adapters,
    );
    expect(result).toEqual({
      status: 'unknown',
      provider: 'opencode-cli',
      model: 'vendor/model-a',
      reason: 'binary-model-probe-unavailable',
    });
  });

  it('returns unknown with probe-threw when a binary adapter throws asynchronously', async () => {
    const adapters: PrimaryModelProbeAdapters = {
      probeBinaryModel: vi.fn(async (): Promise<BinaryModelProbeResult> => {
        throw new Error('binary probe exploded');
      }),
    };

    const result = await probePrimaryModelUsability(
      { provider: 'claude-cli', model: 'primary-model-a' },
      adapters,
    );
    expect(result).toEqual({
      status: 'unknown',
      provider: 'claude-cli',
      model: 'primary-model-a',
      reason: 'probe-threw',
    });
  });

  it('maps binary provider_unavailable to provider-unavailable', async () => {
    const adapters: PrimaryModelProbeAdapters = {
      probeBinaryModel: vi.fn(async (): Promise<BinaryModelProbeResult> => ({
        status: 'provider_unavailable',
      })),
    };

    const result = await probePrimaryModelUsability(
      { provider: 'claude-cli', model: 'primary-model-a' },
      adapters,
    );
    expect(result).toEqual({
      status: 'provider-unavailable',
      provider: 'claude-cli',
      model: 'primary-model-a',
    });
  });

  it('maps binary timeout status to timeout', async () => {
    const adapters: PrimaryModelProbeAdapters = {
      probeBinaryModel: vi.fn(async (): Promise<BinaryModelProbeResult> => ({
        status: 'timeout',
      })),
    };

    const result = await probePrimaryModelUsability(
      { provider: 'opencode-cli', model: 'vendor/model-a' },
      adapters,
    );
    expect(result).toEqual({
      status: 'timeout',
      provider: 'opencode-cli',
      model: 'vendor/model-a',
    });
  });

  it('maps binary unknown status with reason to unknown carrying that reason', async () => {
    const adapters: PrimaryModelProbeAdapters = {
      probeBinaryModel: vi.fn(async (): Promise<BinaryModelProbeResult> => ({
        status: 'unknown',
        reason: 'binary-probe-failed-detail',
      })),
    };

    const result = await probePrimaryModelUsability(
      { provider: 'claude-cli', model: 'primary-model-a' },
      adapters,
    );
    expect(result).toEqual({
      status: 'unknown',
      provider: 'claude-cli',
      model: 'primary-model-a',
      reason: 'binary-probe-failed-detail',
    });
  });

  it('maps api timeout status to timeout', async () => {
    const adapters: PrimaryModelProbeAdapters = {
      probeApiModelAccess: vi.fn(async (): Promise<ApiModelAccessProbeResult> => ({
        status: 'timeout',
      })),
    };

    const result = await probePrimaryModelUsability(
      { provider: 'openai-api', model: 'primary-model-a' },
      adapters,
    );
    expect(result).toEqual({
      status: 'timeout',
      provider: 'openai-api',
      model: 'primary-model-a',
    });
  });

  it('maps api unknown status with reason to unknown carrying that reason', async () => {
    const adapters: PrimaryModelProbeAdapters = {
      probeApiModelAccess: vi.fn(async (): Promise<ApiModelAccessProbeResult> => ({
        status: 'unknown',
        reason: 'api-probe-failed-detail',
      })),
    };

    const result = await probePrimaryModelUsability(
      { provider: 'anthropic-api', model: 'claude-sonnet-test' },
      adapters,
    );
    expect(result).toEqual({
      status: 'unknown',
      provider: 'anthropic-api',
      model: 'claude-sonnet-test',
      reason: 'api-probe-failed-detail',
    });
  });

  it('treats an undefined model as not-configured for codex AND opencode-cli, but claude-cli probes its default', async () => {
    const adapters: PrimaryModelProbeAdapters = {
      probeBinaryModel: vi.fn(async (): Promise<BinaryModelProbeResult> => ({ status: 'ok' })),
    };

    // codex-cli and opencode-cli have no default-model probe. codex takes its
    // model from config; opencode-cli derives the child's credential from the
    // model PREFIX (buildChildEnv) and has no usable default — config admission
    // requires a model (agent-config-validator). A null model is therefore
    // not-configured for both, and the binary adapter is never invoked.
    for (const provider of ['codex-cli', 'opencode-cli'] as const) {
      const result = await probePrimaryModelUsability(
        { provider, model: undefined },
        adapters,
      );
      expect(result).toEqual({
        status: 'unknown',
        provider,
        model: null,
        reason: 'model-not-configured',
      });
    }
    expect(adapters.probeBinaryModel).not.toHaveBeenCalled();

    // claude-cli alone DOES probe its own default with an undefined model
    // (subscription auth, no per-model credential); with no binary adapter it
    // degrades to adapter-missing rather than short-circuiting to not-configured.
    const probed = await probePrimaryModelUsability({ provider: 'claude-cli', model: undefined }, {});
    expect(probed).toEqual({
      status: 'unknown',
      provider: 'claude-cli',
      model: null,
      reason: 'binary-model-probe-unavailable',
    });
  });

  it('treats an explicit null model as not-configured for api providers', async () => {
    const adapters: PrimaryModelProbeAdapters = {
      probeApiModelAccess: vi.fn(async (): Promise<ApiModelAccessProbeResult> => ({ status: 'found' })),
    };

    const result = await probePrimaryModelUsability(
      { provider: 'openai-api', model: null },
      adapters,
    );
    expect(result).toEqual({
      status: 'unknown',
      provider: 'openai-api',
      model: null,
      reason: 'model-not-configured',
    });
    expect(adapters.probeApiModelAccess).not.toHaveBeenCalled();
  });

  it('returns timeout immediately when timeoutMs is zero', async () => {
    const adapters: PrimaryModelProbeAdapters = {
      probeBinaryModel: vi.fn(async (): Promise<BinaryModelProbeResult> => ({ status: 'ok' })),
    };

    const result = await probePrimaryModelUsability(
      { provider: 'claude-cli', model: 'primary-model-a' },
      adapters,
      { timeoutMs: 0 },
    );
    expect(result).toEqual({
      status: 'timeout',
      provider: 'claude-cli',
      model: 'primary-model-a',
    });
    expect(adapters.probeBinaryModel).not.toHaveBeenCalled();
  });

  it('returns timeout immediately when timeoutMs is negative', async () => {
    const adapters: PrimaryModelProbeAdapters = {
      probeApiModelAccess: vi.fn(async (): Promise<ApiModelAccessProbeResult> => ({ status: 'found' })),
    };

    const result = await probePrimaryModelUsability(
      { provider: 'openai-api', model: 'primary-model-a' },
      adapters,
      { timeoutMs: -5 },
    );
    expect(result).toEqual({
      status: 'timeout',
      provider: 'openai-api',
      model: 'primary-model-a',
    });
    expect(adapters.probeApiModelAccess).not.toHaveBeenCalled();
  });

  it('drops the timer callback after the probe promise resolves first', async () => {
    vi.useFakeTimers();
    try {
      const adapters: PrimaryModelProbeAdapters = {
        probeBinaryModel: vi.fn(async (): Promise<BinaryModelProbeResult> => ({ status: 'ok' })),
      };

      const probePromise = probePrimaryModelUsability(
        { provider: 'claude-cli', model: 'primary-model-a' },
        adapters,
        { timeoutMs: 100 },
      );

      // Drain microtasks: the adapter returns a synchronously-resolved promise,
      // so after a microtask flush the .then handler has marked the internal
      // state as settled before the 100ms timer fires.
      await vi.advanceTimersByTimeAsync(0);
      const settled = await probePromise;
      expect(settled).toMatchObject({ status: 'usable' });

      // Now advance past the 100ms deadline. The timer callback should fire
      // and observe that the probe already settled, exercising the early-return.
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops the probe resolve callback after the deadline fires first', async () => {
    vi.useFakeTimers();
    try {
      let lateResolve!: (r: BinaryModelProbeResult) => void;
      const adapters: PrimaryModelProbeAdapters = {
        probeBinaryModel: vi.fn(
          async (): Promise<BinaryModelProbeResult> =>
            new Promise((resolve) => {
              lateResolve = resolve;
            }),
        ),
      };

      const probePromise = probePrimaryModelUsability(
        { provider: 'claude-cli', model: 'primary-model-a' },
        adapters,
        { timeoutMs: 100 },
      );

      // Advance past the 100ms deadline — the internal state is settled as TIMEOUT.
      await vi.advanceTimersByTimeAsync(200);
      await expect(probePromise).resolves.toMatchObject({ status: 'timeout' });

      // Fire the adapter's late resolve AFTER the deadline — its .then resolve
      // callback should observe the internal state is already settled and return early.
      lateResolve({ status: 'ok' });
      await vi.advanceTimersByTimeAsync(0);
      expect(adapters.probeBinaryModel).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops the probe reject callback after the deadline fires first', async () => {
    vi.useFakeTimers();
    try {
      let lateReject!: (e: Error) => void;
      const adapters: PrimaryModelProbeAdapters = {
        probeBinaryModel: vi.fn(
          async (): Promise<BinaryModelProbeResult> =>
            new Promise((_resolve, reject) => {
              lateReject = reject;
            }),
        ),
      };

      const probePromise = probePrimaryModelUsability(
        { provider: 'claude-cli', model: 'primary-model-a' },
        adapters,
        { timeoutMs: 100 },
      );

      // Advance past the 100ms deadline — the internal state is settled as TIMEOUT.
      await vi.advanceTimersByTimeAsync(200);
      await expect(probePromise).resolves.toMatchObject({ status: 'timeout' });

      // Fire the adapter's late reject AFTER the deadline — its .catch reject
      // callback should observe the internal state is already settled and return early.
      lateReject(new Error('late binary failure'));
      await vi.advanceTimersByTimeAsync(0);
      expect(adapters.probeBinaryModel).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('primaryModelUsabilityRequiresAlert', () => {
    it('does not require an alert when the model is unconfigured', () => {
      const result: PrimaryModelUsabilityResult = {
        status: 'unknown',
        provider: 'claude-cli',
        model: null,
        reason: 'model-not-configured',
      };
      expect(primaryModelUsabilityRequiresAlert(result)).toBe(false);
    });

    it('does not require an alert for an unknown status caused by an unsupported provider', () => {
      const result: PrimaryModelUsabilityResult = {
        status: 'unknown',
        provider: 'mystery-provider',
        model: 'primary-model-a',
        reason: 'unsupported-provider',
      };
      expect(primaryModelUsabilityRequiresAlert(result)).toBe(false);
    });

    it('requires an alert for an unknown status carrying a non-suppressed reason', () => {
      const result: PrimaryModelUsabilityResult = {
        status: 'unknown',
        provider: 'claude-cli',
        model: 'primary-model-a',
        reason: 'probe-threw',
      };
      expect(primaryModelUsabilityRequiresAlert(result)).toBe(true);
    });

    it('requires an alert for an unknown status that has no reason at all', () => {
      const result: PrimaryModelUsabilityResult = {
        status: 'unknown',
        provider: 'openai-api',
        model: 'primary-model-a',
      };
      expect(primaryModelUsabilityRequiresAlert(result)).toBe(true);
    });

    it('does not require an alert when the result is usable', () => {
      const result: PrimaryModelUsabilityResult = {
        status: 'usable',
        provider: 'claude-cli',
        model: 'primary-model-a',
      };
      expect(primaryModelUsabilityRequiresAlert(result)).toBe(false);
    });

    it('requires an alert for a model-unavailable status', () => {
      const result: PrimaryModelUsabilityResult = {
        status: 'model-unavailable',
        provider: 'openai-api',
        model: 'primary-model-a',
      };
      expect(primaryModelUsabilityRequiresAlert(result)).toBe(true);
    });

    it('requires an alert for a credential-unavailable status', () => {
      const result: PrimaryModelUsabilityResult = {
        status: 'credential-unavailable',
        provider: 'anthropic-api',
        model: 'claude-sonnet-test',
      };
      expect(primaryModelUsabilityRequiresAlert(result)).toBe(true);
    });

    it('requires an alert for a provider-unavailable status', () => {
      const result: PrimaryModelUsabilityResult = {
        status: 'provider-unavailable',
        provider: 'claude-cli',
        model: 'primary-model-a',
      };
      expect(primaryModelUsabilityRequiresAlert(result)).toBe(true);
    });

    it('requires an alert for a timeout status', () => {
      const result: PrimaryModelUsabilityResult = {
        status: 'timeout',
        provider: 'openai-api',
        model: 'primary-model-a',
      };
      expect(primaryModelUsabilityRequiresAlert(result)).toBe(true);
    });
  });
});

describe('claude-cli default-model probing (fleet recovery-stall fix)', () => {
  // A claude-cli instance with no configured model previously short-circuited every
  // usability/recovery probe to unknown/model-not-configured — probePrimaryProviderRecovered
  // could then never return true, extending the fallback window forever on a healthy,
  // logged-in account (observed in production as a monotonically extending window). The CLI has a default
  // model; probe with it.
  it('probes claude-cli with a null model instead of short-circuiting', async () => {
    const probeBinaryModel = vi.fn(async (): Promise<BinaryModelProbeResult> => ({ status: 'ok' }));
    const result = await probePrimaryModelUsability(
      { provider: 'claude-cli', model: null },
      { probeBinaryModel },
    );
    expect(probeBinaryModel).toHaveBeenCalledWith({ provider: 'claude-cli', model: null });
    expect(result).toEqual({ status: 'usable', provider: 'claude-cli', model: null });
  });

  it('probes claude-cli with a blank model the same way (normalizes to null)', async () => {
    const probeBinaryModel = vi.fn(async (): Promise<BinaryModelProbeResult> => ({ status: 'credential_unavailable' }));
    const result = await probePrimaryModelUsability(
      { provider: 'claude-cli', model: '   ' },
      { probeBinaryModel },
    );
    expect(result).toMatchObject({ status: 'credential-unavailable', model: null });
  });

  it('short-circuits opencode-cli with a null model — no default-model probe', async () => {
    // opencode-cli is NOT in claude-cli's default-probe class: it derives the
    // child credential from the model prefix (buildChildEnv) with no usable
    // default, and config admission requires a model for it (both primary and
    // fallback — agent-config-validator). A null model is not-configured, and the
    // binary adapter is never invoked (probing it would only hit buildChildEnv's
    // credential-route throw).
    const probeBinaryModel = vi.fn(async (): Promise<BinaryModelProbeResult> => ({ status: 'ok' }));
    const result = await probePrimaryModelUsability(
      { provider: 'opencode-cli', model: null },
      { probeBinaryModel },
    );
    expect(result).toEqual({
      status: 'unknown',
      provider: 'opencode-cli',
      model: null,
      reason: 'model-not-configured',
    });
    expect(probeBinaryModel).not.toHaveBeenCalled();
  });

  it('still short-circuits providers with no default-model probe path', async () => {
    const probeBinaryModel = vi.fn(async (): Promise<BinaryModelProbeResult> => ({ status: 'ok' }));
    for (const provider of ['codex-cli', 'gemini-cli', 'opencode-cli'] as const) {
      await expect(
        probePrimaryModelUsability({ provider, model: null }, { probeBinaryModel }),
      ).resolves.toMatchObject({ status: 'unknown', reason: 'model-not-configured' });
    }
    expect(probeBinaryModel).not.toHaveBeenCalled();
  });

  it('alerts on a real failure even when the probed model was the CLI default (null)', () => {
    const result: PrimaryModelUsabilityResult = {
      status: 'credential-unavailable',
      provider: 'claude-cli',
      model: null,
    };
    expect(primaryModelUsabilityRequiresAlert(result)).toBe(true);
  });
});
