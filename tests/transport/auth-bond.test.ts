import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthBondGuard } from '../../src/transport/auth-bond.ts';

let tmpRoot = '';

afterEach(() => {
  vi.restoreAllMocks();
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
});

function makeRoot(): string {
  tmpRoot = mkdtempSync(join(tmpdir(), 'whatsoup-auth-bond-'));
  return tmpRoot;
}

function writeAuth(authDir: string, id = '15550100001:1@s.whatsapp.net'): void {
  mkdirSync(authDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(authDir, 'creds.json'), JSON.stringify({
    me: { id, lid: '12345:1@lid' },
    registrationId: 1,
  }));
  writeFileSync(join(authDir, 'app-state-sync-key-test.json'), JSON.stringify({ keyData: 'secret' }));
}

describe('AuthBondGuard', () => {
  it('reports missing, invalid, and present credential state', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const guard = new AuthBondGuard({ authDir, stateRoot: join(root, 'state'), instanceName: 'test-bot' });

    expect(guard.inspect()).toMatchObject({
      status: 'missing',
      issues: expect.arrayContaining(['auth_dir_missing', 'creds_json_missing']),
    });

    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, 'creds.json'), '{ bad json');
    expect(guard.inspect()).toMatchObject({
      status: 'invalid',
      issues: expect.arrayContaining(['creds_json_invalid_json']),
    });

    writeAuth(authDir);
    const snapshot = guard.inspect();
    expect(snapshot.status).toBe('present');
    expect(snapshot.creds.sha256).toHaveLength(64);
    expect(snapshot.meHash).toHaveLength(20);
    expect(snapshot.treeHash).toHaveLength(64);
  });

  it('reports non-object credentials and supports lid-only identities', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    mkdirSync(authDir, { recursive: true, mode: 0o700 });
    const guard = new AuthBondGuard({ authDir, stateRoot, instanceName: '***' });

    writeFileSync(join(authDir, 'creds.json'), JSON.stringify(['not-an-object']));
    expect(guard.inspect()).toMatchObject({
      status: 'invalid',
      issues: expect.arrayContaining(['creds_json_not_object']),
    });

    writeFileSync(join(authDir, 'creds.json'), JSON.stringify({ me: {}, registrationId: 2 }));
    expect(guard.inspect()).toMatchObject({
      status: 'invalid',
      issues: expect.arrayContaining(['creds_json_missing_me']),
    });

    writeFileSync(join(authDir, 'creds.json'), JSON.stringify({
      me: { lid: 'lid-only-user@lid' },
      registrationId: 2,
    }));
    writeFileSync(join(authDir, 'app-state-sync-key-test.json'), JSON.stringify({ keyData: 'secret' }));

    const snapshot = guard.inspect();
    expect(snapshot.status).toBe('present');
    expect(snapshot.meHash).toHaveLength(20);
    expect(guard.capture('connection-open').path).toContain('/unknown/history/');
  });

  it('reports a symlinked auth root as an invalid auth tree', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const realAuthDir = join(root, 'real-auth');
    writeAuth(realAuthDir);
    symlinkSync(realAuthDir, authDir);

    const snapshot = new AuthBondGuard({
      authDir,
      stateRoot: join(root, 'state'),
      instanceName: 'root-symlink-bot',
    }).inspect();

    expect({
      status: snapshot.status,
      treeHash: snapshot.treeHash,
      issues: snapshot.issues,
    }).toStrictEqual({
      status: 'invalid',
      treeHash: null,
      issues: ['auth_tree_symlink:.'],
    });
  });

  it('captures private immutable backups and a latest pointer', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    writeAuth(authDir);

    const guard = new AuthBondGuard({
      authDir,
      stateRoot,
      instanceName: 'test-bot',
      now: () => new Date('2026-06-09T12:00:00Z'),
    });

    const result = guard.capture('connection-open');
    expect(result).toMatchObject({ ok: true, captured: true, error: null });
    expect(result.path).toEqual(expect.any(String));
    expect(existsSync(join(result.path!, 'auth', 'creds.json'))).toBe(true);
    expect(existsSync(join(result.path!, 'manifest.json'))).toBe(true);

    const latestPath = join(stateRoot, 'auth-bond-backups', 'test-bot', 'latest.json');
    const latest = JSON.parse(readFileSync(latestPath, 'utf8')) as { backupPath: string };
    expect(latest.backupPath).toBe(result.path);
    expect(statSync(latestPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(result.path!, 'auth', 'creds.json')).mode & 0o777).toBe(0o600);

    const skipped = guard.capture('creds-update');
    expect(skipped).toMatchObject({ ok: true, captured: false, path: result.path });
  });

  it('uses the default state root when none is configured', () => {
    const root = makeRoot();
    const instanceRoot = join(root, 'instance');
    const authDir = join(instanceRoot, 'auth');
    writeAuth(authDir, '15550100046:1@s.whatsapp.net');

    const guard = new AuthBondGuard({
      authDir,
      instanceName: 'default-state-bot',
      now: () => new Date('2026-06-09T12:00:00Z'),
    });

    const result = guard.capture('connection-open');

    expect(result.ok).toBe(true);
    expect(result.path).toContain('/state/auth-bond-backups/default-state-bot/history/');
  });

  it('refuses a symlinked latest pointer and removes the unpublished backup', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    writeAuth(authDir);
    const backupRoot = join(stateRoot, 'auth-bond-backups', 'symlink-bot');
    const historyRoot = join(backupRoot, 'history');
    mkdirSync(historyRoot, { recursive: true, mode: 0o700 });
    const outside = join(root, 'outside-latest.json');
    writeFileSync(outside, 'unchanged\n', { mode: 0o600 });
    symlinkSync(outside, join(backupRoot, 'latest.json'));

    const guard = new AuthBondGuard({
      authDir,
      stateRoot,
      instanceName: 'symlink-bot',
      now: () => new Date('2026-06-09T12:00:00Z'),
    });

    const result = guard.capture('connection-open');

    expect(result).toMatchObject({ ok: false, captured: false, path: null });
    expect(result.error).toMatch(/symlink/);
    expect(readFileSync(outside, 'utf8')).toBe('unchanged\n');
    expect(readdirSync(historyRoot)).toEqual([]);
  });

  it('does not trust a symlinked latest pointer even when it points at a matching manifest', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    writeAuth(authDir);
    const backupRoot = join(stateRoot, 'auth-bond-backups', 'matching-symlink-bot');

    const initial = new AuthBondGuard({
      authDir,
      stateRoot,
      instanceName: 'matching-symlink-bot',
      now: () => new Date('2026-06-09T12:00:00Z'),
    });
    const captured = initial.capture('connection-open');
    expect(captured.ok).toBe(true);

    const latestPath = join(backupRoot, 'latest.json');
    const outside = join(root, 'outside-latest.json');
    writeFileSync(outside, readFileSync(latestPath, 'utf8'), { mode: 0o600 });
    rmSync(latestPath, { force: true });
    symlinkSync(outside, latestPath);

    const guard = new AuthBondGuard({
      authDir,
      stateRoot,
      instanceName: 'matching-symlink-bot',
      now: () => new Date('2026-06-09T12:01:00Z'),
    });
    const result = guard.capture('creds-update');

    expect(result).toMatchObject({ ok: false, captured: false, path: null });
    expect(result.error).toMatch(/symlink/);
    expect(JSON.parse(readFileSync(outside, 'utf8'))).toMatchObject({ backupPath: captured.path });
    expect(readdirSync(join(backupRoot, 'history'))).toHaveLength(1);
  });

  it('ignores malformed latest manifests during backup inspection', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    writeAuth(authDir);
    const backupRoot = join(stateRoot, 'auth-bond-backups', 'malformed-latest-bot');
    mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
    writeFileSync(join(backupRoot, 'latest.json'), JSON.stringify(['bad']), { mode: 0o600 });

    const guard = new AuthBondGuard({ authDir, stateRoot, instanceName: 'malformed-latest-bot' });
    const snapshot = guard.inspect();

    expect(snapshot.status).toBe('present');
    expect(snapshot.backup.latest).toBeNull();
    expect(snapshot.backup.latestAt).toBeNull();
    expect(snapshot.backup.root).toBe(backupRoot);
  });

  it('refuses to write backups through a symlinked backup root directory', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    writeAuth(authDir);
    const backupParent = join(stateRoot, 'auth-bond-backups');
    const outsideRoot = join(root, 'outside-backup-root');
    mkdirSync(backupParent, { recursive: true, mode: 0o700 });
    mkdirSync(outsideRoot, { recursive: true, mode: 0o700 });
    symlinkSync(outsideRoot, join(backupParent, 'root-symlink-bot'), 'dir');

    const guard = new AuthBondGuard({
      authDir,
      stateRoot,
      instanceName: 'root-symlink-bot',
      now: () => new Date('2026-06-09T12:00:00Z'),
    });

    const result = guard.capture('connection-open');

    expect(result).toMatchObject({ ok: false, captured: false, path: null });
    expect(result.error).toMatch(/backup root directory.*symlink/);
    expect(readdirSync(outsideRoot)).toEqual([]);
  });

  it('refuses to publish a latest manifest over a non-regular path and removes the unpublished backup', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    writeAuth(authDir);
    const backupRoot = join(stateRoot, 'auth-bond-backups', 'latest-directory-bot');
    const historyRoot = join(backupRoot, 'history');
    mkdirSync(historyRoot, { recursive: true, mode: 0o700 });
    mkdirSync(join(backupRoot, 'latest.json'), { mode: 0o700 });

    const guard = new AuthBondGuard({
      authDir,
      stateRoot,
      instanceName: 'latest-directory-bot',
      now: () => new Date('2026-06-09T12:00:00Z'),
    });

    const result = guard.capture('connection-open');

    expect(result).toMatchObject({ ok: false, captured: false, path: null });
    expect(result.error).toContain('refusing to write auth-bond json over non-regular path');
    expect(readdirSync(historyRoot)).toEqual([]);
  });

  it('refuses to capture a live auth tree containing symlinked credentials', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    writeAuth(authDir, '15550100031:1@s.whatsapp.net');
    const guard = new AuthBondGuard({
      authDir,
      stateRoot,
      instanceName: 'symlink-creds-bot',
      now: () => new Date('2026-06-09T12:00:00Z'),
    });

    const good = guard.capture('connection-open');
    expect(good.ok).toBe(true);
    const latestPath = join(stateRoot, 'auth-bond-backups', 'symlink-creds-bot', 'latest.json');
    const latestBefore = JSON.parse(readFileSync(latestPath, 'utf8')) as { backupPath: string; treeHash: string };

    const outsideCreds = join(root, 'outside-creds.json');
    writeFileSync(outsideCreds, JSON.stringify({
      me: { id: '15550199999:1@s.whatsapp.net', lid: 'changed@lid' },
      registrationId: 99,
    }), { mode: 0o600 });
    rmSync(join(authDir, 'creds.json'), { force: true });
    symlinkSync(outsideCreds, join(authDir, 'creds.json'));

    const failed = guard.capture('creds-update');

    expect(failed).toMatchObject({
      ok: false,
      captured: false,
      path: null,
      snapshot: {
        status: 'invalid',
        issues: expect.arrayContaining(['auth_tree_symlink:creds.json']),
      },
    });
    expect(failed.error).toContain('auth_tree_symlink:creds.json');
    expect(JSON.parse(readFileSync(latestPath, 'utf8'))).toEqual(latestBefore);
    expect(readdirSync(join(stateRoot, 'auth-bond-backups', 'symlink-creds-bot', 'history'))).toHaveLength(1);
  });

  it('revalidates an unchanged auth tree without moving the latest pointer', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    writeAuth(authDir, '15550100020:1@s.whatsapp.net');

    const guard = new AuthBondGuard({
      authDir,
      stateRoot,
      instanceName: 'revalidate-bot',
      now: () => new Date('2026-06-09T12:00:00Z'),
    });

    const first = guard.capture('connection-open');
    expect(first).toMatchObject({ ok: true, captured: true, error: null });
    const second = guard.capture('creds-update');
    expect(second).toMatchObject({ ok: true, captured: false, path: first.path, error: null });

    const snapshot = guard.inspect();
    expect(snapshot.backup.latest).toBe(first.path);
    expect(snapshot.backup.latestReason).toBe('connection-open');
    expect(snapshot.backup.lastCaptureReason).toBe('creds-update');
    expect(snapshot.backup.lastCaptureError).toBeNull();
    expect(readdirSync(join(stateRoot, 'auth-bond-backups', 'revalidate-bot', 'history'))).toHaveLength(1);
  });

  it('refuses corrupt credential captures and preserves the previous protected snapshot', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    writeAuth(authDir, '15550100013:1@s.whatsapp.net');

    const guard = new AuthBondGuard({
      authDir,
      stateRoot,
      instanceName: 'corrupt-bot',
      now: () => new Date('2026-06-09T12:00:00Z'),
      freshInvalidGraceMs: 0,
    });

    const good = guard.capture('connection-open');
    expect(good).toMatchObject({ ok: true, captured: true, error: null });
    const latestPath = join(stateRoot, 'auth-bond-backups', 'corrupt-bot', 'latest.json');
    const latestBefore = JSON.parse(readFileSync(latestPath, 'utf8')) as { backupPath: string; treeHash: string };

    writeFileSync(join(authDir, 'creds.json'), '{ bad json');
    const failed = guard.capture('creds-update');

    expect(failed).toMatchObject({
      ok: false,
      captured: false,
      path: null,
      snapshot: {
        status: 'invalid',
        issues: expect.arrayContaining(['creds_json_invalid_json']),
      },
    });
    expect(failed.error).toContain('auth bond is invalid');
    const latestAfter = JSON.parse(readFileSync(latestPath, 'utf8')) as { backupPath: string; treeHash: string };
    expect(latestAfter).toEqual(latestBefore);
    expect(readdirSync(join(stateRoot, 'auth-bond-backups', 'corrupt-bot', 'history'))).toHaveLength(1);

    const protectedCreds = JSON.parse(readFileSync(join(latestAfter.backupPath, 'auth', 'creds.json'), 'utf8')) as {
      me?: { id?: string };
    };
    expect(protectedCreds.me?.id).toBe('15550100013:1@s.whatsapp.net');
  });

  it('refuses zero-byte credential captures and preserves the previous protected snapshot', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    writeAuth(authDir, '15550100010:1@s.whatsapp.net');

    const guard = new AuthBondGuard({
      authDir,
      stateRoot,
      instanceName: 'zero-byte-bot',
      now: () => new Date('2026-06-09T12:00:00Z'),
      freshInvalidGraceMs: 0,
    });

    const good = guard.capture('connection-open');
    expect(good).toMatchObject({ ok: true, captured: true, error: null });
    const latestPath = join(stateRoot, 'auth-bond-backups', 'zero-byte-bot', 'latest.json');
    const latestBefore = JSON.parse(readFileSync(latestPath, 'utf8')) as { backupPath: string; treeHash: string };

    writeFileSync(join(authDir, 'creds.json'), '');
    const failed = guard.capture('creds-update');

    expect(failed).toMatchObject({
      ok: false,
      captured: false,
      path: null,
      snapshot: {
        status: 'invalid',
        creds: { exists: true, size: 0 },
        issues: expect.arrayContaining(['creds_json_empty']),
      },
    });
    expect(failed.error).toContain('creds_json_empty');
    const latestAfter = JSON.parse(readFileSync(latestPath, 'utf8')) as { backupPath: string; treeHash: string };
    expect(latestAfter).toEqual(latestBefore);
    expect(readdirSync(join(stateRoot, 'auth-bond-backups', 'zero-byte-bot', 'history'))).toHaveLength(1);

    const protectedCreds = JSON.parse(readFileSync(join(latestAfter.backupPath, 'auth', 'creds.json'), 'utf8')) as {
      me?: { id?: string };
    };
    expect(protectedCreds.me?.id).toBe('15550100010:1@s.whatsapp.net');
  });

  it('retries a fresh zero-byte credential read and captures after the write settles', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    mkdirSync(authDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(authDir, 'creds.json'), '');

    vi.spyOn(Atomics, 'wait').mockImplementation(() => {
      writeAuth(authDir, '15550100030:1@s.whatsapp.net');
      return 'ok';
    });

    const guard = new AuthBondGuard({
      authDir,
      stateRoot: join(root, 'state'),
      instanceName: 'settling-retry-bot',
      captureAttempts: 2,
      captureRetryDelayMs: 1,
      freshInvalidGraceMs: 60_000,
    });

    const result = guard.capture('creds-update');

    expect(result).toMatchObject({ ok: true, captured: true, deferred: false, error: null });
    expect(result.path).toEqual(expect.any(String));
    expect(guard.inspect().backup.lastCaptureError).toBeNull();
  });

  it('defers fresh zero-byte credential reads without recording a hard capture failure', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    mkdirSync(authDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(authDir, 'creds.json'), '');

    const guard = new AuthBondGuard({
      authDir,
      stateRoot: join(root, 'state'),
      instanceName: 'settling-bot',
      captureAttempts: 1,
      freshInvalidGraceMs: 60_000,
    });

    const result = guard.capture('creds-update');

    expect(result).toMatchObject({
      ok: false,
      captured: false,
      deferred: true,
      path: null,
      snapshot: {
        status: 'invalid',
        issues: expect.arrayContaining(['creds_json_empty']),
        backup: {
          lastCaptureError: null,
          lastCaptureDeferredReason: 'creds-update',
        },
      },
    });
    expect(result.error).toContain('credential write still in flight');
    expect(guard.inspect().backup.lastCaptureDeferredAgeMs).toEqual(expect.any(Number));
  });

  it('retries a deferred credential read without sleeping when retry delay is zero', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    mkdirSync(authDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(authDir, 'creds.json'), '');
    const wait = vi.spyOn(Atomics, 'wait');

    const guard = new AuthBondGuard({
      authDir,
      stateRoot: join(root, 'state'),
      instanceName: 'zero-delay-retry-bot',
      captureAttempts: 2,
      captureRetryDelayMs: 0,
      freshInvalidGraceMs: 60_000,
    });

    const result = guard.capture('creds-update');

    expect(result).toMatchObject({ ok: false, captured: false, deferred: true, path: null });
    expect(result.error).toContain('credential write still in flight');
    expect(wait).not.toHaveBeenCalled();
  });

  it('fails missing credential captures without treating them as fresh write windows', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    mkdirSync(authDir, { recursive: true, mode: 0o700 });

    const guard = new AuthBondGuard({
      authDir,
      stateRoot: join(root, 'state'),
      instanceName: 'missing-creds-capture-bot',
      freshInvalidGraceMs: 60_000,
    });

    const result = guard.capture('creds-update');

    expect(result).toMatchObject({ ok: false, captured: false, deferred: false, path: null });
    expect(result.error).toContain('auth bond is missing');
    expect(result.error).toContain('creds_json_missing');
  });

  it('fails stale zero-byte credential reads after the write grace expires', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    mkdirSync(authDir, { recursive: true, mode: 0o700 });
    const credsPath = join(authDir, 'creds.json');
    writeFileSync(credsPath, '');
    const stale = new Date('2026-06-09T12:00:00Z');
    utimesSync(credsPath, stale, stale);

    const guard = new AuthBondGuard({
      authDir,
      stateRoot: join(root, 'state'),
      instanceName: 'stale-zero-byte-bot',
      captureAttempts: 1,
      freshInvalidGraceMs: 5_000,
      now: () => new Date('2026-06-09T12:00:10Z'),
    });

    const result = guard.capture('creds-update');

    expect(result).toMatchObject({ ok: false, captured: false, deferred: false, path: null });
    expect(result.error).toContain('auth bond is invalid');
    expect(guard.inspect().backup.lastCaptureError).toContain('creds_json_empty');
    expect(guard.inspect().backup.lastCaptureDeferredAt).toBeNull();
  });

  it('refuses captures without a stable WhatsApp identity and preserves the previous protected snapshot', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    writeAuth(authDir, '15550100021:1@s.whatsapp.net');

    const guard = new AuthBondGuard({
      authDir,
      stateRoot,
      instanceName: 'missing-identity-bot',
      now: () => new Date('2026-06-09T12:00:00Z'),
    });

    const good = guard.capture('connection-open');
    expect(good).toMatchObject({ ok: true, captured: true, error: null });
    const latestPath = join(stateRoot, 'auth-bond-backups', 'missing-identity-bot', 'latest.json');
    const latestBefore = JSON.parse(readFileSync(latestPath, 'utf8')) as { backupPath: string; treeHash: string };

    writeFileSync(join(authDir, 'creds.json'), JSON.stringify({ registrationId: 2 }));
    const failed = guard.capture('creds-update');

    expect(failed).toMatchObject({
      ok: false,
      captured: false,
      path: null,
      snapshot: {
        status: 'invalid',
        meHash: null,
        issues: expect.arrayContaining(['creds_json_missing_me']),
      },
    });
    expect(failed.error).toContain('creds_json_missing_me');
    const latestAfter = JSON.parse(readFileSync(latestPath, 'utf8')) as { backupPath: string; treeHash: string };
    expect(latestAfter).toEqual(latestBefore);
    expect(readdirSync(join(stateRoot, 'auth-bond-backups', 'missing-identity-bot', 'history'))).toHaveLength(1);

    const protectedCreds = JSON.parse(readFileSync(join(latestAfter.backupPath, 'auth', 'creds.json'), 'utf8')) as {
      me?: { id?: string };
    };
    expect(protectedCreds.me?.id).toBe('15550100021:1@s.whatsapp.net');
  });

  it('blocks snapshots during logged-out capture windows and preserves the previous protected snapshot', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    writeAuth(authDir, '15550100022:1@s.whatsapp.net');
    let captureBlockReason: string | null = null;

    const guard = new AuthBondGuard({
      authDir,
      stateRoot,
      instanceName: 'logged-out-bot',
      now: () => new Date('2026-06-09T12:00:00Z'),
      captureBlockReason: () => captureBlockReason,
    });

    const good = guard.capture('connection-open');
    expect(good).toMatchObject({ ok: true, captured: true, error: null });
    const latestPath = join(stateRoot, 'auth-bond-backups', 'logged-out-bot', 'latest.json');
    const latestBefore = JSON.parse(readFileSync(latestPath, 'utf8')) as { backupPath: string; treeHash: string };

    captureBlockReason = 'loggedOut/device-bond-lost state active';
    writeAuth(authDir, '15550199999:1@s.whatsapp.net');
    const blocked = guard.capture('creds-update');

    expect(blocked).toMatchObject({
      ok: false,
      captured: false,
      path: null,
      error: expect.stringContaining('auth bond capture blocked: loggedOut/device-bond-lost state active'),
      snapshot: { status: 'present' },
    });
    const latestAfter = JSON.parse(readFileSync(latestPath, 'utf8')) as { backupPath: string; treeHash: string };
    expect(latestAfter).toEqual(latestBefore);
    expect(readdirSync(join(stateRoot, 'auth-bond-backups', 'logged-out-bot', 'history'))).toHaveLength(1);

    const protectedCreds = JSON.parse(readFileSync(join(latestAfter.backupPath, 'auth', 'creds.json'), 'utf8')) as {
      me?: { id?: string };
    };
    expect(protectedCreds.me?.id).toBe('15550100022:1@s.whatsapp.net');
  });

  it('repairs live auth directory and credential file permissions during inspection', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    writeAuth(authDir);
    chmodSync(authDir, 0o755);
    chmodSync(join(authDir, 'creds.json'), 0o644);

    const guard = new AuthBondGuard({ authDir, stateRoot: join(root, 'state'), instanceName: 'mode-bot' });
    const snapshot = guard.inspect();

    expect(snapshot.status).toBe('present');
    expect(statSync(authDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(authDir, 'creds.json')).mode & 0o777).toBe(0o600);
    expect(snapshot.authDir.mode).toBe('700');
    expect(snapshot.creds.mode).toBe('600');
  });

  it('prunes stale protected backups while ignoring local metadata files', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    let now = new Date('2026-06-09T12:00:00Z');
    writeAuth(authDir, '15550100040:1@s.whatsapp.net');
    writeFileSync(join(authDir, '.DS_Store'), 'metadata');

    const guard = new AuthBondGuard({
      authDir,
      stateRoot,
      instanceName: 'prune-bot',
      keepBackups: 2,
      now: () => now,
    });

    const first = guard.capture('connection-open');
    expect(first.ok).toBe(true);
    expect(existsSync(join(first.path!, 'auth', '.DS_Store'))).toBe(false);

    now = new Date('2026-06-09T12:01:00Z');
    writeAuth(authDir, '15550100041:1@s.whatsapp.net');
    expect(guard.capture('creds-update').ok).toBe(true);

    now = new Date('2026-06-09T12:02:00Z');
    writeAuth(authDir, '15550100042:1@s.whatsapp.net');
    const third = guard.capture('creds-update');

    expect(third.ok).toBe(true);
    const history = readdirSync(join(stateRoot, 'auth-bond-backups', 'prune-bot', 'history'));
    expect(history).toHaveLength(2);
    expect(existsSync(first.path!)).toBe(false);
  });

  it('excludes in-flight temp backup directories from retention pruning', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    let now = new Date('2026-06-09T12:00:00Z');
    writeAuth(authDir, '15550100070:1@s.whatsapp.net');

    const guard = new AuthBondGuard({
      authDir,
      stateRoot,
      instanceName: 'tmp-prune-bot',
      keepBackups: 2,
      now: () => now,
    });

    const first = guard.capture('connection-open');
    expect(first.ok).toBe(true);

    now = new Date('2026-06-09T12:01:00Z');
    writeAuth(authDir, '15550100071:1@s.whatsapp.net');
    const second = guard.capture('creds-update');
    expect(second.ok).toBe(true);

    const historyRoot = join(stateRoot, 'auth-bond-backups', 'tmp-prune-bot', 'history');
    const inFlightTmp = join(historyRoot, '20260609T120300Z.creds-update.inflight.tmp-999');
    mkdirSync(inFlightTmp, { recursive: true, mode: 0o700 });

    now = new Date('2026-06-09T12:02:00Z');
    writeAuth(authDir, '15550100072:1@s.whatsapp.net');
    const third = guard.capture('creds-update');
    expect(third.ok).toBe(true);

    const history = readdirSync(historyRoot).sort();
    const completed = history.filter(name => !name.includes('.tmp-'));
    expect(history).toContain('20260609T120300Z.creds-update.inflight.tmp-999');
    expect(completed).toHaveLength(2);
    expect(existsSync(first.path!)).toBe(false);
    expect(existsSync(second.path!)).toBe(true);
    expect(existsSync(third.path!)).toBe(true);
  });

  it('leaves backup history unpruned when the retention count is zero', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    let now = new Date('2026-06-09T12:00:00Z');
    writeAuth(authDir, '15550100047:1@s.whatsapp.net');

    const guard = new AuthBondGuard({
      authDir,
      stateRoot,
      instanceName: 'no-prune-bot',
      keepBackups: 0,
      now: () => now,
    });

    expect(guard.capture('connection-open').ok).toBe(true);
    now = new Date('2026-06-09T12:01:00Z');
    writeAuth(authDir, '15550100048:1@s.whatsapp.net');
    expect(guard.capture('creds-update').ok).toBe(true);

    const history = readdirSync(join(stateRoot, 'auth-bond-backups', 'no-prune-bot', 'history'));
    expect(history).toHaveLength(2);
  });

  it('does not restore when auth is healthy, auto-restore is disabled, or no backup exists', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    writeAuth(authDir, '15550100043:1@s.whatsapp.net');

    const healthy = new AuthBondGuard({ authDir, stateRoot, instanceName: 'restore-noop-bot' });
    expect(healthy.restoreLatestIfNeeded()).toMatchObject({
      attempted: false,
      restored: false,
      source: null,
      error: null,
    });

    rmSync(authDir, { recursive: true, force: true });
    const disabled = new AuthBondGuard({ authDir, stateRoot, instanceName: 'restore-disabled-bot', autoRestore: false });
    expect(disabled.restoreLatestIfNeeded()).toMatchObject({
      attempted: false,
      restored: false,
      source: null,
      error: 'auto-restore disabled',
    });

    const missingBackup = new AuthBondGuard({ authDir, stateRoot, instanceName: 'restore-no-backup-bot' });
    expect(missingBackup.restoreLatestIfNeeded()).toMatchObject({
      attempted: true,
      restored: false,
      source: null,
      error: 'no auth-bond backup available',
    });
    expect(missingBackup.inspect().backup.lastRestoreError).toBe('no auth-bond backup available');
  });

  it('restores missing local auth from the latest protected snapshot', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    writeAuth(authDir, '15550100009:1@s.whatsapp.net');
    const guard = new AuthBondGuard({ authDir, stateRoot, instanceName: 'restore-bot' });
    expect(guard.capture('connection-open').ok).toBe(true);

    rmSync(authDir, { recursive: true, force: true });
    const restored = guard.restoreLatestIfNeeded();

    expect(restored).toMatchObject({ attempted: true, restored: true, error: null });
    expect(readFileSync(join(authDir, 'creds.json'), 'utf8')).toContain('15550100009');
    expect(guard.inspect().status).toBe('present');
  });

  it('restores corrupt local auth and quarantines the broken tree', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    writeAuth(authDir, '15550100014:1@s.whatsapp.net');
    const guard = new AuthBondGuard({
      authDir,
      stateRoot,
      instanceName: 'restore-corrupt-bot',
      now: () => new Date('2026-06-09T12:00:00Z'),
    });
    const captured = guard.capture('connection-open');
    expect(captured.ok).toBe(true);

    writeFileSync(join(authDir, 'creds.json'), '{ bad json');
    writeFileSync(join(authDir, 'live-only.json'), JSON.stringify({ kept: true }));
    const restored = guard.restoreLatestIfNeeded();

    expect(restored).toMatchObject({
      attempted: true,
      restored: true,
      source: captured.path,
      error: null,
      snapshot: { status: 'present' },
    });
    expect(readFileSync(join(authDir, 'creds.json'), 'utf8')).toContain('15550100014');
    expect(existsSync(join(authDir, 'live-only.json'))).toBe(false);

    const quarantineRoot = join(stateRoot, 'auth-bond-backups', 'restore-corrupt-bot', 'quarantine');
    const quarantineEntries = readdirSync(quarantineRoot);
    expect(quarantineEntries).toHaveLength(1);
    expect(quarantineEntries[0]).toContain('.auth.broken');
    const quarantinedAuth = join(quarantineRoot, quarantineEntries[0]);
    expect(readFileSync(join(quarantinedAuth, 'creds.json'), 'utf8')).toBe('{ bad json');
    expect(readFileSync(join(quarantinedAuth, 'live-only.json'), 'utf8')).toBe('{"kept":true}');

    const snapshot = guard.inspect();
    expect(snapshot.backup).toMatchObject({
      lastRestoreSource: captured.path,
      lastRestoreError: null,
    });
  });

  it('refuses to restore from a backup with a missing manifest', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    writeAuth(authDir, '15550100011:1@s.whatsapp.net');
    const guard = new AuthBondGuard({ authDir, stateRoot, instanceName: 'restore-guard-bot' });
    const captured = guard.capture('connection-open');
    expect(captured.ok).toBe(true);

    rmSync(join(captured.path!, 'manifest.json'), { force: true });
    rmSync(authDir, { recursive: true, force: true });
    const restored = guard.restoreLatestIfNeeded();

    expect(restored).toMatchObject({ attempted: true, restored: false, source: captured.path });
    expect(restored.error).toContain('backup manifest is unreadable');
    expect(existsSync(authDir)).toBe(false);
  });

  it('refuses to restore from backup pointers that are symlinks, files, or unreadable paths', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    writeAuth(authDir, '15550100044:1@s.whatsapp.net');
    const guard = new AuthBondGuard({ authDir, stateRoot, instanceName: 'restore-path-guard-bot' });
    const captured = guard.capture('connection-open');
    expect(captured.ok).toBe(true);

    const latestPath = join(stateRoot, 'auth-bond-backups', 'restore-path-guard-bot', 'latest.json');
    const latest = JSON.parse(readFileSync(latestPath, 'utf8')) as Record<string, unknown>;
    const historyRoot = join(stateRoot, 'auth-bond-backups', 'restore-path-guard-bot', 'history');

    const symlinkBackup = join(historyRoot, 'symlink-backup');
    symlinkSync(captured.path!, symlinkBackup, 'dir');
    writeFileSync(latestPath, `${JSON.stringify({ ...latest, backupPath: symlinkBackup }, null, 2)}\n`, { mode: 0o600 });
    rmSync(authDir, { recursive: true, force: true });
    expect(guard.restoreLatestIfNeeded()).toMatchObject({
      attempted: true,
      restored: false,
      source: symlinkBackup,
      error: expect.stringContaining('backup path is a symlink'),
    });

    const fileBackup = join(historyRoot, 'file-backup');
    writeFileSync(fileBackup, 'not a directory');
    writeFileSync(latestPath, `${JSON.stringify({ ...latest, backupPath: fileBackup }, null, 2)}\n`, { mode: 0o600 });
    expect(guard.restoreLatestIfNeeded()).toMatchObject({
      attempted: true,
      restored: false,
      source: fileBackup,
      error: expect.stringContaining('backup path is not a directory'),
    });

    const missingBackup = join(historyRoot, 'missing-backup');
    writeFileSync(latestPath, `${JSON.stringify({ ...latest, backupPath: missingBackup }, null, 2)}\n`, { mode: 0o600 });
    expect(guard.restoreLatestIfNeeded()).toMatchObject({
      attempted: true,
      restored: false,
      source: missingBackup,
      error: expect.stringContaining('backup path is unreadable'),
    });
  });

  it.each([
    {
      name: 'a non-object manifest',
      mutate: (backupPath: string) => {
        writeFileSync(join(backupPath, 'manifest.json'), JSON.stringify(['bad']));
      },
      expected: 'backup manifest is not an object',
    },
    {
      name: 'a mismatched instance manifest',
      mutate: (backupPath: string) => {
        const manifestPath = join(backupPath, 'manifest.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
        writeFileSync(manifestPath, JSON.stringify({ ...manifest, instanceName: 'other-bot' }));
      },
      expected: 'backup instance mismatch',
    },
    {
      name: 'a stale latest tree hash',
      mutate: (_backupPath: string, latestPath: string) => {
        const latest = JSON.parse(readFileSync(latestPath, 'utf8')) as Record<string, unknown>;
        writeFileSync(latestPath, JSON.stringify({ ...latest, treeHash: 'different-tree-hash' }));
      },
      expected: 'latest pointer tree hash does not match backup manifest',
    },
    {
      name: 'a symlinked backup auth tree',
      mutate: (backupPath: string, _latestPath: string, root: string) => {
        const outsideCreds = join(root, 'outside-backup-creds.json');
        writeFileSync(outsideCreds, JSON.stringify({ me: { id: '15550109999:1@s.whatsapp.net' } }), { mode: 0o600 });
        rmSync(join(backupPath, 'auth', 'creds.json'), { force: true });
        symlinkSync(outsideCreds, join(backupPath, 'auth', 'creds.json'));
      },
      expected: 'backup auth tree contains symlink',
    },
    {
      name: 'missing backup credentials',
      mutate: (backupPath: string) => {
        rmSync(join(backupPath, 'auth', 'creds.json'), { force: true });
      },
      expected: 'backup auth missing creds.json',
    },
    {
      name: 'empty backup credentials',
      mutate: (backupPath: string) => {
        writeFileSync(join(backupPath, 'auth', 'creds.json'), '');
      },
      expected: 'backup creds.json is empty',
    },
    {
      name: 'non-object backup credentials',
      mutate: (backupPath: string) => {
        const manifestPath = join(backupPath, 'manifest.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
        writeFileSync(manifestPath, JSON.stringify({ ...manifest, credsHash: null, treeHash: null }));
        writeFileSync(join(backupPath, 'auth', 'creds.json'), JSON.stringify(['bad']));
      },
      expected: 'backup creds.json is not an object',
    },
    {
      name: 'backup credentials without identity',
      mutate: (backupPath: string) => {
        const manifestPath = join(backupPath, 'manifest.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
        writeFileSync(manifestPath, JSON.stringify({ ...manifest, credsHash: null, treeHash: null }));
        writeFileSync(join(backupPath, 'auth', 'creds.json'), JSON.stringify({ registrationId: 3 }));
      },
      expected: 'backup creds.json is missing identity',
    },
    {
      name: 'invalid-json backup credentials',
      mutate: (backupPath: string) => {
        const manifestPath = join(backupPath, 'manifest.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
        writeFileSync(manifestPath, JSON.stringify({ ...manifest, credsHash: null, treeHash: null }));
        writeFileSync(join(backupPath, 'auth', 'creds.json'), '{ bad json');
      },
      expected: 'backup creds.json is invalid json',
    },
    {
      name: 'backup credentials with a different identity',
      mutate: (backupPath: string) => {
        const manifestPath = join(backupPath, 'manifest.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
        writeFileSync(manifestPath, JSON.stringify({ ...manifest, credsHash: null, treeHash: null }));
        writeFileSync(join(backupPath, 'auth', 'creds.json'), JSON.stringify({
          me: { id: '15550109998:1@s.whatsapp.net' },
          registrationId: 3,
        }));
      },
      expected: 'backup creds.json identity mismatch',
    },
    {
      name: 'backup tree drift outside credentials',
      mutate: (backupPath: string) => {
        writeFileSync(join(backupPath, 'auth', 'app-state-sync-key-test.json'), JSON.stringify({ keyData: 'changed' }));
      },
      expected: 'backup auth tree hash mismatch',
    },
  ])('refuses to restore from $name', ({ mutate, expected }) => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    writeAuth(authDir, '15550100045:1@s.whatsapp.net');
    const guard = new AuthBondGuard({ authDir, stateRoot, instanceName: 'restore-validation-bot' });
    const captured = guard.capture('connection-open');
    expect(captured.ok).toBe(true);

    const latestPath = join(stateRoot, 'auth-bond-backups', 'restore-validation-bot', 'latest.json');
    mutate(captured.path!, latestPath, root);
    rmSync(authDir, { recursive: true, force: true });

    const restored = guard.restoreLatestIfNeeded();

    expect(restored).toMatchObject({ attempted: true, restored: false, source: captured.path });
    expect(restored.error).toContain(expected);
    expect(existsSync(authDir)).toBe(false);
  });

  it('refuses to restore from a backup whose auth tree no longer matches its manifest', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    writeAuth(authDir, '15550100012:1@s.whatsapp.net');
    const guard = new AuthBondGuard({ authDir, stateRoot, instanceName: 'restore-guard-bot' });
    const captured = guard.capture('connection-open');
    expect(captured.ok).toBe(true);

    writeFileSync(join(captured.path!, 'auth', 'creds.json'), JSON.stringify({
      me: { id: '15550199999:1@s.whatsapp.net', lid: 'changed@lid' },
      registrationId: 99,
    }));
    rmSync(authDir, { recursive: true, force: true });
    const restored = guard.restoreLatestIfNeeded();

    expect(restored).toMatchObject({ attempted: true, restored: false, source: captured.path });
    expect(restored.error).toContain('backup creds.json hash mismatch');
    expect(existsSync(authDir)).toBe(false);
  });

  it('refuses to restore from a latest pointer outside the protected history root', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    writeAuth(authDir, '15550100032:1@s.whatsapp.net');
    const guard = new AuthBondGuard({ authDir, stateRoot, instanceName: 'escape-restore-bot' });
    const captured = guard.capture('connection-open');
    expect(captured.ok).toBe(true);

    const outsideBackup = join(root, 'outside-backup');
    cpSync(captured.path!, outsideBackup, { recursive: true });
    const latestPath = join(stateRoot, 'auth-bond-backups', 'escape-restore-bot', 'latest.json');
    const latest = JSON.parse(readFileSync(latestPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(latestPath, `${JSON.stringify({ ...latest, backupPath: outsideBackup }, null, 2)}\n`, { mode: 0o600 });
    rmSync(authDir, { recursive: true, force: true });

    const restored = guard.restoreLatestIfNeeded();

    expect(restored).toMatchObject({ attempted: true, restored: false, source: outsideBackup });
    expect(restored.error).toContain('backup path escapes history root');
    expect(existsSync(authDir)).toBe(false);
  });
});
