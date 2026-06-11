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
