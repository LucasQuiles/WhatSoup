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
    result = subprocess.run(['/bin/ps' if os.path.exists('/bin/ps') else '/usr/bin/ps', '-axo', 'pid=,ppid=,pgid=,stat=,wchan=,lstart=,comm='], capture_output=True, text=True, timeout=3)
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
        if master is not None:
            record['terminal_foreground_group'] = os.tcgetpgrp(master)
            os.write(master, b'go\n')
            # Darwin's terminal close can wait for undrained echo after the
            # command has already exited. The fixture owns the master reader.
            if select.select([master], [], [], 2)[0]: record['terminal_echo'] = os.read(master, 4096).decode()
        else: child.stdin.write('go\n'); child.stdin.close()
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
        child.wait(timeout=8)
        record['exit'] = child.returncode
        record['survivors_before_cleanup'] = members(session)
        record['sentinel_alive_before_cleanup'] = sentinel.poll() is None
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
record['verified_reader_killed'] = (root / 'reader-killed').exists()
print(json.dumps(record))
`;

function runLifecycleProbe(mode: 'fast' | 'near-deadline' | 'printf-override' | 'leader-exits' | 'nested' | 'nonzero' | 'status-255' | 'ownership-command' | 'ownership-watchdog' | 'ownership-caller-group' | 'reader-killed-after-verification' | 'watchdog-reader-killed-after-verification' | 'parent-stopped' | 'parent-terminated' | 'zero', terminal = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded lifecycle '));
  const shim = path.join(root, 'bin');
  fs.mkdirSync(shim);
  for (const name of ['sleep', 'mktemp', 'mkfifo', 'rm', 'rmdir', 'cat', 'false', 'ps']) {
    const binary = resolveBinary(name);
    if (binary) fs.symlinkSync(binary, path.join(shim, name));
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
  fs.writeFileSync(path.join(root, 'lifecycle.py'), LIFECYCLE_DRIVER);
  fs.writeFileSync(path.join(root, 'probe.sh'), [
    'IFS= read -r go',
    '. "$1"',
    'before_options="$-"',
    '[ "$4" != printf-override ] || printf() { return 91; }',
    'budget=6; case "$4" in nested|near-deadline|watchdog-reader-killed-after-verification|parent-stopped) budget=1;; zero) budget=0;; esac',
    'if out="$(builtin printf "payload\\n" | whatsoup_run_bounded "$budget" "$2" "$3" "$4")"; then rc=0; else rc=$?; fi',
    'builtin printf "rc=%s output=%s options=%s/%s\\n" "$rc" "$out" "$before_options" "$-"',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'child.sh'), [
    'printf "%s %s" "$$" "$PPID" > "$COMMAND_STARTED"',
    'if [ "$1" = leader-exits ]; then sleep 30 & kill -9 "$PPID"; wait; exit; fi',
    'if [ "$1" != nested ] && [ "$1" != zero ] && [ "$1" != watchdog-reader-killed-after-verification ] && [ "$1" != parent-stopped ] && [ "$1" != parent-terminated ]; then',
    '  IFS= read -r payload',
    '  if [ "$1" = near-deadline ]; then sleep 0.75; else sleep 0.05; fi',
    '  printf "%s" "$payload"',
    '  [ "$1" != nonzero ] || exit 7',
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
  it.each(['leader-exits', 'status-255', 'printf-override', 'near-deadline', 'near-deadline', 'near-deadline'] as const)('preserves status and cleans owned groups for %s', (mode) => {
    const result = runLifecycleProbe(mode);
    const expected = mode === 'leader-exits' ? 'rc=137 output=' : mode === 'status-255' ? 'rc=255 output=payload' : 'rc=0 output=payload';
    expect(result.exit, JSON.stringify(result)).toBe(0);
    expect(result.stdout, JSON.stringify(result)).toContain(expected);
    expect(result.sentinel_alive_before_cleanup, JSON.stringify(result)).toBe(true);
    expect(result.survivors_before_cleanup, JSON.stringify(result)).toEqual([]);
    expect(result.survivors_after_cleanup, JSON.stringify(result)).toEqual([]);
  });
  it('preserves job-control isolation under a controlling PTY', () => {
    const result = runLifecycleProbe('nested', true);
    expect(result.exit, JSON.stringify(result)).toBe(0);
    expect(result.terminal_foreground_group, JSON.stringify(result)).toBe(result.root_pid);
    expect(result.terminal_echo, JSON.stringify(result)).toContain('go');
    expect(result.stdout).toContain('rc=124 output=');
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
