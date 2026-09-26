import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Shared harness for tests that execute the real maintenance script under /bin/bash in a
// temporary HOME.
//
// Native fixture: a tiny C program compiled once per test file. It is a genuine
// Mach-O/ELF executable, so the static classifier accepts it as native only
// through its real magic bytes, not through a shebang. At run time it execs
// /bin/sh on the behaviour script named by HM_FIXTURE_SCRIPT, passing its own
// argv[0] first, so each test controls what "install" and "--version" do. A
// missing C compiler fails the suite loudly instead of skipping it.

export const REPO = process.cwd();
export const SCRIPT = path.join(REPO, 'deploy/scripts/harness-maintenance.sh');
export const OLD = '2.1.280';
export const TARGET = '2.1.282';
export const YOUNG = '2.1.283';
export const DAY_MS = 86_400_000;
export const RUN_TIMEOUT_MS = 90_000;
export const T = RUN_TIMEOUT_MS + 10_000;
export const onDarwin = process.platform === 'darwin';

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
  '    mode=ok; [ -f "$HM_FIXTURE_MODE" ] && mode="$(cat "$HM_FIXTURE_MODE")"',
  '    case "$mode" in',
  '      interlope|swapok)',
  '        # Another writer moves the launcher while the postcheck runs.',
  '        cp "$self" "$HOME/.local/share/claude/versions/9.9.9" && ln -sfn "$HOME/.local/share/claude/versions/9.9.9" "$HOME/.local/bin/claude"',
  '        [ "$mode" = interlope ] && exit 1 ;;',
  '      lockdir)',
  '        # The launcher directory becomes unwritable before the rollback swap.',
  '        chmod 555 "$HOME/.local/bin"; exit 1 ;;',
  '    esac',
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
  '  plugin)',
  '    mode=ok; [ -f "$HM_FIXTURE_MODE" ] && mode="$(cat "$HM_FIXTURE_MODE")"',
  '    # The agent CLI updating itself when the job starts it for its plugin listing.',
  '    if [ "$mode" = selfupdate ]; then',
  '      cp "$self" "$HOME/.local/share/claude/versions/9.9.9" && ln -sfn "$HOME/.local/share/claude/versions/9.9.9" "$HOME/.local/bin/claude"',
  '    fi',
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
let nativeFixturePath = '';
const homes: string[] = [];

/** Compile the native fixture; call from beforeAll. */
export function buildNativeFixture(): void {
  fixtureRoot = mkdtempSync(path.join(tmpdir(), 'hm-native-'));
  const source = path.join(fixtureRoot, 'fixture.c');
  nativeFixturePath = path.join(fixtureRoot, 'native-fixture');
  writeFileSync(source, FIXTURE_C);
  const cc = spawnSync('cc', ['-O0', '-o', nativeFixturePath, source], { encoding: 'utf8', timeout: 60_000 });
  if (cc.error || cc.status !== 0) {
    throw new Error(`cannot build the native test fixture with cc: ${cc.error?.message ?? cc.stderr}`);
  }
}

/** Remove the fixture and every temporary HOME; call from afterAll. */
export function cleanupHarnesses(): void {
  for (const dir of [fixtureRoot, ...homes]) if (dir) rmSync(dir, { recursive: true, force: true });
  homes.length = 0;
}

export function nativeFixture(): string {
  return nativeFixturePath;
}

