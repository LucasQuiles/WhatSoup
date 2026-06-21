import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { DEFAULT_FRESH_INVALID_GRACE_MS } from '../lib/auth-bond-policy.ts';
import { forceEnsurePrivateDirectorySync, privateWriteError } from '../lib/private-fs.ts';
import { shortHash } from '../lib/short-hash.ts';
import { errorMessage } from '../lib/error-message.ts';

export type AuthBondStatus = 'present' | 'missing' | 'invalid';

export interface AuthBondFileSnapshot {
  path: string;
  exists: boolean;
  mode: string | null;
  size: number | null;
  mtime: string | null;
  sha256: string | null;
}

export interface AuthBondBackupSnapshot {
  root: string;
  latest: string | null;
  latestAt: string | null;
  latestReason: string | null;
  latestTreeHash: string | null;
  lastCaptureAt: string | null;
  lastCaptureReason: string | null;
  lastCaptureError: string | null;
  lastCaptureDeferredAt: string | null;
  lastCaptureDeferredReason: string | null;
  lastCaptureDeferredAgeMs: number | null;
  lastRestoreAt: string | null;
  lastRestoreSource: string | null;
  lastRestoreError: string | null;
}

export interface AuthBondSnapshot {
  status: AuthBondStatus;
  authDir: AuthBondFileSnapshot;
  creds: AuthBondFileSnapshot;
  meHash: string | null;
  treeHash: string | null;
  backup: AuthBondBackupSnapshot;
  issues: string[];
}

export interface AuthBondCaptureResult {
  ok: boolean;
  snapshot: AuthBondSnapshot;
  captured: boolean;
  deferred: boolean;
  path: string | null;
  error: string | null;
}

export interface AuthBondRestoreResult {
  attempted: boolean;
  restored: boolean;
  source: string | null;
  snapshot: AuthBondSnapshot;
  error: string | null;
}

interface LatestManifest {
  backupPath?: string;
  createdAt?: string;
  reason?: string;
  treeHash?: string;
}

interface BackupManifest {
  instanceName?: string;
  reason?: string;
  createdAt?: string;
  authDir?: string;
  treeHash?: string | null;
  credsHash?: string | null;
  meHash?: string | null;
}

interface AuthBondGuardOptions {
  authDir: string;
  stateRoot?: string;
  instanceName: string;
  now?: () => Date;
  keepBackups?: number;
  autoRestore?: boolean;
  captureAttempts?: number;
  captureRetryDelayMs?: number;
  captureBlockReason?: () => string | null;
  freshInvalidGraceMs?: number;
}

const DEFAULT_KEEP_BACKUPS = 96;
const DEFAULT_CAPTURE_ATTEMPTS = 3;
const DEFAULT_CAPTURE_RETRY_DELAY_MS = 75;
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function safeName(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned === '' ? 'unknown' : cleaned;
}

function hashBuffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function isoForFileName(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function isHistoryStagingDirName(name: string): boolean {
  return /\.tmp-\d+$/.test(name);
}

function modeString(mode: number): string {
  return (mode & 0o777).toString(8);
}

function fsyncDirectory(path: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    fsyncSync(fd);
  } catch {
    // Directory fsync is best-effort on some filesystems.
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function fileSnapshot(path: string, includeHash = false): AuthBondFileSnapshot {
  try {
    const st = lstatSync(path);
    return {
      path,
      exists: true,
      mode: modeString(st.mode),
      size: st.size,
      mtime: st.mtime.toISOString(),
      sha256: includeHash && st.isFile() && !st.isSymbolicLink() ? hashBuffer(readFileSync(path)) : null,
    };
  } catch {
    return {
      path,
      exists: false,
      mode: null,
      size: null,
      mtime: null,
      sha256: null,
    };
  }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, ms);
}

function extractMeHash(parsed: unknown): string | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const me = (parsed as Record<string, unknown>)['me'];
  if (typeof me !== 'object' || me === null || Array.isArray(me)) return null;
  const record = me as Record<string, unknown>;
  const id = typeof record['id'] === 'string'
    ? record['id']
    : typeof record['lid'] === 'string'
      ? record['lid']
      : null;
  return id ? shortHash(id, 20) : null;
}

function walkAuthFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const st = lstatSync(current);
    if (st.isDirectory()) {
      const entries = readdirSync(current)
        .filter(name => name !== '.DS_Store')
        .map(name => join(current, name))
        .sort()
        .reverse();
      stack.push(...entries);
      continue;
    }
    if (st.isSymbolicLink()) {
      throw privateWriteError(`refusing to walk auth tree containing symlink: ${relative(root, current) || '.'}`, 'ELOOP');
    }
    if (st.isFile()) {
      out.push(current);
    }
  }
  return out.sort();
}

function hashAuthTree(authDir: string): string | null {
  if (!existsSync(authDir)) return null;
  const hasher = createHash('sha256');
  for (const path of walkAuthFiles(authDir)) {
    const rel = relative(authDir, path);
    const st = lstatSync(path);
    hasher.update(rel);
    hasher.update('\0');
    hasher.update(modeString(st.mode));
    hasher.update('\0');
    hasher.update('file');
    hasher.update('\0');
    hasher.update(readFileSync(path));
    hasher.update('\0');
  }
  return hasher.digest('hex');
}

function copyPrivateTree(src: string, dst: string): void {
  const st = lstatSync(src);
  if (st.isDirectory()) {
    mkdirSync(dst, { recursive: true, mode: 0o700 });
    chmodSync(dst, 0o700);
    for (const entry of readdirSync(src)) {
      if (entry === '.DS_Store') continue;
      copyPrivateTree(join(src, entry), join(dst, entry));
    }
    return;
  }
  if (st.isSymbolicLink()) {
    throw privateWriteError(`refusing to copy auth tree containing symlink: ${src}`, 'ELOOP');
  }
  copyFileSync(src, dst);
  chmodSync(dst, 0o600);
}

function hardenPrivateTree(root: string): string[] {
  if (!existsSync(root)) return [];
  const issues: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let st;
    try {
      st = lstatSync(current);
    } catch (err) {
      const rel = current === root ? '.' : relative(root, current);
      issues.push(`auth_mode_stat_failed:${rel}:${errorMessage(err)}`);
      continue;
    }

    if (st.isSymbolicLink()) {
      const rel = current === root ? '.' : relative(root, current);
      issues.push(`auth_tree_symlink:${rel}`);
      continue;
    }

    const desiredMode = st.isDirectory() ? 0o700 : st.isFile() ? 0o600 : null;
    if (desiredMode !== null && (st.mode & 0o777) !== desiredMode) {
      try {
        chmodSync(current, desiredMode);
      } catch (err) {
        const rel = current === root ? '.' : relative(root, current);
        issues.push(`auth_mode_chmod_failed:${rel}:${errorMessage(err)}`);
      }
    }

    if (st.isDirectory()) {
      try {
        const entries = readdirSync(current)
          .filter(name => name !== '.DS_Store')
          .map(name => join(current, name))
          .sort()
          .reverse();
        stack.push(...entries);
      } catch (err) {
        const rel = current === root ? '.' : relative(root, current);
        issues.push(`auth_mode_readdir_failed:${rel}:${errorMessage(err)}`);
      }
    }
  }
  return issues;
}

function assertPrivateJsonTarget(path: string): void {
  if (!existsSync(path)) return;
  const lst = lstatSync(path);
  if (lst.isSymbolicLink()) {
    throw privateWriteError('refusing to write auth-bond json through symlink', 'ELOOP');
  }
  const st = statSync(path);
  if (!st.isFile()) {
    throw privateWriteError('refusing to write auth-bond json over non-regular path', 'EINVAL');
  }
}

