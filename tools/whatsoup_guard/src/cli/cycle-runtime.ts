import type { Database as SqliteDatabase } from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FixtureCollector } from '../collector/fixture.ts';
import type { FixtureDoc } from '../collector/fixture.ts';
import type { Collector } from '../collector/types.ts';
import type { Evaluator } from '../evaluator/types.ts';
import { loadKey } from '../hmac.ts';
import { runCycle as runProtectionCycle, type RunCycleResult } from '../runner.ts';
import { BaselineStore } from '../store/baseline.ts';
import { openDatabase, type StoreLogger } from '../store/connection.ts';
import { EventStore } from '../store/events.ts';
import { MuteStore } from '../store/mutes.ts';
import { RuntimeStateStore } from '../store/state.ts';
import { buildAlertChain, buildMetaAlertSinks } from '../transport/chain-builder.ts';
import type { CycleRunInput } from './cycle.ts';

const STATE_FILE = 'state.sqlite';
const EVENT_LEDGER_FILE = 'events.jsonl';
const BASELINE_HMAC_KEY_FILE = 'baseline-hmac.key';
const BASELINE_HMAC_KEY_ENV = 'WHATSOUP_GUARD_BASELINE_HMAC_KEY_FILE';
const SOURCE_CHANGE_COLLECTOR_IDS = new Set(['fixture.change']);

export interface CycleRuntimeOptions {
  logger?: StoreLogger;
  now?: () => Date;
}

export async function runCycleRuntime(
  input: CycleRunInput,
  options: CycleRuntimeOptions = {},
): Promise<RunCycleResult> {
  mkdirSync(input.stateDir, { recursive: true });
  let db: SqliteDatabase | undefined;
  const now = options.now ?? (() => new Date());

  try {
    db = openDatabase(join(input.stateDir, STATE_FILE), {
      now,
      ...(options.logger ? { logger: options.logger } : {}),
    });
    const events = new EventStore(db, join(input.stateDir, EVENT_LEDGER_FILE));
    const mutes = new MuteStore(db, {
      now,
      events,
      forbiddenDomains: input.runtimeConfig.forbiddenMuteDomains,
    });
    const baselines = new BaselineStore(
      db,
      loadBaselineKey(input.stateDir),
      options.logger ? { logger: options.logger } : {},
    );

    const baseArgs = {
      baselines,
      events,
      mutes,
      runtimeState: new RuntimeStateStore(db),
      evaluatorFor: noOpEvaluatorFor,
      deploymentRoles: input.policy.deployment_roles,
      runtimeConfig: input.runtimeConfig,
      now,
      sinks: buildAlertChain(input.policy, { stateDir: input.stateDir, now }),
      metaAlertSinks: buildMetaAlertSinks(input.policy),
    };

    let aggregate = emptyRunCycleResult();
    for (const group of hostCollectorGroups(input)) {
      const result = await runProtectionCycle({
        ...baseArgs,
        collectors: group.collectors,
        scopes: group.scopes,
        changeProbeIds: changeProbeIdsFor(group.collectors),
        appendHeartbeat: false,
      });
      aggregate = addRunCycleResult(aggregate, result);
    }
    return appendCycleHeartbeat(events, now, aggregate);
  } finally {
    db?.close();
  }
}

interface HostCollectorGroup {
  collectors: Collector[];
  scopes: string[];
}

interface PolicyHostCollectorGroup {
  collectorIds: string[];
  scopes: string[];
  fixtureDocs: Map<string, Record<string, FixtureDoc>>;
}

