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
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const setupSource = fs.readFileSync(path.join(repoRoot, 'deploy', 'setup.sh'), 'utf8');

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

  it('pins RunAtLoad=false on both plists — no immediate fire on load', () => {
    for (const file of [harnessPlist, replyPlist]) {
      const plist = fs.readFileSync(file, 'utf8');
      expect(plist, `${path.basename(file)} must pin RunAtLoad=false`).toMatch(
        /<key>RunAtLoad<\/key>\s*<false\/>/,
      );
    }
  });

  it('plists use install-time placeholders, never machine-specific absolute paths', () => {
    for (const file of [harnessPlist, replyPlist]) {
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
    for (const file of [harnessPlist, replyPlist]) {
      const out = execFileSync('plutil', ['-lint', file], { encoding: 'utf8' });
      expect(out, `${path.basename(file)} failed plutil -lint`).toContain(': OK');
    }
  });
});
