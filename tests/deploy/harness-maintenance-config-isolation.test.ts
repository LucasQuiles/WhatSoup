import { existsSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  OLD,
  T,
  TARGET,
  allFixtureCalls,
  buildNativeFixture,
  cleanupHarnesses,
  events,
  makeHarness,
  onDarwin,
  run,
  systemdUnit,
  systemdUnitFile,
  type Harness,
  type RunResult,
  writePlist,
} from './harness-maintenance-fixture-helper.ts';

// The agent CLI uses, and can refresh, the login of whatever CLAUDE_CONFIG_DIR it sees. The
// nightly job starts it for the native installer, the post-install --version check and the plugin
// and MCP listings. If the job shared a bot's config dir or keychain item, a refresh by the job
// could rotate or wipe the bot's login. So before any of those steps the script must prove that
// its own CLAUDE_CONFIG_DIR is set, absolute, not the default ~/.claude, and different from every
// inventoried instance's (as a string, a resolved directory and a keychain item); otherwise it
// starts no agent CLI at all and the run ends degraded.
//
// Oracles: the native fixture's invocation log (did any agent CLI process start), the launcher
// link on disk, the alert stub's log, the exit code and the recorded event statuses.

beforeAll(buildNativeFixture);
afterAll(cleanupHarnesses);

/** An empty secure selector selects the default credential store; unset preserves the config selector. */
function withInstance(h: Harness, config?: string, secureStorage?: string): Harness {
  writeFileSync(path.join(h.systemdDir, 'manager.env'), 'PATH=/usr/bin:/bin\n');
  const env = [
    `WHATSOUP_NODE=${process.execPath}`,
    ...(config === undefined ? [] : [`CLAUDE_CONFIG_DIR=${config}`]),
    ...(secureStorage === undefined ? [] : [`CLAUDE_SECURESTORAGE_CONFIG_DIR=${secureStorage}`]),
  ];
  systemdUnit(h, 'alpha', [`Environment=${env.join(' ')}`]);
  h.env.WHATSOUP_HARNESS_SERVICE_MANAGER = 'systemd';
  return h;
}

/** A structurally valid plist whose selected credential-store field cannot be read as a string. */
function withUnreadableLaunchdSelector(h: Harness, key: 'CLAUDE_CONFIG_DIR' | 'CLAUDE_SECURESTORAGE_CONFIG_DIR'): Harness {
  writePlist(h, 'alpha', { PATH: '/usr/bin:/bin', WHATSOUP_NODE: process.execPath, [key]: 'ignored' });
  const file = path.join(h.home, 'Library/LaunchAgents/com.whatsoup.alpha.plist');
  const source = readFileSync(file, 'utf8');
  const stringEntry = `<key>${key}</key>\n    <string>ignored</string>`;
  if (!source.includes(stringEntry)) throw new Error(`fixture missing ${key}`);
  writeFileSync(file, source.replace(stringEntry, `<key>${key}</key>\n    <array><string>ignored</string></array>`));
  h.env.WHATSOUP_HARNESS_SERVICE_MANAGER = 'launchd';
  return h;
}

function isolationAlerts(h: Harness): string[] {
  if (!existsSync(h.alertLog)) return [];
  return readFileSync(h.alertLog, 'utf8').split('\n')
    .filter((line) => line.includes('harness-maintenance:claude-config-isolation'));
}

function expectRefused(h: Harness, r: RunResult, reason: string, updateStatus: 'refused' | 'unknown' = 'refused'): void {
  // No agent CLI process started: not the installer, not --version, not a listing.
  expect(allFixtureCalls(h)).toEqual([]);
  expect(readlinkSync(h.launcher)).toBe(path.join(h.versions, OLD));
  const isolation = events(r, 'claude-config-isolation');
  expect(isolation).toHaveLength(1);
  expect(isolation[0]!.status).toBe('refused');
  expect(isolation[0]!.message).toContain(reason);
  expect(events(r, 'claude').at(-1)?.status).toBe(updateStatus);
  for (const listing of ['claude-plugins', 'mcp-servers']) {
    expect(events(r, listing).map((e) => e.status), listing).toEqual(['refused']);
  }
  expect(r.state?.status).toBe('degraded');
  expect(r.status).toBe(1);
  // One alert for the refusal, however many steps it skipped.
  expect(isolationAlerts(h)).toHaveLength(1);
}

