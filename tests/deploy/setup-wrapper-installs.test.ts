import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const setupSource = fs.readFileSync(path.join(repoRoot, 'deploy', 'setup.sh'), 'utf8');

/** Wrapper names setup.sh symlinks into ~/.local/bin (`ln -sf "$REPO_ROOT/deploy/..." "$BIN_DIR/<name>"`). */
function installedWrappers(source: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /ln -sf "\$REPO_ROOT\/(deploy\/[^"]+)" "\$BIN_DIR\/([^"]+)"/g;
  for (const m of source.matchAll(re)) {
    out.set(m[2], m[1]);
  }
  return out;
}

describe('deploy/setup.sh wrapper installs', () => {
  const wrappers = installedWrappers(setupSource);

  it('parses at least the known wrapper set', () => {
    expect(wrappers.size).toBeGreaterThanOrEqual(5);
    expect(wrappers.get('whatsoup')).toBe('deploy/whatsoup');
  });

  it('every symlink target exists in the repo', () => {
    for (const [name, target] of wrappers) {
      expect(fs.existsSync(path.join(repoRoot, target)), `${name} → ${target} missing`).toBe(true);
    }
  });

  it('installs whatsoup-auth so credential pairing works on a fresh host', () => {
    expect(wrappers.get('whatsoup-auth')).toBe('deploy/whatsoup-auth');
  });

  it('installs whatsoup-heal-notify so the systemd unit does not hardcode a host path', () => {
    expect(wrappers.get('whatsoup-heal-notify')).toBe('deploy/scripts/heal-notify.sh');
  });
});
