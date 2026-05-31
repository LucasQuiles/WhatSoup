import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

let tmpRoot = '';

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
});

function runWatchdog(env: Record<string, string>, args: string[] = []) {
  return execFileSync('python3', ['deploy/scripts/bot-errors-heartbeat-watchdog.py', '--once', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

function readOutboxEvents() {
  const outbox = join(tmpRoot, 'outbox');
  return readdirSync(outbox).map((file) => JSON.parse(readFileSync(join(outbox, file), 'utf8')) as {
    eventType: string;
    severity: string;
    summary: string;
    evidence: string;
    alertSource: string;
  });
}

function writePrivateJson(path: string, value: unknown) {
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  chmodSync(path, 0o600);
}

describe('bot-errors-heartbeat-watchdog', () => {
  it('emits a durable alert when the q-loop heartbeat is stale', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-heartbeat-'));
    const qLoopState = join(tmpRoot, 'q-loop-state.json');
    writePrivateJson(qLoopState, { updated_at: 100 });

    const output = runWatchdog({
      BOT_ERRORS_STATE_DIR: tmpRoot,
      BOT_ERRORS_Q_LOOP_STATE: qLoopState,
      BOT_ERRORS_WATCHDOG_CHECKS: 'q_loop',
      BOT_ERRORS_DRY_NOW: '1000',
      BOT_ERRORS_MAX_Q_LOOP_AGE: '60',
    });

    expect(output).toContain('"q_loop"');
    const events = readOutboxEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.severity).toBe('critical');
    expect(events[0]!.alertSource).toBe('q_loop');
    expect(events[0]!.summary).toBe('BOT ERRORS heartbeat watchdog stale: q_loop');
    expect(events[0]!.evidence).toContain('q-loop heartbeat stale: age_seconds=900');
  });

  it('suppresses duplicate open heartbeat alerts and sends one recovery clear', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-heartbeat-'));
    const qLoopState = join(tmpRoot, 'q-loop-state.json');
    writePrivateJson(qLoopState, { updated_at: 100 });
    const env = {
      BOT_ERRORS_STATE_DIR: tmpRoot,
      BOT_ERRORS_Q_LOOP_STATE: qLoopState,
      BOT_ERRORS_WATCHDOG_CHECKS: 'q_loop',
      BOT_ERRORS_WATCHDOG_RECOVERY_CONFIRMATIONS: '1',
      BOT_ERRORS_DRY_NOW: '1000',
      BOT_ERRORS_MAX_Q_LOOP_AGE: '60',
    };

    runWatchdog(env);
    runWatchdog(env);
    expect(readOutboxEvents()).toHaveLength(1);

    writePrivateJson(qLoopState, { updated_at: 990 });
    runWatchdog({ ...env, BOT_ERRORS_DRY_NOW: '1001' });

    const events = readOutboxEvents();
    expect(events).toHaveLength(2);
    expect(events[1]!.eventType).toBe('clear');
    expect(events[1]!.summary).toBe('BOT ERRORS heartbeat watchdog recovered: q_loop');
    expect(events[1]!.evidence).toContain('suppressed_duplicates=1');
  });

  it('does not emit when configured heartbeats are fresh', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-heartbeat-'));
    const qLoopState = join(tmpRoot, 'q-loop-state.json');
    writePrivateJson(qLoopState, { updated_at: 995 });

    const output = runWatchdog({
      BOT_ERRORS_STATE_DIR: tmpRoot,
      BOT_ERRORS_Q_LOOP_STATE: qLoopState,
      BOT_ERRORS_WATCHDOG_CHECKS: 'q_loop',
      BOT_ERRORS_DRY_NOW: '1000',
      BOT_ERRORS_MAX_Q_LOOP_AGE: '60',
    });

    expect(output).toContain('"problems": []');
    expect(() => readdirSync(join(tmpRoot, 'outbox'))).toThrow();
  });

  it('emits when daily health cadence is missing or stale', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-heartbeat-'));

    runWatchdog({
      BOT_ERRORS_STATE_DIR: tmpRoot,
      BOT_ERRORS_WATCHDOG_CHECKS: 'daily_health',
      BOT_ERRORS_DRY_NOW: '1000',
      BOT_ERRORS_DRY_DAILY_HEALTH_AGE_SECONDS: String(26 * 60 * 60),
      BOT_ERRORS_MAX_DAILY_HEALTH_AGE: String(25 * 60 * 60),
    });

    const events = readOutboxEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.alertSource).toBe('daily_health');
    expect(events[0]!.summary).toBe('BOT ERRORS heartbeat watchdog stale: daily_health');
    expect(events[0]!.evidence).toContain('daily-health cadence stale');
  });

  it('checks daily health cadence per expected host instead of fleet aggregate newest', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-heartbeat-'));
    const sent = join(tmpRoot, 'sent');
    mkdirSync(sent, { recursive: true });
    const mini1Event = join(sent, '20260531T000000Z.relay-mini1.bot-errors-health.daily-health.health-mini1.json.1000.sent');
    writeFileSync(mini1Event, JSON.stringify({
      source: 'daily-health',
      diagnostics: { relay: { remoteHost: 'mini1' } },
    }));
    const fresh = new Date(Date.now() - 5_000);
    utimesSync(mini1Event, fresh, fresh);

    runWatchdog({
      BOT_ERRORS_STATE_DIR: tmpRoot,
      BOT_ERRORS_WATCHDOG_CHECKS: 'daily_health',
      BOT_ERRORS_DAILY_HEALTH_HOSTS: 'mini1,mini2',
      BOT_ERRORS_MAX_DAILY_HEALTH_AGE: String(25 * 60 * 60),
    });

    const events = readOutboxEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.alertSource).toBe('daily_health:mini2');
    expect(events[0]!.summary).toBe('BOT ERRORS heartbeat watchdog stale: daily_health:mini2');
    expect(events[0]!.evidence).toContain('daily-health cadence stale for mini2');
  });

  it('treats suppressed daily-health info events as freshness evidence', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-heartbeat-'));
    const suppressed = join(tmpRoot, 'suppressed');
    mkdirSync(suppressed, { recursive: true });
    const mini1Event = join(suppressed, '20260531T000000Z.relay-mini1.bot-errors-health.daily-health.health-mini1.json.1000.suppressed');
    writeFileSync(mini1Event, JSON.stringify({
      source: 'daily-health',
      diagnostics: { relay: { remoteHost: 'mini1' } },
      delivery: { status: 'suppressed' },
    }));
    const fresh = new Date(Date.now() - 5_000);
    utimesSync(mini1Event, fresh, fresh);

    const output = runWatchdog({
      BOT_ERRORS_STATE_DIR: tmpRoot,
      BOT_ERRORS_WATCHDOG_CHECKS: 'daily_health',
      BOT_ERRORS_DAILY_HEALTH_HOSTS: 'mini1',
      BOT_ERRORS_MAX_DAILY_HEALTH_AGE: String(25 * 60 * 60),
    });

    expect(output).toContain('"problems": []');
    expect(() => readdirSync(join(tmpRoot, 'outbox'))).toThrow();
  });

  it('derives expected daily-health hosts from collector configured remotes', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-heartbeat-'));
    writePrivateJson(join(tmpRoot, 'collector-state.json'), {
      configuredRemoteHosts: ['mini1', 'mini2'],
    });
    const sent = join(tmpRoot, 'sent');
    mkdirSync(sent, { recursive: true });
    const mini1Event = join(sent, '20260531T000000Z.relay-mini1.bot-errors-health.daily-health.health-mini1.json.1000.sent');
    writeFileSync(mini1Event, JSON.stringify({
      source: 'daily-health',
      diagnostics: { relay: { remoteHost: 'mini1' } },
    }));
    const fresh = new Date(Date.now() - 5_000);
    utimesSync(mini1Event, fresh, fresh);

    runWatchdog({
      BOT_ERRORS_STATE_DIR: tmpRoot,
      BOT_ERRORS_WATCHDOG_CHECKS: 'daily_health',
      BOT_ERRORS_LOCAL_DAILY_HEALTH_HOSTS: '',
      BOT_ERRORS_MAX_DAILY_HEALTH_AGE: String(25 * 60 * 60),
    });

    const events = readOutboxEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.alertSource).toBe('daily_health:mini2');
    expect(events[0]!.evidence).toContain('daily-health cadence stale for mini2');
  });

  it('uses file mtimes for dispatcher and collector state freshness', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-heartbeat-'));
    const dispatcher = join(tmpRoot, 'dispatcher-state.json');
    const collector = join(tmpRoot, 'collector-state.json');
    writePrivateJson(dispatcher, {});
    writePrivateJson(collector, {});
    const old = new Date(Date.now() - 600_000);
    utimesSync(dispatcher, old, old);
    utimesSync(collector, old, old);

    runWatchdog({
      BOT_ERRORS_STATE_DIR: tmpRoot,
      BOT_ERRORS_WATCHDOG_CHECKS: 'dispatcher,collector',
      BOT_ERRORS_MAX_DISPATCHER_AGE: '60',
      BOT_ERRORS_MAX_COLLECTOR_AGE: '60',
    });

    const events = readOutboxEvents();
    expect(events.map((event) => event.alertSource).sort()).toEqual(['collector', 'dispatcher']);
  });
});
