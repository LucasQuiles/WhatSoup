import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  statSync,
  type BigIntStats,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { WhatSoupError } from '../errors.ts';
import { CURRENT_SCHEMA_MIGRATION } from './database-schema-version.ts';

export type DatabaseCompatibilityReason =
  | 'future_schema'
  | 'engine_recovery_required'
  | 'invalid_schema'
  | 'unsafe_database_identity'
  | 'database_identity_changed'
  | 'database_not_writable';

export class DatabaseCompatibilityError<
  Reason extends DatabaseCompatibilityReason = DatabaseCompatibilityReason,
> extends WhatSoupError {
  readonly reason: Reason;
  readonly observedMigration: number | null;
  readonly requiredMigration: number;

  constructor(
    reason: Reason,
    message: string,
    cause?: unknown,
    observedMigration: number | null = null,
  ) {
    super(message, 'DATABASE_ERROR', cause);
    this.name = 'DatabaseCompatibilityError';
    this.reason = reason;
    this.observedMigration = observedMigration;
    this.requiredMigration = CURRENT_SCHEMA_MIGRATION;
  }
}

export function isDrainableDatabaseCompatibilityError(
  err: unknown,
): err is DatabaseCompatibilityError<'future_schema' | 'engine_recovery_required'> {
  return err instanceof DatabaseCompatibilityError
    && (err.reason === 'future_schema' || err.reason === 'engine_recovery_required');
}

export type DatabaseIdentity = {
  canonicalPath: string;
  device: bigint;
  inode: bigint;
  linkCount: bigint;
};

export function sqliteFileUri(path: string, mode: 'ro' | 'rw'): string {
  const url = pathToFileURL(path);
  url.searchParams.set('mode', mode);
  return url.href;
}

const MAX_WRITE_COMPATIBILITY_ERROR_NODES = 32;

export function databaseWriteCompatibilityError(
  dbPath: string,
  err: unknown,
): DatabaseCompatibilityError<
  'engine_recovery_required' | 'database_identity_changed' | 'database_not_writable'
> | null {
  const pending: unknown[] = [err];
  const seen = new Set<unknown>();
  let inspected = 0;

  while (pending.length > 0 && inspected < MAX_WRITE_COMPATIBILITY_ERROR_NODES) {
    const current = pending.shift();
    if (
      current === null
      || (typeof current !== 'object' && typeof current !== 'function')
      || seen.has(current)
    ) {
      continue;
    }
    seen.add(current);
    inspected += 1;

    if (current instanceof DatabaseCompatibilityError) {
      switch (current.reason) {
        case 'engine_recovery_required':
        case 'database_identity_changed':
        case 'database_not_writable':
          return current as DatabaseCompatibilityError<
            'engine_recovery_required' | 'database_identity_changed' | 'database_not_writable'
          >;
      }
    }

    const errcode = (current as { errcode?: unknown }).errcode;
    let reason:
      | 'engine_recovery_required'
      | 'database_identity_changed'
      | 'database_not_writable'
      | null = null;
    if (errcode === 264 || errcode === 776) reason = 'engine_recovery_required';
    else if (errcode === 1032) reason = 'database_identity_changed';
    else if (errcode === 8 || errcode === 520 || errcode === 1288 || errcode === 1544) {
      reason = 'database_not_writable';
    }
    const code = (current as { code?: unknown }).code;
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
      reason = 'database_not_writable';
    }
    if (reason) {
      const message = reason === 'engine_recovery_required'
        ? `Database engine recovery is required before writes at ${dbPath}`
        : reason === 'database_identity_changed'
          ? `Database identity changed before or during writes at ${dbPath}`
          : `Database is not writable at ${dbPath}`;
      return new DatabaseCompatibilityError(reason, message, current);
    }

    const cause = (current as { cause?: unknown }).cause;
    if (cause !== undefined && pending.length + inspected < MAX_WRITE_COMPATIBILITY_ERROR_NODES) {
      pending.push(cause);
    }
    if (current instanceof AggregateError) {
      for (const nested of current.errors) {
        if (pending.length + inspected >= MAX_WRITE_COMPATIBILITY_ERROR_NODES) break;
        pending.push(nested);
      }
    }
  }
  return null;
}

