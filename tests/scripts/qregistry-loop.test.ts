import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  buildChildEnv,
  buildWorkerPlans,
  collectSourceFiles,
  computeRegisterHash,
  acquireRunLock,
  dispatchLockPath,
  healthAllowsDispatch,
  parseRegister,
  prepareWorkerStaging,
  redactForWorker,
  resolveCheckerPath,
  resolveMemoryMcpRoot,
  resolveSafeExporterPath,
  run,
  safeExportScanFindings,
  shouldDispatch,
  withDispatchLock,
} from '../../scripts/qregistry-loop.ts';
import { acquireProcessLock, releaseProcessLock } from '../../src/lib/process-lock.ts';

function entry(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema_version: 1,
    id: 'QR-900',
    source_ref: 'test',
    kind: 'debt',
    title: 'Investigate durable memory trace gap',
    severity: 'medium',
    canonical_owner: 'me',
    disposition: 'deferred',
    files: ['src/mcp/registry.ts'],
    unresolved_unknowns: ['whether candidate ids are traced'],
    ...overrides,
  });
}

describe('qregistry loop helpers', () => {
  it('parses actionable register entries and ignores closed dispositions for worker dispatch', () => {
    const parsed = parseRegister([
      entry({ id: 'QR-001', disposition: 'implemented' }),
      entry({ id: 'QR-002', severity: 'high', disposition: 'under-review' }),
      entry({ id: 'QR-003', disposition: 'superseded', superseded_by: 'QR-004' }),
    ].join('\n'));

    expect(parsed.map((item) => item.id)).toEqual(['QR-001', 'QR-002', 'QR-003']);
    const plans = buildWorkerPlans(parsed, {
      repoRoot: '/repo',
      registerPath: '/repo/qregistry.ndjson',
      auditPath: '/repo/docs/audits/2026-06-27-memory-harness-gap-analysis.md',
      sourceFiles: ['/repo/src/mcp/registry.ts'],
      maxWorkers: 2,
      maxItems: 4,
    });

    expect(plans).toHaveLength(2);
    expect(plans[0].role).toBe('review');
    expect(plans[0].prompt).toContain('QR-002');
    expect(plans[0].prompt).not.toContain('QR-001');
    expect(plans[0].prompt).not.toContain('QR-003');
    expect(plans[1].role).toBe('research');
  });

  it('limits worker prompts to the highest-priority actionable items', () => {
    const parsed = parseRegister([
      entry({ id: 'QR-001', severity: 'low', disposition: 'observed' }),
      entry({ id: 'QR-002', severity: 'medium', disposition: 'observed' }),
      entry({ id: 'QR-003', severity: 'high', disposition: 'observed' }),
      entry({ id: 'QR-004', severity: 'high', disposition: 'observed' }),
      entry({ id: 'QR-005', severity: 'medium', disposition: 'observed' }),
      entry({ id: 'QR-006', severity: 'medium', disposition: 'observed' }),
    ].join('\n'));

    const [plan] = buildWorkerPlans(parsed, {
      repoRoot: '/repo',
      registerPath: '/repo/qregistry.ndjson',
      auditPath: '/repo/docs/audits/2026-06-27-memory-harness-gap-analysis.md',
      sourceFiles: [],
      maxWorkers: 1,
      maxItems: 4,
    });

    expect(plan!.prompt).toContain('QR-003');
    expect(plan!.prompt).toContain('QR-004');
    expect(plan!.prompt).toContain('QR-002');
    expect(plan!.prompt).toContain('QR-005');
    expect(plan!.prompt).not.toContain('QR-006');
    expect(plan!.prompt).not.toContain('QR-001');
  });

  it('dispatches on first run, register hash change, or explicit force only', () => {
    const current = computeRegisterHash('a\n');
    expect(shouldDispatch({ currentHash: current, previousHash: null, force: false })).toBe(true);
    expect(shouldDispatch({ currentHash: current, previousHash: current, force: false })).toBe(false);
    expect(shouldDispatch({ currentHash: current, previousHash: computeRegisterHash('b\n'), force: false })).toBe(true);
    expect(shouldDispatch({ currentHash: current, previousHash: current, force: true })).toBe(true);
  });

  it('stages only existing repo-local source files, capped by count and size', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qregistry-loop-'));
    const repoFile = path.join(dir, 'src', 'mcp');
    writeFileSync(path.join(dir, 'qregistry.ndjson'), '', 'utf8');
    // mkdirSync is intentionally avoided here; writeFileSync to a missing dir would
    // make the test fail for the wrong reason if the helper changes.
    expect(() => collectSourceFiles(dir, [], { maxFiles: 4, maxBytes: 100 })).not.toThrow();

    mkdirSync(repoFile, { recursive: true });
    writeFileSync(path.join(repoFile, 'registry.ts'), 'export const registry = true;\n', 'utf8');
    writeFileSync(path.join(dir, 'large.ts'), 'x'.repeat(101), 'utf8');

    const parsed = parseRegister(entry({
      files: [
        'src/mcp/registry.ts',
        'large.ts',
        '../outside.ts',
        '/etc/passwd',
        'memory.db',
      ],
    }));

    expect(collectSourceFiles(dir, parsed, { maxFiles: 4, maxBytes: 100 })).toEqual([
      path.join(dir, 'src/mcp/registry.ts'),
    ]);
  });

  it('redacts secret-looking fixture text before staging files for workers', () => {
    const bearer = `Bearer ${'token'}123456789`;

    expect(redactForWorker(`const jwt = "abc.def.ghi";\nAuthorization: ${bearer}\n`)).toBe(
      'const jwt = "<redacted>";\nAuthorization: Bearer <redacted>\n',
    );

    const dir = mkdtempSync(path.join(tmpdir(), 'qregistry-stage-'));
    mkdirSync(path.join(dir, 'fixtures'), { recursive: true });
    const source = path.join(dir, 'fixtures', 'canary.ts');
    writeFileSync(source, 'const jwt = "abc.def.ghi";\n', 'utf8');

    const staged = prepareWorkerStaging({
      repoRoot: dir,
      runDir: path.join(dir, 'raw', 'run'),
      files: [source],
    });

    expect(staged).toHaveLength(1);
    expect(readFileSync(staged[0]!, 'utf8')).toContain('jwt = "<redacted>"');
  });

  it('allows degraded health when the pinned GLM worker lane is healthy', () => {
    expect(healthAllowsDispatch(0, '')).toBe(true);
    expect(healthAllowsDispatch(1, 'healthy    glm/glm-5.2                  glm         13s  ok\nunhealthy  minimax/MiniMax-M3')).toBe(true);
    expect(healthAllowsDispatch(1, 'healthy    deepseek/deepseek-v4-pro     deepseek     9s  ok')).toBe(false);
  });

  it('recovers a stale lock directory with no live pid', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qregistry-lock-'));
    const lockDir = path.join(dir, 'lock');
    mkdirSync(lockDir);

    const lock = acquireRunLock(lockDir);
    expect(lock).not.toBeNull();
    lock!.release();
  });

  it('exposes the documented npm command surface', () => {
    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(pkg.scripts?.['qregistry:loop']).toBe(
      'bash scripts/run-with-pinned-node.sh scripts/qregistry-loop.ts',
    );
  });

  it('resolves the shared checker without hard-coding a local home path', () => {
    expect(resolveCheckerPath('/repo/WhatSoup', { QREGISTRY_CHECKER: '/opt/q/check.py' }, () => false)).toBe(
      '/opt/q/check.py',
    );

    const worktreeRoot = '/lab/WhatSoup/.worktrees/qregistry-loop-surface';
    const resolved = resolveCheckerPath(worktreeRoot, {}, (candidate) => candidate === '/lab/qRegistry/scripts/qregistry-check.py');

    expect(resolved).toBe('/lab/qRegistry/scripts/qregistry-check.py');
    expect(resolved).not.toContain('/Users/');
  });

  it('resolves the shared safe exporter without hard-coding a local home path', () => {
    expect(resolveSafeExporterPath('/repo/WhatSoup', { QREGISTRY_SAFE_EXPORTER: '/opt/q/safe.py' }, () => false)).toBe(
      '/opt/q/safe.py',
    );

    const worktreeRoot = '/lab/WhatSoup/.worktrees/qregistry-loop-surface';
    const resolved = resolveSafeExporterPath(
      worktreeRoot,
      {},
      (candidate) => candidate === '/lab/qRegistry/scripts/qregistry-safe-export.py',
    );

    expect(resolved).toBe('/lab/qRegistry/scripts/qregistry-safe-export.py');
    expect(resolved).not.toContain('/Users/');
  });

  it('detects unsafe identifiers in safe-export candidates before worker dispatch', () => {
    const groupId = ['120363', '427253', '262639'].join('');
    const userId = ['1555', '123', '4567'].join('');
    const lidId = ['abcdef', '123456', '7890'].join('');
    const groupJid = `${groupId}@${'g.us'}`;
    const userJid = `${userId}@${'s.whatsapp.net'}`;
    const lid = `${lidId}@${'lid'}`;
    const pairingCode = `${'ABCD'}-${'1234'}`;
    const text = JSON.stringify({
      groupJid,
      userJid,
      lid,
      authPath: 'instances/ad-bot/auth/creds.json',
      tokenLine: `token=${lidId}`,
      pairingCode,
      authorization: `Bearer ${'token'}1234567890`,
    });

    expect(safeExportScanFindings(text)).toEqual([
      'raw_whatsapp_user_or_group_jid',
      'raw_lid',
      'bearer_token',
      'secret_assignment',
      'auth_creds_path',
      'pairing_code',
    ]);
  });

  it('stages the safe qRegistry export, not the raw register, for worker plans', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qregistry-loop-safe-export-'));
    writeFileSync(path.join(dir, 'qregistry.ndjson'), `${entry()}\n`, 'utf8');
    const checker = path.join(dir, 'checker.py');
    writeFileSync(checker, 'import sys\nprint("checker ok")\nsys.exit(0)\n', 'utf8');
    const exporter = path.join(dir, 'safe-export.py');
    writeFileSync(exporter, [
      'import json, sys',
      'out = sys.argv[sys.argv.index("--out") + 1]',
      'register = sys.argv[sys.argv.index("--register") + 1]',
      'data = {"artifact_type":"qregistry.safe_export.v0","source_register":"qregistry.ndjson","source_rows":1,"entries":[{"id":"QR-900","title":"safe"}]}',
      'open(out, "w").write(json.dumps(data) + "\\n")',
      'print("SAFE_EXPORT rows=1 out=" + out)',
    ].join('\n'), 'utf8');

    const status = run([
      '--repo',
      dir,
      '--checker',
      checker,
      '--safe-exporter',
      exporter,
      '--no-dispatch',
      '--force',
    ], { ...process.env, PYTHON: 'python3' });

    expect(status).toBe(0);
    const runsRoot = path.join(dir, 'raw', 'qregistry-loop', 'runs');
    const runName = readFileSync(path.join(dir, 'raw', 'qregistry-loop', 'register.sha256'), 'utf8').trim();
    expect(runName).toMatch(/^[a-f0-9]{64}$/);
    const runDirs = readFileSync(path.join(dir, 'raw', 'qregistry-loop', 'last-run.txt'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean);
    expect(runDirs).toHaveLength(1);
    const runDir = path.join(runsRoot, runDirs[0]!);
    const summary = JSON.parse(readFileSync(path.join(runDir, 'summary.json'), 'utf8')) as {
      safeExport?: { status?: string; path?: string };
    };
    expect(summary.safeExport?.status).toBe('ok');
    expect(path.basename(summary.safeExport?.path ?? '')).toBe('qregistry.safe-export.json');
    const staged = readFileSync(path.join(runDir, 'staged-files.json'), 'utf8') as unknown as string;
    expect(staged).toContain('qregistry.safe-export.json');
    expect(staged).not.toContain('qregistry.ndjson');
  });

  it('fails closed before dispatch when the safe export contains forbidden patterns', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qregistry-loop-bad-safe-export-'));
    writeFileSync(path.join(dir, 'qregistry.ndjson'), `${entry()}\n`, 'utf8');
    const checker = path.join(dir, 'checker.py');
    writeFileSync(checker, 'import sys\nprint("checker ok")\nsys.exit(0)\n', 'utf8');
    const exporter = path.join(dir, 'bad-safe-export.py');
    writeFileSync(exporter, [
      'import json, sys',
      'out = sys.argv[sys.argv.index("--out") + 1]',
      'jid = "".join(["120363", "427253", "262639"]) + "@" + "g.us"',
      'open(out, "w").write(json.dumps({"artifact_type":"qregistry.safe_export.v0","title":jid}) + "\\n")',
      'print("SAFE_EXPORT rows=1 out=" + out)',
    ].join('\n'), 'utf8');

    const status = run([
      '--repo',
      dir,
      '--checker',
      checker,
      '--safe-exporter',
      exporter,
      '--force',
    ], { ...process.env, PYTHON: 'python3', PATH: '/usr/bin:/bin' });

    expect(status).toBe(2);
    const runDirs = readFileSync(path.join(dir, 'raw', 'qregistry-loop', 'last-run.txt'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean);
    const runDir = path.join(dir, 'raw', 'qregistry-loop', 'runs', runDirs[0]!);
    const summary = JSON.parse(readFileSync(path.join(runDir, 'summary.json'), 'utf8')) as {
      reason?: string;
      dispatch?: boolean;
      safeExport?: { findings?: string[] };
    };
    expect(summary.reason).toBe('safe-export-scan-failed');
    expect(summary.dispatch).toBe(false);
    expect(summary.safeExport?.findings).toEqual(['raw_whatsapp_user_or_group_jid']);
  });

  it('uses an explicit child-process environment allowlist', () => {
    const childEnv = buildChildEnv(
      {
        HOME: '/home/q',
        PATH: '/usr/bin',
        SECRET_TOKEN: 'must-not-leak',
      },
      { OCW_TIMEOUT_SECS: '1200' },
    );

    expect(childEnv).toEqual({
      HOME: '/home/q',
      PATH: '/usr/bin',
      OCW_TIMEOUT_SECS: '1200',
    });
  });
});

