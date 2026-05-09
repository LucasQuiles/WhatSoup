import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSimulator } from '../../src/simulator.ts';

const NOW = '2026-05-08T10:00:00.000Z';
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stateDir(): string {
  const parent = mkdtempSync(join(tmpdir(), 'wg-simulator-'));
  dirs.push(parent);
  return join(parent, 'state');
}

describe('runSimulator', () => {
  it('reports one drift for a changed fixture field', async () => {
    const result = await runSimulator({
      stateDir: stateDir(),
      now: NOW,
      fixture: {
        baselines: { 'probe-a/scope-a': { enabled: true } },
        observations: { 'probe-a/scope-a': { enabled: false } },
      },
    });

    expect(result).toMatchObject({ drifts: 1, probeErrors: 0, totalEvents: 2 });
  });

  it('reports no events when observed fields equal the baseline', async () => {
    const result = await runSimulator({
      stateDir: stateDir(),
      now: NOW,
      fixture: {
        baselines: { 'probe-a/scope-a': { enabled: true } },
        observations: { 'probe-a/scope-a': { enabled: true } },
      },
    });

    expect(result).toMatchObject({ drifts: 0, probeErrors: 0, totalEvents: 1 });
  });

  it('accepts valid ISO timestamps without millisecond precision', async () => {
    const result = await runSimulator({
      stateDir: stateDir(),
      now: '2026-05-08T10:00:00Z',
      fixture: {
        baselines: { 'probe-a/scope-a': { enabled: true } },
        observations: { 'probe-a/scope-a': { enabled: false } },
      },
    });

    expect(result).toMatchObject({ drifts: 1, probeErrors: 0, totalEvents: 2 });
  });

  it('reports a probe error instead of drift when the cross-product has a missing observation', async () => {
    const result = await runSimulator({
      stateDir: stateDir(),
      now: NOW,
      fixture: {
        baselines: {
          'probe-a/scope-a': { value: 1 },
          'probe-a/scope-b': { value: 1 },
          'probe-b/scope-a': { value: 1 },
          'probe-b/scope-b': { value: 1 },
        },
        observations: {
          'probe-a/scope-a': { value: 1 },
          'probe-b/scope-b': { value: 1 },
        },
      },
    });

    expect(result).toMatchObject({ drifts: 0, probeErrors: 2, totalEvents: 3 });
  });

  it.each([
    ['clean', ['heartbeat'], { drifts: 0, heartbeatCount: 1 }],
    ['drift', ['drift'], { drifts: 1 }],
    ['muted-drift', ['drift_muted'], { drifts: 0 }],
    ['dedup', ['drift_dedup'], { dedupSuppressedCount: 1 }],
    ['crit-storm', ['drift_dedup'], { stormSuppressedCount: 1 }],
    ['alert-fallthrough', ['alert_delivery_failed', 'alert_delivery_succeeded'], { deliveryFailedCount: 1, deliverySucceededCount: 1 }],
    ['watchdog-heartbeat', ['heartbeat'], { heartbeatCount: 1 }],
    ['transport-broken', ['alert_delivery_failed_all'], { deliveryFailedCount: 2 }],
    ['self-secret-widened', ['self_secret_widened'], { selfSecretWidenedCount: 1 }],
  ] as const)('proves simulator scenario %s', async (scenario, eventKinds, expected) => {
    const result = await runSimulator({
      stateDir: stateDir(),
      scenario,
      now: NOW,
      fixture: {
        baselines: { 'probe-a/scope-a': { enabled: true } },
        observations: { 'probe-a/scope-a': { enabled: scenario === 'clean' || scenario === 'watchdog-heartbeat' } },
      },
    });

    expect(result).toMatchObject(expected);
    for (const kind of eventKinds) {
      expect(result.eventKinds).toContain(kind);
    }
  });

  it('proves severity escalation breaks dedup over three cycles', async () => {
    const result = await runSimulator({
      stateDir: stateDir(),
      scenario: 'dedup-escalation',
      now: NOW,
      fixture: {
        baselines: { 'probe-a/scope-a': { enabled: true } },
        observations: { 'probe-a/scope-a': { enabled: false } },
      },
    });

    expect(result).toMatchObject({
      drifts: 1,
      dedupSuppressedCount: 0,
      deliverySucceededCount: 1,
      heartbeatCount: 1,
    });
    expect(result.eventKinds).toContain('drift_dedup');
    expect(result.eventKinds).toContain('alert_delivery_succeeded');
  });

  it('rejects fixture keys without exactly one slash before trusting state', async () => {
    const dir = stateDir();

    await expect(runSimulator({
      stateDir: dir,
      now: NOW,
      fixture: {
        baselines: { 'probe-a/scope-a/extra': { enabled: true } },
        observations: { 'probe-a/scope-a': { enabled: false } },
      },
    })).rejects.toThrow('fixture key must have exactly one "/"');
    expect(existsSync(dir)).toBe(false);
  });

  it('rejects invalid now timestamps', async () => {
    await expect(runSimulator({
      stateDir: stateDir(),
      now: 'not-a-timestamp',
      fixture: {
        baselines: { 'probe-a/scope-a': { enabled: true } },
        observations: { 'probe-a/scope-a': { enabled: false } },
      },
    })).rejects.toThrow('simulator now must be a valid ISO timestamp');
  });

  it('rejects parseable non-ISO timestamps', async () => {
    await expect(runSimulator({
      stateDir: stateDir(),
      now: 'May 8, 2026 10:00 UTC',
      fixture: {
        baselines: { 'probe-a/scope-a': { enabled: true } },
        observations: { 'probe-a/scope-a': { enabled: false } },
      },
    })).rejects.toThrow('simulator now must be a valid ISO timestamp');
  });
});
