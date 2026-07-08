/**
 * Structural tests for platform-portability changes in deploy/setup.sh.
 *
 * These tests validate that:
 * - the script branches on PLATFORM for systemd/launchd requirements
 * - the systemctl-required error appears only in the linux/systemd branch
 * - the Darwin branch checks launchctl
 * - wrapper installs (step 3) are outside any platform conditional
 * - Darwin key-check uses macOS Keychain conventions matching src/lib/keyring.ts
 * - the key check covers the fallback-provider services on both platforms
 */
import { afterEach, describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const setupSource = fs.readFileSync(path.join(repoRoot, 'deploy', 'setup.sh'), 'utf8');
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

function writeHealthProfile(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{}\n', 'utf8');
}

function writeLinuxSetupShims(dir: string): void {
  writeExecutable(dir, 'uname', '#!/usr/bin/env bash\nprintf "Linux\\n"\n');
  writeExecutable(dir, 'node', [
    '#!/usr/bin/env bash',
    'if [[ "${1:-}" == "-v" ]]; then printf "v24.15.0\\n"; exit 0; fi',
    'if [[ "${1:-}" == "-e" ]]; then printf "26"; exit 0; fi',
    'if [[ "${1:-}" == "--experimental-strip-types" ]]; then exit 0; fi',
    'printf "unexpected node shim invocation: %s\\n" "$*" >&2',
    'exit 1',
    '',
  ].join('\n'));
  writeExecutable(dir, 'npm', '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$HOME/npm.log"\nexit 0\n');
  writeExecutable(dir, 'secret-tool', '#!/usr/bin/env bash\nexit 1\n');
  writeExecutable(dir, 'systemctl', [
    '#!/usr/bin/env bash',
    'printf "%s\\n" "$*" >> "$HOME/systemctl.log"',
    'if [[ "$*" == "--user list-units" ]]; then exit 0; fi',
    'if [[ "$*" == "--user daemon-reload" ]]; then exit "${SYSTEMCTL_DAEMON_RELOAD_EXIT:-0}"; fi',
    'exit 0',
    '',
  ].join('\n'));
}

function runLinuxSetupReplay(home: string, shimDir: string, extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync('bash', ['deploy/setup.sh'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...extraEnv,
      HOME: home,
      PATH: `${shimDir}:${process.env.PATH ?? ''}`,
      USER: 'setup-test',
    },
    encoding: 'utf8',
  });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/**
 * Slice the script from a start marker to an end marker (inclusive of start line,
 * exclusive of end line).  Returns the matched region or throws if a marker is absent.
 */
function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const startIdx = source.indexOf(startMarker);
  if (startIdx === -1) throw new Error(`Start marker not found: ${JSON.stringify(startMarker)}`);
  const endIdx = source.indexOf(endMarker, startIdx + startMarker.length);
  if (endIdx === -1) throw new Error(`End marker not found after start: ${JSON.stringify(endMarker)}`);
  return source.slice(startIdx, endIdx);
}