export function createEmptyDatabaseFile(dbPath: string): DatabaseIdentity {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      dbPath,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n) {
      throw new DatabaseCompatibilityError(
        'unsafe_database_identity',
        `Exclusive database create did not produce one regular file at ${dbPath}`,
      );
    }
    const identity = inspectDatabaseIdentity(dbPath);
    if (
      opened.dev !== identity.device
      || opened.ino !== identity.inode
      || opened.nlink !== identity.linkCount
    ) {
      throw new DatabaseCompatibilityError(
        'database_identity_changed',
        `Database identity changed during exclusive create at ${dbPath}`,
      );
    }
    closeSync(descriptor);
    descriptor = null;
    return identity;
  } catch (err) {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // The original creation/close failure remains authoritative.
      }
    }
    const code = (err as { code?: unknown })?.code;
    if (code === 'EEXIST' || code === 'ELOOP') {
      throw new DatabaseCompatibilityError(
        'database_identity_changed',
        `Database creation target changed before exclusive create at ${dbPath}`,
        err,
      );
    }
    if (err instanceof DatabaseCompatibilityError) throw err;
    const rejection = databaseWriteCompatibilityError(dbPath, err);
    if (rejection) throw rejection;
    throw new WhatSoupError(`Cannot create database at ${dbPath}`, 'DATABASE_ERROR', err);
  }
}

export function databaseRecoveryCompatibilityError(
  dbPath: string,
  err: unknown,
): DatabaseCompatibilityError<'engine_recovery_required'> | null {
  const compatibilityError = databaseWriteCompatibilityError(dbPath, err);
  return compatibilityError?.reason === 'engine_recovery_required'
    ? compatibilityError as DatabaseCompatibilityError<'engine_recovery_required'>
    : null;
}

export function sameDatabaseIdentity(
  left: DatabaseIdentity,
  right: DatabaseIdentity,
): boolean {
  return left.canonicalPath === right.canonicalPath
    && left.device === right.device
    && left.inode === right.inode
    && left.linkCount === right.linkCount;
}

export function inspectDatabaseIdentity(dbPath: string): DatabaseIdentity {
  const absolutePath = resolve(dbPath);
  let linkInfo: BigIntStats;
  try {
    linkInfo = lstatSync(absolutePath, { bigint: true });
  } catch (err) {
    throw new DatabaseCompatibilityError(
      'database_identity_changed',
      `Database identity changed or disappeared at ${absolutePath}`,
      err,
    );
  }
  if (linkInfo.isSymbolicLink()) {
    throw new DatabaseCompatibilityError(
      'unsafe_database_identity',
      `Refusing symbolic link as canonical database path: ${absolutePath}`,
    );
  }
  if (!linkInfo.isFile()) {
    throw new DatabaseCompatibilityError(
      'unsafe_database_identity',
      `Canonical database path is not a regular file: ${absolutePath}`,
    );
  }
  if (linkInfo.nlink !== 1n) {
    throw new DatabaseCompatibilityError(
      'unsafe_database_identity',
      `Refusing database identity with link count ${linkInfo.nlink}: ${absolutePath}`,
    );
  }

  const canonicalPath = realpathSync(absolutePath);
  if (canonicalPath !== absolutePath) {
    throw new DatabaseCompatibilityError(
      'unsafe_database_identity',
      `Refusing non-canonical database path alias: ${absolutePath}`,
    );
  }
  const targetInfo = statSync(canonicalPath, { bigint: true });
  if (targetInfo.dev !== linkInfo.dev || targetInfo.ino !== linkInfo.ino) {
    throw new DatabaseCompatibilityError(
      'database_identity_changed',
      `Database identity changed while resolving canonical path: ${absolutePath}`,
    );
  }
  return {
    canonicalPath,
    device: targetInfo.dev,
    inode: targetInfo.ino,
    linkCount: targetInfo.nlink,
  };
}

function isMissingPathError(err: unknown): boolean {
  return (err as { code?: unknown })?.code === 'ENOENT';
}

