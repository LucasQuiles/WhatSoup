// Branch-coverage drafts for src/transport/auth-bond.ts (RR-013).
// Targets ONLY uncovered branch arms identified from coverage-final.json; does
// not duplicate scenarios already exercised in tests/transport/auth-bond.test.ts.
//
// All members of AuthBondGuard are reached through the public API
// (inspect/capture/restoreLatestIfNeeded). Module-private helpers
// (safeName/extractMeHash/walkAuthFiles/copyPrivateTree/hardenPrivateTree/
// readLatestManifest/assertPrivateJsonTarget) are exercised transitively.
//
// Repo-hygiene: all WhatsApp identities use reserved ranges (1555NNNN /
// 1111111N @s.whatsapp.net, @lid). Fake creds are obviously non-secret.

// vi.mock must be hoisted (before imports) — Vitest rewrites this automatically.
// We wrap every real node:fs export so named-import consumers (auth-bond.ts)
// get the mock-controlled version. copyFileSync is replaced with a controllable
// ref so individual tests can inject a throw without namespace-spy ESM issues.
let mockCopyFileSyncImpl: ((...args: Parameters<typeof import('node:fs').copyFileSync>) => void) | null = null;

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    copyFileSync: (...args: Parameters<typeof real.copyFileSync>) => {
      if (mockCopyFileSyncImpl !== null) {
        return mockCopyFileSyncImpl(...args);
      }
      return real.copyFileSync(...args);
    },
  };
});

import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthBondGuard } from '../../src/transport/auth-bond.ts';

let tmpRoot = '';

afterEach(() => {
  // Reset the copyFileSync override between tests.
  mockCopyFileSyncImpl = null;
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
});

function makeRoot(): string {
  tmpRoot = mkdtempSync(join(tmpdir(), 'whatsoup-auth-bond-branch-'));
  return tmpRoot;
}

function writeAuth(authDir: string, id = '15550100:1@s.whatsapp.net'): void {
  mkdirSync(authDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(authDir, 'creds.json'), JSON.stringify({
    me: { id, lid: '11111110:1@lid' },
    registrationId: 1,
  }));
  writeFileSync(join(authDir, 'app-state-sync-key-test.json'), JSON.stringify({ keyData: 'not-a-real-key' }));
}

