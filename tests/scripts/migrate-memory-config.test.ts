import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  findConfigFiles,
  migrateMemoryConfigFile,
  parseArgs,
  rollbackConfigFile,
  runMigration,
  runRollback,
} from '../../scripts/migrate-memory-config.ts';
import { withPrivateConfigLockSync } from '../../src/core/private-config-file.ts';

const isWindows = process.platform === 'win32';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

function makeInstance(root: string, name: string, config: Record<string, unknown>): string {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'auth'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'tokens.env'), 'WHATSOUP_HEALTH_TOKEN=token\n');
  fs.writeFileSync(path.join(dir, 'auth', 'creds.json'), '{"auth":true}\n');
  return path.join(dir, 'config.json');
}

describe('migrate-memory-config CLI helpers', () => {
  it('parses dry-run defaults', () => {
    const args = parseArgs(['--root', '/tmp/ws', '--instance', 'mw-bot']);
    expect(args.root).toBe('/tmp/ws');
    expect(args.instances).toEqual(['mw-bot']);
    expect(args.write).toBe(false);
    expect(args.backup).toBe(true);
    expect(args.removeLegacy).toBe(true);
  });

  it('parses rollback mode', () => {
    const args = parseArgs(['--root', '/tmp/ws', '--instance', 'mw-bot', '--rollback']);
    expect(args.root).toBe('/tmp/ws');
    expect(args.instances).toEqual(['mw-bot']);
    expect(args.rollback).toBe(true);
    expect(args.write).toBe(false);
  });

  it('finds all instance config.json files under a root', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-migrate-test-'));
    try {
      makeInstance(tmp, 'a-bot', { name: 'a-bot' });
      makeInstance(tmp, 'b-bot', { name: 'b-bot' });
      expect(findConfigFiles({ root: tmp, configs: [], instances: [] })).toEqual([
        path.join(tmp, 'a-bot', 'config.json'),
        path.join(tmp, 'b-bot', 'config.json'),
      ]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('dry-runs without touching config.json, tokens.env, or auth credentials', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-migrate-test-'));
    try {
      const configPath = makeInstance(tmp, 'mw-bot', {
        name: 'mw-bot',
        pineconeIndex: 'mw-mind',
        pineconeAllowedIndexes: ['mw-mind'],
      });
      const beforeConfig = fs.readFileSync(configPath, 'utf-8');
      const beforeToken = fs.readFileSync(path.join(tmp, 'mw-bot', 'tokens.env'), 'utf-8');
      const beforeAuth = fs.readFileSync(path.join(tmp, 'mw-bot', 'auth', 'creds.json'), 'utf-8');

      const result = migrateMemoryConfigFile(configPath, { write: false });

      expect(result.changed).toBe(true);
      expect(result.wrote).toBe(false);
      expect(fs.readFileSync(configPath, 'utf-8')).toBe(beforeConfig);
      expect(fs.readFileSync(path.join(tmp, 'mw-bot', 'tokens.env'), 'utf-8')).toBe(beforeToken);
      expect(fs.readFileSync(path.join(tmp, 'mw-bot', 'auth', 'creds.json'), 'utf-8')).toBe(beforeAuth);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('write mode updates only config.json and creates a backup', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-migrate-test-'));
    try {
      const configPath = makeInstance(tmp, 'mw-bot', {
        name: 'mw-bot',
        pineconeIndex: 'mw-mind',
        pineconeFactsNamespace: 'mw-facts',
        recencyHalfLifeDays: 21,
        maxAgeDays: 180,
      });

      const result = migrateMemoryConfigFile(configPath, { write: true, backup: true });
      const next = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

      expect(result.wrote).toBe(true);
      expect(result.backupPath).toBeTruthy();
      expect(fs.existsSync(result.backupPath!)).toBe(true);
      expect(next.memory.pinecone.index).toBe('mw-mind');
      expect(next.memory.pinecone.namespaces.facts).toBe('mw-facts');
      expect(next.memory.pinecone.recencyHalfLifeDays).toBe(21);
      expect(next.memory.pinecone.maxAgeDays).toBe(180);
      expect(next).not.toHaveProperty('pineconeIndex');
      expect(next).not.toHaveProperty('recencyHalfLifeDays');
      expect(next).not.toHaveProperty('maxAgeDays');
      expect(fs.readFileSync(path.join(tmp, 'mw-bot', 'tokens.env'), 'utf-8')).toBe('WHATSOUP_HEALTH_TOKEN=token\n');
      expect(fs.readFileSync(path.join(tmp, 'mw-bot', 'auth', 'creds.json'), 'utf-8')).toBe('{"auth":true}\n');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('write mode moves flat recency settings into Pinecone memory config', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-migrate-test-'));
    try {
      const configPath = makeInstance(tmp, 'mw-bot', {
        name: 'mw-bot',
        pineconeIndex: 'mw-mind',
        recencyHalfLifeDays: 21,
        maxAgeDays: 180,
      });

      const result = migrateMemoryConfigFile(configPath, { write: true, backup: false });
      const next = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

      expect(result.wrote).toBe(true);
      expect(result.backupPath).toBeNull();
      expect(next.memory.pinecone.index).toBe('mw-mind');
      expect(next.memory.pinecone.recencyHalfLifeDays).toBe(21);
      expect(next.memory.pinecone.maxAgeDays).toBe(180);
      expect(next).not.toHaveProperty('pineconeIndex');
      expect(next).not.toHaveProperty('recencyHalfLifeDays');
      expect(next).not.toHaveProperty('maxAgeDays');
      expect(result.moved).toContainEqual({ from: 'pineconeIndex', to: 'memory.pinecone.index' });
      expect(result.moved).toContainEqual({ from: 'recencyHalfLifeDays', to: 'memory.pinecone.recencyHalfLifeDays' });
      expect(result.moved).toContainEqual({ from: 'maxAgeDays', to: 'memory.pinecone.maxAgeDays' });
      expect(result.removed).toContain('pineconeIndex');
      expect(result.removed).toContain('recencyHalfLifeDays');
      expect(result.removed).toContain('maxAgeDays');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('dry-run leaves files untouched while reporting recency moves', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-migrate-test-'));
    try {
      const configPath = makeInstance(tmp, 'mw-bot', {
        name: 'mw-bot',
        pineconeIndex: 'mw-mind',
        recencyHalfLifeDays: 21,
        maxAgeDays: 180,
      });
      const beforeConfig = fs.readFileSync(configPath, 'utf-8');

      const result = migrateMemoryConfigFile(configPath, { write: false });
      const next = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

      expect(result.changed).toBe(true);
      expect(result.wrote).toBe(false);
      expect(fs.readFileSync(configPath, 'utf-8')).toBe(beforeConfig);
      expect(next.pineconeIndex).toBe('mw-mind');
      expect(next.recencyHalfLifeDays).toBe(21);
      expect(next.maxAgeDays).toBe(180);
      expect(next).not.toHaveProperty('memory.pinecone.index');
      expect(next).not.toHaveProperty('memory.pinecone.recencyHalfLifeDays');
      expect(next).not.toHaveProperty('memory.pinecone.maxAgeDays');
      expect(result.moved).toContainEqual({ from: 'pineconeIndex', to: 'memory.pinecone.index' });
      expect(result.moved).toContainEqual({ from: 'recencyHalfLifeDays', to: 'memory.pinecone.recencyHalfLifeDays' });
      expect(result.moved).toContainEqual({ from: 'maxAgeDays', to: 'memory.pinecone.maxAgeDays' });
      expect(result.removed).toContain('pineconeIndex');
      expect(result.removed).toContain('recencyHalfLifeDays');
      expect(result.removed).toContain('maxAgeDays');
      expect(result).not.toHaveProperty('config');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('runMigration can target a named instance', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-migrate-test-'));
    try {
      makeInstance(tmp, 'mw-bot', { name: 'mw-bot', pineconeIndex: 'mw-mind' });
      makeInstance(tmp, 'ana-bot', { name: 'ana-bot', pineconeIndex: 'ana-mind' });

      const results = runMigration(['--root', tmp, '--instance', 'ana-bot', '--write', '--json']);

      expect(results).toHaveLength(1);
      expect(results[0].configPath).toBe(path.join(tmp, 'ana-bot', 'config.json'));
      const mw = JSON.parse(fs.readFileSync(path.join(tmp, 'mw-bot', 'config.json'), 'utf-8'));
      const ana = JSON.parse(fs.readFileSync(path.join(tmp, 'ana-bot', 'config.json'), 'utf-8'));
      expect(mw.pineconeIndex).toBe('mw-mind');
      expect(ana.memory.pinecone.index).toBe('ana-mind');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('migrate-memory-config rollback mode', () => {
  const backupContent = JSON.stringify({ name: 'test-bot', restored: true }, null, 2) + '\n';
  const currentContent = JSON.stringify(
    { name: 'test-bot', memory: { pinecone: { index: 'test-mind' } } },
    null,
    2,
  ) + '\n';
  const backupStamp = '2026-04-25T12-00-00-000Z';

  function makeRollbackFixture(root: string, name: string): { configPath: string; backupPath: string } {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    const configPath = path.join(dir, 'config.json');
    const backupPath = `${configPath}.bak-${backupStamp}`;
    fs.writeFileSync(configPath, currentContent);
    fs.writeFileSync(backupPath, backupContent);
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(backupPath, past, past);
    return { configPath, backupPath };
  }

  it('dry-runs rollback without touching files', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-rollback-test-'));
    try {
      const { configPath } = makeRollbackFixture(tmp, 'test-bot');

      const results = runRollback(['--root', tmp, '--instance', 'test-bot']);

      expect(results).toHaveLength(1);
      expect(results[0].configPath).toBe(configPath);
      expect(results[0].backupPath).toContain(backupStamp);
      expect(results[0].safetySnapshotPath).toBeNull();
      expect(results[0].wouldRestore).toBe(true);
      expect(results[0].restored).toBe(false);
      expect(fs.readFileSync(configPath, 'utf-8')).toBe(currentContent);
      expect(fs.existsSync(results[0].backupPath)).toBe(true);
      expect(
        fs.readdirSync(path.dirname(configPath)).filter((name) => name.includes('.rollback-')),
      ).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('write mode restores the newest backup, keeps it, leaves no temp copy and prints both paths', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-rollback-test-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const { configPath, backupPath } = makeRollbackFixture(tmp, 'test-bot');

      const results = runRollback(['--root', tmp, '--instance', 'test-bot', '--write']);

      expect(results).toHaveLength(1);
      expect(results[0].backupPath).toBe(backupPath);
      expect(results[0].restored).toBe(true);
      expect(fs.readFileSync(configPath, 'utf-8')).toBe(backupContent);
      // Rollback no longer consumes the backup it restores from.
      expect(fs.readFileSync(backupPath, 'utf-8')).toBe(backupContent);
      const snapshotPath = results[0].safetySnapshotPath;
      expect(snapshotPath).toMatch(/config\.json\.rollback-safety-/);
      expect(fs.readFileSync(String(snapshotPath), 'utf-8')).toBe(currentContent);
      expect(
        fs.readdirSync(path.dirname(configPath)).filter((name) => name.includes('.rollback-tmp-')),
      ).toEqual([]);
      const printed = log.mock.calls.flat().join('\n');
      expect(printed).toContain(backupPath);
      expect(printed).toContain(String(snapshotPath));
    } finally {
      log.mockRestore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // @skip-env Windows does not preserve POSIX file modes.
  it.skipIf(isWindows)('write mode leaves the restored config and its safety snapshot owner-only', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-rollback-test-'));
    try {
      const { configPath, backupPath } = makeRollbackFixture(tmp, 'test-bot');
      fs.chmodSync(configPath, 0o644);
      fs.chmodSync(backupPath, 0o644);

      const result = rollbackConfigFile(configPath, { write: true });

      expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(String(result.safetySnapshotPath)).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('prints one JSON array that matches the returned results in JSON mode', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-rollback-test-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      makeRollbackFixture(tmp, 'test-bot');

      const results = runRollback(['--root', tmp, '--instance', 'test-bot', '--json']);

      expect(log).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual(results);
      expect(results[0].safetySnapshotPath).toBeNull();
    } finally {
      log.mockRestore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('repeated rollback keeps every backup and never selects a safety snapshot', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-rollback-test-'));
    try {
      const { configPath, backupPath: newestBackupPath } = makeRollbackFixture(tmp, 'test-bot');
      const olderBackupPath = `${configPath}.bak-2026-04-25T11-00-00-000Z`;
      fs.writeFileSync(olderBackupPath, '{"older":true}\n');
      const older = new Date(Date.now() - 120_000);
      fs.utimesSync(olderBackupPath, older, older);

      const first = rollbackConfigFile(configPath, { write: true });
      const second = rollbackConfigFile(configPath, { write: true });

      expect(first.backupPath).toBe(newestBackupPath);
      expect(second.backupPath).toBe(newestBackupPath);
      expect(first.safetySnapshotPath).not.toBe(second.safetySnapshotPath);
      expect(fs.existsSync(newestBackupPath)).toBe(true);
      expect(fs.existsSync(olderBackupPath)).toBe(true);
      expect(fs.readFileSync(configPath, 'utf-8')).toBe(backupContent);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('refuses rollback when the backup is newer than the current config', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-rollback-test-'));
    try {
      const { backupPath } = makeRollbackFixture(tmp, 'test-bot');
      const future = new Date(Date.now() + 60_000);
      fs.utimesSync(backupPath, future, future);

      expect(() =>
        runRollback(['--root', tmp, '--instance', 'test-bot', '--write']),
      ).toThrowError(/backup.*newer.*config/i);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // @skip-env Windows has no POSIX uid to compare with a file's owner.
  it.skipIf(isWindows)('refuses a rollback run by another account before it writes any file', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-rollback-test-'));
    try {
      const { configPath, backupPath } = makeRollbackFixture(tmp, 'test-bot');
      const user = vi.spyOn(process, 'getuid').mockReturnValue(fs.statSync(configPath).uid + 1);
      try {
        const owners = /owned by uid \d+, but this rollback runs as uid \d+/i;
        expect(() => rollbackConfigFile(configPath)).toThrowError(owners);
        expect(() => rollbackConfigFile(configPath, { write: true })).toThrowError(owners);
      } finally {
        user.mockRestore();
      }

      expect(fs.readFileSync(configPath, 'utf-8')).toBe(currentContent);
      expect(fs.readFileSync(backupPath, 'utf-8')).toBe(backupContent);
      // No safety snapshot, temp copy or lock file: the refusal comes before any write.
      expect(fs.readdirSync(path.dirname(configPath)).sort()).toEqual([
        'config.json',
        path.basename(backupPath),
      ]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('refuses a write-mode rollback while another writer holds the config lock', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-rollback-test-'));
    try {
      const { configPath, backupPath } = makeRollbackFixture(tmp, 'test-bot');

      expect(() =>
        withPrivateConfigLockSync(configPath, () => rollbackConfigFile(configPath, { write: true })),
      ).toThrowError(/config lock is active/i);

      expect(fs.readFileSync(configPath, 'utf-8')).toBe(currentContent);
      expect(fs.readFileSync(backupPath, 'utf-8')).toBe(backupContent);
      expect(
        fs.readdirSync(path.dirname(configPath)).filter((name) => name.includes('.rollback-')),
      ).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('prints the instances already restored when a later instance fails', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-rollback-test-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const { configPath, backupPath } = makeRollbackFixture(tmp, 'a-bot');
      fs.mkdirSync(path.join(tmp, 'b-bot'));
      fs.writeFileSync(path.join(tmp, 'b-bot', 'config.json'), currentContent);

      expect(() =>
        runRollback(['--root', tmp, '--instance', 'a-bot', '--instance', 'b-bot', '--write']),
      ).toThrowError(/no backups found/i);

      expect(fs.readFileSync(configPath, 'utf-8')).toBe(backupContent);
      const printed = log.mock.calls.flat().join('\n');
      expect(printed).toContain(`restored: ${configPath} <- ${backupPath}`);
      expect(printed).toMatch(/safety snapshot: .*config\.json\.rollback-safety-/);
    } finally {
      log.mockRestore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('migrate-memory-config operator errors', () => {
  it('reports missing config files with path context', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-migrate-error-'));
    try {
      const missingPath = path.join(tmp, 'missing', 'config.json');
      expect(() => migrateMemoryConfigFile(missingPath)).toThrowError(/config file not found/i);
      expect(() => migrateMemoryConfigFile(missingPath)).toThrowError(missingPath);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('reports malformed JSON with path context', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-migrate-error-'));
    try {
      const configPath = path.join(tmp, 'config.json');
      fs.writeFileSync(configPath, '{not valid json');
      expect(() => migrateMemoryConfigFile(configPath)).toThrowError(/malformed JSON/i);
      expect(() => migrateMemoryConfigFile(configPath)).toThrowError(configPath);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // @skip-env Windows does not preserve POSIX chmod unreadable-file semantics;
  // root bypasses file-mode permission checks entirely.
  it.skipIf(isWindows || isRoot)('reports EACCES with path context on unreadable config', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-migrate-error-'));
    try {
      const configPath = path.join(tmp, 'config.json');
      fs.writeFileSync(configPath, JSON.stringify({ name: 'eacces-bot' }));
      fs.chmodSync(configPath, 0o000);
      try {
        expect(() => migrateMemoryConfigFile(configPath)).toThrowError(
          /cannot read config file \(permission denied\)/i,
        );
        expect(() => migrateMemoryConfigFile(configPath)).toThrowError(configPath);
      } finally {
        fs.chmodSync(configPath, 0o644);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // @skip-env Windows does not preserve POSIX chmod read-only-directory semantics;
  // root bypasses file-mode permission checks entirely.
  it.skipIf(isWindows || isRoot)('reports EACCES with path context when write dir is read-only', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-migrate-error-'));
    try {
      const instanceDir = path.join(tmp, 'ro-bot');
      fs.mkdirSync(instanceDir);
      const configPath = path.join(instanceDir, 'config.json');
      fs.writeFileSync(
        configPath,
        JSON.stringify({ name: 'ro-bot', pineconeIndex: 'idx' }),
      );
      fs.chmodSync(instanceDir, 0o555);
      try {
        expect(() =>
          migrateMemoryConfigFile(configPath, { write: true, backup: false }),
        ).toThrowError(/cannot (write|replace) config file \(permission denied\)/i);
        expect(() =>
          migrateMemoryConfigFile(configPath, { write: true, backup: false }),
        ).toThrowError(configPath);
      } finally {
        fs.chmodSync(instanceDir, 0o755);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('migrate-memory-config rollback operator errors', () => {
  const currentContent =
    JSON.stringify({ name: 'test-bot', memory: { pinecone: { index: 'test-mind' } } }, null, 2) +
    '\n';

  it('reports helpful error when no backup files exist', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-rollback-error-'));
    try {
      const dir = path.join(tmp, 'no-bak-bot');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'config.json'), currentContent);
      expect(() =>
        runRollback(['--root', tmp, '--instance', 'no-bak-bot', '--write']),
      ).toThrowError(/no backups found/i);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('keeps the config, backup and safety snapshot, names the snapshot and removes its temp file when the replace fails', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-rollback-error-'));
    try {
      const dir = path.join(tmp, 'replace-failure-bot');
      fs.mkdirSync(dir, { recursive: true });
      const configPath = path.join(dir, 'config.json');
      const backupPath = `${configPath}.bak-2026-04-25T12-00-00-000Z`;
      fs.writeFileSync(configPath, currentContent);
      fs.writeFileSync(backupPath, '{"restored":true}\n');
      const past = new Date(Date.now() - 60_000);
      fs.utimesSync(backupPath, past, past);
      const failure = Object.assign(new Error('injected replace failure'), { code: 'EACCES' });

      let failureMessage = '';
      try {
        rollbackConfigFile(
          configPath,
          { write: true },
          {
            replace: () => {
              throw failure;
            },
          },
        );
      } catch (err) {
        failureMessage = (err as Error).message;
      }

      expect(failureMessage).toMatch(/cannot restore backup \(permission denied\)/i);
      const snapshots = fs.readdirSync(dir).filter((name) => name.includes('.rollback-safety-'));
      expect(snapshots).toHaveLength(1);
      expect(failureMessage).toContain(path.join(dir, snapshots[0]));
      expect(fs.readFileSync(path.join(dir, snapshots[0]), 'utf-8')).toBe(currentContent);
      expect(fs.readFileSync(configPath, 'utf-8')).toBe(currentContent);
      expect(fs.readFileSync(backupPath, 'utf-8')).toBe('{"restored":true}\n');
      expect(fs.readdirSync(dir).filter((name) => name.includes('.rollback-tmp-'))).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // @skip-env Windows does not preserve POSIX chmod read-only-directory semantics;
  // root bypasses file-mode permission checks entirely.
  it.skipIf(isWindows || isRoot)('reports EACCES with path context when the rollback cannot write beside the config', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-rollback-error-'));
    try {
      const dir = path.join(tmp, 'perm-bot');
      fs.mkdirSync(dir, { recursive: true });
      const configPath = path.join(dir, 'config.json');
      const backupPath = `${configPath}.bak-2026-04-25T12-00-00-000Z`;
      fs.writeFileSync(configPath, currentContent);
      fs.writeFileSync(backupPath, currentContent);
      const past = new Date(Date.now() - 60_000);
      fs.utimesSync(backupPath, past, past);
      fs.chmodSync(dir, 0o555);
      try {
        expect(() =>
          runRollback(['--root', tmp, '--instance', 'perm-bot', '--write']),
        ).toThrowError(/cannot restore backup \(permission denied\)/i);
        expect(() =>
          runRollback(['--root', tmp, '--instance', 'perm-bot', '--write']),
        ).toThrowError(configPath);
      } finally {
        fs.chmodSync(dir, 0o755);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('parseArgs — a flag must never be consumed as another flag\'s value', () => {
  /**
   * MEASURED ON origin/main BEFORE THE FIX. `argv[++i] ?? ''` accepts the next token
   * unconditionally, so omitting a value silently ate the following FLAG:
   *
   *   parseArgs(['--root', '--write'])     -> { root: '--write', write: false }
   *   parseArgs(['--config', '--write'])   -> { configs: ['--write'], write: false }
   *   parseArgs(['--instance', '--json'])  -> { instances: ['--json'], json: false }
   *
   * Both halves are wrong at once, and this script MUTATES config files: the operator gets
   * a garbage path AND the flag they typed is silently switched off. The empty case was
   * already caught downstream ("--root must not be empty"); the flag-shaped case was not,
   * because '--write' is a perfectly non-empty string.
   */
  it('THROWS instead of taking the next flag as the value of --root', () => {
    expect(() => parseArgs(['--root', '--write'])).toThrow(/another flag/);
  });

  it('THROWS instead of taking the next flag as the value of --config', () => {
    expect(() => parseArgs(['--config', '--write'])).toThrow(/another flag/);
  });

  it('THROWS instead of taking the next flag as the value of --instance', () => {
    expect(() => parseArgs(['--instance', '--json'])).toThrow(/another flag/);
  });

  it('THROWS on a missing value rather than yielding an empty string', () => {
    expect(() => parseArgs(['--root'])).toThrow(/requires a value/);
  });

  it('still parses ordinary values and flags correctly', () => {
    const args = parseArgs(['--root', '/tmp/x', '--instance', 'q', '--write', '--json']);
    expect(args.root).toBe('/tmp/x');
    expect(args.instances).toEqual(['q']);
    expect(args.write).toBe(true);
    expect(args.json).toBe(true);
  });

  it('rejects an unknown flag rather than ignoring it silently', () => {
    expect(() => parseArgs(['--wrte'])).toThrow(/Unknown argument/);
  });
});
