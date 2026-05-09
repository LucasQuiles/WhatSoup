import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cycleCommand } from '../../src/cli/cycle.ts';
import { openDatabase } from '../../src/store/connection.ts';
import { EventStore } from '../../src/store/events.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wg-cycle-'));
  dirs.push(dir);
  return dir;
}

function fixturePolicy(dir: string): string {
  const path = join(dir, 'policy.yaml');
  writeFileSync(path, 'extends: development\n');
  return path;
}

function resultFixture() {
  return {
    driftCount: 0,
    probeErrorCount: 0,
    totalEventCount: 1,
    deliverySucceededCount: 0,
    deliveryFailedCount: 0,
    dedupSuppressedCount: 0,
    stormSuppressedCount: 0,
    baselineIntegrityFailCount: 0,
    selfSecretWidenedCount: 0,
    tokenAgingCount: 0,
    heartbeatCount: 1,
  };
}

describe('cycleCommand', () => {
  it('cycle --policy loads policy, builds runtime config, and runs', async () => {
    const dir = tempDir();
    const out: string[] = [];
    const runCycle = vi.fn(async (_input: unknown) => resultFixture());

    const code = await cycleCommand(['--policy', fixturePolicy(dir), '--state-dir', join(dir, 'state')], {
      write: (chunk) => out.push(chunk),
      runCycle,
    });

    expect(code).toBe(0);
    expect(runCycle).toHaveBeenCalledOnce();
    expect(runCycle.mock.calls[0]?.[0]).toMatchObject({
      policy: expect.objectContaining({
        extends: 'development',
      }),
      stateDir: join(dir, 'state'),
      runtimeConfig: {
        forbiddenMuteDomains: ['alerting'],
        metaAlertEnabled: false,
      },
    });
    expect(out.join('')).toContain('drifts=0');
    expect(out.join('')).toContain('baseline_integrity_fail=0');
    expect(out.join('')).toContain('token_aging=0');
    expect(out.join('')).toContain('self_secret_widened=0');
  });

  it.each([
    ['baseline integrity failures', { baselineIntegrityFailCount: 1, tokenAgingCount: 0, selfSecretWidenedCount: 0 }],
    ['token aging results', { baselineIntegrityFailCount: 0, tokenAgingCount: 1, selfSecretWidenedCount: 0 }],
    ['self-secret widening results', { baselineIntegrityFailCount: 0, tokenAgingCount: 0, selfSecretWidenedCount: 1 }],
  ] as const)('exits non-zero for %s after successful delivery', async (_name, counts) => {
    const dir = tempDir();
    const out: string[] = [];
    const runCycle = vi.fn(async () => ({
      ...resultFixture(),
      ...counts,
      totalEventCount: 2,
      deliverySucceededCount: 1,
    }));

    const code = await cycleCommand(['--policy', fixturePolicy(dir), '--state-dir', join(dir, 'state')], {
      write: (chunk) => out.push(chunk),
      runCycle,
    });

    expect(code).toBe(1);
    expect(out.join('')).toContain(`baseline_integrity_fail=${counts.baselineIntegrityFailCount}`);
    expect(out.join('')).toContain(`token_aging=${counts.tokenAgingCount}`);
    expect(out.join('')).toContain(`self_secret_widened=${counts.selfSecretWidenedCount}`);
    expect(out.join('')).toContain('delivery_failed=0');
  });

  it('prints JSON with stable snake_case self-protection count fields', async () => {
    const dir = tempDir();
    const out: string[] = [];
    const runCycle = vi.fn(async () => ({
      ...resultFixture(),
      baselineIntegrityFailCount: 1,
      tokenAgingCount: 2,
      selfSecretWidenedCount: 3,
    }));

    const code = await cycleCommand(['--policy', fixturePolicy(dir), '--state-dir', join(dir, 'state'), '--json'], {
      write: (chunk) => out.push(chunk),
      runCycle,
    });

    expect(code).toBe(1);
    expect(JSON.parse(out.join(''))).toMatchObject({
      baseline_integrity_fail_count: 1,
      token_aging_count: 2,
      self_secret_widened_count: 3,
    });
  });

  it('unit seam returns usage when the runCycle dependency is intentionally omitted', async () => {
    const dir = tempDir();
    const out: string[] = [];

    const code = await cycleCommand(['--policy', fixturePolicy(dir), '--state-dir', join(dir, 'state')], {
      write: (chunk) => out.push(chunk),
    });

    expect(code).toBe(2);
    expect(out.join('')).toContain('cycle: runtime dependency missing');
    expect(out.join('')).toContain('usage: whatsoup-guard cycle --policy');
  });

  it('cycle without --policy exits 2 with usage', async () => {
    const out: string[] = [];
    const runCycle = vi.fn(async () => resultFixture());

    const code = await cycleCommand([], {
      write: (chunk) => out.push(chunk),
      runCycle,
    });

    expect(code).toBe(2);
    expect(runCycle).not.toHaveBeenCalled();
    expect(out.join('')).toContain('missing required option: --policy');
    expect(out.join('')).not.toContain('missing required option: policy');
    expect(out.join('')).toContain('usage: whatsoup-guard cycle --policy');
  });

  it('cycle --policy without --state-dir reports the public flag name', async () => {
    const dir = tempDir();
    const out: string[] = [];
    const runCycle = vi.fn(async () => resultFixture());

    const code = await cycleCommand(['--policy', fixturePolicy(dir)], {
      write: (chunk) => out.push(chunk),
      runCycle,
    });

    expect(code).toBe(2);
    expect(runCycle).not.toHaveBeenCalled();
    expect(out.join('')).toContain('missing required option: --state-dir');
    expect(out.join('')).not.toContain('missing required option: stateDir');
  });

  it('returns non-zero and writes cycle_failed when runCycle throws', async () => {
    const dir = tempDir();
    const stateDir = join(dir, 'state');
    const out: string[] = [];
    const runCycle = vi.fn(async () => {
      throw new Error('sqlite append failed');
    });

    const code = await cycleCommand(['--policy', fixturePolicy(dir), '--state-dir', stateDir], {
      write: (chunk) => out.push(chunk),
      runCycle,
    });

    const db = openDatabase(join(stateDir, 'state.sqlite'));
    try {
      const events = new EventStore(db, join(stateDir, 'events.jsonl'));
      expect(code).toBe(1);
      expect(out.join('')).toContain('cycle: sqlite append failed');
      expect(events.queryByKind('cycle_failed')[0]).toMatchObject({
        kind: 'cycle_failed',
        domain: 'alerting',
        severity: 'crit',
        payload: expect.objectContaining({
          error: 'sqlite append failed',
        }),
      });
    } finally {
      db.close();
    }
  });
});