function deterministicDatabasePathError(
  dbPath: string,
  err: unknown,
  unsafeMessage: string,
): DatabaseCompatibilityError | null {
  const writeRejection = databaseWriteCompatibilityError(dbPath, err);
  if (writeRejection) return writeRejection;
  const code = (err as { code?: unknown })?.code;
  if (
    code === 'ELOOP'
    || code === 'ENOTDIR'
    || code === 'ENAMETOOLONG'
    || code === 'EINVAL'
    || code === 'ERR_INVALID_ARG_VALUE'
  ) {
    return new DatabaseCompatibilityError(
      'unsafe_database_identity',
      unsafeMessage,
      err,
    );
  }
  return null;
}

type DatabaseDirectoryInspectionDependencies = {
  lstat(path: string): BigIntStats;
  realpath(path: string): string;
  stat(path: string): BigIntStats;
};

const databaseDirectoryInspectionDependencies: DatabaseDirectoryInspectionDependencies = {
  lstat: (path) => lstatSync(path, { bigint: true }),
  realpath: (path) => realpathSync(path),
  stat: (path) => statSync(path, { bigint: true }),
};

function inspectCanonicalDatabaseDirectory(
  path: string,
  dbPath: string,
  dependencies: DatabaseDirectoryInspectionDependencies,
): BigIntStats {
  let linkInfo: BigIntStats;
  try {
    linkInfo = dependencies.lstat(path);
  } catch (err) {
    if (err instanceof DatabaseCompatibilityError) throw err;
    const deterministic = deterministicDatabasePathError(
      dbPath,
      err,
      `Cannot trust database directory path: ${path}`,
    );
    if (deterministic) throw deterministic;
    throw new DatabaseCompatibilityError(
      'database_identity_changed',
      `Database directory identity changed before writer open at ${path}`,
      err,
    );
  }
  if (linkInfo.isSymbolicLink() || !linkInfo.isDirectory()) {
    throw new DatabaseCompatibilityError(
      'unsafe_database_identity',
      `Refusing symbolic link or non-directory in canonical database path: ${path}`,
    );
  }

  let canonicalPath: string;
  try {
    canonicalPath = dependencies.realpath(path);
  } catch (err) {
    if (err instanceof DatabaseCompatibilityError) throw err;
    const deterministic = deterministicDatabasePathError(
      dbPath,
      err,
      `Cannot trust database directory path: ${path}`,
    );
    if (deterministic) throw deterministic;
    throw new DatabaseCompatibilityError(
      'database_identity_changed',
      `Database directory identity changed while resolving ${path}`,
      err,
    );
  }
  if (canonicalPath !== path) {
    throw new DatabaseCompatibilityError(
      'unsafe_database_identity',
      `Refusing non-canonical database directory path alias: ${path}`,
    );
  }

  let targetInfo: BigIntStats;
  try {
    targetInfo = dependencies.stat(canonicalPath);
  } catch (err) {
    if (err instanceof DatabaseCompatibilityError) throw err;
    const deterministic = deterministicDatabasePathError(
      dbPath,
      err,
      `Cannot trust resolved database directory path: ${path}`,
    );
    if (deterministic) throw deterministic;
    throw new DatabaseCompatibilityError(
      'database_identity_changed',
      `Database directory identity changed after resolving ${path}`,
      err,
    );
  }
  if (targetInfo.dev !== linkInfo.dev || targetInfo.ino !== linkInfo.ino) {
    throw new DatabaseCompatibilityError(
      'database_identity_changed',
      `Database directory identity changed while resolving ${path}`,
    );
  }
  return targetInfo;
}

function assertTrustedDatabaseDirectoryMetadata(
  info: { uid: number | bigint; mode: number | bigint },
  path: string,
): void {
  const effectiveUserId = typeof process.geteuid === 'function' ? process.geteuid() : null;
  if (effectiveUserId !== null && BigInt(info.uid) !== BigInt(effectiveUserId)) {
    throw new DatabaseCompatibilityError(
      'unsafe_database_identity',
      `Database parent is not owned by the runtime user: ${path}`,
    );
  }
  if ((BigInt(info.mode) & 0o077n) !== 0n) {
    throw new DatabaseCompatibilityError(
      'unsafe_database_identity',
      `Database parent grants group or other access: ${path}`,
    );
  }
}

