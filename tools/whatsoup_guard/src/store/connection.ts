import Database from 'better-sqlite3';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { basename } from 'node:path';
import { MIGRATIONS } from './migrations.ts';

type MigrationList = ReadonlyArray<string>;
type LogLevel = 'info' | 'error';
type LogPayload = Record<string, string | number>;

export interface StoreLogger {
  info?: (payload: LogPayload, message?: string) => void;
  error?: (payload: LogPayload, message?: string) => void;
}

export interface OpenDatabaseOptions {
  logger?: StoreLogger;
  now?: () => Date;
}

interface PathContext {
  path_class: 'memory' | 'file';
  db_name: string;
}

function safeDatabaseName(file: string): string {
  return file === ':memory:' ? ':memory:' : basename(file);
}

function isMemoryDatabase(file: string): boolean {
  return file === ':memory:';
}

function pathContext(file: string): PathContext {
  return {
    path_class: isMemoryDatabase(file) ? 'memory' : 'file',
    db_name: safeDatabaseName(file),
  };
}

function emit(logger: StoreLogger | undefined, level: LogLevel, payload: LogPayload, message: string): void {
  logger?.[level]?.({ component: 'store.connection', ...payload }, message);
}

function configureDatabase(db: SqliteDatabase, file: string): void {
  db.pragma('foreign_keys = ON');
  if (!isMemoryDatabase(file)) {
    db.pragma('journal_mode = WAL');
    // The same state file is opened by multiple processes (cli/cycle, cli/cycle-runtime,
    // cli/mute). Without a busy timeout a concurrent writer fails immediately with
    // SQLITE_BUSY; wait-and-retry instead, matching the main runtime DB (5000ms).
    db.pragma('busy_timeout = 5000');
  }
}

function applyMigrations(db: SqliteDatabase, migrations: MigrationList, now: () => Date): number {
  const schemaMigrationDdl = MIGRATIONS[0];
  if (!schemaMigrationDdl) throw new Error('schema migration bootstrap missing');

  let appliedCount = 0;
  const migrate = db.transaction(() => {
    db.prepare(schemaMigrationDdl).run();
    const applied = new Set(
      db
        .prepare('SELECT version FROM schema_migrations')
        .all()
        .map((row) => (row as { version: number }).version),
    );
    const insertVersion = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)');

    for (const [index, statement] of migrations.entries()) {
      const version = index + 1;
      if (applied.has(version)) continue;
      db.prepare(statement).run();
      insertVersion.run(version, now().toISOString());
      appliedCount += 1;
    }
  });

  migrate();
  return appliedCount;
}

export function openDatabase(file: string, options: OpenDatabaseOptions = {}): SqliteDatabase {
  return openDatabaseWithMigrations(file, MIGRATIONS, options);
}

export function openDatabaseWithMigrations(
  file: string,
  migrations: MigrationList,
  options: OpenDatabaseOptions = {},
): SqliteDatabase {
  let db: SqliteDatabase;
  const context = pathContext(file);
  const now = options.now ?? (() => new Date());

  emit(options.logger, 'info', { event: 'database_open_start', ...context }, 'opening protection-layer database');
  try {
    db = new Database(file);
  } catch (error) {
    emit(options.logger, 'error', { event: 'database_open_failed', ...context }, 'protection-layer database open failed');
    throw new Error(`database open failed for ${context.db_name}`, { cause: error });
  }

  try {
    configureDatabase(db, file);
    emit(
      options.logger,
      'info',
      { event: 'database_migration_start', ...context, migration_count: migrations.length },
      'applying protection-layer database migrations',
    );
    const appliedCount = applyMigrations(db, migrations, now);
    emit(
      options.logger,
      'info',
      { event: 'database_migration_succeeded', ...context, applied_count: appliedCount },
      'protection-layer database migrations applied',
    );
    emit(options.logger, 'info', { event: 'database_open_succeeded', ...context }, 'protection-layer database ready');
    return db;
  } catch (error) {
    emit(
      options.logger,
      'error',
      { event: 'database_migration_failed', ...context },
      'protection-layer database migration failed',
    );
    db.close();
    throw new Error(`database migration failed for ${context.db_name}`, { cause: error });
  }
}