describe('agent CLI login isolation of the maintenance job', () => {
  it('starts the installer, its --version postcheck and the listings when the job has its own config dir', () => {
    const h = makeHarness();
    withInstance(h, path.join(h.home, 'bot-config'));
    const r = run(h);
    expect(events(r, 'claude-config-isolation')).toEqual([]);
    expect(events(r, 'claude').at(-1)).toMatchObject({ status: 'updated', before: OLD, target: TARGET });
    const calls = allFixtureCalls(h);
    expect(calls).toContain(`${OLD} install ${TARGET}`);
    expect(calls).toContain(`${TARGET} --version`);
    expect(calls).toContain('claude plugin list');
    expect(calls).toContain('claude mcp list');
    expect(isolationAlerts(h)).toEqual([]);
  }, T);

  it('also runs them next to an instance on the default config dir', () => {
    const h = withInstance(makeHarness());
    const r = run(h);
    expect(events(r, 'claude-config-isolation')).toEqual([]);
    expect(allFixtureCalls(h)).toContain('claude plugin list');
  }, T);

  it('refuses every agent CLI step when the job uses the same config dir as an instance', () => {
    const h = makeHarness();
    withInstance(h, h.env.CLAUDE_CONFIG_DIR);
    expectRefused(h, run(h), "equals alpha's");
  }, T);

  it('refuses every agent CLI step when a disabled never-loaded systemd unit shares the job store', () => {
    const h = makeHarness();
    withInstance(h, path.join(h.home, 'bot-config'));
    systemdUnitFile(h, 'beta', [
      `Environment=WHATSOUP_NODE=${process.execPath} CLAUDE_CONFIG_DIR=${h.env.CLAUDE_CONFIG_DIR}`,
    ]);
    expectRefused(h, run(h), "equals beta's");
  }, T);

  it('refuses every agent CLI step when a disabled never-loaded unit selector is unreadable', () => {
    const h = makeHarness();
    withInstance(h, path.join(h.home, 'bot-config'));
    systemdUnitFile(h, 'beta', [
      `Environment=WHATSOUP_NODE=${process.execPath} CLAUDE_CONFIG_DIR=$HOME/not-statically-readable`,
    ]);
    expectRefused(h, run(h), "beta's CLAUDE_CONFIG_DIR is not readable");
  }, T);

  it('refuses every agent CLI step when installed systemd unit-file inventory cannot be read', () => {
    const h = makeHarness();
    withInstance(h, path.join(h.home, 'bot-config'));
    writeFileSync(path.join(h.systemdDir, 'unit-files.rc'), '1\n');
    // Failed inventory retains the update step's unknown diagnosis while every CLI call is blocked.
    expectRefused(h, run(h), 'service definitions were not read', 'unknown');
  }, T);

  it('refuses when the job config dir resolves to an instance config dir through a symlink', () => {
    const h = makeHarness();
    const real = path.join(h.home, 'bot-config');
    const alias = path.join(h.home, 'alias-config');
    mkdirSync(real);
    symlinkSync(real, alias);
    withInstance(h, real);
    expectRefused(h, run(h, [], { CLAUDE_CONFIG_DIR: alias }), "resolves to alpha's config dir");
  }, T);

  it('refuses when a not-yet-created job config dir resolves through a symlinked parent to an instance dir', () => {
    const h = makeHarness();
    const real = path.join(h.home, 'real');
    const alias = path.join(h.home, 'alias');
    mkdirSync(real);
    symlinkSync(real, alias);
    // Neither config dir exists yet; only their parents do.
    withInstance(h, path.join(real, 'bot-config'));
    expectRefused(h, run(h, [], { CLAUDE_CONFIG_DIR: path.join(alias, 'bot-config') }), "resolves to alpha's config dir");
  }, T);

  it('refuses when the job config dir is unset', () => {
    const h = withInstance(makeHarness());
    delete h.env.CLAUDE_CONFIG_DIR;
    expectRefused(h, run(h), 'CLAUDE_CONFIG_DIR is unset');
  }, T);

  it('refuses when the job config dir is relative', () => {
    const h = withInstance(makeHarness());
    expectRefused(h, run(h, [], { CLAUDE_CONFIG_DIR: 'maintenance-claude' }), 'is not an absolute path');
  }, T);

  it('refuses when the job config dir is the default config dir', () => {
    const h = withInstance(makeHarness(), '/elsewhere/bot-config');
    mkdirSync(path.join(h.home, '.claude'));
    expectRefused(h, run(h, [], { CLAUDE_CONFIG_DIR: `${h.home}/.claude/` }), 'is the default config dir');
  }, T);

  it('refuses a nonempty secure-storage selector shared with an instance effective store', () => {
    const h = makeHarness();
    const secureStore = path.join(h.home, 'bot-secure-store');
    h.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = secureStore;
    withInstance(h, path.join(h.home, 'bot-config'), secureStore);
    expectRefused(h, run(h), 'CLAUDE_SECURESTORAGE_CONFIG_DIR');
  }, T);

  it('refuses an explicitly empty secure-storage selector because it selects the default store', () => {
    const h = makeHarness();
    h.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = '';
    withInstance(h, path.join(h.home, 'bot-config'));
    expectRefused(h, run(h), 'CLAUDE_SECURESTORAGE_CONFIG_DIR');
  }, T);

  it('compares an instance secure-storage override with the job config store', () => {
    const h = makeHarness();
    withInstance(h, path.join(h.home, 'bot-config'), h.env.CLAUDE_CONFIG_DIR);
    expectRefused(h, run(h), "alpha's");
  }, T);

  it('allows a dedicated secure-storage selector next to an instance using the default store', () => {
    const h = makeHarness();
    h.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = path.join(h.home, 'maintenance-secure-store');
    withInstance(h, path.join(h.home, 'bot-config'), '');
    const result = run(h);
    expect(events(result, 'claude-config-isolation')).toEqual([]);
    expect(allFixtureCalls(h)).toContain('claude plugin list');
    expect(isolationAlerts(h)).toEqual([]);
  }, T);

  it('compares NFC-normalized secure-storage selectors before invoking the CLI', () => {
    const h = makeHarness();
    h.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = path.join(h.home, 'caf\u00e9');
    withInstance(h, path.join(h.home, 'bot-config'), path.join(h.home, 'cafe\u0301'));
    expectRefused(h, run(h), 'CLAUDE_SECURESTORAGE_CONFIG_DIR');
  }, T);

  it('refuses a self-referential effective secure-storage selector before starting the CLI', () => {
    const h = makeHarness();
    const loop = path.join(h.home, 'maintenance-loop');
    symlinkSync('maintenance-loop', loop);
    withInstance(h, path.join(h.home, 'bot-config'));
    expectRefused(h, run(h, [], { CLAUDE_SECURESTORAGE_CONFIG_DIR: loop }), 'could not be resolved');
  }, T);

  it.runIf(onDarwin)('refuses before CLI execution when an instance config selector is unreadable', () => {
    const h = withUnreadableLaunchdSelector(makeHarness(), 'CLAUDE_CONFIG_DIR');
    expectRefused(h, run(h), 'not readable');
  }, T);

  it.runIf(onDarwin)('refuses before CLI execution when an instance secure-storage selector is unreadable', () => {
    const h = withUnreadableLaunchdSelector(makeHarness(), 'CLAUDE_SECURESTORAGE_CONFIG_DIR');
    expectRefused(h, run(h), 'not readable');
  }, T);

  it('refuses when an instance config dir could not be read', () => {
    // A value with an expansion is not read literally, so the inventory records it as unknown.
    const h = withInstance(makeHarness(), '$HOME/expanded-by-systemd');
    expectRefused(h, run(h), "alpha's CLAUDE_CONFIG_DIR is not readable");
  }, T);

  it('refuses the listings when no service instance was inventoried, so isolation is unproven', () => {
    const h = makeHarness();
    h.env.WHATSOUP_HARNESS_SERVICE_MANAGER = 'systemd';
    const r = run(h);
    expect(allFixtureCalls(h)).toEqual([]);
    const isolation = events(r, 'claude-config-isolation');
    expect(isolation.map((e) => e.status)).toEqual(['refused']);
    expect(isolation[0]!.message).toContain('no service instance');
    expect(events(r, 'claude-plugins').map((e) => e.status)).toEqual(['refused']);
    expect(r.status).toBe(1);
  }, T);
  it('runs the Linux unit selectors beside a separately inventoried bot store', () => {
    const h = makeHarness();
    withInstance(h, path.join(h.home, 'bot-config'));
    const unit = readFileSync(path.join(process.cwd(), 'deploy/harness-maintenance.service'), 'utf8');
    const unitEnv: Record<string, string> = {};
    for (const key of ['CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR']) {
      const prefix = `Environment=${key}=`;
      const assignments = unit.split(/\r?\n/).filter((line) => line.startsWith(prefix));
      expect(assignments).toEqual([`${prefix}%h/.claude-maint`]);
      unitEnv[key] = assignments[0]!.slice(prefix.length).replace('%h', h.home);
      expect(unitEnv[key]).toBe(path.join(h.home, '.claude-maint'));
    }
    // The shipped unit, not makeHarness's injected selector, supplies the job environment.
    const r = run(h, [], unitEnv);
    expect(events(r, 'claude-config-isolation')).toEqual([]);
    expect(events(r, 'claude').at(-1)).toMatchObject({ status: 'updated', before: OLD, target: TARGET });
    const calls = allFixtureCalls(h);
    expect(calls).toContain(`${OLD} install ${TARGET}`);
    expect(calls).toContain(`${TARGET} --version`);
    expect(calls).toContain('claude plugin list');
    expect(calls).toContain('claude mcp list');
    expect(isolationAlerts(h)).toEqual([]);
  }, T);
});
