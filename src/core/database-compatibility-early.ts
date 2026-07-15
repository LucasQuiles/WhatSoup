import { existsSync, mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  acquireProcessLock,
  releaseProcessLock,
  type ProcessLockHandle,
} from '../lib/process-lock.ts';
import {
  assertDatabaseIdentity,
  assertSchemaCeiling,
  databaseRecoveryCompatibilityError,
  DatabaseCompatibilityError,
  inspectDatabaseIdentity,
  inspectDatabasePathBeforeCreate,
  sqliteFileUri,
  type DatabaseCompatibilityReason,
} from './database-compatibility.ts';

export const DATABASE_COMPATIBILITY_PERMANENT_EXIT_STATUS = 78;

export class DatabaseCompatibilityPermanentStartupError extends Error {
  override readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'DatabaseCompatibilityPermanentStartupError';
    this.cause = cause;
  }
}

export function isDatabaseCompatibilityPermanentStartupError(
  err: unknown,
): err is DatabaseCompatibilityPermanentStartupError {
  return err instanceof DatabaseCompatibilityPermanentStartupError;
}

export function databaseCompatibilityStartupExitCode(err: unknown): 1 | 78 {
  return isDatabaseCompatibilityPermanentStartupError(err)
    ? DATABASE_COMPATIBILITY_PERMANENT_EXIT_STATUS
    : 1;
}

export type DrainableDatabaseCompatibilityReason =
  | 'future_schema'
  | 'engine_recovery_required';

export type DatabaseCompatibilityStatus = {
  reason: DrainableDatabaseCompatibilityReason;
  observedMigration: number | null;
  requiredMigration: number;
};

export type DatabaseCompatibilityBootstrapInspection =
  | { outcome: 'ready' }
  | { outcome: 'drained'; error: DatabaseCompatibilityStatus }
  | { outcome: 'permanent'; error: DatabaseCompatibilityError }
  | { outcome: 'transient'; error: Error };

export type DatabaseCompatibilityHealthOptions = {
  error: DatabaseCompatibilityStatus;
  instanceName: string;
  startedAt: number;
  port: number;
};

function transientBootstrapError(err: unknown): Error {
  return err instanceof Error
    ? err
    : new Error('Database compatibility inspection failed', { cause: err });
}

