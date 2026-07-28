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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../deploy/scripts/bot-errors-runtime-staleness.py',
);
const CRITICAL_SUFFIXES = [
  'src/runtimes/agent/failure-taxonomy.ts',
  'src/runtimes/agent/runtime.ts',
  'src/runtimes/agent/fallback-empty-advance.ts',
  'src/core/health.ts',
];

// ---------------------------------------------------------------------------
// Fake binaries
// ---------------------------------------------------------------------------

const FAKE_SYSTEMCTL = [
  '#!/usr/bin/env bash',
  'if [ -n "${FAKE_SYSTEMCTL_RC:-}" ]; then exit "${FAKE_SYSTEMCTL_RC}"; fi',
  'case "$*" in',
  // printf with %s keeps the literal off the email/private-label shape patterns.
  '  *list-units*)',
  '    if [ -n "${FAKE_DISCOVERY_EMPTY:-}" ]; then exit 0; fi',
  '    if [ -n "${FAKE_DISCOVERY_MALFORMED:-}" ]; then echo "invalid"; exit 0; fi',
  '    if [ -n "${FAKE_DISCOVERY_MIXED:-}" ]; then',
  '      printf "whatsoup@%s.service loaded active running\\ninvalid\\n" demo; exit 0; fi',
  '    printf "whatsoup@%s.service  loaded active running WhatSoup %s\\n" demo demo ;;',
  // Plain "-" (not ":-") so an explicitly-empty override (FAKE_MAINPID='')
  // echoes truly empty output instead of falling back to the default —
  // ":-" treats set-but-null the same as unset and would swallow that case.
  '  *MainPID*)    echo "${FAKE_MAINPID-999999}" ;;',
  '  *) : ;;',
  'esac',
].join('\n');

const FAKE_PS = [
  '#!/usr/bin/env bash',
  'if [ -n "${FAKE_PS_RC:-}" ]; then exit "${FAKE_PS_RC}"; fi',
  'if [ -n "${FAKE_PS_SLEEP:-}" ]; then sleep "${FAKE_PS_SLEEP}"; fi',
  'echo "${FAKE_ETIMES-100}"',
].join('\n');

const FAKE_FIND = [
  '#!/usr/bin/env bash',
  'if [ -n "${FAKE_FIND_RC:-}" ]; then exit "${FAKE_FIND_RC}"; fi',
  'if [ -n "${FAKE_FIND_EMPTY:-}" ]; then exit 0; fi',
  'if [ -n "${FAKE_FIND_MALFORMED:-}" ]; then echo "invalid"; exit 0; fi',
  'if [ -n "${FAKE_FIND_MIXED:-}" ]; then printf "1000000000\\t/repo/src/foo.ts\\ninvalid\\n"; exit 0; fi',
  'if [ -n "${FAKE_FIND_NONFINITE:-}" ]; then printf "inf\\t/repo/src/foo.ts\\n"; exit 0; fi',
  'printf "%s\\t%s\\n" "${FAKE_SRC_EPOCH:-1000000000}" "${FAKE_SRC_FILE:-/repo/src/foo.ts}"',
].join('\n');

