import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
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
  return readdirSync(outbox).filter((file) => file !== '.durable-json.lock').sort().map((file) => JSON.parse(readFileSync(join(outbox, file), 'utf8')) as {
    eventType: string;
    severity: string;
    summary: string;
    evidence: string;
    alertSource: string;
    diagnostics?: { forceNotify?: boolean };
  });
}

function writePrivateJson(path: string, payload: unknown): void {
  writeFileSync(path, JSON.stringify(payload));
  chmodSync(path, 0o600);
}

describe('bot-errors-heartbeat-watchdog', () => {
  it('publishes watchdog state through the durable state contract', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-heartbeat-'));
    const output = execFileSync('python3', ['-c', `
import importlib.util, json
from pathlib import Path
spec = importlib.util.spec_from_file_location("watchdog", "deploy/scripts/bot-errors-heartbeat-watchdog.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m.os.environ["BOT_ERRORS_STATE_DIR"] = ${JSON.stringify(tmpRoot)}
m.os.environ["BOT_ERRORS_DRY_NOW"] = "1000"
m.save_state({"version": 1, "open": {}})
target = m.watchdog_state_path()
print(json.dumps({
    "exists": target.exists(),
    "version": json.loads(target.read_text())["version"],
    "mode": target.stat().st_mode & 0o777,
    "lockMode": (target.parent / ".durable-json.lock").stat().st_mode & 0o777,
}))
`], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(JSON.parse(output)).toEqual({ exists: true, version: 1, mode: 0o600, lockMode: 0o600 });
  });

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

  it('suppresses duplicate open heartbeat alerts and confirms recovery before sending one clear', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-heartbeat-'));
    const qLoopState = join(tmpRoot, 'q-loop-state.json');
    writePrivateJson(qLoopState, { updated_at: 100 });
    const env = {
      BOT_ERRORS_STATE_DIR: tmpRoot,
      BOT_ERRORS_Q_LOOP_STATE: qLoopState,
      BOT_ERRORS_WATCHDOG_CHECKS: 'q_loop',
      BOT_ERRORS_DRY_NOW: '1000',
      BOT_ERRORS_MAX_Q_LOOP_AGE: '60',
    };

    runWatchdog(env);
    runWatchdog(env);
    expect(readOutboxEvents()).toHaveLength(1);

    writePrivateJson(qLoopState, { updated_at: 990 });
    runWatchdog({ ...env, BOT_ERRORS_DRY_NOW: '1001' });
    expect(readOutboxEvents()).toHaveLength(1);

    runWatchdog({ ...env, BOT_ERRORS_DRY_NOW: '1002' });
    const events = readOutboxEvents();
    expect(events).toHaveLength(2);
    expect(events[1]!.eventType).toBe('clear');
    expect(events[1]!.alertSource).toBe('q_loop');
    expect(events[1]!.summary).toBe('BOT ERRORS heartbeat watchdog recovered: q_loop');
    expect(events[1]!.evidence).toContain('suppressed_duplicates=1');
    expect(events[1]!.evidence).toContain('recovery_observations=2');
  });

  it('redacts credential material from watchdog events, state, and logs', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-heartbeat-'));
    const evidence = [
      'credential probe failed',
      'Authorization: Bearer rawBearerSecret123',
      'token=rawTokenSecret123',
      'access_token="rawAccessSecret123"',
      'path=/Users/testuser/.config/whatsoup/bot-errors.env',
      'auth_tree=/Users/testuser/.local/share/whatsoup/instances/example-bot/auth/session-creds.json',
      'auth_failure_class=serverside_logout_irreversible',
    ].join(' ');

    execFileSync('python3', ['-c', `
import importlib.util
import os
spec = importlib.util.spec_from_file_location("watchdog", "deploy/scripts/bot-errors-heartbeat-watchdog.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
os.environ["BOT_ERRORS_STATE_DIR"] = ${JSON.stringify(tmpRoot)}
os.environ["BOT_ERRORS_DRY_NOW"] = "1000"
evidence = ${JSON.stringify(evidence)}
m.reconcile({"credential_probe": evidence}, ["credential_probe"])
m.reconcile({"credential_probe": evidence}, ["credential_probe"])
`], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    const combined = [
      JSON.stringify(readOutboxEvents()),
      readFileSync(join(tmpRoot, 'heartbeat-watchdog-state.json'), 'utf8'),
      readFileSync(join(tmpRoot, 'logs', 'heartbeat-watchdog.jsonl'), 'utf8'),
    ].join('\n');

    expect(combined).not.toContain('rawBearerSecret123');
    expect(combined).not.toContain('rawTokenSecret123');
    expect(combined).not.toContain('rawAccessSecret123');
    expect(combined).not.toContain('/Users/testuser/.config/whatsoup/bot-errors.env');
    expect(combined).not.toContain('/Users/testuser/.local/share/whatsoup/instances/example-bot/auth/session-creds.json');
    expect(combined).toContain('Authorization: Bearer [REDACTED]');
    expect(combined).toContain('token=[REDACTED]');
    expect(combined).toContain('access_token=\\"[REDACTED]\\"');
    expect(combined).toContain('[REDACTED_CREDENTIAL_PATH]');
    expect(combined).toContain('auth_failure_class=serverside_logout_irreversible');
  });

  it('re-notifies a still-open heartbeat after the bounded suppression threshold', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-heartbeat-'));
    const qLoopState = join(tmpRoot, 'q-loop-state.json');
    writePrivateJson(qLoopState, { updated_at: 100 });
    const env = {
      BOT_ERRORS_STATE_DIR: tmpRoot,
      BOT_ERRORS_Q_LOOP_STATE: qLoopState,
      BOT_ERRORS_WATCHDOG_CHECKS: 'q_loop',
      BOT_ERRORS_MAX_Q_LOOP_AGE: '60',
      BOT_ERRORS_WATCHDOG_RENOTIFY_SECONDS: '600',
      BOT_ERRORS_WATCHDOG_ESCALATE_SECONDS: '3600',
      BOT_ERRORS_WATCHDOG_ESCALATE_SUPPRESSED: '99',
    };

    runWatchdog({ ...env, BOT_ERRORS_DRY_NOW: '1000' });
    runWatchdog({ ...env, BOT_ERRORS_DRY_NOW: '1200' });
    expect(readOutboxEvents()).toHaveLength(1);

    runWatchdog({ ...env, BOT_ERRORS_DRY_NOW: '1700' });

    const events = readOutboxEvents();
    expect(events).toHaveLength(2);
    const stillOpen = events.find((event) => event.summary.includes('still open'));
    expect(stillOpen).toMatchObject({
      eventType: 'alert',
      severity: 'warning',
      alertSource: 'q_loop',
      diagnostics: { forceNotify: true },
    });
    expect(stillOpen!.evidence).toContain('incident_still_open=true');
    expect(stillOpen!.evidence).toContain('suppressed_duplicates=2');
  });

  it('keeps incident age non-decreasing when the wall clock moves backward', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-heartbeat-'));
    const qLoopState = join(tmpRoot, 'q-loop-state.json');
    writePrivateJson(qLoopState, { updated_at: 100 });
    const env = {
      BOT_ERRORS_STATE_DIR: tmpRoot,
      BOT_ERRORS_Q_LOOP_STATE: qLoopState,
      BOT_ERRORS_WATCHDOG_CHECKS: 'q_loop',
      BOT_ERRORS_MAX_Q_LOOP_AGE: '60',
      BOT_ERRORS_WATCHDOG_RENOTIFY_SECONDS: '9999',
    };

    runWatchdog({ ...env, BOT_ERRORS_DRY_NOW: '1000' });
    runWatchdog({ ...env, BOT_ERRORS_DRY_NOW: '2000' });
    runWatchdog({ ...env, BOT_ERRORS_DRY_NOW: '1500' });

    const state = JSON.parse(readFileSync(join(tmpRoot, 'heartbeat-watchdog-state.json'), 'utf8')) as {
      open: { q_loop: { ageSeconds: number; suppressed: number } };
    };
    expect(state.open.q_loop.ageSeconds).toBe(1000);
    expect(state.open.q_loop.suppressed).toBe(2);
  });

  it('rejects non-positive watchdog escalation thresholds at startup', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-heartbeat-'));
    let status = 0;
    let stderr = '';
    try {
      execFileSync('python3', ['deploy/scripts/bot-errors-heartbeat-watchdog.py', '--once'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          BOT_ERRORS_STATE_DIR: tmpRoot,
          BOT_ERRORS_WATCHDOG_CHECKS: 'q_loop',
          BOT_ERRORS_WATCHDOG_RENOTIFY_SECONDS: '0',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (error) {
      const failed = error as { status?: number; stderr?: Buffer | string };
      status = failed.status ?? 1;
      stderr = String(failed.stderr ?? '');
    }

    expect(status).not.toBe(0);
    expect(stderr).toContain('BOT_ERRORS_WATCHDOG_RENOTIFY_SECONDS must be a positive integer');
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

  it('alerts when q-loop state is fresh but corrupt JSON', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-heartbeat-'));
    const qLoopState = join(tmpRoot, 'q-loop-state.json');
    writeFileSync(qLoopState, '{"updated_at":');
    chmodSync(qLoopState, 0o600);

    runWatchdog({
      BOT_ERRORS_STATE_DIR: tmpRoot,
      BOT_ERRORS_Q_LOOP_STATE: qLoopState,
      BOT_ERRORS_WATCHDOG_CHECKS: 'q_loop',
      BOT_ERRORS_DRY_NOW: '1000',
      BOT_ERRORS_MAX_Q_LOOP_AGE: '60',
    });

    const events = readOutboxEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.alertSource).toBe('q_loop');
    expect(events[0]!.severity).toBe('critical');
    expect(events[0]!.evidence).toContain('age_seconds=missing');
    expect(events[0]!.evidence).toContain('invalid JSON');
  });

  it('alerts when q-loop state is fresh but lacks numeric updated_at', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-heartbeat-'));
    const qLoopState = join(tmpRoot, 'q-loop-state.json');
    writePrivateJson(qLoopState, { phase: 'monitoring', updated_at: '1000' });

    runWatchdog({
      BOT_ERRORS_STATE_DIR: tmpRoot,
      BOT_ERRORS_Q_LOOP_STATE: qLoopState,
      BOT_ERRORS_WATCHDOG_CHECKS: 'q_loop',
      BOT_ERRORS_DRY_NOW: '1000',
      BOT_ERRORS_MAX_Q_LOOP_AGE: '60',
    });

    const events = readOutboxEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.alertSource).toBe('q_loop');
    expect(events[0]!.severity).toBe('critical');
    expect(events[0]!.evidence).toContain('age_seconds=missing');
    expect(events[0]!.evidence).toContain('missing numeric updated_at');
  });

  it('honors BOT_ERRORS_Q_LOOP_STATE_DIR and refuses symlinked q-loop state', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-heartbeat-'));
    const qLoopStateDir = join(tmpRoot, 'q-loop-state-dir');
    mkdirSync(qLoopStateDir, { recursive: true });
    chmodSync(qLoopStateDir, 0o700);
    const qLoopState = join(qLoopStateDir, 'state.json');
    writePrivateJson(qLoopState, { updated_at: 995 });
    const env = {
      BOT_ERRORS_STATE_DIR: tmpRoot,
      BOT_ERRORS_Q_LOOP_STATE_DIR: qLoopStateDir,
      BOT_ERRORS_WATCHDOG_CHECKS: 'q_loop',
      BOT_ERRORS_DRY_NOW: '1000',
      BOT_ERRORS_MAX_Q_LOOP_AGE: '60',
    };

    expect(runWatchdog(env)).toContain('"problems": []');

    const outside = join(tmpRoot, 'outside-state.json');
    writePrivateJson(outside, { updated_at: 999 });
    rmSync(qLoopState);
    symlinkSync(outside, qLoopState);
    runWatchdog({ ...env, BOT_ERRORS_DRY_NOW: '1001' });

    const events = readOutboxEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.alertSource).toBe('q_loop');
    expect(events[0]!.evidence).toContain('refusing to trust symlinked critical file');
    expect(events[0]!.evidence).toContain('age_seconds=missing');
  });

  it('refuses fresh q-loop state stored under a non-private directory', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-heartbeat-'));
    const qLoopStateDir = join(tmpRoot, 'q-loop-state-dir');
    mkdirSync(qLoopStateDir, { recursive: true });
    chmodSync(qLoopStateDir, 0o755);
    writePrivateJson(join(qLoopStateDir, 'state.json'), { updated_at: 995 });

    runWatchdog({
      BOT_ERRORS_STATE_DIR: tmpRoot,
      BOT_ERRORS_Q_LOOP_STATE_DIR: qLoopStateDir,
      BOT_ERRORS_WATCHDOG_CHECKS: 'q_loop',
      BOT_ERRORS_DRY_NOW: '1000',
      BOT_ERRORS_MAX_Q_LOOP_AGE: '60',
    });

    const events = readOutboxEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.alertSource).toBe('q_loop');
    expect(events[0]!.evidence).toContain('refusing to trust critical file in non-private directory');
    expect(events[0]!.evidence).toContain('mode=755');
  });

  it('warns (non-paging capacity) when q-loop is fresh but Q is unavailable due to session limit', () => {
    // A session-limit / usage-window cap is self-recovering: it must surface as
    // a WARNING capacity incident (q_loop:supervisor:capacity), never a CRITICAL
    // supervisor-failure page. Paging on it is the broken-alert anti-pattern.
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-heartbeat-'));
    const qLoopState = join(tmpRoot, 'q-loop-state.json');
    writePrivateJson(qLoopState, {
      updated_at: 995,
      phase: 'q_unavailable_session_limit',
      last_q_unavailable_at: 990,
      last_q_unavailable_reason: 'session_limit',
    });

    runWatchdog({
      BOT_ERRORS_STATE_DIR: tmpRoot,
      BOT_ERRORS_Q_LOOP_STATE: qLoopState,
      BOT_ERRORS_WATCHDOG_CHECKS: 'q_loop',
      BOT_ERRORS_DRY_NOW: '1000',
      BOT_ERRORS_MAX_Q_LOOP_AGE: '60',
    });

    const events = readOutboxEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.severity).toBe('warning');
    expect(events[0]!.alertSource).toBe('q_loop:supervisor:capacity');
    expect(events[0]!.summary).toBe('BOT ERRORS heartbeat watchdog capacity: q_loop:supervisor:capacity');
    expect(events[0]!.evidence).toContain('q-loop at usage-window capacity');
    expect(events[0]!.evidence).toContain('phase=q_unavailable_session_limit');
    expect(events[0]!.evidence).toContain('reason=session_limit');
    expect(events[0]!.evidence).toContain(
      'No action required; Q is at usage-window capacity and self-recovers when the window resets.',
    );
  });

  it('pages critical when q-loop is unavailable for a genuine (non-capacity) reason', () => {
    // Regression guard: capping capacity reasons at warning must NOT swallow a
    // real supervisor failure. A non-capacity reason (e.g. a crash) still routes
    // to q_loop:supervisor and pages critical.
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-heartbeat-'));
    const qLoopState = join(tmpRoot, 'q-loop-state.json');
    writePrivateJson(qLoopState, {
      updated_at: 995,
      phase: 'q_unavailable_crash',
      last_q_unavailable_at: 990,
      last_q_unavailable_reason: 'crash',
    });

    runWatchdog({
      BOT_ERRORS_STATE_DIR: tmpRoot,
      BOT_ERRORS_Q_LOOP_STATE: qLoopState,
      BOT_ERRORS_WATCHDOG_CHECKS: 'q_loop',
      BOT_ERRORS_DRY_NOW: '1000',
      BOT_ERRORS_MAX_Q_LOOP_AGE: '60',
    });

    const events = readOutboxEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.severity).toBe('critical');
    expect(events[0]!.alertSource).toBe('q_loop:supervisor');
    expect(events[0]!.summary).toBe('BOT ERRORS heartbeat watchdog stale: q_loop:supervisor');
    expect(events[0]!.evidence).toContain('q-loop supervisor unavailable');
    expect(events[0]!.evidence).toContain('phase=q_unavailable_crash');
    expect(events[0]!.evidence).toContain('reason=crash');
  });

  it('warns without paging when a detached browser debug tree exceeds age and RSS thresholds', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-heartbeat-'));
    const profilePath = '/private/operator/browser-profile';
    runWatchdog({
      BOT_ERRORS_STATE_DIR: tmpRoot,
      BOT_ERRORS_WATCHDOG_CHECKS: 'browser_debug',
      BOT_ERRORS_DRY_BROWSER_DEBUG_SNAPSHOT: JSON.stringify([
        {
          pid: 4242,
          ageSeconds: 4200,
          rssMb: 2519.3,
          processCount: 16,
          debugPort: 9334,
          controllerConnections: 0,
          profileHash: 'profileabc123',
          profilePath,
        },
      ]),
    });

    const events = readOutboxEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.severity).toBe('warning');
    expect(events[0]!.alertSource).toBe('browser_debug:profileabc123');
    expect(events[0]!.summary).toBe('BOT ERRORS browser debug session unattended: browser_debug:profileabc123');
    expect(events[0]!.diagnostics?.forceNotify).not.toBe(true);
    expect(events[0]!.evidence).toContain('root_pid=4242');
    expect(events[0]!.evidence).toContain('rss_mb=2519.3');
    expect(events[0]!.evidence).toContain('process_count=16');
    expect(events[0]!.evidence).toContain('controller_connections=0');
    expect(events[0]!.evidence).not.toContain(profilePath);
  });

  it('does not alert for a browser debug tree with an active controller or below-threshold resources', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-heartbeat-'));
    runWatchdog({
      BOT_ERRORS_STATE_DIR: tmpRoot,
      BOT_ERRORS_WATCHDOG_CHECKS: 'browser_debug',
      BOT_ERRORS_DRY_BROWSER_DEBUG_SNAPSHOT: JSON.stringify([
        {
          pid: 4242,
          ageSeconds: 4200,
          rssMb: 2519.3,
          processCount: 16,
          debugPort: 9334,
          controllerConnections: 1,
          profileHash: 'controlled',
        },
        {
          pid: 4343,
          ageSeconds: 4200,
          rssMb: 128,
          processCount: 4,
          debugPort: 9335,
          controllerConnections: 0,
          profileHash: 'small',
        },
        {
          pid: 4444,
          ageSeconds: 300,
          rssMb: 2048,
          processCount: 12,
          debugPort: 9336,
          controllerConnections: 0,
          profileHash: 'young',
        },
      ]),
    });

    expect(existsSync(join(tmpRoot, 'outbox'))).toBe(false);
  });

  it('alerts on missing controller visibility without asserting the session is unattended', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-heartbeat-'));
    runWatchdog({
      BOT_ERRORS_STATE_DIR: tmpRoot,
      BOT_ERRORS_WATCHDOG_CHECKS: 'browser_debug',
      BOT_ERRORS_DRY_BROWSER_DEBUG_SNAPSHOT: JSON.stringify([
        {
          pid: 4545,
          ageSeconds: 4200,
          rssMb: 2048,
          processCount: 10,
          debugPort: 9337,
          controllerConnections: null,
          profileHash: 'unknowncontroller',
        },
      ]),
    });

    const events = readOutboxEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.severity).toBe('warning');
    expect(events[0]!.alertSource).toBe('browser_debug:probe');
    expect(events[0]!.summary).toBe('BOT ERRORS browser debug visibility degraded: browser_debug:probe');
    expect(events[0]!.evidence).toContain('controller_connections=unknown');
    expect(events[0]!.evidence).not.toContain('session unattended');
  });

  it('confirms browser debug recovery twice before clearing the incident', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-heartbeat-'));
    const env = {
      BOT_ERRORS_STATE_DIR: tmpRoot,
      BOT_ERRORS_WATCHDOG_CHECKS: 'browser_debug',
      BOT_ERRORS_DRY_BROWSER_DEBUG_SNAPSHOT: JSON.stringify([
        {
          pid: 4242,
          ageSeconds: 4200,
          rssMb: 2519.3,
          processCount: 16,
          debugPort: 9334,
          controllerConnections: 0,
          profileHash: 'profileabc123',
        },
      ]),
    };

    runWatchdog(env);
    runWatchdog({ ...env, BOT_ERRORS_DRY_BROWSER_DEBUG_SNAPSHOT: '[]' });
    expect(readOutboxEvents()).toHaveLength(1);
    runWatchdog({ ...env, BOT_ERRORS_DRY_BROWSER_DEBUG_SNAPSHOT: '[]' });

    const events = readOutboxEvents();
    expect(events).toHaveLength(2);
    expect(events[1]!.eventType).toBe('clear');
    expect(events[1]!.alertSource).toBe('browser_debug:profileabc123');
    expect(events[1]!.summary).toBe('BOT ERRORS heartbeat watchdog recovered: browser_debug:profileabc123');
  });

  it('warns when q-loop heartbeat is fresh but awaiting-Q behavior is stale', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-heartbeat-'));
    const qLoopState = join(tmpRoot, 'q-loop-state.json');
    writePrivateJson(qLoopState, {
      updated_at: 1895,
      phase: 'monitoring',
      awaiting_q_since: 100,
      last_q_message_at: 0,
    });

    runWatchdog({
      BOT_ERRORS_STATE_DIR: tmpRoot,
      BOT_ERRORS_Q_LOOP_STATE: qLoopState,
      BOT_ERRORS_WATCHDOG_CHECKS: 'q_loop',
      BOT_ERRORS_DRY_NOW: '1900',
      BOT_ERRORS_MAX_Q_LOOP_AGE: '60',
      BOT_ERRORS_MAX_AWAITING_Q_AGE: '1200',
    });

    const events = readOutboxEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.severity).toBe('warning');
    expect(events[0]!.alertSource).toBe('q_loop:awaiting_q');
    expect(events[0]!.summary).toBe('BOT ERRORS heartbeat watchdog stale: q_loop:awaiting_q');
    expect(events[0]!.evidence).toContain('q-loop awaiting Q stale');
    expect(events[0]!.evidence).toContain('age_seconds=1800');
    expect(events[0]!.evidence).toContain('phase=monitoring');
    expect(events[0]!.evidence).not.toContain('@g.us');
    expect(events[0]!.evidence).not.toContain('@s.whatsapp.net');
    expect(events[0]!.evidence).not.toContain('@lid');
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

  it('treats storm-collapsed daily-health events as freshness evidence', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-heartbeat-'));
    const collapsed = join(tmpRoot, 'storm-collapsed');
    mkdirSync(collapsed, { recursive: true });
    const mini1Event = join(collapsed, '19700101T001500Z.relay-mini1.bot-errors-health.daily-health.health-mini1.json.storm-test.1000.collapsed');
    writeFileSync(mini1Event, JSON.stringify({
      source: 'daily-health',
      createdAt: '1970-01-01T00:15:00Z',
      diagnostics: { relay: { remoteHost: 'mini1' } },
      delivery: { status: 'storm-collapsed' },
    }));

    const output = runWatchdog({
      BOT_ERRORS_STATE_DIR: tmpRoot,
      BOT_ERRORS_WATCHDOG_CHECKS: 'daily_health',
      BOT_ERRORS_DAILY_HEALTH_HOSTS: 'mini1',
      BOT_ERRORS_DRY_NOW: '1000',
      BOT_ERRORS_MAX_DAILY_HEALTH_AGE: '200',
    });

    expect(output).toContain('"problems": []');
    expect(() => readdirSync(join(tmpRoot, 'outbox'))).toThrow();
  });

  it('uses daily-health event createdAt before file mtime for freshness', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-heartbeat-'));
    const sent = join(tmpRoot, 'sent');
    mkdirSync(sent, { recursive: true });
    const mini1Event = join(sent, '20260531T000000Z.relay-mini1.bot-errors-health.daily-health.health-mini1.json.1000.sent');
    writeFileSync(mini1Event, JSON.stringify({
      source: 'daily-health',
      createdAt: '1970-01-01T00:00:00Z',
      diagnostics: { relay: { remoteHost: 'mini1' } },
    }));
    const fresh = new Date(Date.now() - 5_000);
    utimesSync(mini1Event, fresh, fresh);

    runWatchdog({
      BOT_ERRORS_STATE_DIR: tmpRoot,
      BOT_ERRORS_WATCHDOG_CHECKS: 'daily_health',
      BOT_ERRORS_DAILY_HEALTH_HOSTS: 'mini1',
      BOT_ERRORS_DRY_NOW: String(26 * 60 * 60),
      BOT_ERRORS_MAX_DAILY_HEALTH_AGE: String(25 * 60 * 60),
    });

    const events = readOutboxEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.alertSource).toBe('daily_health:mini1');
    expect(events[0]!.evidence).toContain('daily-health cadence stale for mini1');
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

  it('enriches stale daily-health evidence with the collector reachability diagnosis', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-heartbeat-'));
    writePrivateJson(join(tmpRoot, 'collector-state.json'), {
      configuredRemoteHosts: ['mini2'],
      remotes: {
        mini2: {
          consecutiveFailures: 33,
          lastSuccessIso: '2026-07-21T02:29:31Z',
          lastReachability: {
            reachabilityDiagnosis: 'tailscale_offline',
            tailscale: {
              online: false,
              lastSeen: '2026-07-21T02:29:48.1Z',
              tailscaleIPs: ['100.64.0.1'],
            },
          },
        },
      },
    });

    runWatchdog({
      BOT_ERRORS_STATE_DIR: tmpRoot,
      BOT_ERRORS_WATCHDOG_CHECKS: 'daily_health',
      BOT_ERRORS_LOCAL_DAILY_HEALTH_HOSTS: '',
      BOT_ERRORS_MAX_DAILY_HEALTH_AGE: '60',
    });

    const events = readOutboxEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.evidence).toContain('collector_reachability=tailscale_offline');
    expect(events[0]!.evidence).toContain('collector_consecutive_failures=33');
    expect(events[0]!.evidence).toContain('collector_last_success=2026-07-21T02:29:31Z');
    expect(events[0]!.evidence).toContain('tailscale_online=false');
    expect(events[0]!.evidence).toContain('tailscale_last_seen=2026-07-21T02:29:48.1Z');
    expect(events[0]!.evidence).not.toContain('100.64.0.1');
  });

  it('excludes collector best-effort remotes from required daily-health cadence', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-heartbeat-'));
    writePrivateJson(join(tmpRoot, 'collector-state.json'), {
      configuredRemoteHosts: ['mini1', 'gupta'],
      configuredBestEffortRemoteHosts: ['gupta'],
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

    const output = runWatchdog({
      BOT_ERRORS_STATE_DIR: tmpRoot,
      BOT_ERRORS_WATCHDOG_CHECKS: 'daily_health',
      BOT_ERRORS_LOCAL_DAILY_HEALTH_HOSTS: '',
      BOT_ERRORS_MAX_DAILY_HEALTH_AGE: String(25 * 60 * 60),
    });

    expect(output).toContain('"problems": []');
    expect(() => readdirSync(join(tmpRoot, 'outbox'))).toThrow();
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

  it('emits when an expected local WhatSoup service is inactive', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-heartbeat-'));
    const profile = join(tmpRoot, 'health-profile.json');
    writeFileSync(profile, JSON.stringify({
      instances: [
        { name: 'agent-alpha', expected: 'always_on', service: 'whatsoup-agent-alpha.service' },
        { name: 'agent-beta', expected: 'always_on', service: 'whatsoup-agent-beta.service' },
        { name: 'adhoc', expected: 'manual', service: 'whatsoup-adhoc.service' },
      ],
    }));

    runWatchdog({
      BOT_ERRORS_STATE_DIR: tmpRoot,
      BOT_ERRORS_WATCHDOG_CHECKS: 'local_services',
      BOT_ERRORS_HEALTH_PROFILE: profile,
      BOT_ERRORS_DRY_SERVICE_STATES: 'whatsoup-agent-alpha.service=inactive,whatsoup-agent-beta.service=active',
    });

    const events = readOutboxEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.severity).toBe('critical');
    expect(events[0]!.alertSource).toBe('local_service:whatsoup-agent-alpha.service');
    expect(events[0]!.summary).toBe('BOT ERRORS heartbeat watchdog stale: local_service:whatsoup-agent-alpha.service');
    expect(events[0]!.evidence).toContain('local service inactive: service=whatsoup-agent-alpha.service');
    expect(events[0]!.evidence).toContain('status=inactive');
    expect(events[0]!.evidence).toContain('expected=always_on');
    expect(events[0]!.evidence).not.toContain('adhoc');
  });

  it('emits when a local WhatSoup instance is running but WhatsApp auth is logged out', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-heartbeat-'));
    const profile = join(tmpRoot, 'health-profile.json');
    writeFileSync(profile, JSON.stringify({
      instances: [
        { name: 'agent-alpha', expected: 'always_on', service: 'whatsoup-agent-alpha.service', healthPort: 9092 },
      ],
    }));

    runWatchdog({
      BOT_ERRORS_STATE_DIR: tmpRoot,
      BOT_ERRORS_WATCHDOG_CHECKS: 'local_instance_health',
      BOT_ERRORS_HEALTH_PROFILE: profile,
      BOT_ERRORS_DRY_LOCAL_HEALTH_RESPONSES: JSON.stringify({
        'agent-alpha': {
          status: 200,
          body: {
            status: 'unhealthy',
            instance: { name: 'agent-alpha' },
            whatsapp: {
              connected: false,
              connection: {
                state: 'close',
                last_status_code: 401,
                last_disconnect_reason: 'loggedOut',
                auth_failure_class: 'serverside_logout_irreversible',
              },
              auth_bond: { status: 'present', issues: [] },
            },
          },
        },
      }),
    });

    const events = readOutboxEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.severity).toBe('critical');
    expect(events[0]!.alertSource).toBe('local_health:agent-alpha');
    expect(events[0]!.summary).toBe('BOT ERRORS heartbeat watchdog stale: local_health:agent-alpha');
    expect(events[0]!.evidence).toContain('local instance health failure: instance=agent-alpha');
    expect(events[0]!.evidence).toContain('health_status=unhealthy');
    expect(events[0]!.evidence).toContain('connected=false');
    expect(events[0]!.evidence).toContain('auth_failure_class=serverside_logout_irreversible');
    expect(events[0]!.evidence).toContain('last_status_code=401');
    expect(events[0]!.evidence).toContain('last_disconnect_reason=loggedOut');
  });

  it('does not emit local instance health alerts when WhatsApp is connected and auth is clean', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-heartbeat-'));
    const profile = join(tmpRoot, 'health-profile.json');
    writeFileSync(profile, JSON.stringify({
      instances: [
        { name: 'agent-alpha', expected: 'always_on', service: 'whatsoup-agent-alpha.service', healthPort: 9092 },
      ],
    }));

    const output = runWatchdog({
      BOT_ERRORS_STATE_DIR: tmpRoot,
      BOT_ERRORS_WATCHDOG_CHECKS: 'local_instance_health',
      BOT_ERRORS_HEALTH_PROFILE: profile,
      BOT_ERRORS_DRY_LOCAL_HEALTH_RESPONSES: JSON.stringify({
        'agent-alpha': {
          status: 200,
          body: {
            status: 'healthy',
            instance: { name: 'agent-alpha' },
            whatsapp: {
              connected: true,
              connection: { state: 'connected', auth_failure_class: 'none' },
              auth_bond: { status: 'present', issues: [] },
            },
          },
        },
      }),
    });

    expect(output).toContain('"problems": []');
    expect(() => readdirSync(join(tmpRoot, 'outbox'))).toThrow();
  });

  it('emits when a reachable instance reports degraded runtime health with clean transport', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-heartbeat-'));
    const profile = join(tmpRoot, 'health-profile.json');
    writeFileSync(profile, JSON.stringify({
      instances: [
        { name: 'agent-alpha', expected: 'always_on', service: 'whatsoup-agent-alpha.service', healthPort: 9092 },
      ],
    }));

    runWatchdog({
      BOT_ERRORS_STATE_DIR: tmpRoot,
      BOT_ERRORS_WATCHDOG_CHECKS: 'local_instance_health',
      BOT_ERRORS_HEALTH_PROFILE: profile,
      BOT_ERRORS_DRY_LOCAL_HEALTH_RESPONSES: JSON.stringify({
        'agent-alpha': {
          status: 200,
          body: {
            status: 'degraded',
            degradation_causes: ['finalization_debt', 'recovery_debt'],
            instance: { name: 'agent-alpha' },
            whatsapp: {
              connected: true,
              connection: { state: 'connected', auth_failure_class: 'none' },
              auth_bond: { status: 'present', issues: [] },
            },
          },
        },
      }),
    });

    const events = readOutboxEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.severity).toBe('critical');
    expect(events[0]!.alertSource).toBe('local_health:agent-alpha');
    expect(events[0]!.summary).toBe('BOT ERRORS heartbeat watchdog stale: local_health:agent-alpha');
    expect(events[0]!.evidence).toContain('local instance health failure: instance=agent-alpha');
    expect(events[0]!.evidence).toContain('health_status=degraded');
    expect(events[0]!.evidence).toContain('degradation_causes=finalization_debt,recovery_debt');
    expect(events[0]!.evidence).not.toContain('auth_failure_class=');
  });

  it('does not clear unrelated open incidents during a scoped watchdog run', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-heartbeat-'));
    const profile = join(tmpRoot, 'health-profile.json');
    writeFileSync(profile, JSON.stringify({
      instances: [
        { name: 'agent-alpha', expected: 'always_on', service: 'whatsoup-agent-alpha.service' },
      ],
    }));
    writePrivateJson(join(tmpRoot, 'heartbeat-watchdog-state.json'), {
      version: 1,
      open: {
        'daily_health:agent-gamma': {
          firstSeenAt: '2026-06-11T00:00:00Z',
          lastSeenAt: '2026-06-11T00:00:00Z',
          lastNotifiedAt: '2026-06-11T00:00:00Z',
          lastEvidence: 'daily-health cadence stale for agent-gamma',
          suppressed: 4,
        },
      },
    });

    const output = runWatchdog({
      BOT_ERRORS_STATE_DIR: tmpRoot,
      BOT_ERRORS_WATCHDOG_CHECKS: 'local_services',
      BOT_ERRORS_HEALTH_PROFILE: profile,
      BOT_ERRORS_DRY_SERVICE_STATES: 'whatsoup-agent-alpha.service=active',
    });

    expect(output).toContain('"problems": []');
    expect(() => readdirSync(join(tmpRoot, 'outbox'))).toThrow();
    const state = JSON.parse(readFileSync(join(tmpRoot, 'heartbeat-watchdog-state.json'), 'utf8')) as {
      open?: Record<string, unknown>;
    };
    expect(state.open).toHaveProperty('daily_health:agent-gamma');
  });

  it('emits a continuous watchdog alert for critical outbox backlog', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-heartbeat-'));
    const outbox = join(tmpRoot, 'outbox');
    mkdirSync(outbox, { recursive: true });
    const stuck = join(outbox, 'stuck.json');
    writeFileSync(stuck, '{}');
    const old = new Date(Date.now() - 10_000);
    utimesSync(stuck, old, old);

    runWatchdog({
      BOT_ERRORS_STATE_DIR: tmpRoot,
      BOT_ERRORS_WATCHDOG_CHECKS: 'queue_backlog',
      BOT_ERRORS_WATCHDOG_OUTBOX_CRITICAL_COUNT: '99',
      BOT_ERRORS_WATCHDOG_OUTBOX_CRITICAL_OLDEST_SECONDS: '1',
    });

    const events = readOutboxEvents().filter((event) => event.alertSource === 'queue:outbox');
    expect(events).toHaveLength(1);
    expect(events[0]!.severity).toBe('critical');
    expect(events[0]!.alertSource).toBe('queue:outbox');
    expect(events[0]!.summary).toBe('BOT ERRORS heartbeat watchdog stale: queue:outbox');
    expect(events[0]!.evidence).toContain('outbox backlog critical: count=1');
    expect(events[0]!.evidence).toContain('max_oldest_seconds=1');
  });

  it('emits a continuous watchdog alert when writefail breadcrumbs accumulate', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-heartbeat-'));
    const writefail = join(tmpRoot, 'writefail');
    mkdirSync(writefail, { recursive: true });
    writeFileSync(join(writefail, 'one.writefail'), '{}');

    runWatchdog({
      BOT_ERRORS_STATE_DIR: tmpRoot,
      BOT_ERRORS_WATCHDOG_CHECKS: 'queue_backlog',
      BOT_ERRORS_WATCHDOG_WRITEFAIL_CRITICAL_COUNT: '1',
      BOT_ERRORS_WATCHDOG_WRITEFAIL_CRITICAL_OLDEST_SECONDS: '0',
      TMPDIR: join(tmpRoot, 'tmp'),
      HOME: tmpRoot,
    });

    const events = readOutboxEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.severity).toBe('critical');
    expect(events[0]!.alertSource).toBe('queue:writefail');
    expect(events[0]!.evidence).toContain('writefail backlog critical: count=1');
    expect(events[0]!.evidence).toContain(`${tmpRoot}/writefail`);
  });
});

