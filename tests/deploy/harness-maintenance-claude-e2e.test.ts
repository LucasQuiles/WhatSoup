import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Executes the real maintenance script under /bin/bash in a temporary HOME.
//
// Native fixture: a tiny C program compiled once per run. It is a genuine
// Mach-O/ELF executable, so the static classifier accepts it as native only
// through its real magic bytes, not through a shebang. At run time it execs
// /bin/sh on the behaviour script named by HM_FIXTURE_SCRIPT, passing its own
// argv[0] first, so each test controls what "install" and "--version" do. A
// missing C compiler fails the suite loudly instead of skipping it.

const REPO = process.cwd();
const SCRIPT = path.join(REPO, 'deploy/scripts/harness-maintenance.sh');
const OLD = '2.1.280';
const TARGET = '2.1.282';
const YOUNG = '2.1.283';
const DAY_MS = 86_400_000;
const RUN_TIMEOUT_MS = 90_000;

const FIXTURE_C = [
  '#include <stdlib.h>',
  '#include <unistd.h>',
  'int main(int argc, char **argv) {',
  '  const char *script = getenv("HM_FIXTURE_SCRIPT");',
  '  if (script == NULL) return 97;',
  '  char **args = calloc((size_t)argc + 3, sizeof(char *));',
  '  if (args == NULL) return 98;',
  '  args[0] = "/bin/sh";',
  '  args[1] = (char *)script;',
  '  for (int i = 0; i < argc; i++) args[i + 2] = argv[i];',
  '  execv("/bin/sh", args);',
  '  return 99;',
  '}',
  '',
].join('\n');

// $1 is the fixture's own argv[0]. Modes come from the file named by HM_FIXTURE_MODE.
const FIXTURE_BEHAVIOUR = [
  '#!/bin/sh',
  'self="$1"; shift',
  'printf \'%s %s\\n\' "${self##*/}" "$*" >> "$HM_FIXTURE_LOG"',
  'case "$1" in',
  '  --version)',
  '    if [ -f "$HM_FIXTURE_MODE" ] && [ "$(cat "$HM_FIXTURE_MODE")" = interlope ]; then',
  '      # Another writer moves the launcher while the postcheck runs.',
  '      cp "$self" "$HOME/.local/share/claude/versions/9.9.9" && ln -sfn "$HOME/.local/share/claude/versions/9.9.9" "$HOME/.local/bin/claude"',
  '      exit 1',
  '    fi',
  '    printf \'%s (agent CLI)\\n\' "${HM_FIXTURE_VERSION_TEXT:-${self##*/}}"',
  '    exit "${HM_FIXTURE_VERSION_RC:-0}" ;;',
  '  install)',
  '    mode=ok; [ -f "$HM_FIXTURE_MODE" ] && mode="$(cat "$HM_FIXTURE_MODE")"',
  '    dir="$HOME/.local/share/claude/versions"; link="$HOME/.local/bin/claude"',
  '    case "$mode" in',
  '      fail) exit 1 ;;',
  '      noop) exit 0 ;;',
  '      hang) sleep 60; exit 0 ;;',
  '    esac',
  '    cp "$self" "$dir/$2" && chmod 755 "$dir/$2" && ln -sfn "$dir/$2" "$link" || exit 90',
  '    case "$mode" in',
  '      partial) exit 1 ;;',
  '      prune) rm -f "$self"; exit 1 ;;',
  '    esac',
  '    exit 0 ;;',
  'esac',
  'exit 0',
  '',
].join('\n');

const FAKE_NPM = [
  '#!/bin/sh',
  'printf \'%s\\n\' "$*" >> "$HM_NPM_LOG"',
  'case "$*" in',
  '  --version) echo 10.9.0 ;;',
  '  "config get min-release-age") echo 7 ;;',
  '  "view @anthropic-ai/claude-code time --json") [ -n "${HM_NPM_HANG:-}" ] && sleep 30; cat "$HM_NPM_TIME" ;;',
  '  *" time --json") echo "{}" ;;',
  '  "view "*" version") exit 1 ;;',
  'esac',
  'exit 0',
  '',
].join('\n');