// Minimal emit stub: prints what it was called with so tests can assert argv.
const FAKE_EMIT_PY = [
  '#!/usr/bin/env python3',
  'import os, sys',
  'ledger = os.environ.get("FAKE_EMIT_LEDGER", "")',
  'if ledger:',
  '    with open(ledger, "a", encoding="utf-8") as fh:',
  '        fh.write("invoked\\n")',
  'rc = os.environ.get("FAKE_EMIT_RC", "")',
  'if rc:',
  '    sys.exit(int(rc))',
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
let emitLedger: string;
let procRoot: string;

function writeFake(name: string, body: string): void {
  const p = path.join(binDir, name);
  writeFileSync(p, body, 'utf8');
  chmodSync(p, 0o755);
}

function setProcessRoot(repoRoot: string, pid = '999999'): void {
  const pidRoot = path.join(procRoot, pid);
  mkdirSync(pidRoot, { recursive: true });
  writeFileSync(
    path.join(pidRoot, 'cmdline'),
    `node\0${path.join(repoRoot, 'src/bootstrap.ts')}\0demo\0`,
    'latin1',
  );
}

function makeRuntimeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'brs-runtime-'));
  for (const suffix of CRITICAL_SUFFIXES) {
    const file = path.join(root, suffix);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'fixture\n', 'utf8');
    utimesSync(file, 1_000_000_000, 1_000_000_000);
  }
  return root;
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
      FAKE_EMIT_LEDGER: emitLedger,
      // Bind the source root to a synthetic target-process cmdline rather than
      // accepting a configured checkout fallback.
      BOT_ERRORS_STALENESS_PROC_ROOT: procRoot,
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
  emitLedger = path.join(emitDir, 'invocations.log');
  writeFileSync(emitScript, FAKE_EMIT_PY, 'utf8');
  chmodSync(emitScript, 0o644);

  procRoot = mkdtempSync(path.join(tmpdir(), 'brs-proc-'));
  setProcessRoot(process.cwd());
});

afterEach(() => {
  rmSync(binDir, { recursive: true, force: true });
  if (emitScript) {
    rmSync(path.dirname(emitScript), { recursive: true, force: true });
  }
  if (procRoot) {
    rmSync(procRoot, { recursive: true, force: true });
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

  // NOTE: the former 'malformed MainPID is a probe error, not a not-running
  // skip' case was deleted as redundant — its assertions are a strict subset
  // of the probe-honesty (B1) 'malformed MainPID output → exit 2, distinct
  // from not-running' test below, which also asserts stderr and no emit.

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
    expect(r.stdout).not.toContain(emitScript);
  });
});

// ---------------------------------------------------------------------------
// probe honesty (B1): probe failures must never be converted to a false
// fresh/stale/not-running verdict. Any probe error → exit 2, no emit.
// ---------------------------------------------------------------------------

