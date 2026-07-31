import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { tmpdir as systemTmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import {
  Database,
  DatabaseCompatibilityError,
  CURRENT_SCHEMA_MIGRATION,
} from '../../src/core/database.ts';
import {
  openDatabaseForStartup,
  startDatabaseCompatibilityHealthServer,
} from '../../src/core/database-compatibility-health.ts';
import {
  closeDatabaseCompatibilityHealthServer,
  DATABASE_COMPATIBILITY_PERMANENT_EXIT_STATUS,
  DatabaseCompatibilityPermanentStartupError,
  startupExitCode,
  runEarlyDatabaseCompatibilityGate,
  waitForDatabaseCompatibilityDrain,
} from '../../src/core/database-compatibility-early.ts';
import { configureDatabaseCompatibilityBootstrap } from '../../src/database-compatibility-config.ts';

function tmpdir(): string {
  return realpathSync(systemTmpdir());
}

async function waitForListening(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected TCP server address');
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
  });
}

describe('database compatibility health drain', () => {
  it('reports an actionable 503 without starting a timer', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const error = new DatabaseCompatibilityError(
      'future_schema',
      'future schema is not writable by this binary',
      undefined,
      CURRENT_SCHEMA_MIGRATION + 1,
    );
    const server = await startDatabaseCompatibilityHealthServer({
      error,
      instanceName: 'test-agent',
      startedAt: Date.now() - 5_000,
      port: 0,
    });
    try {
      const port = await waitForListening(server);
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        status: 'unhealthy',
        service_mode: 'inspection_only',
        startup_block: {
          code: 'future_schema',
          retryable: false,
          operator_action_required: true,
        },
        instance: { name: 'test-agent', mode: 'inspection_only' },
        whatsapp: {
          connected: false,
          account_jid: 'not connected',
          connection: { state: 'not_started' },
        },
        sqlite: {
          compatibility: 'future_schema',
          schema_ready: false,
          database_writes_allowed: false,
          sql_inspection_available: true,
          artifact_inspection_available: true,
          schema_migration_latest: CURRENT_SCHEMA_MIGRATION + 1,
          schema_migration_required: CURRENT_SCHEMA_MIGRATION,
        },
        admission: { provider_turns: 'blocked', synthetic_turns: 'blocked' },
        durability: null,
        runtime: { agent: { started: false, admission: 'blocked', reason: 'future_schema' } },
      });
      expect(setIntervalSpy).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
      setIntervalSpy.mockRestore();
    }
  });

  it.each([
    ['POST', '/send'],
    ['POST', '/schedule'],
    ['POST', '/agent/compact'],
    ['POST', '/heal'],
    ['POST', '/access'],
    ['POST', '/mark-read'],
    ['GET', '/typing'],
    ['GET', '/unknown'],
  ])('blocks %s %s while drained', async (method, path) => {
    const server = await startDatabaseCompatibilityHealthServer({
      error: new DatabaseCompatibilityError(
        'engine_recovery_required',
        'rollback journal recovery required',
      ),
      instanceName: 'test-agent',
      startedAt: Date.now(),
      port: 0,
    });
    try {
      const port = await waitForListening(server);
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { method });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: {
          code: 'INSPECTION_ONLY',
          message: 'instance is in inspection-only mode',
        },
      });
    } finally {
      await closeServer(server);
    }
  });

  it('rejects startup when the inspection health port cannot bind', async () => {
    const error = new DatabaseCompatibilityError('future_schema', 'future schema');
    const first = await startDatabaseCompatibilityHealthServer({
      error,
      instanceName: 'first',
      startedAt: Date.now(),
      port: 0,
    });
    try {
      const port = await waitForListening(first);
      await expect(startDatabaseCompatibilityHealthServer({
        error,
        instanceName: 'second',
        startedAt: Date.now(),
        port,
      })).rejects.toMatchObject({
        name: 'DatabaseCompatibilityPermanentStartupError',
        cause: { code: 'EADDRINUSE' },
      });
    } finally {
      await closeServer(first);
    }
  });

  it('maps permanent compatibility startup failures to the non-restarting service exit status', () => {
    const failure = new DatabaseCompatibilityPermanentStartupError(
      'database compatibility health port cannot bind',
      Object.assign(new Error('address in use'), { code: 'EADDRINUSE' }),
    );
    expect(startupExitCode(failure)).toBe(
      DATABASE_COMPATIBILITY_PERMANENT_EXIT_STATUS,
    );
    expect(startupExitCode(new Error('transient'))).toBe(1);
    expect(() => configureDatabaseCompatibilityBootstrap('../invalid')).toThrow(
      DatabaseCompatibilityPermanentStartupError,
    );

    const unit = readFileSync(new URL('../../deploy/whatsoup@.service', import.meta.url), 'utf8');
    expect(unit).toContain(
      `RestartPreventExitStatus=${DATABASE_COMPATIBILITY_PERMANENT_EXIT_STATUS}`,
    );
  });

  it('preserves the permanent bind classification when closing the rejected database also fails', async () => {
    const bindFailure = new DatabaseCompatibilityPermanentStartupError(
      'database compatibility health port cannot bind',
      Object.assign(new Error('address in use'), { code: 'EADDRINUSE' }),
    );
    const futureError = new DatabaseCompatibilityError('future_schema', 'future schema');
    const rejectedDb = {
      open: vi.fn(() => { throw futureError; }),
      close: vi.fn(() => { throw new Error('close failed'); }),
    };

    const failure = await openDatabaseForStartup({
      dbPath: '/tmp/future.db',
      instanceName: 'test-agent',
      startedAt: 1,
      createDatabase: () => rejectedDb as never,
      startDrainServer: async () => { throw bindFailure; },
    }).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(DatabaseCompatibilityPermanentStartupError);
    expect(startupExitCode(failure)).toBe(
      DATABASE_COMPATIBILITY_PERMANENT_EXIT_STATUS,
    );
  });

  it.each([
    { reason: 'invalid_schema', permanent: true, exitCode: 78 },
    { reason: 'unsafe_database_identity', permanent: true, exitCode: 78 },
    { reason: 'database_not_writable', permanent: true, exitCode: 78 },
    { reason: 'database_identity_changed', permanent: false, exitCode: 1 },
  ] as const)(
    'classifies $reason startup failures with exit status $exitCode',
    async ({ reason, permanent, exitCode }) => {
      const compatibilityError = new DatabaseCompatibilityError(
        reason,
        `${reason} startup failure`,
      );
      const rejectedDb = {
        open: vi.fn(() => { throw compatibilityError; }),
        close: vi.fn(),
      };
      const startDrain = vi.fn(async () => ({ close: vi.fn() } as unknown as Server));

      const failure = await openDatabaseForStartup({
        dbPath: '/tmp/rejected.db',
        instanceName: 'test-agent',
        startedAt: 1,
        createDatabase: () => rejectedDb as never,
        startDrainServer: startDrain,
      }).catch((err: unknown) => err);

      if (permanent) {
        expect(failure).toBeInstanceOf(DatabaseCompatibilityPermanentStartupError);
        expect((failure as DatabaseCompatibilityPermanentStartupError).cause).toBe(
          compatibilityError,
        );
      } else {
        expect(failure).toBe(compatibilityError);
      }
      expect(startupExitCode(failure)).toBe(exitCode);
      expect(startDrain).not.toHaveBeenCalled();
    },
  );

  it('rejects the drain wait if the health listener disappears unexpectedly', async () => {
    const server = await startDatabaseCompatibilityHealthServer({
      error: new DatabaseCompatibilityError('future_schema', 'future schema'),
      instanceName: 'test-agent',
      startedAt: Date.now(),
      port: 0,
    });
    const waiting = waitForDatabaseCompatibilityDrain(server);
    await closeServer(server);
    await expect(waiting).rejects.toThrow(/closed unexpectedly/i);
  });

  it('force-closes an active inspection request without waiting indefinitely', async () => {
    let observedRequest!: () => void;
    const requestObserved = new Promise<void>((resolve) => { observedRequest = resolve; });
    const server = createServer(() => {
      observedRequest();
      // Deliberately leave the response open to model a partial health request.
    });
    server.listen(0, '127.0.0.1');
    const port = await waitForListening(server);
    const client = request({ host: '127.0.0.1', port, path: '/health' });
    client.on('error', () => {});
    client.end();
    await requestObserved;

    await expect(closeDatabaseCompatibilityHealthServer(server, 100)).resolves.toBeUndefined();
    expect(server.listening).toBe(false);
    client.destroy();
  });

  it.each([
    'future_schema',
    'engine_recovery_required',
  ] as const)('returns a drained startup result for %s', async (reason) => {
    const drainServer = { close: vi.fn() } as unknown as Server;
    const startDrain = vi.fn(async () => drainServer);
    const compatibilityError = new DatabaseCompatibilityError(reason, `${reason} failure`);
    const drainedDb = {
      open: vi.fn(() => { throw compatibilityError; }),
      close: vi.fn(),
    };

    await expect(openDatabaseForStartup({
      dbPath: '/tmp/drained.db',
      instanceName: 'test-agent',
      startedAt: 1,
      createDatabase: () => drainedDb as never,
      startDrainServer: startDrain,
    })).resolves.toEqual({
      mode: 'drained',
      db: drainedDb,
      error: compatibilityError,
      server: drainServer,
    });
    expect(startDrain).toHaveBeenCalledTimes(1);
  });

  it('rethrows ordinary database open failures', async () => {
    const startDrain = vi.fn(async () => ({ close: vi.fn() } as unknown as Server));
    const ordinaryError = new Error('ordinary open failure');
    await expect(openDatabaseForStartup({
      dbPath: '/tmp/broken.db',
      instanceName: 'test-agent',
      startedAt: 1,
      createDatabase: () => ({ open: () => { throw ordinaryError; } }) as never,
      startDrainServer: startDrain,
    })).rejects.toThrow(ordinaryError);
  });

  it('classifies a real non-writable DELETE-mode writer as permanent and latches its fence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsoup-database-not-writable-'));
    const dbPath = join(dir, 'current.db');
    const initial = new Database(dbPath);
    initial.open();
    initial.close();
    const rollbackMode = new DatabaseSync(dbPath);
    rollbackMode.exec('PRAGMA journal_mode = DELETE');
    rollbackMode.close();

    const db = new Database(dbPath);
    const startDrain = vi.fn(async () => ({ close: vi.fn() } as unknown as Server));
    try {
      chmodSync(dbPath, 0o400);
      chmodSync(dir, 0o500);

      const failure = await openDatabaseForStartup({
        dbPath,
        instanceName: 'test-agent',
        startedAt: 1,
        createDatabase: () => db,
        startDrainServer: startDrain,
      }).catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(DatabaseCompatibilityPermanentStartupError);
      expect(failure).toMatchObject({
        cause: { reason: 'database_not_writable' },
      });
      expect(startupExitCode(failure)).toBe(78);
      expect(startDrain).not.toHaveBeenCalled();
      expect(() => db.assertWritableCompatibility()).toThrow(
        (failure as DatabaseCompatibilityPermanentStartupError).cause as Error,
      );
      expect(() => db.raw.exec('CREATE TABLE must_stay_blocked(id INTEGER)')).toThrow(
        /read.?only|closed|not open/i,
      );
    } finally {
      chmodSync(dir, 0o700);
      chmodSync(dbPath, 0o600);
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not create a missing database during the early import gate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsoup-early-database-gate-'));
    const previousConfig = process.env.INSTANCE_CONFIG;
    const dbPath = join(dir, 'data', 'bot.db');
    const lockPath = join(dir, 'state', 'whatsoup.lock');
    process.env.INSTANCE_CONFIG = JSON.stringify({
      name: 'test-agent',
      healthPort: 19090,
      paths: { dbPath, lockPath },
    });
    try {
      await expect(runEarlyDatabaseCompatibilityGate()).resolves.toBe(false);
      expect(existsSync(dbPath)).toBe(false);
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      if (previousConfig === undefined) delete process.env.INSTANCE_CONFIG;
      else process.env.INSTANCE_CONFIG = previousConfig;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a dangling database symlink through the production early gate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsoup-early-database-dangling-'));
    const previousConfig = process.env.INSTANCE_CONFIG;
    const targetPath = join(dir, 'target', 'created.db');
    const dbPath = join(dir, 'bot.db');
    const lockPath = join(dir, 'state', 'whatsoup.lock');
    symlinkSync(targetPath, dbPath);
    process.env.INSTANCE_CONFIG = JSON.stringify({
      name: 'test-agent',
      healthPort: 19090,
      paths: { dbPath, lockPath },
    });
    try {
      const failure = await runEarlyDatabaseCompatibilityGate().catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(DatabaseCompatibilityPermanentStartupError);
      expect(failure).toMatchObject({
        cause: expect.objectContaining({ reason: 'unsafe_database_identity' }),
      });
      expect(existsSync(targetPath)).toBe(false);
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      if (previousConfig === undefined) delete process.env.INSTANCE_CONFIG;
      else process.env.INSTANCE_CONFIG = previousConfig;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a missing database beneath a symlinked parent through the production early gate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsoup-early-database-parent-alias-'));
    const previousConfig = process.env.INSTANCE_CONFIG;
    const targetDir = join(dir, 'target');
    const targetPath = join(targetDir, 'created.db');
    const aliasDir = join(dir, 'alias');
    const dbPath = join(aliasDir, 'created.db');
    const lockPath = join(dir, 'state', 'whatsoup.lock');
    mkdirSync(targetDir);
    symlinkSync(targetDir, aliasDir);
    process.env.INSTANCE_CONFIG = JSON.stringify({
      name: 'test-agent',
      healthPort: 19090,
      paths: { dbPath, lockPath },
    });
    try {
      const failure = await runEarlyDatabaseCompatibilityGate().catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(DatabaseCompatibilityPermanentStartupError);
      expect(failure).toMatchObject({
        cause: expect.objectContaining({ reason: 'unsafe_database_identity' }),
      });
      expect(existsSync(targetPath)).toBe(false);
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      if (previousConfig === undefined) delete process.env.INSTANCE_CONFIG;
      else process.env.INSTANCE_CONFIG = previousConfig;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('acquires the cooperative process lock before the authoritative inspection', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsoup-early-database-lock-order-'));
    const previousConfig = process.env.INSTANCE_CONFIG;
    const dbPath = join(dir, 'data', 'bot.db');
    const lockPath = join(dir, 'state', 'whatsoup.lock');
    mkdirSync(join(dir, 'data'), { recursive: true, mode: 0o700 });
    writeFileSync(dbPath, 'placeholder');
    process.env.INSTANCE_CONFIG = JSON.stringify({
      name: 'test-agent',
      healthPort: 19090,
      paths: { dbPath, lockPath },
    });
    const order: string[] = [];
    const lock = { path: lockPath, pid: process.pid, token: 'test-lock' };
    try {
      await expect(runEarlyDatabaseCompatibilityGate({
        acquireLock: () => {
          order.push('lock');
          return lock;
        },
        inspect: () => {
          order.push('inspect');
          return { outcome: 'ready' };
        },
        releaseLock: () => {
          order.push('release');
          return true;
        },
      })).resolves.toBe(false);
      expect(order).toEqual(['lock', 'inspect', 'release']);
    } finally {
      if (previousConfig === undefined) delete process.env.INSTANCE_CONFIG;
      else process.env.INSTANCE_CONFIG = previousConfig;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('wraps a permanent authoritative inspection and releases the process lock', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsoup-early-database-permanent-'));
    const previousConfig = process.env.INSTANCE_CONFIG;
    const dbPath = join(dir, 'data', 'bot.db');
    const lockPath = join(dir, 'state', 'whatsoup.lock');
    process.env.INSTANCE_CONFIG = JSON.stringify({
      name: 'test-agent',
      healthPort: 19090,
      paths: { dbPath, lockPath },
    });
    const lock = { path: lockPath, pid: process.pid, token: 'test-lock' };
    const permanentError = new DatabaseCompatibilityError(
      'invalid_schema',
      'malformed migration ledger',
    );
    const startServer = vi.fn(async () => ({ listening: true }) as Server);
    const releaseLock = vi.fn(() => true);
    try {
      const failure = await runEarlyDatabaseCompatibilityGate({
        inspectPath: () => ({ canonicalPath: dbPath, device: 1n, inode: 1n, linkCount: 1n }),
        acquireLock: () => lock,
        inspect: () => ({ outcome: 'permanent', error: permanentError }),
        startServer,
        waitForDrain: async () => 'SIGTERM',
        closeServer: async () => {},
        releaseLock,
      }).catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(DatabaseCompatibilityPermanentStartupError);
      expect(failure).toMatchObject({ cause: permanentError });
      expect(startupExitCode(failure)).toBe(78);
      expect(startServer).not.toHaveBeenCalled();
      expect(releaseLock).toHaveBeenCalledOnce();
    } finally {
      if (previousConfig === undefined) delete process.env.INSTANCE_CONFIG;
      else process.env.INSTANCE_CONFIG = previousConfig;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws a transient authoritative inspection unchanged and releases the process lock', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsoup-early-database-transient-'));
    const previousConfig = process.env.INSTANCE_CONFIG;
    const dbPath = join(dir, 'data', 'bot.db');
    const lockPath = join(dir, 'state', 'whatsoup.lock');
    process.env.INSTANCE_CONFIG = JSON.stringify({
      name: 'test-agent',
      healthPort: 19090,
      paths: { dbPath, lockPath },
    });
    const lock = { path: lockPath, pid: process.pid, token: 'test-lock' };
    const transientError = new DatabaseCompatibilityError(
      'database_identity_changed',
      'database identity changed during inspection',
    );
    const startServer = vi.fn(async () => ({ listening: true }) as Server);
    const releaseLock = vi.fn(() => true);
    try {
      const failure = await runEarlyDatabaseCompatibilityGate({
        inspectPath: () => ({ canonicalPath: dbPath, device: 1n, inode: 1n, linkCount: 1n }),
        acquireLock: () => lock,
        inspect: () => ({ outcome: 'transient', error: transientError }),
        startServer,
        waitForDrain: async () => 'SIGTERM',
        closeServer: async () => {},
        releaseLock,
      }).catch((err: unknown) => err);

      expect(failure).toBe(transientError);
      expect(startupExitCode(failure)).toBe(1);
      expect(startServer).not.toHaveBeenCalled();
      expect(releaseLock).toHaveBeenCalledOnce();
    } finally {
      if (previousConfig === undefined) delete process.env.INSTANCE_CONFIG;
      else process.env.INSTANCE_CONFIG = previousConfig;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('releases the process lock even when forced health-server cleanup fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsoup-early-database-release-'));
    const previousConfig = process.env.INSTANCE_CONFIG;
    const dbPath = join(dir, 'data', 'bot.db');
    const lockPath = join(dir, 'state', 'whatsoup.lock');
    mkdirSync(join(dir, 'data'), { recursive: true, mode: 0o700 });
    writeFileSync(dbPath, 'placeholder');
    process.env.INSTANCE_CONFIG = JSON.stringify({
      name: 'test-agent',
      healthPort: 19090,
      paths: { dbPath, lockPath },
    });
    const order: string[] = [];
    const lock = { path: lockPath, pid: process.pid, token: 'test-lock' };
    const server = { listening: true } as Server;
    try {
      await expect(runEarlyDatabaseCompatibilityGate({
        acquireLock: () => lock,
        inspect: () => ({
          outcome: 'drained',
          error: {
            reason: 'future_schema',
            observedMigration: CURRENT_SCHEMA_MIGRATION + 1,
            requiredMigration: CURRENT_SCHEMA_MIGRATION,
          },
        }),
        startServer: async () => server,
        waitForDrain: async () => 'SIGTERM',
        closeServer: async () => {
          order.push('close');
          throw new Error('forced close failed');
        },
        releaseLock: () => {
          order.push('release');
          return true;
        },
      })).rejects.toThrow(/forced close failed/i);
      expect(order).toEqual(['close', 'release']);
    } finally {
      if (previousConfig === undefined) delete process.env.INSTANCE_CONFIG;
      else process.env.INSTANCE_CONFIG = previousConfig;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('derives the canonical database gate config without full config validation or tmp writes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsoup-minimal-database-config-'));
    const previous = {
      config: process.env.XDG_CONFIG_HOME,
      data: process.env.XDG_DATA_HOME,
      state: process.env.XDG_STATE_HOME,
      instance: process.env.INSTANCE_CONFIG,
    };
    process.env.XDG_CONFIG_HOME = join(dir, 'config');
    process.env.XDG_DATA_HOME = join(dir, 'data');
    process.env.XDG_STATE_HOME = join(dir, 'state');
    const configDir = join(dir, 'config', 'whatsoup', 'instances', 'test-agent');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), '{ malformed unrelated config');
    try {
      configureDatabaseCompatibilityBootstrap('test-agent');
      const configured = JSON.parse(process.env.INSTANCE_CONFIG ?? '{}') as {
        name?: string;
        healthPort?: number;
        paths?: { dbPath?: string; lockPath?: string; tmpDir?: string };
      };
      expect(configured).toMatchObject({
        name: 'test-agent',
        healthPort: 9090,
        paths: {
          dbPath: join(dir, 'data', 'whatsoup', 'instances', 'test-agent', 'bot.db'),
          lockPath: join(dir, 'state', 'whatsoup', 'instances', 'test-agent', 'whatsoup.lock'),
        },
      });
      expect(existsSync(configured.paths?.tmpDir ?? '')).toBe(false);
    } finally {
      if (previous.config === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previous.config;
      if (previous.data === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previous.data;
      if (previous.state === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previous.state;
      if (previous.instance === undefined) delete process.env.INSTANCE_CONFIG;
      else process.env.INSTANCE_CONFIG = previous.instance;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the compatibility gate before external readiness, recovery, runtime, and timers', () => {
    const mainSource = readFileSync(new URL('../../src/main.ts', import.meta.url), 'utf8');
    const gate = mainSource.indexOf('await openDatabaseForStartup({');
    expect(gate).toBeGreaterThanOrEqual(0);
    for (const laterOperation of [
      'getPineconeReadinessObservation(',
      'seedChatAliases(',
      'new DurabilityEngine(',
      'createConnection(',
      'new AgentRuntime(',
      'setInterval(',
    ]) {
      expect(mainSource.indexOf(laterOperation), laterOperation).toBeGreaterThan(gate);
    }
  });
});