describe('deploy/setup.sh platform portability', () => {
  it('defines PLATFORM via uname near the top of the script', () => {
    // Must appear before step 1 header
    const platformAssign = 'PLATFORM="$(uname -s)"';
    const step1Header = '[1/7] Checking requirements';
    expect(setupSource).toContain(platformAssign);
    const platformIdx = setupSource.indexOf(platformAssign);
    const step1Idx = setupSource.indexOf(step1Header);
    expect(platformIdx).toBeGreaterThan(-1);
    expect(step1Idx).toBeGreaterThan(-1);
    expect(platformIdx).toBeLessThan(step1Idx);
  });

  it('contains the stable linux-systemd requirements anchor comment', () => {
    expect(setupSource).toContain('# --- linux (systemd) requirements ---');
  });

  it('"systemctl not found" error appears only inside the linux (non-Darwin) branch', () => {
    // Extract the region from the Darwin if-block open to the linux anchor
    const darwinOpen = 'if [ "$PLATFORM" = "Darwin" ]';
    const linuxAnchor = '# --- linux (systemd) requirements ---';
    const darwinSection = sliceBetween(setupSource, darwinOpen, linuxAnchor);
    // The systemctl-not-found message must NOT be in the Darwin branch
    expect(darwinSection).not.toContain('systemctl not found');
    // But must exist somewhere after the linux anchor
    const linuxOnward = setupSource.slice(setupSource.indexOf(linuxAnchor));
    expect(linuxOnward).toContain('systemctl not found');
  });

  it('Darwin branch checks launchctl in step 1', () => {
    const darwinOpen = 'if [ "$PLATFORM" = "Darwin" ]';
    const linuxAnchor = '# --- linux (systemd) requirements ---';
    const darwinSection = sliceBetween(setupSource, darwinOpen, linuxAnchor);
    expect(darwinSection).toContain('launchctl');
  });

  it('wrapper install block (step 3) contains no PLATFORM reference — portable on both', () => {
    // Step 3 is bounded by its header and a stable anchor comment that precedes the step-4 if-branch
    const step3Header = '[3/7] Installing wrapper scripts';
    const step4Anchor = '# --- step 4 start ---';
    const step3Block = sliceBetween(setupSource, step3Header, step4Anchor);
    expect(step3Block).not.toContain('PLATFORM');
  });

  it('Darwin key-check uses security find-generic-password with -s and -a "$USER"', () => {
    // The darwin key-check section is anchored by stable comments
    const darwinKeyAnchor = '# --- darwin (macos keychain) key check ---';
    expect(setupSource).toContain(darwinKeyAnchor);
    const darwinKeySection = setupSource.slice(setupSource.indexOf(darwinKeyAnchor));
    // Must end before linux key-check anchor
    const linuxKeyAnchor = '# --- linux (secret-tool) key check ---';
    const darwinKeyBlock = darwinKeySection.slice(
      0,
      darwinKeySection.indexOf(linuxKeyAnchor),
    );
    expect(darwinKeyBlock).toContain('security find-generic-password -s');
    expect(darwinKeyBlock).toContain('-a "$USER"');
  });

  it('Darwin key-check add-hint uses add-generic-password', () => {
    const darwinKeyAnchor = '# --- darwin (macos keychain) key check ---';
    const linuxKeyAnchor = '# --- linux (secret-tool) key check ---';
    const darwinKeySection = sliceBetween(setupSource, darwinKeyAnchor, linuxKeyAnchor);
    expect(darwinKeySection).toContain('add-generic-password');
  });

  it('key check covers the fallback-provider services on both platforms', () => {
    const darwinKeyAnchor = '# --- darwin (macos keychain) key check ---';
    const linuxKeyAnchor = '# --- linux (secret-tool) key check ---';
    const darwinKeySection = sliceBetween(setupSource, darwinKeyAnchor, linuxKeyAnchor);
    const linuxKeySection = setupSource.slice(setupSource.indexOf(linuxKeyAnchor));
    for (const service of ['minimax', 'deepseek']) {
      expect(darwinKeySection, `darwin key check missing ${service}`).toContain(`check_key "${service}" "optional"`);
      expect(linuxKeySection, `linux key check missing ${service}`).toContain(`check_key "${service}" "optional"`);
    }
  });

  it('existing wrapper install targets remain intact (regression guard)', () => {
    // These are cross-platform and must be present regardless of PLATFORM branching
    expect(setupSource).toContain('ln -sf "$REPO_ROOT/deploy/whatsoup" "$BIN_DIR/whatsoup"');
    expect(setupSource).toContain('ln -sf "$REPO_ROOT/deploy/whatsoup-auth" "$BIN_DIR/whatsoup-auth"');
    expect(setupSource).toContain('ln -sf "$REPO_ROOT/deploy/whatsoup-fleet" "$BIN_DIR/whatsoup-fleet"');
  });

  it('Linux setup installs BOT ERRORS service and timer units, not just the env template', () => {
    const linuxUnitBlock = sliceBetween(
      setupSource,
      '# --- linux (systemd) unit install ---',
      'fi\nmkdir -p "$HOME/.config/whatsoup"',
    );
    expect(setupSource).toContain('BOT_ERRORS_SYSTEMD_UNITS=(');
    for (const unit of botErrorsSystemdUnits) {
      expect(setupSource, `BOT_ERRORS_SYSTEMD_UNITS missing ${unit}`).toContain(`"${unit}"`);
    }
    expect(linuxUnitBlock).toContain('for unit in "${BOT_ERRORS_SYSTEMD_UNITS[@]}"');
    expect(linuxUnitBlock).toContain('cp "$REPO_ROOT/deploy/$unit" "$SYSTEMD_DIR/$unit"');
    expect(linuxUnitBlock).toContain('BOT ERRORS service/timer units installed');
  });

  it('Linux setup fails closed when daemon-reload cannot see the installed units', () => {
    const linuxUnitBlock = sliceBetween(
      setupSource,
      '# --- linux (systemd) unit install ---',
      'fi\nmkdir -p "$HOME/.config/whatsoup"',
    );
    expect(linuxUnitBlock).toContain('if ! systemctl --user daemon-reload; then');
    expect(linuxUnitBlock).toContain('systemctl --user daemon-reload failed after installing units');
    expect(linuxUnitBlock).toContain('exit 1');
    expect(linuxUnitBlock).not.toMatch(/daemon-reload[^\n]*\|\|\s*true/);
  });

  it('Linux setup validates the BOT ERRORS health profile before installing units', () => {
    const linuxUnitBlock = sliceBetween(
      setupSource,
      '# --- linux (systemd) unit install ---',
      'fi\nmkdir -p "$HOME/.config/whatsoup"',
    );
    expect(linuxUnitBlock).toContain('require_readable_bot_errors_health_profile');
    expect(linuxUnitBlock.indexOf('require_readable_bot_errors_health_profile')).toBeLessThan(
      linuxUnitBlock.indexOf('for unit in "${BOT_ERRORS_SYSTEMD_UNITS[@]}"'),
    );
  });

  it('setup provisions the full BOT ERRORS routing env contract', () => {
    const routingBlock = sliceBetween(
      setupSource,
      'cp "$REPO_ROOT/deploy/bot-errors.env.example"',
      '# ── Step 5: Install hardened npm defaults',
    );
    for (const key of [
      'BOT_ERRORS_JID',
      'BOT_ERRORS_EXPECTED_JID',
      'BOT_ERRORS_SOCKET_PATH',
      'BOT_ERRORS_SOCKET',
      'BOT_ERRORS_DB',
      'BOT_ERRORS_HEALTH_PROFILE',
    ]) {
      expect(routingBlock, `setup routing block missing ${key}`).toContain(`${key}=`);
    }
  });

  it('Linux setup replay copies BOT ERRORS units and writes private routing env', () => {
    const home = makeTempRoot('whatsoup-setup-home-');
    const shimDir = makeTempRoot('whatsoup-setup-shims-');
    const profile = path.join(home, 'profiles', 'testhost.json');
    writeHealthProfile(profile);
    writeLinuxSetupShims(shimDir);

    const result = runLinuxSetupReplay(home, shimDir, {
      BOT_ERRORS_JID: '120363555555550001@g.us',
      BOT_ERRORS_SOCKET_PATH: path.join(home, 'runtime', 'whatsoup.sock'),
      BOT_ERRORS_DB: path.join(home, 'state', 'bot.db'),
      BOT_ERRORS_HEALTH_PROFILE: profile,
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const systemdDir = path.join(home, '.config', 'systemd', 'user');
    for (const unit of botErrorsSystemdUnits) {
      expect(
        fs.existsSync(path.join(systemdDir, unit)),
        `setup replay did not copy ${unit}`,
      ).toBe(true);
    }
    const envFile = fs.readFileSync(path.join(home, '.config', 'whatsoup', 'bot-errors.env'), 'utf8');
    expect(envFile).toContain('BOT_ERRORS_JID=120363555555550001@g.us');
    expect(envFile).toContain('BOT_ERRORS_EXPECTED_JID=120363555555550001@g.us');
    expect(envFile).toContain(`BOT_ERRORS_SOCKET_PATH=${path.join(home, 'runtime', 'whatsoup.sock')}`);
    expect(envFile).toContain(`BOT_ERRORS_SOCKET=${path.join(home, 'runtime', 'whatsoup.sock')}`);
    expect(envFile).toContain(`BOT_ERRORS_DB=${path.join(home, 'state', 'bot.db')}`);
    expect(envFile).toContain(`BOT_ERRORS_HEALTH_PROFILE=${profile}`);
    expect(fs.readFileSync(path.join(home, 'systemctl.log'), 'utf8')).toContain('--user daemon-reload');
    expect(result.stdout).toContain('BOT ERRORS service/timer units installed');
    expect(result.stdout).toContain('systemctl --user enable --now bot-errors-dispatcher.service bot-errors-q-loop.service bot-errors-collector.service');
  });

  it('Linux setup replay re-enables existing WhatSoup units after daemon-reload', () => {
    const home = makeTempRoot('whatsoup-setup-home-');
    const shimDir = makeTempRoot('whatsoup-setup-shims-');
    const profile = path.join(home, 'profiles', 'testhost.json');
    const systemdDir = path.join(home, '.config', 'systemd', 'user');
    const staleTarget = path.join(systemdDir, 'graphical-session.target.wants');
    const defaultTarget = path.join(systemdDir, 'default.target.wants');
    const agentUnit = ['whatsoup', 'alpha.service'].join('@');
    const fleetUnit = 'whatsoup-fleet.service';
    const reenableCommand = `--user reenable ${agentUnit} ${fleetUnit}`;
    writeHealthProfile(profile);
    writeLinuxSetupShims(shimDir);
    fs.mkdirSync(staleTarget, { recursive: true });
    fs.mkdirSync(defaultTarget, { recursive: true });
    fs.writeFileSync(path.join(staleTarget, agentUnit), '');
    fs.writeFileSync(path.join(defaultTarget, fleetUnit), '');

    const result = runLinuxSetupReplay(home, shimDir, {
      BOT_ERRORS_HEALTH_PROFILE: profile,
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const systemctlLog = fs.readFileSync(path.join(home, 'systemctl.log'), 'utf8');
    expect(systemctlLog).toContain('--user daemon-reload');
    expect(systemctlLog).toContain(reenableCommand);
    expect(systemctlLog.indexOf('--user daemon-reload')).toBeLessThan(
      systemctlLog.indexOf(reenableCommand),
    );
    expect(result.stdout).toContain(`refreshed systemd enablement for ${agentUnit} ${fleetUnit}`);
  });

  it('Linux setup replay mirrors BOT_ERRORS_SOCKET when BOT_ERRORS_SOCKET_PATH is absent', () => {
    const home = makeTempRoot('whatsoup-setup-home-');
    const shimDir = makeTempRoot('whatsoup-setup-shims-');
    const profile = path.join(home, 'profiles', 'testhost.json');
    const socket = path.join(home, 'alias-only.sock');
    writeHealthProfile(profile);
    writeLinuxSetupShims(shimDir);

    const result = runLinuxSetupReplay(home, shimDir, {
      BOT_ERRORS_HEALTH_PROFILE: profile,
      BOT_ERRORS_SOCKET: socket,
      BOT_ERRORS_SOCKET_PATH: '',
    } as NodeJS.ProcessEnv);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const envFile = fs.readFileSync(path.join(home, '.config', 'whatsoup', 'bot-errors.env'), 'utf8');
    expect(envFile).toContain(`BOT_ERRORS_SOCKET_PATH=${socket}`);
    expect(envFile).toContain(`BOT_ERRORS_SOCKET=${socket}`);
  });

  it('Linux setup replay backfills missing BOT ERRORS keys in an existing private env file', () => {
    const home = makeTempRoot('whatsoup-setup-home-');
    const shimDir = makeTempRoot('whatsoup-setup-shims-');
    const existingSocket = path.join(home, 'existing.sock');
    const profile = path.join(home, 'profiles', 'testhost.json');
    const maliciousTouch = path.join(home, 'sourced-env-file');
    const envDir = path.join(home, '.config', 'whatsoup');
    const envPath = path.join(envDir, 'bot-errors.env');
    writeHealthProfile(profile);
    writeLinuxSetupShims(shimDir);
    fs.mkdirSync(envDir, { recursive: true });
    fs.writeFileSync(envPath, [
      'BOT_ERRORS_JID=120363555555555555@g.us',
      `BOT_ERRORS_SOCKET=${existingSocket}`,
      `MALICIOUS_TOUCH=$(touch ${maliciousTouch})`,
      '',
    ].join('\n'), 'utf8');

    const result = runLinuxSetupReplay(home, shimDir, {
      BOT_ERRORS_HEALTH_PROFILE: profile,
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const envFile = fs.readFileSync(envPath, 'utf8');
    expect(envFile.match(/^BOT_ERRORS_JID=/gm)).toHaveLength(1);
    expect(envFile.match(/^BOT_ERRORS_SOCKET=/gm)).toHaveLength(1);
    expect(envFile).toContain('BOT_ERRORS_JID=120363555555555555@g.us');
    expect(envFile).toContain('BOT_ERRORS_EXPECTED_JID=120363555555555555@g.us');
    expect(envFile).toContain(`BOT_ERRORS_SOCKET=${existingSocket}`);
    expect(envFile).toContain(`BOT_ERRORS_SOCKET_PATH=${existingSocket}`);
    expect(envFile).toContain(`BOT_ERRORS_DB=${path.join(home, '.local', 'share', 'whatsoup', 'instances', 'personal', 'bot.db')}`);
    expect(envFile).toContain(`BOT_ERRORS_HEALTH_PROFILE=${profile}`);
    expect(fs.existsSync(maliciousTouch)).toBe(false);
    expect(result.stdout).toContain('Existing BOT ERRORS routing config preserved');
  });

  it('Linux setup replay validates the persisted health profile when BOT ERRORS env already exists', () => {
    const home = makeTempRoot('whatsoup-setup-home-');
    const shimDir = makeTempRoot('whatsoup-setup-shims-');
    const envDir = path.join(home, '.config', 'whatsoup');
    const envPath = path.join(envDir, 'bot-errors.env');
    const persistedMissingProfile = path.join(home, 'profiles', 'persisted-missing.json');
    const processOnlyProfile = path.join(home, 'profiles', 'process-only.json');
    writeHealthProfile(processOnlyProfile);
    writeLinuxSetupShims(shimDir);
    fs.mkdirSync(envDir, { recursive: true });
    fs.writeFileSync(envPath, [
      'BOT_ERRORS_EXPECTED_JID=',
      `BOT_ERRORS_HEALTH_PROFILE=${persistedMissingProfile}`,
      '',
    ].join('\n'), 'utf8');

    const result = runLinuxSetupReplay(home, shimDir, {
      BOT_ERRORS_HEALTH_PROFILE: processOnlyProfile,
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('missing BOT_ERRORS_HEALTH_PROFILE; expected readable profile path');
    for (const unit of botErrorsSystemdUnits) {
      expect(fs.existsSync(path.join(home, '.config', 'systemd', 'user', unit))).toBe(false);
    }
    expect(result.stdout).not.toContain('BOT ERRORS service/timer units installed');
  });

  it('Linux setup replay stops before routing env creation when daemon-reload fails', () => {
    const home = makeTempRoot('whatsoup-setup-home-');
    const shimDir = makeTempRoot('whatsoup-setup-shims-');
    const profile = path.join(home, 'profiles', 'testhost.json');
    writeHealthProfile(profile);
    writeLinuxSetupShims(shimDir);

    const result = runLinuxSetupReplay(home, shimDir, {
      BOT_ERRORS_HEALTH_PROFILE: profile,
      SYSTEMCTL_DAEMON_RELOAD_EXIT: '42',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('systemctl --user daemon-reload failed after installing units');
    for (const unit of botErrorsSystemdUnits) {
      expect(
        fs.existsSync(path.join(home, '.config', 'systemd', 'user', unit)),
        `setup replay should have copied ${unit} before daemon-reload failed`,
      ).toBe(true);
    }
    expect(fs.existsSync(path.join(home, '.config', 'whatsoup', 'bot-errors.env'))).toBe(false);
    expect(result.stdout).not.toContain('Setup complete. Next steps:');
  });

  it('Linux setup replay stops before BOT ERRORS unit installation when the health profile is missing', () => {
    const home = makeTempRoot('whatsoup-setup-home-');
    const shimDir = makeTempRoot('whatsoup-setup-shims-');
    const missingProfile = path.join(home, 'profiles', 'missing.json');
    writeLinuxSetupShims(shimDir);

    const result = runLinuxSetupReplay(home, shimDir, {
      BOT_ERRORS_HEALTH_PROFILE: missingProfile,
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('missing BOT_ERRORS_HEALTH_PROFILE; expected readable profile path');
    for (const unit of botErrorsSystemdUnits) {
      expect(
        fs.existsSync(path.join(home, '.config', 'systemd', 'user', unit)),
        `setup replay should not copy ${unit} before validating the health profile`,
      ).toBe(false);
    }
    expect(fs.existsSync(path.join(home, '.config', 'whatsoup', 'bot-errors.env'))).toBe(false);
    expect(result.stdout).not.toContain('BOT ERRORS service/timer units installed');
  });
});

describe('deploy/setup.sh launchd timer packaging (macOS)', () => {
  const darwinTimerAnchor = '# --- darwin (macos launchd) timer install ---';
  const linuxUnitAnchor = '# --- linux (systemd) unit install ---';

  it('step 4 Darwin branch installs both maintenance timer plists to ~/Library/LaunchAgents', () => {
    const darwinTimerBlock = sliceBetween(setupSource, darwinTimerAnchor, linuxUnitAnchor);
    expect(darwinTimerBlock).toContain('com.whatsoup.harness-maintenance');
    expect(darwinTimerBlock).toContain('com.whatsoup.reply-guarantee');
    expect(darwinTimerBlock).toContain('Library/LaunchAgents');
  });

  it('duplicate-timer guard checks both an already-loaded launchd label and a cron twin', () => {
    const darwinTimerBlock = sliceBetween(setupSource, darwinTimerAnchor, linuxUnitAnchor);
    expect(darwinTimerBlock).toContain('launchctl list');
    expect(darwinTimerBlock).toContain('crontab -l');
  });

  it('backs up a differing pre-existing plist before overwriting (idempotent install)', () => {
    const darwinTimerBlock = sliceBetween(setupSource, darwinTimerAnchor, linuxUnitAnchor);
    expect(darwinTimerBlock).toContain('whatsoup-backup-');
    expect(darwinTimerBlock).toContain('cmp -s');
  });

  it('never executes launchd mutations — bootstrap/load guidance appears only in echoed output', () => {
    const mutation = /launchctl\s+(bootstrap|bootout|load|unload|enable|disable|kickstart|start|stop)\b/;
    for (const line of setupSource.split('\n')) {
      if (mutation.test(line)) {
        expect(
          /^\s*(echo|#)/.test(line),
          `launchctl mutation outside echo/comment: ${JSON.stringify(line)}`,
        ).toBe(true);
      }
    }
    // The deployment-step guidance itself must exist.
    expect(setupSource).toContain('launchctl bootstrap gui/');
  });

  it('the incomplete-packaging warning is replaced by the install', () => {
    expect(setupSource).not.toContain('not yet packaged');
  });

  it('documents and implements a --remove-timers uninstall flag', () => {
    const usageBlock = sliceBetween(setupSource, 'Usage: deploy/setup.sh', 'USAGE');
    expect(usageBlock).toContain('--remove-timers');
    expect(setupSource).toContain('"--remove-timers"');
    // Uninstall guidance must name the unload deployment step rather than run it.
    expect(setupSource).toContain('launchctl bootout gui/');
  });
});

describe('deploy launchd timer plists', () => {
  const harnessPlist = path.join(repoRoot, 'deploy', 'com.whatsoup.harness-maintenance.plist');
  const replyPlist = path.join(repoRoot, 'deploy', 'com.whatsoup.reply-guarantee.plist');
  const releaseDriftPlist = path.join(repoRoot, 'deploy', 'com.whatsoup.release-drift-check.plist');

  it('harness-maintenance plist fires daily at the systemd timer\'s OnCalendar time', () => {
    const plist = fs.readFileSync(harnessPlist, 'utf8');
    const timer = fs.readFileSync(path.join(repoRoot, 'deploy', 'harness-maintenance.timer'), 'utf8');
    const onCalendar = timer.match(/OnCalendar=\*-\*-\* (\d{2}):(\d{2}):\d{2}/);
    expect(onCalendar, 'harness-maintenance.timer OnCalendar must be parseable').not.toBeNull();
    const hour = Number(onCalendar![1]);
    const minute = Number(onCalendar![2]);
    expect(plist).toContain('<string>com.whatsoup.harness-maintenance</string>');
    expect(plist).toContain('<key>StartCalendarInterval</key>');
    expect(plist).toMatch(new RegExp(`<key>Hour</key>\\s*<integer>${hour}</integer>`));
    expect(plist).toMatch(new RegExp(`<key>Minute</key>\\s*<integer>${minute}</integer>`));
    expect(plist).toContain('deploy/scripts/harness-maintenance.sh');
  });

  it('reply-guarantee plist interval matches its systemd twin and execs the drain script', () => {
    const plist = fs.readFileSync(replyPlist, 'utf8');
    const timer = fs.readFileSync(path.join(repoRoot, 'deploy', 'whatsoup-reply-guarantee.timer'), 'utf8');
    const onActive = timer.match(/OnUnitActiveSec=(\d+)/);
    expect(onActive, 'whatsoup-reply-guarantee.timer OnUnitActiveSec must be parseable').not.toBeNull();
    expect(plist).toMatch(
      new RegExp(`<key>StartInterval</key>\\s*<integer>${onActive![1]}</integer>`),
    );
    expect(plist).toContain('deploy/scripts/reply-guarantee-drain.sh');
  });

  it('release-drift-check plist runs the manifest drift alert wrapper on an interval', () => {
    const plist = fs.readFileSync(releaseDriftPlist, 'utf8');
    expect(plist).toContain('<string>com.whatsoup.release-drift-check</string>');
    expect(plist).toContain('scripts/run-with-pinned-node.sh');
    expect(plist).toContain('scripts/live-release-drift-alert.ts');
    expect(plist).toContain('--launchd-plist');
    expect(plist).toContain('com.whatsoup.__INSTANCE__.plist');
    expect(plist).toContain('<string>__INSTANCE__</string>');
    expect(plist).toMatch(/<key>StartInterval<\/key>\s*<integer>300<\/integer>/);
  });

  it('pins RunAtLoad=false on all plists — no immediate fire on load', () => {
    for (const file of [harnessPlist, replyPlist, releaseDriftPlist]) {
      const plist = fs.readFileSync(file, 'utf8');
      expect(plist, `${path.basename(file)} must pin RunAtLoad=false`).toMatch(
        /<key>RunAtLoad<\/key>\s*<false\/>/,
      );
    }
  });

  it('plists use install-time placeholders, never machine-specific absolute paths', () => {
    for (const file of [harnessPlist, replyPlist, releaseDriftPlist]) {
      const plist = fs.readFileSync(file, 'utf8');
      // __TOKEN__ sentinels are the install-time placeholder convention the
      // service-unit validity guard recognizes; literal ${VAR} forms are
      // rejected because launchd never expands shell variables.
      expect(plist).toContain('__WHATSOUP_REPO_ROOT__');
      expect(plist).not.toMatch(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/);
      expect(plist).not.toMatch(/\/Users\/[^<\s]+|mwlab|anabot|nucles/i);
    }
  });

  // @skip-env plutil ships with macOS only; the ubuntu CI runner has no plist linter.
  it.skipIf(process.platform !== 'darwin')('both plists pass plutil -lint', () => {
    for (const file of [harnessPlist, replyPlist, releaseDriftPlist]) {
      const out = execFileSync('plutil', ['-lint', file], { encoding: 'utf8' });
      expect(out, `${path.basename(file)} failed plutil -lint`).toContain(': OK');
    }
  });
});