// --- QR-022 dispatch burst lock ---------------------------------------------

const SCRIPT_PATH = path.join(process.cwd(), 'scripts', 'qregistry-loop.ts');

function writeExecutable(file: string, body: string): void {
  writeFileSync(file, body, 'utf8');
  chmodSync(file, 0o755);
}

const ACTIONABLE_ENTRY = JSON.stringify({
  schema_version: 1,
  id: 'QR-777',
  kind: 'debt',
  title: 'Dispatch burst serialization',
  severity: 'high',
  disposition: 'under-review',
  files: ['does/not/exist.ts'],
});

const CHECKER_OK = 'import sys\nprint("checker ok")\nsys.exit(0)\n';
const SAFE_EXPORT_OK = [
  'import json, sys',
  'out = sys.argv[sys.argv.index("--out") + 1]',
  'data = {"artifact_type":"qregistry.safe_export.v0","source_register":"qregistry.ndjson","source_rows":1,"entries":[{"id":"QR-777","title":"safe"}]}',
  'open(out, "w").write(json.dumps(data) + "\\n")',
  'print("SAFE_EXPORT rows=1 out=" + out)',
].join('\n');

/** Builds a self-contained qregistry fixture (repo + checker + exporter). */
function makeDispatchFixture(prefix: string): {
  base: string;
  repo: string;
  memRoot: string;
  lockPath: string;
  checker: string;
  exporter: string;
} {
  const base = mkdtempSync(path.join(tmpdir(), prefix));
  const repo = path.join(base, 'repo');
  const memRoot = path.join(base, 'memroot');
  mkdirSync(repo, { recursive: true });
  mkdirSync(memRoot, { recursive: true });
  writeFileSync(path.join(repo, 'qregistry.ndjson'), `${ACTIONABLE_ENTRY}\n`, 'utf8');
  const checker = path.join(base, 'checker.py');
  const exporter = path.join(base, 'safe-export.py');
  writeFileSync(checker, CHECKER_OK, 'utf8');
  writeFileSync(exporter, SAFE_EXPORT_OK, 'utf8');
  return {
    base,
    repo,
    memRoot,
    lockPath: path.join(memRoot, '.qregistry-dispatch.lock'),
    checker,
    exporter,
  };
}