function writePrivateJson(path: string, value: unknown): void {
  const dir = dirname(path);
  forceEnsurePrivateDirectorySync(dir, 'auth-bond json directory');
  assertPrivateJsonTarget(path);

  const tmpPath = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(tmpPath, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(value, null, 2), 'utf-8');
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    assertPrivateJsonTarget(path);
    renameSync(tmpPath, path);
    chmodSync(path, 0o600);
    fsyncDirectory(dir);
  } catch (err) {
    if (fd !== null) closeSync(fd);
    try { unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

function authTreeValidationError(
  authDir: string,
  expected: { credsHash?: string | null; meHash?: string | null; treeHash?: string | null },
  prefix: string,
): string | null {
  const symlinkIssues = hardenPrivateTree(authDir).filter(issue => issue.startsWith('auth_tree_symlink:'));
  if (symlinkIssues.length > 0) {
    return `${prefix} auth tree contains symlink: ${symlinkIssues.join(',')}`;
  }
  const credsPath = join(authDir, 'creds.json');
  const creds = fileSnapshot(credsPath, true);
  if (!creds.exists) return `${prefix} auth missing creds.json`;
  if (creds.size === 0 || creds.sha256 === EMPTY_SHA256) {
    return `${prefix} creds.json is empty`;
  }
  if (expected.credsHash && creds.sha256 !== expected.credsHash) {
    return `${prefix} creds.json hash mismatch`;
  }

  let meHash: string | null = null;
  try {
    const parsed = readJson(credsPath);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return `${prefix} creds.json is not an object`;
    }
    meHash = extractMeHash(parsed);
  } catch {
    return `${prefix} creds.json is invalid json`;
  }

  if (!meHash) {
    return `${prefix} creds.json is missing identity`;
  }
  if (expected.meHash && meHash !== expected.meHash) {
    return `${prefix} creds.json identity mismatch`;
  }

  const treeHash = hashAuthTree(authDir);
  if (!treeHash) return `${prefix} auth tree is unreadable`;
  if (expected.treeHash && treeHash !== expected.treeHash) {
    return `${prefix} auth tree hash mismatch`;
  }
  return null;
}

function validateCopiedAuthTree(authDir: string, expected: AuthBondSnapshot): string | null {
  return authTreeValidationError(authDir, {
    credsHash: expected.creds.sha256,
    meHash: expected.meHash,
    treeHash: expected.treeHash,
  }, 'copied');
}

function readLatestManifest(path: string): LatestManifest | null {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    const parsed = readJson(path);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as LatestManifest;
  } catch {
    return null;
  }
}

function pathIsInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

export class AuthBondGuard {
  private readonly authDir: string;
  private readonly instanceName: string;
  private readonly now: () => Date;
  private readonly keepBackups: number;
  private readonly autoRestore: boolean;
  private readonly captureAttempts: number;
  private readonly captureRetryDelayMs: number;
  private readonly captureBlockReason: () => string | null;
  private readonly freshInvalidGraceMs: number;
  private readonly root: string;
  private readonly historyRoot: string;
  private readonly stagingRoot: string;
  private readonly latestManifestPath: string;
  private lastCaptureAt: string | null = null;
  private lastCaptureReason: string | null = null;
  private lastCaptureError: string | null = null;
  private lastCaptureDeferredAt: string | null = null;
  private lastCaptureDeferredReason: string | null = null;
  private lastCaptureDeferredAgeMs: number | null = null;
  private lastRestoreAt: string | null = null;
  private lastRestoreSource: string | null = null;
  private lastRestoreError: string | null = null;