function classifyBootstrapInspectionError(
  err: unknown,
): Exclude<DatabaseCompatibilityBootstrapInspection, { outcome: 'ready' }> {
  if (!(err instanceof DatabaseCompatibilityError)) {
    return { outcome: 'transient', error: transientBootstrapError(err) };
  }
  const reason: DatabaseCompatibilityReason = err.reason;
  switch (reason) {
    case 'future_schema':
    case 'engine_recovery_required':
      return {
        outcome: 'drained',
        error: {
          reason,
          observedMigration: err.observedMigration,
          requiredMigration: err.requiredMigration,
        },
      };
    case 'invalid_schema':
    case 'unsafe_database_identity':
    case 'database_not_writable':
      return { outcome: 'permanent', error: err };
    case 'database_identity_changed':
      return { outcome: 'transient', error: err };
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

export function inspectExistingDatabaseForBootstrap(
  dbPath: string,
): DatabaseCompatibilityBootstrapInspection {
  let db: DatabaseSync | null = null;
  let inspection: DatabaseCompatibilityBootstrapInspection;
  try {
    const expectedIdentity = inspectDatabasePathBeforeCreate(dbPath);
    if (!expectedIdentity) return { outcome: 'ready' };
    db = new DatabaseSync(sqliteFileUri(expectedIdentity.canonicalPath, 'ro'), {
      readOnly: true,
      timeout: 5000,
      enableForeignKeyConstraints: false,
    });
    assertDatabaseIdentity(db, dbPath, expectedIdentity);
    assertSchemaCeiling(db, dbPath);
    assertDatabaseIdentity(db, dbPath, expectedIdentity);
    inspection = { outcome: 'ready' };
  } catch (err) {
    inspection = classifyBootstrapInspectionError(
      databaseRecoveryCompatibilityError(dbPath, err) ?? err,
    );
  }

  if (db) {
    try {
      db.close();
    } catch (err) {
      inspection = classifyBootstrapInspectionError(err);
    }
  }
  return inspection;
}

function writeJson(
  response: import('node:http').ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

export function startDatabaseCompatibilityHealthServer(
  options: DatabaseCompatibilityHealthOptions,
): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      const compatibility = options.error.reason;
      writeJson(response, 503, {
        status: 'unhealthy',
        service_mode: 'inspection_only',
        generated_at: new Date().toISOString(),
        uptime_seconds: Math.max(0, Math.floor((Date.now() - options.startedAt) / 1000)),
        startup_block: { code: compatibility, retryable: false, operator_action_required: true },
        instance: {
          name: options.instanceName,
          pid: process.pid,
          mode: 'inspection_only',
          socket_path: null,
          commit: process.env.WHATSOUP_GIT_SHA ?? null,
          branch: process.env.WHATSOUP_GIT_BRANCH ?? null,
        },
        whatsapp: {
          connected: false,
          account_jid: 'not connected',
          connection: {
            state: 'not_started',
            reconnect_phase: null,
            reconnect_attempts: 0,
            last_disconnect_reason: 'startup_schema_gate',
            last_status_code: null,
            auth_failure_class: 'none',
          },
        },
        sqlite: {
          compatibility,
          schema_ready: false,
          database_writes_allowed: false,
          sql_inspection_available: compatibility === 'future_schema',
          artifact_inspection_available: true,
          schema_migration_latest: options.error.observedMigration,
          schema_migration_required: options.error.requiredMigration,
        },
        admission: { provider_turns: 'blocked', synthetic_turns: 'blocked' },
        durability: null,
        runtime: { agent: { started: false, admission: 'blocked', reason: compatibility } },
      });
      return;
    }
    writeJson(response, 503, {
      ok: false,
      error: { code: 'INSPECTION_ONLY', message: 'instance is in inspection-only mode' },
    });
  });

  return new Promise<Server>((resolvePromise, reject) => {
    const onStartupError = (err: Error): void => {
      server.off('error', onStartupError);
      server.off('listening', onListening);
      const code = (err as NodeJS.ErrnoException).code;
      if (
        code === 'EADDRINUSE'
        || code === 'EACCES'
        || code === 'EADDRNOTAVAIL'
        || code === 'ERR_SOCKET_BAD_PORT'
      ) {
        reject(new DatabaseCompatibilityPermanentStartupError(
          `database compatibility health server cannot bind port ${options.port}`,
          err,
        ));
        return;
      }
      reject(err);
    };
    const onListening = (): void => {
      server.off('error', onStartupError);
      resolvePromise(server);
    };
    server.once('error', onStartupError);
    server.once('listening', onListening);
    try {
      server.listen(options.port, '127.0.0.1');
    } catch (err) {
      onStartupError(err as Error);
    }
  });
}

export type DatabaseCompatibilityDrainSignal = 'SIGINT' | 'SIGTERM';

export async function closeDatabaseCompatibilityHealthServer(
  server: Server,
  timeoutMs = 2_000,
): Promise<void> {
  if (!server.listening) {
    server.closeAllConnections();
    return;
  }
  await new Promise<void>((resolvePromise, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolvePromise();
    };
    timer = setTimeout(() => {
      try {
        server.closeAllConnections();
      } catch (err) {
        finish(err as Error);
        return;
      }
      if (server.listening) {
        finish(new Error('database compatibility health server did not close before the deadline'));
      } else {
        finish();
      }
    }, timeoutMs);
    timer.unref();
    try {
      // Stop accepting first, then terminate active/partial inspection requests.
      server.close((err) => finish(err ?? undefined));
      server.closeAllConnections();
    } catch (err) {
      finish(err as Error);
    }
  });
}