const FAKE_ALERT = ['#!/bin/sh', 'printf \'%s\\n\' "$*" >> "$HM_ALERT_LOG"', 'exit 0', ''].join('\n');

const FAKE_SYSTEMCTL = [
  '#!/bin/sh',
  'd="$HM_SYSTEMD_DIR"',
  'printf \'%s\\n\' "$*" >> "$d/argv.log"',
  '[ "$1" = "--user" ] && shift',
  'case "$1" in',
  '  list-units) cat "$d/units" 2>/dev/null; exit "$(cat "$d/list.rc" 2>/dev/null || echo 0)" ;;',
  '  show-environment) cat "$d/manager.env" 2>/dev/null; exit 0 ;;',
  '  show) for last; do :; done; cat "$d/$last.show" 2>/dev/null; exit 0 ;;',
  '  is-active) echo inactive; exit 3 ;;',
  'esac',
  'exit 0',
  '',
].join('\n');

let fixtureRoot = '';
let nativeFixture = '';
const homes: string[] = [];

beforeAll(() => {
  fixtureRoot = mkdtempSync(path.join(tmpdir(), 'hm-native-'));
  const source = path.join(fixtureRoot, 'fixture.c');
  nativeFixture = path.join(fixtureRoot, 'native-fixture');
  writeFileSync(source, FIXTURE_C);
  const cc = spawnSync('cc', ['-O0', '-o', nativeFixture, source], { encoding: 'utf8', timeout: 60_000 });
  if (cc.error || cc.status !== 0) {
    throw new Error(`cannot build the native test fixture with cc: ${cc.error?.message ?? cc.stderr}`);
  }
});

