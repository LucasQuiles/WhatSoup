import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  readFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir as systemTmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CURRENT_SCHEMA_MIGRATION,
  Database,
  DatabaseCompatibilityError,
} from '../../src/core/database.ts';
import {
  assertSchemaCeiling,
  assertTrustedDatabaseParent,
  databaseWriteCompatibilityError,
  inspectDatabasePathBeforeCreate,
} from '../../src/core/database-compatibility.ts';
import {
  databaseCompatibilityStartupExitCode,
  inspectExistingDatabaseForBootstrap,
  runEarlyDatabaseCompatibilityGate,
} from '../../src/core/database-compatibility-early.ts';
import { openDatabaseForStartup } from '../../src/core/database-compatibility-health.ts';
import { WhatSoupError } from '../../src/errors.ts';

function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function tmpdir(): string {
  return realpathSync(systemTmpdir());
}

function createCurrentDatabase(dbPath: string): void {
  const db = new Database(dbPath);
  db.open();
  db.close();
}

function injectNextSchemaInspectionFailure(failure: Error): void {
  const originalPrepare = DatabaseSync.prototype.prepare;
  let injected = false;
  vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function prepare(
    this: DatabaseSync,
    sql: string,
  ) {
    if (!injected && sql.includes('sqlite_master')) {
      injected = true;
      throw failure;
    }
    return originalPrepare.call(this, sql);
  });
}