function waitForFile(target: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const poll = () => {
      if (existsSync(target)) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(poll, 20);
    };
    poll();
  });
}

function readSummary(stateDir: string): Record<string, unknown> {
  const runName = readFileSync(path.join(stateDir, 'last-run.txt'), 'utf8').trim();
  return JSON.parse(
    readFileSync(path.join(stateDir, 'runs', runName, 'summary.json'), 'utf8'),
  ) as Record<string, unknown>;
}

describe('qregistry dispatch burst lock (withDispatchLock)', () => {
  it('skips (dispatch-lock-contended) when a live holder owns the lock, without running fn', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qr-dispatch-lock-'));
    const lockPath = path.join(dir, '.qregistry-dispatch.lock');
    const held = acquireProcessLock(lockPath); // held by this (live) test process
    try {
      let ran = false;
      const result = withDispatchLock(lockPath, { timeoutMs: 40, pollMs: 5 }, () => {
        ran = true;
        return 'entered';
      });
      expect(result).toEqual({ ran: false, reason: 'dispatch-lock-contended' });
      expect(ran).toBe(false);
    } finally {
      releaseProcessLock(held);
    }
  });

  it('reclaims a same-boot stale lock left by a dead holder and runs fn', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qr-dispatch-stale-'));
    const lockPath = path.join(dir, '.qregistry-dispatch.lock');
    // A genuinely dead pid: spawn+reap a child, then reuse its now-free pid.
    const reaped = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    const deadPid = reaped.pid!;
    // Payload with no bootId -> acquireProcessLock treats it as same-boot stale
    // (fails closed) rather than reclaiming it itself.
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: deadPid, token: 'dead-holder', startedAt: new Date().toISOString() }),
      { mode: 0o600 },
    );

    let ran = false;
    const result = withDispatchLock(lockPath, { timeoutMs: 1_000, pollMs: 5 }, () => {
      ran = true;
      return 42;
    });

    expect(result).toEqual({ ran: true, value: 42 });
    expect(ran).toBe(true);
    // Released in finally -> no lock file remains (AC2).
    expect(existsSync(lockPath)).toBe(false);
  });

  it('releases the lock even when fn throws (try/finally)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qr-dispatch-throw-'));
    const lockPath = path.join(dir, '.qregistry-dispatch.lock');
    expect(() =>
      withDispatchLock(lockPath, { timeoutMs: 1_000, pollMs: 5 }, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('keys the lock on the stable memory-mcp root, never a per-job hash16(cwd) namespace', () => {
    expect(dispatchLockPath({ OPENCODE_MEMORY_MCP_ROOT: '/tmp/mroot' })).toBe(
      '/tmp/mroot/.qregistry-dispatch.lock',
    );
    const fakeHome = path.join(tmpdir(), 'qr-fake-home');
    expect(dispatchLockPath({ HOME: fakeHome })).toBe(
      path.join(fakeHome, '.local', 'share', 'opencode', 'memory-mcp', '.qregistry-dispatch.lock'),
    );
    // AC7(b): not derived from a 16-hex per-job namespace.
    expect(dispatchLockPath({ OPENCODE_MEMORY_MCP_ROOT: '/tmp/mroot' })).not.toMatch(/[0-9a-f]{16}/);
  });
});

