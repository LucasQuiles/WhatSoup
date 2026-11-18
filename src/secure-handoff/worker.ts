import { DatabaseSync } from 'node:sqlite';
import { assertSchemaCeiling, sqliteFileUri } from '../core/database-compatibility.ts';
import { CURRENT_SCHEMA_MIGRATION } from '../core/database-schema-version.ts';
import type { ManagedSecretInputMetadata } from '../core/protected-delivery.ts';
import { type Clock, systemClock } from '../lib/clock.ts';
import { SQLITE_BUSY_TIMEOUT_MS } from '../lib/sqlite-constants.ts';
import { HttpManagedDeliveryClient } from '../core/managed-delivery-client.ts';
import { createChildLogger } from '../logger.ts';
import { createFixedHttpLoginAdapter, FixedIntakeConsumer, type FixedConsumerAdapter } from './consumer.ts';
import { createFixedHttpCredentialStore } from './credential-store.ts';
import { createFixedHttpMfaAdapter, createFixedHttpTokenAdapter } from './http-adapters.ts';
import {
  MANAGED_CONSUMER_TOKEN_ENV,
  MANAGED_TRANSPORT_TOKEN_ENV,
  parseSecureHandoffWorkerConfig,
  type FixedAdapterConfig,
  type FixedSaveStoreConfig,
  type SecureHandoffWorkerConfig,
} from './worker-config.ts';

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type RemoteIntakePort = Pick<HttpManagedDeliveryClient, 'getSecretInput'>;
type ConsumerPort = Pick<FixedIntakeConsumer, 'execute' | 'reconcileAmbiguous'>;

type WorkerLogger = {
  info(meta: Record<string, unknown>, message: string): unknown;
  warn(meta: Record<string, unknown>, message: string): unknown;
};

export type SecureHandoffWorker = Readonly<{
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Runs one bounded metadata scan. Concurrent calls share the same operation. */
  tick(): Promise<void>;
}>;

export type SecureHandoffWorkerOptions = Readonly<{
  config: unknown;
  environment: Readonly<Record<string, string | undefined>>;
  fetch?: FetchLike;
  clock?: Pick<Clock, 'now' | 'nowIso'>;
  logger?: WorkerLogger;
  transport?: RemoteIntakePort;
  consumer?: ConsumerPort;
}>;

type LocalIntake = Readonly<{
  id: number;
  intakeId: string;
  principal: string;
  resourceId: string;
  kind: 'password' | 'token' | 'mfa';
  action: string;
}>;

type LocalBatch = Readonly<{
  rows: readonly LocalIntake[];
  nextCursor: number | undefined;
}>;

const ACTIVE_LOCAL_STATES = ['awaiting_input', 'submitted', 'consuming'] as const;
const BATCH_LIMIT = 100;
const TERMINAL_CACHE_LIMIT = 1_000;

/**
 * A small service process for an administrator-owned adapter registry. It reads
 * only metadata locally; Links remains the durable, atomic consume fence.
 */
export function createSecureHandoffWorker(options: SecureHandoffWorkerOptions): SecureHandoffWorker {
  const config = parseSecureHandoffWorkerConfig(options.config);
  const transportToken = requiredEnvironment(options.environment, MANAGED_TRANSPORT_TOKEN_ENV);
  const consumerToken = requiredEnvironment(options.environment, MANAGED_CONSUMER_TOKEN_ENV);
  const fetchFn = options.fetch ?? fetch;
  const adapters = createAdapters(config, options.environment, fetchFn);
  const transport = options.transport ?? new HttpManagedDeliveryClient({ baseUrl: config.linksBaseUrl, token: transportToken, fetch: fetchFn });
  const consumer = options.consumer ?? new FixedIntakeConsumer({ baseUrl: config.linksBaseUrl, token: consumerToken, adapters, fetch: fetchFn });
  return new SecureHandoffWorkerRuntime(config, transport, consumer, options.clock ?? systemClock, options.logger ?? createChildLogger('secure-handoff-worker'));
}

