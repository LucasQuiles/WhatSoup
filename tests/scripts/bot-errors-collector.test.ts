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

function writeExecFakeSsh(root: string): string {
  const script = join(root, 'fake-ssh-exec.sh');
  writeFileSync(
    script,
    `#!/bin/sh
if [ "$FAKE_SSH_MODE" = "fail" ]; then
  echo "simulated ssh failure" >&2
  exit 255
fi
while [ "$#" -gt 0 ] && [ "$1" != "python3" ]; do
  shift
done
if [ "$1" != "python3" ]; then
  echo "python3 command not found" >&2
  exit 127
fi
shift
stdin_file="$(mktemp)"
cat > "$stdin_file"
if [ "$FAKE_FAIL_WRITEFAIL_CLAIM" = "1" ] && grep -q "relay-writefail-processing" "$stdin_file"; then
  echo "simulated writefail claim failure" >&2
  rm -f "$stdin_file"
  exit 255
fi
python3 "$@" < "$stdin_file"
status=$?
rm -f "$stdin_file"
exit "$status"
`,
    { mode: 0o700 },
  );
  chmodSync(script, 0o700);
  return script;
}

function writeHostSelectiveExecFakeSsh(root: string): string {
  const script = join(root, 'fake-host-selective-ssh.sh');
  writeFileSync(
    script,
    `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "mini5" ]; then
    echo "simulated mini5 unreachable" >&2
    exit 255
  fi
done
while [ "$#" -gt 0 ] && [ "$1" != "python3" ]; do
  shift
done
if [ "$1" != "python3" ]; then
  echo "python3 command not found" >&2
  exit 127
fi
shift
exec python3 "$@"
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

function runCollectorWithRemote(fakeSsh: string, remoteRoot: string, env: Record<string, string> = {}) {
  return spawnSync(
    'python3',
    [
      'deploy/scripts/bot-errors-collector.py',
      '--remote',
      `mini5:${remoteRoot}`,
      '--max-events',
      '10',
      '--timeout',
      '5',
      '--alert-cooldown',
      '1',
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_RELAY_SSH_COMMAND: fakeSsh,
        ...env,
      },
      encoding: 'utf8',
    },
  );
}

function writeRemoteWritefail(dir: string, id = 'remote-writefail-test', overrides: Record<string, unknown> = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const event = {
    schemaVersion: 1,
    id,
    eventType: 'alert',
    severity: 'critical',
    createdAt: '2026-05-31T00:00:00Z',
    machine: 'mini5-hostname',
    platform: 'darwin',
    instance: 'ana-bot',
    source: 'wf',
    summary: 'remote writefail critical',
    evidence: 'remote outbox failed',
    delivery: { attempts: 0, status: 'queued', nextAttemptAtEpoch: 0, lastError: null },
    ...overrides,
  };
  const crumb = {
    schemaVersion: 1,
    kind: 'outbox_write_failure',
    recordedAt: '2026-05-31T00:00:01Z',
    failedTarget: '/remote/outbox',
    reason: 'remote outbox denied',
    emitPid: 123,
    event,
  };
  writeFileSync(join(dir, `${id}.writefail`), `${JSON.stringify(crumb, null, 2)}\n`, { mode: 0o600 });
}

function writeRemoteEvent(dir: string, id = 'remote-relay-test', overrides: Record<string, unknown> = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const event = {
    schemaVersion: 1,
    id,
    eventType: 'alert',
    severity: 'critical',
    createdAt: '2026-05-31T00:00:00Z',
    machine: 'mini6-hostname',
    platform: 'darwin',
    instance: 'ana-bot',
    source: 'remote-drill',
    summary: 'reachable host event relayed',
    evidence: 'host mini6 stayed reachable while mini5 was unreachable',
    delivery: { attempts: 0, status: 'queued', nextAttemptAtEpoch: 0, lastError: null },
    ...overrides,
  };
  writeFileSync(join(dir, `${id}.json`), `${JSON.stringify(event, null, 2)}\n`, { mode: 0o600 });
}

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
});

describe('bot-errors-collector', () => {
  it('isolates an unreachable remote while still relaying a reachable host', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-collector-'));
    const failedRemote = join(tmpRoot, 'remote-failed');
    const healthyRemote = join(tmpRoot, 'remote-healthy');
    mkdirSync(join(failedRemote, 'outbox'), { recursive: true, mode: 0o700 });
    writeRemoteEvent(join(healthyRemote, 'outbox'), 'mini6-relay-while-mini5-dark');
    const fakeSsh = writeHostSelectiveExecFakeSsh(tmpRoot);

    const result = spawnSync(
      'python3',
      [
        'deploy/scripts/bot-errors-collector.py',
        '--remote',
        `mini5:${failedRemote}`,
        '--remote',
        `mini6:${healthyRemote}`,
        '--max-events',
        '5',
        '--timeout',
        '5',
        '--alert-cooldown',
        '1',
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          BOT_ERRORS_STATE_DIR: tmpRoot,
          BOT_ERRORS_RELAY_SSH_COMMAND: fakeSsh,
        },
        encoding: 'utf8',
      },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ processed: 1, remotesSucceeded: 1, isolatedFailures: 2 });
    const events = outboxEvents();
    expect(events).toHaveLength(2);
    expect(events.some((event) => String(event.summary).includes('BOT ERRORS collector cannot claim remote outbox: mini5'))).toBe(true);
    expect(events.some((event) => event.id === 'mini6-relay-while-mini5-dark')).toBe(true);
    const relayed = events.find((event) => event.id === 'mini6-relay-while-mini5-dark') as {
      diagnostics?: { relay?: { remoteHost?: string } };
    };
    expect(relayed.diagnostics?.relay?.remoteHost).toBe('mini6');
    expect(readdirSync(join(healthyRemote, 'outbox')).filter((file) => file.endsWith('.json'))).toHaveLength(0);
  });

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

  it('harvests remote writefail crumbs into the local writefail inbox with provenance', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-collector-'));
    const remoteRoot = join(tmpRoot, 'remote');
    const longEventId = `remote-critical-live-canary-${'x'.repeat(210)}`;
    writeRemoteWritefail(join(remoteRoot, 'writefail'), longEventId);
    const fakeSsh = writeExecFakeSsh(tmpRoot);

    const result = runCollectorWithRemote(fakeSsh, remoteRoot);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ writefailHarvested: 1, writefailPoison: 0 });

    const localWritefail = join(tmpRoot, 'writefail');
    const files = readdirSync(localWritefail).filter((file) => file.endsWith('.writefail'));
    expect(files).toHaveLength(1);
    const crumb = JSON.parse(readFileSync(join(localWritefail, files[0]!), 'utf8')) as {
      event: { id: string };
      harvest: { fromHost: string; fromDir: string };
    };
    expect(files[0]).toMatch(/\.writefail$/);
    expect(crumb.event.id).toBe(longEventId);
    expect(crumb.harvest.fromHost).toBe('mini5');
    expect(crumb.harvest.fromDir).toContain('writefail');
    expect(readdirSync(join(remoteRoot, 'writefail')).filter((file) => file.endsWith('.writefail'))).toHaveLength(0);
    expect(readdirSync(join(remoteRoot, 'writefail-relayed'))).toHaveLength(1);
  });

  it('harvests remote writefail crumbs from TMPDIR fallback', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-collector-'));
    const remoteRoot = join(tmpRoot, 'remote');
    const remoteTmp = join(tmpRoot, 'remote-tmp');
    writeRemoteWritefail(join(remoteTmp, 'bot-errors-writefail'), 'tmp-fallback-writefail');
    const fakeSsh = writeExecFakeSsh(tmpRoot);

    const result = runCollectorWithRemote(fakeSsh, remoteRoot, { TMPDIR: remoteTmp });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ writefailHarvested: 1 });

    const files = readdirSync(join(tmpRoot, 'writefail')).filter((file) => file.endsWith('.writefail'));
    expect(files).toHaveLength(1);
    const crumb = JSON.parse(readFileSync(join(tmpRoot, 'writefail', files[0]!), 'utf8')) as {
      event: { id: string };
      harvest: { fromDir: string };
    };
    expect(crumb.event.id).toBe('tmp-fallback-writefail');
    expect(crumb.harvest.fromDir).toContain('bot-errors-writefail');
  });

  it('quarantines malformed remote writefail crumbs without blocking valid crumbs', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-collector-'));
    const remoteRoot = join(tmpRoot, 'remote');
    const remoteWritefail = join(remoteRoot, 'writefail');
    mkdirSync(remoteWritefail, { recursive: true, mode: 0o700 });
    writeFileSync(join(remoteWritefail, 'bad.writefail'), '{not json', { mode: 0o600 });
    writeRemoteWritefail(remoteWritefail, 'valid-alongside-poison');
    const fakeSsh = writeExecFakeSsh(tmpRoot);

    const result = runCollectorWithRemote(fakeSsh, remoteRoot);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ writefailHarvested: 1, writefailPoison: 1 });
    expect(readdirSync(join(tmpRoot, 'writefail')).filter((file) => file.endsWith('.writefail'))).toHaveLength(1);
    expect(readdirSync(join(tmpRoot, 'writefail-harvest-quarantine'))).toHaveLength(1);
  });

  it('continues normal outbox relay when the writefail claim path fails', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-collector-'));
    const remoteRoot = join(tmpRoot, 'remote');
    const remoteOutbox = join(remoteRoot, 'outbox');
    mkdirSync(remoteOutbox, { recursive: true, mode: 0o700 });
    writeFileSync(join(remoteOutbox, 'remote-event.json'), JSON.stringify({
      schemaVersion: 1,
      id: 'ordinary-remote-event',
      eventType: 'alert',
      severity: 'critical',
      createdAt: '2026-05-31T00:00:00Z',
      machine: 'mini5-hostname',
      instance: 'ana-bot',
      source: 'ordinary',
      summary: 'ordinary remote outbox event',
      evidence: 'outbox relay must continue',
      delivery: { attempts: 0, status: 'queued', nextAttemptAtEpoch: 0, lastError: null },
    }));
    const fakeSsh = writeExecFakeSsh(tmpRoot);

    const result = runCollectorWithRemote(fakeSsh, remoteRoot, { FAKE_FAIL_WRITEFAIL_CLAIM: '1' });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ processed: 1, failed: 1 });
    expect(outboxEvents()).toHaveLength(2);
    expect(outboxEvents().some((event) => event.summary === 'ordinary remote outbox event')).toBe(true);
    expect(outboxEvents().some((event) => event.source === 'remote-writefail-harvest-failed')).toBe(true);
  });

  it('lets dispatcher recover a harvested critical remote writefail end to end', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-collector-'));
    const remoteRoot = join(tmpRoot, 'remote');
    writeRemoteWritefail(join(remoteRoot, 'writefail'), 'remote-critical-e2e', {
      summary: 'remote harvested critical alert',
    });
    const fakeSsh = writeExecFakeSsh(tmpRoot);
    const capturePath = join(tmpRoot, 'capture.txt');

    const collector = runCollectorWithRemote(fakeSsh, remoteRoot);
    expect(collector.status).toBe(0);
    const dispatcher = spawnSync('python3', ['deploy/scripts/bot-errors-dispatcher.py', '--once'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_SEND_CAPTURE: capturePath,
      },
      encoding: 'utf8',
    });

    expect(dispatcher.status).toBe(0);
    expect(readFileSync(capturePath, 'utf8')).toContain('remote harvested critical alert');
    expect(readFileSync(capturePath, 'utf8')).toContain('writefail_recovered: origin=mini5-hostname harvested_from=mini5');
    expect(readdirSync(join(tmpRoot, 'sent')).filter((file) => file.endsWith('.sent'))).toHaveLength(1);
  });

  it('does not double-send a remote writefail re-harvest with the same event id', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-collector-'));
    const remoteRoot = join(tmpRoot, 'remote');
    const remoteWritefail = join(remoteRoot, 'writefail');
    const fakeSsh = writeExecFakeSsh(tmpRoot);
    const capturePath = join(tmpRoot, 'capture.txt');

    writeRemoteWritefail(remoteWritefail, 'remote-reharvest-idempotent');
    expect(runCollectorWithRemote(fakeSsh, remoteRoot).status).toBe(0);
    expect(spawnSync('python3', ['deploy/scripts/bot-errors-dispatcher.py', '--once'], {
      cwd: process.cwd(),
      env: { ...process.env, BOT_ERRORS_STATE_DIR: tmpRoot, BOT_ERRORS_DRY_SEND_CAPTURE: capturePath },
      encoding: 'utf8',
    }).status).toBe(0);
    expect(readdirSync(join(tmpRoot, 'sent')).filter((file) => file.endsWith('.sent'))).toHaveLength(1);

    writeRemoteWritefail(remoteWritefail, 'remote-reharvest-idempotent');
    const secondCollector = runCollectorWithRemote(fakeSsh, remoteRoot);
    expect(secondCollector.status).toBe(0);
    expect(JSON.parse(secondCollector.stdout)).toMatchObject({ writefailDuplicates: 1 });
    expect(spawnSync('python3', ['deploy/scripts/bot-errors-dispatcher.py', '--once'], {
      cwd: process.cwd(),
      env: { ...process.env, BOT_ERRORS_STATE_DIR: tmpRoot, BOT_ERRORS_DRY_SEND_CAPTURE: capturePath },
      encoding: 'utf8',
    }).status).toBe(0);
    expect(readdirSync(join(tmpRoot, 'sent')).filter((file) => file.endsWith('.sent'))).toHaveLength(1);
    expect((readFileSync(capturePath, 'utf8').match(/remote writefail critical/g) ?? [])).toHaveLength(1);
  });
});