function assertTrustedDatabaseDirectoryChain(
  leaf: string,
  dbPath: string,
  dependencies: DatabaseDirectoryInspectionDependencies,
): void {
  let childPath = leaf;
  let childInfo = inspectCanonicalDatabaseDirectory(childPath, dbPath, dependencies);
  assertTrustedDatabaseDirectoryMetadata(childInfo, childPath);
  const effectiveUserId = typeof process.geteuid === 'function'
    ? BigInt(process.geteuid())
    : null;

  while (dirname(childPath) !== childPath) {
    const ancestorPath = dirname(childPath);
    const ancestorInfo = inspectCanonicalDatabaseDirectory(
      ancestorPath,
      dbPath,
      dependencies,
    );
    const ancestorUserId = BigInt(ancestorInfo.uid);
    if (
      effectiveUserId !== null
      && ancestorUserId !== 0n
      && ancestorUserId !== effectiveUserId
    ) {
      throw new DatabaseCompatibilityError(
        'unsafe_database_identity',
        `Database ancestor is controlled by another runtime user: ${ancestorPath}`,
      );
    }

    if ((BigInt(ancestorInfo.mode) & 0o022n) !== 0n) {
      const hasStickyRenameProtection = (BigInt(ancestorInfo.mode) & 0o1000n) !== 0n
        && effectiveUserId !== null
        && BigInt(childInfo.uid) === effectiveUserId;
      if (!hasStickyRenameProtection) {
        throw new DatabaseCompatibilityError(
          'unsafe_database_identity',
          `Database ancestor permits untrusted entry replacement: ${ancestorPath}`,
        );
      }
    }

    childPath = ancestorPath;
    childInfo = ancestorInfo;
  }
}

/**
 * Return the identity of an existing database, or prove that a missing target
 * can be created without following a pathname alias.
 */
export function inspectDatabasePathBeforeCreate(dbPath: string): DatabaseIdentity | null {
  const absolutePath = resolve(dbPath);
  try {
    lstatSync(absolutePath);
    const identity = inspectDatabaseIdentity(absolutePath);
    assertTrustedDatabaseParent(absolutePath);
    return identity;
  } catch (err) {
    if (!isMissingPathError(err)) {
      if (err instanceof DatabaseCompatibilityError) throw err;
      const deterministic = deterministicDatabasePathError(
        absolutePath,
        err,
        `Cannot create DB directory safely because a parent is not a directory: ${absolutePath}`,
      );
      if (deterministic) throw deterministic;
      throw new DatabaseCompatibilityError(
        'database_identity_changed',
        `Database creation target could not be inspected at ${absolutePath}`,
        err,
      );
    }
  }

  let ancestor = dirname(absolutePath);
  while (true) {
    try {
      lstatSync(ancestor);
    } catch (err) {
      if (isMissingPathError(err) && dirname(ancestor) !== ancestor) {
        ancestor = dirname(ancestor);
        continue;
      }
      const deterministic = deterministicDatabasePathError(
        absolutePath,
        err,
        `Cannot create DB directory safely because a parent is not a directory: ${ancestor}`,
      );
      if (deterministic) throw deterministic;
      throw new DatabaseCompatibilityError(
        'database_identity_changed',
        `Database parent path could not be inspected at ${ancestor}`,
        err,
      );
    }
    assertTrustedDatabaseDirectoryChain(
      ancestor,
      absolutePath,
      databaseDirectoryInspectionDependencies,
    );
    return null;
  }
}

export function assertTrustedDatabaseParent(
  dbPath: string,
  dependencies: DatabaseDirectoryInspectionDependencies = databaseDirectoryInspectionDependencies,
): void {
  const absolutePath = resolve(dbPath);
  const parent = dirname(absolutePath);
  assertTrustedDatabaseDirectoryChain(parent, absolutePath, dependencies);
}

function invalidSchemaError(
  message: string,
  cause?: unknown,
): DatabaseCompatibilityError {
  return new DatabaseCompatibilityError('invalid_schema', message, cause);
}

function schemaInspectionFailure(dbPath: string, err: unknown): unknown {
  return databaseWriteCompatibilityError(dbPath, err) ?? err;
}