afterAll(() => {
  for (const dir of [fixtureRoot, ...homes]) if (dir) rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  home: string;
  fakeBin: string;
  versions: string;
  launcher: string;
  fixtureLog: string;
  npmLog: string;
  alertLog: string;
  modeFile: string;
  systemdDir: string;
  env: Record<string, string>;
}

function writeExec(file: string, text: string): void {
  writeFileSync(file, text);
  chmodSync(file, 0o755);
}

function installNative(h: Harness, version: string): string {
  const file = path.join(h.versions, version);
  copyFileSync(nativeFixture, file);
  chmodSync(file, 0o755);
  return file;
}

function makeHarness(): Harness {
  const home = mkdtempSync(path.join(tmpdir(), 'hm-e2e-'));
  homes.push(home);
  const fakeBin = path.join(home, 'fakebin');
  const versions = path.join(home, '.local/share/claude/versions');
  const localBin = path.join(home, '.local/bin');
  const systemdDir = path.join(home, 'systemd-fixture');
  for (const dir of [fakeBin, versions, localBin, systemdDir, path.join(home, 'tmp'), path.join(home, 'Library/LaunchAgents')]) {
    mkdirSync(dir, { recursive: true, mode: 0o755 });
  }
  const h: Harness = {
    home,
    fakeBin,
    versions,
    launcher: path.join(localBin, 'claude'),
    fixtureLog: path.join(home, 'fixture.log'),
    npmLog: path.join(home, 'npm.log'),
    alertLog: path.join(home, 'alert.log'),
    modeFile: path.join(home, 'fixture.mode'),
    systemdDir,
    env: {},
  };
  const behaviour = path.join(home, 'fixture-behaviour.sh');
  writeExec(behaviour, FIXTURE_BEHAVIOUR);
  writeExec(path.join(fakeBin, 'npm'), FAKE_NPM);
  writeExec(path.join(fakeBin, 'alert'), FAKE_ALERT);
  writeExec(path.join(fakeBin, 'systemctl'), FAKE_SYSTEMCTL);
  installNative(h, OLD);
  symlinkSync(path.join(versions, OLD), h.launcher);

  const now = Date.now();
  const timeJson = path.join(home, 'npm-time.json');
  writeFileSync(timeJson, JSON.stringify({
    created: new Date(now - 400 * DAY_MS).toISOString(),
    modified: new Date(now - DAY_MS).toISOString(),
    [OLD]: new Date(now - 30 * DAY_MS).toISOString(),
    [TARGET]: new Date(now - 10 * DAY_MS).toISOString(),
    [YOUNG]: new Date(now - DAY_MS).toISOString(),
  }));

  h.env = {
    PATH: `${fakeBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: home,
    TMPDIR: path.join(home, 'tmp'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    WHATSOUP_NODE_BIN: process.execPath,
    WHATSOUP_CODEX_NODE_BIN_DIR: fakeBin,
    WHATSOUP_ALERT_BIN: path.join(fakeBin, 'alert'),
    WHATSOUP_HARNESS_NPM_GLOBAL_PREFIX: path.join(home, 'npm-global'),
    WHATSOUP_HARNESS_SERVICE_MANAGER: 'launchd',
    HM_FIXTURE_SCRIPT: behaviour,
    HM_FIXTURE_LOG: h.fixtureLog,
    HM_FIXTURE_MODE: h.modeFile,
    HM_NPM_LOG: h.npmLog,
    HM_NPM_TIME: timeJson,
    HM_ALERT_LOG: h.alertLog,
    HM_SYSTEMD_DIR: systemdDir,
  };
  return h;
}

function xml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Writes a generated-style instance plist; `env` values of undefined are omitted. */
function writePlist(
  h: Harness,
  name: string,
  env: Record<string, string | undefined>,
  program: string[] = [path.join(h.home, '.local/bin/whatsoup'), name],
): void {
  const vars = Object.entries(env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`)
    .join('\n');
  writeFileSync(path.join(h.home, 'Library/LaunchAgents', `com.whatsoup.${name}.plist`), [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>com.whatsoup.${xml(name)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...program.map((arg) => `    <string>${xml(arg)}</string>`),
    '  </array>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    vars,
    '  </dict>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n'));
}

/** A plain instance: service PATH without any claude, the pinned node, no prepend. */
function plainInstance(h: Harness, name: string, extra: Record<string, string | undefined> = {}): void {
  writePlist(h, name, { PATH: '/usr/bin:/bin', WHATSOUP_NODE: process.execPath, ...extra });
}

/** A directory outside the launcher holding its own copy of the native fixture. */
function pinDir(h: Harness): string {
  const dir = path.join(h.home, 'pin/bin');
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  copyFileSync(nativeFixture, path.join(dir, 'claude'));
  chmodSync(path.join(dir, 'claude'), 0o755);
  return dir;
}

interface RunResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  state: { status: string; events: Array<Record<string, string>> } | null;
}

function run(h: Harness, args: string[] = [], extraEnv: Record<string, string> = {}): RunResult {
  const result = spawnSync('/bin/bash', [SCRIPT, ...args], {
    cwd: h.home,
    encoding: 'utf8',
    // spawnSync blocks the event loop, so vitest's own timeout cannot interrupt
    // a hung child: bound the child and hard-kill it on overrun.
    timeout: RUN_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    env: { ...h.env, ...extraEnv },
  });
  if (result.error) throw result.error;
  const stateFile = path.join(h.home, '.cache/whatsoup/harness-maintenance/state.json');
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    state: existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : null,
  };
}

function events(r: RunResult, component: string): Array<Record<string, string>> {
  return (r.state?.events ?? []).filter((event) => event.component === component);
}