describe('qregistry-loop dispatch serialization', () => {
  it('does not enter the dispatch critical section while another holder owns the stable dispatch lock', () => {
    // Serialization proof (single process, deterministic via the lock's observable
    // state): a foreign holder owns the STABLE dispatch lock; run() uses its own
    // default --state-dir so acquireRunLock is uncontended, yet run() must NOT
    // dispatch. Falsifier: remove the withDispatchLock wrap -> run() ignores the
    // held lock, invokes ocw, summary.dispatch === true -> this test goes red.
    const fx = makeDispatchFixture('qr-dispatch-serialize-');
    const bin = path.join(fx.base, 'bin');
    mkdirSync(bin, { recursive: true });
    const ocwMarker = path.join(fx.base, 'ocw-invoked');
    writeExecutable(path.join(bin, 'ocw'), `#!/bin/sh\necho invoked > "${ocwMarker}"\nexit 0\n`);
    writeExecutable(path.join(bin, 'ocw-health'), '#!/bin/sh\nexit 0\n');

    const held = acquireProcessLock(fx.lockPath); // foreign live holder
    let status: number;
    try {
      status = run(
        ['--repo', fx.repo, '--checker', fx.checker, '--safe-exporter', fx.exporter, '--force', '--max-workers', '1'],
        {
          ...process.env,
          PATH: `${bin}:/usr/bin:/bin`,
          PYTHON: 'python3',
          OPENCODE_MEMORY_MCP_ROOT: fx.memRoot,
          QREGISTRY_DISPATCH_LOCK_TIMEOUT_MS: '50',
          QREGISTRY_DISPATCH_LOCK_POLL_MS: '10',
        },
      );
    } finally {
      releaseProcessLock(held);
    }

    expect(status).toBe(0);
    const summary = readSummary(path.join(fx.repo, 'raw', 'qregistry-loop'));
    expect(summary.reason).toBe('dispatch-lock-contended');
    expect(summary.dispatch).toBe(false);
    // The critical section was never entered -> ocw was never invoked.
    expect(existsSync(ocwMarker)).toBe(false);
  });

  it('serializes two dispatch bursts with DIFFERENT --state-dir on the same host lock (what acquireRunLock cannot)', async () => {
    const fx = makeDispatchFixture('qr-dispatch-crossproc-');
    const binA = path.join(fx.base, 'binA');
    const binB = path.join(fx.base, 'binB');
    mkdirSync(binA, { recursive: true });
    mkdirSync(binB, { recursive: true });
    const aHolding = path.join(fx.base, 'A-holding');
    const releaseA = path.join(fx.base, 'release-A');
    const bEntered = path.join(fx.base, 'B-entered-critical');

    // Run A's ocw stub: announce it is inside the critical section (holding the
    // dispatch lock), then block until the test releases it.
    writeExecutable(
      path.join(binA, 'ocw'),
      `#!/bin/sh\necho holding > "${aHolding}"\nwhile [ ! -e "${releaseA}" ]; do sleep 0.02; done\necho "worker A" \nexit 0\n`,
    );
    writeExecutable(path.join(binA, 'ocw-health'), '#!/bin/sh\nexit 0\n');
    // Run B's ocw stub: entering it AT ALL is the violation we assert against.
    writeExecutable(path.join(binB, 'ocw'), `#!/bin/sh\necho entered > "${bEntered}"\nexit 0\n`);
    writeExecutable(path.join(binB, 'ocw-health'), '#!/bin/sh\nexit 0\n');

    const stateA = path.join(fx.base, 'stateA');
    const stateB = path.join(fx.base, 'stateB');

    const baseEnv = {
      ...process.env,
      PYTHON: 'python3',
      OPENCODE_MEMORY_MCP_ROOT: fx.memRoot,
    };

    const childArgs = (stateDir: string): string[] => [
      '--experimental-strip-types',
      '--no-warnings',
      SCRIPT_PATH,
      '--repo',
      fx.repo,
      '--state-dir',
      stateDir,
      '--checker',
      fx.checker,
      '--safe-exporter',
      fx.exporter,
      '--force',
      '--max-workers',
      '1',
    ];

    // Launch A and wait until it is provably holding the dispatch lock.
    const childA = spawn(process.execPath, childArgs(stateA), {
      env: { ...baseEnv, PATH: `${binA}:/usr/bin:/bin`, QREGISTRY_DISPATCH_LOCK_TIMEOUT_MS: '60000' },
      stdio: 'ignore',
    });
    const aExit = new Promise<number>((resolve) => childA.on('close', (code) => resolve(code ?? -1)));

    try {
      const ready = await waitForFile(aHolding, 8_000);
      expect(ready).toBe(true);

      // B contends for the SAME dispatch lock but with a DIFFERENT --state-dir,
      // so acquireRunLock does not serialize them. B must skip, never entering
      // its critical section.
      const bResult = spawnSync(process.execPath, childArgs(stateB), {
        env: {
          ...baseEnv,
          PATH: `${binB}:/usr/bin:/bin`,
          QREGISTRY_DISPATCH_LOCK_TIMEOUT_MS: '400',
          QREGISTRY_DISPATCH_LOCK_POLL_MS: '20',
        },
        stdio: 'ignore',
      });

      expect(bResult.status).toBe(0);
      expect(existsSync(bEntered)).toBe(false); // B never entered the critical section
      const bSummary = readSummary(stateB);
      expect(bSummary.reason).toBe('dispatch-lock-contended');
      expect(bSummary.dispatch).toBe(false);
    } finally {
      writeFileSync(releaseA, 'go', 'utf8'); // unblock A on every path
    }

    const aCode = await aExit;
    expect(aCode).toBe(0);
    const aSummary = readSummary(stateA);
    expect(aSummary.dispatch).toBe(true); // A completed its dispatch
  }, 25_000);
});

