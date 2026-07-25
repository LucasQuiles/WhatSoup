import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
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
  const root = actualFs.mkdtempSync(join(tmpdir(), 'whatsoup-auth-bond-fs-errors-'));
  tmpRoots.push(root);
  return root;
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

describe('AuthBondGuard filesystem error paths', () => {
  it('records hardening issues when stat, chmod, and readdir fail', async () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const credsPath = join(authDir, 'creds.json');
    const blockedDir = join(authDir, 'blocked');
    const missingStatPath = join(authDir, 'missing-stat.json');
    writeAuth(authDir);
    actualFs.chmodSync(credsPath, 0o644);
    actualFs.mkdirSync(blockedDir, { mode: 0o700 });
    actualFs.symlinkSync(credsPath, join(authDir, 'creds-link.json'));

    const { AuthBondGuard } = await importGuardWithFsMock((actual) => ({
      lstatSync: vi.fn((path: Parameters<FsModule['lstatSync']>[0]) => {
        if (String(path) === missingStatPath) throw new Error('stat boom');
        return actual.lstatSync(path);
      }) as unknown as FsModule['lstatSync'],
      chmodSync: vi.fn((path: Parameters<FsModule['chmodSync']>[0], mode: number) => {
        if (String(path) === credsPath) throw new Error('chmod boom');
        return actual.chmodSync(path, mode);
      }) as FsModule['chmodSync'],
      readdirSync: vi.fn((path: Parameters<FsModule['readdirSync']>[0], options?: Parameters<FsModule['readdirSync']>[1]) => {
        if (String(path) === authDir) {
          return [...actual.readdirSync(path) as string[], basename(missingStatPath)];
        }
        if (String(path) === blockedDir) throw new Error('readdir boom');
        return actual.readdirSync(path, options as any) as any;
      }) as unknown as FsModule['readdirSync'],
    }));

    const snapshot = new AuthBondGuard({ authDir, stateRoot: join(root, 'state'), instanceName: 'fs-hardening-bot' }).inspect();

    expect(snapshot.status).toBe('invalid');
    expect(snapshot.issues).toEqual(expect.arrayContaining([
      expect.stringContaining('auth_mode_stat_failed:missing-stat.json:stat boom'),
      expect.stringContaining('auth_mode_chmod_failed:creds.json:chmod boom'),
      expect.stringContaining('auth_mode_readdir_failed:blocked:readdir boom'),
      expect.stringContaining('auth_tree_symlink:creds-link.json'),
    ]));
  });

  it('covers root hardening labels and root readdir failures', async () => {
    const statRoot = makeRoot();
    const statAuthDir = join(statRoot, 'auth');
    writeAuth(statAuthDir);
    {
      const { AuthBondGuard } = await importGuardWithFsMock((actual) => ({
        lstatSync: vi.fn((path: Parameters<FsModule['lstatSync']>[0]) => {
          if (String(path) === statAuthDir) throw 'root stat string';
          return actual.lstatSync(path);
        }) as unknown as FsModule['lstatSync'],
      }));
      expect(new AuthBondGuard({
        authDir: statAuthDir,
        stateRoot: join(statRoot, 'state'),
        instanceName: 'root-stat-bot',
      }).inspect().issues).toEqual(expect.arrayContaining([
        'auth_mode_stat_failed:.:root stat string',
      ]));
    }

    const chmodRoot = makeRoot();
    const chmodAuthDir = join(chmodRoot, 'auth');
    writeAuth(chmodAuthDir);
    actualFs.chmodSync(chmodAuthDir, 0o755);
    {
      const { AuthBondGuard } = await importGuardWithFsMock((actual) => ({
        chmodSync: vi.fn((path: Parameters<FsModule['chmodSync']>[0], mode: number) => {
          if (String(path) === chmodAuthDir) throw 'root chmod string';
          return actual.chmodSync(path, mode);
        }) as FsModule['chmodSync'],
      }));
      expect(new AuthBondGuard({
        authDir: chmodAuthDir,
        stateRoot: join(chmodRoot, 'state'),
        instanceName: 'root-chmod-bot',
      }).inspect().issues).toEqual(expect.arrayContaining([
        'auth_mode_chmod_failed:.:root chmod string',
      ]));
    }

    const readdirRoot = makeRoot();
    const readdirAuthDir = join(readdirRoot, 'auth');
    writeAuth(readdirAuthDir);
    {
      let readdirCalls = 0;
      const { AuthBondGuard } = await importGuardWithFsMock((actual) => ({
        readdirSync: vi.fn((path: Parameters<FsModule['readdirSync']>[0], options?: Parameters<FsModule['readdirSync']>[1]) => {
          if (String(path) === readdirAuthDir) {
            readdirCalls += 1;
            throw 'root readdir string';
          }
          return actual.readdirSync(path, options as any) as any;
        }) as unknown as FsModule['readdirSync'],
      }));
      const guard = new AuthBondGuard({
        authDir: readdirAuthDir,
        stateRoot: join(readdirRoot, 'state'),
        instanceName: 'root-readdir-bot',
      });

      expect(() => guard.inspect()).toThrow('root readdir string');
      expect(readdirCalls).toBeGreaterThanOrEqual(1);
    }
  });

  it('cleans up temporary backup state when durable manifest writing fails', async () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    writeAuth(authDir);
    let fsyncCalls = 0;

    const { AuthBondGuard } = await importGuardWithFsMock((actual) => ({
      fsyncSync: vi.fn((fd: number) => {
        fsyncCalls += 1;
        if (fsyncCalls === 1) throw 'fsync boom';
        return actual.fsyncSync(fd);
      }) as FsModule['fsyncSync'],
    }));

    const guard = new AuthBondGuard({
      authDir,
      stateRoot,
      instanceName: 'manifest-fsync-bot',
      now: () => new Date('2026-06-09T12:00:00Z'),
    });
    const result = guard.capture('connection-open');

    expect(result).toMatchObject({ ok: false, captured: false, path: null });
    expect(result.error).toContain('fsync boom');
    expect(actualFs.readdirSync(join(stateRoot, 'auth-bond-backups', 'manifest-fsync-bot', 'history'))).toEqual([]);
  });

  it('tolerates directory fsync open failures while writing backup metadata', async () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    writeAuth(authDir);
    let directoryOpenFailures = 0;

    const { AuthBondGuard } = await importGuardWithFsMock((actual) => ({
      openSync: vi.fn((path: Parameters<FsModule['openSync']>[0], flags: Parameters<FsModule['openSync']>[1], mode?: Parameters<FsModule['openSync']>[2]) => {
        if (flags === 'r' && String(path).includes(`${join('auth-bond-backups', 'dir-fsync-bot')}`)) {
          directoryOpenFailures += 1;
          throw 'dir open string';
        }
        return actual.openSync(path, flags, mode as any);
      }) as unknown as FsModule['openSync'],
    }));

    const result = new AuthBondGuard({
      authDir,
      stateRoot,
      instanceName: 'dir-fsync-bot',
      now: () => new Date('2026-06-09T12:00:00Z'),
    }).capture('connection-open');

    expect(result).toMatchObject({ ok: true, captured: true, error: null });
    expect(directoryOpenFailures).toBeGreaterThanOrEqual(1);
    expect(actualFs.existsSync(join(result.path!, 'manifest.json'))).toBe(true);
    expect(actualFs.existsSync(join(stateRoot, 'auth-bond-backups', 'dir-fsync-bot', 'latest.json'))).toBe(true);
  });

  it('defers capture when credentials change while the auth tree is being copied', async () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    writeAuth(authDir, '15550100060:1@s.whatsapp.net');

    const { AuthBondGuard } = await importGuardWithFsMock((actual) => ({
      copyFileSync: vi.fn((src: Parameters<FsModule['copyFileSync']>[0], dest: Parameters<FsModule['copyFileSync']>[1]) => {
        actual.copyFileSync(src, dest);
        if (basename(String(src)) === 'creds.json') {
          actual.writeFileSync(dest, '{ bad json');
          actual.writeFileSync(src, '');
        }
      }) as FsModule['copyFileSync'],
    }));

    const guard = new AuthBondGuard({
      authDir,
      stateRoot,
      instanceName: 'copy-race-bot',
      captureAttempts: 1,
      freshInvalidGraceMs: 60_000,
      now: () => new Date('2026-06-09T12:00:00Z'),
    });

    const result = guard.capture('creds-update');

    expect(result).toMatchObject({ ok: false, captured: false, deferred: true, path: null });
    expect(result.error).toContain('auth bond changed during capture');
    expect(actualFs.readdirSync(join(stateRoot, 'auth-bond-backups', 'copy-race-bot', 'history'))).toEqual([]);
  });

  it('throws when an auth tree entry becomes a symlink during hashing', async () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const credsPath = join(authDir, 'creds.json');
    const linkPath = join(authDir, 'late-symlink.json');
    writeAuth(authDir, '15550100064:1@s.whatsapp.net');
    actualFs.symlinkSync(credsPath, linkPath);
    let linkStatsCalls = 0;

    const { AuthBondGuard } = await importGuardWithFsMock((actual) => ({
      lstatSync: vi.fn((path: Parameters<FsModule['lstatSync']>[0]) => {
        if (String(path) === linkPath) {
          linkStatsCalls += 1;
          if (linkStatsCalls === 1) return actual.lstatSync(credsPath);
        }
        return actual.lstatSync(path);
      }) as unknown as FsModule['lstatSync'],
    }));

    const guard = new AuthBondGuard({ authDir, stateRoot: join(root, 'state'), instanceName: 'hash-race-bot' });

    expect(() => guard.inspect()).toThrow(/refusing to walk auth tree containing symlink/);
  });

  it('refuses capture when an auth tree entry becomes a symlink during copy', async () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    const credsPath = join(authDir, 'creds.json');
    const linkPath = join(root, 'copy-race-link');
    writeAuth(authDir, '15550100065:1@s.whatsapp.net');
    actualFs.symlinkSync(credsPath, linkPath);
    const symlinkStats = actualFs.lstatSync(linkPath);
    let credsStatsCalls = 0;

    const { AuthBondGuard } = await importGuardWithFsMock((actual) => ({
      lstatSync: vi.fn((path: Parameters<FsModule['lstatSync']>[0]) => {
        if (String(path) === credsPath) {
          credsStatsCalls += 1;
          if (credsStatsCalls >= 4) return symlinkStats;
        }
        return actual.lstatSync(path);
      }) as unknown as FsModule['lstatSync'],
    }));

    const guard = new AuthBondGuard({
      authDir,
      stateRoot,
      instanceName: 'copy-symlink-race-bot',
      now: () => new Date('2026-06-09T12:00:00Z'),
    });
    const result = guard.capture('connection-open');

    expect(result).toMatchObject({ ok: false, captured: false, path: null });
    expect(result.error).toContain('refusing to copy auth tree containing symlink');
    expect(actualFs.readdirSync(join(stateRoot, 'auth-bond-backups', 'copy-symlink-race-bot', 'history'))).toEqual([]);
  });

  it('fails capture when the auth directory disappears before tree hashing', async () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    writeAuth(authDir, '15550100066:1@s.whatsapp.net');
    let authDirExistsCalls = 0;

    const { AuthBondGuard } = await importGuardWithFsMock((actual) => ({
      existsSync: vi.fn((path: Parameters<FsModule['existsSync']>[0]) => {
        if (String(path) === authDir) {
          authDirExistsCalls += 1;
          if (authDirExistsCalls >= 2) return false;
        }
        return actual.existsSync(path);
      }) as FsModule['existsSync'],
    }));

    const guard = new AuthBondGuard({ authDir, stateRoot: join(root, 'state'), instanceName: 'missing-treehash-bot' });
    const result = guard.capture('connection-open');

    expect(result).toMatchObject({ ok: false, captured: false, path: null });
    expect(result.error).toContain('auth bond is present');
  });

  it('does not defer invalid credentials when their mtime is not parseable', async () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const credsPath = join(authDir, 'creds.json');
    actualFs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
    actualFs.writeFileSync(credsPath, '');

    const { AuthBondGuard } = await importGuardWithFsMock((actual) => ({
      lstatSync: vi.fn((path: Parameters<FsModule['lstatSync']>[0]) => {
        const stat = actual.lstatSync(path);
        if (String(path) !== credsPath) return stat;
        const fakeStat = Object.create(Object.getPrototypeOf(stat));
        Object.assign(fakeStat, stat, { mtime: { toISOString: () => 'not-a-date' } });
        return fakeStat;
      }) as unknown as FsModule['lstatSync'],
    }));

    const result = new AuthBondGuard({
      authDir,
      stateRoot: join(root, 'state'),
      instanceName: 'invalid-mtime-bot',
      freshInvalidGraceMs: 60_000,
    }).capture('creds-update');

    expect(result).toMatchObject({ ok: false, captured: false, deferred: false, path: null });
    expect(result.error).toContain('creds_json_empty');
  });

  it('restores the quarantined auth tree when restore copy fails', async () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    let failCopy = false;

    const { AuthBondGuard } = await importGuardWithFsMock((actual) => ({
      copyFileSync: vi.fn((src: Parameters<FsModule['copyFileSync']>[0], dest: Parameters<FsModule['copyFileSync']>[1]) => {
        if (failCopy) throw new Error('copy boom');
        return actual.copyFileSync(src, dest);
      }) as FsModule['copyFileSync'],
    }));

    writeAuth(authDir, '15550100061:1@s.whatsapp.net');
    const guard = new AuthBondGuard({
      authDir,
      stateRoot,
      instanceName: 'restore-copy-failure-bot',
      now: () => new Date('2026-06-09T12:00:00Z'),
    });
    const captured = guard.capture('connection-open');
    expect(captured.ok).toBe(true);

    actualFs.writeFileSync(join(authDir, 'creds.json'), '{ bad json');
    failCopy = true;
    const restored = guard.restoreLatestIfNeeded();

    expect(restored).toMatchObject({ attempted: true, restored: false, source: captured.path });
    expect(restored.error).toContain('copy boom');
    expect(restored.error).toContain('quarantine=');
    expect(actualFs.readFileSync(join(authDir, 'creds.json'), 'utf8')).toBe('{ bad json');
  });

  it('validates the copied restore tree before publishing it', async () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    let corruptRestoreCopy = false;

    const { AuthBondGuard } = await importGuardWithFsMock((actual) => ({
      copyFileSync: vi.fn((src: Parameters<FsModule['copyFileSync']>[0], dest: Parameters<FsModule['copyFileSync']>[1]) => {
        actual.copyFileSync(src, dest);
        if (
          corruptRestoreCopy
          && basename(String(src)) === 'creds.json'
          && String(dest).includes('.restore-')
        ) {
          actual.writeFileSync(dest, '{}');
        }
      }) as FsModule['copyFileSync'],
    }));

    writeAuth(authDir, '15550100066:1@s.whatsapp.net');
    const guard = new AuthBondGuard({
      authDir,
      stateRoot,
      instanceName: 'restore-copy-validation-bot',
      now: () => new Date('2026-06-09T12:00:00Z'),
    });
    const captured = guard.capture('connection-open');
    expect(captured.ok).toBe(true);

    actualFs.writeFileSync(join(authDir, 'creds.json'), '{ bad json');
    corruptRestoreCopy = true;
    const restored = guard.restoreLatestIfNeeded();

    expect(restored).toMatchObject({ attempted: true, restored: false, source: captured.path });
    expect(restored.error).toContain('copied creds.json hash mismatch');
    expect(restored.error).toContain('quarantine=');
    expect(actualFs.readFileSync(join(authDir, 'creds.json'), 'utf8')).toBe('{ bad json');
  });

  it('reports restore copy failures before moving a missing auth tree', async () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    let failCopy = false;

    const { AuthBondGuard } = await importGuardWithFsMock((actual) => ({
      copyFileSync: vi.fn((src: Parameters<FsModule['copyFileSync']>[0], dest: Parameters<FsModule['copyFileSync']>[1]) => {
        if (failCopy) throw 'copy string';
        return actual.copyFileSync(src, dest);
      }) as FsModule['copyFileSync'],
    }));

    writeAuth(authDir, '15550100067:1@s.whatsapp.net');
    const guard = new AuthBondGuard({
      authDir,
      stateRoot,
      instanceName: 'restore-missing-copy-failure-bot',
      now: () => new Date('2026-06-09T12:00:00Z'),
    });
    const captured = guard.capture('connection-open');
    expect(captured.ok).toBe(true);

    actualFs.rmSync(authDir, { recursive: true, force: true });
    failCopy = true;
    const restored = guard.restoreLatestIfNeeded();

    expect(restored).toMatchObject({ attempted: true, restored: false, source: captured.path });
    expect(restored.error).toContain('copy string');
    expect(actualFs.existsSync(authDir)).toBe(false);
  });

  it('refuses restore when backup auth disappears before tree validation completes', async () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    let disappearingBackupAuth: string | null = null;
    let backupAuthExistsCalls = 0;

    const { AuthBondGuard } = await importGuardWithFsMock((actual) => ({
      existsSync: vi.fn((path: Parameters<FsModule['existsSync']>[0]) => {
        if (disappearingBackupAuth && String(path) === disappearingBackupAuth) {
          backupAuthExistsCalls += 1;
          return backupAuthExistsCalls === 1;
        }
        return actual.existsSync(path);
      }) as FsModule['existsSync'],
    }));

    writeAuth(authDir, '15550100068:1@s.whatsapp.net');
    const guard = new AuthBondGuard({ authDir, stateRoot, instanceName: 'restore-disappearing-auth-bot' });
    const captured = guard.capture('connection-open');
    expect(captured.ok).toBe(true);
    disappearingBackupAuth = join(captured.path!, 'auth');
    actualFs.rmSync(authDir, { recursive: true, force: true });

    const restored = guard.restoreLatestIfNeeded();

    expect(restored).toMatchObject({ attempted: true, restored: false, source: captured.path });
    expect(restored.error).toContain('backup auth tree is unreadable');
  });

  it('refuses restore when backup path validation fails during restore validation', async () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    let backupPath: string | null = null;
    let backupPathStats = 0;

    const { AuthBondGuard } = await importGuardWithFsMock((actual) => ({
      lstatSync: vi.fn((path: Parameters<FsModule['lstatSync']>[0]) => {
        if (backupPath && String(path) === backupPath) {
          backupPathStats += 1;
          if (backupPathStats >= 3) throw new Error('backup vanished');
        }
        return actual.lstatSync(path);
      }) as unknown as FsModule['lstatSync'],
    }));

    writeAuth(authDir, '15550100069:1@s.whatsapp.net');
    const guard = new AuthBondGuard({ authDir, stateRoot, instanceName: 'restore-path-race-bot' });
    const captured = guard.capture('connection-open');
    expect(captured.ok).toBe(true);
    backupPath = captured.path;
    actualFs.rmSync(authDir, { recursive: true, force: true });

    const restored = guard.restoreLatestIfNeeded();

    expect(restored).toMatchObject({ attempted: true, restored: false, source: captured.path });
    expect(restored.error).toContain('backup path is unreadable');
  });

  it('stringifies non-Error throws while reading backup manifests and paths', async () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    let manifestPath: string | null = null;
    let backupPath: string | null = null;

    const { AuthBondGuard } = await importGuardWithFsMock((actual) => ({
      readFileSync: vi.fn((path: Parameters<FsModule['readFileSync']>[0], options?: Parameters<FsModule['readFileSync']>[1]) => {
        if (manifestPath && String(path) === manifestPath) throw 'manifest read string';
        return actual.readFileSync(path, options as any) as any;
      }) as unknown as FsModule['readFileSync'],
      lstatSync: vi.fn((path: Parameters<FsModule['lstatSync']>[0]) => {
        if (backupPath && String(path) === backupPath) throw 'backup stat string';
        return actual.lstatSync(path);
      }) as unknown as FsModule['lstatSync'],
    }));

    writeAuth(authDir, '15550100070:1@s.whatsapp.net');
    const manifestGuard = new AuthBondGuard({ authDir, stateRoot, instanceName: 'restore-manifest-string-bot' });
    const manifestCapture = manifestGuard.capture('connection-open');
    expect(manifestCapture.ok).toBe(true);
    manifestPath = join(manifestCapture.path!, 'manifest.json');
    actualFs.rmSync(authDir, { recursive: true, force: true });

    const manifestResult = manifestGuard.restoreLatestIfNeeded();
    expect(manifestResult.error).toContain('manifest read string');

    manifestPath = null;
    writeAuth(authDir, '15550100071:1@s.whatsapp.net');
    const pathGuard = new AuthBondGuard({ authDir, stateRoot, instanceName: 'restore-path-string-bot' });
    const pathCapture = pathGuard.capture('connection-open');
    expect(pathCapture.ok).toBe(true);
    backupPath = pathCapture.path;
    actualFs.rmSync(authDir, { recursive: true, force: true });

    const pathResult = pathGuard.restoreLatestIfNeeded();
    expect(pathResult.error).toContain('backup stat string');
  });

  it('ignores history entries that disappear during pruning', async () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    const flakyHistoryEntry = join(stateRoot, 'auth-bond-backups', 'flaky-prune-bot', 'history', 'flaky-entry');
    let now = new Date('2026-06-09T12:00:00Z');

    const { AuthBondGuard } = await importGuardWithFsMock((actual) => ({
      lstatSync: vi.fn((path: Parameters<FsModule['lstatSync']>[0]) => {
        if (String(path) === flakyHistoryEntry) throw new Error('gone during prune');
        return actual.lstatSync(path);
      }) as unknown as FsModule['lstatSync'],
    }));

    writeAuth(authDir, '15550100062:1@s.whatsapp.net');
    const guard = new AuthBondGuard({
      authDir,
      stateRoot,
      instanceName: 'flaky-prune-bot',
      keepBackups: 2,
      now: () => now,
    });
    expect(guard.capture('connection-open').ok).toBe(true);

    actualFs.mkdirSync(flakyHistoryEntry, { mode: 0o700 });
    now = new Date('2026-06-09T12:01:00Z');
    writeAuth(authDir, '15550100063:1@s.whatsapp.net');
    const second = guard.capture('creds-update');

    expect(second.ok).toBe(true);
    expect(actualFs.existsSync(flakyHistoryEntry)).toBe(true);
  });
});

