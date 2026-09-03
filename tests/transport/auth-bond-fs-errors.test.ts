import { execFileSync } from 'node:child_process';
import { basename, join } from 'node:path';
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
  return tmp.make('whatsoup-auth-bond-fs-errors');
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

    // creds.json metadata now comes from fstat on the O_NOFOLLOW descriptor the
    // snapshot opens, not from lstat on the path, so the unparseable mtime is
    // injected there. The contract under test is unchanged: an mtime that
    // cannot be parsed must not be read as "freshly written" and deferred.
    let credsFd: number | null = null;
    const { AuthBondGuard } = await importGuardWithFsMock((actual) => ({
      openSync: vi.fn(((path: Parameters<FsModule['openSync']>[0], ...rest: unknown[]) => {
        const fd = (actual.openSync as (...a: unknown[]) => number)(path, ...rest);
        if (String(path) === credsPath) credsFd = fd;
        return fd;
      })) as unknown as FsModule['openSync'],
      fstatSync: vi.fn(((fd: number, ...rest: unknown[]) => {
        const stat = (actual.fstatSync as (...a: unknown[]) => ReturnType<FsModule['fstatSync']>)(fd, ...rest);
        if (credsFd === null || fd !== credsFd) return stat;
        const fakeStat = Object.create(Object.getPrototypeOf(stat));
        Object.assign(fakeStat, stat, { mtime: { toISOString: () => 'not-a-date' } });
        return fakeStat;
      })) as unknown as FsModule['fstatSync'],
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

// ===========================================================================
// r4 review of fix/health-endpoint-auth-walk-cost — SHOULD-1 and NIT-9.
//
// Both are about readCredsThroughNoFollow, the synchronous credential read
// reachable from an unauthenticated GET /health, and both are unpinned lines:
// deleting either leaves the rest of the suite green.
// ===========================================================================
describe('AuthBondGuard credential open flags and root-descriptor faults', () => {
  /**
   * r4 SHOULD-1 — O_NONBLOCK is the load-bearing line of the r3 MUST-1 fix.
   *
   * open(2) on a FIFO with O_RDONLY and no writer BLOCKS until a writer
   * arrives. This open is synchronous, on the main thread, and reachable from
   * an unauthenticated GET /health, so without the flag a FIFO planted at
   * creds.json stops the process serving anything, forever, and no watchdog
   * that waits for exit ever fires.
   *
   * The obvious test — plant a FIFO and assert the refusal — is the wrong shape
   * for exactly that reason: against the UNFIXED code it does not fail, it
   * hangs the worker, and a hang is not a red. vitest's test timeout cannot
   * preempt a blocked synchronous syscall. So the flags are asserted directly
   * through the fs mock this file already uses, which fails cleanly and names
   * the missing flag. The FIFO case below holds a writer open so that it cannot
   * block either way; it pins the kind refusal, not the flag.
   */
  it('passes O_NONBLOCK and O_NOFOLLOW on both credential opens', async () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const credsPath = join(authDir, 'creds.json');
    writeAuth(authDir);

    const opens: { path: string; flags: number }[] = [];
    const mod = await importGuardWithFsMock((actual) => ({
      openSync: vi.fn((
        path: Parameters<FsModule['openSync']>[0],
        flags: Parameters<FsModule['openSync']>[1],
        mode?: Parameters<FsModule['openSync']>[2],
      ) => {
        if (typeof flags === 'number') opens.push({ path: String(path), flags });
        return actual.openSync(path, flags, mode as any);
      }) as unknown as FsModule['openSync'],
    }));

    new mod.AuthBondGuard({
      authDir, stateRoot: join(root, 'state'), instanceName: 'open-flags-bot',
    }).inspect();

    // Read the constants from the REAL fs module, never from the mocked one: a
    // spread that silently dropped `constants` would make every mask below
    // compare zero to zero and pass vacuously.
    const { O_NONBLOCK, O_NOFOLLOW, O_DIRECTORY } = actualFs.constants;
    expect(O_NONBLOCK).toBeGreaterThan(0);
    expect(O_NOFOLLOW).toBeGreaterThan(0);

    const credentialOpens = opens.filter((o) => o.path === authDir || o.path === credsPath);
    // Infrastructure control. An empty or reordered recorder means the mock did
    // not intercept, and that must read as a broken test rather than as a
    // finding about the flags. It also pins the ORDER the r3 MUST-1 fix
    // depends on: the root is opened and held first, and the child is opened
    // through it afterwards.
    expect(credentialOpens.map((o) => o.path)).toEqual([authDir, credsPath]);

    // The root open: a directory, not followed, and non-blocking.
    expect(credentialOpens[0].flags & (O_DIRECTORY ?? 0)).toBe(O_DIRECTORY ?? 0);
    expect(credentialOpens[0].flags & O_NOFOLLOW).toBe(O_NOFOLLOW);
    expect(credentialOpens[0].flags & O_NONBLOCK).toBe(O_NONBLOCK);
    // The child open: this is the one a FIFO would block forever.
    expect(credentialOpens[1].flags & O_NOFOLLOW).toBe(O_NOFOLLOW);
    expect(credentialOpens[1].flags & O_NONBLOCK).toBe(O_NONBLOCK);
  });

  it('refuses a FIFO at creds.json by kind, before any byte is read', async () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const credsPath = join(authDir, 'creds.json');
    actualFs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
    execFileSync('mkfifo', [credsPath]);

    // A writer held open for the whole test. With a writer present, an
    // O_RDONLY open of a FIFO returns at once whether or not O_NONBLOCK is
    // set, so this test cannot hang even against code missing the flag — which
    // is why it pins the kind refusal and NOT the flag. The flag is pinned by
    // the assertion above.
    const writerFd = actualFs.openSync(credsPath, actualFs.constants.O_RDWR);
    try {
      const mod = await importGuardWithFsMock(() => ({}));
      const snapshot = new mod.AuthBondGuard({
        authDir, stateRoot: join(root, 'state'), instanceName: 'fifo-creds-bot',
      }).inspect();

      expect(snapshot.issues).toContain('creds_json_not_regular_file');
      expect(snapshot.status).toBe('invalid');
      // Nothing was taken from it: no hash, and no identity.
      expect(snapshot.creds.sha256).toBeNull();
      expect(snapshot.meHash).toBeNull();
    } finally {
      actualFs.closeSync(writerFd);
    }
  });

  /**
   * r4 NIT-9 — fstatSync on the auth-root descriptor sat outside any catch.
   *
   * Its `try` carries only a `finally`, so a throw escaped
   * readCredsThroughNoFollow, buildSnapshot and inspectCached and surfaced in
   * the /health handler. Every other filesystem call in that function turns a
   * throw into an issue.
   */
  it('turns a failed fstat on the auth-root descriptor into an issue, not a throw', async () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    writeAuth(authDir);
    let fstatFailures = 0;

    const mod = await importGuardWithFsMock((actual) => ({
      fstatSync: vi.fn((fd: number, options?: unknown) => {
        // The first fstat in an inspect() is the one on the root descriptor:
        // everything before it uses lstat, stat, chmod or readdir.
        if (fstatFailures === 0) {
          fstatFailures += 1;
          throw Object.assign(new Error('EBADF: bad file descriptor, fstat'), { code: 'EBADF' });
        }
        return (actual.fstatSync as (f: number, o?: unknown) => unknown)(fd, options);
      }) as unknown as FsModule['fstatSync'],
    }));

    const guard = new mod.AuthBondGuard({
      authDir, stateRoot: join(root, 'state'), instanceName: 'root-fstat-bot',
    });

    let snapshot!: ReturnType<typeof guard.inspect>;
    expect(() => { snapshot = guard.inspect(); }).not.toThrow();
    // Coverage assertion: the injected failure was actually reached.
    expect(fstatFailures).toBe(1);
    expect(snapshot.issues.some((i) => i.startsWith('auth_dir_stat_failed:'))).toBe(true);
    expect(snapshot.issues).toContain('auth_dir_stat_failed:EBADF');
    // Fail-closed: an auth root whose descriptor cannot be stat'd is not a
    // healthy bond, and the credential was never looked at, so nothing claims
    // it is missing either.
    expect(snapshot.status).toBe('invalid');
    expect(snapshot.issues).not.toContain('creds_json_missing');

    // review r4 LOW-4 — a root-side refusal must not claim the child exists.
    // creds.json is on disk and readable here; the point is that this snapshot
    // never looked, so it reports no existence rather than a `true` it did not
    // establish, alongside the null mode/size/mtime/hash it already reported.
    expect(snapshot.creds.exists).toBe(false);
    expect(snapshot.creds.mode).toBeNull();
    expect(snapshot.creds.size).toBeNull();
    expect(snapshot.creds.mtime).toBeNull();
    expect(snapshot.creds.sha256).toBeNull();
    expect(snapshot.creds.error).toBeNull();
  });

  /**
   * review r4 HIGH-1 residual — O_NONBLOCK bounds the OPEN, not the READ.
   *
   * The ABA swap HIGH-1 describes is not closable in Node, which exposes no
   * openat(2): the child is opened by full pathname, so an actor who can
   * rename the auth root can put their own regular file behind the descriptor
   * and restore the root before the dev/ino check. What IS closable is the
   * consequence — an unbounded synchronous read on an unauthenticated request.
   */
  it('refuses an oversized creds.json by descriptor size, before reading it', async () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const credsPath = join(authDir, 'creds.json');
    writeAuth(authDir);

    const mod = await importGuardWithFsMock(() => ({}));
    const readOnce = () => new mod.AuthBondGuard({
      authDir, stateRoot: join(root, 'state'), instanceName: 'creds-size-bot',
    }).inspect();

    // Control first: the same fixture, under the cap, is read normally. Without
    // this the refusal below could hold because the reader stopped working.
    const under = readOnce();
    expect(under.status).toBe('present');
    expect(under.creds.sha256).toMatch(/^[0-9a-f]{64}$/);

    // Sparse, so the fixture costs no real I/O: fstat reports the apparent
    // size, and the point of the fix is that nothing ever reads these bytes.
    const oversize = mod.MAX_CREDS_BYTES + 1;
    actualFs.truncateSync(credsPath, oversize);
    expect(actualFs.statSync(credsPath).size).toBe(oversize);

    const snapshot = readOnce();

    expect(snapshot.issues).toContain(`creds_json_too_large:${oversize}`);
    expect(snapshot.status).toBe('invalid');
    // Refused by kind, so no bytes were hashed and no identity was taken.
    expect(snapshot.creds.sha256).toBeNull();
    expect(snapshot.meHash).toBeNull();
    // The cap is the documented one. A change to the constant that forgets the
    // release note and the rationale fails here.
    expect(mod.MAX_CREDS_BYTES).toBe(1_048_576);
  });

  /**
   * SHOULD-4 — the cap is enforced against the descriptor, not the fstat.
   *
   * readFileSync(fd) took its own internal stat, so the fstat-based check was
   * informative rather than load-bearing: an actor who could extend the object
   * between the fstat and the read got an unbounded synchronous read on the
   * unauthenticated health path. The bounded readSync loop refuses when the
   * descriptor still has bytes after the buffer is full.
   */
  it('refuses an oversized creds.json against the descriptor when fstat under-reports', async () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const credsPath = join(authDir, 'creds.json');
    writeAuth(authDir);

    // A real 2 MiB regular file behind creds.json. Sparse so no bytes hit disk.
    const CAP = 1_048_576;
    const oversize = CAP * 2;
    actualFs.truncateSync(credsPath, oversize);
    expect(actualFs.statSync(credsPath).size).toBe(oversize);

    let fstatUnderreports = 0;
    const mod = await importGuardWithFsMock((actual) => ({
      fstatSync: vi.fn((fd: number) => {
        const stat = actual.fstatSync(fd);
        // Under-report only on a file descriptor pointing at the oversize
        // regular file. The directory descriptor is untouched, so no other
        // early check is disturbed.
        if (stat.isFile() && stat.size > CAP) {
          fstatUnderreports += 1;
          // Preserve isFile() and the rest of the Stats API; only size lies.
          return new Proxy(stat, {
            get(target, prop, receiver) {
              if (prop === 'size') return 100;
              return Reflect.get(target, prop, receiver);
            },
          });
        }
        return stat;
      }) as unknown as FsModule['fstatSync'],
    }));

    const snapshot = new mod.AuthBondGuard({
      authDir, stateRoot: join(root, 'state'), instanceName: 'creds-descriptor-cap-bot',
    }).inspect();

    // Coverage assertion: the fstat mock really under-reported this read, so
    // the descriptor-side check is what caught it and not the fstat path.
    expect(fstatUnderreports).toBeGreaterThanOrEqual(1);
    // Reported size is what the descriptor yielded past the buffer, not what
    // fstat said, so a comparison against st.size would sail through here.
    expect(snapshot.issues).toContain(`creds_json_too_large:${CAP + 1}`);
    expect(snapshot.status).toBe('invalid');
    expect(snapshot.creds.sha256).toBeNull();
    expect(snapshot.meHash).toBeNull();
  });

  /**
   * NIT-3 — the root-open transient branch is untested and its issue string
   * is not bound to the shared prefix constant. One injected-EAGAIN test on
   * the ROOT open pins both halves: the reason is produced, and the restore
   * gate withholds because hasTransientAuthReadIssue recognises the prefix.
   */
  it('reports a transient nonblocking open on the ROOT as transient, and the restore gate withholds', async () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    writeAuth(authDir);

    // A real backup so the withheld path is discriminating: without one the
    // restore bails at "no auth-bond backup available" and the gate is not
    // what refused. Same idiom as the sibling restore-withhold test.
    const clean = await importGuardWithFsMock(() => ({}));
    const seeded = new clean.AuthBondGuard({
      authDir, stateRoot, instanceName: 'root-eagain-bot',
      now: () => new Date('2026-09-03T12:00:00Z'),
    }).capture('seed');
    expect(seeded).toMatchObject({ ok: true, captured: true });

    let rootTransientOpens = 0;
    const mod = await importGuardWithFsMock((actual) => ({
      openSync: vi.fn((
        path: Parameters<FsModule['openSync']>[0],
        flags: Parameters<FsModule['openSync']>[1],
        mode?: Parameters<FsModule['openSync']>[2],
      ) => {
        // Only intercept the ROOT open at readCredsThroughNoFollow, which is
        // an O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK on the authDir path.
        // Everything else — hardening, seeding, other opens — falls through.
        const isRoot = String(path) === authDir
          && typeof flags === 'number'
          && (flags & actual.constants.O_DIRECTORY) !== 0
          && (flags & actual.constants.O_NONBLOCK) !== 0;
        if (isRoot) {
          rootTransientOpens += 1;
          throw Object.assign(
            new Error('EAGAIN: resource temporarily unavailable, open'),
            { code: 'EAGAIN' },
          );
        }
        return actual.openSync(path, flags, mode as any);
      }) as unknown as FsModule['openSync'],
    }));

    const guard = new mod.AuthBondGuard({
      authDir, stateRoot, instanceName: 'root-eagain-bot',
    });
    const snapshot = guard.inspect();

    // Coverage: the injected failure was actually reached on the ROOT open.
    expect(rootTransientOpens).toBeGreaterThanOrEqual(1);
    // Names the ROOT reason, not the child one — the two are distinct issues.
    expect(snapshot.issues).toContain('auth_dir_read_transient:EAGAIN');
    expect(snapshot.issues).not.toContain('auth_dir_unreadable:EAGAIN');
    expect(snapshot.status).toBe('invalid');

    // The load-bearing half: hasTransientAuthReadIssue recognises the shared
    // prefix, so the destructive restore is withheld on this reason too.
    // A rename of TRANSIENT_AUTH_READ_ISSUE_PREFIXES that forgets the root
    // producer's literal string breaks this assertion.
    const result = guard.restoreLatestIfNeeded();
    expect(result.attempted).toBe(false);
    expect(result.error).toContain('transient');
  });

  /**
   * review r4 LOW-1 — a nonblocking open that says "not now" is not corruption.
   *
   * EAGAIN/EWOULDBLOCK became `creds_json_unreadable:<errno>`, which
   * src/core/health.ts classifies as local corruption and pages on. The
   * distinct reason is what lets a classifier tell retry from corrupt.
   */
  it('reports a transient nonblocking open as transient, not as unreadable', async () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const credsPath = join(authDir, 'creds.json');
    writeAuth(authDir);
    let transientOpens = 0;

    const mod = await importGuardWithFsMock((actual) => ({
      openSync: vi.fn((
        path: Parameters<FsModule['openSync']>[0],
        flags: Parameters<FsModule['openSync']>[1],
        mode?: Parameters<FsModule['openSync']>[2],
      ) => {
        if (String(path) === credsPath) {
          transientOpens += 1;
          throw Object.assign(new Error('EAGAIN: resource temporarily unavailable, open'), { code: 'EAGAIN' });
        }
        return actual.openSync(path, flags, mode as any);
      }) as unknown as FsModule['openSync'],
    }));

    const snapshot = new mod.AuthBondGuard({
      authDir, stateRoot: join(root, 'state'), instanceName: 'creds-eagain-bot',
    }).inspect();

    // Coverage assertion: the injected failure was actually reached.
    expect(transientOpens).toBeGreaterThanOrEqual(1);
    expect(snapshot.issues).toContain('creds_json_read_transient:EAGAIN');
    // The load-bearing half: it is NOT reported as an unreadable credential,
    // which is the input health.ts turns into a local-corruption page.
    expect(snapshot.issues).not.toContain('creds_json_unreadable:EAGAIN');
    expect(snapshot.issues).not.toContain('creds_json_missing');
    // Still fail-closed on status. What must NOT follow from it is a
    // destructive repair or a corruption page — see the two tests below and
    // the classifier gate in src/core/health.ts.
    expect(snapshot.status).toBe('invalid');
    expect(snapshot.creds.exists).toBe(false);
  });

  /**
   * review r4 LOW-1, destructive half — the reason this matters more than a page.
   *
   * restoreLatestIfNeeded's only precondition was a non-'present' status, and
   * it renames the live auth root away and replaces it from a backup. A
   * transient EAGAIN produces a non-'present' status while saying nothing about
   * the credential, so the destructive repair could fire on "not now" and
   * destroy a healthy tree.
   */
  it('withholds the destructive restore on a transient read; the next definite read decides', async () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    const credsPath = join(authDir, 'creds.json');
    writeAuth(authDir);

    // Seed a real backup FIRST, with a clean reader. Without one the restore
    // bails at "no auth-bond backup available" and the destructive path is
    // never reached, which would leave this test unable to tell the gate from
    // the absence of a backup.
    const clean = await importGuardWithFsMock(() => ({}));
    const seeded = new clean.AuthBondGuard({
      authDir, stateRoot, instanceName: 'transient-restore-bot',
      now: () => new Date('2026-09-03T12:00:00Z'),
    }).capture('seed');
    expect(seeded).toMatchObject({ ok: true, captured: true });

    const credsBefore = actualFs.readFileSync(credsPath, 'utf8');
    const treeBefore = actualFs.readdirSync(authDir).sort();
    const quarantineRoot = join(stateRoot, 'auth-bond-backups', 'transient-restore-bot', 'quarantine');
    expect(actualFs.existsSync(quarantineRoot)).toBe(false);

    const mod = await importGuardWithFsMock((actual) => ({
      openSync: vi.fn((
        path: Parameters<FsModule['openSync']>[0],
        flags: Parameters<FsModule['openSync']>[1],
        mode?: Parameters<FsModule['openSync']>[2],
      ) => {
        if (String(path) === credsPath) {
          throw Object.assign(new Error('EAGAIN: resource temporarily unavailable, open'), { code: 'EAGAIN' });
        }
        return actual.openSync(path, flags, mode as any);
      }) as unknown as FsModule['openSync'],
    }));

    const guard = new mod.AuthBondGuard({
      authDir,
      stateRoot,
      instanceName: 'transient-restore-bot',
      // Non-zero so the armed retry below has a measurable wait rather than a
      // 0 ms timer that has already fired by the time it is asserted.
      treeRefreshMinIntervalMs: 5_000,
    });
    await guard.warmTreeCache();

    const result = guard.restoreLatestIfNeeded();

    // Not merely "did not restore" — never even ATTEMPTED. Without the gate
    // this reaches the restore proper, which is what renames the root.
    expect(result.attempted).toBe(false);
    expect(result.restored).toBe(false);
    expect(result.error).toContain('transient');
    // Coverage assertion: the withheld snapshot is the transient one, so the
    // gate fired for the reason under test and not for some other early exit.
    expect(result.snapshot.issues).toContain('creds_json_read_transient:EAGAIN');

    // The tree is untouched: same entries, same bytes, no quarantine.
    expect(actualFs.readdirSync(authDir).sort()).toEqual(treeBefore);
    expect(actualFs.readFileSync(credsPath, 'utf8')).toBe(credsBefore);
    expect(actualFs.existsSync(quarantineRoot)).toBe(false);

    // No tree walk is armed here. A tree walk cannot re-establish a
    // credential, and arming one would only defer reader-driven walks in the
    // meantime. Convergence lives on the live path: the credential is re-read
    // on every inspect() and on every connect attempt, so the definite read
    // that unblocks the restore arrives whenever the transient stops.
    expect(guard.inspectCached().treeProvenance?.refreshScheduled).toBe(false);
  });

  /**
   * SHOULD-3 — a failed restore re-enters the convergence path.
   *
   * markTreeStale('auth-restore-started') cancels the successor that a cold
   * or age-driven walk armed. If the restore then throws, the catch used to
   * roll back the quarantine and return, leaving treeInvalidated true with no
   * walk in flight and no timer queued. Convergence fell back to "someone
   * reads again" — precisely the property invalidateTreeCache's contract
   * says has been removed. The fix invalidates with reason
   * 'auth-restore-failed' inside the catch after the rollback.
   */
  it('re-enters the convergence path when a restore attempt fails', async () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    writeAuth(authDir);

    // Seed a real backup so the restore reaches the destructive body rather
    // than bailing at "no auth-bond backup available".
    const clean = await importGuardWithFsMock(() => ({}));
    const seeded = new clean.AuthBondGuard({
      authDir, stateRoot, instanceName: 'restore-fail-bot',
      now: () => new Date('2026-09-03T12:00:00Z'),
    }).capture('seed');
    expect(seeded).toMatchObject({ ok: true, captured: true });

    // Cause a non-'present' status so restoreLatestIfNeeded proceeds, then
    // fail the last rename (tmp → authDir) after the quarantine rename has
    // succeeded. The quarantine rename is authDir → <state>/…/quarantine/…,
    // so intercepting only renames whose DESTINATION is authDir leaves the
    // quarantine step untouched.
    actualFs.unlinkSync(join(authDir, 'creds.json'));
    let renameFailures = 0;
    const mod = await importGuardWithFsMock((actual) => ({
      renameSync: vi.fn((
        src: Parameters<FsModule['renameSync']>[0],
        dst: Parameters<FsModule['renameSync']>[1],
      ) => {
        if (String(dst) === authDir) {
          renameFailures += 1;
          throw Object.assign(new Error('EIO: forced restore failure'), { code: 'EIO' });
        }
        return actual.renameSync(src, dst);
      }) as FsModule['renameSync'],
    }));

    const guard = new mod.AuthBondGuard({
      authDir, stateRoot, instanceName: 'restore-fail-bot',
      treeRefreshMinIntervalMs: 5_000,
    });

    // Cold walk that fails and arms a successor. markTreeStale in the restore
    // will then cancel this successor, which is the exact window the fix
    // exists to close.
    await guard.warmTreeCache();

    const result = guard.restoreLatestIfNeeded();

    // Coverage: the injected failure fired for the reason under test.
    expect(renameFailures).toBeGreaterThanOrEqual(1);
    expect(result.attempted).toBe(true);
    expect(result.restored).toBe(false);
    expect(result.error).toContain('quarantine=');

    // The catch called invalidateTreeCache('auth-restore-failed'), which
    // re-fenced the generation with its own reason and re-entered the
    // scheduler through refreshTreeCache(fromInvalidation=true). That call is
    // floor-blocked (a successful warm happened seconds ago) but a
    // fromInvalidation floor-block still arms a successor synchronously, so
    // both the reason and the armed timer are visible without draining.
    //
    // Without the fix the catch does nothing after the quarantine rollback:
    // lastInvalidationReason stays 'auth-restore-started' (from the try's
    // markTreeStale) and no successor is armed — markTreeStale cancelled the
    // one warmTreeCache did not leave behind, and no later call re-arms it.
    // Both assertions go red under that mutation.
    const afterCatch = guard.inspectCached().treeProvenance!;
    expect(afterCatch.lastInvalidationReason).toBe('auth-restore-failed');
    expect(afterCatch.refreshScheduled).toBe(true);
  });

  /**
   * SHOULD-5, guard-side accounting — a transient credential read that
   * persists past treeStaleRiskMs flips the snapshot's transientReadPersistent
   * flag from false to true, mirroring how a stale tree observation flips
   * status to 'unknown' at the same bound. The classifier consumes this flag
   * to escalate a permanently transient read out of `auth_bond_at_risk`.
   */
  it('flips transientReadPersistent after the stale-risk bound while EAGAIN persists', async () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const credsPath = join(authDir, 'creds.json');
    writeAuth(authDir);

    // A programmable transient: when true, the credential open throws EAGAIN;
    // when false, the real open runs. One guard sees both regimes so the
    // streak reset is tested on the SAME instance, not on a fresh one.
    const inject = { transient: true };
    const mod = await importGuardWithFsMock((actual) => ({
      openSync: vi.fn((
        path: Parameters<FsModule['openSync']>[0],
        flags: Parameters<FsModule['openSync']>[1],
        mode?: Parameters<FsModule['openSync']>[2],
      ) => {
        if (String(path) === credsPath && inject.transient) {
          throw Object.assign(
            new Error('EAGAIN: resource temporarily unavailable, open'),
            { code: 'EAGAIN' },
          );
        }
        return actual.openSync(path, flags, mode as any);
      }) as unknown as FsModule['openSync'],
    }));

    // A short treeCacheMaxAgeMs so treeStaleRiskMs is 40 ms (× 4). Uses the
    // same multiple production uses and keeps the test fast.
    const clock = { value: 0 };
    const guard = new mod.AuthBondGuard({
      authDir, stateRoot: join(root, 'state'), instanceName: 'transient-persist-bot',
      treeCacheMaxAgeMs: 10,
      monotonicNow: () => clock.value,
    });

    // First observation: the transient has just been seen, so it is at-risk
    // but not yet persistent. Coverage assertion for the "flips to true"
    // claim below — without it that claim could hold vacuously.
    const first = guard.inspect();
    expect(first.issues).toContain('creds_json_read_transient:EAGAIN');
    expect(first.transientReadPersistent).toBe(false);

    // Inside the bound: still not persistent.
    clock.value = 30;
    expect(guard.inspect().transientReadPersistent).toBe(false);

    // Past 40 ms (10 × 4): persistent. Removing the >= comparison in
    // noteTransientReadState — for example forcing the flip to a hardcoded
    // false — makes this assertion red.
    clock.value = 41;
    const persistent = guard.inspect();
    expect(persistent.issues).toContain('creds_json_read_transient:EAGAIN');
    expect(persistent.transientReadPersistent).toBe(true);

    // The fault recovers. The streak resets the moment a snapshot no longer
    // carries a transient — on the SAME guard — so the persistent flag does
    // not latch on a fault that has already recovered.
    inject.transient = false;
    clock.value = 100;
    const recovered = guard.inspect();
    expect(recovered.issues).not.toContain('creds_json_read_transient:EAGAIN');
    expect(recovered.transientReadPersistent).toBe(false);

    // A fresh streak starts from scratch: a transient reappearing after
    // recovery is at-risk, not immediately persistent, so the guard cannot
    // carry a stale "persistent" flag past a recovery.
    inject.transient = true;
    clock.value = 105;
    const reappeared = guard.inspect();
    expect(reappeared.issues).toContain('creds_json_read_transient:EAGAIN');
    expect(reappeared.transientReadPersistent).toBe(false);
  });
});