function fixtureCalls(h: Harness): string[] {
  if (!existsSync(h.fixtureLog)) return [];
  // probe_tier2 still runs `claude plugin list` / `claude mcp list` from the job PATH;
  // that whole-script check-mode boundary is a later task, so it is excluded here.
  return readFileSync(h.fixtureLog, 'utf8').split('\n').filter((line) => line !== '' && !/^\S+ (plugin|mcp) list$/.test(line));
}

describe('harness-maintenance.sh agent CLI update, end to end', () => {
  it('baseline: the script runs to a final state in a temporary HOME', () => {
    const h = makeHarness();
    plainInstance(h, 'alpha');
    const started = Date.now();
    const r = run(h);
    const elapsed = Date.now() - started;
    expect(r.state, r.stderr).not.toBeNull();
    expect(elapsed).toBeLessThan(RUN_TIMEOUT_MS);
    expect(readlinkSync(h.launcher)).toContain('versions');
  }, RUN_TIMEOUT_MS + 10_000);
});

const T = RUN_TIMEOUT_MS + 10_000;
const onDarwin = process.platform === 'darwin';

/**
 * A plain instance under the systemd fake, so manager-independent behaviour runs on every
 * platform: manager PATH without any claude, the pinned node, no prepend.
 */
function portableInstance(h: Harness, name: string): void {
  writeFileSync(path.join(h.systemdDir, 'manager.env'), 'PATH=/usr/bin:/bin\n');
  systemdUnit(h, name, [`Environment=WHATSOUP_NODE=${process.execPath}`]);
  h.env.WHATSOUP_HARNESS_SERVICE_MANAGER = 'systemd';
}

function systemdUnit(h: Harness, name: string, show: string[]): void {
  const units = path.join(h.systemdDir, 'units');
  const prior = existsSync(units) ? readFileSync(units, 'utf8') : '';
  writeFileSync(units, `${prior}whatsoup@${name}.service loaded active running WhatSoup ${name}\n`);
  writeFileSync(path.join(h.systemdDir, `whatsoup@${name}.service.show`), `${show.join('\n')}\n`);
}

describe('per-instance service resolver (launchd)', () => {
  it.runIf(onDarwin)('resolves through the plist PATH plus the governed prepend, never the job PATH', () => {
    const h = makeHarness();
    const pin = pinDir(h);
    plainInstance(h, 'alpha', { WHATSOUP_PATH_PREPEND: pin });
    const r = run(h);
    const consumer = events(r, 'claude-consumer');
    expect(consumer).toHaveLength(1);
    expect(consumer[0]!.status).toBe('resolved');
    expect(consumer[0]!.message).toContain(`alpha via launchd: ${pin}/claude`);
    expect(fixtureCalls(h)).toEqual([]);
    expect(readlinkSync(h.launcher)).toBe(path.join(h.versions, OLD));
  }, T);

  it.runIf(onDarwin)('treats a plist without a PATH as unknown instead of borrowing the job PATH', () => {
    const h = makeHarness();
    writePlist(h, 'alpha', { WHATSOUP_NODE: process.execPath });
    const r = run(h);
    expect(events(r, 'claude-consumer').map((e) => e.status)).toEqual(['unknown']);
    expect(events(r, 'claude').at(-1)?.status).toBe('unknown');
    expect(events(r, 'claude').at(-1)?.message).toContain('alpha');
    expect(fixtureCalls(h)).toEqual([]);
  }, T);

  it.runIf(onDarwin)('installs through the shared launcher when every instance resolves it, without executing it first', () => {
    const h = makeHarness();
    plainInstance(h, 'alpha');
    plainInstance(h, 'beta');
    const r = run(h);
    const consumer = events(r, 'claude-consumer');
    // Two rounds: the inventory before the install and the postcheck re-resolution after it.
    expect(consumer.map((e) => e.status)).toEqual(['resolved', 'resolved', 'resolved', 'resolved']);
    for (const e of consumer.slice(0, 2)) expect(e.message).toContain(`${h.launcher} (native ${OLD})`);
    for (const e of consumer.slice(2)) expect(e.message).toContain(`${h.launcher} (native ${TARGET})`);
    expect(events(r, 'claude').at(-1)).toMatchObject({ status: 'updated', before: OLD, target: TARGET });
    expect(readlinkSync(h.launcher)).toBe(path.join(h.versions, TARGET));
    const calls = fixtureCalls(h);
    const firstInstall = calls.findIndex((line) => line.includes(`install ${TARGET}`));
    expect(firstInstall).toBe(0);
  }, T);

  it.runIf(onDarwin)('records a com.whatsoup plist that is not a generated instance instead of dropping it silently', () => {
    const h = makeHarness();
    plainInstance(h, 'alpha');
    writePlist(h, 'helper', { PATH: '/usr/bin:/bin' }, ['/bin/sh', '-c', 'true']);
    const r = run(h);
    const consumer = events(r, 'claude-consumer');
    expect(consumer.find((e) => e.status === 'skipped')?.message).toContain('com.whatsoup.helper.plist');
    expect(consumer.filter((e) => e.status === 'resolved' && e.message.includes(`(native ${OLD})`))).toHaveLength(1);
  }, T);
});

