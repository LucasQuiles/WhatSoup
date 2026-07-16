import type { Server } from 'node:http';
import { createChildLogger } from '../logger.ts';
import {
  Database,
  DatabaseCompatibilityError,
  isDrainableDatabaseCompatibilityError,
} from './database.ts';
import {
  DatabaseCompatibilityPermanentStartupError,
  isDatabaseCompatibilityPermanentStartupError,
  startDatabaseCompatibilityHealthServer,
  type DatabaseCompatibilityHealthOptions,
} from './database-compatibility-early.ts';

export {
  startDatabaseCompatibilityHealthServer,
  type DatabaseCompatibilityHealthOptions,
} from './database-compatibility-early.ts';

const log = createChildLogger('database-compatibility-health');

type StartupDatabase = Pick<Database, 'open' | 'close'>;

function isPermanentDatabaseCompatibilityStartupError(
  err: unknown,
): err is DatabaseCompatibilityError {
  return err instanceof DatabaseCompatibilityError
    && (
      err.reason === 'invalid_schema'
      || err.reason === 'unsafe_database_identity'
      || err.reason === 'database_not_writable'
    );
}

export type DatabaseStartupResult =
  | { mode: 'ready'; db: Database }
  | {
      mode: 'drained';
      db: StartupDatabase | null;
      error: DatabaseCompatibilityError;
      server: Server;
    };

export async function openDatabaseForStartup(options: {
  dbPath: string;
  instanceName: string;
  startedAt: number;
  healthPort?: number;
  createDatabase?: (path: string) => StartupDatabase;
  startDrainServer?: (options: DatabaseCompatibilityHealthOptions) => Promise<Server>;
}): Promise<DatabaseStartupResult> {
  const createDatabase = options.createDatabase ?? ((path: string) => new Database(path));
  const startDrainServer = options.startDrainServer ?? startDatabaseCompatibilityHealthServer;
  let db: StartupDatabase | null = null;
  try {
    db = createDatabase(options.dbPath);
    db.open();
    return { mode: 'ready', db: db as Database };
  } catch (err) {
    if (isPermanentDatabaseCompatibilityStartupError(err)) {
      throw new DatabaseCompatibilityPermanentStartupError(err.message, err);
    }
    if (!isDrainableDatabaseCompatibilityError(err)) throw err;
    let server: Server;
    try {
      server = await startDrainServer({
        error: err,
        instanceName: options.instanceName,
        startedAt: options.startedAt,
        port: options.healthPort ?? 9090,
      });
    } catch (bindError) {
      try {
        db?.close();
      } catch (closeError) {
        const aggregate = new AggregateError(
          [bindError, closeError],
          'Database compatibility health bind failed and the inspection database could not close',
        );
        if (isDatabaseCompatibilityPermanentStartupError(bindError)) {
          throw new DatabaseCompatibilityPermanentStartupError(
            aggregate.message,
            aggregate,
          );
        }
        throw aggregate;
      }
      throw bindError;
    }
    log.error(
      { reason: err.reason, observedMigration: err.observedMigration },
      'database compatibility drain active; all runtime admission is blocked',
    );
    return { mode: 'drained', db, error: err, server };
  }
}
