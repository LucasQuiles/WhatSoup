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

/** Shell files that may invoke a credential store and must therefore be bounded. */
function deployShellFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z', 'deploy/'], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
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

describe('credential-store probes are bounded on every platform', () => {
  it('no deploy shell script invokes security/secret-tool unbounded', () => {
    const findings = deployShellFiles()
      .filter((f) => f !== BOUNDED_LIB)
      .flatMap(unboundedProbes);
    expect(findings, `unbounded credential probes:\n${findings.join('\n')}`).toEqual([]);
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
  ['with timeout(1) present', false],
  ['with timeout(1) absent (stock macOS shape)', true],
])('whatsoup_run_bounded %s', (_label, withoutTimeout) => {
  const opts = { withoutTimeout };

  it('confirms which branch is under test', () => {
    const res = runSnippet(
      'command -v timeout >/dev/null 2>&1 && echo present || echo absent',
      opts,
    );
    expect(res.stdout.trim()).toBe(withoutTimeout ? 'absent' : 'present');
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