describe('per-instance service resolver (systemd)', () => {
  it('reads PATH and the prepend from the unit environment and its environment files', () => {
    const h = makeHarness();
    const pin = pinDir(h);
    const envFile = path.join(h.home, 'alpha.env');
    writeFileSync(envFile, `# instance tokens\nWHATSOUP_PATH_PREPEND=${pin}\nOTHER_SECRET=do-not-read\n`);
    systemdUnit(h, 'alpha', [
      `Environment=PATH=/usr/bin:/bin WHATSOUP_NODE=${process.execPath}`,
      `EnvironmentFiles=${envFile} (ignore_errors=yes)`,
      `EnvironmentFiles=${path.join(h.home, 'absent.env')} (ignore_errors=yes)`,
    ]);
    const r = run(h, [], { WHATSOUP_HARNESS_SERVICE_MANAGER: 'systemd' });
    const consumer = events(r, 'claude-consumer');
    expect(consumer).toHaveLength(1);
    expect(consumer[0]!.message).toContain(`alpha via systemd: ${pin}/claude`);
    expect(JSON.stringify(r.state)).not.toContain('do-not-read');
    expect(fixtureCalls(h)).toEqual([]);
  }, T);

  it('falls back to the user manager PATH only when the unit sets none, and installs', () => {
    const h = makeHarness();
    writeFileSync(path.join(h.systemdDir, 'manager.env'), 'LANG=C\nPATH=/usr/bin:/bin\n');
    systemdUnit(h, 'alpha', [`Environment=WHATSOUP_NODE=${process.execPath}`, 'EnvironmentFiles=']);
    const r = run(h, [], { WHATSOUP_HARNESS_SERVICE_MANAGER: 'systemd' });
    expect(events(r, 'claude-consumer')[0]!.message).toContain(`alpha via systemd: ${h.launcher}`);
    expect(events(r, 'claude').at(-1)?.status).toBe('updated');
  }, T);

  it('treats an unparseable unit environment as unknown', () => {
    const h = makeHarness();
    systemdUnit(h, 'alpha', ['Environment="PATH=/usr/bin:/bin" "WHATSOUP_NODE=/x y/node"']);
    const r = run(h, [], { WHATSOUP_HARNESS_SERVICE_MANAGER: 'systemd' });
    expect(events(r, 'claude-consumer')[0]!.status).toBe('unknown');
    expect(fixtureCalls(h)).toEqual([]);
  }, T);

  it('treats a failed unit listing as an unknown inventory, not as zero instances', () => {
    const h = makeHarness();
    writeFileSync(path.join(h.systemdDir, 'list.rc'), '1');
    const r = run(h, [], { WHATSOUP_HARNESS_SERVICE_MANAGER: 'systemd' });
    expect(events(r, 'claude').at(-1)?.status).toBe('unknown');
    expect(fixtureCalls(h)).toEqual([]);
  }, T);
});

