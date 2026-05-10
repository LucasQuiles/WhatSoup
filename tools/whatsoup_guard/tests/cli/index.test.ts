import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../src/cli/index.ts';

describe('runCli', () => {
  const dirs: string[] = [];

  function fixturePolicy(): { dir: string; path: string } {
    const dir = mkdtempSync(join(tmpdir(), 'wg-cli-index-'));
    dirs.push(dir);
    const path = join(dir, 'policy.yaml');
    writeFileSync(path, 'extends: development\n');
    return { dir, path };
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('prints pong and exits zero for ping', async () => {
    const out: string[] = [];

    const code = await runCli(['ping'], { write: (chunk) => out.push(chunk) });

    expect(code).toBe(0);
    expect(out.join('')).toBe('pong v1\n');
  });

  it('exits non-zero and prints usage for unknown commands', async () => {
    const out: string[] = [];

    const code = await runCli(['nothing-real'], { write: (chunk) => out.push(chunk) });

    expect(code).toBe(2);
    expect(out.join('')).toContain('unknown command: nothing-real');
    expect(out.join('')).toContain('usage: whatsoup-guard <ping|cycle|mute|status|simulate|watchdog>');
    expect(out.join('')).not.toContain('legacy usage');
  });

  it('exits non-zero and prints usage when no command is provided', async () => {
    const out: string[] = [];

    const code = await runCli([], { write: (chunk) => out.push(chunk) });

    expect(code).toBe(2);
    expect(out.join('')).toContain('unknown command: <none>');
    expect(out.join('')).toContain('usage: whatsoup-guard <ping|cycle|mute|status|simulate|watchdog>');
    expect(out.join('')).not.toContain('legacy usage');
  });

  it('cycle invokes an injected runner dependency and prints structured counts as JSON', async () => {
    const out: string[] = [];
    const policy = fixturePolicy();
    const runCycle = vi.fn(async () => ({
      driftCount: 1,
      probeErrorCount: 0,
      totalEventCount: 4,
      deliverySucceededCount: 1,
      deliveryFailedCount: 0,
      dedupSuppressedCount: 0,
      stormSuppressedCount: 0,
      baselineIntegrityFailCount: 0,
      selfSecretWidenedCount: 0,
      tokenAgingCount: 0,
      heartbeatCount: 1,
    }));

    const code = await runCli(['cycle', '--policy', policy.path, '--state-dir', join(policy.dir, 'state'), '--json'], {
      write: (chunk) => out.push(chunk),
      runCycle,
    });

    expect(code).toBe(1);
    expect(runCycle).toHaveBeenCalledOnce();
    expect(out.join('')).toContain('"drift_count":1');
    expect(out.join('')).toContain('"delivery_succeeded_count":1');
    expect(out.join('')).toContain('"baseline_integrity_fail_count":0');
  });

  it('cycle exits non-zero when self-protection events fired', async () => {
    const out: string[] = [];
    const policy = fixturePolicy();
    const runCycle = vi.fn(async () => ({
      driftCount: 0,
      probeErrorCount: 0,
      totalEventCount: 2,
      deliverySucceededCount: 0,
      deliveryFailedCount: 0,
      dedupSuppressedCount: 0,
      stormSuppressedCount: 0,
      baselineIntegrityFailCount: 0,
      selfSecretWidenedCount: 1,
      tokenAgingCount: 0,
      heartbeatCount: 1,
    }));

    const code = await runCli(['cycle', '--policy', policy.path, '--state-dir', join(policy.dir, 'state')], {
      write: (chunk) => out.push(chunk),
      runCycle,
    });

    expect(code).toBe(1);
    expect(out.join('')).toContain('self_secret_widened=1');
  });

  it('cycle uses the default runtime adapter when no runner dependency is injected', async () => {
    const out: string[] = [];
    const policy = fixturePolicy();
    const stateDir = join(policy.dir, 'state');

    const code = await runCli(['cycle', '--policy', policy.path, '--state-dir', stateDir], {
      write: (chunk) => out.push(chunk),
    });

    expect(code).toBe(0);
    expect(out.join('')).toContain('drifts=0');
    expect(out.join('')).not.toContain('runtime dependency missing');
    expect(existsSync(join(stateDir, 'state.sqlite')) || existsSync(join(stateDir, 'events.jsonl'))).toBe(true);
  });

  it('cycle runtime runs host-specific collectors with one heartbeat per CLI invocation', async () => {
    const out: string[] = [];
    const policy = fixturePolicy();
    const stateDir = join(policy.dir, 'state');
    writeFileSync(policy.path, [
      'extends: development',
      'inventory:',
      '  hosts:',
      '    - id: host-a',
      '      platform: linux',
      '      collectors: [fixture.alpha]',
      '    - id: host-b',
      '      platform: linux',
      '      collectors: [fixture.beta]',
      '  instances: []',
      '',
    ].join('\n'));

    const code = await runCli(['cycle', '--policy', policy.path, '--state-dir', stateDir], {
      write: (chunk) => out.push(chunk),
    });

    const events = readFileSync(join(stateDir, 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { kind: string; scope_id?: string; probe_id?: string });
    const probeErrors = events.filter((event) => event.kind === 'probe_error');
    const heartbeats = events.filter((event) => event.kind === 'heartbeat');

    expect(code).toBe(1);
    expect(probeErrors).toHaveLength(2);
    expect(probeErrors).toEqual([
      expect.objectContaining({ probe_id: 'fixture.alpha', scope_id: 'host-a' }),
      expect.objectContaining({ probe_id: 'fixture.beta', scope_id: 'host-b' }),
    ]);
    expect(probeErrors).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ probe_id: 'fixture.alpha', scope_id: 'host-b' }),
      expect.objectContaining({ probe_id: 'fixture.beta', scope_id: 'host-a' }),
    ]));
    expect(heartbeats).toHaveLength(1);
  });

  it('cycle runtime creates and reuses a state-local baseline HMAC key', async () => {
    const out: string[] = [];
    const policy = fixturePolicy();
    const stateDir = join(policy.dir, 'state');
    const keyPath = join(stateDir, 'baseline-hmac.key');

    await runCli(['cycle', '--policy', policy.path, '--state-dir', stateDir], {
      write: (chunk) => out.push(chunk),
    });
    const firstKey = readFileSync(keyPath);

    await runCli(['cycle', '--policy', policy.path, '--state-dir', stateDir], {
      write: (chunk) => out.push(chunk),
    });
    const secondKey = readFileSync(keyPath);

    expect(firstKey.length).toBeGreaterThan(0);
    expect(secondKey).toEqual(firstKey);
    expect(statSync(keyPath).mode & 0o777).toBe(0o400);
    expect(firstKey.toString('utf8')).not.toContain('whatsoup-guard-cycle-baseline-hmac-key-v1');
  });

  it('forwards cycle arguments to the cycle handler', async () => {
    const seen: string[][] = [];

    const code = await runCli(['cycle', '--state-dir', 'tmp-state'], {
      write: () => {},
      cycleCommand: async (args) => {
        seen.push(args);
        return 7;
      },
    });

    expect(code).toBe(7);
    expect(seen).toEqual([['--state-dir', 'tmp-state']]);
  });
});
