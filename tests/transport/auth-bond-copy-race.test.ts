import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

type FsModule = typeof import('node:fs');

const actualFs = await vi.importActual<FsModule>('node:fs');

const tmp = trackTmpDirs('');

afterEach(() => {
  vi.doUnmock('node:fs');
  vi.resetModules();
});

function makeRoot(): string {
  return tmp.make('whatsoup-auth-bond-copy-race');
}

function writeAuth(authDir: string, id = '15550100001:1@s.whatsapp.net'): void {
  actualFs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
  actualFs.writeFileSync(join(authDir, 'creds.json'), JSON.stringify({
    me: { id, lid: '12345:1@lid' },
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

describe('AuthBondGuard snapshot copy races', () => {
  it('retries a valid same-identity auth tree change that lands while copying', async () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    const keyPath = join(authDir, 'app-state-sync-key-test.json');
    writeAuth(authDir, '15550100061:1@s.whatsapp.net');
    let mutationCount = 0;

    const { AuthBondGuard } = await importGuardWithFsMock((actual) => ({
      copyFileSync: vi.fn((src: Parameters<FsModule['copyFileSync']>[0], dest: Parameters<FsModule['copyFileSync']>[1]) => {
        if (String(src) === keyPath && mutationCount === 0) {
          mutationCount += 1;
          actual.writeFileSync(keyPath, JSON.stringify({ keyData: 'rotated-key' }));
        }
        return actual.copyFileSync(src, dest);
      }) as FsModule['copyFileSync'],
    }));

    const result = new AuthBondGuard({
      authDir,
      stateRoot,
      instanceName: 'valid-copy-race-bot',
      captureAttempts: 2,
      captureRetryDelayMs: 0,
      now: () => new Date('2026-06-09T12:00:00Z'),
    }).capture('connection-open');

    expect(mutationCount).toBe(1);
    expect(result).toMatchObject({ ok: true, captured: true, deferred: false, error: null });
    expect(JSON.parse(actualFs.readFileSync(join(result.path!, 'auth', 'app-state-sync-key-test.json'), 'utf8'))).toEqual({
      keyData: 'rotated-key',
    });
    expect(actualFs.readdirSync(join(stateRoot, 'auth-bond-backups', 'valid-copy-race-bot', 'history'))).toHaveLength(1);
    expect(actualFs.readdirSync(join(stateRoot, 'auth-bond-backups', 'valid-copy-race-bot', 'staging'))).toEqual([]);
  });

  it('retries a valid same-identity creds rotation that lands while copying', async () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    const credsPath = join(authDir, 'creds.json');
    const id = '15550100066:1@s.whatsapp.net';
    writeAuth(authDir, id);
    let mutationCount = 0;

    const { AuthBondGuard } = await importGuardWithFsMock((actual) => ({
      copyFileSync: vi.fn((src: Parameters<FsModule['copyFileSync']>[0], dest: Parameters<FsModule['copyFileSync']>[1]) => {
        if (String(src) === credsPath && mutationCount === 0) {
          mutationCount += 1;
          actual.writeFileSync(credsPath, JSON.stringify({
            me: { id, lid: '12345:1@lid' },
            registrationId: 2,
          }));
        }
        return actual.copyFileSync(src, dest);
      }) as FsModule['copyFileSync'],
    }));

    const result = new AuthBondGuard({
      authDir,
      stateRoot,
      instanceName: 'same-identity-creds-copy-race-bot',
      captureAttempts: 2,
      captureRetryDelayMs: 0,
      now: () => new Date('2026-06-09T12:00:00Z'),
    }).capture('connection-open');

    expect(mutationCount).toBe(1);
    expect(result).toMatchObject({ ok: true, captured: true, deferred: false, error: null });
    expect(JSON.parse(actualFs.readFileSync(join(result.path!, 'auth', 'creds.json'), 'utf8'))).toMatchObject({
      me: { id, lid: '12345:1@lid' },
      registrationId: 2,
    });
    expect(actualFs.readdirSync(join(stateRoot, 'auth-bond-backups', 'same-identity-creds-copy-race-bot', 'history'))).toHaveLength(1);
    expect(actualFs.readdirSync(join(stateRoot, 'auth-bond-backups', 'same-identity-creds-copy-race-bot', 'staging'))).toEqual([]);
  });

  it('returns deferred after the configured attempts when a valid auth tree keeps changing while copying', async () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    const keyPath = join(authDir, 'app-state-sync-key-test.json');
    writeAuth(authDir, '15550100062:1@s.whatsapp.net');
    let mutationCount = 0;
    let shouldChurn = false;

    const { AuthBondGuard } = await importGuardWithFsMock((actual) => ({
      copyFileSync: vi.fn((src: Parameters<FsModule['copyFileSync']>[0], dest: Parameters<FsModule['copyFileSync']>[1]) => {
        if (shouldChurn && String(src) === keyPath) {
          mutationCount += 1;
          actual.writeFileSync(keyPath, JSON.stringify({ keyData: `rotated-key-${mutationCount}` }));
        }
        return actual.copyFileSync(src, dest);
      }) as FsModule['copyFileSync'],
    }));

    const guard = new AuthBondGuard({
      authDir,
      stateRoot,
      instanceName: 'churning-copy-race-bot',
      captureAttempts: 2,
      captureRetryDelayMs: 0,
      now: () => new Date('2026-06-09T12:00:00Z'),
    });
    const initial = guard.capture('connection-open');
    expect(initial).toMatchObject({ ok: true, captured: true });
    const latestPath = join(stateRoot, 'auth-bond-backups', 'churning-copy-race-bot', 'latest.json');
    const latestBefore = actualFs.readFileSync(latestPath, 'utf8');

    actualFs.writeFileSync(keyPath, JSON.stringify({ keyData: 'new-source-key' }));
    shouldChurn = true;
    const result = guard.capture('creds-update');

    expect(mutationCount).toBe(2);
    expect(result).toMatchObject({ ok: false, captured: false, deferred: true, path: null });
    expect(actualFs.readFileSync(latestPath, 'utf8')).toBe(latestBefore);
    expect(actualFs.readdirSync(join(stateRoot, 'auth-bond-backups', 'churning-copy-race-bot', 'history'))).toHaveLength(1);
    expect(actualFs.readdirSync(join(stateRoot, 'auth-bond-backups', 'churning-copy-race-bot', 'staging'))).toEqual([]);
  });

  it('keeps the latest snapshot when a stable source produces a corrupted copied tree', async () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    const keyPath = join(authDir, 'app-state-sync-key-test.json');
    writeAuth(authDir, '15550100063:1@s.whatsapp.net');
    let corruptCopiedKey = false;
    let corruptCopyCount = 0;

    const { AuthBondGuard } = await importGuardWithFsMock((actual) => ({
      copyFileSync: vi.fn((src: Parameters<FsModule['copyFileSync']>[0], dest: Parameters<FsModule['copyFileSync']>[1]) => {
        actual.copyFileSync(src, dest);
        if (corruptCopiedKey && String(src) === keyPath) {
          corruptCopyCount += 1;
          actual.writeFileSync(dest, JSON.stringify({ keyData: 'corrupted-copy' }));
        }
      }) as FsModule['copyFileSync'],
    }));

    const guard = new AuthBondGuard({
      authDir,
      stateRoot,
      instanceName: 'stable-corrupt-copy-bot',
      captureAttempts: 2,
      captureRetryDelayMs: 0,
      now: () => new Date('2026-06-09T12:00:00Z'),
    });
    const initial = guard.capture('connection-open');
    expect(initial).toMatchObject({ ok: true, captured: true });
    const latestPath = join(stateRoot, 'auth-bond-backups', 'stable-corrupt-copy-bot', 'latest.json');
    const latestBefore = actualFs.readFileSync(latestPath, 'utf8');

    actualFs.writeFileSync(keyPath, JSON.stringify({ keyData: 'new-source-key' }));
    corruptCopiedKey = true;
    const result = guard.capture('creds-update');

    expect(corruptCopyCount).toBe(1);
    expect(result).toMatchObject({ ok: false, captured: false, deferred: false, path: null });
    expect(result.error).toContain('copied auth tree hash mismatch');
    expect(actualFs.readFileSync(latestPath, 'utf8')).toBe(latestBefore);
    expect(actualFs.readdirSync(join(stateRoot, 'auth-bond-backups', 'stable-corrupt-copy-bot', 'history'))).toHaveLength(1);
    expect(actualFs.readdirSync(join(stateRoot, 'auth-bond-backups', 'stable-corrupt-copy-bot', 'staging'))).toEqual([]);
  });

  it('does not defer copied creds corruption when only a source key changes while copying', async () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    const credsPath = join(authDir, 'creds.json');
    const keyPath = join(authDir, 'app-state-sync-key-test.json');
    writeAuth(authDir, '15550100067:1@s.whatsapp.net');
    let corruptCopiedCreds = false;
    let corruptionCount = 0;

    const { AuthBondGuard } = await importGuardWithFsMock((actual) => ({
      copyFileSync: vi.fn((src: Parameters<FsModule['copyFileSync']>[0], dest: Parameters<FsModule['copyFileSync']>[1]) => {
        actual.copyFileSync(src, dest);
        if (corruptCopiedCreds && String(src) === credsPath) {
          corruptionCount += 1;
          actual.writeFileSync(dest, JSON.stringify({
            me: { id: '15550100067:1@s.whatsapp.net', lid: '12345:1@lid' },
            registrationId: 999,
          }));
          actual.writeFileSync(keyPath, JSON.stringify({ keyData: 'source-key-after-snapshot' }));
        }
      }) as FsModule['copyFileSync'],
    }));

    const guard = new AuthBondGuard({
      authDir,
      stateRoot,
      instanceName: 'corrupt-creds-source-key-change-bot',
      captureAttempts: 2,
      captureRetryDelayMs: 0,
      now: () => new Date('2026-06-09T12:00:00Z'),
    });
    const initial = guard.capture('connection-open');
    expect(initial).toMatchObject({ ok: true, captured: true });
    const latestPath = join(stateRoot, 'auth-bond-backups', 'corrupt-creds-source-key-change-bot', 'latest.json');
    const latestBefore = actualFs.readFileSync(latestPath, 'utf8');

    actualFs.writeFileSync(keyPath, JSON.stringify({ keyData: 'source-key-before-copy' }));
    corruptCopiedCreds = true;
    const result = guard.capture('creds-update');

    expect(corruptionCount).toBe(1);
    expect(result).toMatchObject({ ok: false, captured: false, deferred: false, path: null });
    expect(result.error).toContain('copied creds.json hash mismatch');
    expect(actualFs.readFileSync(latestPath, 'utf8')).toBe(latestBefore);
    expect(actualFs.readdirSync(join(stateRoot, 'auth-bond-backups', 'corrupt-creds-source-key-change-bot', 'history'))).toHaveLength(1);
    expect(actualFs.readdirSync(join(stateRoot, 'auth-bond-backups', 'corrupt-creds-source-key-change-bot', 'staging'))).toEqual([]);
  });

  it('does not defer when the source credentials change to another identity while copying', async () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    const credsPath = join(authDir, 'creds.json');
    writeAuth(authDir, '15550100064:1@s.whatsapp.net');
    let identityChangeCount = 0;

    const { AuthBondGuard } = await importGuardWithFsMock((actual) => ({
      copyFileSync: vi.fn((src: Parameters<FsModule['copyFileSync']>[0], dest: Parameters<FsModule['copyFileSync']>[1]) => {
        if (String(src) === credsPath && identityChangeCount === 0) {
          identityChangeCount += 1;
          actual.writeFileSync(credsPath, JSON.stringify({
            me: { id: '15550100065:1@s.whatsapp.net', lid: '12345:1@lid' },
            registrationId: 1,
          }));
        }
        return actual.copyFileSync(src, dest);
      }) as FsModule['copyFileSync'],
    }));

    const result = new AuthBondGuard({
      authDir,
      stateRoot,
      instanceName: 'identity-copy-race-bot',
      captureAttempts: 2,
      captureRetryDelayMs: 0,
      now: () => new Date('2026-06-09T12:00:00Z'),
    }).capture('connection-open');

    expect(identityChangeCount).toBe(1);
    expect(result).toMatchObject({ ok: false, captured: false, deferred: false, path: null });
    expect(result.error).toContain('copied creds.json hash mismatch');
    expect(actualFs.readdirSync(join(stateRoot, 'auth-bond-backups', 'identity-copy-race-bot', 'history'))).toEqual([]);
  });

});