function hostCollectorGroups(input: CycleRunInput): HostCollectorGroup[] {
  if (input.policy.inventory.hosts.length === 0) return [{ collectors: [], scopes: [] }];

  const groups = new Map<string, PolicyHostCollectorGroup>();
  for (const host of input.policy.inventory.hosts) {
    const collectorIds = [...host.collectors].sort((left, right) => left.localeCompare(right));
    const key = collectorIds.join('\0');
    const group: PolicyHostCollectorGroup = groups.get(key) ?? {
      collectorIds,
      scopes: [],
      fixtureDocs: new Map<string, Record<string, FixtureDoc>>(),
    };
    group.scopes.push(host.id);
    for (const collectorId of collectorIds) {
      const fixture = host.fixture_docs?.[collectorId];
      if (!fixture) continue;
      const docs = group.fixtureDocs.get(collectorId) ?? {};
      docs[host.id] = fixture;
      group.fixtureDocs.set(collectorId, docs);
    }
    groups.set(key, group);
  }

  return [...groups.values()].map((group) => ({
    collectors: group.collectorIds.map((id) => new FixtureCollector({ id, docs: group.fixtureDocs.get(id) ?? {} })),
    scopes: group.scopes.sort((left, right) => left.localeCompare(right)),
  }));
}

function changeProbeIdsFor(collectors: Collector[]): string[] {
  return collectors
    .map((collector) => collector.id)
    .filter((id) => SOURCE_CHANGE_COLLECTOR_IDS.has(id));
}

function loadBaselineKey(stateDir: string): Buffer {
  const envPath = process.env[BASELINE_HMAC_KEY_ENV];
  if (envPath && envPath.trim().length > 0) return loadKey(envPath);

  const path = join(stateDir, BASELINE_HMAC_KEY_FILE);
  if (existsSync(path)) return loadKey(path);

  try {
    writeFileSync(path, randomBytes(32), { flag: 'wx', mode: 0o400 });
    chmodSync(path, 0o400);
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
  }

  return loadKey(path);
}

function emptyRunCycleResult(): RunCycleResult {
  return {
    driftCount: 0,
    probeErrorCount: 0,
    totalEventCount: 0,
    deliverySucceededCount: 0,
    deliveryFailedCount: 0,
    dedupSuppressedCount: 0,
    stormSuppressedCount: 0,
    baselineIntegrityFailCount: 0,
    selfSecretWidenedCount: 0,
    tokenAgingCount: 0,
    heartbeatCount: 0,
  };
}

function addRunCycleResult(left: RunCycleResult, right: RunCycleResult): RunCycleResult {
  return {
    driftCount: left.driftCount + right.driftCount,
    probeErrorCount: left.probeErrorCount + right.probeErrorCount,
    totalEventCount: left.totalEventCount + right.totalEventCount,
    deliverySucceededCount: left.deliverySucceededCount + right.deliverySucceededCount,
    deliveryFailedCount: left.deliveryFailedCount + right.deliveryFailedCount,
    dedupSuppressedCount: left.dedupSuppressedCount + right.dedupSuppressedCount,
    stormSuppressedCount: left.stormSuppressedCount + right.stormSuppressedCount,
    baselineIntegrityFailCount: left.baselineIntegrityFailCount + right.baselineIntegrityFailCount,
    selfSecretWidenedCount: left.selfSecretWidenedCount + right.selfSecretWidenedCount,
    tokenAgingCount: left.tokenAgingCount + right.tokenAgingCount,
    heartbeatCount: left.heartbeatCount + right.heartbeatCount,
  };
}

function appendCycleHeartbeat(events: EventStore, now: () => Date, result: RunCycleResult): RunCycleResult {
  events.append({
    ts: now().toISOString(),
    kind: 'heartbeat',
    domain: 'alerting',
    severity: 'info',
    payload: {
      status: 'cycle_complete',
      drift_count: result.driftCount,
      probe_error_count: result.probeErrorCount,
      delivery_succeeded_count: result.deliverySucceededCount,
      delivery_failed_count: result.deliveryFailedCount,
      dedup_suppressed_count: result.dedupSuppressedCount,
      storm_suppressed_count: result.stormSuppressedCount,
      baseline_integrity_fail_count: result.baselineIntegrityFailCount,
      self_secret_widened_count: result.selfSecretWidenedCount,
      token_aging_count: result.tokenAgingCount,
    },
    alerted_to: 'none',
  });

  return {
    ...result,
    totalEventCount: result.totalEventCount + 1,
    heartbeatCount: result.heartbeatCount + 1,
  };
}

function noOpEvaluatorFor(_collectorId: string): Evaluator {
  return () => [];
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}