describe('shared-binary consumer and pin policy', () => {
  it.runIf(onDarwin)('holds the shared install when any instance is pinned elsewhere, naming it', () => {
    const h = makeHarness();
    const pin = pinDir(h);
    plainInstance(h, 'alpha');
    plainInstance(h, 'beta', { WHATSOUP_PATH_PREPEND: pin });
    const r = run(h);
    const last = events(r, 'claude').at(-1)!;
    expect(last.status).toBe('held');
    expect(last.message).toContain('beta');
    expect(last.message).not.toContain('alpha');
    expect(fixtureCalls(h)).toEqual([]);
    expect(readlinkSync(h.launcher)).toBe(path.join(h.versions, OLD));
  }, T);

  it.runIf(onDarwin)('holds when one instance is unknown even if the others resolve the launcher', () => {
    const h = makeHarness();
    plainInstance(h, 'alpha');
    writeFileSync(path.join(h.home, 'Library/LaunchAgents/com.whatsoup.beta.plist'), 'not a plist');
    const r = run(h);
    expect(events(r, 'claude').at(-1)?.status).toBe('unknown');
    expect(events(r, 'claude').at(-1)?.message).toContain('beta');
    expect(fixtureCalls(h)).toEqual([]);
  }, T);

  it.runIf(onDarwin)('never updates an unused launcher when no instance consumes it', () => {
    const h = makeHarness();
    const r = run(h);
    expect(events(r, 'claude').at(-1)?.status).toBe('held');
    expect(events(r, 'claude').at(-1)?.message).toContain('no service instance');
    expect(fixtureCalls(h)).toEqual([]);
    expect(readlinkSync(h.launcher)).toBe(path.join(h.versions, OLD));
  }, T);

  it.runIf(onDarwin)('holds a non-native launcher as an unmanaged layout without running an installer', () => {
    const h = makeHarness();
    plainInstance(h, 'alpha');
    rmSync(h.launcher);
    writeExec(h.launcher, `#!/bin/sh\nexec ${path.join(h.versions, OLD)} "$@"\n`);
    const r = run(h);
    expect(events(r, 'claude').at(-1)?.status).toBe('unmanaged-layout');
    expect(fixtureCalls(h)).toEqual([]);
  }, T);
});

function customManifest(h: Harness, mutate: (m: Record<string, any>) => void): string {
  const manifest = JSON.parse(readFileSync(path.join(REPO, 'deploy/managed-components.json'), 'utf8'));
  mutate(manifest);
  const file = path.join(h.home, 'manifest.json');
  writeFileSync(file, JSON.stringify(manifest));
  return file;
}

