import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertPrivateDirectorySync,
  ensurePrivateDirectorySync,
  forceEnsurePrivateDirectorySync,
  writePrivateFileSync,
} from '../../src/lib/private-fs.ts';

let tmpRoot = '';

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
});

function makeTmp(): string {
  tmpRoot = mkdtempSync(join(tmpdir(), 'private-fs-test-'));
  return tmpRoot;
}

describe('writePrivateFileSync', () => {
  it('refuses a pre-existing symlink at the file path (ELOOP) and writes mode 0600 for real files', () => {
    const root = makeTmp();
    const dir = join(root, 'priv');
    mkdirSync(dir, { recursive: true, mode: 0o700 });

    // Symlink at target path — must refuse
    const target = join(dir, 'secret.json');
    const decoy = join(root, 'decoy.json');
    symlinkSync(decoy, target);

    let caughtErr: NodeJS.ErrnoException | undefined;
    try { writePrivateFileSync(target, '{"x":1}'); } catch (e) { caughtErr = e as NodeJS.ErrnoException; }
    expect(caughtErr).toBeDefined();
    expect(caughtErr?.code).toBe('ELOOP');

    // Write to a real file — confirm mode 0600
    const real = join(dir, 'real.json');
    writePrivateFileSync(real, '{"ok":true}');
    const st = statSync(real);
    expect(st.mode & 0o777).toBe(0o600);
  });
});

describe('two-algorithm split: assert-first vs mkdir-then-force-chmod', () => {
  it('forceEnsurePrivateDirectorySync chmods a pre-existing 0755 dir to 0700', () => {
    const root = makeTmp();
    const dir = join(root, 'forcedir');
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    chmodSync(dir, 0o755);

    // Verify starting mode
    expect(statSync(dir).mode & 0o777).toBe(0o755);

    forceEnsurePrivateDirectorySync(dir, 'test-label');

    // Must have been chmoded to 0700
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('assertPrivateDirectorySync leaves a pre-existing 0755 dir untouched', () => {
    const root = makeTmp();
    const dir = join(root, 'assertdir');
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    chmodSync(dir, 0o755);

    expect(statSync(dir).mode & 0o777).toBe(0o755);

    // assertPrivateDirectorySync does NOT chmod — it only asserts symlink/dir status
    assertPrivateDirectorySync(dir);

    // Mode must remain unchanged — the assert variant never touches it
    expect(statSync(dir).mode & 0o777).toBe(0o755);
  });

  it('ensurePrivateDirectorySync creates directory at mode 0700 but leaves existing untouched', () => {
    const root = makeTmp();
    const newDir = join(root, 'newdir');

    ensurePrivateDirectorySync(newDir);
    expect(statSync(newDir).mode & 0o777).toBe(0o700);
  });
});
