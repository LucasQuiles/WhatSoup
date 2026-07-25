/**
 * #2292 L3 — an unreadable creds.json must not be reported as a missing one.
 *
 * `fileSnapshot` caught every failure and returned `exists:false`, so EACCES
 * and EIO arrived at the operator as "auth missing creds.json". The two demand
 * opposite responses: missing means re-pair (destructive), unreadable means fix
 * a mode or a disk. The module already states this rule for `isVanishedEntry`
 * ("ENOENT only, on purpose") — these pin it for the snapshot path too.
 *
 * Fixing `fileSnapshot` alone only MOVES the misattribution: with a real size
 * and a null hash, inspect() falls through to the JSON parse and reports
 * `creds_json_invalid_json`, and authTreeValidationError reports a hash
 * mismatch. Both consumers are therefore asserted here, not just the helper.
 *
 * Errors are injected as synthetic errnos rather than via chmod: CI frequently
 * runs as root, where mode bits are bypassed and a chmod-based test would pass
 * vacuously.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

type FsModule = typeof import('node:fs');

const actualFs = await vi.importActual<FsModule>('node:fs');

let tmpRoots: string[] = [];

afterEach(() => {
  vi.doUnmock('node:fs');
  vi.resetModules();
  for (const root of tmpRoots.splice(0)) actualFs.rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = actualFs.mkdtempSync(join(tmpdir(), 'whatsoup-auth-bond-unreadable-'));
  tmpRoots.push(root);
  return root;
}

function writeAuth(authDir: string): void {
  actualFs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
  actualFs.writeFileSync(join(authDir, 'creds.json'), JSON.stringify({
    me: { id: '15550100001:1@s.whatsapp.net', lid: '12345:1@lid' },
    registrationId: 1,
  }));
  actualFs.writeFileSync(join(authDir, 'app-state-sync-key-test.json'), JSON.stringify({ keyData: 'secret' }));
}

async function importGuardWithFsMock(overrides: (actual: FsModule) => Partial<FsModule>) {
  vi.resetModules();
  vi.doMock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<FsModule>();
    return { ...actual, ...overrides(actual) };
  });
  return import('../../src/transport/auth-bond.ts');
}

type GuardModule = typeof import('../../src/transport/auth-bond.ts');

function guardFor(root: string, authDir: string, mod: GuardModule) {
  return new mod.AuthBondGuard({
    authDir,
    stateRoot: join(root, 'state'),
    instanceName: 'unreadable-bot',
  });
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: injected`), { code });
}

describe('auth bond: unreadable is not missing (#2292 L3)', () => {
  it('keeps exists TRUE when lstat succeeded but the content read failed', async () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    writeAuth(authDir);
    const credsPath = join(authDir, 'creds.json');

    const mod = await importGuardWithFsMock((actual) => ({
      readFileSync: vi.fn(((path: Parameters<FsModule['readFileSync']>[0], ...rest: unknown[]) => {
        if (String(path) === credsPath) throw errno('EACCES');
        return (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
      })) as unknown as FsModule['readFileSync'],
    }));

    const snap = guardFor(root, authDir, mod).inspect();

    // The hash is the one field that genuinely could not be computed.
    expect(snap.creds.sha256).toBeNull();
    // ...but the metadata that DID succeed is kept, not discarded.
    expect(snap.creds.size).toBeGreaterThan(0);
    expect(snap.creds.mode).toBe('600');
    // lstat proved the file is there; the snapshot must not deny it.
    expect(snap.creds.exists).toBe(true);
    expect(snap.creds.error).toBe('EACCES');
  });

  it('classifies an unreadable creds.json as invalid, never as missing', async () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    writeAuth(authDir);
    const credsPath = join(authDir, 'creds.json');

    const mod = await importGuardWithFsMock((actual) => ({
      readFileSync: vi.fn(((path: Parameters<FsModule['readFileSync']>[0], ...rest: unknown[]) => {
        if (String(path) === credsPath) throw errno('EACCES');
        return (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
      })) as unknown as FsModule['readFileSync'],
    }));

    const snap = guardFor(root, authDir, mod).inspect();

    expect(snap.status).toBe('invalid');
    expect(snap.issues).toContain('creds_json_unreadable:EACCES');
    // The defect: "missing" sends an operator to re-pair over a permissions fault.
    expect(snap.issues).not.toContain('creds_json_missing');
  });

  // The consumer half. A fileSnapshot-only fix leaves a real size with a null
  // hash, which falls through to the JSON parse and lands here instead.
  it('does not relabel an unreadable creds.json as invalid JSON', async () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    writeAuth(authDir);
    const credsPath = join(authDir, 'creds.json');

    const mod = await importGuardWithFsMock((actual) => ({
      readFileSync: vi.fn(((path: Parameters<FsModule['readFileSync']>[0], ...rest: unknown[]) => {
        if (String(path) === credsPath) throw errno('EIO');
        return (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
      })) as unknown as FsModule['readFileSync'],
    }));

    const snap = guardFor(root, authDir, mod).inspect();

    expect(snap.issues).toContain('creds_json_unreadable:EIO');
    expect(snap.issues).not.toContain('creds_json_invalid_json');
    expect(snap.issues).not.toContain('creds_json_empty');
  });

  // The OTHER failure point. Above, lstat succeeded and the read failed; here
  // lstat itself fails, so existence was never established — `exists` stays
  // false, but with an errno, which is what separates it from plain absence.
  it('marks a non-ENOENT lstat failure unreadable rather than missing', async () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    writeAuth(authDir);
    const credsPath = join(authDir, 'creds.json');

    const mod = await importGuardWithFsMock((actual) => ({
      lstatSync: vi.fn(((path: Parameters<FsModule['lstatSync']>[0]) => {
        if (String(path) === credsPath) throw errno('EACCES');
        return (actual.lstatSync as (...a: unknown[]) => unknown)(path);
      })) as unknown as FsModule['lstatSync'],
    }));

    const snap = guardFor(root, authDir, mod).inspect();

    expect(snap.creds.exists).toBe(false);
    expect(snap.creds.error).toBe('EACCES');
    expect(snap.status).toBe('invalid');
    expect(snap.issues).toContain('creds_json_unreadable:EACCES');
    expect(snap.issues).not.toContain('creds_json_missing');
  });

  it('still reports a genuinely absent creds.json as missing, with no error', async () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    writeAuth(authDir);
    actualFs.rmSync(join(authDir, 'creds.json'));

    const mod = await importGuardWithFsMock(() => ({}));
    const snap = guardFor(root, authDir, mod).inspect();

    // ENOENT is still plain absence — the fix must not turn every absence into
    // an error, or the distinction it adds would be worthless.
    expect(snap.creds.exists).toBe(false);
    expect(snap.creds.error).toBeNull();
    expect(snap.status).toBe('missing');
    expect(snap.issues).toContain('creds_json_missing');
  });

  // The SECOND consumer. capture() validates the staged copy; with a null hash
  // and no unreadable branch, the comparison reports a hash mismatch — i.e.
  // "your copy is corrupt" for what is actually a permissions fault. Only the
  // staged copy is blocked here, so the source tree stays readable.
  it('does not relabel an unreadable staged copy as a hash mismatch', async () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    writeAuth(authDir);

    const mod = await importGuardWithFsMock((actual) => ({
      readFileSync: vi.fn(((path: Parameters<FsModule['readFileSync']>[0], ...rest: unknown[]) => {
        const p = String(path);
        if (p.includes(`${'staging'}/`) && p.endsWith('creds.json')) throw errno('EACCES');
        return (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
      })) as unknown as FsModule['readFileSync'],
    }));

    const result = guardFor(root, authDir, mod).capture('unreadable-copy');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('unreadable');
    expect(result.error).toContain('EACCES');
    expect(result.error).not.toContain('hash mismatch');
  });

  it('reports a readable creds.json with a null error', async () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    writeAuth(authDir);

    const mod = await importGuardWithFsMock(() => ({}));
    const snap = guardFor(root, authDir, mod).inspect();

    expect(snap.creds.error).toBeNull();
    expect(snap.authDir.error).toBeNull();
    expect(snap.creds.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(snap.status).toBe('present');
  });
});