// --- QR-022/#1978 pin: worker memory-mcp root === dispatch lock root -------
//
// The dispatch lock and the worker's memory-mcp plugin used to agree on a
// root only by both independently defaulting the same way; nothing pinned
// them together. These tests prove resolveMemoryMcpRoot is the single source
// both draw from: (1) it is allowlisted for passthrough, and (2) the ocw
// child process dispatchWorker spawns actually receives it, for both an
// explicit override and the bare-HOME default.

describe('qregistry worker env pins to the dispatch-lock memory-mcp root', () => {
  it('allowlists OPENCODE_MEMORY_MCP_ROOT for child-process passthrough', () => {
    const childEnv = buildChildEnv(
      { HOME: '/home/q', PATH: '/usr/bin', OPENCODE_MEMORY_MCP_ROOT: '/tmp/mroot' },
      {},
    );
    expect(childEnv.OPENCODE_MEMORY_MCP_ROOT).toBe('/tmp/mroot');
  });

  it('pins the dispatched ocw worker to the same root dispatchLockPath resolves (explicit override)', () => {
    const fx = makeDispatchFixture('qr-dispatch-envpin-explicit-');
    const bin = path.join(fx.base, 'bin');
    mkdirSync(bin, { recursive: true });
    const capturedRoot = path.join(fx.base, 'ocw-memory-root.txt');
    // Falsifier: if dispatchWorker stopped setting OPENCODE_MEMORY_MCP_ROOT
    // (or set a different value than the lock's root), this file would be
    // empty/absent or mismatch fx.memRoot, and the assertion below goes red.
    writeExecutable(
      path.join(bin, 'ocw'),
      `#!/bin/sh\nprintf '%s' "$OPENCODE_MEMORY_MCP_ROOT" > "${capturedRoot}"\nexit 0\n`,
    );
    writeExecutable(path.join(bin, 'ocw-health'), '#!/bin/sh\nexit 0\n');

    const env = {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      PYTHON: 'python3',
      OPENCODE_MEMORY_MCP_ROOT: fx.memRoot,
    };
    const status = run(
      ['--repo', fx.repo, '--checker', fx.checker, '--safe-exporter', fx.exporter, '--force', '--max-workers', '1'],
      env,
    );

    expect(status).toBe(0);
    const lockRoot = path.dirname(dispatchLockPath(env));
    expect(lockRoot).toBe(fx.memRoot); // sanity: fixture's lock root is the override
    expect(lockRoot).toBe(resolveMemoryMcpRoot(env));
    expect(existsSync(capturedRoot)).toBe(true);
    expect(readFileSync(capturedRoot, 'utf8')).toBe(lockRoot);
  });

  it('pins the dispatched ocw worker to the same root dispatchLockPath resolves (default, HOME-derived)', () => {
    const fx = makeDispatchFixture('qr-dispatch-envpin-default-');
    const bin = path.join(fx.base, 'bin');
    mkdirSync(bin, { recursive: true });
    const capturedRoot = path.join(fx.base, 'ocw-memory-root.txt');
    writeExecutable(
      path.join(bin, 'ocw'),
      `#!/bin/sh\nprintf '%s' "$OPENCODE_MEMORY_MCP_ROOT" > "${capturedRoot}"\nexit 0\n`,
    );
    writeExecutable(path.join(bin, 'ocw-health'), '#!/bin/sh\nexit 0\n');

    const fakeHome = path.join(fx.base, 'fake-home');
    mkdirSync(fakeHome, { recursive: true });
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: fakeHome, PATH: `${bin}:/usr/bin:/bin`, PYTHON: 'python3' };
    delete env.OPENCODE_MEMORY_MCP_ROOT; // force the HOME-derived default path

    const status = run(
      ['--repo', fx.repo, '--checker', fx.checker, '--safe-exporter', fx.exporter, '--force', '--max-workers', '1'],
      env,
    );

    expect(status).toBe(0);
    const lockRoot = path.dirname(dispatchLockPath(env));
    expect(lockRoot).toBe(path.join(fakeHome, '.local', 'share', 'opencode', 'memory-mcp'));
    expect(lockRoot).toBe(resolveMemoryMcpRoot(env));
    expect(existsSync(capturedRoot)).toBe(true);
    expect(readFileSync(capturedRoot, 'utf8')).toBe(lockRoot);
  });
});
