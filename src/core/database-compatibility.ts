import {
  lstatSync,
  realpathSync,
  statSync,
  type BigIntStats,
} from 'node:fs';
import { resolve } from 'node:path';
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

export function isSqliteReadonlyRollback(err: unknown): boolean {
  return (err as { errcode?: unknown })?.errcode === 776;
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

function compatibilityError(
  dbPath: string,
  message: string,
  cause?: unknown,
): DatabaseCompatibilityError {
  if (isSqliteReadonlyRollback(cause)) {
    return new DatabaseCompatibilityError(
      'engine_recovery_required',
      `Database engine recovery is required before schema inspection at ${dbPath}`,
      cause,
    );
  }
  return new DatabaseCompatibilityError('invalid_schema', message, cause);
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
    throw compatibilityError(
      dbPath,
      'Failed to inspect database objects before schema writes',
      err,
    );
  }
  if (!Number.isSafeInteger(row.count) || row.count < 0) {
    throw compatibilityError(
      dbPath,
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
    throw compatibilityError(
      dbPath,
      'Failed to inspect schema migration ceiling before database writes',
      err,
    );
  }
  if (!migrationObject) {
    if (countUserSchemaObjects(db, dbPath) === 0) return;
    throw compatibilityError(
      dbPath,
      'Failed to inspect schema migration ceiling: nonempty database has no canonical migration ledger',
    );
  }
  if (migrationObject.name !== 'schema_migrations') {
    throw compatibilityError(
      dbPath,
      'Failed to inspect schema migration ceiling: schema_migrations name is not canonical',
    );
  }
  if (migrationObject.type !== 'table') {
    throw compatibilityError(
      dbPath,
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
    throw compatibilityError(
      dbPath,
      'Failed to inspect schema migration ceiling table shape before database writes',
      err,
    );
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
    throw compatibilityError(
      dbPath,
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
    throw compatibilityError(
      dbPath,
      'Failed to inspect schema migration ceiling before database writes',
      err,
    );
  }

  const countersAreSafe = Number.isSafeInteger(row.row_count)
    && row.row_count >= 0
    && Number.isSafeInteger(row.distinct_versions)
    && row.distinct_versions >= 0
    && Number.isSafeInteger(row.invalid_versions)
    && row.invalid_versions >= 0;
  const latestIsSafe = row.latest === null || Number.isSafeInteger(row.latest);
  if (!countersAreSafe || !latestIsSafe) {
    throw compatibilityError(
      dbPath,
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
    throw compatibilityError(
      dbPath,
      'Failed to inspect schema migration ceiling: recorded versions fall outside the supported range',
    );
  }

  if (
    row.row_count === 0
    && countUserSchemaObjects(db, dbPath, 'schema_migrations') !== 0
  ) {
    throw compatibilityError(
      dbPath,
      'Failed to inspect schema migration ceiling: empty migration ledger accompanies unledgered schema objects',
    );
  }
}

export function normalizeDatabaseCompatibilityError(
  dbPath: string,
  err: unknown,
): DatabaseCompatibilityError {
  if (err instanceof DatabaseCompatibilityError) return err;
  return compatibilityError(
    dbPath,
    'Failed to inspect schema migration ceiling before database writes',
    err,
  );
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