describe('bounded step runner and final state', () => {
  it('keeps running independent steps after a failed step and ends degraded with exit 1', () => {
    const h = makeHarness();
    const manifest = path.join(h.home, 'broken-manifest.json');
    writeFileSync(manifest, '{"schema_version": 2}');
    const r = run(h, [], { WHATSOUP_HARNESS_MAINTENANCE_MANIFEST: manifest });
    expect(r.status).toBe(1);
    expect(r.state?.status).toBe('degraded');
    // The probes are independent of the manifest and still ran.
    expect(events(r, 'apt')).toHaveLength(1);
    // Updates depend on a valid manifest and were skipped, not attempted.
    expect(events(r, 'claude')).toEqual([]);
    expect(events(r, 'harness-maintenance').map((e) => e.status)).toContain('skipped');
    expect(fixtureCalls(h)).toEqual([]);
  }, T);

  it('ends degraded with exit 1 when an instance binary is unknown', () => {
    const h = makeHarness();
    // No PATH in the unit and none in the manager environment.
    systemdUnit(h, 'alpha', [`Environment=WHATSOUP_NODE=${process.execPath}`]);
    const r = run(h, [], { WHATSOUP_HARNESS_SERVICE_MANAGER: 'systemd' });
    expect(events(r, 'claude').at(-1)?.status).toBe('unknown');
    expect(r.state?.status).toBe('degraded');
    expect(r.status).toBe(1);
  }, T);

  it('writes a degraded final state and exits 1 when the service binary is missing', () => {
    const h = makeHarness();
    portableInstance(h, 'alpha');
    rmSync(h.launcher);
    const r = run(h);
    expect(events(r, 'claude-consumer')[0]!.status).toBe('missing');
    expect(events(r, 'claude').at(-1)?.status).toBe('missing');
    expect(r.state?.status).toBe('degraded');
    expect(r.status).toBe(1);
    expect(fixtureCalls(h)).toEqual([]);
  }, T);

  it('records a rejected update plan (exit 2) as held and keeps the job running', () => {
    const h = makeHarness();
    portableInstance(h, 'alpha');
    const manifest = customManifest(h, (m) => { m.npm.cooldown_minutes = 10080.5; });
    const r = run(h, [], { WHATSOUP_HARNESS_MAINTENANCE_MANIFEST: manifest });
    const last = events(r, 'claude').at(-1)!;
    expect(last.status).toBe('held');
    expect(last.message).toContain('INVALID_ARGUMENT');
    expect(events(r, 'apt')).toHaveLength(1);
    expect(r.state?.status).toBe('degraded');
    expect(fixtureCalls(h)).toEqual([]);
  }, T);

  it('bounds the publish-time lookup and holds without installing when it times out', () => {
    const h = makeHarness();
    portableInstance(h, 'alpha');
    const started = Date.now();
    const r = run(h, [], { HM_NPM_HANG: '1', WHATSOUP_HARNESS_MAINTENANCE_LOOKUP_TIMEOUT_SECS: '2' });
    expect(Date.now() - started).toBeLessThan(25_000);
    const last = events(r, 'claude').at(-1)!;
    expect(last.status).toBe('unknown');
    expect(last.message).toContain('timed out');
    expect(fixtureCalls(h)).toEqual([]);
    expect(r.state?.status).toBe('degraded');
  }, T);

  it('surfaces a final state write failure on its own, with an alert and exit 1', () => {
    const h = makeHarness();
    const stateDir = path.join(h.home, '.cache/whatsoup/harness-maintenance');
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    symlinkSync(path.join(h.home, 'elsewhere.json'), path.join(stateDir, 'state.json'));
    const r = run(h);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('state write failed');
    const alerts = readFileSync(h.alertLog, 'utf8').split('\n');
    expect(alerts.some((line) => line.includes('harness-maintenance:job') && line.includes('state write failed'))).toBe(true);
    expect(existsSync(path.join(h.home, 'elsewhere.json'))).toBe(false);
  }, T);
});

function statuses(r: RunResult): string[] {
  return events(r, 'claude').map((e) => e.status);
}

function installCalls(h: Harness): string[] {
  return fixtureCalls(h).filter((line) => / install /.test(line));
}

