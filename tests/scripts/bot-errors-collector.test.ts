import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

let tmpRoot = '';

function writeFakeSsh(root: string): string {
  const script = join(root, 'fake-ssh.sh');
  writeFileSync(
    script,
    `#!/bin/sh
if [ "$FAKE_SSH_MODE" = "success" ]; then
  exit 0
fi
echo "simulated ssh failure" >&2
exit 255
`,
    { mode: 0o700 },
  );
  chmodSync(script, 0o700);
  return script;
}

function outboxEvents() {
  const outbox = join(tmpRoot, 'outbox');
  return readdirSync(outbox)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => JSON.parse(readFileSync(join(outbox, file), 'utf8')) as Record<string, unknown>);
}

function runCollector(fakeSsh: string, mode: 'fail' | 'success') {
  return spawnSync(
    'python3',
    [
      'deploy/scripts/bot-errors-collector.py',
      '--remote',
      'mini5',
      '--max-events',
      '1',
      '--timeout',
      '2',
      '--alert-cooldown',
      '1',
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_RELAY_SSH_COMMAND: fakeSsh,
        FAKE_SSH_MODE: mode,
      },
      encoding: 'utf8',
    },
  );
}

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
});

describe('bot-errors-collector', () => {
  it('keeps one open remote-claim incident and emits recovery on the next success', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-collector-'));
    mkdirSync(join(tmpRoot, 'outbox'), { recursive: true, mode: 0o700 });
    const fakeSsh = writeFakeSsh(tmpRoot);

    const firstFailure = runCollector(fakeSsh, 'fail');
    expect(firstFailure.status).toBe(1);
    expect(outboxEvents()).toHaveLength(1);
    expect(outboxEvents()[0]).toMatchObject({
      eventType: 'alert',
      severity: 'critical',
      instance: 'bot-errors-collector',
      source: 'remote-claim-failed',
      summary: 'BOT ERRORS collector cannot claim remote outbox: mini5',
    });

    const secondFailure = runCollector(fakeSsh, 'fail');
    expect(secondFailure.status).toBe(1);
    expect(outboxEvents()).toHaveLength(1);
    expect(readFileSync(join(tmpRoot, 'logs', 'collector.jsonl'), 'utf8')).toContain('meta_alert_suppressed_open');

    const recovery = runCollector(fakeSsh, 'success');
    expect(recovery.status).toBe(0);
    const events = outboxEvents();
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      eventType: 'clear',
      severity: 'info',
      instance: 'bot-errors-collector',
      source: 'remote-claim-failed',
      summary: 'BOT ERRORS collector remote recovered: mini5',
    });
    expect(String(events[1]?.evidence)).toContain('suppressed_duplicates=1');

    const state = JSON.parse(readFileSync(join(tmpRoot, 'collector-state.json'), 'utf8')) as {
      configuredRemoteHosts?: string[];
      configuredRemotes?: string[];
      openAlerts?: Record<string, unknown>;
    };
    expect(state.configuredRemoteHosts).toEqual(['mini5']);
    expect(state.configuredRemotes).toEqual(['mini5']);
    expect(state.openAlerts?.['mini5:remote-claim-failed']).toBeUndefined();
  });

  it('prunes stale remotes and alert bookkeeping that are no longer configured', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-collector-'));
    mkdirSync(join(tmpRoot, 'outbox'), { recursive: true, mode: 0o700 });
    writeFileSync(join(tmpRoot, 'collector-state.json'), JSON.stringify({
      configuredRemotes: ['brick'],
      configuredRemoteHosts: ['brick'],
      remotes: {
        brick: { lastSuccessIso: '2026-05-30T00:00:00Z' },
        'mini5:/var/tmp/bot-errors-drill': { lastError: 'old drill alias' },
      },
      alerts: {
        'brick:remote-claim-failed': 1,
        'mini5:/var/tmp/bot-errors-drill:remote-claim-failed': 2,
      },
      openAlerts: {
        'brick:remote-drain-stale': { status: 'open' },
        'mini5:/var/tmp/bot-errors-drill:remote-claim-failed': { status: 'open' },
      },
    }));
    const fakeSsh = writeFakeSsh(tmpRoot);

    const result = runCollector(fakeSsh, 'success');
    expect(result.status).toBe(0);

    const state = JSON.parse(readFileSync(join(tmpRoot, 'collector-state.json'), 'utf8')) as {
      configuredRemoteHosts?: string[];
      configuredRemotes?: string[];
      remotes?: Record<string, unknown>;
      alerts?: Record<string, unknown>;
      openAlerts?: Record<string, unknown>;
    };
    expect(state.configuredRemoteHosts).toEqual(['mini5']);
    expect(state.configuredRemotes).toEqual(['mini5']);
    expect(Object.keys(state.remotes ?? {})).toEqual(['mini5']);
    expect(state.alerts).toEqual({});
    expect(state.openAlerts).toEqual({});
  });
});
