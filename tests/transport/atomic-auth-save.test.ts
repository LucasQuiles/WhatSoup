import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeAtomicBaileysJson } from '../../src/transport/atomic-auth-save.ts';

const roots = new Set<string>();

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'whatsoup-atomic-auth-'));
  roots.add(root);
  return root;
}

afterEach(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
  roots.clear();
});

describe('writeAtomicBaileysJson', () => {
  it('writes creds with private directory and file modes and no temp leftovers', async () => {
    const authDir = tempRoot();
    chmodSync(authDir, 0o755);
    const credsPath = join(authDir, 'creds.json');

    await writeAtomicBaileysJson(credsPath, {
      me: { id: '15551230004:1@s.whatsapp.net' },
      registrationId: 42,
    });

    expect(JSON.parse(readFileSync(credsPath, 'utf8'))).toMatchObject({
      me: { id: '15551230004:1@s.whatsapp.net' },
      registrationId: 42,
    });
    expect(statSync(authDir).mode & 0o777).toBe(0o700);
    expect(statSync(credsPath).mode & 0o777).toBe(0o600);
    expect(readdirSync(authDir).filter((entry) => entry.includes('.tmp'))).toEqual([]);
  });

  it('refuses to write creds through a symlinked target', async () => {
    const authDir = tempRoot();
    const outside = join(tempRoot(), 'outside-creds.json');
    writeFileSync(outside, 'unchanged\n', { mode: 0o600 });
    symlinkSync(outside, join(authDir, 'creds.json'));

    await expect(writeAtomicBaileysJson(join(authDir, 'creds.json'), { registrationId: 1 }))
      .rejects.toThrow(/symlink/);

    expect(readFileSync(outside, 'utf8')).toBe('unchanged\n');
    expect(lstatSync(join(authDir, 'creds.json')).isSymbolicLink()).toBe(true);
  });

  it('refuses to write creds through a symlinked auth directory', async () => {
    const root = tempRoot();
    const realAuthDir = join(root, 'real-auth');
    const linkAuthDir = join(root, 'auth-link');
    rmSync(realAuthDir, { recursive: true, force: true });
    rmSync(linkAuthDir, { force: true });
    writeFileSync(realAuthDir, 'not a directory yet');
    rmSync(realAuthDir, { force: true });
    symlinkSync(tempRoot(), linkAuthDir, 'dir');

    await expect(writeAtomicBaileysJson(join(linkAuthDir, 'creds.json'), { registrationId: 1 }))
      .rejects.toThrow(/auth directory.*symlink/);

    expect(existsSync(join(linkAuthDir, 'creds.json'))).toBe(false);
  });
});
