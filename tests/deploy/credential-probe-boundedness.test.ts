import { describe, it, expect } from 'vitest';
import { BOUNDED_LIB, expectLifecycleIsolation, resolveBinary, runLifecycleProbe } from './fixtures/bounded-exec-lifecycle';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Incident 2026-07-24 (mini11 / ph-bot, ~45h outage): an unbounded
// `security find-generic-password` blocked the launcher forever because macOS
// popped a SecurityAgent authorization prompt on an auto-login host that nobody
// could answer. The Linux branch was bounded; the Darwin branch was not.
//
// The naive fix — `timeout 3s security ...` — does not work: stock macOS ships
// no `timeout(1)`. These tests pin both halves of the invariant:
//   1. every credential-store probe in deploy/ goes through whatsoup_run_bounded
//   2. whatsoup_run_bounded actually bounds, on a host with AND without timeout(1)

/**
 * Every tracked shell file, repo-wide — not just deploy/. A new script anywhere
 * that reaches for a credential store has to be bounded too, and scoping the
 * scan to one directory would let that regression land silently.
 */
function trackedShellFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return out
    .split('\0')
    .filter(Boolean)
    .filter((f) => f.endsWith('.sh') || f === 'deploy/whatsoup');
}

/**
 * Matches `security`/`secret-tool` in *command position* — start of line, or
 * after a pipe/`&&`/`;`/subshell open. Occurrences inside echoed help text and
 * comments sit mid-line and are correctly ignored.
 */