export function waitForDatabaseCompatibilityDrain(
  server: Server,
): Promise<DatabaseCompatibilityDrainSignal> {
  return new Promise<DatabaseCompatibilityDrainSignal>((resolvePromise, reject) => {
    const cleanup = (): void => {
      process.off('SIGINT', stopSigint);
      process.off('SIGTERM', stopSigterm);
      server.off('error', fail);
      server.off('close', closedUnexpectedly);
    };
    const stop = (signal: DatabaseCompatibilityDrainSignal): void => {
      cleanup();
      resolvePromise(signal);
    };
    const stopSigint = (): void => stop('SIGINT');
    const stopSigterm = (): void => stop('SIGTERM');
    const fail = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const closedUnexpectedly = (): void => {
      cleanup();
      reject(new Error('database compatibility health server closed unexpectedly'));
    };
    process.once('SIGINT', stopSigint);
    process.once('SIGTERM', stopSigterm);
    server.once('error', fail);
    server.once('close', closedUnexpectedly);
  });
}

type BootstrapInstanceConfig = {
  name?: unknown;
  healthPort?: unknown;
  paths?: { dbPath?: unknown; lockPath?: unknown };
};

export type EarlyDatabaseCompatibilityGateDependencies = {
  databaseExists?: (path: string) => boolean;
  inspect?: typeof inspectExistingDatabaseForBootstrap;
  acquireLock?: (path: string) => ProcessLockHandle;
  releaseLock?: (lock: ProcessLockHandle) => boolean;
  startServer?: typeof startDatabaseCompatibilityHealthServer;
  waitForDrain?: typeof waitForDatabaseCompatibilityDrain;
  closeServer?: typeof closeDatabaseCompatibilityHealthServer;
};

export async function runEarlyDatabaseCompatibilityGate(
  dependencies: EarlyDatabaseCompatibilityGateDependencies = {},
): Promise<boolean> {
  const encoded = process.env.INSTANCE_CONFIG;
  if (!encoded) throw new Error('INSTANCE_CONFIG is required before the database compatibility gate');
  const instance = JSON.parse(encoded) as BootstrapInstanceConfig;
  const dbPath = instance.paths?.dbPath;
  const lockPath = instance.paths?.lockPath;
  const instanceName = instance.name;
  const healthPort = instance.healthPort;
  if (
    typeof dbPath !== 'string'
    || typeof lockPath !== 'string'
    || typeof instanceName !== 'string'
    || (healthPort !== undefined && (!Number.isInteger(healthPort) || (healthPort as number) <= 0))
  ) {
    throw new Error('INSTANCE_CONFIG is missing canonical database gate fields');
  }

  const databaseExists = dependencies.databaseExists ?? existsSync;
  if (!databaseExists(dbPath)) return false;

  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const lock = (dependencies.acquireLock ?? acquireProcessLock)(lockPath);
  const inspect = dependencies.inspect ?? inspectExistingDatabaseForBootstrap;
  const releaseLock = dependencies.releaseLock ?? releaseProcessLock;
  const startServer = dependencies.startServer ?? startDatabaseCompatibilityHealthServer;
  const waitForDrain = dependencies.waitForDrain ?? waitForDatabaseCompatibilityDrain;
  const closeServer = dependencies.closeServer ?? closeDatabaseCompatibilityHealthServer;
  let server: Server | null = null;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    releaseLock(lock);
  };
  process.once('exit', release);
  try {
    // This is the authoritative inspection. The advisory wrapper check is
    // intentionally repeated only after the cooperative writer lock is held.
    const inspection = inspect(dbPath);
    if (inspection.outcome === 'ready') return false;
    if (inspection.outcome === 'permanent') {
      throw new DatabaseCompatibilityPermanentStartupError(
        inspection.error.message,
        inspection.error,
      );
    }
    if (inspection.outcome === 'transient') throw inspection.error;
    server = await startServer({
      error: inspection.error,
      instanceName,
      startedAt: Date.now(),
      port: typeof healthPort === 'number' ? healthPort : 9090,
    });
    await waitForDrain(server);
  } finally {
    try {
      if (server) await closeServer(server);
    } finally {
      process.off('exit', release);
      release();
    }
  }
  return true;
}
