/**
 * Version-resilient plugin-dir resolution.
 *
 * A pinned plugin version dir (e.g. .../superpowers/5.0.7) disappears after
 * `claude plugin update`. resolveLatestPluginDir substitutes the highest
 * existing semver sibling so the `--plugin-dir` flag does not point at a gone
 * directory. Uses real temp directories (no fs mocks) per repo convention.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveLatestPluginDir } from '../../../src/runtimes/agent/plugin-dir-resolver.ts';

describe('resolveLatestPluginDir', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plugin-dir-resolver-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns an existing directory unchanged', () => {
    const dir = join(root, 'superpowers', '5.0.7');
    mkdirSync(dir, { recursive: true });
    expect(resolveLatestPluginDir(dir)).toBe(dir);
  });

  it('substitutes the highest semver sibling when the pinned version is gone', () => {
    const base = join(root, 'superpowers');
    mkdirSync(join(base, '5.0.7'), { recursive: true });
    mkdirSync(join(base, '5.1.0'), { recursive: true });
    mkdirSync(join(base, '4.9.9'), { recursive: true });
    // Pin a now-missing version.
    const pinned = join(base, '5.0.6');
    expect(resolveLatestPluginDir(pinned)).toBe(join(base, '5.1.0'));
  });

  it('compares numeric components, not lexicographically (5.10.0 > 5.9.0)', () => {
    const base = join(root, 'p');
    mkdirSync(join(base, '5.9.0'), { recursive: true });
    mkdirSync(join(base, '5.10.0'), { recursive: true });
    expect(resolveLatestPluginDir(join(base, '5.0.0'))).toBe(join(base, '5.10.0'));
  });

  it('returns the original when no version-like siblings exist', () => {
    const base = join(root, 'p');
    mkdirSync(join(base, 'stable'), { recursive: true });
    const pinned = join(base, '5.0.7');
    expect(resolveLatestPluginDir(pinned)).toBe(pinned);
  });

  it('returns the original when the parent does not exist', () => {
    const pinned = join(root, 'nope', '5.0.7');
    expect(resolveLatestPluginDir(pinned)).toBe(pinned);
  });

  it('does not substitute when the missing leaf is not version-like', () => {
    const base = join(root, 'p');
    mkdirSync(join(base, '5.1.0'), { recursive: true });
    const pinned = join(base, 'latest');
    expect(resolveLatestPluginDir(pinned)).toBe(pinned);
  });

  it('ignores non-directory siblings that look like versions', () => {
    const base = join(root, 'p');
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, '9.9.9'), 'not a dir');
    mkdirSync(join(base, '5.1.0'), { recursive: true });
    expect(resolveLatestPluginDir(join(base, '5.0.0'))).toBe(join(base, '5.1.0'));
  });
});