  constructor(options: AuthBondGuardOptions) {
    this.authDir = options.authDir;
    this.instanceName = safeName(options.instanceName);
    this.now = options.now ?? (() => new Date());
    this.keepBackups = options.keepBackups ?? DEFAULT_KEEP_BACKUPS;
    this.autoRestore = options.autoRestore ?? process.env['WHATSOUP_AUTH_BOND_AUTO_RESTORE'] !== '0';
    this.captureAttempts = Math.max(1, options.captureAttempts ?? DEFAULT_CAPTURE_ATTEMPTS);
    this.captureRetryDelayMs = Math.max(0, options.captureRetryDelayMs ?? DEFAULT_CAPTURE_RETRY_DELAY_MS);
    this.captureBlockReason = options.captureBlockReason ?? (() => null);
    this.freshInvalidGraceMs = Math.max(0, options.freshInvalidGraceMs ?? DEFAULT_FRESH_INVALID_GRACE_MS);
    const stateRoot = options.stateRoot && options.stateRoot.trim() !== ''
      ? options.stateRoot
      : join(dirname(options.authDir), '..', 'state');
    this.root = join(stateRoot, 'auth-bond-backups', this.instanceName);
    this.historyRoot = join(this.root, 'history');
    this.stagingRoot = join(this.root, 'staging');
    this.latestManifestPath = join(this.root, 'latest.json');
  }

  inspect(): AuthBondSnapshot {
    const credsPath = join(this.authDir, 'creds.json');
    const issues: string[] = [];
    issues.push(...hardenPrivateTree(this.authDir));
    const authDir = fileSnapshot(this.authDir);
    const creds = fileSnapshot(credsPath, true);
    let status: AuthBondStatus = 'present';
    let meHash: string | null = null;
    const hasSymlinkIssue = issues.some(issue => issue.startsWith('auth_tree_symlink:'));

    if (!authDir.exists) {
      status = 'missing';
      issues.push('auth_dir_missing');
    }
    if (!creds.exists) {
      status = 'missing';
      issues.push('creds_json_missing');
    }
    if (hasSymlinkIssue) {
      status = 'invalid';
    }
    if (creds.exists && !hasSymlinkIssue) {
      if (creds.size === 0 || creds.sha256 === EMPTY_SHA256) {
        status = 'invalid';
        issues.push('creds_json_empty');
      } else {
        try {
          const parsed = readJson(credsPath);
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            status = 'invalid';
            issues.push('creds_json_not_object');
          } else {
            meHash = extractMeHash(parsed);
            if (!meHash) {
              status = 'invalid';
              issues.push('creds_json_missing_me');
            }
          }
        } catch {
          status = 'invalid';
          issues.push('creds_json_invalid_json');
        }
      }
    }