export interface Harness {
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

export function writeExec(file: string, text: string): void {
  writeFileSync(file, text);
  chmodSync(file, 0o755);
}

export function installNative(h: Harness, version: string): string {
  const file = path.join(h.versions, version);
  copyFileSync(nativeFixturePath, file);
  chmodSync(file, 0o755);
  return file;
}

export function makeHarness(): Harness {
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
  // The installed instance wrapper, linked into this checkout as deploy/setup.sh links it.
  symlinkSync(path.join(REPO, 'deploy/whatsoup'), path.join(localBin, 'whatsoup'));

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
    // The host's own managed settings file must not leak into a test.
    WHATSOUP_HARNESS_MANAGED_SETTINGS_FILE: path.join(home, 'no-managed-settings.json'),
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
export function writePlist(
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
export function plainInstance(h: Harness, name: string, extra: Record<string, string | undefined> = {}): void {
  writePlist(h, name, { PATH: '/usr/bin:/bin', WHATSOUP_NODE: process.execPath, ...extra });
}

/** A directory outside the launcher holding its own copy of the native fixture. */
export function pinDir(h: Harness): string {
  const dir = path.join(h.home, 'pin/bin');
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  copyFileSync(nativeFixturePath, path.join(dir, 'claude'));
  chmodSync(path.join(dir, 'claude'), 0o755);
  return dir;
}

export interface RunResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  state: { status: string; mode: string; events: Array<Record<string, string>> } | null;
}

/**
 * A mirror of this checkout whose maintenance script has `edits` applied (each `from` must occur
 * exactly once), for injecting a fault into one step. Every other file is a symlink into the
 * checkout, so the mirror's wrapper and libraries are byte-identical to it. Returns the script.
 */
export function faultScript(h: Harness, edits: Array<[string, string]>): string {
  const root = mkdtempSync(path.join(h.home, 'fault-tree-'));
  const mirror = (from: string, to: string, keep: string): void => {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) if (name !== keep) symlinkSync(path.join(from, name), path.join(to, name));
  };
  mirror(REPO, root, 'deploy');
  mirror(path.join(REPO, 'deploy'), path.join(root, 'deploy'), 'scripts');
  mirror(path.join(REPO, 'deploy/scripts'), path.join(root, 'deploy/scripts'), 'harness-maintenance.sh');
  let text = readFileSync(SCRIPT, 'utf8');
  for (const [from, to] of edits) {
    if (text.split(from).length !== 2) throw new Error(`fault edit does not match exactly once: ${from}`);
    text = text.replace(from, to);
  }
  const script = path.join(root, 'deploy/scripts/harness-maintenance.sh');
  writeFileSync(script, text);
  return script;
}

export function run(h: Harness, args: string[] = [], extraEnv: Record<string, string> = {}, script = SCRIPT): RunResult {
  const result = spawnSync('/bin/bash', [script, ...args], {
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

export function events(r: RunResult, component: string): Array<Record<string, string>> {
  return (r.state?.events ?? []).filter((event) => event.component === component);
}

/** Every recorded invocation of the native fixture, unfiltered. */
export function allFixtureCalls(h: Harness): string[] {
  if (!existsSync(h.fixtureLog)) return [];
  return readFileSync(h.fixtureLog, 'utf8').split('\n').filter((line) => line !== '');
}

/**
 * Fixture invocations other than the run-mode tier-2 probes: a normal run lists the agent CLI's
 * plugins and MCP servers from the job PATH by design. --check never does; that boundary is
 * asserted with allFixtureCalls in harness-maintenance-check-boundary.test.ts.
 */
export function fixtureCalls(h: Harness): string[] {
  return allFixtureCalls(h).filter((line) => !/^\S+ (plugin|mcp) list$/.test(line));
}

/**
 * A plain instance under the systemd fake, so manager-independent behaviour runs on every
 * platform: manager PATH without any claude, the pinned node, no prepend.
 */
export function portableInstance(h: Harness, name: string): void {
  writeFileSync(path.join(h.systemdDir, 'manager.env'), 'PATH=/usr/bin:/bin\n');
  systemdUnit(h, name, [`Environment=WHATSOUP_NODE=${process.execPath}`]);
  h.env.WHATSOUP_HARNESS_SERVICE_MANAGER = 'systemd';
}

export function systemdUnit(h: Harness, name: string, show: string[]): void {
  const units = path.join(h.systemdDir, 'units');
  const prior = existsSync(units) ? readFileSync(units, 'utf8') : '';
  writeFileSync(units, `${prior}whatsoup@${name}.service loaded active running WhatSoup ${name}\n`);
  writeFileSync(path.join(h.systemdDir, `whatsoup@${name}.service.show`), `${show.join('\n')}\n`);
}

export function customManifest(h: Harness, mutate: (m: Record<string, any>) => void): string {
  const manifest = JSON.parse(readFileSync(path.join(REPO, 'deploy/managed-components.json'), 'utf8'));
  mutate(manifest);
  const file = path.join(h.home, 'manifest.json');
  writeFileSync(file, JSON.stringify(manifest));
  return file;
}
