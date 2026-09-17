import { describe, it, expect } from 'vitest';
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

const BOUNDED_LIB = 'deploy/lib/bounded-exec.sh';

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

const SHIM_SEARCH_PATH = ['/usr/bin', '/bin', '/usr/local/bin', '/opt/homebrew/bin'];

function resolveBinary(name: string): string | undefined {
  for (const dir of SHIM_SEARCH_PATH) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

// A fresh session identifies every owned group, including Bash job-control
// groups. Capture survivors before finally cleans them; cleanup cannot make a
// lifecycle assertion pass. Processes that create a new session are outside
// this boundary and are not claimed as covered by these probes.
const LIFECYCLE_DRIVER = String.raw`
import fcntl, json, os, pathlib, pty, select, signal, subprocess, sys, termios, time
root, helper, bash, mode, terminal = sys.argv[1:]
root = pathlib.Path(root)
def interrupted(signum, frame):
    raise TimeoutError('outer lifecycle watchdog interrupted the fixture')
signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
def members(session):
    result = subprocess.run(['/bin/ps' if os.path.exists('/bin/ps') else '/usr/bin/ps', '-axo', 'pid=,ppid=,pgid='], capture_output=True, text=True, timeout=3)
    if result.returncode: raise RuntimeError('process identity unavailable')
    found = []
    for row in result.stdout.splitlines():
        fields = row.split()
        if len(fields) < 3: continue
        pid = int(fields[0])
        try:
            if os.getsid(pid) == session: found.append({'pid': pid, 'ppid': int(fields[1]), 'pgid': int(fields[2]), 'identity': row})
        except ProcessLookupError: pass
    return found
record = {}
sentinel = subprocess.Popen(['/bin/sleep', '30'], start_new_session=True)
master, slave = pty.openpty() if terminal == 'pty' else (None, None)
with (root / 'stdout').open('w') as out, (root / 'stderr').open('w') as err:
    started = time.monotonic()
    child = subprocess.Popen([bash, str(root / 'probe.sh'), helper, bash, str(root / 'child.sh'), mode], stdin=slave if slave is not None else subprocess.PIPE, stdout=out, stderr=err, text=True, start_new_session=True, preexec_fn=(lambda: fcntl.ioctl(slave, termios.TIOCSCTTY, 0)) if slave is not None else None)
    session = os.getsid(child.pid)
    try:
        if session != child.pid: raise RuntimeError('test session ownership unavailable')
        record['root_pid'] = child.pid
        record['session_id'] = session
        record['initial'] = members(session)
        record['sentinel'] = members(os.getsid(sentinel.pid))
        record['sentinel_group'] = os.getpgid(sentinel.pid)
        record['caller_group'] = os.getpgid(child.pid)
        if master is not None:
            record['terminal_foreground_group'] = os.tcgetpgrp(master)
            os.write(master, b'go\n')
            # Darwin's terminal close can wait for undrained echo after the
            # command has already exited. The fixture owns the master reader.
            if select.select([master], [], [], 2)[0]: record['terminal_echo'] = os.read(master, 4096).decode()
        else: child.stdin.write('go\n'); child.stdin.close()
        if mode in ('timeout-symlink', 'timeout-existing'):
            deadline = time.monotonic() + 3
            control = None
            while time.monotonic() < deadline:
                matches = list(root.glob('whatsoup-bounded-control.*'))
                if matches:
                    control = matches[0]
                    break
                time.sleep(0.01)
            if control is None: raise RuntimeError('timeout control record unavailable')
            timeout_path = root / ('whatsoup-bounded-timeout.%s.%s' % (child.pid, control.name.rsplit('.', 1)[1]))
            victim = root / 'timeout-victim'
            victim.write_text('unchanged')
            if mode == 'timeout-symlink': timeout_path.symlink_to(victim)
            else: timeout_path.write_text('preexisting')
            (root / 'timeout-fixture-ready').write_text('ready')
            record['timeout_victim'] = str(victim)
        if mode.startswith('control-'):
            deadline = time.monotonic() + 3
            control = None
            while time.monotonic() < deadline:
                matches = list(root.glob('whatsoup-bounded-authorize.*')) or list(root.glob('whatsoup-bounded-control.*'))
                if matches and 'release=1' in matches[0].read_text():
                    control = matches[0]
                    break
                time.sleep(0.01)
            if control is None: raise RuntimeError('complete control record unavailable')
            fields = dict(line.split('=', 1) for line in control.read_text().splitlines() if '=' in line)
            target_group = {
                'control-low-group': '1',
                'control-caller-group': str(record['caller_group']),
                'control-external-group': str(record['sentinel_group']),
            }.get(mode, fields['command_group'])
            target_pid = {
                'control-low-group': '1',
                'control-caller-group': str(record['caller_group']),
                'control-external-group': str(sentinel.pid),
            }.get(mode, fields.get('command_pid', target_group))
            (root / 'dangerous-groups').write_text(','.join(('1', str(record['caller_group']), str(record['sentinel_group']))))
            replacement = [
                'directory=' + fields['directory'],
                'command_pid=' + target_pid,
                'command_group=' + target_group,
                'watchdog_pid=' + fields.get('watchdog_pid', target_pid),
                'watchdog_group=' + fields['watchdog_group'],
                'release=1',
            ]
            if mode != 'control-tokenless': replacement.insert(0, 'token=' + fields['token'])
            if mode == 'control-duplicate-token': replacement.insert(1, 'token=' + fields['token'])
            staged = root / 'replacement-control'
            staged.write_text('\n'.join(replacement) + '\n')
            staged.replace(control)
            record['control_corrupted'] = mode
        if mode in ('worker-stopped-after-authorization', 'forged-completion-worker-stopped', 'deadline-timer-descendant', 'cleanup-child-group'):
            deadline = time.monotonic() + 3
            authorization = None
            while time.monotonic() < deadline:
                matches = list(root.glob('whatsoup-bounded-authorize.*'))
                if matches and 'release=1' in matches[0].read_text():
                    authorization = matches[0]
                    break
                time.sleep(0.01)
            if authorization is None: raise RuntimeError('worker authorization unavailable')
            fields = dict(line.split('=', 1) for line in authorization.read_text().splitlines() if '=' in line)
            command_pid = int(fields['command_pid'])
            worker = next((item['ppid'] for item in members(session) if item['pid'] == command_pid), None)
            if worker is None or worker == child.pid: raise RuntimeError('worker identity unavailable')
            if mode == 'forged-completion-worker-stopped':
                token = authorization.name.rsplit('.', 1)[1]
                completion = root / ('whatsoup-bounded-cleanup-complete.%s.%s' % (child.pid, token))
                completion.write_text('token=' + token + '\ncomplete=1\n')
                record['forged_completion'] = str(completion)
            record['expected_helper_group'] = worker
            if mode != 'cleanup-child-group':
                os.kill(worker, signal.SIGSTOP)
                record['stopped_worker'] = worker
        if mode in ('dead-leader-before-authorization', 'dead-leader-clean-cleanup', 'dead-leader-finishing-cleanup', 'deadline-fifo-after-cleanup', 'authorization-unreadable-after-cleanup'):
            deadline = time.monotonic() + 3
            authorization = None
            while time.monotonic() < deadline:
                matches = list(root.glob('whatsoup-bounded-authorize.*'))
                if matches and 'release=1' in matches[0].read_text():
                    authorization = matches[0]
                    break
                time.sleep(0.01)
            if authorization is None: raise RuntimeError('outer authorization unavailable')
            fields = dict(line.split('=', 1) for line in authorization.read_text().splitlines() if '=' in line)
            command_pid = int(fields['command_pid'])
            worker = next((item['ppid'] for item in members(session) if item['pid'] == command_pid), None)
            worker_record = next((item for item in members(session) if item['pid'] == worker), None)
            if worker is None or worker_record is None: raise RuntimeError('worker identity unavailable')
            outer = worker_record['ppid']
            guard_candidates = [
                item for item in members(session)
                if item['ppid'] == outer and item['pid'] != worker and item['pgid'] != worker_record['pgid']
            ]
            if len(guard_candidates) != 1: raise RuntimeError('guard identity unavailable')
            guard = guard_candidates[0]['pid']
            (root / 'expected-guard-pid').write_text(str(guard))
            os.kill(guard, signal.SIGSTOP)
            record['stopped_guard'] = guard
            while not (root / 'authorization-rm-ready').exists() and time.monotonic() < deadline + 5:
                time.sleep(0.01)
            if not (root / 'authorization-rm-ready').exists(): raise RuntimeError('worker cleanup did not retain authorization')
            try:
                os.kill(command_pid, 0)
            except ProcessLookupError:
                record['command_pid_reaped_before_authorization'] = True
            else:
                raise RuntimeError('command leader remained present before outer authorization')
            if mode == 'dead-leader-finishing-cleanup':
                os.kill(guard, signal.SIGCONT)
                record['continued_guard'] = guard
                authority_deadline = time.monotonic() + 2
                while not (root / 'outer-authority-finished').exists() and time.monotonic() < authority_deadline:
                    time.sleep(0.01)
                record['outer_authority_finished'] = (root / 'outer-authority-finished').exists()
                if not record['outer_authority_finished']: raise RuntimeError('outer authority check did not complete')
                try:
                    release = os.open(root / 'authorization-rm-release', os.O_WRONLY | os.O_NONBLOCK)
                    try: os.write(release, b'release\n')
                    finally: os.close(release)
                    record['cleanup_released_after_authority'] = True
                except OSError as error:
                    record['cleanup_release_error'] = repr(error)
            if mode == 'deadline-fifo-after-cleanup':
                deadlines = list(root.glob('whatsoup-bounded-deadline.*'))
                if len(deadlines) != 1: raise RuntimeError('deadline handoff unavailable')
                release = os.open(root / 'authorization-rm-release', os.O_WRONLY | os.O_NONBLOCK)
                try: os.write(release, b'release\n')
                finally: os.close(release)
                cleanup_deadline = time.monotonic() + 3
                while any(item['pid'] == worker for item in members(session)) and time.monotonic() < cleanup_deadline:
                    time.sleep(0.01)
                record['worker_cleanup_completed_before_authorization'] = not any(item['pid'] == worker for item in members(session))
                if not record['worker_cleanup_completed_before_authorization']: raise RuntimeError('worker did not finish before deadline substitution')
                while not (root / 'deadline-race-substituted').exists() and time.monotonic() < cleanup_deadline + 3:
                    time.sleep(0.01)
                record['deadline_replaced_with_fifo'] = (root / 'deadline-race-substituted').exists()
                if not record['deadline_replaced_with_fifo']: raise RuntimeError('deadline stat/open substitution was not reached')
            if mode in ('dead-leader-clean-cleanup', 'authorization-unreadable-after-cleanup'):
                if mode == 'authorization-unreadable-after-cleanup':
                    authorization.chmod(0)
                    record['authorization_unreadable'] = not os.access(authorization, os.R_OK)
                release = os.open(root / 'authorization-rm-release', os.O_WRONLY | os.O_NONBLOCK)
                try: os.write(release, b'release\n')
                finally: os.close(release)
                cleanup_deadline = time.monotonic() + 3
                while any(item['pid'] == worker for item in members(session)) and time.monotonic() < cleanup_deadline:
                    time.sleep(0.01)
                record['worker_cleanup_completed_before_authorization'] = not any(item['pid'] == worker for item in members(session))
                if not record['worker_cleanup_completed_before_authorization']: raise RuntimeError('worker did not finish clean cleanup')
            if mode == 'dead-leader-before-authorization':
                os.kill(guard, signal.SIGCONT)
                record['continued_guard'] = guard
            elif mode != 'dead-leader-finishing-cleanup':
                record['guard_left_stopped_for_deadline_reader'] = guard
        if mode == 'handshake-early-cont':
            deadline = time.monotonic() + 3
            while not (root / 'handshake-stop-entered').exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            if not (root / 'handshake-stop-entered').exists(): raise RuntimeError('worker stop entry unavailable')
            early_deadline = time.monotonic() + 0.2
            while not (root / 'handshake-early-cont').exists() and time.monotonic() < early_deadline:
                time.sleep(0.01)
            record['early_cont_before_stop'] = (root / 'handshake-early-cont').exists()
            (root / 'handshake-allow-stop').write_text('continue')
        if mode in ('parent-stopped', 'parent-terminated'):
            deadline = time.monotonic() + 3
            while not (root / 'command-started').exists() and time.monotonic() < deadline: time.sleep(0.01)
            command_pid, wrapper_pid = map(int, (root / 'command-started').read_text().split())
            wrapper = next(item for item in members(session) if item['pid'] == wrapper_pid)
            supervisor = wrapper['ppid']
            if supervisor == child.pid or not any(item['pid'] == supervisor for item in members(session)):
                raise RuntimeError('supervisor identity unavailable')
            record['command_pid'] = command_pid
            record['supervisor_pid'] = supervisor
            if mode == 'parent-stopped':
                os.kill(supervisor, signal.SIGSTOP)
                try:
                    time.sleep(1.5)
                    record['command_alive_while_parent_stopped'] = any(item['pid'] == command_pid for item in members(session))
                finally: os.kill(supervisor, signal.SIGCONT)
            else: os.kill(supervisor, signal.SIGTERM)
        if mode == 'deadline-timer-descendant':
            deadline = time.monotonic() + 8
            while not (root / 'timer-library-return').exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            if not (root / 'timer-library-return').exists(): raise RuntimeError('library return checkpoint unavailable')
            timer_group = int((root / 'timer-partial-signal').read_text())
            record['timer_survivors_after_return'] = [item for item in members(session) if item['pgid'] == timer_group]
        child.wait(timeout=6 if mode in ('worker-stopped-after-authorization', 'forged-completion-worker-stopped') else 8)
        record['exit'] = child.returncode
        record['sentinel_alive_before_cleanup'] = sentinel.poll() is None
        record['survivors_before_cleanup'] = members(session)
    except Exception as error:
        record['error'] = repr(error)
        record['at_error'] = members(session)
        record['stdout_at_error'] = (root / 'stdout').read_text()
        record['stderr_at_error'] = (root / 'stderr').read_text()
    finally:
        # Finish bounded cleanup if the Node-side watchdog requested shutdown.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        owned = members(session) if session == child.pid else []
        if session != child.pid: child.kill()
        record['cleanup_groups'] = sorted({item['pgid'] for item in owned})
        for group in record['cleanup_groups']:
            try: os.killpg(group, signal.SIGKILL)
            except ProcessLookupError: pass
        child.wait(timeout=3)
        deadline = time.monotonic() + 2
        while members(session) and time.monotonic() < deadline: time.sleep(0.01)
        record['survivors_after_cleanup'] = members(session)
        if sentinel.poll() is None: sentinel.kill()
        sentinel.wait(timeout=3)
        if master is not None: os.close(master)
        if slave is not None: os.close(slave)
record['duration_ms'] = int((time.monotonic() - started) * 1000)
record['stdout'] = (root / 'stdout').read_text()
record['stderr'] = (root / 'stderr').read_text()
record['command_started'] = (root / 'command-started').exists()
record['continued_after_stop'] = (root / 'handshake-cont-after-stop').exists()
record['verified_reader_killed'] = (root / 'reader-killed').exists()
record['command_partial_signal'] = (root / 'command-partial-signal').read_text() if (root / 'command-partial-signal').exists() else None
record['umask_groups'] = [int(value) for value in (root / 'umask-groups').read_text().split()] if (root / 'umask-groups').exists() else []
record['helper_vanished_after_probe'] = (root / 'helper-vanished-after-probe').exists()
record['helper_signal_refused'] = (root / 'helper-signal-refused').exists()
record['timer_partial_signal'] = (root / 'timer-partial-signal').read_text() if (root / 'timer-partial-signal').exists() else None
record['dangerous_kill_attempts'] = (root / 'dangerous-kill-attempts').read_text().splitlines() if (root / 'dangerous-kill-attempts').exists() else []
if (root / 'cleanup-residual-polls').exists():
    polls = (root / 'cleanup-residual-polls').read_text().splitlines()
    record['cleanup_residual_polls_raw'] = polls
    record['cleanup_residual_capture_valid'] = all(value.isdecimal() for value in polls)
    record['cleanup_residual_polls'] = len(polls)
if 'timeout_victim' in record: record['timeout_victim_contents'] = pathlib.Path(record['timeout_victim']).read_text()
print(json.dumps(record))
`;

function runLifecycleProbe(mode: 'fast' | 'near-deadline' | 'printf-override' | 'leader-exits' | 'nested' | 'nonzero' | 'ordinary-exit-0' | 'ordinary-exit-2' | 'ordinary-exit-143' | 'status-255' | 'ownership-command' | 'ownership-watchdog' | 'ownership-caller-group' | 'reader-killed-after-verification' | 'watchdog-reader-killed-after-verification' | 'parent-stopped' | 'parent-terminated' | 'worker-stopped-after-authorization' | 'forged-completion-worker-stopped' | 'dead-leader-before-authorization' | 'dead-leader-clean-cleanup' | 'dead-leader-finishing-cleanup' | 'command-group-descendant' | 'cleanup-child-group' | 'deadline-timer-descendant' | 'deadline-helper-vanished' | 'deadline-helper-signal-refused' | 'deadline-fifo-after-cleanup' | 'authorization-unreadable-after-cleanup' | 'setup-mktemp-term-ignoring' | 'setup-mkfifo-term-ignoring' | 'setup-ps-term-ignoring' | 'setup-timer-sleep-failure' | 'cleanup-residual' | 'handshake-early-cont' | 'control-tokenless' | 'control-duplicate-token' | 'control-low-group' | 'control-caller-group' | 'control-external-group' | 'timeout-symlink' | 'timeout-existing' | 'zero', terminal = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded lifecycle '));
  const shim = path.join(root, 'bin');
  fs.mkdirSync(shim);
  const authorizationRmRelease = path.join(root, 'authorization-rm-release');
  if (mode === 'dead-leader-before-authorization' || mode === 'dead-leader-clean-cleanup' || mode === 'dead-leader-finishing-cleanup' || mode === 'deadline-fifo-after-cleanup' || mode === 'authorization-unreadable-after-cleanup') {
    execFileSync(resolveBinary('mkfifo')!, [authorizationRmRelease]);
  }
  for (const name of ['sleep', 'mktemp', 'mkfifo', 'rm', 'rmdir', 'cat', 'false', 'ps']) {
    const binary = resolveBinary(name);
    if (binary) fs.symlinkSync(binary, path.join(shim, name));
  }
  if (mode === 'cleanup-child-group') {
    fs.writeFileSync(path.join(root, 'umask-capture.sh'), [
      '#!/bin/bash',
      '"$REAL_PS" -o pgid= -p "$$" >> "$TMPDIR/umask-groups"',
      'builtin umask',
      '',
    ].join('\n'), { mode: 0o700 });
  }
  if (mode === 'deadline-timer-descendant' || mode === 'deadline-helper-vanished' || mode === 'deadline-helper-signal-refused') {
    fs.unlinkSync(path.join(shim, 'sleep'));
    fs.writeFileSync(path.join(shim, 'sleep'), [
      '#!/bin/bash',
      'group="$("$REAL_PS" -o pgid= -p "$$")" || exit 2',
      'group="${group//[[:space:]]/}"; [[ "$group" =~ ^[0-9]+$ ]] || exit 2',
      'builtin printf "%s\\n" "$$" > "$TMPDIR/sleep-child.$group"',
      'exec /bin/sleep "$@"',
      '',
    ].join('\n'), { mode: 0o700 });
  }
  if (mode === 'dead-leader-finishing-cleanup') {
    fs.unlinkSync(path.join(shim, 'sleep'));
    fs.writeFileSync(path.join(shim, 'sleep'), [
      '#!/bin/bash',
      'guard=""; [ ! -r "$TMPDIR/expected-guard-pid" ] || IFS= read -r guard < "$TMPDIR/expected-guard-pid"',
      'if [ "$1" = 2 ] && [ "$PPID" = "$guard" ]; then builtin printf ready > "$TMPDIR/outer-authority-finished"; fi',
      'exec /bin/sleep "$@"',
      '',
    ].join('\n'), { mode: 0o700 });
  }
  if (mode.startsWith('ownership-') || mode.endsWith('reader-killed-after-verification')) {
    fs.unlinkSync(path.join(shim, 'ps'));
    fs.writeFileSync(path.join(shim, 'ps'), [
      '#!/bin/bash',
      'count=0; [ ! -f "$PS_COUNTER" ] || read -r count < "$PS_COUNTER"',
      'count=$((count + 1)); printf "%s\\n" "$count" > "$PS_COUNTER"',
      '[ "$count" -ne "$PS_FAIL_AT" ] || exit 1',
      'if [ "$PS_BORROW_GROUP" = 1 ]; then',
      '  if [ "$count" -eq 1 ]; then "$REAL_PS" "$@" > "$PS_CALLER_GROUP" || exit $?; cat "$PS_CALLER_GROUP"; exit; fi',
      '  if [ "$count" -eq 2 ]; then cat "$PS_CALLER_GROUP"; exit; fi',
      'fi',
      '"$REAL_PS" "$@"',
      'rc=$?',
      'if [ "$rc" -eq 0 ] && [ "$count" -eq "$PS_KILL_AT" ]; then',
      '  target=""; for argument in "$@"; do target="$argument"; done',
      '  kill -9 "$target" || exit 1',
      '  printf killed > "$PS_KILL_RECEIPT"',
      'fi',
      'exit "$rc"',
      '',
    ].join('\n'), { mode: 0o700 });
  }
  if (mode.startsWith('timeout-')) {
    fs.unlinkSync(path.join(shim, 'ps'));
    fs.writeFileSync(path.join(shim, 'ps'), [
      '#!/bin/bash',
      'count=0; [ ! -f "$PS_COUNTER" ] || read -r count < "$PS_COUNTER"',
      'count=$((count + 1)); printf "%s\\n" "$count" > "$PS_COUNTER"',
      'if [ "$count" -eq 2 ]; then while [ ! -f "$TIMEOUT_FIXTURE_READY" ]; do /bin/sleep 0.01; done; fi',
      'exec "$REAL_PS" "$@"',
      '',
    ].join('\n'), { mode: 0o700 });
  }
  const stalledSetupBinary = mode === 'setup-mktemp-term-ignoring' || mode === 'setup-timer-sleep-failure'
    ? 'mktemp'
    : mode === 'setup-mkfifo-term-ignoring'
      ? 'mkfifo'
      : mode === 'setup-ps-term-ignoring'
        ? 'ps'
        : undefined;
  if (stalledSetupBinary) {
    fs.unlinkSync(path.join(shim, stalledSetupBinary));
    fs.writeFileSync(path.join(shim, stalledSetupBinary), [
      '#!/bin/bash',
      'printf "%s\\n" "$$" > "$SETUP_PID"',
      'trap "" TERM HUP USR1',
      mode === 'setup-timer-sleep-failure' ? '/bin/sleep 30 &' : 'sleep 30 &',
      'child=$!',
      'printf "%s\\n" "$child" > "$SETUP_CHILD_PID"',
      'wait "$child"',
      '',
    ].join('\n'), { mode: 0o700 });
  }
  if (mode === 'setup-timer-sleep-failure') {
    fs.unlinkSync(path.join(shim, 'sleep'));
    fs.writeFileSync(path.join(shim, 'sleep'), [
      '#!/bin/bash',
      '[ "$1" != 1 ] || exit 1',
      'exec /bin/sleep "$@"',
      '',
    ].join('\n'), { mode: 0o700 });
  }
  if (mode === 'cleanup-residual') {
    fs.unlinkSync(path.join(shim, 'sleep'));
    fs.writeFileSync(path.join(shim, 'sleep'), [
      '#!/bin/bash',
      'if [ "$1" = 0.01 ] && [ -e "$CLEANUP_RESIDUAL_ACTIVE" ]; then exec /bin/sleep 0.05; fi',
      'exec /bin/sleep "$@"',
      '',
    ].join('\n'), { mode: 0o700 });
  }
  fs.writeFileSync(path.join(root, 'lifecycle.py'), LIFECYCLE_DRIVER);
  fs.writeFileSync(path.join(root, 'probe.sh'), [
    'IFS= read -r go',
    'cleanup_mode="$4"',
    'case "$4" in control-*|cleanup-residual)',
    '  kill() {',
    '    groups=""; [ ! -r "$KILL_INTERCEPT_GROUPS" ] || IFS= read -r groups < "$KILL_INTERCEPT_GROUPS"',
    '    if [ "$cleanup_mode" = cleanup-residual ] && [ "$1" = -0 ] && [ "$2" = -- ]; then',
    '      [ -n "$cleanup_group" ] || cleanup_group="$3"',
    '      if [ "$3" = "$cleanup_group" ]; then cleanup_group_checks=$((cleanup_group_checks + 1)); builtin printf active > "$CLEANUP_RESIDUAL_ACTIVE"; builtin printf "%s\\n" "$cleanup_group_checks" >> "$CLEANUP_RESIDUAL_POLLS"; [ "$cleanup_group_checks" -le 200 ] && return 0; fi',
    '    fi',
    '    for argument in "$@"; do',
    '      case "$argument" in -[0-9]*) case ",$groups," in *,"${argument#-}",*) builtin printf "%s\\n" "$argument" >> "$KILL_INTERCEPT_LOG"; return 0;; esac;; esac',
    '    done',
    '    builtin kill "$@"',
    '  }',
    '  ;; esac',
    'case "$4" in dead-leader-before-authorization|dead-leader-clean-cleanup|dead-leader-finishing-cleanup|deadline-fifo-after-cleanup|authorization-unreadable-after-cleanup)',
    '  rm() {',
    '    local argument marker_rc',
    '    for argument in "$@"; do',
    '      case "$argument" in',
    '        "$TMPDIR"/whatsoup-bounded-timeout.*)',
    '          set -C; : > "$AUTHORIZATION_RM_USED" 2>/dev/null; marker_rc=$?; set +C',
    '          if [ "$marker_rc" -eq 0 ] && [ "$cleanup_mode" = deadline-fifo-after-cleanup ]; then',
    '            "$REAL_RM" "$@"',
    '            builtin printf ready > "$AUTHORIZATION_RM_READY"',
    '            IFS= read -r _ < "$AUTHORIZATION_RM_RELEASE"',
    '            return 0',
    '          elif [ "$marker_rc" -eq 0 ]; then',
    '            builtin printf ready > "$AUTHORIZATION_RM_READY"',
    '            IFS= read -r _ < "$AUTHORIZATION_RM_RELEASE"',
    '          fi',
    '          ;;',
    '      esac',
    '    done',
    '    "$REAL_RM" "$@"',
    '  }',
    '  ;; esac',
    'case "$4" in handshake-early-cont)',
    '  kill() {',
    '    if [ "$1" = -STOP ] && [ "$2" = 0 ]; then',
    '      builtin printf entered > "$HANDSHAKE_STOP_ENTERED"',
    '      while [ ! -f "$HANDSHAKE_EARLY_CONT" ] && [ ! -f "$HANDSHAKE_ALLOW_STOP" ]; do /bin/sleep 0.01; done',
    '      builtin printf stopped > "$HANDSHAKE_STOPPED"',
    '    elif [ "$1" = -CONT ]; then',
    '      if [ -f "$HANDSHAKE_STOPPED" ]; then builtin printf continued > "$HANDSHAKE_CONT_AFTER_STOP"; else builtin printf early > "$HANDSHAKE_EARLY_CONT"; fi',
    '    fi',
    '    builtin kill "$@"',
    '  }',
    '  ;; esac',
    'case "$4" in deadline-fifo-after-cleanup)',
    '  function [ {',
    '    target=""; builtin [ "$1" = -f ] && target="$2"; builtin [ "$1" = ! ] && builtin [ "$2" = -f ] && target="$3"',
    '    builtin [ "$@"; bracket_rc=$?',
    '    case "$target" in "$TMPDIR"/whatsoup-bounded-deadline.*)',
    '      if builtin [ ! -e "$DEADLINE_RACE_SUBSTITUTED" ] && builtin [ -f "$target" ]; then',
    '        "$REAL_RM" -f "$target"; mkfifo "$target"; builtin printf substituted > "$DEADLINE_RACE_SUBSTITUTED"',
    '      fi',
    '      ;; esac',
    '    return "$bracket_rc"',
    '  }',
    '  ;; esac',
    'case "$4" in command-group-descendant)',
    '  kill() {',
    '    if [ "$1" = -9 ] && [ -n "$cmd_group" ] && [ "$3" = "-$cmd_group" ] && [ ! -f "$TMPDIR/command-partial-signal" ]; then',
    '      builtin printf "%s\\n" "$cmd_group" > "$TMPDIR/command-partial-signal"',
    '      builtin kill -9 "$cmd_pid" 2>/dev/null; return 0',
    '    fi',
    '    builtin kill "$@"',
    '  }',
    '  ;; esac',
    'case "$4" in cleanup-child-group)',
    '  umask() { if [ "$#" -eq 0 ]; then /bin/bash "$TMPDIR/umask-capture.sh"; else builtin umask "$@"; fi; }',
    '  ;; esac',
    'case "$4" in deadline-timer-descendant|deadline-helper-vanished|deadline-helper-signal-refused)',
    '  case "$4" in deadline-helper-*)',
    '    sleep() {',
    '      if [ "${FUNCNAME[1]}" = _bounded_wait_for_budget ]; then',
    '        local polls=0',
    '        while [ ! -f "$TMPDIR/timer-partial-signal" ]; do polls=$((polls + 1)); [ "$polls" -lt 300 ] || return 2; /bin/sleep 0.01; done',
    '      fi',
    '      command sleep "$@"',
    '    }',
    '    ;; esac',
    '  kill() {',
    '    if [ "$1" = -9 ] && [ -n "$status_timer_pid" ] && [ "$3" = "-$status_timer_pid" ] && [ ! -f "$TMPDIR/timer-partial-signal" ]; then',
    '      count=0; while [ ! -s "$TMPDIR/sleep-child.$status_timer_pid" ] && [ "$count" -lt 100 ]; do /bin/sleep 0.01; count=$((count + 1)); done',
    '      [ -s "$TMPDIR/sleep-child.$status_timer_pid" ] || return 2',
    '      builtin printf "%s\\n" "$status_timer_pid" > "$TMPDIR/timer-partial-signal"',
    // Model the observed fork race: the first signal catches the leader while its child survives.
    '      builtin kill -9 "$status_timer_pid"; return "$?"',
    '    fi',
    '    if [ "$cleanup_mode" = deadline-helper-vanished ] && [ "$1" = -0 ] && [ "$2" = -- ] && [ "$3" = "-$status_timer_pid" ] && [ -f "$TMPDIR/timer-partial-signal" ] && [ ! -f "$TMPDIR/helper-vanished-after-probe" ]; then',
    '      builtin kill "$@" || return "$?"',
    '      builtin kill -9 -- "-$status_timer_pid" || return 2',
    '      count=0; while builtin kill -0 -- "-$status_timer_pid" 2>/dev/null; do count=$((count + 1)); [ "$count" -lt 200 ] || return 2; /bin/sleep 0.01; done',
    '      builtin printf vanished > "$TMPDIR/helper-vanished-after-probe"',
    '      return 0',
    '    fi',
    '    if [ "$cleanup_mode" = deadline-helper-signal-refused ] && [ "$1" = -9 ] && [ "$3" = "-$status_timer_pid" ] && [ -f "$TMPDIR/timer-partial-signal" ]; then',
    '      builtin kill -0 -- "-$status_timer_pid" || return "$?"',
    '      builtin printf refused > "$TMPDIR/helper-signal-refused"',
    '      return 1',
    '    fi',
    '    builtin kill "$@"',
    '  }',
    '  ;; esac',
    '. "$1"',
    'before_options="$-"',
    '[ "$4" != printf-override ] || printf() { return 91; }',
    'budget=6; case "$4" in nested|near-deadline|ordinary-exit-*|watchdog-reader-killed-after-verification|parent-stopped|worker-stopped-after-authorization|forged-completion-worker-stopped|dead-leader-before-authorization|dead-leader-clean-cleanup|dead-leader-finishing-cleanup|deadline-fifo-after-cleanup|authorization-unreadable-after-cleanup|setup-*-term-ignoring|setup-timer-sleep-failure|cleanup-residual|handshake-early-cont|timeout-*) budget=1;; deadline-timer-descendant|deadline-helper-*|cleanup-child-group) budget=1;; control-*) budget=2;; zero) budget=0;; esac',
    'if [ "$4" = deadline-timer-descendant ]; then',
    '  if out="$(builtin printf "payload\\n" | { whatsoup_run_bounded "$budget" "$2" "$3" "$4"; bounded_rc=$?; builtin printf returned > "$TMPDIR/timer-library-return"; exit "$bounded_rc"; })"; then rc=0; else rc=$?; fi',
    'else',
    'if out="$(builtin printf "payload\\n" | whatsoup_run_bounded "$budget" "$2" "$3" "$4")"; then rc=0; else rc=$?; fi',
    'fi',
    'builtin printf "rc=%s output=%s options=%s/%s\\n" "$rc" "$out" "$before_options" "$-"',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'child.sh'), [
    'printf "%s %s" "$$" "$PPID" > "$COMMAND_STARTED"',
    'if [ "$1" = leader-exits ]; then sleep 30 & kill -9 "$PPID"; wait; exit; fi',
    'if [ "$1" = command-group-descendant ]; then sleep 30 & exit 0; fi',
    'case "$1" in cleanup-child-group|deadline-timer-descendant|deadline-helper-*|control-*|timeout-*|cleanup-residual|worker-stopped-after-authorization|forged-completion-worker-stopped|dead-leader-before-authorization|dead-leader-clean-cleanup|dead-leader-finishing-cleanup|deadline-fifo-after-cleanup|authorization-unreadable-after-cleanup) value="$(sleep 30)"; printf "%s" "$value"; exit;; esac',
    'if [ "$1" != nested ] && [ "$1" != zero ] && [ "$1" != watchdog-reader-killed-after-verification ] && [ "$1" != parent-stopped ] && [ "$1" != parent-terminated ]; then',
    '  IFS= read -r payload',
    '  if [ "$1" = near-deadline ]; then sleep 0.75; else sleep 0.05; fi',
    '  printf "%s" "$payload"',
    '  [ "$1" != nonzero ] || exit 7',
    '  [ "$1" != ordinary-exit-2 ] || exit 2',
    '  [ "$1" != ordinary-exit-143 ] || exit 143',
    '  [ "$1" != status-255 ] || exit 255',
    'else',
    '  value="$(sleep 30)"',
    '  printf "%s" "$value"',
    'fi',
    '',
  ].join('\n'));
  try {
    const result = spawnSync(resolveBinary('python3')!, [
      path.join(root, 'lifecycle.py'), root, path.resolve(BOUNDED_LIB), resolveBinary('bash')!, mode, terminal ? 'pty' : 'pipe',
    ], { encoding: 'utf8', timeout: 15_000, env: {
      ...process.env, PATH: shim, TMPDIR: root,
      COMMAND_STARTED: path.join(root, 'command-started'),
      REAL_PS: resolveBinary('ps')!, PS_COUNTER: path.join(root, 'ps-counter'),
      PS_FAIL_AT: mode === 'ownership-command' ? '2' : mode === 'ownership-watchdog' ? '3' : '0',
      PS_KILL_AT: mode === 'reader-killed-after-verification' ? '2' : mode === 'watchdog-reader-killed-after-verification' ? '3' : '0',
      PS_BORROW_GROUP: mode === 'ownership-caller-group' ? '1' : '0',
      PS_CALLER_GROUP: path.join(root, 'caller-group'),
      PS_KILL_RECEIPT: path.join(root, 'reader-killed'),
      TIMEOUT_FIXTURE_READY: path.join(root, 'timeout-fixture-ready'),
      SETUP_PID: path.join(root, 'setup-pid'),
      SETUP_CHILD_PID: path.join(root, 'setup-child-pid'),
      KILL_INTERCEPT_GROUPS: path.join(root, 'dangerous-groups'),
      KILL_INTERCEPT_LOG: path.join(root, 'dangerous-kill-attempts'),
      REAL_RM: resolveBinary('rm')!,
      AUTHORIZATION_RM_READY: path.join(root, 'authorization-rm-ready'),
      AUTHORIZATION_RM_USED: path.join(root, 'authorization-rm-used'),
      AUTHORIZATION_RM_RELEASE: authorizationRmRelease,
      DEADLINE_RACE_SUBSTITUTED: path.join(root, 'deadline-race-substituted'),
      HANDSHAKE_STOP_ENTERED: path.join(root, 'handshake-stop-entered'),
      HANDSHAKE_STOPPED: path.join(root, 'handshake-stopped'),
      HANDSHAKE_EARLY_CONT: path.join(root, 'handshake-early-cont'),
      HANDSHAKE_ALLOW_STOP: path.join(root, 'handshake-allow-stop'),
      HANDSHAKE_CONT_AFTER_STOP: path.join(root, 'handshake-cont-after-stop'),
      CLEANUP_RESIDUAL_ACTIVE: path.join(root, 'cleanup-residual-active'),
      CLEANUP_RESIDUAL_POLLS: path.join(root, 'cleanup-residual-polls'),
    } });
    if (result.error) throw new Error(`${result.error.message}\n${result.stdout}\n${result.stderr}`);
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('whatsoup_run_bounded process-group lifecycle', () => {
  it.each(['fast', 'nested', 'nonzero', 'zero'] as const)('reaps every owned descendant before returning from %s', (mode) => {
    const result = runLifecycleProbe(mode);
    expect(result.exit, JSON.stringify(result)).toBe(0);
    const expected = mode === 'fast' ? 'rc=0 output=payload' : mode === 'nonzero' ? 'rc=7 output=payload' : 'rc=124 output=';
    expect(result.stdout).toContain(expected);
    expect(result.sentinel_alive_before_cleanup, JSON.stringify(result)).toBe(true);
    expect(result.survivors_after_cleanup, JSON.stringify(result)).toEqual([]);
    expect(result.survivors_before_cleanup, JSON.stringify(result)).toEqual([]);
    if (mode === 'nested') expect(result.duration_ms, JSON.stringify(result)).toBeGreaterThanOrEqual(900);
    if (mode === 'zero') expect(result.command_started, JSON.stringify(result)).toBe(false);
  });
  it.each(['ownership-command', 'ownership-watchdog', 'ownership-caller-group'] as const)('refuses %s failure before releasing the command', (mode) => {
    const result = runLifecycleProbe(mode);
    expect(result.stdout).toContain('rc=2 output=');
    expect(result.command_started).toBe(false);
    expect(result.sentinel_alive_before_cleanup, JSON.stringify(result)).toBe(true);
    expect(result.survivors_before_cleanup, JSON.stringify(result)).toEqual([]);
    expect(result.survivors_after_cleanup, JSON.stringify(result)).toEqual([]);
  });
  it('returns after a verified command launch-gate reader dies before release', () => {
    const result = runLifecycleProbe('reader-killed-after-verification');
    expect(result.verified_reader_killed, JSON.stringify(result)).toBe(true);
    expect(result.duration_ms, JSON.stringify(result)).toBeLessThan(4_000);
    expect(result.exit, JSON.stringify(result)).toBe(0);
    expect(result.stdout).toContain('rc=137 output=');
    expect(result.command_started).toBe(false);
    expect(result.sentinel_alive_before_cleanup, JSON.stringify(result)).toBe(true);
    expect(result.survivors_before_cleanup, JSON.stringify(result)).toEqual([]);
    expect(result.survivors_after_cleanup, JSON.stringify(result)).toEqual([]);
  });
  it('keeps the command deadline when an optional watchdog launch reader is lost', () => {
    const result = runLifecycleProbe('watchdog-reader-killed-after-verification');
    expect(result.verified_reader_killed, JSON.stringify(result)).toBe(true);
    expect(result.duration_ms, JSON.stringify(result)).toBeLessThan(4_000);
    expect(result.exit, JSON.stringify(result)).toBe(0);
    expect(result.stdout).toContain('rc=124 output=');
    expect(result.command_started).toBe(true);
    expect(result.sentinel_alive_before_cleanup, JSON.stringify(result)).toBe(true);
    expect(result.survivors_before_cleanup, JSON.stringify(result)).toEqual([]);
    expect(result.survivors_after_cleanup, JSON.stringify(result)).toEqual([]);
  });
  it('enforces the command deadline while the supervising parent is stopped', () => {
    const result = runLifecycleProbe('parent-stopped');
    expect(result.exit, JSON.stringify(result)).toBe(0);
    expect(result.command_alive_while_parent_stopped, JSON.stringify(result)).toBe(false);
    expect(result.stdout).toContain('rc=124 output=');
    expect(result.sentinel_alive_before_cleanup, JSON.stringify(result)).toBe(true);
    expect(result.survivors_before_cleanup, JSON.stringify(result)).toEqual([]);
    expect(result.survivors_after_cleanup, JSON.stringify(result)).toEqual([]);
  });
  it('reaps command descendants when the supervising parent receives TERM', () => {
    const result = runLifecycleProbe('parent-terminated');
    expect(result.exit, JSON.stringify(result)).toBe(0);
    expect(result.stdout).toContain('rc=143 output=');
    expect(result.sentinel_alive_before_cleanup, JSON.stringify(result)).toBe(true);
    expect(result.survivors_before_cleanup, JSON.stringify(result)).toEqual([]);
    expect(result.survivors_after_cleanup, JSON.stringify(result)).toEqual([]);
  });
  it.each(['setup-mktemp-term-ignoring', 'setup-mkfifo-term-ignoring', 'setup-ps-term-ignoring'] as const)('bounds a TERM-ignoring setup child from helper entry: %s', (mode) => {
    const result = runLifecycleProbe(mode);
    expect(result.exit, JSON.stringify(result)).toBe(0);
    expect(result.duration_ms, JSON.stringify(result)).toBeLessThan(4_000);
    expect(result.stdout, JSON.stringify(result)).toContain('rc=2 output=');
    expect(result.command_started, JSON.stringify(result)).toBe(false);
    expect(result.sentinel_alive_before_cleanup, JSON.stringify(result)).toBe(true);
    expect(result.survivors_before_cleanup, JSON.stringify(result)).toEqual([]);
    expect(result.survivors_after_cleanup, JSON.stringify(result)).toEqual([]);
  });
  it('fails closed and reaps setup when the outer timer sleep fails', () => {
    const result = runLifecycleProbe('setup-timer-sleep-failure');
    expect(result.exit, JSON.stringify(result)).toBe(0);
    expect(result.duration_ms, JSON.stringify(result)).toBeLessThan(4_000);
    expect(result.stdout, JSON.stringify(result)).toContain('rc=2 output=');
    expect(result.command_started, JSON.stringify(result)).toBe(false);
    expect(result.sentinel_alive_before_cleanup, JSON.stringify(result)).toBe(true);
    expect(result.survivors_before_cleanup, JSON.stringify(result)).toEqual([]);
    expect(result.survivors_after_cleanup, JSON.stringify(result)).toEqual([]);
  });
  it('reports a worker cleanup residual instead of a deadline', () => {
    const result = runLifecycleProbe('cleanup-residual');
    expect(result.exit, JSON.stringify(result)).toBe(0);
    expect(result.duration_ms, JSON.stringify(result)).toBeLessThan(7_500);
    expect(result.stdout, JSON.stringify(result)).toContain('rc=2 output=');
    expect(result.command_started, JSON.stringify(result)).toBe(true);
    expect(result.cleanup_residual_polls, JSON.stringify(result)).toBeGreaterThan(0);
    expect(result.cleanup_residual_capture_valid, JSON.stringify(result)).toBe(true);
    expect(result.sentinel_alive_before_cleanup, JSON.stringify(result)).toBe(true);
    expect(result.survivors_before_cleanup, JSON.stringify(result)).toEqual([]);
    expect(result.survivors_after_cleanup, JSON.stringify(result)).toEqual([]);
  });
  it('refuses interrupted cleanup after the command leader is reaped before outer authorization', () => {
    const result = runLifecycleProbe('dead-leader-before-authorization');
    expect(result.exit, JSON.stringify(result)).toBe(0);
    expect(result.stopped_guard, JSON.stringify(result)).toBeTruthy();
    expect(result.continued_guard, JSON.stringify(result)).toBe(result.stopped_guard);
    expect(result.command_pid_reaped_before_authorization, JSON.stringify(result)).toBe(true);
    expect(result.stdout, JSON.stringify(result)).toContain('rc=2 output=');
    expect(result.sentinel_alive_before_cleanup, JSON.stringify(result)).toBe(true);
    expect(result.survivors_before_cleanup, JSON.stringify(result)).toEqual([]);
    expect(result.survivors_after_cleanup, JSON.stringify(result)).toEqual([]);
  });
  it('keeps the deadline result when clean worker completion precedes outer authorization', () => {
    const result = runLifecycleProbe('dead-leader-clean-cleanup');
    expect(result.exit, JSON.stringify(result)).toBe(0);
    expect(result.command_pid_reaped_before_authorization, JSON.stringify(result)).toBe(true);
    expect(result.worker_cleanup_completed_before_authorization, JSON.stringify(result)).toBe(true);
    expect(result.guard_left_stopped_for_deadline_reader, JSON.stringify(result)).toBe(result.stopped_guard);
    expect(result.stdout, JSON.stringify(result)).toContain('rc=124 output=');
    expect(result.sentinel_alive_before_cleanup, JSON.stringify(result)).toBe(true);
    expect(result.survivors_before_cleanup, JSON.stringify(result)).toEqual([]);
    expect(result.survivors_after_cleanup, JSON.stringify(result)).toEqual([]);
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
    expect(result.sentinel_alive_before_cleanup, JSON.stringify(result)).toBe(true);
    expect(result.survivors_before_cleanup, JSON.stringify(result)).toEqual([]);
    expect(result.survivors_after_cleanup, JSON.stringify(result)).toEqual([]);
  });
  it('bounds an authorized worker that is stopped before timeout cleanup', () => {
    const result = runLifecycleProbe('worker-stopped-after-authorization');
    expect(result.exit, JSON.stringify(result)).toBe(0);
    expect(result.duration_ms, JSON.stringify(result)).toBeLessThan(6_000);
    expect(result.stopped_worker, JSON.stringify(result)).toBeTruthy();
    expect(result.stdout, JSON.stringify(result)).toContain('rc=2 output=');
    expect(result.sentinel_alive_before_cleanup, JSON.stringify(result)).toBe(true);
    expect(result.survivors_before_cleanup, JSON.stringify(result)).toEqual([]);
    expect(result.survivors_after_cleanup, JSON.stringify(result)).toEqual([]);
  });
  it('does not trust a forged completion marker for a stopped worker', () => {
    const result = runLifecycleProbe('forged-completion-worker-stopped');
    expect(result.exit, JSON.stringify(result)).toBe(0);
    expect(result.duration_ms, JSON.stringify(result)).toBeLessThan(6_000);
    expect(result.forged_completion, JSON.stringify(result)).toBeTruthy();
    expect(result.stdout, JSON.stringify(result)).toContain('rc=2 output=');
    expect(result.sentinel_alive_before_cleanup, JSON.stringify(result)).toBe(true);
    expect(result.survivors_before_cleanup, JSON.stringify(result)).toEqual([]);
    expect(result.survivors_after_cleanup, JSON.stringify(result)).toEqual([]);
  });
  it('does not lose a release sent before the worker stops', () => {
    const result = runLifecycleProbe('handshake-early-cont');
    expect(result.exit, JSON.stringify(result)).toBe(0);
    expect(result.early_cont_before_stop, JSON.stringify(result)).toBe(false);
    expect(result.continued_after_stop, JSON.stringify(result)).toBe(true);
    expect(result.command_started, JSON.stringify(result)).toBe(true);
    expect(result.stdout, JSON.stringify(result)).toContain('rc=0 output=payload');
    expect(result.duration_ms, JSON.stringify(result)).toBeLessThan(4_000);
    expect(result.sentinel_alive_before_cleanup, JSON.stringify(result)).toBe(true);
    expect(result.survivors_before_cleanup, JSON.stringify(result)).toEqual([]);
    expect(result.survivors_after_cleanup, JSON.stringify(result)).toEqual([]);
  });
  it.each(['control-tokenless', 'control-duplicate-token', 'control-low-group', 'control-caller-group', 'control-external-group'] as const)('fails closed without signalling an injected group: %s', (mode) => {
    const result = runLifecycleProbe(mode);
    expect(result.control_corrupted, JSON.stringify(result)).toBe(mode);
    expect(result.exit, JSON.stringify(result)).toBe(0);
    expect(result.duration_ms, JSON.stringify(result)).toBeLessThan(6_000);
    expect(result.stdout, JSON.stringify(result)).toContain('rc=2 output=');
    expect(result.dangerous_kill_attempts, JSON.stringify(result)).toEqual([]);
    expect(result.sentinel_alive_before_cleanup, JSON.stringify(result)).toBe(true);
    expect(result.survivors_before_cleanup, JSON.stringify(result)).toEqual([]);
    expect(result.survivors_after_cleanup, JSON.stringify(result)).toEqual([]);
  });
  it.each(['timeout-symlink', 'timeout-existing'] as const)('does not follow or trust a pre-existing timeout marker: %s', (mode) => {
    const result = runLifecycleProbe(mode);
    expect(result.exit, JSON.stringify(result)).toBe(0);
    expect(result.stdout, JSON.stringify(result)).toContain('rc=2 output=');
    expect(result.timeout_victim_contents, JSON.stringify(result)).toBe('unchanged');
    expect(result.sentinel_alive_before_cleanup, JSON.stringify(result)).toBe(true);
    expect(result.survivors_before_cleanup, JSON.stringify(result)).toEqual([]);
    expect(result.survivors_after_cleanup, JSON.stringify(result)).toEqual([]);
  });
  it.each(['leader-exits', 'status-255', 'printf-override', 'near-deadline', 'near-deadline', 'near-deadline'] as const)('preserves status and cleans owned groups for %s', (mode) => {
    const result = runLifecycleProbe(mode);
    const expected = mode === 'leader-exits' ? 'rc=137 output=' : mode === 'status-255' ? 'rc=255 output=payload' : 'rc=0 output=payload';
    expect(result.exit, JSON.stringify(result)).toBe(0);
    expect(result.stdout, JSON.stringify(result)).toContain(expected);
    expect(result.sentinel_alive_before_cleanup, JSON.stringify(result)).toBe(true);
    expect(result.survivors_before_cleanup, JSON.stringify(result)).toEqual([]);
    expect(result.survivors_after_cleanup, JSON.stringify(result)).toEqual([]);
  });
  it('reaps a command child that survives the first group signal', () => {
    const result = runLifecycleProbe('command-group-descendant');
    expect(result.command_partial_signal, JSON.stringify(result)).toBeTruthy();
    expect(result.exit, JSON.stringify(result)).toBe(0);
    expect(result.stdout, JSON.stringify(result)).toContain('rc=0 output=');
    expect(result.sentinel_alive_before_cleanup, JSON.stringify(result)).toBe(true);
    expect(result.survivors_before_cleanup, JSON.stringify(result)).toEqual([]);
    expect(result.survivors_after_cleanup, JSON.stringify(result)).toEqual([]);
  });
  it('keeps command-substitution helpers in the owned worker group', () => {
    const result = runLifecycleProbe('cleanup-child-group');
    expect(result.exit, JSON.stringify(result)).toBe(0);
    expect(result.umask_groups.length, JSON.stringify(result)).toBeGreaterThan(0);
    expect(result.umask_groups, JSON.stringify(result)).toEqual(
      result.umask_groups.map(() => result.expected_helper_group),
    );
    expect(result.stdout, JSON.stringify(result)).toContain('rc=124 output=');
    expect(result.sentinel_alive_before_cleanup, JSON.stringify(result)).toBe(true);
    expect(result.survivors_before_cleanup, JSON.stringify(result)).toEqual([]);
    expect(result.survivors_after_cleanup, JSON.stringify(result)).toEqual([]);
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
    expect(result.sentinel_alive_before_cleanup, JSON.stringify(result)).toBe(true);
    expect(result.survivors_before_cleanup, JSON.stringify(result)).toEqual([]);
    expect(result.survivors_after_cleanup, JSON.stringify(result)).toEqual([]);
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