describe('bot-errors-heartbeat-watchdog transition latch', () => {
  // Production defect (2026-07-17, fleet coordinator host): the q-loop's own outbound nudges
  // reset awaiting_q_since (classify_activity treats any Codex/outbound message
  // containing "reply"/"approve"/"blocked" as a fresh ask), so the
  // q_loop:awaiting_q age sawtooths around BOT_ERRORS_MAX_AWAITING_Q_AGE. Each
  // sawtooth cycle fully recovered the incident (2 clean observations) and then
  // reopened it as a brand-new incident, emitting an alternating stale/recovered
  // pair roughly every NUDGE_COOLDOWN_SECONDS — ~30 messages/day. The watchdog
  // must latch through such oscillation: one stale alert on entry, silence while
  // the flap continues, one recovery once the state durably settles.
  const AWAITING_KEY = 'q_loop:awaiting_q';

  function latchEnv(qLoopState: string): Record<string, string> {
    return {
      BOT_ERRORS_STATE_DIR: tmpRoot,
      BOT_ERRORS_Q_LOOP_STATE: qLoopState,
      BOT_ERRORS_WATCHDOG_CHECKS: 'q_loop',
      BOT_ERRORS_MAX_Q_LOOP_AGE: '600',
      BOT_ERRORS_MAX_AWAITING_Q_AGE: '1200',
    };
  }

  function runAwaiting(qLoopState: string, env: Record<string, string>, now: number, awaitingSince: number): void {
    writePrivateJson(qLoopState, { updated_at: now - 10, awaiting_q_since: awaitingSince, phase: 'monitoring' });
    runWatchdog({ ...env, BOT_ERRORS_DRY_NOW: String(now) });
  }

  function watchdogState(): { open: Record<string, { flapCount?: number }>; recentlyRecovered?: Record<string, unknown> } {
    return JSON.parse(readFileSync(join(tmpRoot, 'heartbeat-watchdog-state.json'), 'utf8'));
  }

  it('pins the oscillating awaiting_q sequence to two stale alerts and one recovery', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-heartbeat-'));
    const qLoopState = join(tmpRoot, 'q-loop-state.json');
    const env = latchEnv(qLoopState);

    // Cycle 1: stale (age 2000 > 1200), stale, nudge-reset, clean x2 -> recovery.
    runAwaiting(qLoopState, env, 10000, 8000);
    runAwaiting(qLoopState, env, 10300, 8000);
    runAwaiting(qLoopState, env, 10600, 10500);
    runAwaiting(qLoopState, env, 10900, 10500);
    let events = readOutboxEvents();
    expect(events).toHaveLength(2);
    expect(events[0]!.summary).toBe(`BOT ERRORS heartbeat watchdog stale: ${AWAITING_KEY}`);
    expect(events[1]!.eventType).toBe('clear');

    // Cycle 2: the condition re-enters stale inside the flap re-arm window. The
    // FIRST reopen still alerts — a genuinely new outage of a recovered key must
    // page immediately — carrying the flap context of the prior incident.
    runAwaiting(qLoopState, env, 11900, 10500);
    events = readOutboxEvents();
    expect(events).toHaveLength(3);
    expect(events[2]!.eventType).toBe('alert');
    expect(events[2]!.summary).toBe(`BOT ERRORS heartbeat watchdog stale: ${AWAITING_KEY}`);
    expect(events[2]!.evidence).toContain('incident_reopened=true');
    expect(events[2]!.evidence).toContain('flap_count=1');
    expect(events[2]!.evidence).toContain('first_seen=');

    // Nudge resets the clock again; recovery of a flapped incident is HELD.
    runAwaiting(qLoopState, env, 12200, 12100);
    runAwaiting(qLoopState, env, 12500, 12100);
    // Cycle 3: crosses the threshold again -> now a SILENT reopen (flapping).
    runAwaiting(qLoopState, env, 13800, 12400);

    events = readOutboxEvents();
    expect(events).toHaveLength(3);
    const state = watchdogState();
    expect(state.open[AWAITING_KEY]!.flapCount).toBe(2);
  });

  it('flushes the held recovery notice once the flapping key stays clean past the re-arm window', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-heartbeat-'));
    const qLoopState = join(tmpRoot, 'q-loop-state.json');
    const env = latchEnv(qLoopState);

    runAwaiting(qLoopState, env, 10000, 8000); // stale alert
    runAwaiting(qLoopState, env, 10600, 10500); // clean 1
    runAwaiting(qLoopState, env, 10900, 10500); // clean 2 -> immediate recovery (first cycle)
    runAwaiting(qLoopState, env, 11900, 10500); // first reopen -> alerts with flap context
    runAwaiting(qLoopState, env, 12200, 12100); // clean 1
    runAwaiting(qLoopState, env, 12500, 12100); // clean 2 -> recovery HELD (flapped incident)
    expect(readOutboxEvents()).toHaveLength(3);

    // Q durably returns: clean past the 6h re-arm window -> deferred recovery flush.
    runAwaiting(qLoopState, env, 12500 + 6 * 60 * 60 + 300, 0);
    const events = readOutboxEvents();
    expect(events).toHaveLength(4);
    expect(events[3]!.eventType).toBe('clear');
    expect(events[3]!.summary).toBe(`BOT ERRORS heartbeat watchdog recovered: ${AWAITING_KEY}`);
    expect(events[3]!.evidence).toContain('flap_count=1');
    const state = watchdogState();
    expect(Object.keys(state.open)).toHaveLength(0);
    expect(Object.keys(state.recentlyRecovered ?? {})).toHaveLength(0);
  });

  it('requires N consecutive stale observations before opening when stale confirmations are configured', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-heartbeat-'));
    const qLoopState = join(tmpRoot, 'q-loop-state.json');
    const env = {
      BOT_ERRORS_STATE_DIR: tmpRoot,
      BOT_ERRORS_Q_LOOP_STATE: qLoopState,
      BOT_ERRORS_WATCHDOG_CHECKS: 'q_loop',
      BOT_ERRORS_MAX_Q_LOOP_AGE: '60',
      BOT_ERRORS_WATCHDOG_STALE_CONFIRMATIONS: '2',
    };

    writePrivateJson(qLoopState, { updated_at: 100 });
    runWatchdog({ ...env, BOT_ERRORS_DRY_NOW: '1000' }); // stale observation 1 -> pending, no alert
    writePrivateJson(qLoopState, { updated_at: 1290 });
    runWatchdog({ ...env, BOT_ERRORS_DRY_NOW: '1300' }); // clean -> pending counter resets
    writePrivateJson(qLoopState, { updated_at: 1000 });
    runWatchdog({ ...env, BOT_ERRORS_DRY_NOW: '1600' }); // stale observation 1 again
    // No alert may exist yet, so the outbox directory itself must be absent.
    expect(existsSync(join(tmpRoot, 'outbox'))).toBe(false);

    runWatchdog({ ...env, BOT_ERRORS_DRY_NOW: '1900' }); // stale observation 2 -> opens + alerts once
    const events = readOutboxEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.summary).toBe('BOT ERRORS heartbeat watchdog stale: q_loop');
  });
});
