/**
 * Collector tests intentionally assert rendered BOT ERRORS dispatch captures
 * and collector log text as behavioral output contracts.
 *
 * test-integrity: source-string-ok
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

let tmpRoot = '';
const tmpdir = () => '/tmp';

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
if [ "$FAKE_FAIL_WRITEFAIL_ACK" = "1" ] && grep -q "writefail-relayed" "$stdin_file"; then
  echo "simulated writefail ack archive failure" >&2
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

function writeFakeTailscaleStatus(root: string, status: Record<string, unknown>): string {
  const script = join(root, 'fake-tailscale-status.sh');
  writeFileSync(
    script,
    `#!/bin/sh
cat <<'JSON'
${JSON.stringify(status, null, 2)}
JSON
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

function writePrivateJson(path: string, value: unknown) {
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  chmodSync(path, 0o600);
}

function collectorEnv(overrides: Record<string, string>) {
  const env = { ...process.env };
  for (const key of [
    'BOT_ERRORS_OUTBOX_DIR',
    'BOT_ERRORS_WRITEFAIL_DIR',
    'BOT_ERRORS_REMOTE_HOST_TARGETS',
    'BOT_ERRORS_TAILSCALE_STATUS_TIMEOUT_SECONDS',
  ]) {
    delete env[key];
  }
  return { ...env, ...overrides };
}

function runAtomicWrite(targetPath: string) {
  return spawnSync('python3', ['-c', `
import importlib.util
from pathlib import Path
spec = importlib.util.spec_from_file_location("bot_errors_collector", "deploy/scripts/bot-errors-collector.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m.atomic_write_json(Path(${JSON.stringify(targetPath)}), {"ok": True})
`], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
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
      '3600',
    ],
    {
      cwd: process.cwd(),
      env: collectorEnv({
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_RELAY_SSH_COMMAND: fakeSsh,
        BOT_ERRORS_TAILSCALE_STATUS_COMMAND: '',
        FAKE_SSH_MODE: mode,
        BOT_ERRORS_COLLECTOR_RECOVERY_SUCCESSES: '1',
      }),
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
      env: collectorEnv({
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_RELAY_SSH_COMMAND: fakeSsh,
        BOT_ERRORS_TAILSCALE_STATUS_COMMAND: '',
        ...env,
      }),
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
  it('asserts the atomic-write parent is private before creating a temp file', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-collector-'));
    const realParent = join(tmpRoot, 'real-outbox');
    const linkedParent = join(tmpRoot, 'linked-outbox');
    mkdirSync(realParent, { recursive: true, mode: 0o700 });
    symlinkSync(realParent, linkedParent, 'dir');

    const result = runAtomicWrite(join(linkedParent, 'event.json'));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('refusing to use private directory through symlink');
    expect(readdirSync(realParent)).toEqual([]);
  });

  it('creates a missing atomic-write parent with private permissions', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-collector-'));
    const parent = join(tmpRoot, 'new-outbox');
    const result = runAtomicWrite(join(parent, 'event.json'));

    expect(result.status).toBe(0);
    expect(statSync(parent).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(join(parent, 'event.json'), 'utf8'))).toEqual({ ok: true });
  });

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
        env: collectorEnv({
          BOT_ERRORS_STATE_DIR: tmpRoot,
          BOT_ERRORS_RELAY_SSH_COMMAND: fakeSsh,
          BOT_ERRORS_TAILSCALE_STATUS_COMMAND: '',
        }),
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

  it('preflights an offline Tailscale peer and skips the secondary writefail probe', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-collector-'));
    const failedRemote = join(tmpRoot, 'remote-failed');
    const healthyRemote = join(tmpRoot, 'remote-healthy');
    mkdirSync(join(failedRemote, 'outbox'), { recursive: true, mode: 0o700 });
    writeRemoteEvent(join(healthyRemote, 'outbox'), 'mini6-relay-while-mini5-tailscale-offline');
    const fakeSsh = writeHostSelectiveExecFakeSsh(tmpRoot);
    const fakeTailscale = writeFakeTailscaleStatus(tmpRoot, {
      Self: { HostName: 'collector', DNSName: 'collector.tailnet.example.ts.net', Online: true },
      Peer: {
        mini5: {
          HostName: 'mini5',
          DNSName: 'mini5.tailnet.example.ts.net',
          TailscaleIPs: ['100.64.0.5'],
          Online: false,
          Active: false,
          OS: 'macOS',
        },
        mini6: {
          HostName: 'mini6',
          DNSName: 'mini6.tailnet.example.ts.net',
          TailscaleIPs: ['100.64.0.6'],
          Online: true,
          Active: true,
          OS: 'macOS',
        },
      },
    });

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
        env: collectorEnv({
          BOT_ERRORS_STATE_DIR: tmpRoot,
          BOT_ERRORS_RELAY_SSH_COMMAND: fakeSsh,
          BOT_ERRORS_TAILSCALE_STATUS_COMMAND: fakeTailscale,
          // Full-suite load can starve the shell fake long enough to exceed
          // the production 2s lookup default, which makes this test count the
          // skipped writefail probe as a second isolated failure.
          BOT_ERRORS_TAILSCALE_STATUS_TIMEOUT_SECONDS: '30',
        }),
        encoding: 'utf8',
      },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ processed: 1, remotesSucceeded: 1, isolatedFailures: 1 });
    const events = outboxEvents();
    expect(events).toHaveLength(2);
    expect(events.some((event) => String(event.summary).includes('BOT ERRORS collector cannot claim remote outbox: mini5'))).toBe(true);
    expect(events.some((event) => event.source === 'remote-writefail-harvest-failed')).toBe(false);
    expect(events.some((event) => event.id === 'mini6-relay-while-mini5-tailscale-offline')).toBe(true);

    const logText = readFileSync(join(tmpRoot, 'logs', 'collector.jsonl'), 'utf8');
    expect(logText).toContain('"type": "remote_writefail_claim_skipped_unreachable"');
    expect(logText).toContain('"reason": "tailscale_offline"');
    expect(logText).not.toContain('"type": "remote_writefail_claim_failed"');
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
    expect(state.openAlerts ?? {}).not.toHaveProperty('mini5:remote-claim-failed');
  });

  it('persists best-effort remote hosts for watchdog daily-health classification', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-collector-'));
    mkdirSync(join(tmpRoot, 'outbox'), { recursive: true, mode: 0o700 });
    const fakeSsh = writeFakeSsh(tmpRoot);

    const result = spawnSync('python3', [
      'deploy/scripts/bot-errors-collector.py',
      '--remote',
      'mini5',
      '--remote',
      'gupta:/tmp/bot-errors',
      '--best-effort-remote',
      'gupta:/tmp/bot-errors',
      '--max-events',
      '1',
      '--timeout',
      '2',
      '--alert-cooldown',
      '900',
    ], {
      cwd: process.cwd(),
      env: collectorEnv({
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_RELAY_SSH_COMMAND: fakeSsh,
        BOT_ERRORS_TAILSCALE_STATUS_COMMAND: '',
        FAKE_SSH_MODE: 'success',
      }),
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    const state = JSON.parse(readFileSync(join(tmpRoot, 'collector-state.json'), 'utf8')) as {
      configuredBestEffortRemoteHosts?: string[];
      configuredBestEffortRemotes?: string[];
      configuredRemoteHosts?: string[];
    };
    expect(state.configuredRemoteHosts).toEqual(['mini5', 'gupta']);
    expect(state.configuredBestEffortRemotes).toEqual(['gupta:/tmp/bot-errors']);
    expect(state.configuredBestEffortRemoteHosts).toEqual(['gupta']);
  });

  it('prunes stale remotes and alert bookkeeping that are no longer configured', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-collector-'));
    mkdirSync(join(tmpRoot, 'outbox'), { recursive: true, mode: 0o700 });
    writePrivateJson(join(tmpRoot, 'collector-state.json'), {
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
    });
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
    expect(files[0]!.length).toBeLessThanOrEqual(180);
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
    const logEntries = readFileSync(join(tmpRoot, 'logs', 'collector.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const poisonAck = logEntries.find((entry) => entry.type === 'writefail_harvest_poison_acked');
    expect(poisonAck?.remoteAckPath).toContain(join(remoteRoot, 'writefail-relayed'));
    expect(poisonAck?.remoteAckDegraded).toBe(false);
  });

  it('does not grow quarantine for the same poisoned writefail when ack keeps failing', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-collector-'));
    const remoteRoot = join(tmpRoot, 'remote');
    const remoteWritefail = join(remoteRoot, 'writefail');
    mkdirSync(remoteWritefail, { recursive: true, mode: 0o700 });
    writeFileSync(join(remoteWritefail, 'bad.writefail'), '{not json', { mode: 0o600 });
    const fakeSsh = writeExecFakeSsh(tmpRoot);

    const first = runCollectorWithRemote(fakeSsh, remoteRoot, { FAKE_FAIL_WRITEFAIL_ACK: '1' });
    expect(first.status).toBe(1);
    expect(JSON.parse(first.stdout)).toMatchObject({ writefailPoison: 1, failed: 1 });
    const quarantineDir = join(tmpRoot, 'writefail-harvest-quarantine');
    const firstFiles = readdirSync(quarantineDir).filter((file) => file.endsWith('.poison'));
    expect(firstFiles).toHaveLength(1);
    expect(outboxEvents().filter((event) => event.source === 'remote-writefail-ack-failed')).toHaveLength(1);

    const second = spawnSync(
      'python3',
      [
        'deploy/scripts/bot-errors-collector.py',
        '--remote',
        `mini5:${remoteRoot}`,
        '--max-events',
        '10',
        '--timeout',
        '5',
        '--lease-seconds',
        '0',
      ],
      {
        cwd: process.cwd(),
        env: collectorEnv({
          BOT_ERRORS_STATE_DIR: tmpRoot,
          BOT_ERRORS_RELAY_SSH_COMMAND: fakeSsh,
          FAKE_FAIL_WRITEFAIL_ACK: '1',
        }),
        encoding: 'utf8',
      },
    );
    expect(second.status).toBe(1);
    expect(JSON.parse(second.stdout)).toMatchObject({ writefailPoison: 1, failed: 1 });
    expect(outboxEvents().filter((event) => event.source === 'remote-writefail-ack-failed')).toHaveLength(1);
    const secondFiles = readdirSync(quarantineDir).filter((file) => file.endsWith('.poison'));
    expect(secondFiles).toEqual(firstFiles);
    const quarantine = JSON.parse(readFileSync(join(quarantineDir, secondFiles[0]!), 'utf8')) as {
      payloadSha256?: string;
    };
    expect(quarantine.payloadSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('uses remote claim dedupe only for legacy poison quarantine records without hashes', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-collector-'));
    const quarantineDir = join(tmpRoot, 'writefail-harvest-quarantine');
    mkdirSync(quarantineDir, { recursive: true, mode: 0o700 });
    const remoteRoot = join(tmpRoot, 'remote');
    const remoteClaim = join(remoteRoot, 'relay-writefail-processing', 'same.claim');
    writeFileSync(join(quarantineDir, 'hashed.poison'), JSON.stringify({
      kind: 'writefail_harvest_poison',
      remoteHost: 'mini5',
      remoteRoot,
      remoteClaim,
      payloadSha256: '0'.repeat(64),
    }));
    writeFileSync(join(quarantineDir, 'legacy.poison'), JSON.stringify({
      kind: 'writefail_harvest_poison',
      remoteHost: 'mini5',
      remoteRoot,
      remoteClaim,
    }));

    const result = spawnSync('python3', ['-'], {
      cwd: process.cwd(),
      input: `
import importlib.util
import os
from pathlib import Path
os.environ["BOT_ERRORS_STATE_DIR"] = ${JSON.stringify(tmpRoot)}
spec = importlib.util.spec_from_file_location("collector", "deploy/scripts/bot-errors-collector.py")
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)
record = {"claim": ${JSON.stringify(remoteClaim)}, "payload": "different payload"}
payload_hash = collector.writefail_poison_hash(record)
found = collector.existing_harvest_quarantine("mini5", ${JSON.stringify(remoteRoot)}, record, payload_hash)
print(Path(found).name if found else "NONE")
`,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('legacy.poison');
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
    const events = outboxEvents();
    expect(events).toHaveLength(2);
    expect(events.some((event) => event.summary === 'ordinary remote outbox event')).toBe(true);
    expect(events.some((event) => event.source === 'remote-writefail-harvest-failed')).toBe(true);
    expect(events.some((event) => event.source === 'remote-drain-stale')).toBe(false);
  });

  it('alerts on malformed normal remote events while relaying valid events behind them', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-collector-'));
    const remoteRoot = join(tmpRoot, 'remote');
    const remoteOutbox = join(remoteRoot, 'outbox');
    mkdirSync(remoteOutbox, { recursive: true, mode: 0o700 });
    writeFileSync(join(remoteOutbox, 'aaa-bad.json'), '{not json', { mode: 0o600 });
    writeRemoteEvent(remoteOutbox, 'valid-after-remote-poison', {
      summary: 'valid event behind malformed remote json',
    });
    const fakeSsh = writeExecFakeSsh(tmpRoot);

    const result = runCollectorWithRemote(fakeSsh, remoteRoot);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ processed: 1, failed: 1 });

    const events = outboxEvents();
    expect(events).toHaveLength(2);
    expect(events.some((event) => event.id === 'valid-after-remote-poison')).toBe(true);
    const meta = events.find((event) => event.source === 'remote-relay-failed');
    expect(String(meta?.summary)).toContain('BOT ERRORS collector cannot relay remote event: mini5');
    expect(String(meta?.evidence)).toContain('remote_name=aaa-bad.json');
    expect(String(meta?.evidence)).not.toContain('{not json');
    expect(readdirSync(remoteOutbox).filter((file) => file.endsWith('.json'))).toEqual(['aaa-bad.json']);
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
      env: collectorEnv({ BOT_ERRORS_STATE_DIR: tmpRoot, BOT_ERRORS_DRY_SEND_CAPTURE: capturePath }),
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
      env: collectorEnv({ BOT_ERRORS_STATE_DIR: tmpRoot, BOT_ERRORS_DRY_SEND_CAPTURE: capturePath }),
      encoding: 'utf8',
    }).status).toBe(0);
    expect(readdirSync(join(tmpRoot, 'sent')).filter((file) => file.endsWith('.sent'))).toHaveLength(1);

    writeRemoteWritefail(remoteWritefail, 'remote-reharvest-idempotent');
    const secondCollector = runCollectorWithRemote(fakeSsh, remoteRoot);
    expect(secondCollector.status).toBe(0);
    expect(JSON.parse(secondCollector.stdout)).toMatchObject({ writefailDuplicates: 1 });
    expect(spawnSync('python3', ['deploy/scripts/bot-errors-dispatcher.py', '--once'], {
      cwd: process.cwd(),
      env: collectorEnv({ BOT_ERRORS_STATE_DIR: tmpRoot, BOT_ERRORS_DRY_SEND_CAPTURE: capturePath }),
      encoding: 'utf8',
    }).status).toBe(0);
    expect(readdirSync(join(tmpRoot, 'sent')).filter((file) => file.endsWith('.sent'))).toHaveLength(1);
    expect((readFileSync(capturePath, 'utf8').match(/remote writefail critical/g) ?? [])).toHaveLength(1);
  });

  it('dedupes a stale remote writefail claim left behind by ack archive failure', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-collector-'));
    const remoteRoot = join(tmpRoot, 'remote');
    const remoteWritefail = join(remoteRoot, 'writefail');
    const fakeSsh = writeExecFakeSsh(tmpRoot);
    const capturePath = join(tmpRoot, 'capture.txt');

    writeRemoteWritefail(remoteWritefail, 'remote-ack-failure-idempotent');
    const firstCollector = runCollectorWithRemote(fakeSsh, remoteRoot, { FAKE_FAIL_WRITEFAIL_ACK: '1' });
    expect(firstCollector.status).toBe(1);
    expect(JSON.parse(firstCollector.stdout)).toMatchObject({ writefailHarvested: 1, failed: 1 });
    const ackMeta = outboxEvents().filter((event) => event.source === 'remote-writefail-ack-failed');
    expect(ackMeta).toHaveLength(1);
    expect(String(ackMeta[0]?.evidence)).toContain('alert_path=normal_outbox');
    expect(String(ackMeta[0]?.evidence)).toContain('terminal_ack_dirs_are_not_used_for_this_meta_alert=true');
    expect(spawnSync('python3', ['deploy/scripts/bot-errors-dispatcher.py', '--once'], {
      cwd: process.cwd(),
      env: collectorEnv({ BOT_ERRORS_STATE_DIR: tmpRoot, BOT_ERRORS_DRY_SEND_CAPTURE: capturePath }),
      encoding: 'utf8',
    }).status).toBe(0);
    expect(readdirSync(join(tmpRoot, 'sent')).filter((file) => file.endsWith('.sent'))).toHaveLength(2);

    const secondCollector = spawnSync(
      'python3',
      [
        'deploy/scripts/bot-errors-collector.py',
        '--remote',
        `mini5:${remoteRoot}`,
        '--max-events',
        '10',
        '--timeout',
        '5',
        '--lease-seconds',
        '0',
      ],
      {
        cwd: process.cwd(),
        env: collectorEnv({
          BOT_ERRORS_STATE_DIR: tmpRoot,
          BOT_ERRORS_RELAY_SSH_COMMAND: fakeSsh,
        }),
        encoding: 'utf8',
      },
    );
    expect(secondCollector.status).toBe(0);
    expect(JSON.parse(secondCollector.stdout)).toMatchObject({ writefailDuplicates: 1 });
    const state = JSON.parse(readFileSync(join(tmpRoot, 'collector-state.json'), 'utf8')) as {
      writefailAckFailures?: Record<string, unknown>;
    };
    expect(state.writefailAckFailures).toEqual({});
    expect(spawnSync('python3', ['deploy/scripts/bot-errors-dispatcher.py', '--once'], {
      cwd: process.cwd(),
      env: collectorEnv({ BOT_ERRORS_STATE_DIR: tmpRoot, BOT_ERRORS_DRY_SEND_CAPTURE: capturePath }),
      encoding: 'utf8',
    }).status).toBe(0);
    expect(readdirSync(join(tmpRoot, 'sent')).filter((file) => file.endsWith('.sent'))).toHaveLength(2);
    expect((readFileSync(capturePath, 'utf8').match(/remote writefail critical/g) ?? [])).toHaveLength(1);
  });

  it('alerts distinct remote writefail ack failures independently by payload hash', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-collector-'));
    const remoteRoot = join(tmpRoot, 'remote');
    const remoteWritefail = join(remoteRoot, 'writefail');
    const fakeSsh = writeExecFakeSsh(tmpRoot);

    writeRemoteWritefail(remoteWritefail, 'remote-ack-failure-one');
    writeRemoteWritefail(remoteWritefail, 'remote-ack-failure-two');
    const result = runCollectorWithRemote(fakeSsh, remoteRoot, { FAKE_FAIL_WRITEFAIL_ACK: '1' });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ writefailHarvested: 2, failed: 2 });

    const events = outboxEvents().filter((event) => event.source === 'remote-writefail-ack-failed');
    expect(events).toHaveLength(2);
    const payloadHashes = new Set(events.map((event) => {
      const diagnostics = event.diagnostics as { payloadSha256?: string } | undefined;
      return String(diagnostics?.payloadSha256 ?? '');
    }));
    expect(payloadHashes.size).toBe(2);
    const state = JSON.parse(readFileSync(join(tmpRoot, 'collector-state.json'), 'utf8')) as {
      writefailAckFailures?: Record<string, unknown>;
    };
    expect(Object.keys(state.writefailAckFailures ?? {})).toHaveLength(2);
  });

  it('drains remote writefail claims into HOME fallback when root relayed archive is blocked', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-collector-'));
    const remoteRoot = join(tmpRoot, 'remote');
    const remoteHome = join(tmpRoot, 'remote-home');
    const remoteWritefail = join(remoteRoot, 'writefail');
    mkdirSync(remoteHome, { recursive: true, mode: 0o700 });
    writeRemoteWritefail(remoteWritefail, 'remote-ack-home-fallback');
    writeFileSync(join(remoteRoot, 'writefail-relayed'), 'not a directory', { mode: 0o600 });
    const fakeSsh = writeExecFakeSsh(tmpRoot);

    const firstCollector = runCollectorWithRemote(fakeSsh, remoteRoot, { HOME: remoteHome });
    expect(firstCollector.status).toBe(0);
    expect(JSON.parse(firstCollector.stdout)).toMatchObject({ writefailHarvested: 1, failed: 0 });
    expect(readdirSync(join(remoteRoot, 'relay-writefail-processing'))).toHaveLength(0);
    const fallbackRelayed = join(remoteHome, '.bot-errors-writefail-relayed');
    expect(readdirSync(fallbackRelayed).filter((file) => file.endsWith('.relayed'))).toHaveLength(1);
    const logEntries = readFileSync(join(tmpRoot, 'logs', 'collector.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const ack = logEntries.find((entry) => entry.type === 'writefail_harvest_acked');
    expect(ack?.remoteAckPath).toContain(fallbackRelayed);
    expect(ack?.remoteAckDegraded).toBe(false);

    const secondCollector = spawnSync(
      'python3',
      [
        'deploy/scripts/bot-errors-collector.py',
        '--remote',
        `mini5:${remoteRoot}`,
        '--max-events',
        '10',
        '--timeout',
        '5',
        '--lease-seconds',
        '0',
      ],
      {
        cwd: process.cwd(),
        env: collectorEnv({
          HOME: remoteHome,
          BOT_ERRORS_STATE_DIR: tmpRoot,
          BOT_ERRORS_RELAY_SSH_COMMAND: fakeSsh,
        }),
        encoding: 'utf8',
      },
    );
    expect(secondCollector.status).toBe(0);
    expect(JSON.parse(secondCollector.stdout)).toMatchObject({
      writefailHarvested: 0,
      writefailDuplicates: 0,
      writefailPoison: 0,
      failed: 0,
    });
    expect(readdirSync(join(tmpRoot, 'writefail')).filter((file) => file.endsWith('.writefail'))).toHaveLength(1);
  });

  it('atomically drains a remote writefail claim across EXDEV without partial relayed files', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-collector-'));
    const remoteRoot = join(tmpRoot, 'remote');
    const claimDir = join(remoteRoot, 'relay-writefail-processing');
    mkdirSync(claimDir, { recursive: true, mode: 0o700 });
    const claim = join(claimDir, 'exdev.writefail.123.relay');
    writeFileSync(claim, 'exdev payload\n', { mode: 0o600 });

    const result = spawnSync('python3', ['-'], {
      cwd: process.cwd(),
      input: `
import errno
import importlib.util
import os
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location("collector", "deploy/scripts/bot-errors-collector.py")
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)
claim = Path(${JSON.stringify(claim)})
root = Path(${JSON.stringify(remoteRoot)})
original_replace = os.replace

def fake_replace(src, dst):
    if str(src) == str(claim):
        raise OSError(errno.EXDEV, "cross-device link")
    return original_replace(src, dst)

os.replace = fake_replace
sys.argv = ["ack-test", str(claim), str(root), "ack"]
exec(collector.REMOTE_WRITEFAIL_ACK_SCRIPT, {"__name__": "__main__"})
`,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(existsSync(claim)).toBe(false);
    const relayedDir = join(remoteRoot, 'writefail-relayed');
    const relayed = readdirSync(relayedDir).filter((file) => file.endsWith('.relayed'));
    expect(relayed).toHaveLength(1);
    expect(readFileSync(join(relayedDir, relayed[0]!), 'utf8')).toBe('exdev payload\n');
    expect(readdirSync(relayedDir).filter((file) => file.includes('.tmp'))).toHaveLength(0);
  });

  it('does not create duplicate terminal archives when unlink fails after EXDEV promotion', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-collector-'));
    const remoteRoot = join(tmpRoot, 'remote');
    const claimDir = join(remoteRoot, 'relay-writefail-processing');
    mkdirSync(claimDir, { recursive: true, mode: 0o700 });
    const claim = join(claimDir, 'unlink-fails.writefail.123.relay');
    writeFileSync(claim, 'unlink failure payload\n', { mode: 0o600 });
    const input = `
import errno
import importlib.util
import os
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location("collector", "deploy/scripts/bot-errors-collector.py")
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)
claim = Path(${JSON.stringify(claim)})
root = Path(${JSON.stringify(remoteRoot)})
original_replace = os.replace
original_unlink = Path.unlink

def fake_replace(src, dst):
    if str(src) == str(claim):
        raise OSError(errno.EXDEV, "cross-device link")
    return original_replace(src, dst)

def fake_unlink(self, *args, **kwargs):
    if str(self) == str(claim):
        raise OSError("unlink denied")
    return original_unlink(self, *args, **kwargs)

os.replace = fake_replace
Path.unlink = fake_unlink
sys.argv = ["ack-test", str(claim), str(root), "ack"]
exec(collector.REMOTE_WRITEFAIL_ACK_SCRIPT, {"__name__": "__main__"})
`;

    const first = spawnSync('python3', ['-'], { cwd: process.cwd(), input, encoding: 'utf8' });
    expect(first.status).not.toBe(0);
    expect(existsSync(claim)).toBe(true);
    const relayedDir = join(remoteRoot, 'writefail-relayed');
    expect(readdirSync(relayedDir).filter((file) => file.endsWith('.relayed'))).toHaveLength(1);

    const second = spawnSync('python3', ['-'], { cwd: process.cwd(), input, encoding: 'utf8' });
    expect(second.status).not.toBe(0);
    expect(second.stderr).toContain('already archived but claim unlink failed');
    expect(existsSync(claim)).toBe(true);
    expect(readdirSync(relayedDir).filter((file) => file.endsWith('.relayed'))).toHaveLength(1);
    expect(readdirSync(relayedDir).filter((file) => file.includes('.tmp'))).toHaveLength(0);
  });

  it('preserves a remote writefail claim when no terminal ack archive is writable', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-collector-'));
    const remoteRoot = join(tmpRoot, 'remote');
    const claimDir = join(remoteRoot, 'relay-writefail-processing');
    mkdirSync(claimDir, { recursive: true, mode: 0o700 });
    const claim = join(claimDir, 'unwritable.writefail.123.relay');
    writeFileSync(claim, 'still pending\n', { mode: 0o600 });

    const result = spawnSync('python3', ['-'], {
      cwd: process.cwd(),
      env: collectorEnv({
        HOME: join(tmpRoot, 'remote-home'),
        TMPDIR: join(tmpRoot, 'remote-tmp'),
      }),
      input: `
import importlib.util
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location("collector", "deploy/scripts/bot-errors-collector.py")
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)
original_mkdir = Path.mkdir

def fake_mkdir(self, *args, **kwargs):
    text = str(self)
    if "writefail-relayed" in text or ".bot-errors-writefail-relayed" in text:
        raise OSError("blocked terminal archive dir")
    return original_mkdir(self, *args, **kwargs)

Path.mkdir = fake_mkdir
sys.argv = ["ack-test", ${JSON.stringify(claim)}, ${JSON.stringify(remoteRoot)}, "ack"]
exec(collector.REMOTE_WRITEFAIL_ACK_SCRIPT, {"__name__": "__main__"})
`,
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('no writable writefail ack terminal dir');
    expect(existsSync(claim)).toBe(true);
  });

  it('marks volatile TMPDIR terminal drains as degraded in the collector log', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-collector-'));
    const remoteRoot = join(tmpRoot, 'remote');
    const remoteTmp = join(tmpRoot, 'remote-tmp');
    const remoteHomeFile = join(tmpRoot, 'remote-home-file');
    const remoteWritefail = join(remoteRoot, 'writefail');
    mkdirSync(remoteTmp, { recursive: true, mode: 0o700 });
    writeFileSync(remoteHomeFile, 'not a directory', { mode: 0o600 });
    writeRemoteWritefail(remoteWritefail, 'remote-ack-tmp-fallback');
    writeFileSync(join(remoteRoot, 'writefail-relayed'), 'not a directory', { mode: 0o600 });
    const fakeSsh = writeExecFakeSsh(tmpRoot);

    const result = runCollectorWithRemote(fakeSsh, remoteRoot, { HOME: remoteHomeFile, TMPDIR: remoteTmp });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ writefailHarvested: 1, failed: 0 });
    const tmpRelayed = join(remoteTmp, 'bot-errors-writefail-relayed');
    expect(readdirSync(tmpRelayed).filter((file) => file.endsWith('.relayed'))).toHaveLength(1);
    const logEntries = readFileSync(join(tmpRoot, 'logs', 'collector.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const ack = logEntries.find((entry) => entry.type === 'writefail_harvest_acked');
    expect(ack?.remoteAckPath).toContain(tmpRelayed);
    expect(ack?.remoteAckDegraded).toBe(true);
  });

  it('caps long normal remote relay filenames without mutating event identity', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-collector-'));
    const remoteRoot = join(tmpRoot, 'remote');
    const eventId = `remote-long-${'x'.repeat(180)}`;
    writeRemoteEvent(join(remoteRoot, 'outbox'), eventId, {
      instance: `ana-bot-${'i'.repeat(100)}`,
      source: `remote/source-${'s'.repeat(100)}`,
    });
    const fakeSsh = writeExecFakeSsh(tmpRoot);

    const result = runCollectorWithRemote(fakeSsh, remoteRoot);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ processed: 1, failed: 0 });

    const files = readdirSync(join(tmpRoot, 'outbox')).filter((file) => file.endsWith('.json'));
    expect(files).toHaveLength(1);
    expect(files[0]!.length).toBeLessThanOrEqual(180);
    expect(files[0]).toMatch(/\.json$/);
    expect(files[0]).not.toContain('/');
    const event = JSON.parse(readFileSync(join(tmpRoot, 'outbox', files[0]!), 'utf8')) as { id: string };
    expect(event.id).toBe(eventId);
    expect(readdirSync(join(remoteRoot, 'outbox')).filter((file) => file.endsWith('.json'))).toHaveLength(0);
    expect(readdirSync(join(remoteRoot, 'relayed'))).toHaveLength(1);
  });

  it('does not collapse two long remote ids that differ only beyond the filename cap', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-collector-'));
    const remoteRoot = join(tmpRoot, 'remote');
    const sharedPrefix = `remote-collision-${'x'.repeat(190)}`;
    const firstId = `${sharedPrefix}-a`;
    const secondId = `${sharedPrefix}-b`;
    writeRemoteEvent(join(remoteRoot, 'outbox'), firstId, {
      instance: `ana-bot-${'i'.repeat(100)}`,
      source: `remote-source-${'s'.repeat(100)}`,
      summary: 'first long collision candidate',
    });
    writeRemoteEvent(join(remoteRoot, 'outbox'), secondId, {
      instance: `ana-bot-${'i'.repeat(100)}`,
      source: `remote-source-${'s'.repeat(100)}`,
      summary: 'second long collision candidate',
    });
    const fakeSsh = writeExecFakeSsh(tmpRoot);

    const result = runCollectorWithRemote(fakeSsh, remoteRoot);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ processed: 2, failed: 0 });

    const files = readdirSync(join(tmpRoot, 'outbox')).filter((file) => file.endsWith('.json')).sort();
    expect(files).toHaveLength(2);
    expect(new Set(files).size).toBe(2);
    files.forEach((file) => {
      expect(file.length).toBeLessThanOrEqual(180);
      expect(file).toMatch(/\.json$/);
    });
    const ids = files.map((file) => JSON.parse(readFileSync(join(tmpRoot, 'outbox', file), 'utf8')).id).sort();
    expect(ids).toEqual([firstId, secondId].sort());
  });

  it('recognizes duplicate remote events already present in a custom local outbox', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-collector-'));
    const customOutbox = join(tmpRoot, 'custom-outbox');
    const remoteRoot = join(tmpRoot, 'remote');
    mkdirSync(customOutbox, { recursive: true, mode: 0o700 });
    writeFileSync(join(customOutbox, 'already-local.json'), JSON.stringify({
      id: 'custom-outbox-duplicate',
      createdAt: '2026-05-31T00:00:00Z',
      delivery: { status: 'queued' },
    }));
    writeRemoteEvent(join(remoteRoot, 'outbox'), 'custom-outbox-duplicate', {
      createdAt: '2026-05-31T00:00:00Z',
    });
    const fakeSsh = writeExecFakeSsh(tmpRoot);

    const result = runCollectorWithRemote(fakeSsh, remoteRoot, { BOT_ERRORS_OUTBOX_DIR: customOutbox });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ processed: 1, failed: 0 });
    expect(readdirSync(customOutbox).filter((file) => file.endsWith('.json'))).toHaveLength(1);
    expect(readdirSync(join(remoteRoot, 'outbox')).filter((file) => file.endsWith('.json'))).toHaveLength(0);
  });

  it('does not suppress a new occurrence that reuses a stable id with a new createdAt', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-collector-'));
    const remoteRoot = join(tmpRoot, 'remote');
    const sent = join(tmpRoot, 'sent');
    mkdirSync(sent, { recursive: true, mode: 0o700 });
    writeFileSync(join(sent, 'stable-recurring.sent'), JSON.stringify({
      id: 'stable-recurring',
      createdAt: '2026-05-31T00:00:00Z',
      delivery: { status: 'sent' },
    }));
    writeRemoteEvent(join(remoteRoot, 'outbox'), 'stable-recurring', {
      createdAt: '2026-05-31T00:05:00Z',
      summary: 'stable id second occurrence must alert',
    });
    const fakeSsh = writeExecFakeSsh(tmpRoot);

    const result = runCollectorWithRemote(fakeSsh, remoteRoot);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ processed: 1, failed: 0 });
    const events = outboxEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: 'stable-recurring',
      createdAt: '2026-05-31T00:05:00Z',
      summary: 'stable id second occurrence must alert',
    });
  });

  it('fails closed with exit 64 when no remotes are configured (empty env, no --remote)', () => {
    // Externalized poll list: with no --remote flags and an empty
    // BOT_ERRORS_RELAY_REMOTES, the collector must surface inconclusive config as
    // a usage error (EX_USAGE=64), never daemonize on an empty set or exit 0.
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-collector-'));
    const result = spawnSync(
      'python3',
      ['deploy/scripts/bot-errors-collector.py', '--max-events', '1', '--timeout', '2'],
      {
        cwd: process.cwd(),
        env: collectorEnv({ BOT_ERRORS_STATE_DIR: tmpRoot, BOT_ERRORS_RELAY_REMOTES: '' }),
        encoding: 'utf8',
      },
    );
    expect(result.status).toBe(64);
    expect(result.stderr).toContain('no remotes configured');
  });

  it('resolves the poll list from BOT_ERRORS_RELAY_REMOTES when no --remote flags are given', () => {
    // Proves the env fallback (collector main: `args.remote or env split`) is the
    // wired path now that the tracked unit carries no --remote flags. The env list
    // gets past the fail-closed guard and the run acts on exactly that host.
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-collector-'));
    const fakeSsh = writeFakeSsh(tmpRoot);
    const result = spawnSync(
      'python3',
      ['deploy/scripts/bot-errors-collector.py', '--max-events', '1', '--timeout', '2', '--alert-cooldown', '3600'],
      {
        cwd: process.cwd(),
        env: collectorEnv({
          BOT_ERRORS_STATE_DIR: tmpRoot,
          BOT_ERRORS_RELAY_REMOTES: 'mini5',
          BOT_ERRORS_RELAY_SSH_COMMAND: fakeSsh,
          BOT_ERRORS_TAILSCALE_STATUS_COMMAND: '',
          FAKE_SSH_MODE: 'fail',
        }),
        encoding: 'utf8',
      },
    );
    // Got past the fail-closed guard (not 64) → the env list became the remote
    // set. The run_once summary is host-agnostic counters, so we assert behavior,
    // not the host name: exactly the env-provided host was attempted and failed
    // through fake-ssh (failed >= 1), proving a real poll — not a silent no-op
    // (which would yield zero failures).
    expect(result.status).not.toBe(64);
    const summary = JSON.parse(result.stdout) as { failed: number; remotesSucceeded: number };
    expect(summary.failed).toBeGreaterThanOrEqual(1);
    expect(summary.remotesSucceeded).toBe(0);
  });
});