    return {
      status,
      authDir,
      creds,
      meHash,
      treeHash: status === 'present' ? hashAuthTree(this.authDir) : null,
      backup: this.backupSnapshot(),
      issues,
    };
  }

  capture(reason: string): AuthBondCaptureResult {
    let lastResult: AuthBondCaptureResult | null = null;
    for (let attempt = 1; attempt <= this.captureAttempts; attempt += 1) {
      lastResult = this.captureOnce(reason);
      if (lastResult.ok || !lastResult.deferred || attempt === this.captureAttempts) return lastResult;
      sleepSync(this.captureRetryDelayMs);
    }
    return lastResult!;
  }

  private captureOnce(reason: string): AuthBondCaptureResult {
    const snapshot = this.inspect();
    const blockedReason = this.captureBlockReason();
    if (blockedReason) {
      this.lastCaptureAt = this.now().toISOString();
      this.lastCaptureReason = reason;
      this.lastCaptureError = `auth bond capture blocked: ${blockedReason}`;
      return { ok: false, snapshot: this.inspect(), captured: false, deferred: false, path: null, error: this.lastCaptureError };
    }
    if (snapshot.status !== 'present' || !snapshot.treeHash) {
      const freshAgeMs = this.freshInvalidCredentialAgeMs(snapshot);
      if (freshAgeMs !== null && freshAgeMs < this.freshInvalidGraceMs) {
        return this.deferFreshInvalidCapture(reason, freshAgeMs, 'auth bond credential write still in flight');
      }
      this.lastCaptureAt = this.now().toISOString();
      this.lastCaptureReason = reason;
      this.lastCaptureError = `auth bond is ${snapshot.status}: ${snapshot.issues.join(',')}`;
      return { ok: false, snapshot: this.inspect(), captured: false, deferred: false, path: null, error: this.lastCaptureError };
    }

    let tmp: string | null = null;
    let publishedTarget: string | null = null;
    try {
      forceEnsurePrivateDirectorySync(this.root, 'auth-bond backup root directory');
      forceEnsurePrivateDirectorySync(this.historyRoot, 'auth-bond backup history directory');
      forceEnsurePrivateDirectorySync(this.stagingRoot, 'auth-bond backup staging directory');

      const latest = readLatestManifest(this.latestManifestPath);
      if (
        latest?.treeHash === snapshot.treeHash
        && latest.backupPath
        && this.backupPathProblem(latest.backupPath) === null
      ) {
        this.lastCaptureAt = this.now().toISOString();
        this.lastCaptureReason = reason;
        this.lastCaptureError = null;
        return { ok: true, snapshot: this.inspect(), captured: false, deferred: false, path: latest.backupPath, error: null };
      }

      const createdAt = this.now();
      const dirName = `${isoForFileName(createdAt)}.${safeName(reason)}.${snapshot.treeHash.slice(0, 16)}`;
      const target = join(this.historyRoot, dirName);
      tmp = join(this.stagingRoot, `${dirName}.tmp-${process.pid}`);
      rmSync(tmp, { recursive: true, force: true });
      mkdirSync(tmp, { recursive: true, mode: 0o700 });
      const copiedAuthDir = join(tmp, 'auth');
      copyPrivateTree(this.authDir, copiedAuthDir);
      const copiedAuthError = validateCopiedAuthTree(copiedAuthDir, snapshot);
      if (copiedAuthError) throw new Error(copiedAuthError);
      const manifest = {
        instanceName: this.instanceName,
        reason,
        createdAt: createdAt.toISOString(),
        authDir: this.authDir,
        treeHash: snapshot.treeHash,
        credsHash: snapshot.creds.sha256,
        meHash: snapshot.meHash,
      };
      writePrivateJson(join(tmp, 'manifest.json'), manifest);
      renameSync(tmp, target);
      publishedTarget = target;
      tmp = null;

      writePrivateJson(this.latestManifestPath, {
        backupPath: target,
        createdAt: createdAt.toISOString(),
        reason,
        treeHash: snapshot.treeHash,
      });
      publishedTarget = null;

      this.lastCaptureAt = createdAt.toISOString();
      this.lastCaptureReason = reason;
      this.lastCaptureError = null;
      this.pruneHistory();
      return { ok: true, snapshot: this.inspect(), captured: true, deferred: false, path: target, error: null };
    } catch (err) {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
      if (publishedTarget) rmSync(publishedTarget, { recursive: true, force: true });
      const freshSnapshot = this.inspect();
      const freshAgeMs = this.freshInvalidCredentialAgeMs(freshSnapshot);
      if (freshAgeMs !== null && freshAgeMs < this.freshInvalidGraceMs) {
        return this.deferFreshInvalidCapture(reason, freshAgeMs, 'auth bond changed during capture');
      }
      this.lastCaptureAt = this.now().toISOString();
      this.lastCaptureReason = reason;
      this.lastCaptureError = errorMessage(err);
      return { ok: false, snapshot: this.inspect(), captured: false, deferred: false, path: null, error: this.lastCaptureError };
    }
  }

  private freshInvalidCredentialAgeMs(snapshot: AuthBondSnapshot): number | null {
    if (snapshot.status === 'present') return null;
    if (!snapshot.creds.exists || !snapshot.creds.mtime) return null;
    if (!snapshot.issues.some(issue => issue === 'creds_json_empty' || issue === 'creds_json_invalid_json')) {
      return null;
    }
    const mtime = Date.parse(snapshot.creds.mtime);
    if (!Number.isFinite(mtime)) return null;
    return Math.max(0, this.now().getTime() - mtime);
  }

  private deferFreshInvalidCapture(
    reason: string,
    ageMs: number,
    message: string,
  ): AuthBondCaptureResult {
    this.lastCaptureDeferredAt = this.now().toISOString();
    this.lastCaptureDeferredReason = reason;
    this.lastCaptureDeferredAgeMs = ageMs;
    return {
      ok: false,
      snapshot: this.inspect(),
      captured: false,
      deferred: true,
      path: null,
      error: `${message}: age_ms=${ageMs}`,
    };
  }

  restoreLatestIfNeeded(): AuthBondRestoreResult {
    const before = this.inspect();
    if (before.status === 'present') {
      return { attempted: false, restored: false, source: null, snapshot: before, error: null };
    }
    if (!this.autoRestore) {
      return { attempted: false, restored: false, source: null, snapshot: before, error: 'auto-restore disabled' };
    }

    const latest = readLatestManifest(this.latestManifestPath);
    const latestBackupPath = latest?.backupPath ?? null;
    const source = latestBackupPath ? join(latestBackupPath, 'auth') : null;
    if (latestBackupPath) {
      const latestProblem = this.backupPathProblem(latestBackupPath);
      if (latestProblem) {
        this.lastRestoreAt = this.now().toISOString();
        this.lastRestoreSource = latestBackupPath;
        this.lastRestoreError = latestProblem;
        return {
          attempted: true,
          restored: false,
          source: latestBackupPath,
          snapshot: this.inspect(),
          error: latestProblem,
        };
      }
    }
    if (!source || !existsSync(source)) {
      const error = 'no auth-bond backup available';
      this.lastRestoreAt = this.now().toISOString();
      this.lastRestoreSource = null;
      this.lastRestoreError = error;
      return { attempted: true, restored: false, source: null, snapshot: this.inspect(), error };
    }
    const backupError = this.validateBackupForRestore(latestBackupPath!, latest);
    if (backupError) {
      this.lastRestoreAt = this.now().toISOString();
      this.lastRestoreSource = latestBackupPath;
      this.lastRestoreError = backupError;
      return {
        attempted: true,
        restored: false,
        source: latestBackupPath,
        snapshot: this.inspect(),
        error: backupError,
      };
    }

    forceEnsurePrivateDirectorySync(this.root, 'auth-bond backup root directory');
    const restoredAt = this.now();
    const quarantineRoot = join(this.root, 'quarantine');
    forceEnsurePrivateDirectorySync(quarantineRoot, 'auth-bond quarantine directory');
    const quarantine = join(
      quarantineRoot,
      `${isoForFileName(restoredAt)}.${safeName(basename(this.authDir))}.broken`,
    );
    const tmp = `${this.authDir}.restore-${process.pid}`;
    let movedOriginal = false;

    try {
      rmSync(tmp, { recursive: true, force: true });
      if (existsSync(this.authDir)) {
        renameSync(this.authDir, quarantine);
        movedOriginal = true;
      } else {
        forceEnsurePrivateDirectorySync(dirname(this.authDir), 'auth parent directory');
      }
      copyPrivateTree(source, tmp);
      renameSync(tmp, this.authDir);
      this.lastRestoreAt = restoredAt.toISOString();
      this.lastRestoreSource = latestBackupPath;
      this.lastRestoreError = null;
      return {
        attempted: true,
        restored: true,
        source: latestBackupPath,
        snapshot: this.inspect(),
        error: null,
      };
    } catch (err) {
      rmSync(tmp, { recursive: true, force: true });
      if (movedOriginal && !existsSync(this.authDir)) {
        try {
          renameSync(quarantine, this.authDir);
        } catch {
          // Preserve the original failure; the alert evidence includes the quarantine path.
        }
      }
      const error = errorMessage(err);
      this.lastRestoreAt = restoredAt.toISOString();
      this.lastRestoreSource = latestBackupPath;
      this.lastRestoreError = `${error}; quarantine=${quarantine}`;
      return {
        attempted: true,
        restored: false,
        source: latestBackupPath,
        snapshot: this.inspect(),
        error: this.lastRestoreError,
      };
    }
  }

  private backupSnapshot(): AuthBondBackupSnapshot {
    const latest = readLatestManifest(this.latestManifestPath);
    const latestPath = latest?.backupPath && this.backupPathProblem(latest.backupPath) === null ? latest.backupPath : null;
    return {
      root: this.root,
      latest: latestPath,
      latestAt: latest?.createdAt ?? null,
      latestReason: latest?.reason ?? null,
      latestTreeHash: latest?.treeHash ?? null,
      lastCaptureAt: this.lastCaptureAt,
      lastCaptureReason: this.lastCaptureReason,
      lastCaptureError: this.lastCaptureError,
      lastCaptureDeferredAt: this.lastCaptureDeferredAt,
      lastCaptureDeferredReason: this.lastCaptureDeferredReason,
      lastCaptureDeferredAgeMs: this.lastCaptureDeferredAgeMs,
      lastRestoreAt: this.lastRestoreAt,
      lastRestoreSource: this.lastRestoreSource,
      lastRestoreError: this.lastRestoreError,
    };
  }

  private validateBackupForRestore(backupPath: string, latest: LatestManifest | null): string | null {
    const pathProblem = this.backupPathProblem(backupPath);
    if (pathProblem) return pathProblem;
    const manifestPath = join(backupPath, 'manifest.json');
    let manifest: BackupManifest;
    try {
      const parsed = readJson(manifestPath);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return `backup manifest is not an object: ${manifestPath}`;
      }
      manifest = parsed as BackupManifest;
    } catch (err) {
      return `backup manifest is unreadable: ${manifestPath}: ${errorMessage(err)}`;
    }

    if (manifest.instanceName && safeName(manifest.instanceName) !== this.instanceName) {
      return `backup instance mismatch: manifest=${safeName(manifest.instanceName)} expected=${this.instanceName}`;
    }
    if (latest?.treeHash && manifest.treeHash && latest.treeHash !== manifest.treeHash) {
      return 'latest pointer tree hash does not match backup manifest';
    }

    return authTreeValidationError(join(backupPath, 'auth'), {
      credsHash: manifest.credsHash,
      meHash: manifest.meHash,
      treeHash: manifest.treeHash,
    }, 'backup');
  }

  private backupPathProblem(backupPath: string): string | null {
    if (!pathIsInside(this.historyRoot, backupPath)) {
      return `backup path escapes history root: ${backupPath}`;
    }
    try {
      const st = lstatSync(backupPath);
      if (st.isSymbolicLink()) return `backup path is a symlink: ${backupPath}`;
      if (!st.isDirectory()) return `backup path is not a directory: ${backupPath}`;
    } catch (err) {
      return `backup path is unreadable: ${backupPath}: ${errorMessage(err)}`;
    }
    return null;
  }

  private pruneHistory(): void {
    if (this.keepBackups <= 0 || !existsSync(this.historyRoot)) return;
    const entries = readdirSync(this.historyRoot)
      .filter(name => !isHistoryStagingDirName(name))
      .map(name => join(this.historyRoot, name))
      .filter(path => {
        try {
          return lstatSync(path).isDirectory();
        } catch {
          return false;
        }
      })
      .sort()
      .reverse();
    for (const stale of entries.slice(this.keepBackups)) {
      rmSync(stale, { recursive: true, force: true });
    }
  }
}