const COMMAND_POSITION =
  /(?:^|[|&;(]|\bthen\b|\bdo\b|\bif\b|\belif\b|!)\s*(security|secret-tool)\s/;

function unboundedProbes(file: string): string[] {
  const findings: string[] = [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, index) => {
    const code = line.replace(/^\s*#.*$/, '');
    const match = COMMAND_POSITION.exec(code);
    if (!match) return;
    // A match sitting inside a quoted string is data/help text, not a call.
    // Continuation lines of a multi-line message read as an odd quote count.
    const prefix = code.slice(0, match.index);
    const doubleQuotesBefore = (prefix.match(/"/g) ?? []).length;
    const singleQuotesBefore = (prefix.match(/'/g) ?? []).length;
    if (
      doubleQuotesBefore % 2 === 1
      || singleQuotesBefore % 2 === 1
      || /^["']/.test(code.trimStart())
    ) return;
    // `command -v security` only asks whether the binary exists; it cannot block.
    if (/command\s+-v\s+(security|secret-tool)\b/.test(code)) return;
    if (code.includes('whatsoup_run_bounded')) return;
    findings.push(`${file}:${index + 1}: ${line.trim()}`);
  });
  return findings;
}

/**
 * CRED-1: `security add-generic-password ... -w <value>` puts the secret on argv,
 * where `ps -ww` exposes it to every user on the host for the exec lifetime.
 * `-w` must be the LAST option so `security` reads the value from stdin instead.
 */
function argvSecretLeaks(file: string): string[] {
  const findings: string[] = [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, index) => {
    const code = line.replace(/^\s*#.*$/, '');
    const match = /-w(\s+.*)?$/.exec(code);
    if (!match) return;
    if (!/(add|find|delete)-generic-password/.test(code) && !/-w\s/.test(code)) return;
    const rest = (match[1] ?? '').trim();
    // Acceptable tails: nothing, a line continuation, or a redirect/pipe/close.
    if (rest === '' || rest === '\\' || /^[>|;)&]/.test(rest)) return;
    findings.push(`${file}:${index + 1}: ${line.trim()}`);
  });
  return findings;
}

describe('credential-store probes are bounded on every platform', () => {
  it('ignores credential command names inside single-quoted data records', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'credential-probe-scan-'));
    const fixture = path.join(tmpDir, 'records.sh');
    fs.writeFileSync(
      fixture,
      "printf 'credential_store|optional|security|structural||||security is supplied by macOS.\\n'\n",
    );

    try {
      expect(unboundedProbes(fixture)).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('no tracked shell script invokes security/secret-tool unbounded', () => {
    const findings = trackedShellFiles()
      .filter((f) => f !== BOUNDED_LIB)
      .flatMap(unboundedProbes);
    expect(findings, `unbounded credential probes:\n${findings.join('\n')}`).toEqual([]);
  });

  it('no tracked shell script passes a keychain secret on argv (CRED-1)', () => {
    const findings = trackedShellFiles()
      .filter((f) => /security\s|generic-password/.test(fs.readFileSync(f, 'utf8')))
      .flatMap(argvSecretLeaks);
    expect(findings, `secrets on argv:\n${findings.join('\n')}`).toEqual([]);
  });

  it('the TypeScript keyring backend gives up on a credential store that never answers', () => {
    // Behavioural, not a source-string assertion: put a credential helper on PATH
    // that answers detection but then hangs forever — the shape of a locked
    // keychain or a stuck libsecret daemon — and require the read to return.
    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keyring-hang-'));
    const stub = path.join(stubDir, 'secret-tool');
    fs.writeFileSync(
      stub,
      '#!/usr/bin/env bash\nif [ "$1" = "--help" ]; then echo usage; exit 0; fi\nsleep 300\n',
      { mode: 0o700 },
    );

    const probe = path.join(stubDir, 'probe.mjs');
    fs.writeFileSync(
      probe,
      [
        `import { lookupCredential, _resetBackendCache } from ${JSON.stringify(path.resolve('src/lib/keyring.ts'))};`,
        '_resetBackendCache();',
        'const started = Date.now();',
        "let value = null;",
        'try { value = lookupCredential("anthropic"); } catch { value = null; }',
        'process.stdout.write(`elapsed=${Date.now() - started} value=${value ?? ""}`);',
      ].join('\n'),
    );

    try {
      const started = Date.now();
      const res = spawnSync(
        process.execPath,
        ['--experimental-strip-types', probe],
        {
          encoding: 'utf8',
          timeout: 60_000,
          env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}`, ANTHROPIC_API_KEY: '' },
          cwd: process.cwd(),
        },
      );
      const wall = Date.now() - started;

      expect(res.error, `probe failed to run: ${res.stderr}`).toBeUndefined();
      // A 300s sleep per candidate service; anything under 30s proves the read
      // was cut off rather than left to block.
      expect(wall).toBeLessThan(30_000);
      expect(res.stdout).toMatch(/elapsed=\d+/);
    } finally {
      fs.rmSync(stubDir, { recursive: true, force: true });
    }
  });

  it('the launcher and setup scripts source the bounded-exec library', () => {
    for (const file of [
      'deploy/whatsoup',
      'deploy/setup.sh',
      'deploy/generate-health-tokens.sh',
    ]) {
      expect(fs.readFileSync(file, 'utf8')).toContain('lib/bounded-exec.sh');
    }
  });

  it('the pinned-Node keychain helper stays bounded with a hard kill', () => {
    const helper = fs.readFileSync('deploy/lib/read-keychain-secret.mjs', 'utf8');
    expect(helper).toContain('timeout: 3_000');
    expect(helper).toContain("killSignal: 'SIGKILL'");
  });
});

describe('health-token keyring mirroring keeps the secret off argv', () => {
  function runMirror(platform: 'Darwin' | 'Linux') {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-keyring-'));
    const binDir = path.join(tmpDir, 'bin');
    fs.mkdirSync(binDir);
    const argvLog = path.join(tmpDir, 'argv.log');
    const stdinLog = path.join(tmpDir, 'stdin.log');

    for (const tool of ['security', 'secret-tool']) {
      fs.writeFileSync(
        path.join(binDir, tool),
        `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${argvLog}"\ncat >> "${stdinLog}"\n`,
        { mode: 0o700 },
      );
    }
    fs.writeFileSync(
      path.join(binDir, 'uname'),
      `#!/usr/bin/env bash\nprintf '%s\\n' '${platform}'\n`,
      { mode: 0o700 },
    );

    const source = fs.readFileSync('deploy/generate-health-tokens.sh', 'utf8');
    const start = source.indexOf('mirror_to_keyring() {');
    const end = source.indexOf('\n}\n', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const fn = source.slice(start, end + 3);

    const token = 'f'.repeat(64);
    const script = path.join(tmpDir, 'probe.sh');
    fs.writeFileSync(
      script,
      `#!/usr/bin/env bash\nset -uo pipefail\nPATH="${binDir}:$PATH"\n`
        + `. "${path.resolve('deploy/lib/bounded-exec.sh')}"\n${fn}\n`
        + `mirror_to_keyring fixture-bot ${token}\n`,
      { mode: 0o700 },
    );

    const bash = resolveBinary('bash') ?? 'bash';
    const res = spawnSync(bash, [script], { encoding: 'utf8', timeout: 30_000 });
    const argv = fs.existsSync(argvLog) ? fs.readFileSync(argvLog, 'utf8') : '';
    const stdin = fs.existsSync(stdinLog) ? fs.readFileSync(stdinLog, 'utf8') : '';
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return { res, argv, stdin, token };
  }

  it.each<['Darwin' | 'Linux']>([['Darwin'], ['Linux']])(
    'passes the token via stdin on %s',
    (platform) => {
      const { res, argv, stdin, token } = runMirror(platform);
      expect(res.status, res.stderr).toBe(0);
      expect(argv).not.toContain(token);
      expect(stdin).toContain(token);
      expect(argv).toContain('whatsoup-health-token');
    },
  );
});

describe('whatsoup_run_bounded process-group lifecycle', () => {
  it.each(['fast', 'nested', 'nonzero', 'zero'] as const)('reaps every owned descendant before returning from %s', (mode) => {
    const result = runLifecycleProbe(mode);
    expect(result.exit, JSON.stringify(result)).toBe(0);
    const expected = mode === 'fast' ? 'rc=0 output=payload' : mode === 'nonzero' ? 'rc=7 output=payload' : 'rc=124 output=';
    expect(result.stdout, JSON.stringify(result)).toContain(expected);
    expect(result.sentinel_alive_before_cleanup, JSON.stringify(result)).toBe(true);
    expect(result.survivors_after_cleanup, JSON.stringify(result)).toEqual([]);
    expect(result.survivors_before_cleanup, JSON.stringify(result)).toEqual([]);
    if (mode === 'nested') expect(result.duration_ms, JSON.stringify(result)).toBeGreaterThanOrEqual(900);
    if (mode === 'zero') expect(result.command_started, JSON.stringify(result)).toBe(false);
  });
  it('refuses before a caller-group stop when job control is unavailable', () => {
    const result = runLifecycleProbe('job-control-unavailable');
    const evidence = JSON.stringify(result);
    expect(result.error, evidence).toBeUndefined();
    expect(result.job_control_monitor_refused, evidence).toBe(true);
    expect(result.caller_group_stopped, `${evidence} [job-control: caller group stopped]`).toBe(false);
    expect(result.job_control_stop_witness, evidence).toBeNull();
    expect(result.command_started, evidence).toBe(false);
    expect(result.exit, evidence).toBe(0);
    expect(result.stdout, evidence).toContain('rc=2 output=');
    expect(result.sentinel_alive_before_cleanup, evidence).toBe(true);
    expect(result.survivors_before_cleanup, evidence).toEqual([]);
    expect(result.survivors_after_cleanup, evidence).toEqual([]);
    expect(result.residual_bounded_files, evidence).toEqual([]);
  });
  it.each(['ownership-command', 'ownership-watchdog', 'ownership-caller-group'] as const)('refuses %s failure before releasing the command', (mode) => {
    const result = runLifecycleProbe(mode);
    expect(result.stdout).toContain('rc=2 output=');
    expect(result.command_started).toBe(false);
    expectLifecycleIsolation(result);
  });
  it('returns after a verified command launch-gate reader dies before release', () => {
    const result = runLifecycleProbe('reader-killed-after-verification');
    expect(result.verified_reader_killed, JSON.stringify(result)).toBe(true);
    expect(result.duration_ms, JSON.stringify(result)).toBeLessThan(4_000);
    expect(result.exit, JSON.stringify(result)).toBe(0);
    expect(result.stdout).toContain('rc=137 output=');
    expect(result.command_started).toBe(false);
    expectLifecycleIsolation(result);
  });
  it('keeps the command deadline when an optional watchdog launch reader is lost', () => {
    const result = runLifecycleProbe('watchdog-reader-killed-after-verification');
    expect(result.verified_reader_killed, JSON.stringify(result)).toBe(true);
    expect(result.duration_ms, JSON.stringify(result)).toBeLessThan(4_000);
    expect(result.exit, JSON.stringify(result)).toBe(0);
    expect(result.stdout).toContain('rc=124 output=');
    expect(result.command_started).toBe(true);
    expectLifecycleIsolation(result);
  });
  it('enforces the command deadline while the supervising parent is stopped', () => {
    const result = runLifecycleProbe('parent-stopped');
    expect(result.exit, JSON.stringify(result)).toBe(0);
    expect(result.command_alive_while_parent_stopped, JSON.stringify(result)).toBe(false);
    expect(result.stdout).toContain('rc=124 output=');
    expectLifecycleIsolation(result);
  });
  it('reaps command descendants when the supervising parent receives TERM', () => {
    const result = runLifecycleProbe('parent-terminated');
    expect(result.exit, JSON.stringify(result)).toBe(0);
    expect(result.stdout).toContain('rc=143 output=');
    expectLifecycleIsolation(result);
  });
  it.each(['setup-mktemp-term-ignoring', 'setup-mkfifo-term-ignoring', 'setup-ps-term-ignoring'] as const)('bounds a TERM-ignoring setup child from helper entry: %s', (mode) => {
    const result = runLifecycleProbe(mode);
    expect(result.exit, JSON.stringify(result)).toBe(0);
    expect(result.duration_ms, JSON.stringify(result)).toBeLessThan(4_000);
    expect(result.stdout, JSON.stringify(result)).toContain('rc=2 output=');
    expect(result.command_started, JSON.stringify(result)).toBe(false);
    expectLifecycleIsolation(result);
  });
  it('fails closed and reaps setup when the outer timer sleep fails', () => {
    const result = runLifecycleProbe('setup-timer-sleep-failure');
    expect(result.exit, JSON.stringify(result)).toBe(0);
    expect(result.duration_ms, JSON.stringify(result)).toBeLessThan(4_000);
    expect(result.stdout, JSON.stringify(result)).toContain('rc=2 output=');
    expect(result.command_started, JSON.stringify(result)).toBe(false);
    expectLifecycleIsolation(result);
  });
  it('reports a worker cleanup residual instead of a deadline', () => {
    const result = runLifecycleProbe('cleanup-residual');
    expect(result.exit, JSON.stringify(result)).toBe(0);
    expect(result.duration_ms, JSON.stringify(result)).toBeLessThan(7_500);
    expect(result.stdout, JSON.stringify(result)).toContain('rc=2 output=');
    expect(result.command_started, JSON.stringify(result)).toBe(true);
    expect(result.cleanup_residual_polls, JSON.stringify(result)).toBeGreaterThan(0);
    expect(result.cleanup_residual_capture_valid, JSON.stringify(result)).toBe(true);
    expectLifecycleIsolation(result);
  });
  it('refuses interrupted cleanup after the command leader is reaped before outer authorization', () => {
    const result = runLifecycleProbe('dead-leader-before-authorization');
    expect(result.exit, JSON.stringify(result)).toBe(0);
    expect(result.stopped_guard, JSON.stringify(result)).toBeTruthy();
    expect(result.continued_guard, JSON.stringify(result)).toBe(result.stopped_guard);
    expect(result.command_pid_reaped_before_authorization, JSON.stringify(result)).toBe(true);
    expect(result.stdout, JSON.stringify(result)).toContain('rc=2 output=');
    expectLifecycleIsolation(result);
  });
  it('keeps the deadline result when clean worker completion precedes outer authorization', () => {
    const result = runLifecycleProbe('dead-leader-clean-cleanup');
    expect(result.exit, JSON.stringify(result)).toBe(0);
    expect(result.command_pid_reaped_before_authorization, JSON.stringify(result)).toBe(true);
    expect(result.worker_cleanup_completed_before_authorization, JSON.stringify(result)).toBe(true);
    expect(result.guard_left_stopped_for_deadline_reader, JSON.stringify(result)).toBe(result.stopped_guard);
    expect(result.stdout, JSON.stringify(result)).toContain('rc=124 output=');
    expectLifecycleIsolation(result);
  });
  it('allows bounded worker cleanup to finish after the command leader is reaped', () => {
    const result = runLifecycleProbe('dead-leader-finishing-cleanup');
    expect(result.exit, JSON.stringify(result)).toBe(0);
    expect(result.command_pid_reaped_before_authorization, JSON.stringify(result)).toBe(true);
    expect(result.outer_authority_finished, JSON.stringify(result)).toBe(true);
    expect(result.stdout, JSON.stringify(result)).toContain('rc=124 output=');
    expect(result.cleanup_released_after_authority, JSON.stringify(result)).toBe(true);
    expect(result.duration_ms, JSON.stringify(result)).toBeLessThan(6_000);
    expect(result.sentinel_alive_before_cleanup, JSON.stringify(result)).toBe(true);
    expect(result.dangerous_kill_attempts, JSON.stringify(result)).toEqual([]);
    expect(result.survivors_before_cleanup, JSON.stringify(result)).toEqual([]);
    expect(result.survivors_after_cleanup, JSON.stringify(result)).toEqual([]);
  });
  it('refuses an unreadable authorization record after clean worker completion', () => {
    const result = runLifecycleProbe('authorization-unreadable-after-cleanup');
    expect(result.authorization_unreadable, JSON.stringify(result)).toBe(true);
    expect(result.worker_cleanup_completed_before_authorization, JSON.stringify(result)).toBe(true);
    expect(result.exit, JSON.stringify(result)).toBe(0);
    expect(result.duration_ms, JSON.stringify(result)).toBeLessThan(6_000);
    expect(result.stdout, JSON.stringify(result)).toContain('rc=2 output=');
    expect(result.sentinel_alive_before_cleanup, JSON.stringify(result)).toBe(true);
    expect(result.dangerous_kill_attempts, JSON.stringify(result)).toEqual([]);
    expect(result.survivors_before_cleanup, JSON.stringify(result)).toEqual([]);
    expect(result.survivors_after_cleanup, JSON.stringify(result)).toEqual([]);
  });
  it('bounds a guard that does not complete TERM during unreadable authorization handoff', () => {
    const result = runLifecycleProbe('authorization-unreadable-guard-stuck');
    expect(result.authorization_unreadable, JSON.stringify(result)).toBe(true);
    expect(result.deadline_forced, JSON.stringify(result)).toBe(true);
    expect(result.worker_cleanup_completed_before_authorization, JSON.stringify(result)).toBe(true);
    expect(result.guard_term_held, JSON.stringify(result)).toBe(true);
    expect(result.guard_sleep_held, JSON.stringify(result)).toBe(true);
    expect(result.exit, JSON.stringify(result)).toBe(0);
    expect(result.duration_ms, JSON.stringify(result)).toBeLessThan(6_000);
    expect(result.stdout, JSON.stringify(result)).toContain('rc=2 output=');
    expectLifecycleIsolation(result);
  });
  it('returns refusal when an otherwise successful worker outlives a stuck guard handoff', () => {
    const result = runLifecycleProbe('authorized-guard-stuck');
    expect(result.command_custody_established, JSON.stringify(result)).toBe(true);
    expect(result.command_released_after_guard_stop, JSON.stringify(result)).toBe(true);
    expect(result.worker_cleanup_completed_before_authorization, JSON.stringify(result)).toBe(true);
    expect(result.guard_term_held, JSON.stringify(result)).toBe(true);
    expect(result.guard_sleep_held, JSON.stringify(result)).toBe(true);
    expect(result.exit, JSON.stringify(result)).toBe(0);
    expect(result.duration_ms, JSON.stringify(result)).toBeLessThan(6_000);
    expect(result.stdout, JSON.stringify(result)).toContain('rc=2 output=');
    expectLifecycleIsolation(result);
  });
  it('runs the first-grace TERM handler before hard force escalation', () => {
    const result = runLifecycleProbe('guard-first-grace-term-boundary');
    const evidence = JSON.stringify(result);

    expect(result.error, evidence).toBeUndefined();
    expect(result.exit, evidence).toBe(0);
    expect(result.stdout, evidence).toContain('guard_grace_entered=true');
    expect(result.stdout, evidence).toContain('rc=124 output=');
    expect(result.duration_ms, evidence).toBeLessThan(6_000);
    expectLifecycleIsolation(result);
  });
  it('fails closed after a worker-cleanup deadline handoff is replaced with a FIFO', () => {
    const result = runLifecycleProbe('deadline-fifo-after-cleanup');
    expect(result.exit, JSON.stringify(result)).toBe(0);
    expect(result.deadline_replaced_with_fifo, JSON.stringify(result)).toBe(true);
    expect(result.worker_cleanup_completed_before_authorization, JSON.stringify(result)).toBe(true);
    expect(result.duration_ms, JSON.stringify(result)).toBeLessThan(6_000);
    expect(result.stdout, JSON.stringify(result)).toContain('rc=2 output=');
    expect(result.sentinel_alive_before_cleanup, JSON.stringify(result)).toBe(true);
    expect(result.dangerous_kill_attempts, JSON.stringify(result)).toEqual([]);
    expect(result.survivors_before_cleanup, JSON.stringify(result)).toEqual([]);
    expect(result.survivors_after_cleanup, JSON.stringify(result)).toEqual([]);
  });
  it.each([0, 2, 143] as const)('preserves a natural result ready before the watchdog event: %s', (status) => {
    const result = runLifecycleProbe(status === 0 ? 'ordinary-exit-0' : status === 2 ? 'ordinary-exit-2' : 'ordinary-exit-143');
    expect(result.exit, JSON.stringify(result)).toBe(0);
    expect(result.stdout, JSON.stringify(result)).toContain(`rc=${status} output=payload`);
    expectLifecycleIsolation(result);
  });
  it.for(['event-order-deadline-first', 'event-order-expired-reaped', 'event-order-natural-0', 'event-order-natural-2', 'event-order-natural-143'] as const)('arbitrates real FIFO status by observed event order: %s', (mode, { task }) => {
    const result = runLifecycleProbe(mode);
    const evidence = JSON.stringify(result);
    // Keep the negative control's event record as well as the RED diagnostics.
    Object.assign(task.meta, { boundedEventOrder: result });
    expect(result.error, evidence).toBeUndefined();
    expect(result.transport, evidence).toBe('pipe');
    expect(result.exit, evidence).toBe(0);
    expect(result.sentinel_alive_before_cleanup, evidence).toBe(true);
    expect(result.survivors_before_cleanup, evidence).toEqual([]);
    expect(result.survivors_after_cleanup, evidence).toEqual([]);
    const events: string[] = result.events;
    const index = (name: string) => events.findIndex((event) => event === name || event.startsWith(`${name} `));
    expect(events.filter((event) => event.startsWith('R_FIFO ')), evidence).toHaveLength(1);
    expect(index('R_WAIT'), evidence).toBe(-1);
    expect(index('CONTROL_ERROR'), evidence).toBe(-1);
    expect(index('S_OUTER'), evidence).toBeGreaterThanOrEqual(0);
    expect(index('L_COMMAND'), evidence).toBeGreaterThanOrEqual(0);
    expect(index('CHILD_SECRET_EXPORTED'), evidence).toBe(-1);
    expect(index('CHILD_SECRET_ABSENT'), evidence).toBeGreaterThan(index('L_COMMAND'));
    expect(index('C_COMPLETE'), evidence).toBeGreaterThan(index('R_FIFO'));
    expect(index('A'), evidence).toBeGreaterThan(index('C_COMPLETE'));
    if (mode === 'event-order-expired-reaped') {
      expect(events[index('O_OUTER_CLAIM')], evidence).toMatch(/^O_OUTER_CLAIM rc=0 worker=\d+$/);
      expect(index('I_START'), evidence).toBeGreaterThan(index('O_OUTER_CLAIM'));
      expect(index('R_FIFO'), evidence).toBeGreaterThan(index('O_OUTER_CLAIM'));
      expect(events[index('R_FIFO')], evidence).toMatch(/^R_FIFO rc=0 raw=0 command=\d+ group=\d+$/);
      expect(events[index('O_RESULT_CLAIM')], evidence).toBe('O_RESULT_CLAIM rc=1 result=0');
      expect(index('O_RESULT_CLAIM'), evidence).toBeGreaterThan(index('R_FIFO'));
      expect(index('C_HOLD'), evidence).toBeGreaterThan(index('R_FIFO'));
      expect(index('AUTHORITY'), evidence).toBeGreaterThan(index('C_HOLD'));
      expect(events[index('AUTHORITY')], evidence).toBe('AUTHORITY state=3');
      expect(index('C_RELEASE'), evidence).toBeGreaterThan(index('AUTHORITY'));
      expect(events[index('C_COMPLETE')], evidence).toBe('C_COMPLETE cleanup=0');
      expect(index('D_INNER_ENTER'), evidence).toBe(-1);
      expect(index('D_INNER_COMMIT'), evidence).toBe(-1);
      expect(result.cleanup_released_after_authority, evidence).toBe(true);
      expect(result.stdout, evidence).toContain('rc=124 output=payload');
    } else if (mode === 'event-order-deadline-first') {
      const deadlines = ['O_OUTER_CLAIM rc=0', 'D_INNER_COMMIT'].map(index).filter((value) => value >= 0);
      expect(deadlines.length, evidence).toBeGreaterThan(0);
      expect(index('P_PAYLOAD'), evidence).toBeLessThan(Math.min(...deadlines));
      expect(Math.min(...deadlines), evidence).toBeLessThan(index('R_FIFO'));
      expect(result.stdout, evidence).toContain('rc=124 output=payload');
    } else {
      const status = Number(mode.split('-').at(-1));
      expect(events[index('R_FIFO')], evidence).toMatch(new RegExp(`^R_FIFO rc=${status} raw=${status} command=\\d+ group=\\d+$`));
      expect(events[index('O_RESULT_CLAIM')], evidence).toBe(`O_RESULT_CLAIM rc=0 result=${status}`);
      expect(index('C_HOLD'), evidence).toBeGreaterThan(index('R_FIFO'));
      expect(index('O_RESULT_CLAIM'), evidence).toBeGreaterThan(index('R_FIFO'));
      // The fixture must establish result-first ordering before starting the
      // outer budget, regardless of command-start scheduling latency.
      expect(index('S_OUTER'), evidence).toBeGreaterThan(index('C_HOLD'));
      expect(events[index('O_OUTER_CLAIM')], evidence).toMatch(/^O_OUTER_CLAIM rc=1 worker=\d+$/);
      expect(index('O_OUTER_CLAIM'), evidence).toBeGreaterThan(index('C_HOLD'));
      // Cleanup has reaped the inner watchdog before the handoff. An inner
      // deadline observation would invalidate this result-first control.
      expect(index('D_INNER_ENTER'), evidence).toBe(-1);
      expect(index('D_INNER_COMMIT'), evidence).toBe(-1);
      expect(result.cleanup_released_after_outer_deadline, evidence).toBe(true);
      expect(index('C_RELEASE'), evidence).toBeGreaterThan(index('O_OUTER_CLAIM'));
      expect(events[index('AUTHORITY')], evidence).toBe('AUTHORITY state=3');
      expect(events[index('C_COMPLETE')], evidence).toBe('C_COMPLETE cleanup=0');
      expect(result.stdout, evidence).toContain(`rc=${status} output=payload`);
    }
  });
  it('keeps an authenticated command exit 2 under a real inner deadline', ({ task }) => {
    const result = runLifecycleProbe('event-order-inner-deadline-command-2');
    const evidence = JSON.stringify(result);
    Object.assign(task.meta, { boundedInnerDeadlineCommand2: result });
    expect(result.error, evidence).toBeUndefined();
    expect(result.transport, evidence).toBe('pipe');
    expect(result.exit, evidence).toBe(0);
    expect(result.command_started, evidence).toBe(true);
    expect(result.duration_ms, evidence).toBeLessThan(6_000);
    expect(result.sentinel_alive_before_cleanup, evidence).toBe(true);
    expect(result.survivors_before_cleanup, evidence).toEqual([]);
    expect(result.survivors_after_cleanup, evidence).toEqual([]);
    const events: string[] = result.events;
    const index = (name: string) => events.findIndex((event) => event === name || event.startsWith(`${name} `));
    expect(index('CONTROL_ERROR'), evidence).toBe(-1);
    expect(index('P_PAYLOAD'), evidence).toBeGreaterThanOrEqual(0);
    expect(index('D_INNER_ENTER'), evidence).toBeGreaterThan(index('P_PAYLOAD'));
    expect(index('D_INNER_COMMIT'), evidence).toBeGreaterThan(index('D_INNER_ENTER'));
    expect(events[index('O_RESULT_CLAIM')], evidence).toBe('O_RESULT_CLAIM rc=0 result=2');
    expect(index('O_RESULT_CLAIM'), evidence).toBeGreaterThan(index('D_INNER_COMMIT'));
    expect(events[index('A')], evidence).toMatch(/^A worker=\d+ worker_rc=2 guard=\d+ guard_rc=0 deadline_rc=124 rc=124$/);
    expect(index('A'), evidence).toBeGreaterThan(index('O_RESULT_CLAIM'));
    expect(result.stdout, evidence).toContain('rc=124 output=payload');
  });
  it('keeps a malformed candidate as worker failure after a real inner deadline', ({ task }) => {
    const result = runLifecycleProbe('event-order-outcome-candidate-directory');
    const evidence = JSON.stringify(result);
    Object.assign(task.meta, { boundedInnerDeadlineMalformedCandidate: result });
    expect(result.error, evidence).toBeUndefined();
    expect(result.transport, evidence).toBe('pipe');
    expect(result.exit, evidence).toBe(0);
    expect(result.command_started, evidence).toBe(true);
    expect(result.outcome_substitution, evidence).toBe('event-order-outcome-candidate-directory');
    expect(result.outcome_paths, evidence).toHaveLength(2);
    expect(result.stdout, evidence).toContain('rc=2 output=');
    expect(result.outcome_claims, evidence).toEqual(['result', 'deadline-outer']);
    expect(result.outcome_victim_contents, evidence).toBe('unchanged');
    expect(result.outcome_directory_children, evidence).toEqual([]);
    expect(result.outer_release_error, evidence).toBeUndefined();
    expect(result.outer_released_after_parent_wait, evidence).toBe(true);
    expect(result.sentinel_alive_before_cleanup, evidence).toBe(true);
    expect(result.survivors_before_cleanup, evidence).toEqual([]);
    expect(result.survivors_after_cleanup, evidence).toEqual([]);
    expect(result.duration_ms, evidence).toBeLessThan(6_000);
    const events: string[] = result.events;
    const index = (name: string) => events.findIndex((event) => event === name || event.startsWith(`${name} `));
    expect(index('CONTROL_ERROR'), evidence).toBe(-1);
    expect(index('P_PAYLOAD'), evidence).toBeGreaterThanOrEqual(0);
    expect(index('D_INNER_ENTER'), evidence).toBeGreaterThan(index('P_PAYLOAD'));
    expect(index('D_INNER_COMMIT'), evidence).toBeGreaterThan(index('D_INNER_ENTER'));
    expect(events[index('O_RESULT_CLAIM')], evidence).toMatch(/^O_RESULT_CLAIM rc=2 result=\d+$/);
    expect(index('O_RESULT_CLAIM'), evidence).toBeGreaterThan(index('D_INNER_COMMIT'));
    expect(index('G_WAIT'), evidence).toBeGreaterThan(index('O_RESULT_CLAIM'));
    expect(index('D_OUTER_ENTER'), evidence).toBeGreaterThan(index('G_WAIT'));
    expect(events[index('O_OUTER_CLAIM')], evidence).toMatch(/^O_OUTER_CLAIM rc=2 worker=\d+$/);
    expect(index('O_OUTER_CLAIM'), evidence).toBeGreaterThan(index('D_OUTER_ENTER'));
    expect(events[index('A')], evidence).toMatch(/^A worker=\d+ worker_rc=2 guard=\d+ guard_rc=2 deadline_rc=124 rc=2$/);
    expect(index('A'), evidence).toBeGreaterThan(index('O_OUTER_CLAIM'));
  });
  it('bounds an authorized worker that is stopped before timeout cleanup', () => {
    const result = runLifecycleProbe('worker-stopped-after-authorization');
    expect(result.exit, JSON.stringify(result)).toBe(0);
    expect(result.duration_ms, JSON.stringify(result)).toBeLessThan(6_000);
    expect(result.stopped_worker, JSON.stringify(result)).toBeTruthy();
    expect(result.stdout, JSON.stringify(result)).toContain('rc=2 output=');
    expectLifecycleIsolation(result);
  });
  it('does not trust a forged completion marker for a stopped worker', () => {
    const result = runLifecycleProbe('forged-completion-worker-stopped');
    expect(result.exit, JSON.stringify(result)).toBe(0);
    expect(result.duration_ms, JSON.stringify(result)).toBeLessThan(6_000);
    expect(result.forged_completion, JSON.stringify(result)).toBeTruthy();
    expect(result.stdout, JSON.stringify(result)).toContain('rc=2 output=');
    expectLifecycleIsolation(result);
  });
  it('does not lose a release sent before the worker stops', () => {
    const result = runLifecycleProbe('handshake-early-cont');
    expect(result.exit, JSON.stringify(result)).toBe(0);
    expect(result.early_cont_before_stop, JSON.stringify(result)).toBe(false);
    expect(result.continued_after_stop, JSON.stringify(result)).toBe(true);
    expect(result.command_started, JSON.stringify(result)).toBe(true);
    expect(result.stdout, JSON.stringify(result)).toContain('rc=0 output=payload');
    expect(result.duration_ms, JSON.stringify(result)).toBeLessThan(4_000);
    expectLifecycleIsolation(result);
  });
  it.each(['control-tokenless', 'control-duplicate-token', 'control-low-group', 'control-caller-group', 'control-external-group'] as const)('fails closed without signalling an injected group: %s', (mode) => {
    const result = runLifecycleProbe(mode);
    expect(result.control_corrupted, JSON.stringify(result)).toBe(mode);
    expect(result.exit, JSON.stringify(result)).toBe(0);
    expect(result.duration_ms, JSON.stringify(result)).toBeLessThan(6_000);
    expect(result.stdout, JSON.stringify(result)).toContain('rc=2 output=');
    expect(result.dangerous_kill_attempts, JSON.stringify(result)).toEqual([]);
    expectLifecycleIsolation(result);
  });
  // The groups the worker created must not outlive it when the worker cannot
  // run its own cleanup. Each case checks its survivors right after its setup,
  // and a label after the evidence names the list that failed.
  it('ends the groups a stopped worker created under an invalid record', () => {
    const result = runLifecycleProbe('control-tokenless-worker-stopped');
    const evidence = JSON.stringify(result);
    expect(result.error, evidence).toBeUndefined();
    expect(result.control_corrupted, evidence).toBe('control-tokenless-worker-stopped');
    expect(result.stopped_worker, evidence).toBeGreaterThan(1);
    expect(result.watchdog_sleep_stretched, evidence).toBe(true);
    expect(result.survivors_before_cleanup, `${evidence} [survivors before cleanup]`).toEqual([]);
    expect(result.exit, evidence).toBe(0);
    expect(result.stdout, evidence).toContain('rc=2 output=');
    expect(result.duration_ms, evidence).toBeLessThan(6_000);
    expect(result.dangerous_kill_attempts, `${evidence} [dangerous kill attempts]`).toEqual([]);
    expect(result.sentinel_alive_before_cleanup, evidence).toBe(true);
    expect(result.survivors_after_cleanup, evidence).toEqual([]);
    expect(result.residual_bounded_files, evidence).toEqual([]);
  });
  it('ends the created groups before a trapped signal can cut worker cleanup short under an invalid record', () => {
    const result = runLifecycleProbe('control-tokenless-cleanup-interrupted');
    const evidence = JSON.stringify(result);
    expect(result.error, evidence).toBeUndefined();
    expect(result.control_corrupted, evidence).toBe('control-tokenless-cleanup-interrupted');
    expect(result.watchdog_sleep_stretched, evidence).toBe(true);
    expect(result.barrier_expired, evidence).toEqual([]);
    expect(result.survivors_before_cleanup, `${evidence} [survivors before cleanup]`).toEqual([]);
    expect(result.exit, evidence).toBe(0);
    expect(result.stdout, evidence).toContain('rc=2 output=');
    expect(result.duration_ms, evidence).toBeLessThan(6_000);
    expect(result.dangerous_kill_attempts, `${evidence} [dangerous kill attempts]`).toEqual([]);
    expect(result.sentinel_alive_before_cleanup, evidence).toBe(true);
    expect(result.survivors_after_cleanup, evidence).toEqual([]);
    expect(result.residual_bounded_files, evidence).toEqual([]);
  });
  it('ends the created groups before a trapped signal can cut worker cleanup short without a readable record', () => {
    const result = runLifecycleProbe('authorization-unreadable-cleanup-interrupted');
    const evidence = JSON.stringify(result);
    expect(result.error, evidence).toBeUndefined();
    expect(result.authorization_unreadable, evidence).toBe(true);
    expect(result.guard_timer_entered, evidence).toBe(true);
    expect(result.authorization_unreadable_release, evidence).toBe(true);
    expect(result.watchdog_sleep_stretched, evidence).toBe(true);
    expect(result.guard_usr1_sent, `${evidence} [signal-diagnosis: unreadable-record guard USR1 unexpectedly sent]`).toBe(false);
    expect(result.cleanup_hold_reached, evidence).toBe(true);
    expect(result.interrupted_worker, evidence).toBeGreaterThan(1);
    expect(result.barrier_expired, evidence).toEqual([]);
    expect(result.survivors_before_cleanup, `${evidence} [survivors before cleanup]`).toEqual([]);
    expect(result.exit, evidence).toBe(0);
    // The guard reports 124 from its claim, or 2 when it sees the worker still
    // alive after its grace; which one depends on scheduling.
    expect(result.stdout, evidence).toMatch(/rc=(2|124) output=/);
    expect(result.duration_ms, evidence).toBeLessThan(6_000);
    expect(result.sentinel_alive_before_cleanup, evidence).toBe(true);
    expect(result.survivors_after_cleanup, evidence).toEqual([]);
    expect(result.residual_bounded_files, evidence).toEqual([]);
  });
  // With a valid record the guard trusts the recorded groups. The outer
  // signals it only after reaping the worker, so its signal trap must end the
  // groups that a cleanup cut short leaves behind.
  it('ends the recorded groups after a trapped signal cuts worker cleanup short under a valid record', () => {
    const result = runLifecycleProbe('authorization-valid-cleanup-interrupted');
    const evidence = JSON.stringify(result);
    expect(result.error, evidence).toBeUndefined();
    expect(result.watchdog_sleep_stretched, evidence).toBe(true);
    expect(result.guard_usr1_sent, evidence).toBe(true);
    expect(result.cleanup_hold_reached, evidence).toBe(true);
    expect(result.interrupted_worker, evidence).toBeGreaterThan(1);
    expect(result.worker_cut_observed, evidence).toBe(true);
    expect(result.barrier_expired, evidence).toEqual([]);
    expect(result.survivors_before_cleanup, `${evidence} [survivors before cleanup]`).toEqual([]);
    expect(result.exit, evidence).toBe(0);
    expect(result.stdout, evidence).toContain('rc=124 output=');
    expect(result.duration_ms, evidence).toBeLessThan(6_000);
    expect(result.sentinel_alive_before_cleanup, evidence).toBe(true);
    expect(result.survivors_after_cleanup, evidence).toEqual([]);
    expect(result.residual_bounded_files, evidence).toEqual([]);
  });
  // After the reap only the guard can still check the recorded groups, so a
  // TERM to the outer then must not end the guard before its trap ends them.
  it('ends the recorded groups when the outer subshell receives TERM after reaping a worker whose cleanup was cut short', () => {
    const result = runLifecycleProbe('authorization-valid-outer-terminated-after-reap');
    const evidence = JSON.stringify(result);
    expect(result.error, evidence).toBeUndefined();
    expect(result.watchdog_sleep_stretched, evidence).toBe(true);
    expect(result.guard_usr1_sent, evidence).toBe(true);
    expect(result.cleanup_hold_reached, evidence).toBe(true);
    expect(result.interrupted_worker, evidence).toBeGreaterThan(1);
    expect(result.terminated_pid, evidence).toBeGreaterThan(1);
    expect(result.barrier_expired, evidence).toEqual([]);
    expect(result.survivors_before_cleanup, `${evidence} [survivors before cleanup]`).toEqual([]);
    expect(result.exit, evidence).toBe(0);
    expect(result.stdout, evidence).toContain('rc=143 output=');
    expect(result.duration_ms, evidence).toBeLessThan(6_000);
    expect(result.sentinel_alive_before_cleanup, evidence).toBe(true);
    expect(result.survivors_after_cleanup, evidence).toEqual([]);
    expect(result.residual_bounded_files, evidence).toEqual([]);
  });
  it('ends the worker and the groups it created when the guard receives TERM', () => {
    const result = runLifecycleProbe('guard-terminated');
    const evidence = JSON.stringify(result);
    expect(result.error, evidence).toBeUndefined();
    expect(result.terminated_pid, evidence).toBeGreaterThan(1);
    expect(result.survivors_before_cleanup, `${evidence} [survivors before cleanup]`).toEqual([]);
    expect(result.exit, evidence).toBe(0);
    expect(result.stdout, evidence).toContain('rc=2 output=');
    expect(result.duration_ms, evidence).toBeLessThan(4_000);
    expect(result.sentinel_alive_before_cleanup, evidence).toBe(true);
    expect(result.survivors_after_cleanup, evidence).toEqual([]);
    expect(result.residual_bounded_files, evidence).toEqual([]);
  });
  it('ends the groups the worker created when the outer subshell receives TERM', () => {
    const result = runLifecycleProbe('outer-terminated');
    const evidence = JSON.stringify(result);
    expect(result.error, evidence).toBeUndefined();
    expect(result.terminated_pid, evidence).toBeGreaterThan(1);
    expect(result.survivors_before_cleanup, `${evidence} [survivors before cleanup]`).toEqual([]);
    expect(result.exit, evidence).toBe(0);
    expect(result.stdout, evidence).toContain('rc=143 output=');
    expect(result.sentinel_alive_before_cleanup, evidence).toBe(true);
    expect(result.survivors_after_cleanup, evidence).toEqual([]);
    expect(result.residual_bounded_files, evidence).toEqual([]);
  });
  it.each(['outcome-symlink', 'outcome-existing', 'outcome-fifo', 'outcome-directory', 'outcome-candidate-symlink', 'outcome-candidate-existing', 'outcome-candidate-fifo', 'outcome-candidate-directory'] as const)('refuses an unauthenticated outcome without reading it: %s', (mode) => {
    const result = runLifecycleProbe(mode);
    expect(result.outcome_substitution, JSON.stringify(result)).toBe(mode);
    expect(result.outcome_paths, JSON.stringify(result)).toHaveLength(mode.startsWith('outcome-candidate-') ? 2 : 1);
    expect(result.outcome_claims.length, JSON.stringify(result)).toBeGreaterThan(0);
    expect(result.outcome_claims.every((event: string) => event === 'result' || event === 'deadline-outer'), JSON.stringify(result)).toBe(true);
    expect(result.exit, JSON.stringify(result)).toBe(0);
    expect(result.stdout, JSON.stringify(result)).toContain('rc=2 output=');
    expect(result.duration_ms, JSON.stringify(result)).toBeLessThan(6_000);
    expect(result.outcome_victim_contents, JSON.stringify(result)).toBe('unchanged');
    expect(result.outcome_directory_children, JSON.stringify(result)).toEqual([]);
    expectLifecycleIsolation(result);
  });
  // The fixture lets the first SIGKILL of the watchdog's group reach its leader
  // only, as when a member forks at that instant; the call must still end it.
  it('ends a watchdog group member that escapes the group kill under a refused outcome', () => {
    const result = runLifecycleProbe('outcome-candidate-fork-race-symlink');
    const evidence = JSON.stringify(result);
    expect(result.error, evidence).toBeUndefined();
    expect(result.outcome_substitution, evidence).toBe('outcome-candidate-fork-race-symlink');
    expect(result.fork_race_intercept, evidence).toMatch(/^\d+ \S+\n$/);
    expect(result.watchdog_sleep_stretched, evidence).toBe(true);
    expect(result.survivors_before_cleanup, `${evidence} [survivors before cleanup]`).toEqual([]);
    expect(result.exit, evidence).toBe(0);
    expect(result.stdout, evidence).toContain('rc=2 output=');
    expect(result.duration_ms, evidence).toBeLessThan(6_000);
    expect(result.outcome_victim_contents, evidence).toBe('unchanged');
    expect(result.sentinel_alive_before_cleanup, evidence).toBe(true);
    expect(result.survivors_after_cleanup, evidence).toEqual([]);
  });
  // A trap that runs inside another read sees that read's IFS; the call must
  // still end every group the worker created.
  it('ends the worker groups when the guard trap runs inside its record read', () => {
    const result = runLifecycleProbe('guard-trap-in-record-read');
    const evidence = JSON.stringify(result);
    expect(result.error, evidence).toBeUndefined();
    expect(result.record_read_trap, evidence).toBe('1\n');
    expect(result.watchdog_sleep_stretched, evidence).toBe(true);
    expect(result.survivors_before_cleanup, `${evidence} [survivors before cleanup]`).toEqual([]);
    expect(result.exit, evidence).toBe(0);
    expect(result.sentinel_alive_before_cleanup, evidence).toBe(true);
    expect(result.survivors_after_cleanup, evidence).toEqual([]);
  });
  it.each(['timeout-symlink', 'timeout-existing'] as const)('does not follow or trust a pre-existing timeout marker: %s', (mode) => {
    const result = runLifecycleProbe(mode);
    expect(result.exit, JSON.stringify(result)).toBe(0);
    expect(result.stdout, JSON.stringify(result)).toContain('rc=2 output=');
    expect(result.timeout_victim_contents, JSON.stringify(result)).toBe('unchanged');
    expectLifecycleIsolation(result);
  });
  it.each(['leader-exits', 'status-255', 'printf-override'] as const)('preserves status and cleans owned groups for %s', (mode) => {
    const result = runLifecycleProbe(mode);
    const expected = mode === 'leader-exits' ? 'rc=137 output=' : mode === 'status-255' ? 'rc=255 output=payload' : 'rc=0 output=payload';
    expect(result.exit, JSON.stringify(result)).toBe(0);
    expect(result.stdout, JSON.stringify(result)).toContain(expected);
    expectLifecycleIsolation(result);
  });
  // With real timers the scheduler picks the winner near the deadline, so the
  // result must agree with the observed winner, never with wall-clock hopes: a
  // won result claim with no inner deadline read is rc 0, anything else is 124.
  it.each([1, 2, 3] as const)('arbitrates a near-deadline result by its observed claim order (run %s)', () => {
    const result = runLifecycleProbe('near-deadline');
    const evidence = JSON.stringify(result);
    expect(result.exit, evidence).toBe(0);
    expect(result.sentinel_alive_before_cleanup, evidence).toBe(true);
    expect(result.survivors_before_cleanup, evidence).toEqual([]);
    expect(result.survivors_after_cleanup, evidence).toEqual([]);
    const events: string[] = result.events;
    const claims = events.filter((event) => event.startsWith('O_RESULT_CLAIM '));
    const arbitration = events.filter((event) => event.startsWith('A '));
    expect(claims, evidence).toHaveLength(1);
    expect(arbitration, evidence).toHaveLength(1);
    // The outer's own read decides whether an inner deadline counted; the
    // commit event can be lost when the watchdog is reaped right after link.
    const deadlineRead = /^A .* deadline_rc=(\d+) rc=\d+$/.exec(arbitration[0])?.[1];
    if (events.includes('D_INNER_COMMIT')) expect(deadlineRead, evidence).toBe('124');
    const resultWon = claims[0] === 'O_RESULT_CLAIM rc=0 result=0' && deadlineRead === '0';
    expect(result.stdout, evidence).toContain(resultWon ? 'rc=0 output=payload' : 'rc=124 output=');
  });
  // Force each claim order around the deadline while the command completes
  // normally and the inner watchdog stays gated. The guard parks after its
  // budget, before its claim (result-first) or after it (deadline-first).
  it.for(['event-order-near-deadline-result-first', 'event-order-near-deadline-deadline-first'] as const)('arbitrates a near-deadline completion by forced claim order: %s', (mode, { task }) => {
    const result = runLifecycleProbe(mode);
    const evidence = JSON.stringify(result);
    Object.assign(task.meta, { boundedNearDeadlineOrder: result });
    expect(result.error, evidence).toBeUndefined();
    expect(result.exit, evidence).toBe(0);
    expect(result.child_released_after_guard_parked, evidence).toBe(true);
    expect(result.sentinel_alive_before_cleanup, evidence).toBe(true);
    expect(result.survivors_before_cleanup, evidence).toEqual([]);
    expect(result.survivors_after_cleanup, evidence).toEqual([]);
    const events: string[] = result.events;
    const index = (name: string) => events.findIndex((event) => event === name || event.startsWith(`${name} `));
    expect(index('CONTROL_ERROR'), evidence).toBe(-1);
    expect(index('D_INNER_ENTER'), evidence).toBe(-1);
    expect(index('D_OUTER_PARKED'), evidence).toBeGreaterThanOrEqual(0);
    expect(index('R_FIFO'), evidence).toBeGreaterThan(index('D_OUTER_PARKED'));
    expect(events[index('R_FIFO')], evidence).toMatch(/^R_FIFO rc=0 raw=0 command=\d+ group=\d+$/);
    if (mode === 'event-order-near-deadline-result-first') {
      // The TERM that follows the worker's return reaches the guard before its claim.
      expect(index('D_OUTER_ENTER'), evidence).toBe(-1);
      expect(events[index('O_RESULT_CLAIM')], evidence).toBe('O_RESULT_CLAIM rc=0 result=0');
      expect(events[index('A')], evidence).toMatch(/^A worker=\d+ worker_rc=0 guard=\d+ guard_rc=0 deadline_rc=0 rc=0$/);
      expect(result.stdout, evidence).toContain('rc=0 output=payload');
    } else {
      expect(events[index('O_OUTER_CLAIM')], evidence).toMatch(/^O_OUTER_CLAIM rc=0 worker=\d+$/);
      expect(index('D_OUTER_PARKED'), evidence).toBeGreaterThan(index('O_OUTER_CLAIM'));
      expect(events[index('O_RESULT_CLAIM')], evidence).toBe('O_RESULT_CLAIM rc=1 result=0');
      expect(events[index('A')], evidence).toMatch(/^A worker=\d+ worker_rc=124 guard=\d+ guard_rc=124 deadline_rc=0 rc=124$/);
      expect(result.stdout, evidence).toContain('rc=124 output=payload');
    }
  });
  it.for(['event-order-frame-gap', 'event-order-frame-gap-control'] as const)('delivers a frame written between polls: %s', (mode, { task }) => {
    const result = runLifecycleProbe(mode);
    const evidence = JSON.stringify(result);
    Object.assign(task.meta, { boundedFrameGap: result });
    expect(result.error, evidence).toBeUndefined();
    expect(result.transport, evidence).toBe('pipe');
    expect(result.exit, evidence).toBe(0);
    expect(result.bash_version?.returncode, evidence).toBe(0);
    expect(result.bash_version?.first_line, evidence).toMatch(/^GNU bash, version \d+\.\d+/);
    expect(result.sentinel_alive_before_cleanup, evidence).toBe(true);
    expect(result.survivors_before_cleanup, evidence).toEqual([]);
    expect(result.survivors_after_cleanup, evidence).toEqual([]);
    const events: string[] = result.events;
    const index = (name: string) => events.findIndex((event) => event === name || event.startsWith(`${name} `));
    expect(index('CONTROL_ERROR'), evidence).toBe(-1);
    expect(index('R_POLL_HOLD'), evidence).toBeGreaterThanOrEqual(0);
    expect(index('CHILD_RELEASED'), evidence).toBeGreaterThan(index('R_POLL_HOLD'));
    expect(index('CHILD_RELEASED'), evidence).toBeGreaterThanOrEqual(0);
    expect(index('R_WRITTEN'), evidence).toBeGreaterThan(index('CHILD_RELEASED'));
    expect(index('R_WRITTEN'), evidence).toBeGreaterThanOrEqual(0);
    expect(index('R_POLL_RELEASE'), evidence).toBeGreaterThan(index('R_WRITTEN'));
    expect(result.result_holder_closed, evidence).toBe(mode === 'event-order-frame-gap' ? 'before-poll-release' : 'after-delivery');
    expect(events.filter((event) => event.startsWith('R_FIFO ')), evidence).toHaveLength(1);
    expect(index('R_WAIT'), evidence).toBe(-1);
    expect(events[index('R_FIFO')], evidence).toMatch(/^R_FIFO rc=0 raw=0 command=\d+ group=\d+$/);
    expect(index('R_POLL_RELEASE'), evidence).toBeGreaterThanOrEqual(0);
    expect(index('R_FIFO'), evidence).toBeGreaterThan(index('R_POLL_RELEASE'));
    expect(events[index('O_RESULT_CLAIM')], evidence).toBe('O_RESULT_CLAIM rc=0 result=0');
    expect(index('O_OUTER_CLAIM'), evidence).toBe(-1);
    expect(events[index('A')], evidence).toMatch(/^A worker=\d+ worker_rc=0 guard=\d+ guard_rc=0 deadline_rc=0 rc=0$/);
    expect(result.stdout, evidence).toContain('rc=0 output=payload');
  });
  it('keeps the command status when the result FIFO carries a fragment', ({ task }) => {
    const result = runLifecycleProbe('event-order-frame-fragment');
    const evidence = JSON.stringify(result);
    Object.assign(task.meta, { boundedFrameFragment: result });
    expect(result.error, evidence).toBeUndefined();
    expect(result.exit, evidence).toBe(0);
    expect(result.fragment_written, evidence).toBe(true);
    expect(result.stdout, evidence).toContain('rc=0 output=payload');
    const events: string[] = result.events;
    const index = (name: string) => events.findIndex((event) => event === name || event.startsWith(`${name} `));
    expect(events[index('O_RESULT_CLAIM')], evidence).toBe('O_RESULT_CLAIM rc=0 result=0');
    expect(events[index('R_REJECT')], evidence).toBe('R_REJECT raw=43');
    expect(index('R_FIFO'), evidence).toBe(-1);
    expect(index('R_WAIT'), evidence).toBe(-1);
    expect(index('CHILD_RELEASED'), evidence).toBeGreaterThan(index('R_REJECT'));
    expect(index('CONTROL_ERROR'), evidence).toBe(-1);
    expect(result.sentinel_alive_before_cleanup, evidence).toBe(true);
    expect(result.survivors_before_cleanup, evidence).toEqual([]);
    expect(result.survivors_after_cleanup, evidence).toEqual([]);
  });
  // A frame written after a poll, by a command reaped before the liveness
  // check, must still be delivered.
  it('delivers a frame written between a poll and the liveness check', ({ task }) => {
    const result = runLifecycleProbe('event-order-frame-before-liveness');
    const evidence = JSON.stringify(result);
    Object.assign(task.meta, { boundedFrameBeforeLiveness: result });
    expect(result.error, evidence).toBeUndefined();
    expect(result.exit, evidence).toBe(0);
    const events: string[] = result.events;
    const index = (name: string) => events.findIndex((event) => event === name || event.startsWith(`${name} `));
    expect(index('CONTROL_ERROR'), evidence).toBe(-1);
    expect(index('R_LIVENESS_HOLD'), evidence).toBeGreaterThanOrEqual(0);
    expect(['reaped', 'zombie'], evidence).toContain(result.command_state_at_release);
    expect(result.result_holder_closed, evidence).toBe('before-poll-release');
    expect(index('R_WRITTEN'), evidence).toBeGreaterThan(index('R_LIVENESS_HOLD'));
    expect(index('R_WRITTEN'), evidence).toBeGreaterThanOrEqual(0);
    expect(index('R_LIVENESS_RELEASE'), evidence).toBeGreaterThan(index('R_WRITTEN'));
    expect(events.filter((event) => event.startsWith('R_FIFO ')), evidence).toHaveLength(1);
    expect(index('R_WAIT'), evidence).toBe(-1);
    if (result.command_state_at_release === 'reaped') {
      expect(index('R_DRAIN'), evidence).toBeGreaterThanOrEqual(0);
      expect(index('R_DRAIN'), evidence).toBeLessThan(index('R_FIFO'));
    }
    expect(events[index('R_FIFO')], evidence).toMatch(/^R_FIFO rc=0 raw=0 command=\d+ group=\d+$/);
    expect(index('R_LIVENESS_RELEASE'), evidence).toBeGreaterThanOrEqual(0);
    expect(index('R_FIFO'), evidence).toBeGreaterThan(index('R_LIVENESS_RELEASE'));
    expect(events[index('O_RESULT_CLAIM')], evidence).toBe('O_RESULT_CLAIM rc=0 result=0');
    expect(result.stdout, evidence).toContain('rc=0 output=payload');
    expect(result.survivors_before_cleanup, evidence).toEqual([]);
    expect(result.survivors_after_cleanup, evidence).toEqual([]);
  });
  // A frame that reaches the worker while it is descheduled past a poll second
  // must be read whole.
  it('reads a whole frame that arrives while the worker is descheduled', ({ task }) => {
    const result = runLifecycleProbe('event-order-frame-tear');
    const evidence = JSON.stringify(result);
    Object.assign(task.meta, { boundedFrameTear: result });
    expect(result.error, evidence).toBeUndefined();
    expect(result.exit, evidence).toBe(0);
    expect(result.tear_setup?.stopped, evidence).toBe(true);
    const events: string[] = result.events;
    const index = (name: string) => events.findIndex((event) => event === name || event.startsWith(`${name} `));
    expect(index('CONTROL_ERROR'), evidence).toBe(-1);
    expect(index('R_READ_ARMED'), evidence).toBeGreaterThanOrEqual(0);
    expect(index('CHILD_RELEASED'), evidence).toBeGreaterThan(index('R_READ_ARMED'));
    expect(index('CHILD_RELEASED'), evidence).toBeGreaterThanOrEqual(0);
    expect(index('R_WRITTEN'), evidence).toBeGreaterThan(index('CHILD_RELEASED'));
    expect(events.filter((event) => event.startsWith('R_FIFO ')), evidence).toHaveLength(1);
    expect(index('R_WAIT'), evidence).toBe(-1);
    expect(index('R_REJECT'), evidence).toBe(-1);
    expect(events[index('R_FIFO')], evidence).toMatch(/^R_FIFO rc=0 raw=0 command=\d+ group=\d+$/);
    expect(events[index('O_RESULT_CLAIM')], evidence).toBe('O_RESULT_CLAIM rc=0 result=0');
    expect(result.stdout, evidence).toContain('rc=0 output=payload');
    expect(result.survivors_before_cleanup, evidence).toEqual([]);
    expect(result.survivors_after_cleanup, evidence).toEqual([]);
  });
  // A caller's TMOUT must not put a timeout on the worker's untimed read.
  it('keeps waiting for the frame when the caller sets TMOUT', ({ task }) => {
    const result = runLifecycleProbe('event-order-frame-tmout');
    const evidence = JSON.stringify(result);
    Object.assign(task.meta, { boundedFrameTmout: result });
    expect(result.error, evidence).toBeUndefined();
    expect(result.exit, evidence).toBe(0);
    const events: string[] = result.events;
    const index = (name: string) => events.findIndex((event) => event === name || event.startsWith(`${name} `));
    expect(index('CONTROL_ERROR'), evidence).toBe(-1);
    // A missing L_COMMAND means the command never passed its start read: a harness failure.
    expect(index('L_COMMAND'), `HARNESS tmout-command-start ${evidence}`).toBeGreaterThanOrEqual(0);
    expect(index('R_READ_ARMED'), evidence).toBeGreaterThanOrEqual(0);
    expect(events.filter((event) => event.startsWith('R_FIFO ')), evidence).toHaveLength(1);
    expect(index('R_WAIT'), evidence).toBe(-1);
    expect(events[index('O_RESULT_CLAIM')], evidence).toBe('O_RESULT_CLAIM rc=0 result=0');
    expect(events[index('R_FIFO')], evidence).toMatch(/^R_FIFO rc=0 raw=0 command=\d+ group=\d+$/);
    expect(index('CHILD_RELEASED'), evidence).toBeGreaterThan(index('R_READ_ARMED'));
    expect(index('CHILD_RELEASED'), evidence).toBeGreaterThanOrEqual(0);
    expect(index('R_FIFO'), evidence).toBeGreaterThan(index('CHILD_RELEASED'));
    expect(result.stdout, evidence).toContain('rc=0 output=payload');
    expect(result.survivors_before_cleanup, evidence).toEqual([]);
    expect(result.survivors_after_cleanup, evidence).toEqual([]);
  });
  it('reaps a command child that survives the first group signal', () => {
    const result = runLifecycleProbe('command-group-descendant');
    expect(result.command_partial_signal, JSON.stringify(result)).toBeTruthy();
    expect(result.exit, JSON.stringify(result)).toBe(0);
    expect(result.stdout, JSON.stringify(result)).toContain('rc=0 output=');
    expectLifecycleIsolation(result);
  });
  it('keeps command-substitution helpers in the owned worker group', () => {
    const result = runLifecycleProbe('cleanup-child-group');
    expect(result.exit, JSON.stringify(result)).toBe(0);
    expect(result.umask_groups.length, JSON.stringify(result)).toBeGreaterThan(0);
    expect(result.umask_groups, JSON.stringify(result)).toEqual(
      result.umask_groups.map(() => result.expected_helper_group),
    );
    expect(result.stdout, JSON.stringify(result)).toContain('rc=124 output=');
    expectLifecycleIsolation(result);
  });
  it('reaps a timer child that survives the first group signal', () => {
    const result = runLifecycleProbe('deadline-timer-descendant');
    expect(result.timer_partial_signal, JSON.stringify(result)).toBeTruthy();
    expect(result.timer_survivors_after_return, JSON.stringify(result)).toEqual([]);
    expect(result.exit, JSON.stringify(result)).toBe(0);
    expect(result.stdout, JSON.stringify(result)).toContain('rc=2 output=');
    expect(result.sentinel_alive_before_cleanup, JSON.stringify(result)).toBe(true);
    expect(result.dangerous_kill_attempts, JSON.stringify(result)).toEqual([]);
    expect(result.survivors_before_cleanup, JSON.stringify(result)).toEqual([]);
    expect(result.survivors_after_cleanup, JSON.stringify(result)).toEqual([]);
  });
  it.each([
    ['deadline-helper-vanished', 124, true, false],
    ['deadline-helper-signal-refused', 2, false, true],
  ] as const)('handles %s without masking a surviving helper', (mode, status, vanished, refused) => {
    const result = runLifecycleProbe(mode, true);
    expect(result.exit, JSON.stringify(result)).toBe(0);
    expect(result.timer_partial_signal, JSON.stringify(result)).toBeTruthy();
    expect(result.helper_vanished_after_probe, JSON.stringify(result)).toBe(vanished);
    expect(result.helper_signal_refused, JSON.stringify(result)).toBe(refused);
    expect(result.stdout, JSON.stringify(result)).toContain(`rc=${status} output=`);
    expect(result.terminal_foreground_group, JSON.stringify(result)).toBe(result.root_pid);
    expect(result.terminal_echo, JSON.stringify(result)).toContain('go');
    expect(result.sentinel_alive_before_cleanup, JSON.stringify(result)).toBe(true);
    if (vanished) expect(result.survivors_before_cleanup, JSON.stringify(result)).toEqual([]);
    expect(result.survivors_after_cleanup, JSON.stringify(result)).toEqual([]);
  });
  it('preserves job-control isolation under a controlling PTY', () => {
    const result = runLifecycleProbe('nested', true);
    expect(result.exit, JSON.stringify(result)).toBe(0);
    expect(result.terminal_foreground_group, JSON.stringify(result)).toBe(result.root_pid);
    expect(result.terminal_echo, JSON.stringify(result)).toContain('go');
    expect(result.stdout, JSON.stringify(result)).toContain('rc=124 output=');
    expectLifecycleIsolation(result);
  });
  // A watchdog that dies after creating its deadline marker but before writing
  // the token must not turn an exhausted budget into a protocol failure: the
  // outer guard still owns the deadline, so the contract result is 124.
  it('keeps the deadline when the watchdog writer dies between create and token write', () => {
    const result = runLifecycleProbe('deadline-writer-interrupted');
    expect(result.exit, JSON.stringify(result)).toBe(0);
    // Setup proof: the real writer was reached, created a size-0 file, and failed.
    expect(result.deadline_writer_armed, JSON.stringify(result)).toBe(true);
    expect(result.deadline_writer_size0, JSON.stringify(result)).toBe(true);
    expect(result.deadline_writer_exit, JSON.stringify(result)).toHaveLength(1);
    expect(result.deadline_writer_exit[0], JSON.stringify(result)).not.toBe('0');
    expect(result.stdout, JSON.stringify(result)).toContain('rc=124 output=');
    expect(result.deadline_marker_observed, JSON.stringify(result)).toBe('absent');
    expect(result.deadline_watchdog_term, JSON.stringify(result)).toBe(false);
    expect(result.residual_bounded_files, JSON.stringify(result)).toEqual([]);
    expectLifecycleIsolation(result);
  });
  // The deadline marker is exclusive: an existing file at its path is never
  // replaced by the watchdog, and an unauthenticated marker fails closed. A
  // watchdog whose publish failed must not go on to signal the command.
  it('never replaces a deadline marker that already exists', () => {
    const result = runLifecycleProbe('deadline-writer-preexisting');
    expect(result.exit, JSON.stringify(result)).toBe(0);
    expect(result.deadline_preexisting_planted, JSON.stringify(result)).toBe(true);
    expect(result.deadline_writer_armed, JSON.stringify(result)).toBe(true);
    expect(result.deadline_marker_observed, JSON.stringify(result)).toBe('other');
    expect(result.deadline_watchdog_term, JSON.stringify(result)).toBe(false);
    expect(result.stdout, JSON.stringify(result)).toContain('rc=2 output=');
    expect(result.residual_bounded_files, JSON.stringify(result)).toEqual([]);
    expectLifecycleIsolation(result);
  });
  // Only the publish step runs under a zero file-size limit, so the marker path
  // must go from absent straight to the full token: a copying publish leaves an
  // empty marker. The published marker is private to the owner.
  it('publishes the deadline marker without writing through its path', () => {
    const result = runLifecycleProbe('deadline-writer-publish-limited');
    const evidence = JSON.stringify(result);
    expect(result.exit, evidence).toBe(0);
    expect(result.deadline_writer_armed, evidence).toBe(true);
    expect(result.deadline_publish_limited, evidence).toBe(true);
    expect(result.deadline_absent_before_publish, evidence).toBe(true);
    expect(result.deadline_marker_observed, evidence).toBe('token');
    expect(result.deadline_marker_mode, evidence).toBe('600');
    expect(result.deadline_watchdog_term, evidence).toBe(true);
    expect(result.stdout, evidence).toContain('rc=124 output=');
    expect(result.residual_bounded_files, evidence).toEqual([]);
    expect(result.sentinel_alive_before_cleanup, evidence).toBe(true);
    expect(result.survivors_before_cleanup, evidence).toEqual([]);
    expect(result.survivors_after_cleanup, evidence).toEqual([]);
  });
  // The pending token file is created exclusively: a planted symlink is never
  // followed, and the refused writer neither publishes nor signals.
  it('refuses a pending deadline file that already exists', () => {
    const result = runLifecycleProbe('deadline-writer-pending-planted');
    const evidence = JSON.stringify(result);
    expect(result.exit, evidence).toBe(0);
    expect(result.deadline_pending_planted, evidence).toBe(true);
    expect(result.deadline_writer_armed, evidence).toBe(true);
    expect(result.pending_victim_contents, evidence).toBe('victim\n');
    expect(result.deadline_marker_observed, evidence).toBe('absent');
    expect(result.deadline_watchdog_term, evidence).toBe(false);
    expect(result.stdout, evidence).toContain('rc=124 output=');
    expect(result.residual_bounded_files, evidence).toEqual([]);
    expect(result.sentinel_alive_before_cleanup, evidence).toBe(true);
    expect(result.survivors_before_cleanup, evidence).toEqual([]);
    expect(result.survivors_after_cleanup, evidence).toEqual([]);
  });
});

/**
 * Runs a snippet against the real library. When `withoutTimeout` is set, PATH is
 * reduced to a shim directory holding only stock utilities. The supervisor must
 * work with timeout/gtimeout installed and with both genuinely absent.
 */
function runSnippet(snippet: string, opts: { withoutTimeout?: boolean } = {}) {
  const repoRoot = process.cwd();
  let env = { ...process.env };
  let shimDir: string | undefined;

  if (opts.withoutTimeout) {
    shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-shim-'));
    for (const bin of ['sleep', 'mktemp', 'mkfifo', 'rm', 'rmdir', 'cat', 'false', 'ps']) {
      const resolved = resolveBinary(bin);
      if (resolved) fs.symlinkSync(resolved, path.join(shimDir, bin));
    }
    env = { ...env, PATH: shimDir };
  }

  // The snippet runs from a script on disk, never through `bash -c`. Moving the
  // library path into a positional argument was the #66 fix, and it did NOT clear
  // the query: CodeQL reopened the identical line as #76, because the `-c` program
  // string is itself the sink — a cwd-derived value reaching that call is flagged
  // whichever argv slot carries it. The sibling whatsoup-health-token-wrapper test
  // closed #75 for good by dropping `-c` and invoking a script file, while still
  // passing a cwd-derived path positionally; that is the shape reproduced here.
  //
  // `$0` shifts from 'bounded-lib' to the script path. deploy/lib/bounded-exec.sh
  // reads neither `$0` nor `BASH_SOURCE`, so nothing observes the difference.
  const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-snippet-'));
  const scriptPath = path.join(scriptDir, 'snippet.sh');
  fs.writeFileSync(scriptPath, `. "$1"\n${snippet}\n`, 'utf8');

  try {
    // Absolute bash path: the shim PATH deliberately omits everything except the
    // few utilities the fallback branch needs, so `bash` itself is not on it.
    const bash = resolveBinary('bash') ?? 'bash';
    return spawnSync(bash, [scriptPath, path.join(repoRoot, BOUNDED_LIB)], {
      encoding: 'utf8',
      env,
      cwd: repoRoot,
    });
  } finally {
    fs.rmSync(scriptDir, { recursive: true, force: true });
    if (shimDir) fs.rmSync(shimDir, { recursive: true, force: true });
  }
}

describe.each([
  ['as installed on this host', false],
  ['with timeout(1) absent (stock macOS shape)', true],
])('whatsoup_run_bounded %s', (_label, withoutTimeout) => {
  const opts = { withoutTimeout };

  it.each(['0', '000'])('does not launch a command with a zero budget (%s)', (budget) => {
    const res = runSnippet(`whatsoup_run_bounded ${budget} cat /dev/null; echo "rc=$?"`, opts);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain('rc=124');
  });

  it.each(['-1', 'invalid', '1.5', '999999999999999999999999'])('rejects invalid budget %s before arithmetic or launch', (budget) => {
    const res = runSnippet(`whatsoup_run_bounded ${budget} cat /dev/null; echo "rc=$?"`, opts);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain('rc=2');
  });

  it.each(['timeout', 'gtimeout'])('does not invoke %s for a zero budget', (tool) => {
    const res = runSnippet([
      `${tool}() { echo delegated; return 91; }`,
      'whatsoup_run_bounded 0 cat /dev/null; echo "rc=$?"',
    ].join('\n'), { withoutTimeout: true });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain('rc=124');
    expect(res.stdout).not.toContain('delegated');
  });

  it('returns the command status for a fast command', () => {
    const res = runSnippet('whatsoup_run_bounded 3 cat </dev/null; echo "rc=$?"', opts);
    expect(res.stdout).toContain('rc=0');
  });

  it('kills a hung command and reports 124 within the budget', () => {
    const started = Date.now();
    const res = runSnippet('whatsoup_run_bounded 1 sleep 30; echo "rc=$?"', opts);
    expect(res.stdout).toContain('rc=124');
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('propagates a non-timeout failure status unchanged', () => {
    const res = runSnippet('whatsoup_run_bounded 3 false; echo "rc=$?"', opts);
    expect(res.stdout).toContain('rc=1');
  });

  it('preserves a natural exit 137 before the deadline', () => {
    const started = Date.now();
    const res = runSnippet('whatsoup_run_bounded 5 /bin/sh -c "exit 137"; echo "rc=$?"', opts);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain('rc=137');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('does not overflow a valid large budget when adding kill grace', () => {
    const res = runSnippet('whatsoup_run_bounded 9223372036854775807 /usr/bin/true; echo "rc=$?"', opts);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain('rc=0');
  });

  it('allows a command to finish its TERM handler before the kill grace expires', () => {
    const res = runSnippet([
      'whatsoup_run_bounded 1 /bin/sh -c \'trap "sleep 0.2; echo term-finished; exit 0" TERM; while :; do sleep 1; done\'',
      'echo "rc=$?"',
    ].join('\n'), opts);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain('term-finished');
    expect(res.stdout).toContain('rc=124');
  });

  it('passes stdin through to the wrapped command', () => {
    const res = runSnippet(
      'got="$(printf %s secret-value | whatsoup_run_bounded 5 cat)"; echo "got=$got"',
      opts,
    );
    expect(res.stdout).toContain('got=secret-value');
  });

  it('does not hold command substitution open for the full budget', () => {
    const started = Date.now();
    const res = runSnippet('out="$(whatsoup_run_bounded 30 cat </dev/null)"; echo done', opts);
    expect(res.stdout).toContain('done');
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it.each(['set +m', 'set -m'])('preserves caller options, traps and environment with %s', (monitor) => {
    const res = runSnippet([
      monitor,
      'set -u',
      'export BOUNDED_CALLER_FIXTURE=unchanged',
      'trap ":" USR1',
      'before_options="$-"; before_traps="$(trap -p)"; before_umask="$(umask)"',
      'if whatsoup_run_bounded 3 false; then rc=0; else rc=$?; fi',
      '[ "$before_options" = "$-" ] || exit 91',
      '[ "$before_traps" = "$(trap -p)" ] || exit 92',
      '[ "$before_umask" = "$(umask)" ] || exit 93',
      '[ "$BOUNDED_CALLER_FIXTURE" = unchanged ] || exit 94',
      'printf "rc=%s caller-preserved\\n" "$rc"',
    ].join('\n'), opts);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain('rc=1 caller-preserved');
  });
});

describe.each([false, true])('whatsoup_run_bounded hard kill with timeout absent=%s', (withoutTimeout) => {
  it(
    'bounds the wall clock, not just the return code',
    () => {
      // Bare `timeout Ns` sends SIGTERM at the budget and then WAITS for the child
      // to exit, so a child that ignores SIGTERM runs to its own completion yet
      // still yields 124 — the wrapper reports a timeout it never enforced. A
      // `sleep` child dies on SIGTERM, so a sleep-based test goes green against
      // the bug and certifies nothing: the child must ignore SIGTERM for the
      // assertion to mean anything.
      const started = Date.now();
      const res = runSnippet(
        'whatsoup_run_bounded 1 /bin/bash -c \'trap "" TERM; sleep 30\'; echo "rc=$?"',
        { withoutTimeout },
      );
      const wall = Date.now() - started;

      expect(res.stdout).toContain('rc=124');
      // budget 1s + kill grace 2s => ~3s. The broken bare-timeout path would
      // block for the child's full 30s. Under 10s proves the child was actually
      // killed, not merely reported as timed out.
      expect(wall).toBeLessThan(10_000);
    },
  );
});