function countUserSchemaObjects(
  db: DatabaseSync,
  dbPath: string,
  excludedName?: string,
): number {
  let row: { count: number };
  try {
    row = db.prepare(`
      SELECT COUNT(*) AS count
      FROM main.sqlite_master
      WHERE name NOT GLOB 'sqlite_*'
        AND (? IS NULL OR name <> ?)
    `).get(excludedName ?? null, excludedName ?? null) as { count: number };
  } catch (err) {
    throw schemaInspectionFailure(dbPath, err);
  }
  if (!Number.isSafeInteger(row.count) || row.count < 0) {
    throw invalidSchemaError(
      'Failed to inspect database objects: object count is invalid',
    );
  }
  return row.count;
}

export function assertSchemaCeiling(db: DatabaseSync, dbPath: string): void {
  let migrationObject: { name: string; type: string } | undefined;
  try {
    migrationObject = db.prepare(`
      SELECT name, type
      FROM main.sqlite_master
      WHERE name = 'schema_migrations' COLLATE NOCASE
      LIMIT 1
    `).get() as { name: string; type: string } | undefined;
  } catch (err) {
    throw schemaInspectionFailure(dbPath, err);
  }
  if (!migrationObject) {
    if (countUserSchemaObjects(db, dbPath) === 0) return;
    throw invalidSchemaError(
      'Failed to inspect schema migration ceiling: nonempty database has no canonical migration ledger',
    );
  }
  if (migrationObject.name !== 'schema_migrations') {
    throw invalidSchemaError(
      'Failed to inspect schema migration ceiling: schema_migrations name is not canonical',
    );
  }
  if (migrationObject.type !== 'table') {
    throw invalidSchemaError(
      'Failed to inspect schema migration ceiling: schema_migrations is not a table',
    );
  }

  type ColumnMetadata = {
    cid: number;
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
    hidden: number;
  };
  let columns: ColumnMetadata[];
  let tableMetadata: {
    schema: string;
    name: string;
    type: string;
    ncol: number;
    wr: number;
    strict: number;
  } | undefined;
  try {
    columns = db.prepare("PRAGMA main.table_xinfo('schema_migrations')").all() as ColumnMetadata[];
    tableMetadata = (
      db.prepare("PRAGMA main.table_list('schema_migrations')").get()
    ) as typeof tableMetadata;
  } catch (err) {
    throw schemaInspectionFailure(dbPath, err);
  }

  const [versionColumn, appliedAtColumn] = columns;
  const appliedAtDefault = appliedAtColumn?.dflt_value?.replaceAll(/\s/g, '').toLowerCase();
  const canonicalShape = columns.length === 2
    && versionColumn?.cid === 0
    && versionColumn.name === 'version'
    && versionColumn.type.toUpperCase() === 'INTEGER'
    && versionColumn.notnull === 0
    && versionColumn.dflt_value === null
    && versionColumn.pk === 1
    && versionColumn.hidden === 0
    && appliedAtColumn?.cid === 1
    && appliedAtColumn.name === 'applied_at'
    && appliedAtColumn.type.toUpperCase() === 'TEXT'
    && appliedAtColumn.notnull === 1
    && (appliedAtDefault === "datetime('now')" || appliedAtDefault === "(datetime('now'))")
    && appliedAtColumn.pk === 0
    && appliedAtColumn.hidden === 0
    && tableMetadata?.schema === 'main'
    && tableMetadata.name === 'schema_migrations'
    && tableMetadata.type === 'table'
    && tableMetadata.ncol === 2
    && tableMetadata.wr === 0
    && tableMetadata.strict === 0;
  if (!canonicalShape) {
    throw invalidSchemaError(
      'Failed to inspect schema migration ceiling: schema_migrations table shape is not canonical',
    );
  }

  let row: {
    row_count: number;
    latest: number | null;
    distinct_versions: number;
    invalid_versions: number;
  };
  try {
    row = db.prepare(`
      SELECT COUNT(*) AS row_count,
             MAX(version) AS latest,
             COUNT(DISTINCT version) AS distinct_versions,
             COALESCE(SUM(
               CASE
                 WHEN typeof(version) = 'integer' AND version >= 1 THEN 0
                 ELSE 1
               END
             ), 0) AS invalid_versions
      FROM schema_migrations
    `).get() as typeof row;
  } catch (err) {
    throw schemaInspectionFailure(dbPath, err);
  }

  const countersAreSafe = Number.isSafeInteger(row.row_count)
    && row.row_count >= 0
    && Number.isSafeInteger(row.distinct_versions)
    && row.distinct_versions >= 0
    && Number.isSafeInteger(row.invalid_versions)
    && row.invalid_versions >= 0;
  const latestIsSafe = row.latest === null || Number.isSafeInteger(row.latest);
  if (!countersAreSafe || !latestIsSafe) {
    throw invalidSchemaError(
      'Failed to inspect schema migration ceiling: migration ledger counters are invalid',
    );
  }

  if (row.latest !== null && row.latest > CURRENT_SCHEMA_MIGRATION) {
    throw new DatabaseCompatibilityError(
      'future_schema',
      `Database schema migration ${row.latest} exceeds binary ceiling ${CURRENT_SCHEMA_MIGRATION}; refusing writes`,
      undefined,
      row.latest,
    );
  }

  if (
    row.invalid_versions !== 0
    || row.row_count !== row.distinct_versions
    || (row.row_count === 0 && row.latest !== null)
    || (row.row_count > 0 && row.latest === null)
  ) {
    throw invalidSchemaError(
      'Failed to inspect schema migration ceiling: recorded versions fall outside the supported range',
    );
  }

  if (
    row.row_count === 0
    && countUserSchemaObjects(db, dbPath, 'schema_migrations') !== 0
  ) {
    throw invalidSchemaError(
      'Failed to inspect schema migration ceiling: empty migration ledger accompanies unledgered schema objects',
    );
  }
}

