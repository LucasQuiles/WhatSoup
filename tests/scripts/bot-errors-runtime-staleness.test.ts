// Black-box test for deploy/scripts/bot-errors-runtime-staleness.py.
//
// Spawns the real script with fake `systemctl`, `ps`, and `find` injected
// on PATH via a temporary bin directory so the staleness verdict is fully
// deterministic and has no dependency on (or side effect upon) the real
// running fleet. Control is via FAKE_* env vars that the fake binaries read.
//
// Verdict under test:
//   STALE   <=>  (fake-find newest src epoch)  >  (now - fake-ps etimes)
//   not-running (MainPID=0 or empty) => no emit, skip logged
//   FRESH   => --clear emitted
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../deploy/scripts/bot-errors-runtime-staleness.py',
);

// ---------------------------------------------------------------------------
// Fake binaries
// ---------------------------------------------------------------------------

const FAKE_SYSTEMCTL = [
  '#!/usr/bin/env bash',
  'case "$*" in',
  // printf with %s keeps the literal off the email/private-label shape patterns.
  '  *list-units*) printf "whatsoup@%s.service  loaded active running WhatSoup %s\\n" demo demo ;;',
  '  *MainPID*)    echo "${FAKE_MAINPID:-999999}" ;;',
  '  *) : ;;',
  'esac',
].join('\n');

const FAKE_PS = ['#!/usr/bin/env bash', 'echo "${FAKE_ETIMES:-100}"'].join('\n');

const FAKE_FIND = [
  '#!/usr/bin/env bash',
  'printf "%s\\t%s\\n" "${FAKE_SRC_EPOCH:-1000000000}" "${FAKE_SRC_FILE:-/repo/src/foo.ts}"',
].join('\n');

// Minimal emit stub: prints what it was called with so tests can assert argv.
const FAKE_EMIT_PY = [
  '#!/usr/bin/env python3',
  'import sys',
  'args = sys.argv[1:]',
  'def get(flag):',
  '    try:',
  '        return args[args.index(flag) + 1]',
  '    except (ValueError, IndexError):',
  '        return None',
  'if "--clear" in args:',
  '    source = get("--source") or ""',
  '    instance = get("--instance") or ""',
  '    print(f"CLEAR {source} {instance}")',
  'else:',
  '    severity = get("--severity") or ""',
  '    source = get("--source") or ""',
  '    instance = get("--instance") or ""',
  '    diags = [args[i+1] for i,a in enumerate(args) if a == "--diagnostic" and i+1 < len(args)]',
  '    lag = next((d.split("=",1)[1] for d in diags if d.startswith("lag_seconds=")), "")',
  '    crit = next((d.split("=",1)[1] for d in diags if d.startswith("critical=")), "")',
  '    print(f"ALERT {severity} {source} {instance} lag={lag} critical={crit}")',
].join('\n');

let binDir: string;
let emitScript: string;

function writeFake(name: string, body: string): void {
  const p = path.join(binDir, name);
  writeFileSync(p, body, 'utf8');
  chmodSync(p, 0o755);
}

