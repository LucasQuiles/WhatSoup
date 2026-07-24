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
    // A match sitting inside a double-quoted string is help text, not a call.
    // Continuation lines of a multi-line message read as an odd quote count.
    const quotesBefore = (code.slice(0, match.index).match(/"/g) ?? []).length;
    if (quotesBefore % 2 === 1 || code.trimStart().startsWith('"')) return;
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

/**
 * Runs a snippet against the real library. When `withoutTimeout` is set, PATH is
 * reduced to a shim directory holding only the utilities the fallback needs — so
 * `timeout`/`gtimeout` are genuinely absent and the Darwin-shaped branch is the
 * only reachable one. This is what makes the macOS path verifiable on Linux CI.
 */
function runSnippet(snippet: string, opts: { withoutTimeout?: boolean } = {}) {
  const repoRoot = process.cwd();
  let env = { ...process.env };
  let shimDir: string | undefined;

  if (opts.withoutTimeout) {
    shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-shim-'));
    for (const bin of ['sleep', 'mktemp', 'rm', 'cat', 'false']) {
      const resolved = resolveBinary(bin);
      if (resolved) fs.symlinkSync(resolved, path.join(shimDir, bin));
    }
    env = { ...env, PATH: shimDir };
  }

  try {
    // Absolute bash path: the shim PATH deliberately omits everything except the
    // few utilities the fallback branch needs, so `bash` itself is not on it.
    const bash = resolveBinary('bash') ?? 'bash';
    return spawnSync(bash, ['-c', `. "${repoRoot}/${BOUNDED_LIB}"\n${snippet}`], {
      encoding: 'utf8',
      env,
      cwd: repoRoot,
    });
  } finally {
    if (shimDir) fs.rmSync(shimDir, { recursive: true, force: true });
  }
}

describe.each([
  ['as installed on this host', false],
  ['with timeout(1) absent (stock macOS shape)', true],
])('whatsoup_run_bounded %s', (_label, withoutTimeout) => {
  const opts = { withoutTimeout };

  it('confirms which branch is under test', () => {
    const res = runSnippet(
      'command -v timeout >/dev/null 2>&1 && echo present || echo absent',
      opts,
    );
    const branch = res.stdout.trim();
    if (withoutTimeout) {
      // PATH was stripped, so the pure-shell watchdog is the only reachable path.
      expect(branch).toBe('absent');
    } else if (process.platform === 'linux') {
      // Linux ships timeout(1); if that ever stops being true the delegation
      // branch would silently stop being covered anywhere.
      expect(branch).toBe('present');
    } else {
      // macOS may legitimately have neither timeout nor gtimeout — that is the
      // condition this whole change exists for. Either branch is acceptable
      // here; the behavioural assertions below must hold regardless.
      expect(['present', 'absent']).toContain(branch);
    }
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
});