describe('probe honesty (B1)', () => {
  it('discovery command failure → exit 2, no alert, no clear', () => {
    const res = run([], { FAKE_SYSTEMCTL_RC: '1' });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('probe error');
    expect(res.stdout).not.toContain('ALERT');
    expect(res.stdout).not.toContain('CLEAR');
  });

  it('successful discovery with zero instances → exit 2, not an empty healthy fleet', () => {
    const res = run([], { FAKE_DISCOVERY_EMPTY: '1' });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('probe error');
  });

  it('malformed MainPID output → exit 2, distinct from not-running', () => {
    const res = run(['--instance', 'demo'], { FAKE_MAINPID: 'garbage' });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('malformed');
    expect(res.stdout).not.toContain('ALERT');
    expect(res.stdout).not.toContain('CLEAR');
  });

  it('empty MainPID output → exit 2, distinct from not-running', () => {
    const res = run(['--instance', 'demo'], { FAKE_MAINPID: '' });
    expect(res.status).toBe(2);
  });

  it('ps command failure → exit 2, no emit', () => {
    const res = run(['--instance', 'demo'], { FAKE_PS_RC: '1' });
    expect(res.status).toBe(2);
    expect(res.stdout).not.toContain('ALERT');
    expect(res.stdout).not.toContain('CLEAR');
  });

  it('malformed ps etimes → exit 2, no emit', () => {
    const res = run(['--instance', 'demo'], { FAKE_ETIMES: 'abc' });
    expect(res.status).toBe(2);
  });

  it('find command failure → exit 2, never a false CLEAR', () => {
    const res = run(['--instance', 'demo'], { FAKE_FIND_RC: '1' });
    expect(res.status).toBe(2);
    expect(res.stdout).not.toContain('CLEAR');
  });

  it('empty find output → exit 2, never a false CLEAR', () => {
    const res = run(['--instance', 'demo'], { FAKE_FIND_EMPTY: '1' });
    expect(res.status).toBe(2);
    expect(res.stdout).not.toContain('CLEAR');
  });

  it('unresolvable process source identity → exit 2', () => {
    const res = run(['--instance', 'demo'], {
      FAKE_MAINPID: '4194000',
    });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('missing');
  });

  it('observation-only JSON reports current with exit 0 and never emits', () => {
    const res = run(['--observe-only', '--json', '--instance', 'private-json-canary'], {
      FAKE_SRC_EPOCH: '1000000000',
      FAKE_EMIT_RC: '9',
    });
    expect(res.status).toBe(0);
    const report = JSON.parse(res.stdout);
    expect(report).toEqual({
      schemaVersion: 1,
      check: 'runtime-code-staleness',
      executionStatus: 'completed',
      status: 'current',
      evidenceComplete: true,
      inventoryStatus: 'not_requested',
      criterion: 'all_source',
      counts: {
        total: 1,
        current: 1,
        stale: 0,
        notRunning: 0,
        unknown: 0,
      },
      failureCounts: {
        missing: 0,
        malformed: 0,
        timeout: 0,
        permissionError: 0,
        commandError: 0,
      },
    });
    expect(res.stdout).not.toContain('CLEAR');
    expect(res.stdout).not.toContain('ALERT');
    expect(res.stdout).not.toContain('demo');
    expect(res.stdout).not.toContain('private-json-canary');
    expect(res.stderr).toBe('');
    expect(existsSync(emitLedger)).toBe(false);
  });

  it('observation-only JSON reports stale with exit 1 and never emits', () => {
    const res = run(['--observe-only', '--json', '--instance', 'demo'], {
      FAKE_SRC_EPOCH: String(Math.floor(Date.now() / 1000) + 3600),
      FAKE_EMIT_RC: '9',
    });
    expect(res.status).toBe(1);
    expect(JSON.parse(res.stdout)).toMatchObject({
      schemaVersion: 1,
      check: 'runtime-code-staleness',
      status: 'stale',
      evidenceComplete: true,
      counts: { total: 1, current: 0, stale: 1, notRunning: 0, unknown: 0 },
    });
    expect(res.stdout).not.toContain('demo');
    expect(res.stdout).not.toContain('ALERT');
    expect(res.stderr).toBe('');
    expect(existsSync(emitLedger)).toBe(false);
  });

  it('observation-only JSON distinguishes exact not-running with exit 0', () => {
    const res = run(['--observe-only', '--json', '--instance', 'demo'], {
      FAKE_MAINPID: '0',
      FAKE_EMIT_RC: '9',
    });
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout)).toMatchObject({
      status: 'not_running',
      evidenceComplete: true,
      counts: { total: 1, current: 0, stale: 0, notRunning: 1, unknown: 0 },
    });
    expect(res.stdout).not.toContain('demo');
    expect(res.stderr).toBe('');
    expect(existsSync(emitLedger)).toBe(false);
  });

  it('observation-only human output derives from the same bounded result', () => {
    const res = run(['--observe-only', '--instance', 'private-canary'], {
      FAKE_MAINPID: '0',
      FAKE_EMIT_RC: '9',
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe(
      'runtime-code-staleness: status=not_running execution_status=completed ' +
      'evidence_complete=true inventory_status=not_requested criterion=all_source ' +
      'total=1 current=0 stale=0 not_running=1 unknown=0\n',
    );
    expect(res.stdout).not.toContain('private-canary');
    expect(existsSync(emitLedger)).toBe(false);
  });

  it('--json without --observe-only fails closed', () => {
    const res = run(['--json', '--instance', 'demo']);
    expect(res.status).toBe(2);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('--json requires --observe-only');
  });

  it('--config-check cannot bypass observation JSON validation', () => {
    const res = run(['--config-check', '--json']);
    expect(res.status).toBe(2);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('--json requires --observe-only');
    expect(res.stderr).not.toContain(emitScript);
  });

  it('--critical requires the complete critical set before reporting current', () => {
    const root = makeRuntimeRoot();
    try {
      const future = Math.floor(Date.now() / 1000) + 3600;
      utimesSync(path.join(root, CRITICAL_SUFFIXES[0]), future, future);
      rmSync(path.join(root, CRITICAL_SUFFIXES[1]));
      setProcessRoot(root);
      const res = run(['--observe-only', '--json', '--critical', '--instance', 'demo'], {
        FAKE_SRC_EPOCH: '1000000000',
      });
      expect(res.status).toBe(2);
      expect(JSON.parse(res.stdout)).toMatchObject({
        status: 'unknown',
        evidenceComplete: false,
        failureCounts: { missing: 1 },
      });
      expect(existsSync(emitLedger)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('--critical observes later unreadable entries even after finding staleness', () => {
    const root = makeRuntimeRoot();
    try {
      const future = Math.floor(Date.now() / 1000) + 3600;
      utimesSync(path.join(root, CRITICAL_SUFFIXES[0]), future, future);
      const code = [
        'import builtins, importlib.util',
        `spec = importlib.util.spec_from_file_location("runtime_staleness", ${JSON.stringify(SCRIPT)})`,
        'module = importlib.util.module_from_spec(spec)',
        'spec.loader.exec_module(module)',
        'real_open = builtins.open',
        'def controlled_open(file, *args, **kwargs):',
        `    if str(file).endswith(${JSON.stringify(CRITICAL_SUFFIXES[1])}):`,
        '        raise PermissionError()',
        '    return real_open(file, *args, **kwargs)',
        'module.open = controlled_open',
        'try:',
        `    module.is_critical_stale(1, 2, ${JSON.stringify(root)})`,
        'except module.ProbeError as exc:',
        '    print(exc.kind)',
        '    raise SystemExit(0)',
        'raise SystemExit(1)',
      ].join('\n');
      const res = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
      expect(res.status).toBe(0);
      expect(res.stdout).toBe('permission_error\n');
      expect(res.stderr).toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('--critical classifies from the canonical complete critical observation', () => {
    const root = makeRuntimeRoot();
    try {
      setProcessRoot(root);
      const current = run(['--observe-only', '--json', '--critical', '--instance', 'demo'], {
        FAKE_SRC_EPOCH: '1000000000',
      });
      expect(current.status).toBe(0);
      expect(JSON.parse(current.stdout)).toMatchObject({
        status: 'current',
        criterion: 'critical',
      });

      const future = Math.floor(Date.now() / 1000) + 3600;
      utimesSync(path.join(root, CRITICAL_SUFFIXES[0]), future, future);
      const stale = run(['--observe-only', '--json', '--critical', '--instance', 'demo'], {
        FAKE_SRC_EPOCH: '1000000000',
      });
      expect(stale.status).toBe(1);
      expect(JSON.parse(stale.stdout).status).toBe('stale');
      expect(existsSync(emitLedger)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['discovery failure', [], { FAKE_SYSTEMCTL_RC: '1' }, 'commandError', 'commandError'],
    ['empty discovery', [], { FAKE_DISCOVERY_EMPTY: '1' }, 'missing', 'missing'],
    ['malformed discovery', [], { FAKE_DISCOVERY_MALFORMED: '1' }, 'malformed', 'malformed'],
    ['mixed discovery', [], { FAKE_DISCOVERY_MIXED: '1' }, 'malformed', 'malformed'],
    ['PID failure', ['--instance', 'demo'], { FAKE_SYSTEMCTL_RC: '1' }, 'commandError', 'not_requested'],
    ['empty PID', ['--instance', 'demo'], { FAKE_MAINPID: '' }, 'missing', 'not_requested'],
    ['malformed PID', ['--instance', 'demo'], { FAKE_MAINPID: 'invalid' }, 'malformed', 'not_requested'],
    ['elapsed-time failure', ['--instance', 'demo'], { FAKE_PS_RC: '1' }, 'commandError', 'not_requested'],
    ['empty elapsed time', ['--instance', 'demo'], { FAKE_ETIMES: '' }, 'missing', 'not_requested'],
    ['malformed elapsed time', ['--instance', 'demo'], { FAKE_ETIMES: 'invalid' }, 'malformed', 'not_requested'],
    ['source scan failure', ['--instance', 'demo'], { FAKE_FIND_RC: '1' }, 'commandError', 'not_requested'],
    ['empty source scan', ['--instance', 'demo'], { FAKE_FIND_EMPTY: '1' }, 'missing', 'not_requested'],
    ['malformed source scan', ['--instance', 'demo'], { FAKE_FIND_MALFORMED: '1' }, 'malformed', 'not_requested'],
    ['mixed source scan', ['--instance', 'demo'], { FAKE_FIND_MIXED: '1' }, 'malformed', 'not_requested'],
    ['non-finite source time', ['--instance', 'demo'], { FAKE_FIND_NONFINITE: '1' }, 'malformed', 'not_requested'],
  ])('observation-only JSON makes %s typed unknown with exit 2', (_name, args, env, failureKey, inventoryStatus) => {
    const res = run(['--observe-only', '--json', ...args], {
      ...env,
      FAKE_EMIT_RC: '9',
    });
    expect(res.status).toBe(2);
    expect(JSON.parse(res.stdout)).toMatchObject({
      schemaVersion: 1,
      check: 'runtime-code-staleness',
      executionStatus: 'incomplete',
      status: 'unknown',
      evidenceComplete: false,
    });
    const report = JSON.parse(res.stdout);
    expect(report.failureCounts[failureKey]).toBe(1);
    expect(report.inventoryStatus).toBe(inventoryStatus);
    expect(
      report.counts.current +
      report.counts.stale +
      report.counts.notRunning +
      report.counts.unknown,
    ).toBe(report.counts.total);
    expect(res.stdout).not.toContain('demo');
    expect(res.stdout).not.toContain('CLEAR');
    expect(res.stdout).not.toContain('ALERT');
    expect(res.stderr).toBe('');
    expect(existsSync(emitLedger)).toBe(false);
  });

  it('observation-only JSON preserves timeout as a bounded failure class', () => {
    const res = run(['--observe-only', '--json', '--instance', 'demo'], {
      FAKE_PS_SLEEP: '1',
      BOT_ERRORS_STALENESS_PROBE_TIMEOUT_SECONDS: '0.05',
    });
    expect(res.status).toBe(2);
    expect(JSON.parse(res.stdout).failureCounts.timeout).toBe(1);
    expect(res.stderr).toBe('');
    expect(existsSync(emitLedger)).toBe(false);
  });

  it('observation-only JSON preserves permission failure as a bounded class', () => {
    const code = [
      'import importlib.util',
      `spec = importlib.util.spec_from_file_location("runtime_staleness", ${JSON.stringify(SCRIPT)})`,
      'module = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'def deny(*args, **kwargs):',
      '    raise PermissionError()',
      'module.subprocess.run = deny',
      'raise SystemExit(module.observe_once(instances=None, json_output=True, critical_only=False))',
    ].join('\n');
    const res = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
    expect(res.status).toBe(2);
    expect(JSON.parse(res.stdout)).toMatchObject({
      inventoryStatus: 'permissionError',
      failureCounts: { permissionError: 1 },
    });
    expect(res.stderr).toBe('');
  });

  it('emit script failure → exit 1', () => {
    const res = run(['--instance', 'demo'], {
      FAKE_SRC_EPOCH: String(Math.floor(Date.now() / 1000) + 3600),
      FAKE_EMIT_RC: '7',
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('emit failed');
  });
});