export function normalizeDatabaseCompatibilityError(
  dbPath: string,
  err: unknown,
): DatabaseCompatibilityError | null {
  if (err instanceof DatabaseCompatibilityError) return err;
  return databaseWriteCompatibilityError(dbPath, err);
}

export function assertDatabaseIdentity(
  db: DatabaseSync,
  dbPath: string,
  expectedIdentity: DatabaseIdentity | null,
): void {
  if (!expectedIdentity) return;
  const currentIdentity = inspectDatabaseIdentity(dbPath);
  const openedLocation = db.location('main');
  if (
    !sameDatabaseIdentity(expectedIdentity, currentIdentity)
    || openedLocation === null
    || realpathSync(openedLocation) !== expectedIdentity.canonicalPath
  ) {
    throw new DatabaseCompatibilityError(
      'database_identity_changed',
      `Database identity or path was replaced before schema writes at ${dbPath}`,
    );
  }
}

export function installReadOnlyRejectionFence(
  db: DatabaseSync,
  rejection: DatabaseCompatibilityError,
  onClosed: () => void,
): void {
  const mustClose = rejection.reason === 'engine_recovery_required'
    || rejection.reason === 'database_identity_changed'
    || rejection.reason === 'unsafe_database_identity';
  if (mustClose) {
    let readOnlyError: unknown;
    try {
      db.exec('PRAGMA query_only = ON');
    } catch (err) {
      readOnlyError = err;
    }
    try {
      db.close();
      onClosed();
      return;
    } catch (closeError) {
      throw new WhatSoupError(
        `${rejection.message}; failed to close the rejected database connection`,
        'DATABASE_ERROR',
        new AggregateError(
          readOnlyError === undefined
            ? [rejection, closeError]
            : [rejection, readOnlyError, closeError],
          'Database compatibility close fence failed',
        ),
      );
    }
  }
  try {
    db.exec('PRAGMA query_only = ON');
  } catch (readOnlyErr) {
    const causes: unknown[] = [rejection, readOnlyErr];
    try {
      db.close();
      onClosed();
    } catch (closeErr) {
      causes.push(closeErr);
    }
    throw new WhatSoupError(
      `${rejection.message}; failed to establish the read-only rejection fence`,
      'DATABASE_ERROR',
      new AggregateError(causes, 'Schema rejection fence failed'),
    );
  }
}
