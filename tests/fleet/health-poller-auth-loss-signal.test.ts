/**
 * #1786 / P2: HealthPoller writes the durable `auth_loss_signal` latch into the
 * TARGET INSTANCE's own persistent, migrated SQLite DB — not into the fleet
 * server's throwaway `:memory:` handle.
 *
 * Production-faithful fixture (the fixture-vs-prod divergence that hid the bug):
 *  - the instance DB is a real on-disk file, migrated via `core/database.ts`'s
 *    `Database.open()` (same path production instances use — includes
 *    migration 33, which creates `auth_loss_signal`), then closed so the
 *    poller's own `FleetDbReader.queryWrite` opens its own writable handle —
 *    exactly as `db-reader.ts:200` / `index.ts:645` already do for LID sync.
 *  - the fleet server's own "self" db is a bare, unmigrated `DatabaseSync(':memory:')`
 *    — this mirrors `standalone.ts:16` (`new DatabaseSync(':memory:')`), the exact
 *    production binding PR #2023 fed straight into `AuthLossSignalStore`.
 *
 * A prior version of this test constructed `AuthLossSignalStore` directly against
 * a pre-migrated `Database` wrapper handed straight to the poller — that shortcut
 * bypassed `deps.db`/`FleetDbReader` entirely and hid the bug PR #2023 introduced
 * (writes landing in `:memory:`, silently swallowed). This version drives the
 * poller exactly the way production wires it (a `FleetDbReader` whose `queryWrite`
 * opens the instance's own `dbPath`) and asserts against the instance's own on-disk
 * DB — proven RED against the pre-fix `AuthLossSignalStore(deps.db)` binding before
 * the fix landed (see git history / PR description for the captured RED output).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { realpathSync, unlinkSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const alertFns = vi.hoisted(() => ({
  emitAlert: vi.fn(() => ({ ok: true, channel: 'outbox', status: 'durably_queued' })),
  clearAlertSource: vi.fn(() => true),
}));
const alertThrottleStore = vi.hoisted(() => ({
  loadAlertThrottle: vi.fn(() => new Map<string, string>()),
  loadAlertThrottleDetailed: vi.fn(() => ({ entries: new Map<string, string>(), loadError: null })),
  recordAlertThrottle: vi.fn(),
}));
const silenceManager = vi.hoisted(() => ({ isInstanceSilenced: vi.fn(() => false) }));

vi.mock('../../src/lib/emit-alert.ts', () => ({
  ...alertFns,
  emitAlertChecked: alertFns.emitAlert,
  emitObservationChecked: vi.fn(() => true),
  clearAlertSourceChecked: alertFns.clearAlertSource,
}));
vi.mock('../../src/fleet/alert-throttle-store.ts', () => ({
  ALERT_THROTTLE_INTERVAL_MS: 15 * 60 * 1_000,
  ...alertThrottleStore,
}));
vi.mock('../../src/fleet/silence-manager.ts', () => silenceManager);
vi.mock('../../src/logger.ts', async () => {
  const { singletonLoggerMock } = await import('../helpers/logger-mock.ts');
  const logger = singletonLoggerMock();
  return { createChildLogger: () => logger };
});

import { createChildLogger } from '../../src/logger.ts';
import type { singletonLoggerMock } from '../helpers/logger-mock.ts';
const logger = createChildLogger('health-poller') as unknown as ReturnType<typeof singletonLoggerMock>;

import { HealthPoller, type InstanceHealth } from '../../src/fleet/health-poller.ts';
import { FleetDbReader } from '../../src/fleet/db-reader.ts';
import { Database } from '../../src/core/database.ts';
import { AuthLossSignalStore } from '../../src/fleet/auth-loss-signal-store.ts';

function tmpFile(): string {
  return join(realpathSync(tmpdir()), `whatsoup-authloss-p2-${randomBytes(8).toString('hex')}.db`);
}

function cleanupDbFile(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const full = path + suffix;
    if (existsSync(full)) {
      try {
        unlinkSync(full);
      } catch {
        /* ignore */
      }
    }
  }
}

/** Health body that classifies as a confirmed `logged_out` (explicit 401 + loggedOut). */
function loggedOutBody(): Record<string, unknown> {
  return {
    status: 'unhealthy',
    whatsapp: {
      connected: false,
      connection: {
        state: 'disconnected',
        last_status_code: 401,
        last_disconnect_reason: 'loggedOut',
        reconnect_phase: 'backoff',
        reconnect_attempts: 0,
      },
    },
  };
}