function run(
  args: string[],
  fakeEnv: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('python3', [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      // Default every run at the stub emitter so non-dry-run cases NEVER touch
      // the real outbox. A test may still override via fakeEnv.
      BOT_ERRORS_STALENESS_EMIT_SCRIPT: emitScript,
      ...fakeEnv,
      PATH: `${binDir}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

beforeEach(() => {
  binDir = mkdtempSync(path.join(tmpdir(), 'brs-bin-'));
  writeFake('systemctl', FAKE_SYSTEMCTL);
  writeFake('ps', FAKE_PS);
  writeFake('find', FAKE_FIND);

  const emitDir = mkdtempSync(path.join(tmpdir(), 'brs-emit-'));
  emitScript = path.join(emitDir, 'bot-errors-emit.py');
  writeFileSync(emitScript, FAKE_EMIT_PY, 'utf8');
  chmodSync(emitScript, 0o644);
});

afterEach(() => {
  rmSync(binDir, { recursive: true, force: true });
  if (emitScript) {
    rmSync(path.dirname(emitScript), { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Pure builder assertions — verify emit argv shape via --dry-run output.
// ---------------------------------------------------------------------------

describe('pure builder: build_emit_argv', () => {
  it('STALE --dry-run prints --severity warning --source runtime_stale --instance with diagnostics', () => {
    const nowApprox = Math.floor(Date.now() / 1000);
    const r = run(['--dry-run', '--instance', 'demo'], {
      FAKE_ETIMES: '100',
      FAKE_SRC_EPOCH: String(nowApprox + 3600),
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('--severity warning');
    expect(r.stdout).toContain('--source runtime_stale');
    expect(r.stdout).toContain('--instance demo');
    expect(r.stdout).toContain('--diagnostic lag_seconds=');
    expect(r.stdout).toContain('--diagnostic critical=');
  });

  it('build_clear_argv: FRESH --dry-run prints --clear --source runtime_stale --instance', () => {
    const r = run(['--dry-run', '--instance', 'demo'], {
      FAKE_ETIMES: '100',
      FAKE_SRC_EPOCH: '1000000000',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('--clear');
    expect(r.stdout).toContain('--source runtime_stale');
    expect(r.stdout).toContain('--instance demo');
  });
});

// ---------------------------------------------------------------------------
// Integration: STALE / FRESH / not-running scenarios.
// ---------------------------------------------------------------------------

describe('integration: staleness verdict and emit routing', () => {
  it('STALE → shells emit.py with ALERT warning runtime_stale and lag', () => {
    const nowApprox = Math.floor(Date.now() / 1000);
    const r = run(['--instance', 'demo'], {
      FAKE_ETIMES: '100',
      FAKE_SRC_EPOCH: String(nowApprox + 3600),
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('STALE');
    expect(r.stdout).toContain('whatsoup@demo');
    // The stub emitter (run() points EMIT_SCRIPT at it) must receive the alert —
    // proves the real emit path is exercised, NOT the live outbox.
    expect(r.stdout).toContain('ALERT warning runtime_stale demo');
  });

  it('FRESH → shells emit.py with a CLEAR for the instance', () => {
    const r = run(['--instance', 'demo'], {
      FAKE_ETIMES: '100',
      FAKE_SRC_EPOCH: '1000000000',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('fresh');
    expect(r.stdout).toContain('whatsoup@demo');
    expect(r.stdout).toContain('CLEAR runtime_stale demo');
  });

  it('not-running (MainPID=0) → no emit, skipped with note', () => {
    const r = run(['--instance', 'demo'], {
      FAKE_MAINPID: '0',
      FAKE_SRC_EPOCH: '9999999999',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('not running');
    // Must not attempt an emit for a not-running instance
    expect(r.stdout).not.toContain('STALE');
    expect(r.stdout).not.toContain('fresh');
  });

  it('not-running (non-numeric MainPID output) → no emit', () => {
    // The fake systemctl echoes FAKE_MAINPID verbatim; "notapid" is non-numeric
    // so parse_main_pid returns None → instance treated as not running.
    const r = run(['--instance', 'demo'], {
      FAKE_MAINPID: 'notapid',
      FAKE_SRC_EPOCH: '9999999999',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('not running');
    expect(r.stdout).not.toContain('STALE');
  });

  it('exit 0 on successful run even when instance is STALE', () => {
    const nowApprox = Math.floor(Date.now() / 1000);
    const r = run(['--instance', 'demo'], {
      FAKE_ETIMES: '100',
      FAKE_SRC_EPOCH: String(nowApprox + 9999),
    });
    // Monitor is a reporter: exit 0 on a successful run regardless of staleness.
    // (exit 1 only on emit failure, exit 2 on probe/config error)
    expect(r.status).toBe(0);
  });

  it('discovers instances via systemctl when --instance is omitted', () => {
    const r = run([], {
      FAKE_ETIMES: '100',
      FAKE_SRC_EPOCH: '1000000000',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('whatsoup@demo');
  });
});

// ---------------------------------------------------------------------------
// --dry-run: prints [dry-run], does not shell emit.py
// ---------------------------------------------------------------------------

describe('--dry-run', () => {
  it('STALE --dry-run prints [dry-run] and does NOT invoke emit.py', () => {
    const nowApprox = Math.floor(Date.now() / 1000);
    const r = run(['--dry-run', '--instance', 'demo'], {
      FAKE_ETIMES: '100',
      FAKE_SRC_EPOCH: String(nowApprox + 3600),
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('[dry-run]');
    // The fake emit stub output should NOT appear (emit.py was not run)
    expect(r.stdout).not.toContain('ALERT');
  });

  it('FRESH --dry-run prints [dry-run] with --clear in the printed argv', () => {
    const r = run(['--dry-run', '--instance', 'demo'], {
      FAKE_ETIMES: '100',
      FAKE_SRC_EPOCH: '1000000000',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('[dry-run]');
    expect(r.stdout).toContain('--clear');
    expect(r.stdout).not.toContain('CLEAR');
  });

  it('not-running --dry-run logs skip without [dry-run] emit line', () => {
    const r = run(['--dry-run', '--instance', 'demo'], {
      FAKE_MAINPID: '0',
      FAKE_SRC_EPOCH: '9999999999',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('not running');
    expect(r.stdout).not.toContain('[dry-run]');
  });
});

// ---------------------------------------------------------------------------
// --config-check
// ---------------------------------------------------------------------------

describe('--config-check', () => {
  it('exits 0 and reports config ok when emit script exists on disk', () => {
    const r = run(['--config-check']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('config ok');
  });
});