// ── #2285: the auth tree can change under the walk ────────────────────────────
//
// Baileys rewrites key material constantly, so an entry can disappear between
// the readdir that listed it and the stat/read that consumes it. Pre-fix those
// calls were bare, so the ENOENT escaped inspect() — and inspect() is reached
// from a `void`-ed async path, so the throw became an unhandled rejection and
// main.ts shut the instance down.
//
// The fix must not simply skip the vanished entry: the digest commits only to
// the files it hashed, so a skipped entry would make a partial read produce a
// hash byte-identical to a genuinely smaller tree, turning a tamper-detection
// primitive from fail-closed into fail-open. An incomplete observation
// therefore yields NO hash.
describe('AuthBondGuard auth-tree races (#2285)', () => {
  // Typed off the real module rather than a hand-rolled structural shape: a
  // `Record<string, unknown>` constructor parameter does not satisfy
  // AuthBondGuardOptions, which `typecheck:all` (tsconfig.test.json) rejects
  // even though the looser default project accepts it.
  type GuardModule = Awaited<ReturnType<typeof importGuardWithFsMock>>;

  function guardFor(root: string, authDir: string, mod: GuardModule) {
    return new mod.AuthBondGuard({ authDir, stateRoot: join(root, 'state'), instanceName: 'race-bot' });
  }

  type Snapshot = ReturnType<ReturnType<typeof guardFor>['inspect']>;

  it('reports no tree hash when an entry vanishes between readdir and lstat', async () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    writeAuth(authDir);
    const vanishing = join(authDir, 'app-state-sync-key-test.json');

    const mod = await importGuardWithFsMock((actual) => ({
      lstatSync: vi.fn((path: Parameters<FsModule['lstatSync']>[0]) => {
        if (String(path) === vanishing) {
          throw Object.assign(new Error('ENOENT: vanished'), { code: 'ENOENT' });
        }
        return actual.lstatSync(path);
      }) as unknown as FsModule['lstatSync'],
    }));

    let snapshot!: Snapshot;
    expect(() => { snapshot = guardFor(root, authDir, mod).inspect(); }).not.toThrow();
    expect(snapshot.treeHash).toBeNull();
    expect(snapshot.fileCount).toBeNull();
    // Positive terminal: the snapshot is still a real observation whose tree
    // hash was deliberately withheld — not a degenerate object from a
    // short-circuited inspect(). `status === 'present'` is also the precondition
    // for reaching the tree walk at all, so this proves the fixture got there.
    expect(snapshot.status).toBe('present');
    expect(snapshot.creds).toMatchObject({ exists: true });
  });

  it('reports no tree hash when a directory vanishes, taking its subtree out of the walk', async () => {
    // The subtree case leaves no trace in `paths` at all — without the
    // completeness flag it would be invisible, not merely miscounted.
    const root = makeRoot();
    const authDir = join(root, 'auth');
    writeAuth(authDir);
    const subDir = join(authDir, 'keys');
    actualFs.mkdirSync(subDir, { mode: 0o700 });
    actualFs.writeFileSync(join(subDir, 'pre-key-1.json'), JSON.stringify({ k: 1 }));

    const mod = await importGuardWithFsMock((actual) => ({
      readdirSync: vi.fn((path: Parameters<FsModule['readdirSync']>[0], options?: unknown) => {
        if (String(path) === subDir) {
          throw Object.assign(new Error('ENOENT: vanished'), { code: 'ENOENT' });
        }
        return (actual.readdirSync as (p: unknown, o?: unknown) => unknown)(path, options);
      }) as unknown as FsModule['readdirSync'],
    }));

    let snapshot!: Snapshot;
    expect(() => { snapshot = guardFor(root, authDir, mod).inspect(); }).not.toThrow();
    expect(snapshot.treeHash).toBeNull();
    // Positive terminal: a real snapshot was produced and reached the walk; only
    // the hash was withheld.
    expect(snapshot.status).toBe('present');
    expect(snapshot.creds).toMatchObject({ exists: true });
  });

  it('reports no tree hash when a file vanishes between lstat and read', async () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    writeAuth(authDir);
    const vanishing = join(authDir, 'app-state-sync-key-test.json');

    const mod = await importGuardWithFsMock((actual) => ({
      readFileSync: vi.fn((path: Parameters<FsModule['readFileSync']>[0], options?: unknown) => {
        if (String(path) === vanishing) {
          throw Object.assign(new Error('ENOENT: vanished'), { code: 'ENOENT' });
        }
        return (actual.readFileSync as (p: unknown, o?: unknown) => unknown)(path, options);
      }) as unknown as FsModule['readFileSync'],
    }));

    let snapshot!: Snapshot;
    expect(() => { snapshot = guardFor(root, authDir, mod).inspect(); }).not.toThrow();
    expect(snapshot.treeHash).toBeNull();
    // Positive terminal: a real snapshot was produced and reached the walk; only
    // the hash was withheld.
    expect(snapshot.status).toBe('present');
    expect(snapshot.creds).toMatchObject({ exists: true });
  });

  // THE load-bearing assertion. A "skip the vanished entry and keep hashing"
  // implementation passes every test above — it also returns without throwing.
  // What it CANNOT do is avoid colliding with the genuine smaller tree, because
  // the digest would then cover exactly the surviving file. Pinning the racing
  // read against a real one-file tree's hash is what discriminates the two
  // designs, and it does not depend on any particular error being reachable.
  it('does not let a partial read collide with a genuinely smaller tree', async () => {
    // Control: a real tree containing ONLY creds.json, read with no races.
    const controlRoot = makeRoot();
    const controlAuthDir = join(controlRoot, 'auth');
    actualFs.mkdirSync(controlAuthDir, { recursive: true, mode: 0o700 });
    actualFs.writeFileSync(join(controlAuthDir, 'creds.json'), JSON.stringify({
      me: { id: '15550100001:1@s.whatsapp.net', lid: '12345:1@lid' },
      registrationId: 1,
    }));
    const controlMod = await importGuardWithFsMock(() => ({}));
    const controlHash = guardFor(controlRoot, controlAuthDir, controlMod).inspect()['treeHash'];

    // A complete read must still produce a hash — the guard must not have
    // degenerated into "always null".
    expect(typeof controlHash).toBe('string');
    expect(controlHash).not.toBeNull();

    // Racing: a two-file tree whose second file vanishes during the read. A
    // skip-and-continue implementation hashes only creds.json and therefore
    // reproduces controlHash exactly.
    const raceRoot = makeRoot();
    const raceAuthDir = join(raceRoot, 'auth');
    writeAuth(raceAuthDir);
    const vanishing = join(raceAuthDir, 'app-state-sync-key-test.json');
    const raceMod = await importGuardWithFsMock((actual) => ({
      readFileSync: vi.fn((path: Parameters<FsModule['readFileSync']>[0], options?: unknown) => {
        if (String(path) === vanishing) {
          throw Object.assign(new Error('ENOENT: vanished'), { code: 'ENOENT' });
        }
        return (actual.readFileSync as (p: unknown, o?: unknown) => unknown)(path, options);
      }) as unknown as FsModule['readFileSync'],
    }));
    const raceHash = guardFor(raceRoot, raceAuthDir, raceMod).inspect()['treeHash'];

    expect(raceHash).toBeNull();
    expect(raceHash).not.toBe(controlHash);
    // Positive terminal, and the guard against a vacuous inequality: two absent
    // values are also "not equal". Pinning the control side to a real 64-hex
    // sha256 proves the comparison above discriminates a genuine hash from a
    // withheld one, rather than comparing two nulls.
    expect(controlHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('still propagates a non-ENOENT stat failure instead of swallowing it', async () => {
    // The allowlist is ENOENT-only on purpose: EACCES means the tree is
    // genuinely unreadable, and must not be downgraded to "vanished".
    // Blocks a NON-creds file deliberately — inspect() only reaches the tree
    // walk when status === 'present', which a creds.json failure would prevent.
    const root = makeRoot();
    const authDir = join(root, 'auth');
    writeAuth(authDir);
    const blocked = join(authDir, 'app-state-sync-key-test.json');

    const mod = await importGuardWithFsMock((actual) => ({
      lstatSync: vi.fn((path: Parameters<FsModule['lstatSync']>[0]) => {
        if (String(path) === blocked) {
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        }
        return actual.lstatSync(path);
      }) as unknown as FsModule['lstatSync'],
    }));

    expect(() => guardFor(root, authDir, mod).inspect()).toThrow(/EACCES/);
  });
});
