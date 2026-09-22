import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetModelCatalogueCacheForTest,
  resolveModelCatalogue,
} from '../../../src/runtimes/agent/model-catalogue-resolver.ts';

beforeEach(__resetModelCatalogueCacheForTest);

describe.each([
  { provider: 'opencode-cli', dependency: 'listFn' },
  { provider: 'codex-cli', dependency: 'codexFn' },
] as const)('$provider request sharing and retry', ({ provider, dependency }) => {
  const resolve = (probe: ReturnType<typeof vi.fn>, nowMs: number, binary = '/test/bin/agent') =>
    resolveModelCatalogue(provider, binary, { nowMs, [dependency]: probe });

  it('shares one pending command between simultaneous renders', async () => {
    let finish!: (result: { status: 'ok'; ids: string[] }) => void;
    const probe = vi.fn(() => new Promise<{ status: 'ok'; ids: string[] }>((done) => { finish = done; }));
    const first = resolve(probe, 100_000);
    const second = resolve(probe, 100_001);
    await Promise.resolve();
    expect(probe).toHaveBeenCalledTimes(1);
    finish({ status: 'ok', ids: ['vendor/model'] });
    const results = await Promise.all([first, second]);
    expect(results[0]).toMatchObject({ status: 'ok', ids: ['vendor/model'], asOfLabel: 'just now' });
    expect(results[1]).toStrictEqual(results[0]);
  });

  it('retains a failed probe reason for one second, then retries', async () => {
    const probe = vi.fn()
      .mockResolvedValueOnce({ status: 'unavailable', reason: 'timeout' })
      .mockResolvedValueOnce({ status: 'ok', ids: ['vendor/recovered'] });
    const failed = { status: 'unavailable', reason: { kind: 'timeout' }, asOfLabel: 'just now' };
    expect(await resolve(probe, 100_000)).toStrictEqual(failed);
    expect(await resolve(probe, 100_999)).toStrictEqual(failed);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(await resolve(probe, 101_000)).toMatchObject({ status: 'ok', ids: ['vendor/recovered'] });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('clears a rejected pending request and allows a later retry', async () => {
    const probe = vi.fn()
      .mockRejectedValueOnce(new Error('synthetic probe rejection'))
      .mockResolvedValueOnce({ status: 'ok', ids: ['vendor/recovered'] });
    const failed = { status: 'unavailable', reason: { kind: 'probe-failed' }, asOfLabel: 'just now' };
    await expect(Promise.all([resolve(probe, 100_000), resolve(probe, 100_000)]))
      .resolves.toStrictEqual([failed, failed]);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(await resolve(probe, 101_000)).toMatchObject({ status: 'ok', ids: ['vendor/recovered'] });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('preserves the successful capture age while backing off failed refreshes', async () => {
    const probe = vi.fn()
      .mockResolvedValueOnce({ status: 'ok', ids: ['vendor/original'] })
      .mockResolvedValue({ status: 'unavailable', reason: 'timeout' });
    await resolve(probe, 100_000);
    expect(await resolve(probe, 220_000)).toMatchObject({ status: 'ok', ids: ['vendor/original'], asOfLabel: '2m ago' });
    expect(await resolve(probe, 220_999)).toMatchObject({ status: 'ok', ids: ['vendor/original'], asOfLabel: '2m ago' });
    expect(probe).toHaveBeenCalledTimes(2);
    expect(await resolve(probe, 280_000)).toMatchObject({ status: 'ok', ids: ['vendor/original'], asOfLabel: '3m ago' });
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('keeps failure backoff separate for different binaries', async () => {
    const probe = vi.fn().mockResolvedValue({ status: 'unavailable', reason: 'empty' });
    const results = await Promise.all([
      resolve(probe, 100_000, '/test/bin/one'),
      resolve(probe, 100_000, '/test/bin/two'),
    ]);
    expect(results).toStrictEqual([
      { status: 'unavailable', reason: { kind: 'empty' }, asOfLabel: 'just now' },
      { status: 'unavailable', reason: { kind: 'empty' }, asOfLabel: 'just now' },
    ]);
    expect(probe.mock.calls).toStrictEqual([['/test/bin/one'], ['/test/bin/two']]);
  });
});
