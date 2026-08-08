/**
 * Tests for `deploy/setup.sh --reconcile` (fleet/watchdog service reconcile).
 *
 * The reconcile mode compares the installed launchd plists (Darwin) / systemd
 * units (Linux) against the setup-managed expected set and REPORTS missing
 * services and orphan candidates, printing remediation commands without ever
 * executing launchctl/systemctl mutations (preserving the launchd-mutation
 * invariant asserted in setup-platform.test.ts). `--check` makes the exit code
 * non-zero when drift is found (CI/scripting); without `--check` the report
 * always exits 0 (operator-review mode).
 *
 * Discriminating tests (T1-T5) execute the reconcile against synthetic
 * filesystem state so that removing a detection branch fails the test.
 */
import { afterEach, describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const setupSource = fs.readFileSync(path.join(repoRoot, 'deploy', 'setup.sh'), 'utf8');

// The full setup-managed expected set. MUST mirror `RECONCILE_SYSTEMD_EXPECTED`
// in deploy/setup.sh (7 named cp targets + the 11-entry BOT_ERRORS_SYSTEMD_UNITS
// array). The structural drift-guard test below asserts this stays in sync.
const reconcileSystemdNamed = [
  'whatsoup@.service',
  'whatsoup-fleet.service',
  'whatsoup-heal-notify@.service',
  'whatsoup-reply-guarantee.service',
  'whatsoup-reply-guarantee.timer',
  'harness-maintenance.service',
  'harness-maintenance.timer',
];
const botErrorsSystemdUnits = [
  'bot-errors-dispatcher.service',
  'bot-errors-q-loop.service',
  'bot-errors-collector.service',
  'bot-errors-deadman.service',
  'bot-errors-deadman.timer',
  'bot-errors-health-check.service',
  'bot-errors-health-check.timer',
  'bot-errors-heartbeat-watchdog.service',
  'bot-errors-heartbeat-watchdog.timer',
  'bot-errors-runtime-staleness.service',
  'bot-errors-runtime-staleness.timer',
];
const reconcileSystemdExpected = [...reconcileSystemdNamed, ...botErrorsSystemdUnits];
const launchdTimerLabels = [
  'com.whatsoup.harness-maintenance',
  'com.whatsoup.reply-guarantee',
];

const tempRoots: string[] = [];

function makeTempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function writeExecutable(dir: string, name: string, body: string): void {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, 'utf8');
  fs.chmodSync(file, 0o755);
}

/** uname shim: reports the given platform for `-s`, arm64 for `-m`. */
function writeUnameShim(dir: string, platform: 'Linux' | 'Darwin'): void {
  writeExecutable(dir, 'uname', [
    '#!/usr/bin/env bash',
    'case "${1:-}" in',
    `  -s) printf "%s\\n" "${platform}";;`,
    '  -m) printf "%s\\n" "arm64";;',
    `  *) printf "%s\\n" "${platform}";;`,
    'esac',
    '',
  ].join('\n'));
}