describe('database schema ceiling', () => {
  const cleanup: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const path of cleanup.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it.each([
    { errcode: 264, reason: 'engine_recovery_required' },
    { errcode: 776, reason: 'engine_recovery_required' },
    { errcode: 1032, reason: 'database_identity_changed' },
    { errcode: 8, reason: 'database_not_writable' },
    { errcode: 520, reason: 'database_not_writable' },
    { errcode: 1288, reason: 'database_not_writable' },
    { errcode: 1544, reason: 'database_not_writable' },
  ] as const)(
    'database write compatibility classifier: maps SQLite errcode $errcode to $reason',
    ({ errcode, reason }) => {
      const source = Object.assign(new Error(`SQLite write failure ${errcode}`), { errcode });
      const classified = databaseWriteCompatibilityError('/canonical/bot.db', source);

      expect(classified).toBeInstanceOf(DatabaseCompatibilityError);
      expect(classified).toMatchObject({ reason, cause: source });
    },
  );

  it.each(['EACCES', 'EPERM', 'EROFS'] as const)(
    'database write compatibility classifier: maps OS code %s to database_not_writable',
    (code) => {
      const source = Object.assign(new Error(`OS write failure ${code}`), { code });
      expect(databaseWriteCompatibilityError('/canonical/bot.db', source)).toMatchObject({
        reason: 'database_not_writable',
        cause: source,
      });
    },
  );

  it('database path inspection classifies an invalid pathname as permanently unsafe', () => {
    expect(() => inspectDatabasePathBeforeCreate('\0')).toThrow(
      expect.objectContaining({ reason: 'unsafe_database_identity' }),
    );
  });

  it('database write compatibility classifier: walks cause and AggregateError branches', () => {
    const source = Object.assign(new Error('read-only database directory'), { errcode: 1544 });
    const aggregate = new AggregateError([new Error('ordinary sibling'), source]);
    const outer = new Error('writer setup failed', { cause: aggregate });

    expect(databaseWriteCompatibilityError('/canonical/bot.db', outer)).toMatchObject({
      reason: 'database_not_writable',
      cause: source,
    });
  });

  it.each([
    { label: 'BUSY', errcode: 5 },
    { label: 'FULL', errcode: 13 },
    { label: 'IOERR', errcode: 10 },
    { label: 'corruption', errcode: 11 },
    { label: 'generic CANTOPEN', errcode: 14 },
    { label: 'unknown SQLite error', errcode: 999_999 },
  ])(
    'database write compatibility classifier: leaves $label transient and unclassified',
    ({ label, errcode }) => {
      const source = Object.assign(new Error(label), { errcode });
      expect(databaseWriteCompatibilityError('/canonical/bot.db', source)).toBeNull();
    },
  );

  it('database write compatibility classifier: bounds a cyclic unknown cause chain', () => {
    const cyclic = new Error('cyclic unknown error') as Error & { cause?: unknown };
    cyclic.cause = cyclic;

    expect(databaseWriteCompatibilityError('/canonical/bot.db', cyclic)).toBeNull();
  });

  it.each([
    { label: 'BUSY', errcode: 5 },
    { label: 'FULL', errcode: 13 },
    { label: 'IOERR', errcode: 10 },
    { label: 'CORRUPT', errcode: 11 },
    { label: 'CANTOPEN', errcode: 14 },
  ])(
    'review hardening: assertSchemaCeiling preserves transient $label query failures',
    ({ label, errcode }) => {
      const db = new DatabaseSync(':memory:');
      const source = Object.assign(new Error(`${label} during schema inspection`), { errcode });
      injectNextSchemaInspectionFailure(source);

      let failure: unknown;
      try {
        assertSchemaCeiling(db, ':memory:');
      } catch (err) {
        failure = err;
      } finally {
        db.close();
      }

      expect(failure).toBe(source);
      expect(failure).not.toBeInstanceOf(DatabaseCompatibilityError);
    },
  );

  it.each([
    { marker: { errcode: 264 }, reason: 'engine_recovery_required' },
    { marker: { errcode: 776 }, reason: 'engine_recovery_required' },
    { marker: { errcode: 1032 }, reason: 'database_identity_changed' },
    { marker: { errcode: 8 }, reason: 'database_not_writable' },
    { marker: { errcode: 520 }, reason: 'database_not_writable' },
    { marker: { errcode: 1288 }, reason: 'database_not_writable' },
    { marker: { errcode: 1544 }, reason: 'database_not_writable' },
    { marker: { code: 'EACCES' }, reason: 'database_not_writable' },
    { marker: { code: 'EPERM' }, reason: 'database_not_writable' },
    { marker: { code: 'EROFS' }, reason: 'database_not_writable' },
  ] as const)(
    'review hardening: assertSchemaCeiling classifies recognized query marker $marker',
    ({ marker, reason }) => {
      const db = new DatabaseSync(':memory:');
      const source = Object.assign(new Error('recognized schema inspection failure'), marker);
      injectNextSchemaInspectionFailure(source);

      let failure: unknown;
      try {
        assertSchemaCeiling(db, ':memory:');
      } catch (err) {
        failure = err;
      } finally {
        db.close();
      }

      expect(failure).toBeInstanceOf(DatabaseCompatibilityError);
      expect(failure).toMatchObject({ reason, cause: source });
    },
  );

  it('review hardening: early bootstrap keeps BUSY transient with exit status 1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsoup-schema-ceiling-early-busy-'));
    cleanup.push(dir);
    const dbPath = join(dir, 'current.db');
    const lockPath = join(dir, 'whatsoup.lock');
    const previousConfig = process.env.INSTANCE_CONFIG;
    createCurrentDatabase(dbPath);
    process.env.INSTANCE_CONFIG = JSON.stringify({
      name: 'test-agent',
      healthPort: 19090,
      paths: { dbPath, lockPath },
    });
    const source = Object.assign(new Error('BUSY during early schema inspection'), { errcode: 5 });
    injectNextSchemaInspectionFailure(source);
    const startServer = vi.fn(async () => ({ listening: true }) as Server);
    const releaseLock = vi.fn(() => true);

    try {
      const failure = await runEarlyDatabaseCompatibilityGate({
        acquireLock: () => ({ path: lockPath, pid: process.pid, token: 'test-lock' }),
        releaseLock,
        startServer,
      }).catch((err: unknown) => err);

      expect(failure).toBe(source);
      expect(databaseCompatibilityStartupExitCode(failure)).toBe(1);
      expect(startServer).not.toHaveBeenCalled();
      expect(releaseLock).toHaveBeenCalledOnce();
    } finally {
      if (previousConfig === undefined) delete process.env.INSTANCE_CONFIG;
      else process.env.INSTANCE_CONFIG = previousConfig;
    }
  });

  it('review hardening: runtime admission leaves IOERR transient without latching a fence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsoup-schema-ceiling-admission-ioerr-'));
    cleanup.push(dir);
    const dbPath = join(dir, 'current.db');
    const db = new Database(dbPath);
    db.open();
    const source = Object.assign(new Error('IOERR during runtime admission'), { errcode: 10 });
    vi.spyOn(db.raw, 'prepare').mockImplementationOnce(() => {
      throw source;
    });

    try {
      let failure: unknown;
      try {
        db.assertWritableCompatibility();
      } catch (err) {
        failure = err;
      }
      expect(failure).toBe(source);
      expect(failure).not.toBeInstanceOf(DatabaseCompatibilityError);
      expect(() => db.assertWritableCompatibility()).not.toThrow();
      expect(() => db.raw.exec('CREATE TABLE admission_still_writable(id INTEGER)')).not.toThrow();
    } finally {
      db.close();
    }
  });

  it.each([264, 776])(
    'review hardening: early read-only schema inspection drains raw SQLite errcode %s',
    async (errcode) => {
      const dir = mkdtempSync(join(tmpdir(), `whatsoup-schema-ceiling-early-${errcode}-`));
      cleanup.push(dir);
      const dbPath = join(dir, 'current.db');
      const lockPath = join(dir, 'whatsoup.lock');
      const previousConfig = process.env.INSTANCE_CONFIG;
      createCurrentDatabase(dbPath);
      process.env.INSTANCE_CONFIG = JSON.stringify({
        name: 'test-agent',
        healthPort: 19090,
        paths: { dbPath, lockPath },
      });
      const source = Object.assign(new Error(`SQLite recovery ${errcode}`), { errcode });
      injectNextSchemaInspectionFailure(source);
      const server = { listening: true } as Server;
      const startServer = vi.fn(async () => server);
      const closeServer = vi.fn(async () => {});
      const releaseLock = vi.fn(() => true);

      try {
        await expect(runEarlyDatabaseCompatibilityGate({
          acquireLock: () => ({ path: lockPath, pid: process.pid, token: 'test-lock' }),
          releaseLock,
          startServer,
          waitForDrain: async () => 'SIGTERM',
          closeServer,
        })).resolves.toBe(true);
        expect(startServer).toHaveBeenCalledWith(expect.objectContaining({
          error: expect.objectContaining({ reason: 'engine_recovery_required' }),
        }));
        expect(closeServer).toHaveBeenCalledWith(server);
        expect(releaseLock).toHaveBeenCalledOnce();
      } finally {
        if (previousConfig === undefined) delete process.env.INSTANCE_CONFIG;
        else process.env.INSTANCE_CONFIG = previousConfig;
      }
    },
  );

  it.each([264, 776])(
    'review hardening: Database read-only schema inspection drains raw SQLite errcode %s',
    async (errcode) => {
      const dir = mkdtempSync(join(tmpdir(), `whatsoup-schema-ceiling-database-${errcode}-`));
      cleanup.push(dir);
      const dbPath = join(dir, 'current.db');
      createCurrentDatabase(dbPath);
      const source = Object.assign(new Error(`SQLite recovery ${errcode}`), { errcode });
      injectNextSchemaInspectionFailure(source);
      const server = { listening: true } as Server;
      const startServer = vi.fn(async () => server);
      let created: Database | null = null;

      try {
        await expect(openDatabaseForStartup({
          dbPath,
          instanceName: 'test-agent',
          startedAt: 1,
          createDatabase: (path) => {
            created = new Database(path);
            return created;
          },
          startDrainServer: startServer,
        })).resolves.toMatchObject({
          mode: 'drained',
          error: { reason: 'engine_recovery_required', cause: source },
          server,
        });
        expect(startServer).toHaveBeenCalledOnce();
      } finally {
        (created as Database | null)?.close();
      }
    },
  );

  it.each([264, 776])(
    'review hardening: actual read-only DatabaseSync constructor failure %s drains at both preflight boundaries',
    async (errcode) => {
      const dir = mkdtempSync(join(tmpdir(), `whatsoup-schema-ceiling-constructor-${errcode}-`));
      cleanup.push(dir);
      const dbPath = join(dir, 'current.db');
      createCurrentDatabase(dbPath);
      const earlyFailure = Object.assign(new Error(`early open recovery ${errcode}`), { errcode });
      const databaseFailure = Object.assign(new Error(`Database open recovery ${errcode}`), {
        errcode,
      });
      const openFailures = [earlyFailure, databaseFailure];
      const MockDatabaseSync = vi.fn(function DatabaseSync(
        _path: string,
        _options?: unknown,
      ) {
        const failure = openFailures.shift();
        if (!failure) throw new Error('unexpected extra DatabaseSync construction');
        throw failure;
      });

      vi.resetModules();
      vi.doMock('node:sqlite', () => ({ DatabaseSync: MockDatabaseSync }));
      try {
        const earlyModule = await import('../../src/core/database-compatibility-early.ts');
        const databaseModule = await import('../../src/core/database.ts');

        expect(earlyModule.inspectExistingDatabaseForBootstrap(dbPath)).toMatchObject({
          outcome: 'drained',
          error: { reason: 'engine_recovery_required' },
        });

        let failure: unknown;
        try {
          new databaseModule.Database(dbPath);
        } catch (err) {
          failure = err;
        }
        expect(failure).toMatchObject({
          reason: 'engine_recovery_required',
          cause: databaseFailure,
        });
        expect(MockDatabaseSync).toHaveBeenCalledTimes(2);
        for (const [, options] of MockDatabaseSync.mock.calls) {
          expect(options).toMatchObject({ readOnly: true });
        }
      } finally {
        vi.doUnmock('node:sqlite');
        vi.resetModules();
      }
    },
  );

  it('review hardening: Database schema preflight closes after BUSY without latching', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsoup-schema-ceiling-preflight-busy-'));
    cleanup.push(dir);
    const dbPath = join(dir, 'current.db');
    createCurrentDatabase(dbPath);
    const source = Object.assign(new Error('BUSY during Database schema preflight'), { errcode: 5 });
    const closeSpy = vi.spyOn(DatabaseSync.prototype, 'close');
    injectNextSchemaInspectionFailure(source);

    let constructed: Database | null = null;
    let failure: unknown;
    try {
      constructed = new Database(dbPath);
    } catch (err) {
      failure = err;
    }
    constructed?.close();

    expect(failure).toBe(source);
    expect(failure).not.toBeInstanceOf(DatabaseCompatibilityError);
    expect(closeSpy).toHaveBeenCalledOnce();

    const retry = new Database(dbPath);
    try {
      retry.open();
      expect(() => retry.assertWritableCompatibility()).not.toThrow();
    } finally {
      retry.close();
    }
  });

  it('early bootstrap outcome: classifies a genuine hot rollback journal as drained without changing bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsoup-schema-ceiling-hot-journal-'));
    cleanup.push(dir);
    const dbPath = join(dir, 'hot.db');
    const journalPath = `${dbPath}-journal`;

    const initial = new Database(dbPath);
    initial.open();
    initial.close();

    const seed = new DatabaseSync(dbPath);
    seed.exec(`
      PRAGMA journal_mode = DELETE;
      CREATE TABLE hot_journal_probe (id INTEGER PRIMARY KEY, value BLOB NOT NULL);
      WITH RECURSIVE ids(id) AS (
        VALUES (1)
        UNION ALL
        SELECT id + 1 FROM ids WHERE id < 512
      )
      INSERT INTO hot_journal_probe(id, value)
      SELECT id, zeroblob(4096) FROM ids;
    `);
    seed.close();

    const crashWriter = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { statSync } from 'node:fs';
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(${JSON.stringify(dbPath)});
      db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA cache_size = 8;');
      db.exec('BEGIN IMMEDIATE; UPDATE hot_journal_probe SET value = randomblob(4096);');
      if (statSync(${JSON.stringify(journalPath)}).size <= 512) process.exit(86);
      process.kill(process.pid, 'SIGKILL');
    `], { encoding: 'utf8' });
    expect(crashWriter.signal).toBe('SIGKILL');
    expect(existsSync(journalPath)).toBe(true);
    expect(readFileSync(journalPath).byteLength).toBeGreaterThan(512);

    const databaseBefore = fileSha256(dbPath);
    const journalBefore = fileSha256(journalPath);
    expect(inspectExistingDatabaseForBootstrap(dbPath)).toEqual({
      outcome: 'drained',
      error: {
        reason: 'engine_recovery_required',
        observedMigration: null,
        requiredMigration: CURRENT_SCHEMA_MIGRATION,
      },
    });
    expect(fileSha256(dbPath)).toBe(databaseBefore);
    expect(fileSha256(journalPath)).toBe(journalBefore);
    let db: Database | null = null;
    let failure: unknown;
    try {
      db = new Database(dbPath);
      db.open();
    } catch (err) {
      failure = err;
    }
    expect(failure).toBeInstanceOf(DatabaseCompatibilityError);
    expect(failure).toMatchObject({ reason: 'engine_recovery_required' });
    db?.close();

    expect(fileSha256(dbPath)).toBe(databaseBefore);
    expect(fileSha256(journalPath)).toBe(journalBefore);
  });

  it('early bootstrap outcome: classifies a newer database as drained before changing bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsoup-schema-ceiling-'));
    cleanup.push(dir);
    const dbPath = join(dir, 'future.db');
    const futureVersion = CURRENT_SCHEMA_MIGRATION + 1;

    const seed = new DatabaseSync(dbPath);
    seed.exec(`
      PRAGMA journal_mode = DELETE;
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE future_schema_sentinel (id INTEGER PRIMARY KEY);
    `);
    const insertVersion = seed.prepare('INSERT INTO schema_migrations (version) VALUES (?)');
    for (let version = 1; version <= futureVersion; version += 1) insertVersion.run(version);
    seed.close();

    expect(inspectExistingDatabaseForBootstrap(dbPath)).toEqual({
      outcome: 'drained',
      error: {
        reason: 'future_schema',
        observedMigration: futureVersion,
        requiredMigration: CURRENT_SCHEMA_MIGRATION,
      },
    });
    const db = new Database(dbPath);
    try {
      expect(() => db.open()).toThrow(
        new RegExp(`schema migration ${futureVersion}.*binary ceiling ${CURRENT_SCHEMA_MIGRATION}`, 'i'),
      );

      expect(db.raw.prepare('PRAGMA query_only').get()).toEqual({ query_only: 1 });
      expect(db.raw.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' });
      expect(db.raw.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
        .toEqual({ version: futureVersion });
      expect(db.raw.prepare(`
        SELECT COUNT(*) AS count
        FROM sqlite_master
        WHERE type = 'table' AND name = 'future_schema_sentinel'
      `).get()).toEqual({ count: 1 });
      expect(db.raw.prepare(`
        SELECT COUNT(*) AS count
        FROM sqlite_master
        WHERE type = 'table' AND name = 'messages'
      `).get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it('does not checkpoint, truncate, or remove a sole rejected future-schema WAL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsoup-schema-ceiling-wal-'));
    cleanup.push(dir);
    const dbPath = join(dir, 'future-wal.db');
    const walPath = `${dbPath}-wal`;
    const shmPath = `${dbPath}-shm`;
    const futureVersion = CURRENT_SCHEMA_MIGRATION + 1;

    const crashWriter = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(${JSON.stringify(dbPath)});
      db.exec(\`
        PRAGMA journal_mode = WAL;
        PRAGMA wal_autocheckpoint = 0;
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE future_schema_sentinel (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
        WITH RECURSIVE versions(version) AS (
          VALUES (1)
          UNION ALL
          SELECT version + 1 FROM versions WHERE version < ${futureVersion}
        )
        INSERT INTO schema_migrations (version) SELECT version FROM versions;
        INSERT INTO future_schema_sentinel (id, value) VALUES (1, 'pending');
      \`);
      process.kill(process.pid, 'SIGKILL');
    `], { encoding: 'utf8' });
    expect(crashWriter.signal).toBe('SIGKILL');
    expect(existsSync(walPath)).toBe(true);
    expect(existsSync(shmPath)).toBe(true);

    const databaseBefore = fileSha256(dbPath);
    const walBefore = fileSha256(walPath);
    expect(readFileSync(walPath).byteLength).toBeGreaterThan(0);

    const db = new Database(dbPath);
    expect(() => db.open()).toThrow(/exceeds binary ceiling/i);
    expect(db.raw.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
      .toEqual({ version: futureVersion });
    expect(db.raw.prepare('SELECT value FROM future_schema_sentinel WHERE id = 1').get())
      .toEqual({ value: 'pending' });
    db.close();

    expect(fileSha256(dbPath)).toBe(databaseBefore);
    expect(fileSha256(walPath)).toBe(walBefore);
    // The WAL-index is transient coordination state: a safe read-only connection
    // may update reader marks or rebuild it, but must not remove the aux files.
    expect(existsSync(walPath)).toBe(true);
    expect(existsSync(shmPath)).toBe(true);
  });

  it('uses a no-create writer open when the inspected database disappears', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsoup-schema-ceiling-no-recreate-'));
    cleanup.push(dir);
    const dbPath = join(dir, 'existing.db');

    const initial = new Database(dbPath);
    initial.open();
    initial.close();

    const originalClose = DatabaseSync.prototype.close;
    let removedAfterInspection = false;
    vi.spyOn(DatabaseSync.prototype, 'close').mockImplementation(function closeWithRemoval(
      this: DatabaseSync,
    ) {
      const location = this.location('main');
      originalClose.call(this);
      if (!removedAfterInspection && location === dbPath) {
        removedAfterInspection = true;
        rmSync(dbPath, { force: true });
      }
    });

    expect(() => new Database(dbPath)).toThrow(/cannot open.*existing database|identity/i);
    expect(removedAfterInspection).toBe(true);
    expect(existsSync(dbPath)).toBe(false);
  });

  it('rejects symlink and hardlink database aliases before compatibility inspection', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsoup-schema-ceiling-alias-'));
    cleanup.push(dir);
    const dbPath = join(dir, 'canonical.db');
    const symlinkPath = join(dir, 'symlink.db');
    const hardlinkPath = join(dir, 'hardlink.db');

    const initial = new Database(dbPath);
    initial.open();
    initial.close();
    symlinkSync(dbPath, symlinkPath);

    expect(() => new Database(symlinkPath)).toThrow(/symbolic link|canonical database path/i);

    linkSync(dbPath, hardlinkPath);
    expect(() => new Database(hardlinkPath)).toThrow(/hard link|link count|database identity/i);
  });

  it('rejects a dangling database symlink without creating its target', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsoup-schema-ceiling-dangling-'));
    cleanup.push(dir);
    const targetDir = join(dir, 'target');
    const targetPath = join(targetDir, 'created.db');
    const symlinkPath = join(dir, 'bot.db');
    mkdirSync(targetDir);
    symlinkSync(targetPath, symlinkPath);

    expect(inspectExistingDatabaseForBootstrap(symlinkPath)).toMatchObject({
      outcome: 'permanent',
      error: { reason: 'unsafe_database_identity' },
    });
    expect(() => new Database(symlinkPath)).toThrow(/symbolic link|canonical database path/i);
    expect(existsSync(targetPath)).toBe(false);
  });

  it('rejects a missing database beneath a symlinked parent without creating it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsoup-schema-ceiling-parent-alias-'));
    cleanup.push(dir);
    const targetDir = join(dir, 'target');
    const aliasDir = join(dir, 'alias');
    const targetPath = join(targetDir, 'created.db');
    const aliasPath = join(aliasDir, 'created.db');
    mkdirSync(targetDir);
    symlinkSync(targetDir, aliasDir);

    expect(inspectExistingDatabaseForBootstrap(aliasPath)).toMatchObject({
      outcome: 'permanent',
      error: { reason: 'unsafe_database_identity' },
    });
    expect(() => new Database(aliasPath)).toThrow(/symbolic link|canonical database path/i);
    expect(existsSync(targetPath)).toBe(false);
  });

  it('rejects a database parent exposed to group mutation before creating a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsoup-schema-ceiling-parent-mode-'));
    cleanup.push(dir);
    const dbPath = join(dir, 'bot.db');
    chmodSync(dir, 0o770);
    expect(inspectExistingDatabaseForBootstrap(dbPath)).toMatchObject({
      outcome: 'permanent',
      error: { reason: 'unsafe_database_identity' },
    });
    let opened: Database | null = null;
    let failure: unknown;
    try {
      opened = new Database(dbPath);
    } catch (err) {
      failure = err;
    } finally {
      opened?.close();
      chmodSync(dir, 0o700);
    }

    expect(failure).toMatchObject({ reason: 'unsafe_database_identity' });
    expect(existsSync(dbPath)).toBe(false);
  });

  it('rejects a private database parent beneath a non-sticky writable ancestor', () => {
    const root = mkdtempSync(join(tmpdir(), 'whatsoup-schema-ceiling-ancestor-mode-'));
    cleanup.push(root);
    const writableAncestor = join(root, 'shared');
    const databaseParent = join(writableAncestor, 'private');
    const dbPath = join(databaseParent, 'bot.db');
    mkdirSync(databaseParent, { recursive: true, mode: 0o700 });
    chmodSync(writableAncestor, 0o777);

    expect(inspectExistingDatabaseForBootstrap(dbPath)).toMatchObject({
      outcome: 'permanent',
      error: { reason: 'unsafe_database_identity' },
    });
    expect(() => new Database(dbPath)).toThrow(
      expect.objectContaining({ reason: 'unsafe_database_identity' }),
    );
    expect(existsSync(dbPath)).toBe(false);
  });

  it('rejects a parent whose resolved inode differs from its lstat identity', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsoup-schema-ceiling-parent-identity-'));
    cleanup.push(dir);
    const dbPath = join(dir, 'bot.db');
    const assertWithDependencies = assertTrustedDatabaseParent as unknown as (
      path: string,
      dependencies: {
        lstat(path: string): unknown;
        realpath(path: string): string;
        stat(path: string): unknown;
      },
    ) => void;

    expect(() => assertWithDependencies(dbPath, {
      lstat: (path) => lstatSync(path, { bigint: true }),
      realpath: realpathSync,
      stat: (path) => {
        const info = statSync(path, { bigint: true });
        return path === dir ? { ...info, ino: info.ino + 1n } : info;
      },
    })).toThrow(expect.objectContaining({ reason: 'database_identity_changed' }));
  });

  it('early bootstrap outcome: classifies a symlink database path as permanent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsoup-schema-ceiling-early-symlink-'));
    cleanup.push(dir);
    const dbPath = join(dir, 'canonical.db');
    const symlinkPath = join(dir, 'symlink.db');

    const seed = new DatabaseSync(dbPath);
    seed.close();
    symlinkSync(dbPath, symlinkPath);

    const inspection = inspectExistingDatabaseForBootstrap(symlinkPath);
    expect(inspection).toMatchObject({
      outcome: 'permanent',
      error: { reason: 'unsafe_database_identity' },
    });
  });

  it('early bootstrap outcome: classifies a hardlink database path as permanent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsoup-schema-ceiling-early-hardlink-'));
    cleanup.push(dir);
    const dbPath = join(dir, 'canonical.db');
    const hardlinkPath = join(dir, 'hardlink.db');

    const seed = new DatabaseSync(dbPath);
    seed.close();
    linkSync(dbPath, hardlinkPath);

    const inspection = inspectExistingDatabaseForBootstrap(hardlinkPath);
    expect(inspection).toMatchObject({
      outcome: 'permanent',
      error: { reason: 'unsafe_database_identity' },
    });
  });

  it('early bootstrap outcome: classifies a current database as ready', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsoup-schema-ceiling-early-ready-'));
    cleanup.push(dir);
    const dbPath = join(dir, 'current.db');
    const db = new Database(dbPath);
    db.open();
    db.close();

    expect(inspectExistingDatabaseForBootstrap(dbPath)).toEqual({ outcome: 'ready' });
  });

  it('early bootstrap outcome: classifies a missing database as ready without creating it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsoup-schema-ceiling-early-missing-'));
    cleanup.push(dir);
    const dbPath = join(dir, 'missing.db');

    expect(inspectExistingDatabaseForBootstrap(dbPath)).toEqual({ outcome: 'ready' });
    expect(existsSync(dbPath)).toBe(false);
  });

  it('early bootstrap outcome: classifies deterministic pathname replacement as transient', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsoup-schema-ceiling-early-replaced-'));
    cleanup.push(dir);
    const dbPath = join(dir, 'target.db');
    const replacementPath = join(dir, 'replacement.db');
    for (const path of [dbPath, replacementPath]) {
      const db = new Database(path);
      db.open();
      db.close();
    }

    const originalLocation = DatabaseSync.prototype.location;
    let swapped = false;
    vi.spyOn(DatabaseSync.prototype, 'location').mockImplementation(function observeLocation(
      this: DatabaseSync,
      name?: string,
    ) {
      const location = originalLocation.call(this, name);
      if (!swapped && name === 'main' && location === dbPath) {
        renameSync(replacementPath, dbPath);
        swapped = true;
      }
      return location;
    });

    const inspection = inspectExistingDatabaseForBootstrap(dbPath);
    expect(swapped).toBe(true);
    expect(inspection).toMatchObject({
      outcome: 'transient',
      error: { reason: 'database_identity_changed' },
    });
  });

  it('detects pathname replacement before beginning the authoritative write transaction', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsoup-schema-ceiling-replaced-'));
    cleanup.push(dir);
    const dbPath = join(dir, 'target.db');
    const replacementPath = join(dir, 'replacement.db');

    const target = new Database(dbPath);
    target.open();
    target.close();
    const replacement = new Database(replacementPath);
    replacement.open();
    replacement.close();

    const db = new Database(dbPath);
    rmSync(dbPath);
    copyFileSync(replacementPath, dbPath);
    const replacementBefore = fileSha256(dbPath);

    expect(() => db.open()).toThrow(/database identity.*changed|path.*replaced/i);
    expect(fileSha256(dbPath)).toBe(replacementBefore);
    db.close();
  });

  it('holds BEGIN IMMEDIATE across the authoritative ceiling check and schema writes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsoup-schema-ceiling-writer-race-'));
    cleanup.push(dir);
    const dbPath = join(dir, 'race.db');
    const latest = CURRENT_SCHEMA_MIGRATION;

    const initial = new Database(dbPath);
    initial.open();
    initial.close();
    const rewind = new DatabaseSync(dbPath);
    rewind.prepare('DELETE FROM schema_migrations WHERE version = ?').run(latest);
    rewind.close();

    const db = new Database(dbPath);
    const competitor = new DatabaseSync(dbPath, { timeout: 0 });
    const originalExec = db.raw.exec.bind(db.raw);
    let competingWriteFailure: unknown;
    vi.spyOn(db.raw, 'exec').mockImplementation((sql: string) => {
      originalExec(sql);
      if (sql.trim().toUpperCase() === 'BEGIN IMMEDIATE') {
        try {
          competitor.prepare('INSERT INTO schema_migrations(version) VALUES (?)')
            .run(CURRENT_SCHEMA_MIGRATION + 1);
        } catch (err) {
          competingWriteFailure = err;
        }
      }
    });

    try {
      db.open();
      expect(competingWriteFailure).toMatchObject({ code: 'ERR_SQLITE_ERROR' });
      expect(String((competingWriteFailure as Error).message)).toMatch(/locked|busy/i);
      expect(db.raw.prepare(
        'SELECT COUNT(*) AS count FROM schema_migrations WHERE version > ?',
      ).get(CURRENT_SCHEMA_MIGRATION)).toEqual({ count: 0 });
    } finally {
      competitor.close();
      db.close();
    }
  });

  it('rechecks the migration ceiling at runtime admission on the same database inode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsoup-schema-ceiling-runtime-advance-'));
    cleanup.push(dir);
    const dbPath = join(dir, 'runtime.db');
    const db = new Database(dbPath);
    db.open();

    const newerWriter = new DatabaseSync(dbPath);
    try {
      newerWriter.prepare('INSERT INTO schema_migrations(version) VALUES (?)')
        .run(CURRENT_SCHEMA_MIGRATION + 1);

      let rejection: unknown;
      try {
        db.assertWritableCompatibility();
      } catch (err) {
        rejection = err;
      }
      expect(rejection).toBeInstanceOf(DatabaseCompatibilityError);
      expect(rejection).toMatchObject({
        reason: 'future_schema',
        observedMigration: CURRENT_SCHEMA_MIGRATION + 1,
      });
      expect(() => db.raw.exec('CREATE TABLE must_stay_blocked(id INTEGER)')).toThrow(/read.?only/i);
    } finally {
      newerWriter.close();
      db.close();
    }
  });

  it('latches and closes the runtime handle when the database pathname is replaced', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsoup-schema-ceiling-runtime-replace-'));
    cleanup.push(dir);
    const dbPath = join(dir, 'runtime.db');
    const replacementPath = join(dir, 'replacement.db');
    const db = new Database(dbPath);
    db.open();
    const replacement = new Database(replacementPath);
    replacement.open();
    replacement.close();

    rmSync(dbPath);
    copyFileSync(replacementPath, dbPath);
    const replacementBefore = fileSha256(dbPath);
    let rejection: unknown;
    try {
      db.assertWritableCompatibility();
    } catch (err) {
      rejection = err;
    }

    expect(rejection).toBeInstanceOf(DatabaseCompatibilityError);
    expect(rejection).toMatchObject({ reason: 'database_identity_changed' });
    expect(() => db.raw.exec('CREATE TABLE must_stay_closed(id INTEGER)')).toThrow(/closed|not open/i);
    expect(fileSha256(dbPath)).toBe(replacementBefore);
    expect(() => db.assertWritableCompatibility()).toThrow(rejection as Error);
    db.close();
  });

  it('rolls back the ledger and every schema mutation when a migration fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsoup-schema-ceiling-atomic-failure-'));
    cleanup.push(dir);
    const dbPath = join(dir, 'atomic.db');
    const db = new Database(dbPath);
    const originalExec = db.raw.exec.bind(db.raw);

    vi.spyOn(db.raw, 'exec').mockImplementation((sql: string) => {
      if (sql.includes('CREATE TABLE IF NOT EXISTS messages (')) {
        throw new Error('injected migration failure');
      }
      originalExec(sql);
    });

    expect(() => db.open()).toThrow(/migration 1 failed/i);
    expect(db.raw.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type='table' AND name IN ('schema_migrations', 'messages')
    `).get()).toEqual({ count: 0 });
    db.close();
  });

  it('rolls back all earlier schema work when the final migration fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsoup-schema-ceiling-late-failure-'));
    cleanup.push(dir);
    const dbPath = join(dir, 'late.db');
    const db = new Database(dbPath);
    const originalExec = db.raw.exec.bind(db.raw);

    vi.spyOn(db.raw, 'exec').mockImplementation((sql: string) => {
      if (sql.includes('ADD COLUMN total_cache_read_tokens')) {
        throw new Error('injected final migration failure');
      }
      originalExec(sql);
    });

    expect(() => db.open()).toThrow(/migration 44 failed/i);
    expect(db.raw.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type='table' AND name IN ('schema_migrations', 'messages', 'agent_sessions')
    `).get()).toEqual({ count: 0 });
    db.close();
  });

  it('changes DELETE journaling to WAL only after the guarded schema transaction commits', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsoup-schema-ceiling-journal-order-'));
    cleanup.push(dir);
    const dbPath = join(dir, 'journal.db');
    const initial = new Database(dbPath);
    initial.open();
    initial.close();
    const rollbackMode = new DatabaseSync(dbPath);
    rollbackMode.exec('PRAGMA journal_mode = DELETE');
    rollbackMode.close();

    const db = new Database(dbPath);
    const originalExec = db.raw.exec.bind(db.raw);
    const statements: string[] = [];
    vi.spyOn(db.raw, 'exec').mockImplementation((sql: string) => {
      statements.push(sql.trim().replaceAll(/\s+/g, ' ').toUpperCase());
      originalExec(sql);
    });
    try {
      db.open();
      const begin = statements.indexOf('BEGIN IMMEDIATE');
      const commit = statements.indexOf('COMMIT');
      const wal = statements.indexOf('PRAGMA JOURNAL_MODE = WAL');
      expect(statements.filter((sql) => sql === 'BEGIN IMMEDIATE')).toHaveLength(1);
      expect(statements.filter((sql) => sql === 'COMMIT')).toHaveLength(1);
      expect(begin).toBeGreaterThanOrEqual(0);
      expect(commit).toBeGreaterThan(begin);
      expect(wal).toBeGreaterThan(commit);
    } finally {
      db.close();
    }
  });

  it('early bootstrap outcome: classifies a malformed migration ledger as permanent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsoup-schema-ceiling-malformed-'));
    cleanup.push(dir);
    const dbPath = join(dir, 'malformed.db');

    const seed = new DatabaseSync(dbPath);
    seed.exec(`
      PRAGMA journal_mode = DELETE;
      CREATE TABLE schema_migrations (unexpected TEXT NOT NULL);
      INSERT INTO schema_migrations (unexpected) VALUES ('future');
    `);
    seed.close();

    const inspection = inspectExistingDatabaseForBootstrap(dbPath);
    expect(inspection).toMatchObject({
      outcome: 'permanent',
      error: { reason: 'invalid_schema' },
    });

    const db = new Database(dbPath);
    try {
      let failure: unknown;
      try {
        db.open();
      } catch (err) {
        failure = err;
      }
      expect(failure).toBeInstanceOf(WhatSoupError);
      expect(failure).toMatchObject({ code: 'DATABASE_ERROR' });
      expect(String((failure as Error).message)).toMatch(/table shape is not canonical/i);
      expect(db.raw.prepare('PRAGMA query_only').get()).toEqual({ query_only: 1 });
      expect(db.raw.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' });
      expect(db.raw.prepare(`
        SELECT COUNT(*) AS count
        FROM sqlite_master
        WHERE type = 'table' AND name = 'messages'
      `).get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it('early bootstrap gives an invalid ledger precedence over a future migration', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsoup-schema-ceiling-invalid-future-'));
    cleanup.push(dir);
    const dbPath = join(dir, 'mixed.db');
    const lockPath = join(dir, 'state', 'whatsoup.lock');
    const previousConfig = process.env.INSTANCE_CONFIG;

    const seed = new DatabaseSync(dbPath);
    seed.exec(`
      PRAGMA journal_mode = DELETE;
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO schema_migrations (version)
      VALUES (0), (${CURRENT_SCHEMA_MIGRATION + 1});
    `);
    seed.close();

    const inspection = inspectExistingDatabaseForBootstrap(dbPath);
    expect(inspection).toMatchObject({
      outcome: 'permanent',
      error: { reason: 'invalid_schema' },
    });

    process.env.INSTANCE_CONFIG = JSON.stringify({
      name: 'test-agent',
      healthPort: 19090,
      paths: { dbPath, lockPath },
    });
    const startServer = vi.fn(async () => {
      throw new Error('invalid ledger must not start the compatibility drain server');
    });
    try {
      const failure = await runEarlyDatabaseCompatibilityGate({
        acquireLock: () => ({ path: lockPath, pid: process.pid, token: 'test-lock' }),
        releaseLock: () => true,
        startServer,
      }).catch((err: unknown) => err);

      expect(failure).toMatchObject({
        name: 'DatabaseCompatibilityPermanentStartupError',
        cause: expect.objectContaining({ reason: 'invalid_schema' }),
      });
      expect(databaseCompatibilityStartupExitCode(failure)).toBe(78);
      expect(startServer).not.toHaveBeenCalled();
    } finally {
      if (previousConfig === undefined) delete process.env.INSTANCE_CONFIG;
      else process.env.INSTANCE_CONFIG = previousConfig;
    }
  });

  it('preserves a transient schema inspection cause without latching read-only mode', () => {
    const db = new Database(':memory:');
    const inspectionFailure = new Error('schema inspection failed');
    vi.spyOn(db.raw, 'prepare').mockImplementationOnce(() => {
      throw inspectionFailure;
    });

    try {
      let failure: unknown;
      try {
        db.open();
      } catch (err) {
        failure = err;
      }
      expect(failure).toBeInstanceOf(WhatSoupError);
      expect(failure).toMatchObject({ code: 'DATABASE_ERROR', cause: inspectionFailure });
      expect(db.raw.prepare('PRAGMA query_only').get()).toEqual({ query_only: 0 });
      expect(() => db.open()).not.toThrow();
      expect(() => db.assertWritableCompatibility()).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('rejects a readable ledger containing a version outside the supported range', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsoup-schema-ceiling-gap-'));
    cleanup.push(dir);
    const dbPath = join(dir, 'gap.db');

    const seed = new DatabaseSync(dbPath);
    seed.exec(`
      PRAGMA journal_mode = DELETE;
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO schema_migrations (version) VALUES (0), (${CURRENT_SCHEMA_MIGRATION});
    `);
    seed.close();

    const db = new Database(dbPath);
    try {
      expect(() => db.open()).toThrow(/outside the supported range/i);
      expect(db.raw.prepare('PRAGMA query_only').get()).toEqual({ query_only: 1 });
      expect(db.raw.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' });
    } finally {
      db.close();
    }
  });

  it('accepts a ledger gap so an idempotent migration receipt can be repaired', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsoup-schema-ceiling-repair-'));
    cleanup.push(dir);
    const dbPath = join(dir, 'repair.db');

    const initial = new Database(dbPath);
    initial.open();
    initial.close();
    const missingVersion = Math.max(1, CURRENT_SCHEMA_MIGRATION - 1);
    const rewind = new DatabaseSync(dbPath);
    rewind.prepare('DELETE FROM schema_migrations WHERE version = ?').run(missingVersion);
    rewind.close();

    const reopened = new Database(dbPath);
    try {
      expect(() => reopened.open()).not.toThrow();
      expect(reopened.raw.prepare(
        'SELECT version FROM schema_migrations WHERE version = ?',
      ).get(missingVersion)).toEqual({ version: missingVersion });
    } finally {
      reopened.close();
    }
  });

  it('rejects a readable ledger whose table shape is not canonical', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsoup-schema-ceiling-shape-'));
    cleanup.push(dir);
    const dbPath = join(dir, 'shape.db');

    const seed = new DatabaseSync(dbPath);
    seed.exec(`
      PRAGMA journal_mode = DELETE;
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
      INSERT INTO schema_migrations (version) VALUES (${CURRENT_SCHEMA_MIGRATION});
    `);
    seed.close();

    const db = new Database(dbPath);
    try {
      expect(() => db.open()).toThrow(/table shape is not canonical/i);
      expect(db.raw.prepare('PRAGMA query_only').get()).toEqual({ query_only: 1 });
      expect(db.raw.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' });
    } finally {
      db.close();
    }
  });

  it('rejects hidden or generated additions to the canonical ledger shape', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsoup-schema-ceiling-hidden-'));
    cleanup.push(dir);
    const dbPath = join(dir, 'hidden.db');

    const seed = new DatabaseSync(dbPath);
    seed.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now')),
        generated_version TEXT GENERATED ALWAYS AS (version) VIRTUAL
      )
    `);
    const insert = seed.prepare('INSERT INTO schema_migrations (version) VALUES (?)');
    for (let version = 1; version <= CURRENT_SCHEMA_MIGRATION; version += 1) {
      insert.run(version);
    }
    seed.close();

    const db = new Database(dbPath);
    try {
      expect(() => db.open()).toThrow(/table shape is not canonical/i);
      expect(db.raw.prepare('PRAGMA query_only').get()).toEqual({ query_only: 1 });
    } finally {
      db.close();
    }
  });

  it('rejects a case-variant migration ledger instead of bypassing the ceiling', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsoup-schema-ceiling-case-'));
    cleanup.push(dir);
    const dbPath = join(dir, 'case.db');
    const futureVersion = CURRENT_SCHEMA_MIGRATION + 1;

    const seed = new DatabaseSync(dbPath);
    seed.exec(`
      CREATE TABLE SCHEMA_MIGRATIONS (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    const insert = seed.prepare('INSERT INTO SCHEMA_MIGRATIONS (version) VALUES (?)');
    for (let version = 1; version <= futureVersion; version += 1) insert.run(version);
    seed.close();

    const db = new Database(dbPath);
    try {
      expect(() => db.open()).toThrow(/name is not canonical/i);
      expect(db.raw.prepare('PRAGMA query_only').get()).toEqual({ query_only: 1 });
    } finally {
      db.close();
    }
  });

  it('rejects a nonempty database with no migration ledger', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsoup-schema-ceiling-unledgered-'));
    cleanup.push(dir);
    const dbPath = join(dir, 'unledgered.db');

    const seed = new DatabaseSync(dbPath);
    seed.exec('CREATE TABLE future_unledgered_state (id INTEGER PRIMARY KEY)');
    seed.close();

    const db = new Database(dbPath);
    try {
      expect(() => db.open()).toThrow(/nonempty database has no canonical migration ledger/i);
      expect(db.raw.prepare('PRAGMA query_only').get()).toEqual({ query_only: 1 });
    } finally {
      db.close();
    }
  });

  it('rejects an empty ledger that accompanies unledgered schema objects', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsoup-schema-ceiling-empty-ledger-'));
    cleanup.push(dir);
    const dbPath = join(dir, 'empty-ledger.db');

    const seed = new DatabaseSync(dbPath);
    seed.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE future_unledgered_state (id INTEGER PRIMARY KEY);
    `);
    seed.close();

    const db = new Database(dbPath);
    try {
      expect(() => db.open()).toThrow(/empty migration ledger accompanies unledgered schema/i);
      expect(db.raw.prepare('PRAGMA query_only').get()).toEqual({ query_only: 1 });
    } finally {
      db.close();
    }
  });

  it.each([
    { label: 'legacy', latest: CURRENT_SCHEMA_MIGRATION - 1 },
    { label: 'current', latest: CURRENT_SCHEMA_MIGRATION },
  ])('admits a supported $label migration ledger to normal schema verification', ({ latest }) => {
    const dir = mkdtempSync(join(tmpdir(), `whatsoup-schema-ceiling-${latest}-`));
    cleanup.push(dir);
    const dbPath = join(dir, 'supported.db');

    const initial = new Database(dbPath);
    initial.open();
    initial.close();
    if (latest < CURRENT_SCHEMA_MIGRATION) {
      const rewind = new DatabaseSync(dbPath);
      rewind.prepare('DELETE FROM schema_migrations WHERE version > ?').run(latest);
      rewind.close();
    }

    const db = new Database(dbPath);
    try {
      expect(() => db.open()).not.toThrow();
      expect(db.raw.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
        .toEqual({ version: CURRENT_SCHEMA_MIGRATION });
    } finally {
      db.close();
    }
  });

  it('accepts a fresh database with no migration ledger', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsoup-schema-ceiling-fresh-'));
    cleanup.push(dir);
    const dbPath = join(dir, 'fresh.db');

    const db = new Database(dbPath);
    try {
      expect(() => db.open()).not.toThrow();
      expect(db.raw.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
        .toEqual({ version: CURRENT_SCHEMA_MIGRATION });
    } finally {
      db.close();
    }
  });

  it('accepts an empty canonical ledger and applies the supported migration set', () => {
    const db = new Database(':memory:');
    db.raw.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    try {
      expect(() => db.open()).not.toThrow();
      expect(db.raw.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
        .toEqual({ version: CURRENT_SCHEMA_MIGRATION });
      expect(db.raw.prepare('PRAGMA query_only').get()).toEqual({ query_only: 0 });
    } finally {
      db.close();
    }
  });
});