function onlineSelf(): Record<string, unknown> {
  return {
    status: 'healthy',
    generated_at: new Date().toISOString(),
    whatsapp: {
      connected: true,
      account_jid: 'self@s.whatsapp.net',
      connection: { state: 'connected', reconnect_phase: null, reconnect_attempts: 0, auth_failure_class: 'none' },
    },
  };
}

/** Read active (unresolved) auth_loss_signal rows straight from the instance's own DB file. */
function activeInstanceRows(
  dbPath: string,
): Array<{ instance: string; classifier: string; reason: string; confidence: string }> {
  const raw = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return raw
      .prepare('SELECT instance, classifier, reason, confidence FROM auth_loss_signal WHERE resolved_at IS NULL')
      .all() as Array<{ instance: string; classifier: string; reason: string; confidence: string }>;
  } finally {
    raw.close();
  }
}

/** Healthy remote body that also satisfies the stable-authenticated-open sample contract. */
function healthyRemoteBody(): Record<string, unknown> {
  return {
    status: 'healthy',
    generated_at: new Date().toISOString(),
    whatsapp: {
      connected: true,
      account_jid: 'remote@s.whatsapp.net',
      connection: {
        state: 'connected',
        reconnect_phase: null,
        reconnect_attempts: 0,
        auth_failure_class: 'none',
        recent_disconnects: { count: 0 },
      },
    },
  };
}

/** Resolved auth_loss_signal rows straight from the instance's own DB file. */
function resolvedInstanceRows(
  dbPath: string,
): Array<{ classifier: string; resolved_reason: string | null }> {
  const raw = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return raw
      .prepare('SELECT classifier, resolved_reason FROM auth_loss_signal WHERE resolved_at IS NOT NULL ORDER BY classifier')
      .all() as Array<{ classifier: string; resolved_reason: string | null }>;
  } finally {
    raw.close();
  }
}

const SELF = 'self';
const REMOTE = 'remote-1';

function remoteInstances(instanceDbPath: string): Map<string, InstanceHealth> {
  return new Map<string, InstanceHealth>([
    [SELF, { name: SELF, type: 'agent', accessMode: 'allowlist', healthPort: 9000, dbPath: '', healthToken: null }],
    [REMOTE, { name: REMOTE, type: 'chat', accessMode: 'open', healthPort: 9100, dbPath: instanceDbPath, healthToken: null }],
  ]);
}