describe('AuthBondGuard uncovered branches', () => {
  // --- safeName(): cleaned === '' fallback to 'unknown' (auth-bond.ts:116) ---
  it('falls back to "unknown" instance directory when the name is all separators', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    writeAuth(authDir);
    const guard = new AuthBondGuard({
      authDir,
      stateRoot,
      instanceName: '///',
      now: () => new Date('2026-06-09T12:00:00Z'),
    });
    const result = guard.capture('connection-open');
    expect(result.ok).toBe(true);
    expect(existsSync(join(stateRoot, 'auth-bond-backups', 'unknown', 'latest.json'))).toBe(true);
  });

  // --- extractMeHash(): me non-object/array, lid fallback, id null ---
  it('treats a non-object "me" field as missing identity (extractMeHash early null)', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    mkdirSync(authDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(authDir, 'creds.json'), JSON.stringify({ me: ['nope'], registrationId: 1 }));
    const snap = new AuthBondGuard({ authDir, stateRoot: join(root, 'state'), instanceName: 'arr-me-bot' }).inspect();
    expect(snap.status).toBe('invalid');
    expect(snap.meHash).toBeNull();
    expect(snap.issues).toContain('creds_json_missing_me');
  });

  it('derives identity from "lid" when "id" is absent (extractMeHash lid fallback)', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    mkdirSync(authDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(authDir, 'creds.json'), JSON.stringify({ me: { lid: '11111112:9@lid' }, registrationId: 1 }));
    const snap = new AuthBondGuard({ authDir, stateRoot: join(root, 'state'), instanceName: 'lid-only-bot' }).inspect();
    expect(snap.status).toBe('present');
    expect(snap.meHash).toHaveLength(20);
  });

  it('treats a "me" without string id or lid as missing identity (extractMeHash id === null)', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    mkdirSync(authDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(authDir, 'creds.json'), JSON.stringify({ me: { id: 42, lid: 7 }, registrationId: 1 }));
    const snap = new AuthBondGuard({ authDir, stateRoot: join(root, 'state'), instanceName: 'no-id-bot' }).inspect();
    expect(snap.status).toBe('invalid');
    expect(snap.meHash).toBeNull();
    expect(snap.issues).toContain('creds_json_missing_me');
  });

  // --- inspect(): parsed creds is array -> creds_json_not_object (auth-bond.ts:473-482) ---
  it('reports creds_json_not_object when creds.json parses to a JSON array', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    mkdirSync(authDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(authDir, 'creds.json'), JSON.stringify(['not', 'an', 'object']));
    const snap = new AuthBondGuard({ authDir, stateRoot: join(root, 'state'), instanceName: 'array-creds-bot' }).inspect();
    expect(snap.status).toBe('invalid');
    expect(snap.meHash).toBeNull();
    expect(snap.issues).toContain('creds_json_not_object');
  });

  // --- walkAuthFiles symlink throw is reached only via hashAuthTree on a tree
  //     that already passed hardenPrivateTree; inspect() classifies symlinked
  //     trees 'invalid' first, so we assert that classification here. ---
  it('refuses to treat an auth tree containing a symlinked non-creds file as present', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    writeAuth(authDir);
    const outside = join(root, 'outside-extra.json');
    writeFileSync(outside, JSON.stringify({ extra: true }), { mode: 0o600 });
    symlinkSync(outside, join(authDir, 'linked-extra.json'));
    const snap = new AuthBondGuard({ authDir, stateRoot: join(root, 'state'), instanceName: 'nested-symlink-bot' }).inspect();
    expect(snap.issues.some(i => i.startsWith('auth_tree_symlink:'))).toBe(true);
    // A symlinked auth tree is classified 'invalid', so treeHash is suppressed
    // to null and no me-identity is hashed. Assert the full classification shape
    // so the terminal assertion carries the state, not a bare null check.
    expect(snap).toMatchObject({ status: 'invalid', treeHash: null, meHash: null });
  });

  // UNREACHABLE — recommend /* v8 ignore */: the symlink throw inside
  // walkAuthFiles (auth-bond.ts:204-206). hashAuthTree only runs after
  // hardenPrivateTree has classified any symlinked tree as 'invalid' (inspect)
  // or thrown auth_tree_symlink (authTreeValidationError), so walkAuthFiles
  // never observes a symlink. Flagged, not fake-covered.

  // --- copyPrivateTree(): .DS_Store skip (auth-bond.ts:238) via capture ---
  it('captures successfully while skipping a .DS_Store entry in the auth tree', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    writeAuth(authDir, '15550101:1@s.whatsapp.net');
    writeFileSync(join(authDir, '.DS_Store'), 'junk');
    const guard = new AuthBondGuard({
      authDir,
      stateRoot,
      instanceName: 'dsstore-bot',
      now: () => new Date('2026-06-09T12:00:00Z'),
    });
    const result = guard.capture('connection-open');
    expect(result.ok).toBe(true);
    expect(existsSync(join(result.path!, 'auth', '.DS_Store'))).toBe(false);
    expect(existsSync(join(result.path!, 'auth', 'creds.json'))).toBe(true);
  });

  // --- hardenPrivateTree(): chmod arms on NON-root sub-entries + directory
  //     re-stack (auth-bond.ts:271-277, 281-288) ---
  it('repairs permissions on nested auth subdirectories and files (non-root rel paths)', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    writeAuth(authDir, '15550102:1@s.whatsapp.net');
    const sub = join(authDir, 'keys');
    mkdirSync(sub, { recursive: true, mode: 0o700 });
    const nested = join(sub, 'pre-key-1.json');
    writeFileSync(nested, JSON.stringify({ k: 1 }));
    chmodSync(sub, 0o755);
    chmodSync(nested, 0o644);
    const snap = new AuthBondGuard({ authDir, stateRoot: join(root, 'state'), instanceName: 'nested-mode-bot' }).inspect();
    expect(snap.status).toBe('present');
    expect(statSync(sub).mode & 0o777).toBe(0o700);
    expect(statSync(nested).mode & 0o777).toBe(0o600);
  });

  // --- authTreeValidationError() arms via validateBackupForRestore ---
  it('refuses restore when the backup creds.json is missing (auth missing creds.json)', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    writeAuth(authDir, '15550103:1@s.whatsapp.net');
    const guard = new AuthBondGuard({ authDir, stateRoot, instanceName: 'missing-backup-creds-bot' });
    const captured = guard.capture('connection-open');
    expect(captured.ok).toBe(true);
    rmSync(join(captured.path!, 'auth', 'creds.json'), { force: true });
    rmSync(authDir, { recursive: true, force: true });
    const restored = guard.restoreLatestIfNeeded();
    expect(restored).toMatchObject({ attempted: true, restored: false });
    expect(restored.error).toContain('auth missing creds.json');
    expect(existsSync(authDir)).toBe(false);
  });

  it('refuses restore when the backup creds.json is empty (creds.json is empty)', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    writeAuth(authDir, '15550104:1@s.whatsapp.net');
    const guard = new AuthBondGuard({ authDir, stateRoot, instanceName: 'empty-backup-creds-bot' });
    const captured = guard.capture('connection-open');
    expect(captured.ok).toBe(true);
    writeFileSync(join(captured.path!, 'auth', 'creds.json'), '');
    rmSync(authDir, { recursive: true, force: true });
    const restored = guard.restoreLatestIfNeeded();
    expect(restored.restored).toBe(false);
    expect(restored.error).toContain('creds.json is empty');
  });

  it('refuses restore when backup creds.json is a non-object but its hash matches the manifest', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    writeAuth(authDir, '15550106:1@s.whatsapp.net');
    const guard = new AuthBondGuard({ authDir, stateRoot, instanceName: 'nonobj-match-bot' });
    const captured = guard.capture('connection-open');
    expect(captured.ok).toBe(true);
    const arrayBody = JSON.stringify([1, 2, 3]);
    const credsPath = join(captured.path!, 'auth', 'creds.json');
    writeFileSync(credsPath, arrayBody);
    const newCredsHash = createHash('sha256').update(readFileSync(credsPath)).digest('hex');
    const manifestPath = join(captured.path!, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest['credsHash'] = newCredsHash;
    delete manifest['treeHash'];
    delete manifest['meHash'];
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    const latestPath = join(stateRoot, 'auth-bond-backups', 'nonobj-match-bot', 'latest.json');
    const latest = JSON.parse(readFileSync(latestPath, 'utf8')) as Record<string, unknown>;
    delete latest['treeHash'];
    writeFileSync(latestPath, JSON.stringify(latest, null, 2), { mode: 0o600 });
    rmSync(authDir, { recursive: true, force: true });
    const restored = guard.restoreLatestIfNeeded();
    expect(restored.restored).toBe(false);
    expect(restored.error).toContain('creds.json is not an object');
  });

  it('refuses restore when backup creds.json is invalid JSON but its hash matches', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    writeAuth(authDir, '15550107:1@s.whatsapp.net');
    const guard = new AuthBondGuard({ authDir, stateRoot, instanceName: 'invalidjson-match-bot' });
    const captured = guard.capture('connection-open');
    expect(captured.ok).toBe(true);
    const credsPath = join(captured.path!, 'auth', 'creds.json');
    writeFileSync(credsPath, '{ not json');
    const newHash = createHash('sha256').update(readFileSync(credsPath)).digest('hex');
    const manifestPath = join(captured.path!, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest['credsHash'] = newHash;
    delete manifest['treeHash'];
    delete manifest['meHash'];
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    const latestPath = join(stateRoot, 'auth-bond-backups', 'invalidjson-match-bot', 'latest.json');
    const latest = JSON.parse(readFileSync(latestPath, 'utf8')) as Record<string, unknown>;
    delete latest['treeHash'];
    writeFileSync(latestPath, JSON.stringify(latest, null, 2), { mode: 0o600 });
    rmSync(authDir, { recursive: true, force: true });
    const restored = guard.restoreLatestIfNeeded();
    expect(restored.restored).toBe(false);
    expect(restored.error).toContain('creds.json is invalid json');
  });

  it('refuses restore when backup creds.json lacks identity but its hash matches', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    writeAuth(authDir, '15550108:1@s.whatsapp.net');
    const guard = new AuthBondGuard({ authDir, stateRoot, instanceName: 'noidentity-match-bot' });
    const captured = guard.capture('connection-open');
    expect(captured.ok).toBe(true);
    const credsPath = join(captured.path!, 'auth', 'creds.json');
    writeFileSync(credsPath, JSON.stringify({ registrationId: 5 }));
    const newHash = createHash('sha256').update(readFileSync(credsPath)).digest('hex');
    const manifestPath = join(captured.path!, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest['credsHash'] = newHash;
    delete manifest['treeHash'];
    delete manifest['meHash'];
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    const latestPath = join(stateRoot, 'auth-bond-backups', 'noidentity-match-bot', 'latest.json');
    const latest = JSON.parse(readFileSync(latestPath, 'utf8')) as Record<string, unknown>;
    delete latest['treeHash'];
    writeFileSync(latestPath, JSON.stringify(latest, null, 2), { mode: 0o600 });
    rmSync(authDir, { recursive: true, force: true });
    const restored = guard.restoreLatestIfNeeded();
    expect(restored.restored).toBe(false);
    expect(restored.error).toContain('creds.json is missing identity');
  });

  it('refuses restore when the backup creds.json identity does not match the manifest', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    writeAuth(authDir, '15550109:1@s.whatsapp.net');
    const guard = new AuthBondGuard({ authDir, stateRoot, instanceName: 'identity-mismatch-bot' });
    const captured = guard.capture('connection-open');
    expect(captured.ok).toBe(true);
    const credsPath = join(captured.path!, 'auth', 'creds.json');
    writeFileSync(credsPath, JSON.stringify({ me: { id: '15550199:9@s.whatsapp.net' }, registrationId: 9 }));
    const newHash = createHash('sha256').update(readFileSync(credsPath)).digest('hex');
    const manifestPath = join(captured.path!, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest['credsHash'] = newHash; // matching content hash
    delete manifest['treeHash'];
    // keep manifest.meHash as ORIGINAL identity -> identity mismatch arm fires.
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    const latestPath = join(stateRoot, 'auth-bond-backups', 'identity-mismatch-bot', 'latest.json');
    const latest = JSON.parse(readFileSync(latestPath, 'utf8')) as Record<string, unknown>;
    delete latest['treeHash'];
    writeFileSync(latestPath, JSON.stringify(latest, null, 2), { mode: 0o600 });
    rmSync(authDir, { recursive: true, force: true });
    const restored = guard.restoreLatestIfNeeded();
    expect(restored.restored).toBe(false);
    expect(restored.error).toContain('creds.json identity mismatch');
  });

  it('refuses restore when the backup auth tree hash does not match the manifest', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    writeAuth(authDir, '15550110:1@s.whatsapp.net');
    const guard = new AuthBondGuard({ authDir, stateRoot, instanceName: 'treehash-mismatch-bot' });
    const captured = guard.capture('connection-open');
    expect(captured.ok).toBe(true);
    // Extra file -> recomputed treeHash differs while creds (hash+identity) match.
    writeFileSync(join(captured.path!, 'auth', 'pre-key-extra.json'), JSON.stringify({ added: true }));
    const latestPath = join(stateRoot, 'auth-bond-backups', 'treehash-mismatch-bot', 'latest.json');
    const latest = JSON.parse(readFileSync(latestPath, 'utf8')) as Record<string, unknown>;
    delete latest['treeHash']; // avoid latest-vs-manifest check dominating
    writeFileSync(latestPath, JSON.stringify(latest, null, 2), { mode: 0o600 });
    rmSync(authDir, { recursive: true, force: true });
    const restored = guard.restoreLatestIfNeeded();
    expect(restored.restored).toBe(false);
    expect(restored.error).toContain('auth tree hash mismatch');
  });

  // --- validateBackupForRestore(): manifest not-object, instance mismatch,
  //     latest-vs-manifest tree mismatch (auth-bond.ts:760, 768, 771) ---
  it('refuses restore when the backup manifest is a JSON array (manifest not an object)', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    writeAuth(authDir, '15550112:1@s.whatsapp.net');
    const guard = new AuthBondGuard({ authDir, stateRoot, instanceName: 'manifest-array-bot' });
    const captured = guard.capture('connection-open');
    expect(captured.ok).toBe(true);
    writeFileSync(join(captured.path!, 'manifest.json'), JSON.stringify(['not', 'object']));
    rmSync(authDir, { recursive: true, force: true });
    const restored = guard.restoreLatestIfNeeded();
    expect(restored.restored).toBe(false);
    expect(restored.error).toContain('backup manifest is not an object');
  });

  it('refuses restore when the backup manifest instanceName mismatches the guard', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    writeAuth(authDir, '15550113:1@s.whatsapp.net');
    const guard = new AuthBondGuard({ authDir, stateRoot, instanceName: 'instance-mismatch-bot' });
    const captured = guard.capture('connection-open');
    expect(captured.ok).toBe(true);
    const manifestPath = join(captured.path!, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest['instanceName'] = 'some-other-bot';
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    rmSync(authDir, { recursive: true, force: true });
    const restored = guard.restoreLatestIfNeeded();
    expect(restored.restored).toBe(false);
    expect(restored.error).toContain('backup instance mismatch');
  });

  it('refuses restore when the latest pointer treeHash disagrees with the manifest', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    writeAuth(authDir, '15550114:1@s.whatsapp.net');
    const guard = new AuthBondGuard({ authDir, stateRoot, instanceName: 'pointer-treehash-bot' });
    const captured = guard.capture('connection-open');
    expect(captured.ok).toBe(true);
    const manifestPath = join(captured.path!, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest['treeHash'] = 'deadbeef'.repeat(8); // present + differs from latest
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    rmSync(authDir, { recursive: true, force: true });
    const restored = guard.restoreLatestIfNeeded();
    expect(restored.restored).toBe(false);
    expect(restored.error).toContain('latest pointer tree hash does not match backup manifest');
  });

  // --- backupPathProblem(): symlink, not-directory, unreadable (788, 789, 791) ---
  it('refuses restore when the latest backup path is a symlink', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    writeAuth(authDir, '15550115:1@s.whatsapp.net');
    const guard = new AuthBondGuard({ authDir, stateRoot, instanceName: 'backup-symlink-bot' });
    const captured = guard.capture('connection-open');
    expect(captured.ok).toBe(true);
    const realTarget = join(root, 'real-backup-target');
    cpSync(captured.path!, realTarget, { recursive: true });
    rmSync(captured.path!, { recursive: true, force: true });
    symlinkSync(realTarget, captured.path!, 'dir'); // inside historyRoot -> pathIsInside passes
    rmSync(authDir, { recursive: true, force: true });
    const restored = guard.restoreLatestIfNeeded();
    expect(restored.restored).toBe(false);
    expect(restored.error).toContain('backup path is a symlink');
  });

  it('refuses restore when the latest backup path is a regular file, not a directory', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    writeAuth(authDir, '15550116:1@s.whatsapp.net');
    const guard = new AuthBondGuard({ authDir, stateRoot, instanceName: 'backup-notdir-bot' });
    const captured = guard.capture('connection-open');
    expect(captured.ok).toBe(true);
    rmSync(captured.path!, { recursive: true, force: true });
    writeFileSync(captured.path!, 'i am a file', { mode: 0o600 });
    rmSync(authDir, { recursive: true, force: true });
    const restored = guard.restoreLatestIfNeeded();
    expect(restored.restored).toBe(false);
    expect(restored.error).toContain('backup path is not a directory');
  });

  it('refuses restore when the latest backup path is unreadable (lstat throws ENOENT)', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    writeAuth(authDir, '15550117:1@s.whatsapp.net');
    const guard = new AuthBondGuard({ authDir, stateRoot, instanceName: 'backup-unreadable-bot' });
    const captured = guard.capture('connection-open');
    expect(captured.ok).toBe(true);
    rmSync(captured.path!, { recursive: true, force: true });
    rmSync(authDir, { recursive: true, force: true });
    const restored = guard.restoreLatestIfNeeded();
    expect(restored.restored).toBe(false);
    // backupPathProblem's lstat-throw arm fires before the source-exists gate.
    expect(restored.error).toMatch(/backup path is unreadable|no auth-bond backup available/);
  });

  // --- restoreLatestIfNeeded(): auto-restore disabled (auth-bond.ts:635-637) ---
  it('does not attempt restore when autoRestore is disabled', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    writeAuth(authDir, '15550118:1@s.whatsapp.net');
    const guard = new AuthBondGuard({ authDir, stateRoot, instanceName: 'no-autorestore-bot', autoRestore: false });
    expect(guard.capture('connection-open').ok).toBe(true);
    rmSync(authDir, { recursive: true, force: true });
    const restored = guard.restoreLatestIfNeeded();
    expect(restored).toMatchObject({ attempted: false, restored: false, source: null });
    expect(restored.error).toBe('auto-restore disabled');
    expect(existsSync(authDir)).toBe(false);
  });

  // --- restoreLatestIfNeeded(): failure rollback (auth-bond.ts:709-718) ---
  // Uses hoisted vi.mock('node:fs') factory (top of file) — ESM named-import
  // spy is not configurable; mockCopyFileSyncImpl ref is the only safe hook.
  it('rolls the quarantined original back when the restore copy fails mid-flight', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    writeAuth(authDir, '15550119:1@s.whatsapp.net');
    const guard = new AuthBondGuard({
      authDir,
      stateRoot,
      instanceName: 'rollback-bot',
      now: () => new Date('2026-06-09T12:00:00Z'),
    });
    const captured = guard.capture('connection-open');
    expect(captured.ok).toBe(true);
    // Corrupt LIVE creds -> status invalid -> restore attempted; live tree still
    // present so it is moved to quarantine before the copy fails.
    writeFileSync(join(authDir, 'creds.json'), '{ bad json');
    const liveOriginal = readFileSync(join(authDir, 'app-state-sync-key-test.json'), 'utf8');

    // Inject the failure via the hoisted mock ref (ESM-safe: no spyOn namespace).
    mockCopyFileSyncImpl = () => {
      throw new Error('synthetic copy failure');
    };

    const restored = guard.restoreLatestIfNeeded();
    expect(restored.restored).toBe(false);
    expect(restored.error).toMatch(/synthetic copy failure/);
    expect(restored.error).toContain('quarantine=');
    // Rollback (711-714): original auth dir is back since copy created no replacement.
    expect(existsSync(join(authDir, 'app-state-sync-key-test.json'))).toBe(true);
    expect(readFileSync(join(authDir, 'app-state-sync-key-test.json'), 'utf8')).toBe(liveOriginal);
  });

  // --- pruneHistory(): keepBackups <= 0 short-circuit (auth-bond.ts:797) ---
  it('never prunes history when keepBackups is zero', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    writeAuth(authDir, '15550120:1@s.whatsapp.net');
    const guard = new AuthBondGuard({
      authDir,
      stateRoot,
      instanceName: 'no-prune-bot',
      keepBackups: 0,
      now: () => new Date('2026-06-09T12:00:00Z'),
    });
    expect(guard.capture('connection-open').captured).toBe(true);
    writeAuth(authDir, '15550121:1@s.whatsapp.net');
    expect(guard.capture('creds-update').captured).toBe(true);
    const historyRoot = join(stateRoot, 'auth-bond-backups', 'no-prune-bot', 'history');
    expect(readdirSync(historyRoot).length).toBe(2);
  });

  // --- readLatestManifest(): non-object/array pointer -> null (auth-bond.ts:392) ---
  it('treats a non-object latest pointer as absent', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    writeAuth(authDir, '15550122:1@s.whatsapp.net');
    const guard = new AuthBondGuard({
      authDir,
      stateRoot,
      instanceName: 'array-pointer-bot',
      now: () => new Date('2026-06-09T12:00:00Z'),
    });
    expect(guard.capture('connection-open').ok).toBe(true);
    const latestPath = join(stateRoot, 'auth-bond-backups', 'array-pointer-bot', 'latest.json');
    writeFileSync(latestPath, JSON.stringify([1, 2, 3]), { mode: 0o600 });
    const snap = guard.inspect();
    // A non-object latest pointer is treated as absent, so every latest-derived
    // backup field collapses to null together. Assert the shape so the terminal
    // assertion captures the full "pointer ignored" state.
    expect(snap.backup).toMatchObject({
      latest: null,
      latestAt: null,
      latestReason: null,
      latestTreeHash: null,
    });
  });

  // UNREACHABLE — recommend /* v8 ignore */: freshInvalidCredentialAgeMs's
  // `!Number.isFinite(mtime)` guard at auth-bond.ts:608. fileSnapshot derives
  // mtime from st.mtime.toISOString() (always a valid ISO for a real file), and
  // Date.parse of a valid ISO is always finite, so this guard cannot be hit
  // through the filesystem. Flagged, not fake-covered (no test emitted).

  // --- captureOnce catch path: fresh-invalid detected DURING capture defers
  //     instead of recording a hard failure (auth-bond.ts:589-593) ---
  // Uses hoisted vi.mock('node:fs') factory (top of file) — ESM named-import
  // spy is not configurable; mockCopyFileSyncImpl ref is the only safe hook.
  it('defers when the auth tree is freshly truncated during capture', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    writeAuth(authDir, '15550123:1@s.whatsapp.net');
    const guard = new AuthBondGuard({
      authDir,
      stateRoot,
      instanceName: 'defer-during-capture-bot',
      captureAttempts: 1,
      freshInvalidGraceMs: 60_000,
      now: () => new Date(),
    });
    // Inject: throw during the tree copy AND truncate live creds to empty
    // (fresh mtime). The catch in captureOnce re-inspects; freshAgeMs < grace
    // -> deferral path (auth-bond.ts:591-593).
    mockCopyFileSyncImpl = () => {
      writeFileSync(join(authDir, 'creds.json'), '');
      throw new Error('synthetic mid-capture failure');
    };

    const result = guard.capture('creds-update');
    expect(result).toMatchObject({ ok: false, captured: false, deferred: true, path: null });
    expect(result.error).toContain('changed during capture');
    expect(guard.inspect().backup.lastCaptureDeferredReason).toBe('creds-update');
  });

  // --- assertPrivateJsonTarget(): refuses writing json over a non-regular path
  //     (auth-bond.ts:305-307) — latest.json pre-created as a directory ---
  it('refuses to write the latest pointer over a non-regular (directory) path', () => {
    const root = makeRoot();
    const authDir = join(root, 'auth');
    const stateRoot = join(root, 'state');
    writeAuth(authDir, '15550124:1@s.whatsapp.net');
    const backupRoot = join(stateRoot, 'auth-bond-backups', 'json-target-bot');
    mkdirSync(join(backupRoot, 'latest.json'), { recursive: true, mode: 0o700 });
    const guard = new AuthBondGuard({
      authDir,
      stateRoot,
      instanceName: 'json-target-bot',
      now: () => new Date('2026-06-09T12:00:00Z'),
    });
    const result = guard.capture('connection-open');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('non-regular path');
  });
});