function runReconcile(
  home: string,
  shimDir: string | undefined,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, ...extraEnv };
  if (shimDir) env.PATH = `${shimDir}:${env.PATH ?? ''}`;
  return spawnSync('bash', ['deploy/setup.sh', ...args], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('deploy/setup.sh --reconcile structure', () => {
  it('documents --reconcile in the usage block and dispatches the flag', () => {
    const startIdx = setupSource.indexOf('Usage: deploy/setup.sh');
    expect(startIdx, 'usage block not found').toBeGreaterThan(-1);
    // Search for the heredoc terminator AFTER the usage start (mirrors
    // sliceBetween in setup-platform.test.ts so an earlier 'USAGE' token in
    // the `cat <<'USAGE'` line does not produce an empty slice).
    const endIdx = setupSource.indexOf('USAGE', startIdx);
    const usageBlock = setupSource.slice(startIdx, endIdx);
    expect(usageBlock).toContain('--reconcile');
    expect(usageBlock).toContain('never executes them');
    expect(usageBlock).toContain('operator');
    // The dispatch handler must exist.
    expect(setupSource).toContain('"--reconcile"');
  });

  it('never executes launchctl mutations — every launchctl mutation line is echoed/commented', () => {
    // Mirrors the setup-platform.test.ts:815 invariant, scoped here to catch a
    // reconcile regression even if the canonical test is moved/refactored.
    const mutation = /launchctl\s+(bootstrap|bootout|load|unload|enable|disable|kickstart|start|stop)\b/;
    for (const line of setupSource.split('\n')) {
      if (mutation.test(line)) {
        expect(
          /^\s*(echo|#)/.test(line),
          `launchctl mutation outside echo/comment: ${JSON.stringify(line)}`,
        ).toBe(true);
      }
    }
  });

  it('the reconcile expected-set mirrors the step-4 install surface (drift guard)', () => {
    // The named 7-unit array declaration must enumerate exactly the cp targets.
    const startMarker = 'RECONCILE_SYSTEMD_EXPECTED=(';
    const startIdx = setupSource.indexOf(startMarker);
    expect(startIdx, 'RECONCILE_SYSTEMD_EXPECTED array not found').toBeGreaterThan(-1);
    const namedBlock = setupSource.slice(startIdx, setupSource.indexOf(')', startIdx));
    for (const unit of reconcileSystemdNamed) {
      expect(namedBlock, `reconcile expected-set missing named unit ${unit}`).toContain(`"${unit}"`);
    }
    // The reconcile set must REUSE BOT_ERRORS_SYSTEMD_UNITS rather than
    // duplicate the 11 bot-errors units (single source of truth). The append
    // lives on its own line after the named array close.
    expect(setupSource).toContain('RECONCILE_SYSTEMD_EXPECTED+=("${BOT_ERRORS_SYSTEMD_UNITS[@]}")');
    for (const unit of botErrorsSystemdUnits) {
      expect(setupSource, `BOT_ERRORS_SYSTEMD_UNITS missing ${unit}`).toContain(`"${unit}"`);
    }
  });

  it('reconcile uses filesystem discovery, not launchctl list / systemctl list-units', () => {
    const reconcileBlock = setupSource.slice(
      setupSource.indexOf('"--reconcile"'),
      setupSource.indexOf('if [ "${1:-}" = "-h" ]'),
    );
    expect(reconcileBlock).toContain('nullglob');
    expect(reconcileBlock).toContain('com.whatsoup.*.plist');
    expect(reconcileBlock).toContain('$SYSTEMD_DIR"/whatsoup*.service');
    // The per-instance @<name> exclusion keeps operator-managed instances out.
    expect(reconcileBlock).toContain('*@[^.]*.service');
    expect(reconcileBlock).toContain('*@[^.]*.timer');
  });
});

describe('deploy/setup.sh --reconcile systemd path (Linux)', () => {
  function seedSystemdDir(home: string, units: string[]): string {
    const dir = path.join(home, '.config', 'systemd', 'user');
    fs.mkdirSync(dir, { recursive: true });
    for (const u of units) fs.writeFileSync(path.join(dir, u), '');
    return dir;
  }

  it('T1 [DISCRIMINATING]: a missing expected unit is reported and --check exits non-zero', () => {
    const home = makeTempRoot('whatsoup-reconcile-');
    const shimDir = makeTempRoot('whatsoup-reconcile-shim-');
    writeUnameShim(shimDir, 'Linux');
    // Install the full expected set, then remove one so it is genuinely missing.
    const missingUnit = 'whatsoup-fleet.service';
    seedSystemdDir(home, reconcileSystemdExpected.filter((u) => u !== missingUnit));

    const result = runReconcile(home, shimDir, ['--reconcile', '--check']);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
    expect(result.stdout).toContain(`missing: ${missingUnit} not installed`);
    // No false-positive orphan on the clean expected set.
    expect(result.stdout).not.toMatch(/^  orphan:/m);
    expect(result.stdout).toContain('Reconcile complete');
  });

  it('T3 [DISCRIMINATING]: an exactly-clean expected set exits 0 with no remediation', () => {
    const home = makeTempRoot('whatsoup-reconcile-');
    const shimDir = makeTempRoot('whatsoup-reconcile-shim-');
    writeUnameShim(shimDir, 'Linux');
    seedSystemdDir(home, reconcileSystemdExpected);

    const result = runReconcile(home, shimDir, ['--reconcile', '--check']);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('Reconcile clean');
    expect(result.stdout).not.toMatch(/^  missing:/m);
    expect(result.stdout).not.toMatch(/^  orphan:/m);
    // No destructive commands printed when clean.
    expect(result.stdout).not.toContain('systemctl --user disable --now');
  });

  it('T4 [DISCRIMINATING]: an orphan systemd unit is reported with a printed disable command', () => {
    const home = makeTempRoot('whatsoup-reconcile-');
    const shimDir = makeTempRoot('whatsoup-reconcile-shim-');
    writeUnameShim(shimDir, 'Linux');
    const orphan = 'bot-errors-old-removed.service';
    seedSystemdDir(home, [...reconcileSystemdExpected, orphan]);

    const result = runReconcile(home, shimDir, ['--reconcile', '--check']);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
    expect(result.stdout).toContain(`orphan: ${orphan} installed but not in the expected set`);
    expect(result.stdout).toContain(`systemctl --user disable --now ${orphan}`);
    // The disable command is printed (echoed), never executed by setup.sh.
    expect(result.stdout).toContain('operator step, never auto-run');
  });

  it('T1-instance-guard: per-instance units are excluded from reconcile (not flagged as orphans)', () => {
    const home = makeTempRoot('whatsoup-reconcile-');
    const shimDir = makeTempRoot('whatsoup-reconcile-shim-');
    writeUnameShim(shimDir, 'Linux');
    // Fleet-generated instance units — operator-managed, must stay invisible.
    // Built via .join('@') (matching setup-platform.test.ts) so the literal
    // <name>@<instance>.service string never appears in source and the
    // personal-email repo-hygiene guard does not false-positive on it.
    const instanceUnits = [
      ['whatsoup', 'primary-line.service'].join('@'),
      ['whatsoup', 'operator-agent.service'].join('@'),
      ['whatsoup-heal-notify', 'alpha.service'].join('@'),
    ];
    seedSystemdDir(home, [...reconcileSystemdExpected, ...instanceUnits]);

    const result = runReconcile(home, shimDir, ['--reconcile', '--check']);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('Reconcile clean');
    for (const inst of instanceUnits) {
      expect(result.stdout, `${inst} must not be flagged`).not.toContain(inst);
    }
  });

  it('T5 [DISCRIMINATING]: reconcile is idempotent — repeated runs are identical and side-effect-free', () => {
    const home = makeTempRoot('whatsoup-reconcile-');
    const shimDir = makeTempRoot('whatsoup-reconcile-shim-');
    writeUnameShim(shimDir, 'Linux');
    seedSystemdDir(home, reconcileSystemdExpected);

    const first = runReconcile(home, shimDir, ['--reconcile', '--check']);
    const dirListingBefore = fs.readdirSync(path.join(home, '.config', 'systemd', 'user')).sort();
    const second = runReconcile(home, shimDir, ['--reconcile', '--check']);
    const dirListingAfter = fs.readdirSync(path.join(home, '.config', 'systemd', 'user')).sort();

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(second.stdout).toBe(first.stdout);
    expect(dirListingAfter).toEqual(dirListingBefore);
  });

  it('without --check, a drifted state still reports but exits 0 (operator-review mode)', () => {
    const home = makeTempRoot('whatsoup-reconcile-');
    const shimDir = makeTempRoot('whatsoup-reconcile-shim-');
    writeUnameShim(shimDir, 'Linux');
    const orphan = 'bot-errors-old-removed.service';
    seedSystemdDir(home, [...reconcileSystemdExpected, orphan]);

    const result = runReconcile(home, shimDir, ['--reconcile']);

    // Report present, but exit 0 (no --check → operator reviews).
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(`orphan: ${orphan}`);
    expect(result.stdout).toContain('printed, not executed');
  });

  it('rejects an unknown trailing flag after --reconcile', () => {
    const home = makeTempRoot('whatsoup-reconcile-');
    const shimDir = makeTempRoot('whatsoup-reconcile-shim-');
    writeUnameShim(shimDir, 'Linux');

    const result = runReconcile(home, shimDir, ['--reconcile', '--bogus']);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--reconcile accepts at most');
  });
});

describe('deploy/setup.sh --reconcile launchd path (Darwin)', () => {
  function seedLaunchAgents(home: string, labels: string[]): string {
    const dir = path.join(home, 'Library', 'LaunchAgents');
    fs.mkdirSync(dir, { recursive: true });
    for (const label of labels) fs.writeFileSync(path.join(dir, `${label}.plist`), '');
    return dir;
  }

  it('T2 [DISCRIMINATING]: an orphan plist is reported with a printed (literal $(id -u)) bootout command', () => {
    const home = makeTempRoot('whatsoup-reconcile-darwin-');
    const shimDir = makeTempRoot('whatsoup-reconcile-darwin-shim-');
    writeUnameShim(shimDir, 'Darwin');
    const orphan = 'com.whatsoup.old-removed-service';
    seedLaunchAgents(home, [...launchdTimerLabels, orphan]);

    const result = runReconcile(home, shimDir, ['--reconcile', '--check']);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
    expect(result.stdout).toContain(`orphan candidate: ${orphan}.plist installed`);
    // $(id -u) is printed LITERALLY (the script never expands/executes it).
    expect(result.stdout).toContain(`launchctl bootout gui/$(id -u)/${orphan}`);
    expect(result.stdout).toContain('operator: verify this is stale');
  });

  it('T-launchd-missing [DISCRIMINATING]: a missing expected timer is reported', () => {
    const home = makeTempRoot('whatsoup-reconcile-darwin-');
    const shimDir = makeTempRoot('whatsoup-reconcile-darwin-shim-');
    writeUnameShim(shimDir, 'Darwin');
    const missing = 'com.whatsoup.reply-guarantee';
    seedLaunchAgents(home, launchdTimerLabels.filter((l) => l !== missing));

    const result = runReconcile(home, shimDir, ['--reconcile', '--check']);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
    expect(result.stdout).toContain(`missing: ${missing}.plist not installed`);
    expect(result.stdout).not.toMatch(/^  orphan candidate:/m);
  });

  it('T-launchd-clean [DISCRIMINATING]: exactly the expected timer set exits 0 with no bootout', () => {
    const home = makeTempRoot('whatsoup-reconcile-darwin-');
    const shimDir = makeTempRoot('whatsoup-reconcile-darwin-shim-');
    writeUnameShim(shimDir, 'Darwin');
    seedLaunchAgents(home, launchdTimerLabels);

    const result = runReconcile(home, shimDir, ['--reconcile', '--check']);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('Reconcile clean');
    expect(result.stdout).not.toContain('launchctl bootout');
    expect(result.stdout).not.toMatch(/^  orphan candidate:/m);
  });
});