describe("HealthPoller durable auth-loss signal — writes into the instance's own persistent DB (#1786 P2)", () => {
  let instanceDbPath: string;
  let dbReader: FleetDbReader;
  let mockFetch: ReturnType<typeof vi.fn>;
  let poller: HealthPoller;

  beforeEach(() => {
    instanceDbPath = tmpFile();
    // Seed a real, migrated, on-disk instance DB — same construction path production
    // uses (Database.open() runs every migration up to CURRENT_SCHEMA_MIGRATION,
    // including migration 33 which creates `auth_loss_signal`) — then close it so the
    // poller path under test opens its OWN writable connection against `dbPath`,
    // exactly as `FleetDbReader.queryWrite` does for a real remote instance.
    const seed = new Database(instanceDbPath);
    seed.open();
    seed.close();

    // Production binding under test: the fleet server's own "self" db is a bare,
    // unmigrated :memory: — mirrors standalone.ts:16 / index.ts's `deps.db`. The
    // durable writer must NEVER target this handle for a remote instance; it must
    // resolve dbPath from the instance itself and open its OWN connection there
    // (FleetDbReader.queryWrite — the seam already used for cross-instance LID sync).
    const fleetSelfDb = new DatabaseSync(':memory:');
    dbReader = new FleetDbReader(SELF, fleetSelfDb);

    mockFetch = vi.fn();
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-20T12:00:00.000Z'));
  });

  afterEach(() => {
    poller?.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    cleanupDbFile(instanceDbPath);
  });

  it('records a durable auth_loss_signal row in the INSTANCE db for a remote confirmed logged_out', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(loggedOutBody()) });

    poller = new HealthPoller(() => remoteInstances(instanceDbPath), SELF, () => onlineSelf(), 5_000, undefined, dbReader);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    const rows = activeInstanceRows(instanceDbPath);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      instance: REMOTE,
      classifier: 'logged_out',
      reason: 'explicit_auth_loss',
      confidence: 'confirmed',
    });
  });

  it('is idempotent — a second identical logged_out poll keeps exactly one active row in the instance db', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(loggedOutBody()) });

    poller = new HealthPoller(() => remoteInstances(instanceDbPath), SELF, () => onlineSelf(), 5_000, undefined, dbReader);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000); // second poll, same de-linked state

    expect(activeInstanceRows(instanceDbPath)).toHaveLength(1);
  });

  it('does nothing when no dbReader is injected (backward compatible)', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(loggedOutBody()) });

    poller = new HealthPoller(() => remoteInstances(instanceDbPath), SELF, () => onlineSelf(), 5_000);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(activeInstanceRows(instanceDbPath)).toHaveLength(0);
  });

  it('fails closed — logs loudly (never silently swallows) when the write target lacks the migrated table', async () => {
    // Self-path: classifyHealthSnapshot's logged_out branch routes through
    // recordDurableAuthLoss → writeDurableAuthLoss(selfName, ...). dbReader.queryWrite
    // shortcuts name===selfName straight to the fleet server's own selfDb — a bare,
    // unmigrated :memory: with no auth_loss_signal table. This must log at warn with
    // the instance name, dbPath, and underlying error — never throw, never be silent.
    poller = new HealthPoller(() => remoteInstances(instanceDbPath), SELF, () => loggedOutBody(), 5_000, undefined, dbReader);

    await expect(poller.start()).resolves.not.toThrow();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        name: SELF,
        error: expect.stringContaining('no such table'),
      }),
      'failed to record durable auth-loss signal (#1786)',
    );
  });

  it('resolves a previous run\'s unresolved rows (both classifiers) only after a stable authenticated window — a bare reconnect is not enough (#1786 resolution)', async () => {
    // Rows persisted by a PREVIOUS fleet process: this process never observes
    // the loss condition, so recordAuthLoss never runs — discovery must find
    // the rows from the DB alone.
    const seed = new Database(instanceDbPath);
    seed.open();
    const store = new AuthLossSignalStore(seed.raw);
    store.record({ instance: REMOTE, host: SELF, classifier: 'logged_out', reason: 'explicit_auth_loss', confidence: 'confirmed', observedAt: '2026-05-19T00:00:00.000Z' });
    store.record({ instance: REMOTE, host: SELF, classifier: 'weak_logged_out_signal', reason: 'weak_signal_persisted', confidence: 'inferred', observedAt: '2026-05-19T00:00:00.000Z' });
    seed.close();

    mockFetch.mockImplementation(() => Promise.resolve({ ok: true, json: () => Promise.resolve(healthyRemoteBody()) }));

    // quietDwellSeconds 20 with 5s polls and tolerance 1 -> 3 required samples,
    // window elapsed at the t=20s sample.
    poller = new HealthPoller(() => remoteInstances(instanceDbPath), SELF, () => onlineSelf(), 5_000, undefined, dbReader, undefined, undefined, 20);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    // Bare reconnect: one healthy poll must NOT resolve anything.
    expect(activeInstanceRows(instanceDbPath)).toHaveLength(2);

    for (let i = 0; i < 4; i += 1) {
      await vi.advanceTimersByTimeAsync(5_000);
    }

    expect(activeInstanceRows(instanceDbPath)).toHaveLength(0);
    expect(resolvedInstanceRows(instanceDbPath)).toEqual([
      { classifier: 'logged_out', resolved_reason: 'stable_authenticated_open' },
      { classifier: 'weak_logged_out_signal', resolved_reason: 'stable_authenticated_open' },
    ]);
  });

  it('holds an unresolved row open when recovery samples are contradicted mid-window (fail-closed)', async () => {
    const seed = new Database(instanceDbPath);
    seed.open();
    new AuthLossSignalStore(seed.raw).record({ instance: REMOTE, host: SELF, classifier: 'logged_out', reason: 'explicit_auth_loss', confidence: 'confirmed', observedAt: '2026-05-19T00:00:00.000Z' });
    seed.close();

    // Healthy polls interleaved with a degraded one: the contradicting sample
    // resets the quiet window, so the same elapsed time must NOT resolve.
    let call = 0;
    mockFetch.mockImplementation(() => {
      call += 1;
      const body = call === 3
        ? { ...healthyRemoteBody(), whatsapp: { ...healthyRemoteBody().whatsapp as Record<string, unknown>, connected: false } }
        : healthyRemoteBody();
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
    });

    poller = new HealthPoller(() => remoteInstances(instanceDbPath), SELF, () => onlineSelf(), 5_000, undefined, dbReader, undefined, undefined, 20);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 4; i += 1) {
      await vi.advanceTimersByTimeAsync(5_000);
    }

    expect(activeInstanceRows(instanceDbPath)).toHaveLength(1);
  });
});