describe('install and rollback transaction', () => {
  it('installs through the verified previous binary with an explicit target and postchecks the result', () => {
    const h = makeHarness();
    portableInstance(h, 'alpha');
    const r = run(h);
    expect(r.status).toBe(0);
    expect(statuses(r)).toEqual(['install-attempted', 'updated']);
    expect(events(r, 'claude')[0]!.message).toContain('rc=0');
    expect(events(r, 'claude')[1]!.message).toMatch(/sha256 [0-9a-f]{64}/);
    // The installer ran from the verified native binary, then only the new binary answered --version.
    expect(fixtureCalls(h)).toEqual([`${OLD} install ${TARGET}`, `${TARGET} --version`]);
    expect(readlinkSync(h.launcher)).toBe(path.join(h.versions, TARGET));
  }, T);

  it('rolls back nothing when a failed installer left the link alone, and still exits 1', () => {
    const h = makeHarness();
    portableInstance(h, 'alpha');
    writeFileSync(h.modeFile, 'fail');
    const r = run(h);
    expect(statuses(r)).toEqual(['install-attempted', 'rollback-attempted', 'rollback-verified']);
    expect(events(r, 'claude')[0]!.message).toContain('rc=1');
    expect(readlinkSync(h.launcher)).toBe(path.join(h.versions, OLD));
    expect(r.state?.status).toBe('degraded');
    expect(r.status).toBe(1);
  }, T);

  it('restores the recorded link when the installer switched it and then failed', () => {
    const h = makeHarness();
    portableInstance(h, 'alpha');
    writeFileSync(h.modeFile, 'partial');
    const r = run(h);
    // The requested version is present, but a failed installer is still a failed attempt.
    expect(statuses(r)).toEqual(['install-attempted', 'rollback-attempted', 'rollback-verified']);
    expect(readlinkSync(h.launcher)).toBe(path.join(h.versions, OLD));
    expect(r.status).toBe(1);
  }, T);

  it('reports rollback-failed with exit 3 when the previous binary was pruned, and never reinstalls it', () => {
    const h = makeHarness();
    portableInstance(h, 'alpha');
    writeFileSync(h.modeFile, 'prune');
    const r = run(h);
    expect(statuses(r)).toEqual(['install-attempted', 'rollback-attempted', 'rollback-failed']);
    expect(events(r, 'claude').at(-1)!.message).toContain('previous binary');
    expect(installCalls(h)).toEqual([`${OLD} install ${TARGET}`]);
    expect(r.state?.status).toBe('degraded');
    expect(r.status).toBe(3);
  }, T);

  it('rolls back when the installer exits 0 without switching the link', () => {
    const h = makeHarness();
    portableInstance(h, 'alpha');
    writeFileSync(h.modeFile, 'noop');
    const r = run(h);
    expect(statuses(r)).toEqual(['install-attempted', 'rollback-attempted', 'rollback-verified']);
    expect(r.status).toBe(1);
  }, T);

  it('fails the postcheck when --version prints the target but exits nonzero', () => {
    const h = makeHarness();
    portableInstance(h, 'alpha');
    const r = run(h, [], { HM_FIXTURE_VERSION_RC: '1' });
    expect(statuses(r)).toEqual(['install-attempted', 'rollback-attempted', 'rollback-verified']);
    expect(readlinkSync(h.launcher)).toBe(path.join(h.versions, OLD));
    expect(r.status).toBe(1);
  }, T);

  it('bounds a hung installer and rolls back', () => {
    const h = makeHarness();
    portableInstance(h, 'alpha');
    writeFileSync(h.modeFile, 'hang');
    const started = Date.now();
    const r = run(h, [], { WHATSOUP_HARNESS_MAINTENANCE_INSTALL_TIMEOUT_SECS: '2' });
    expect(Date.now() - started).toBeLessThan(40_000);
    expect(events(r, 'claude')[0]!.message).toContain('rc=124');
    expect(statuses(r).at(-1)).toBe('rollback-verified');
    expect(r.status).toBe(1);
  }, T);

  it('refuses to swap back a launcher that moved after the install, and exits 3', () => {
    const h = makeHarness();
    portableInstance(h, 'alpha');
    writeFileSync(h.modeFile, 'interlope');
    const r = run(h);
    expect(statuses(r)).toEqual(['install-attempted', 'rollback-attempted', 'rollback-failed']);
    expect(events(r, 'claude').at(-1)!.message).toContain('moved since the install');
    // Left where the other writer put it, not overwritten.
    expect(readlinkSync(h.launcher)).toBe(path.join(h.versions, '9.9.9'));
    expect(r.status).toBe(3);
  }, T);
});
