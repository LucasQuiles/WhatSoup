import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  probePrimaryModelUsability,
  type BinaryModelProbeResult,
  type PrimaryModelProbeAdapters,
  type PrimaryModelProbeStage,
} from '../../../src/runtimes/agent/providers/primary-model-usability.ts';
import { createPrimaryModelProbeAdapters } from '../../../src/runtimes/agent/providers/primary-model-usability-adapters.ts';
import { ProviderExecutionGate } from '../../../src/runtimes/agent/provider-execution-gate.ts';

// #3557: a cancelled usability probe must record why it was cancelled (the
// usability deadline or the caller) and which probe stage was in flight, so a
// stalled credential heal, gate wait, child run, or API request is
// distinguishable from /health primaryModelUsability.reason and the diagnostic
// finding's data alone.

/** A binary command stub that only settles once its signal aborts. */
function hangingBinaryCommand() {
  return vi.fn((
    _binary: string,
    _args: string[],
    _env: NodeJS.ProcessEnv,
    options?: { signal?: AbortSignal },
  ) => new Promise<{ status: 'failed'; output: string }>((resolve) => {
    options?.signal?.addEventListener('abort', () => resolve({ status: 'failed', output: '' }), { once: true });
  }));
}

/** A fetch stub that only settles (as AbortError) once its request aborts. */
function hangingFetch() {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('request aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }));
}

describe('primary usability timeout cause (#3557)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('adapter stage reporting', () => {
    it('reports prepare, credential-heal, prepare, child-run for a claude-cli probe', async () => {
      const stages: PrimaryModelProbeStage[] = [];
      const adapters = createPrimaryModelProbeAdapters(undefined, {
        getProviderBinary: vi.fn(() => 'claude'),
        ensureClaudeFileStoreCredential: vi.fn(() => ({ outcome: 'healed' as const })),
        probeBinaryCommand: vi.fn(async () => ({ status: 'ok' as const, output: 'OK' })),
      });

      await expect(
        adapters.probeBinaryModel?.(
          { provider: 'claude-cli', model: 'configured-primary' },
          undefined,
          (stage) => stages.push(stage),
        ),
      ).resolves.toEqual({ status: 'ok' });
      expect(stages).toEqual(['prepare', 'credential-heal', 'prepare', 'child-run']);
    });

    it('reports prepare, gate-wait, child-run for a gated opencode-cli probe', async () => {
      const stages: PrimaryModelProbeStage[] = [];
      const adapters = createPrimaryModelProbeAdapters(undefined, {
        getProviderBinary: vi.fn(() => 'opencode'),
        probeBinaryCommand: vi.fn(async () => ({ status: 'ok' as const, output: 'OK' })),
        providerExecutionGate: new ProviderExecutionGate(),
      });

      await expect(
        adapters.probeBinaryModel?.(
          { provider: 'opencode-cli', model: 'openai/some-model' },
          undefined,
          (stage) => stages.push(stage),
        ),
      ).resolves.toEqual({ status: 'ok' });
      expect(stages).toEqual(['prepare', 'gate-wait', 'child-run']);
    });

    it('reports prepare, api-request for an API generation probe', async () => {
      const stages: PrimaryModelProbeStage[] = [];
      const adapters = createPrimaryModelProbeAdapters(undefined, {
        fetch: vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
        resolveApiKey: vi.fn(() => 'sk-test-secret'),
      });

      await expect(
        adapters.probeApiModelAccess?.(
          { provider: 'openai-api', model: 'api-live-model' },
          undefined,
          (stage) => stages.push(stage),
        ),
      ).resolves.toEqual({ status: 'found' });
      expect(stages).toEqual(['prepare', 'api-request']);
    });
  });

  describe('deadline cause', () => {
    it('names child-run when the deadline fires while the claude-cli child runs', async () => {
      vi.useFakeTimers();
      const adapters = createPrimaryModelProbeAdapters(undefined, {
        getProviderBinary: vi.fn(() => 'claude'),
        ensureClaudeFileStoreCredential: vi.fn(() => ({ outcome: 'healed' as const })),
        probeBinaryCommand: hangingBinaryCommand(),
      });

      const probe = probePrimaryModelUsability(
        { provider: 'claude-cli', model: 'configured-primary' },
        adapters,
        { timeoutMs: 100 },
      );
      await vi.advanceTimersByTimeAsync(100);

      await expect(probe).resolves.toEqual({
        status: 'timeout',
        provider: 'claude-cli',
        model: 'configured-primary',
        reason: 'deadline-child-run',
      });
    });

    it('names credential-heal when a synchronous heal consumed the whole budget', async () => {
      // The heal blocks the event loop, so the deadline timer can only run after
      // the child has already been started. The deadline must still be charged
      // to the heal, not to the child that began after the deadline passed.
      // Only the monotonic clock advances during the heal: attribution read
      // from the wall clock, or from the stage current when the timer callback
      // runs, would both report child-run instead.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let monotonicMs = 1_000;
      const now = vi.spyOn(performance, 'now').mockImplementation(() => monotonicMs);
      try {
        const probeBinaryCommand = hangingBinaryCommand();
        const adapters = createPrimaryModelProbeAdapters(undefined, {
          getProviderBinary: vi.fn(() => 'claude'),
          ensureClaudeFileStoreCredential: vi.fn(() => {
            monotonicMs += 250;
            return { outcome: 'healed' as const };
          }),
          probeBinaryCommand,
        });

        const probe = probePrimaryModelUsability(
          { provider: 'claude-cli', model: 'configured-primary' },
          adapters,
          { timeoutMs: 100 },
        );
        await vi.advanceTimersByTimeAsync(100);

        expect(probeBinaryCommand).toHaveBeenCalledTimes(1);
        await expect(probe).resolves.toMatchObject({
          status: 'timeout',
          reason: 'deadline-credential-heal',
        });
      } finally {
        now.mockRestore();
      }
    });

    it('names gate-wait when the deadline fires while an opencode probe is queued', async () => {
      vi.useFakeTimers();
      const gate = new ProviderExecutionGate();
      const activeTurn = await gate.acquire();
      const probeBinaryCommand = vi.fn(async () => ({ status: 'ok' as const, output: 'OK' }));
      const adapters = createPrimaryModelProbeAdapters(undefined, {
        getProviderBinary: vi.fn(() => 'opencode'),
        probeBinaryCommand,
        providerExecutionGate: gate,
      });

      const probe = probePrimaryModelUsability(
        { provider: 'opencode-cli', model: 'openai/some-model' },
        adapters,
        { timeoutMs: 100 },
      );
      await vi.advanceTimersByTimeAsync(100);

      await expect(probe).resolves.toMatchObject({ status: 'timeout', reason: 'deadline-gate-wait' });
      expect(probeBinaryCommand).not.toHaveBeenCalled();
      activeTurn.release();
    });

    it('names api-request when the deadline fires during the API generation request', async () => {
      vi.useFakeTimers();
      const adapters = createPrimaryModelProbeAdapters(undefined, {
        fetch: hangingFetch() as unknown as typeof fetch,
        resolveApiKey: vi.fn(() => 'sk-test-secret'),
      });

      const probe = probePrimaryModelUsability(
        { provider: 'openai-api', model: 'api-live-model' },
        adapters,
        { timeoutMs: 100 },
      );
      await vi.advanceTimersByTimeAsync(100);

      await expect(probe).resolves.toEqual({
        status: 'timeout',
        provider: 'openai-api',
        model: 'api-live-model',
        reason: 'deadline-api-request',
      });
    });

    it('marks the stage unreported when an adapter never reports one', async () => {
      vi.useFakeTimers();
      const adapters: PrimaryModelProbeAdapters = {
        probeBinaryModel: vi.fn(async (_target, signal): Promise<BinaryModelProbeResult> =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
          })),
      };

      const probe = probePrimaryModelUsability(
        { provider: 'claude-cli', model: 'configured-primary' },
        adapters,
        { timeoutMs: 100 },
      );
      await vi.advanceTimersByTimeAsync(100);

      await expect(probe).resolves.toMatchObject({ status: 'timeout', reason: 'deadline-unreported' });
    });
  });

  describe('caller-abort cause', () => {
    it('names child-run when the caller aborts while the child runs', async () => {
      const controller = new AbortController();
      const probeBinaryCommand = hangingBinaryCommand();
      const adapters = createPrimaryModelProbeAdapters(undefined, {
        getProviderBinary: vi.fn(() => 'claude'),
        ensureClaudeFileStoreCredential: vi.fn(() => ({ outcome: 'healed' as const })),
        probeBinaryCommand,
      });

      const probe = probePrimaryModelUsability(
        { provider: 'claude-cli', model: 'configured-primary' },
        adapters,
        { signal: controller.signal },
      );
      await vi.waitFor(() => expect(probeBinaryCommand).toHaveBeenCalledTimes(1));
      controller.abort();

      await expect(probe).resolves.toEqual({
        status: 'timeout',
        provider: 'claude-cli',
        model: 'configured-primary',
        reason: 'caller-abort-child-run',
      });
    });

    it('names api-request when the caller aborts during the API generation request', async () => {
      const controller = new AbortController();
      const fetchImpl = hangingFetch();
      const adapters = createPrimaryModelProbeAdapters(undefined, {
        fetch: fetchImpl as unknown as typeof fetch,
        resolveApiKey: vi.fn(() => 'sk-test-secret'),
      });

      const probe = probePrimaryModelUsability(
        { provider: 'anthropic-api', model: 'api-live-model' },
        adapters,
        { signal: controller.signal },
      );
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
      controller.abort();

      await expect(probe).resolves.toMatchObject({ status: 'timeout', reason: 'caller-abort-api-request' });
    });

    it('keeps the first cause when the caller aborts after the deadline already fired', async () => {
      vi.useFakeTimers();
      const controller = new AbortController();
      let acknowledge!: () => void;
      const adapters: PrimaryModelProbeAdapters = {
        probeBinaryModel: vi.fn(async (_target, signal, onStage): Promise<BinaryModelProbeResult> => {
          onStage?.('child-run');
          return new Promise((resolve) => {
            signal?.addEventListener('abort', () => {
              acknowledge = () => resolve({ status: 'ok' });
            }, { once: true });
          });
        }),
      };

      const probe = probePrimaryModelUsability(
        { provider: 'claude-cli', model: 'configured-primary' },
        adapters,
        { timeoutMs: 100, signal: controller.signal },
      );
      await vi.advanceTimersByTimeAsync(100);
      controller.abort();
      acknowledge();

      await expect(probe).resolves.toMatchObject({ status: 'timeout', reason: 'deadline-child-run' });
    });

    it('ignores stages an adapter reports after cancellation', async () => {
      const controller = new AbortController();
      const adapters: PrimaryModelProbeAdapters = {
        probeBinaryModel: vi.fn(async (_target, signal, onStage): Promise<BinaryModelProbeResult> => {
          onStage?.('gate-wait');
          return new Promise((resolve) => {
            signal?.addEventListener('abort', () => {
              onStage?.('child-run');
              resolve({ status: 'timeout' });
            }, { once: true });
          });
        }),
      };

      const probe = probePrimaryModelUsability(
        { provider: 'claude-cli', model: 'configured-primary' },
        adapters,
        { signal: controller.signal },
      );
      await Promise.resolve();
      controller.abort();

      await expect(probe).resolves.toMatchObject({ status: 'timeout', reason: 'caller-abort-gate-wait' });
    });
  });

  describe('unchanged behaviour', () => {
    it('keeps a successful stage-reporting probe free of any reason', async () => {
      vi.useFakeTimers();
      const adapters = createPrimaryModelProbeAdapters(undefined, {
        getProviderBinary: vi.fn(() => 'claude'),
        ensureClaudeFileStoreCredential: vi.fn(() => ({ outcome: 'healed' as const })),
        probeBinaryCommand: vi.fn(async () => ({ status: 'ok' as const, output: 'OK' })),
      });

      const probe = probePrimaryModelUsability(
        { provider: 'claude-cli', model: 'configured-primary' },
        adapters,
        { timeoutMs: 100 },
      );
      await vi.advanceTimersByTimeAsync(0);
      await expect(probe).resolves.toEqual({
        status: 'usable',
        provider: 'claude-cli',
        model: 'configured-primary',
      });
      await vi.runAllTimersAsync();
    });

    it('keeps a provider-reported timeout (no cancellation) without a reason', async () => {
      const adapters: PrimaryModelProbeAdapters = {
        probeApiModelAccess: vi.fn(async (_target, _signal, onStage) => {
          onStage?.('api-request');
          return { status: 'timeout' as const };
        }),
      };

      await expect(
        probePrimaryModelUsability({ provider: 'openai-api', model: 'api-live-model' }, adapters),
      ).resolves.toEqual({ status: 'timeout', provider: 'openai-api', model: 'api-live-model' });
    });

    it('still starts no adapter for a pre-aborted caller and records that cause', async () => {
      const controller = new AbortController();
      controller.abort();
      const probeBinaryModel = vi.fn(async (): Promise<BinaryModelProbeResult> => ({ status: 'ok' }));

      await expect(
        probePrimaryModelUsability(
          { provider: 'claude-cli', model: 'configured-primary' },
          { probeBinaryModel },
          { signal: controller.signal, timeoutMs: 0 },
        ),
      ).resolves.toMatchObject({ status: 'timeout', reason: 'caller-pre-aborted' });
      expect(probeBinaryModel).not.toHaveBeenCalled();
    });
  });
});