class SecureHandoffWorkerRuntime implements SecureHandoffWorker {
  readonly #byResource = new Map<string, FixedAdapterConfig>();
  readonly #config: SecureHandoffWorkerConfig;
  readonly #transport: RemoteIntakePort;
  readonly #consumer: ConsumerPort;
  readonly #clock: Pick<Clock, 'now' | 'nowIso'>;
  readonly #logger: WorkerLogger;
  #database: DatabaseSync | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #active: Promise<void> | undefined;
  #stopOperation: Promise<void> | undefined;
  #stopping = false;
  #cursor: number | undefined;
  readonly #terminalIntakeBindings = new Map<string, string>();

  constructor(
    config: SecureHandoffWorkerConfig,
    transport: RemoteIntakePort,
    consumer: ConsumerPort,
    clock: Pick<Clock, 'now' | 'nowIso'>,
    logger: WorkerLogger,
  ) {
    this.#config = config;
    this.#transport = transport;
    this.#consumer = consumer;
    this.#clock = clock;
    this.#logger = logger;
    for (const adapter of config.adapters) this.#byResource.set(adapter.resourceId, adapter);
  }

  async start(): Promise<void> {
    if (this.#database) return;
    if (this.#stopping) throw new Error('secure handoff worker is stopping');
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(sqliteFileUri(this.#config.databasePath, 'ro'), {
        readOnly: true,
        timeout: SQLITE_BUSY_TIMEOUT_MS,
        enableForeignKeyConstraints: false,
      });
      validateDatabase(database, this.#config.databasePath);
    } catch {
      try {
        database?.close();
      } catch {
        // intentional: startup remains rejected even when a broken database cannot be closed cleanly.
      }
      throw new Error('secure handoff worker database is incompatible');
    }
    this.#database = database;
    this.#cursor = undefined;
    this.#terminalIntakeBindings.clear();
    this.#timer = setInterval(() => { this.#scheduleTick(); }, this.#config.pollIntervalMs);
    this.#logger.info({ adapterCount: this.#config.adapters.length }, 'secure handoff worker started');
    this.#scheduleTick();
  }

  stop(): Promise<void> {
    if (this.#stopOperation) return this.#stopOperation;
    if (!this.#database) return Promise.resolve();
    this.#stopping = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    const operation = this.#finishStop();
    this.#stopOperation = operation;
    return operation;
  }

  tick(): Promise<void> {
    if (!this.#database) return Promise.reject(new Error('secure handoff worker is not started'));
    if (this.#stopping) return Promise.reject(new Error('secure handoff worker is stopping'));
    if (this.#active) return this.#active;
    const operation = this.#runTick().finally(() => {
      if (this.#active === operation) this.#active = undefined;
    });
    this.#active = operation;
    return operation;
  }

  async #runTick(): Promise<void> {
    const batch = this.#readBatch();
    this.#cursor = batch.nextCursor;
    for (const row of batch.rows) await this.#process(row);
  }

  async #finishStop(): Promise<void> {
    try {
      await this.#active;
    } catch {
      // intentional: shutdown closes the read-only handle after a tick failure.
      this.#logger.warn({ phase: 'tick' }, 'secure handoff worker stopped after a failed tick');
    } finally {
      this.#database?.close();
      this.#database = undefined;
      this.#cursor = undefined;
      this.#terminalIntakeBindings.clear();
      this.#stopping = false;
      this.#stopOperation = undefined;
      this.#logger.info({}, 'secure handoff worker stopped');
    }
  }

  #scheduleTick(): void {
    void this.tick().catch(() => {
      this.#logger.warn({ phase: 'tick' }, 'secure handoff worker tick failed');
    });
  }

  #readBatch(): LocalBatch {
    const database = this.#database;
    if (!database) return { rows: [], nextCursor: undefined };
    const clauses = this.#config.adapters.map(() => '(principal=? AND resource_id=? AND kind=? AND action=?)');
    const parameters: Array<string | number> = [this.#clock.nowIso()];
    if (this.#cursor !== undefined) parameters.push(this.#cursor);
    for (const adapter of this.#config.adapters) parameters.push(adapter.principal, adapter.resourceId, adapter.kind, adapter.action);
    parameters.push(BATCH_LIMIT);
    const cursorClause = this.#cursor === undefined ? '' : ' AND id < ?';
    const stateParams = ACTIVE_LOCAL_STATES.map(() => '?').join(', ');
    const query = `SELECT id, intake_id, principal, resource_id, kind, action
      FROM protected_secret_inputs
      WHERE input_state IN (${stateParams})
        AND intake_id IS NOT NULL AND expires_at IS NOT NULL
        AND julianday(expires_at) > julianday(?)${cursorClause}
        AND (${clauses.join(' OR ')})
      ORDER BY id DESC LIMIT ?`;
    const values = [...ACTIVE_LOCAL_STATES, ...parameters];
    const rawRows = database.prepare(query).all(...values);
    const nextCursor = rawRows.length === BATCH_LIMIT ? sqliteRowId(rawRows.at(-1)) : undefined;
    if (rawRows.length === BATCH_LIMIT && nextCursor === undefined) {
      throw new Error('secure handoff worker database returned an invalid cursor');
    }
    return { rows: rawRows.flatMap(parseLocalIntake), nextCursor };
  }

  async #process(row: LocalIntake): Promise<void> {
    const binding = localBindingFingerprint(row);
    if (this.#terminalIntakeBindings.get(row.intakeId) === binding) return;
    const adapter = this.#byResource.get(row.resourceId);
    if (!adapter || row.principal !== adapter.principal || row.kind !== adapter.kind || row.action !== adapter.action) return;
    let remote: ManagedSecretInputMetadata;
    try {
      remote = await this.#transport.getSecretInput({ id: row.intakeId, principal: adapter.principal });
    } catch {
      this.#logger.warn(safeMetadata(row, 'status_unavailable'), 'secure handoff status was unavailable');
      return;
    }
    const expiresAt = Date.parse(remote.expiresAt);
    if (!matchesRemoteBinding(remote, row, adapter) || !Number.isFinite(expiresAt)) {
      this.#logger.warn(safeMetadata(row, 'binding_or_expiry'), 'secure handoff intake was rejected');
      return;
    }
    if (isTerminalState(remote.state)) {
      this.#rememberTerminal(row.intakeId, binding);
      return;
    }
    if (expiresAt <= this.#clock.now()) {
      this.#logger.warn(safeMetadata(row, 'binding_or_expiry'), 'secure handoff intake was rejected');
      return;
    }
    try {
      if (remote.state === 'submitted') await this.#consumer.execute({ intakeId: row.intakeId, resourceId: row.resourceId });
      if (remote.state === 'consuming') await this.#consumer.reconcileAmbiguous({ intakeId: row.intakeId, resourceId: row.resourceId });
    } catch {
      this.#logger.warn(safeMetadata(row, remote.state === 'submitted' ? 'consumer' : 'reconcile'), 'secure handoff operation is ambiguous');
    }
  }

  #rememberTerminal(intakeId: string, binding: string): void {
    this.#terminalIntakeBindings.set(intakeId, binding);
    if (this.#terminalIntakeBindings.size <= TERMINAL_CACHE_LIMIT) return;
    const oldest = this.#terminalIntakeBindings.keys().next().value;
    if (typeof oldest === 'string') this.#terminalIntakeBindings.delete(oldest);
  }
}

function createAdapters(
  config: SecureHandoffWorkerConfig,
  environment: Readonly<Record<string, string | undefined>>,
  fetchFn: FetchLike,
): FixedConsumerAdapter[] {
  return config.adapters.map((adapter) => {
    const store = adapter.kind === 'mfa' || adapter.saveStore === undefined
      ? undefined : createStore(adapter, adapter.saveStore, environment, fetchFn);
    if (adapter.kind === 'password') {
      return createFixedHttpLoginAdapter({
        resourceId: adapter.resourceId, principal: adapter.principal, action: adapter.action,
        endpoint: adapter.endpoint, username: adapter.username, ...(store === undefined ? {} : { store }),
        ...(adapter.mfaTransition === undefined ? {} : { mfaTransition: adapter.mfaTransition }), fetch: fetchFn,
      });
    }
    if (adapter.kind === 'token') {
      return createFixedHttpTokenAdapter({
        resourceId: adapter.resourceId, principal: adapter.principal, action: adapter.action,
        endpoint: adapter.endpoint, ...(store === undefined ? {} : { store }), fetch: fetchFn,
      });
    }
    const mfaOptions = {
      resourceId: adapter.resourceId, principal: adapter.principal, action: adapter.action,
      endpoint: adapter.endpoint, username: adapter.username, fetch: fetchFn,
    };
    return createFixedHttpMfaAdapter('operationMode' in adapter
      ? { ...mfaOptions, operationMode: adapter.operationMode }
      : { ...mfaOptions, mfaOperationId: adapter.operationId });
  });
}

function createStore(
  adapter: Exclude<FixedAdapterConfig, { kind: 'mfa' }>,
  store: FixedSaveStoreConfig,
  environment: Readonly<Record<string, string | undefined>>,
  fetchFn: FetchLike,
) {
  return createFixedHttpCredentialStore({
    name: store.name, resourceId: adapter.resourceId, principal: adapter.principal, action: adapter.action,
    endpoint: store.endpoint, authorization: requiredEnvironment(environment, store.authorizationEnv), fetch: fetchFn,
  });
}

function requiredEnvironment(environment: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = environment[name];
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || /[\u0000-\u001F\u007F]/.test(value)) {
    throw new Error('secure handoff worker credentials are invalid');
  }
  return value;
}

export function validateDatabase(database: DatabaseSync, databasePath: string): void {
  assertSchemaCeiling(database, databasePath);
  const migration = database.prepare('SELECT 1 AS ok FROM schema_migrations WHERE version = ? LIMIT 1')
    .get(CURRENT_SCHEMA_MIGRATION) as { ok?: unknown } | undefined;
  if (migration?.ok !== 1) throw new Error('database has not applied the current schema migration of this binary');
  database.prepare(`SELECT id, intake_id, principal, resource_id, kind, action
    FROM protected_secret_inputs
    WHERE input_state IN ('awaiting_input', 'submitted', 'consuming')
      AND intake_id IS NOT NULL AND expires_at IS NOT NULL
    LIMIT 0`).all();
}

function parseLocalIntake(value: unknown): LocalIntake[] {
  if (!isLocalRow(value)) return [];
  return [{ id: value.id, intakeId: value.intake_id, principal: value.principal, resourceId: value.resource_id, kind: value.kind, action: value.action }];
}

function sqliteRowId(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const id = (value as Record<string, unknown>).id;
  return typeof id === 'number' && Number.isSafeInteger(id) ? id : undefined;
}

function localBindingFingerprint(row: LocalIntake): string {
  return `${row.principal}\u0000${row.resourceId}\u0000${row.kind}\u0000${row.action}`;
}

function isLocalRow(value: unknown): value is {
  id: number; intake_id: string; principal: string; resource_id: string; kind: 'password' | 'token' | 'mfa'; action: string;
} {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return Number.isSafeInteger(row.id) && typeof row.intake_id === 'string' && /^[A-Za-z0-9_-]{22}$/.test(row.intake_id)
    && typeof row.principal === 'string' && typeof row.resource_id === 'string'
    && (row.kind === 'password' || row.kind === 'token' || row.kind === 'mfa') && typeof row.action === 'string';
}

function matchesRemoteBinding(remote: ManagedSecretInputMetadata, row: LocalIntake, adapter: FixedAdapterConfig): boolean {
  return remote.id === row.intakeId && remote.resourceId === adapter.resourceId && remote.kind === adapter.kind
    && remote.action === adapter.action && matchesConfiguredAccount(remote, adapter);
}

function matchesConfiguredAccount(remote: ManagedSecretInputMetadata, adapter: FixedAdapterConfig): boolean {
  if (adapter.kind === 'password' && adapter.mfaTransition !== undefined) {
    return remote.accountLabel === adapter.mfaTransition.account;
  }
  if (adapter.kind === 'mfa' && 'operationMode' in adapter && adapter.operationMode === 'links_registered') {
    return remote.accountLabel === adapter.account;
  }
  return true;
}

function isTerminalState(state: ManagedSecretInputMetadata['state']): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'expired' || state === 'revoked'
    || state === 'ambiguous' || state === 'cancelled';
}

function safeMetadata(row: LocalIntake, phase: string): Record<string, unknown> {
  return { intakeId: row.intakeId, resourceId: row.resourceId, phase };
}

export type { SecureHandoffWorkerConfig } from './worker-config.ts';
