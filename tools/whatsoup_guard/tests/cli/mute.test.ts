import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '../../src/cli/index.ts';
import { openDatabase } from '../../src/store/connection.ts';
import { EventStore } from '../../src/store/events.ts';

const NOW = new Date('2026-05-08T10:00:00.000Z');
const dirs: string[] = [];
const DEVELOPMENT_POLICY_PATH = fileURLToPath(new URL('../../src/policy/profiles/development.yaml', import.meta.url));
const PRODUCTION_POLICY_PATH = fileURLToPath(new URL('../../src/policy/profiles/production.yaml', import.meta.url));

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function invoke(args: string[], now: Date = NOW): Promise<{ code: number; output: string }> {
  const out: string[] = [];
  const code = await runCli(args, {
    write: (chunk) => out.push(chunk),
    now: () => now,
  });

  return { code, output: out.join('') };
}

describe('mute/status/simulate CLI commands', () => {
  it('mute rejects empty reason', async () => {
    const result = await invoke([
      'mute',
      '--state-dir',
      tempDir('wg-cli-mute-'),
      '--host',
      'scope-a',
      '--domain',
      'exposure',
      '--duration',
      '15m',
      '--reason',
      '',
    ]);

    expect(result.code).toBe(2);
    expect(result.output).toContain('reason');
    expect(result.output).toContain('usage: whatsoup-guard mute');
  });

  it('mute missing state directory reports --state-dir, not stateDir', async () => {
    const result = await invoke([
      'mute',
      '--host',
      'scope-a',
      '--domain',
      'exposure',
      '--duration',
      '15m',
      '--reason',
      'planned change',
    ]);

    expect(result.code).toBe(2);
    expect(result.output).toContain('--state-dir');
    expect(result.output).not.toContain('stateDir');
  });

  it('mute creates and status lists an active mute using deterministic now', async () => {
    const stateDir = tempDir('wg-cli-mute-');

    const created = await invoke([
      'mute',
      '--state-dir',
      stateDir,
      '--host',
      'scope-a',
      '--domain',
      'exposure',
      '--duration',
      '30m',
      '--reason',
      'planned change',
    ]);
    const status = await invoke(['status', '--state-dir', stateDir]);

    expect(created.code).toBe(0);
    expect(created.output).toBe('mute id=1 host=scope-a domain=exposure expires_at=2026-05-08T10:30:00.000Z\n');
    expect(status.code).toBe(0);
    expect(status.output).toBe('host\tdomain\texpires_at\treason\nscope-a\texposure\t2026-05-08T10:30:00.000Z\tplanned change\n');
  });

  it('mute writes a mute_set audit event to the ledger', async () => {
    const stateDir = tempDir('wg-cli-mute-audit-');

    const created = await invoke([
      'mute',
      '--state-dir',
      stateDir,
      '--host',
      'scope-a',
      '--domain',
      'change',
      '--duration',
      '30m',
      '--reason',
      'planned change',
    ]);

    const db = openDatabase(join(stateDir, 'state.sqlite'));
    try {
      const events = new EventStore(db, join(stateDir, 'events.jsonl'));
      expect(created.code).toBe(0);
      expect(events.queryByKind('mute_set')[0]).toMatchObject({
        domain: 'change',
        scope_id: 'scope-a',
        payload: expect.objectContaining({
          host: 'scope-a',
          domain: 'change',
          reason: 'planned change',
          created_by: 'cli',
        }),
      });
    } finally {
      db.close();
    }
  });

  it('status prints no active mutes for empty state', async () => {
    const result = await invoke(['status', '--state-dir', tempDir('wg-cli-status-')]);

    expect(result.code).toBe(0);
    expect(result.output).toBe('no active mutes\n');
  });

  it('invalid duration returns nonzero and mentions duration', async () => {
    const result = await invoke([
      'mute',
      '--state-dir',
      tempDir('wg-cli-mute-'),
      '--host',
      'scope-a',
      '--domain',
      'exposure',
      '--duration',
      '0m',
      '--reason',
      'planned change',
    ]);

    expect(result.code).toBe(2);
    expect(result.output).toMatch(/duration/i);
  });

  it('mute --policy allows a 72h duration under the development profile (default_max_duration: 72h)', async () => {
    const stateDir = tempDir('wg-cli-mute-policy-');

    const result = await invoke([
      'mute',
      '--state-dir',
      stateDir,
      '--host',
      'scope-a',
      '--domain',
      'exposure',
      '--duration',
      '72h',
      '--reason',
      'owner-requested demotion',
      '--policy',
      DEVELOPMENT_POLICY_PATH,
    ]);

    expect(result.code).toBe(0);
    expect(result.output).toContain('mute id=1');
    const status = await invoke(['status', '--state-dir', stateDir]);
    expect(status.output).toContain('scope-a');
  });

  it('mute --policy rejects a 72h duration under the production profile (default_max_duration: 8h) with a truthful error, not a silent clamp', async () => {
    const stateDir = tempDir('wg-cli-mute-policy-');

    const result = await invoke([
      'mute',
      '--state-dir',
      stateDir,
      '--host',
      'scope-a',
      '--domain',
      'exposure',
      '--duration',
      '72h',
      '--reason',
      'owner-requested demotion',
      '--policy',
      PRODUCTION_POLICY_PATH,
    ]);

    expect(result.code).toBe(1);
    expect(result.output).toMatch(/maximum/i);
    expect(result.output).not.toContain('mute id=');
    const status = await invoke(['status', '--state-dir', stateDir]);
    expect(status.output).toBe('no active mutes\n');
  });

  it('mute without --policy keeps the pre-existing 24h hard cap (backward compatible default)', async () => {
    const result = await invoke([
      'mute',
      '--state-dir',
      tempDir('wg-cli-mute-policy-'),
      '--host',
      'scope-a',
      '--domain',
      'exposure',
      '--duration',
      '72h',
      '--reason',
      'no policy supplied',
    ]);

    expect(result.code).toBe(1);
    expect(result.output).toMatch(/maximum/i);
  });

  it('mute --policy rejects an unreadable policy path with a truthful error, not a silent fallback', async () => {
    const result = await invoke([
      'mute',
      '--state-dir',
      tempDir('wg-cli-mute-policy-'),
      '--host',
      'scope-a',
      '--domain',
      'exposure',
      '--duration',
      '1h',
      '--reason',
      'planned change',
      '--policy',
      join(tempDir('wg-cli-mute-policy-missing-'), 'does-not-exist.yaml'),
    ]);

    expect(result.code).toBe(1);
    expect(result.output).toContain('mute:');
  });

  it('simulate runs a fixture JSON file and prints drift, probe error, and total counts', async () => {
    const dir = tempDir('wg-cli-simulate-');
    const fixture = join(dir, 'fixture.json');
    writeFileSync(fixture, JSON.stringify({
      baselines: { 'probe-a/scope-a': { enabled: true } },
      observations: { 'probe-a/scope-a': { enabled: false } },
    }));

    const result = await invoke([
      'simulate',
      '--state-dir',
      join(dir, 'state'),
      '--fixture',
      fixture,
      '--now',
      NOW.toISOString(),
    ]);

    expect(result.code).toBe(0);
    expect(result.output).toBe('drifts=1 probe_errors=0 total=2\n');
  });

  it('simulate --scenario runs the named scenario and labels the output', async () => {
    const dir = tempDir('wg-cli-simulate-');
    const fixture = join(dir, 'fixture.json');
    writeFileSync(fixture, JSON.stringify({
      baselines: { 'probe-a/scope-a': { enabled: true } },
      observations: { 'probe-a/scope-a': { enabled: false } },
    }));

    const result = await invoke([
      'simulate',
      '--state-dir',
      join(dir, 'state'),
      '--fixture',
      fixture,
      '--scenario',
      'muted-drift',
      '--now',
      NOW.toISOString(),
    ]);

    expect(result.code).toBe(0);
    expect(result.output).toBe('scenario=muted-drift drifts=0 probe_errors=0 total=2\n');
  });

  it('simulate rejects missing fixture or state-dir usage', async () => {
    const dir = tempDir('wg-cli-simulate-');
    const fixture = join(dir, 'fixture.json');
    writeFileSync(fixture, JSON.stringify({ baselines: {}, observations: {} }));

    for (const args of [
      ['simulate', '--state-dir', join(dir, 'state')],
      ['simulate', '--fixture', fixture],
    ]) {
      const result = await invoke(args);

      expect(result.code).toBe(2);
      expect(result.output).toContain('usage: whatsoup-guard simulate');
    }
  });

  it('simulate missing state directory reports --state-dir, not stateDir', async () => {
    const dir = tempDir('wg-cli-simulate-');
    const fixture = join(dir, 'fixture.json');
    writeFileSync(fixture, JSON.stringify({ baselines: {}, observations: {} }));

    const result = await invoke(['simulate', '--fixture', fixture]);

    expect(result.code).toBe(2);
    expect(result.output).toContain('--state-dir');
    expect(result.output).not.toContain('stateDir');
  });

  it('unmute is not a reachable stub command', async () => {
    const result = await invoke(['unmute']);

    expect(result.code).toBe(2);
    expect(result.output).toContain('unknown command: unmute');
    expect(result.output).toContain('usage: whatsoup-guard <ping|cycle|mute|status|simulate|watchdog>');
  });
});
