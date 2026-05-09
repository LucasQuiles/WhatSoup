import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../src/cli/index.ts';
import { openDatabase } from '../../src/store/connection.ts';
import { EventStore } from '../../src/store/events.ts';

const NOW = new Date('2026-05-09T11:00:00.000Z');
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function fixturePolicy(dir: string): string {
  const path = join(dir, 'policy.yaml');
  writeFileSync(path, 'extends: development\n');
  return path;
}

function seedHeartbeat(stateDir: string): void {
  mkdirSync(stateDir, { recursive: true });
  const db = openDatabase(join(stateDir, 'state.sqlite'), { now: () => NOW });
  try {
    const events = new EventStore(db, join(stateDir, 'events.jsonl'));
    events.append({
      ts: '2026-05-09T10:30:00.000Z',
      kind: 'heartbeat',
      domain: 'alerting',
      severity: 'info',
      payload: { status: 'cycle_complete' },
      alerted_to: 'none',
    });
  } finally {
    db.close();
  }
}

describe('watchdog CLI command', () => {
  it('dispatches watchdog command and exits 0 on clean state', async () => {
    const dir = tempDir('wg-cli-watchdog-');
    const stateDir = join(dir, 'state');
    seedHeartbeat(stateDir);
    const out: string[] = [];

    const code = await runCli(['watchdog', '--state-dir', stateDir, '--policy', fixturePolicy(dir)], {
      write: (chunk) => out.push(chunk),
      now: () => NOW,
    });

    expect(code).toBe(0);
    expect(out.join('')).toContain('alerts=0');
  });

  it('exits 2 when policy is missing', async () => {
    const out: string[] = [];

    const code = await runCli(['watchdog'], {
      write: (chunk) => out.push(chunk),
      now: () => NOW,
    });

    expect(code).toBe(2);
    expect(out.join('')).toContain('missing required option: --policy');
    expect(out.join('')).not.toContain('missing required option: policy');
    expect(out.join('')).toContain('usage: whatsoup-guard watchdog');
  });

  it('watchdog --policy without --state-dir reports the public flag name', async () => {
    const dir = tempDir('wg-cli-watchdog-');
    const out: string[] = [];

    const code = await runCli(['watchdog', '--policy', fixturePolicy(dir)], {
      write: (chunk) => out.push(chunk),
      now: () => NOW,
    });

    expect(code).toBe(2);
    expect(out.join('')).toContain('missing required option: --state-dir');
    expect(out.join('')).not.toContain('missing required option: stateDir');
  });

  it('records and reports delivery failure when watchdog has findings but no meta-alert sinks', async () => {
    const dir = tempDir('wg-cli-watchdog-');
    const stateDir = join(dir, 'state');
    const out: string[] = [];

    const code = await runCli([
      'watchdog',
      '--state-dir',
      stateDir,
      '--policy',
      fixturePolicy(dir),
      '--now',
      NOW.toISOString(),
      '--threshold-hours',
      '7',
    ], {
      write: (chunk) => out.push(chunk),
      now: () => NOW,
      metaAlertSinks: [],
    });

    const db = openDatabase(join(stateDir, 'state.sqlite'), { now: () => NOW });
    try {
      const events = new EventStore(db, join(stateDir, 'events.jsonl'));
      expect(code).toBe(1);
      expect(out.join('')).toContain('alerts=1 delivery_failed=1');
      expect(out.join('')).not.toContain('alerts=1 delivery_failed=0');
      expect(events.queryByKind('alert_delivery_failed_all')[0]).toMatchObject({
        kind: 'alert_delivery_failed_all',
        domain: 'alerting',
        severity: 'crit',
        scope_id: 'watchdog',
        alerted_to: 'none',
        payload: expect.objectContaining({
          action_result: 'meta_alert',
          reason: expect.stringContaining('heartbeat silent'),
        }),
      });
    } finally {
      db.close();
    }
  });
});
