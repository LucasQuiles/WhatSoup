// tests/core/database-compatibility.test.ts
// Unit coverage for the pure decision branches of database-compatibility.ts:
// the write-error classifier's traversal bounds, exclusive-create failure
// taxonomy, canonical-identity refusals, the injectable directory-chain trust
// walk, schema-ceiling default-clause variants, and the rejection fence's
// close-failure aggregation.
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir as systemTmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DatabaseCompatibilityError,
  assertSchemaCeiling,
  assertTrustedDatabaseParent,
  createEmptyDatabaseFile,
  databaseWriteCompatibilityError,
  inspectDatabaseIdentity,
  installReadOnlyRejectionFence,
} from '../../src/core/database-compatibility.ts';
import { WhatSoupError } from '../../src/errors.ts';

let tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(realpathSync(systemTmpdir()), 'whatsoup-dbcompat-'));
  tempDirs.push(dir);
  return dir;
}

function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected the callback to throw');
}

afterEach(() => {
  vi.doUnmock('node:fs');
  vi.resetModules();
  for (const dir of tempDirs) {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe('databaseWriteCompatibilityError traversal bounds', () => {
  it('walks past non-object causes without classifying them', () => {
    const primitiveCause = Object.assign(new Error('outer'), { cause: 'not-an-object' });
    expect(databaseWriteCompatibilityError('/db', primitiveCause)).toBeNull();

    const functionCause = Object.assign(new Error('outer'), { cause: () => {} });
    expect(databaseWriteCompatibilityError('/db', functionCause)).toBeNull();
  });

  it('stops inspecting an AggregateError once the node budget is exhausted', () => {
    // A recognizable recovery marker parked beyond the 32-node inspection cap
    // must stay unreachable: the classifier reports null rather than walking an
    // unbounded (or adversarially wide) error graph.
    const filler = Array.from({ length: 38 }, (_, i) => new Error(`filler-${i}`));
    const beyondBudget = Object.assign(new Error('recovery'), { errcode: 264 });
    const wide = new AggregateError([...filler, beyondBudget], 'wide');
    expect(databaseWriteCompatibilityError('/db', wide)).toBeNull();
  });
});

describe('createEmptyDatabaseFile', () => {
  it('creates one regular file and reports its identity', () => {
    const dbPath = join(makeTempDir(), 'db.sqlite');
    const identity = createEmptyDatabaseFile(dbPath);
    expect(identity.canonicalPath).toBe(dbPath);
    expect(identity.linkCount).toBe(1n);
    expect(inspectDatabaseIdentity(dbPath)).toEqual(identity);
  });

  it('reports an already-present target as an identity change', () => {
    const dbPath = join(makeTempDir(), 'db.sqlite');
    writeFileSync(dbPath, '');
    const err = captureError(() => createEmptyDatabaseFile(dbPath));
    expect(err).toBeInstanceOf(DatabaseCompatibilityError);
    expect((err as DatabaseCompatibilityError).reason).toBe('database_identity_changed');
    expect((err as Error).message).toContain('creation target changed');
  });

  it('reports a symlink loop in the creation path as an identity change', () => {
    const dir = makeTempDir();
    symlinkSync(join(dir, 'loop'), join(dir, 'loop'));
    const err = captureError(() => createEmptyDatabaseFile(join(dir, 'loop', 'db.sqlite')));
    expect(err).toBeInstanceOf(DatabaseCompatibilityError);
    expect((err as DatabaseCompatibilityError).reason).toBe('database_identity_changed');
  });

  it('classifies an unwritable parent as database_not_writable', () => {
    const dir = makeTempDir();
    chmodSync(dir, 0o500);
    const err = captureError(() => createEmptyDatabaseFile(join(dir, 'db.sqlite')));
    expect(err).toBeInstanceOf(DatabaseCompatibilityError);
    expect((err as DatabaseCompatibilityError).reason).toBe('database_not_writable');
  });

  it('wraps an unclassifiable creation failure as a generic database error', () => {
    const dbPath = join(makeTempDir(), 'missing-parent', 'db.sqlite');
    const err = captureError(() => createEmptyDatabaseFile(dbPath));
    expect(err).toBeInstanceOf(WhatSoupError);
    expect(err).not.toBeInstanceOf(DatabaseCompatibilityError);
    expect((err as Error).message).toContain('Cannot create database');
  });

  it('refuses a descriptor that is not one regular file after exclusive create', async () => {
    vi.resetModules();
    vi.doMock('node:fs', async (importOriginal: () => Promise<typeof import('node:fs')>) => {
      const actual = await importOriginal();
      return {
        ...actual,
        fstatSync: () => ({ isFile: () => true, nlink: 2n, dev: 1n, ino: 1n }),
      };
    });
    const mocked = await import('../../src/core/database-compatibility.ts');
    const dbPath = join(makeTempDir(), 'db.sqlite');
    const err = captureError(() => mocked.createEmptyDatabaseFile(dbPath));
    expect(err).toBeInstanceOf(mocked.DatabaseCompatibilityError);
    expect((err as DatabaseCompatibilityError).reason).toBe('unsafe_database_identity');
    expect((err as Error).message).toContain('did not produce one regular file');
  });

  it('refuses a created descriptor whose identity diverges from the path', async () => {
    vi.resetModules();
    vi.doMock('node:fs', async (importOriginal: () => Promise<typeof import('node:fs')>) => {
      const actual = await importOriginal();
      return {
        ...actual,
        fstatSync: () => ({ isFile: () => true, nlink: 1n, dev: 999_999n, ino: 999_999n }),
      };
    });
    const mocked = await import('../../src/core/database-compatibility.ts');
    const dbPath = join(makeTempDir(), 'db.sqlite');
    const err = captureError(() => mocked.createEmptyDatabaseFile(dbPath));
    expect(err).toBeInstanceOf(mocked.DatabaseCompatibilityError);
    expect((err as DatabaseCompatibilityError).reason).toBe('database_identity_changed');
    expect((err as Error).message).toContain('identity changed during exclusive create');
  });
});

describe('inspectDatabaseIdentity canonical-path refusals', () => {
  it('refuses a path reached through a symlinked parent directory', () => {
    const dir = makeTempDir();
    const realDir = join(dir, 'real');
    mkdirSync(realDir);
    const dbPath = join(realDir, 'db.sqlite');
    writeFileSync(dbPath, '');
    symlinkSync(realDir, join(dir, 'alias'));
    const err = captureError(() => inspectDatabaseIdentity(join(dir, 'alias', 'db.sqlite')));
    expect(err).toBeInstanceOf(DatabaseCompatibilityError);
    expect((err as DatabaseCompatibilityError).reason).toBe('unsafe_database_identity');
    expect((err as Error).message).toContain('non-canonical database path alias');
  });
});

type FakeDirectoryStats = {
  isSymbolicLink: () => boolean;
  isDirectory: () => boolean;
  dev: bigint;
  ino: bigint;
  uid: bigint;
  mode: bigint;
};

function directoryStats(uid: number | bigint, mode: number): FakeDirectoryStats {
  return {
    isSymbolicLink: () => false,
    isDirectory: () => true,
    dev: 1n,
    ino: 100n,
    uid: BigInt(uid),
    mode: BigInt(mode),
  };
}

function euid(): number {
  if (typeof process.geteuid !== 'function') throw new Error('test requires geteuid');
  return process.geteuid();
}

describe('assertTrustedDatabaseParent directory-chain walk (injected dependencies)', () => {
  const DB_PATH = '/safe/store/db.sqlite';

  function depsFromTable(table: Record<string, FakeDirectoryStats>) {
    return {
      lstat: (path: string) => {
        const stats = table[path];
        if (!stats) throw new Error(`unexpected lstat: ${path}`);
        return stats as never;
      },
      realpath: (path: string) => path,
      stat: (path: string) => {
        const stats = table[path];
        if (!stats) throw new Error(`unexpected stat: ${path}`);
        return stats as never;
      },
    };
  }

  it('accepts a chain of owner-private and root-owned safe ancestors', () => {
    const table = {
      '/safe/store': directoryStats(euid(), 0o40700),
      '/safe': directoryStats(0, 0o40755),
      '/': directoryStats(0, 0o40755),
    };
    expect(() => assertTrustedDatabaseParent(DB_PATH, depsFromTable(table))).not.toThrow();
  });

  it('refuses a parent owned by another user', () => {
    const table = { '/safe/store': directoryStats(euid() + 1, 0o40700) };
    const err = captureError(() => assertTrustedDatabaseParent(DB_PATH, depsFromTable(table)));
    expect(err).toBeInstanceOf(DatabaseCompatibilityError);
    expect((err as Error).message).toContain('not owned by the runtime user');
  });

  it('refuses an ancestor controlled by a third runtime user', () => {
    const table = {
      '/safe/store': directoryStats(euid(), 0o40700),
      '/safe': directoryStats(euid() + 2, 0o40755),
    };
    const err = captureError(() => assertTrustedDatabaseParent(DB_PATH, depsFromTable(table)));
    expect(err).toBeInstanceOf(DatabaseCompatibilityError);
    expect((err as Error).message).toContain('controlled by another runtime user');
  });

  it('skips user-identity checks entirely when the platform has no effective uid', () => {
    const originalGeteuid = process.geteuid;
    Object.defineProperty(process, 'geteuid', { value: undefined, configurable: true });
    try {
      const table = {
        '/safe/store': directoryStats(12_345, 0o40700),
        '/safe': directoryStats(54_321, 0o40755),
        '/': directoryStats(54_321, 0o40755),
      };
      expect(() => assertTrustedDatabaseParent(DB_PATH, depsFromTable(table))).not.toThrow();
    } finally {
      Object.defineProperty(process, 'geteuid', { value: originalGeteuid, configurable: true });
    }
  });

  it.each([
    ['lstat', 'before writer open'],
    ['realpath', 'while resolving'],
    ['stat', 'after resolving'],
  ] as const)('re-throws a compatibility error surfaced by %s unchanged', (failingDependency, _phase) => {
    const injected = new DatabaseCompatibilityError('unsafe_database_identity', 'injected sentinel');
    const good = depsFromTable({ '/safe/store': directoryStats(euid(), 0o40700) });
    const deps = { ...good, [failingDependency]: () => { throw injected; } };
    expect(captureError(() => assertTrustedDatabaseParent(DB_PATH, deps))).toBe(injected);
  });

  it.each([
    ['lstat'],
    ['realpath'],
    ['stat'],
  ] as const)('classifies a permission failure from %s as database_not_writable', (failingDependency) => {
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
    const good = depsFromTable({ '/safe/store': directoryStats(euid(), 0o40700) });
    const deps = { ...good, [failingDependency]: () => { throw denied; } };
    const err = captureError(() => assertTrustedDatabaseParent(DB_PATH, deps));
    expect(err).toBeInstanceOf(DatabaseCompatibilityError);
    expect((err as DatabaseCompatibilityError).reason).toBe('database_not_writable');
  });

  it.each([
    ['lstat', 'identity changed before writer open'],
    ['realpath', 'identity changed while resolving'],
    ['stat', 'identity changed after resolving'],
  ] as const)('treats an unlisted %s failure as a directory identity change', (failingDependency, expected) => {
    const opaque = new Error('opaque failure');
    const good = depsFromTable({ '/safe/store': directoryStats(euid(), 0o40700) });
    const deps = { ...good, [failingDependency]: () => { throw opaque; } };
    const err = captureError(() => assertTrustedDatabaseParent(DB_PATH, deps));
    expect(err).toBeInstanceOf(DatabaseCompatibilityError);
    expect((err as DatabaseCompatibilityError).reason).toBe('database_identity_changed');
    expect((err as Error).message).toContain(expected);
  });

  it('refuses a directory whose realpath is not itself', () => {
    const table = { '/safe/store': directoryStats(euid(), 0o40700) };
    const deps = { ...depsFromTable(table), realpath: (path: string) => `${path}-alias` };
    const err = captureError(() => assertTrustedDatabaseParent(DB_PATH, deps));
    expect(err).toBeInstanceOf(DatabaseCompatibilityError);
    expect((err as Error).message).toContain('non-canonical database directory path alias');
  });
});

describe('assertSchemaCeiling default-clause variants', () => {
  it('accepts the outer-parenthesized applied_at default SQLite preserves verbatim', () => {
    // `DEFAULT (datetime('now'))` is reported by table_xinfo with its outer
    // parens stripped; the doubled form keeps one layer, exercising the
    // second accepted spelling of the canonical default.
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT ((datetime('now')))
      )
    `);
    expect(() => assertSchemaCeiling(db, '/db')).not.toThrow();
    db.close();
  });
});

describe('installReadOnlyRejectionFence close-failure aggregation', () => {
  const mustCloseRejection = new DatabaseCompatibilityError(
    'engine_recovery_required',
    'engine recovery required',
  );

  it('aggregates rejection, read-only failure, and close failure on a dead connection', () => {
    const db = new DatabaseSync(':memory:');
    db.close();
    const onClosed = vi.fn();
    const err = captureError(() => installReadOnlyRejectionFence(db, mustCloseRejection, onClosed));
    expect(err).toBeInstanceOf(WhatSoupError);
    expect((err as Error).message).toContain('failed to close the rejected database connection');
    expect(((err as WhatSoupError).cause as AggregateError).errors).toHaveLength(3);
    expect(onClosed).not.toHaveBeenCalled();
  });

  it('aggregates only rejection and close failure when the read-only fence held', () => {
    const stub = { exec: () => {}, close: () => { throw new Error('close refused'); } };
    const onClosed = vi.fn();
    const err = captureError(() => installReadOnlyRejectionFence(
      stub as unknown as DatabaseSync,
      mustCloseRejection,
      onClosed,
    ));
    expect(err).toBeInstanceOf(WhatSoupError);
    expect(((err as WhatSoupError).cause as AggregateError).errors).toHaveLength(2);
    expect(onClosed).not.toHaveBeenCalled();
  });
});
