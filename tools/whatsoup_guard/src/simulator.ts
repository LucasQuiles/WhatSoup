import type { Database as SqliteDatabase } from 'better-sqlite3';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FixtureCollector } from './collector/fixture.ts';
import { canonicalize } from './canonical.ts';
import { driftRule } from './evaluator/canonical-rules.ts';
import type { Evaluator } from './evaluator/types.ts';
import { runCycle, type RunCycleArgs, type RunCycleResult } from './runner.ts';
import { BaselineStore } from './store/baseline.ts';
import { openDatabase } from './store/connection.ts';
import { EventStore } from './store/events.ts';
import { MuteStore } from './store/mutes.ts';
import { RuntimeStateStore } from './store/state.ts';
import type { Sink } from './transport/types.ts';
import { EventKind, type EventKind as EventKindType, type Severity } from './types.ts';

export const SIMULATOR_SCENARIOS = [
  'clean',
  'drift',
  'muted-drift',
  'dedup',
  'dedup-escalation',
  'crit-storm',
  'alert-fallthrough',
  'watchdog-heartbeat',
  'transport-broken',
  'self-secret-widened',
] as const;

export type SimulatorScenario = (typeof SIMULATOR_SCENARIOS)[number];

export interface SimulatorInput {
  stateDir: string;
  scenario?: SimulatorScenario;
  fixture: {
    /** Maps "<probe_id>/<scope_id>" -> baseline fields. */
    baselines: Record<string, Record<string, unknown>>;
    /** Maps "<probe_id>/<scope_id>" -> observed fields. */
    observations: Record<string, Record<string, unknown>>;
  };
  now: string;
}

export interface SimulatorResult {
  drifts: number;
  probeErrors: number;
  totalEvents: number;
  deliverySucceededCount: number;
  deliveryFailedCount: number;
  dedupSuppressedCount: number;
  stormSuppressedCount: number;
  selfSecretWidenedCount: number;
  tokenAgingCount: number;
  heartbeatCount: number;
  eventKinds: EventKindType[];
}

interface FixtureEntry {
  probeId: string;
  scopeId: string;
  fields: Record<string, unknown>;
}

const SIMULATOR_HMAC_KEY = Buffer.from('whatsoup-guard-simulator-hmac-key-v1', 'utf8');
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

export async function runSimulator(input: SimulatorInput): Promise<SimulatorResult> {
  const now = parseNow(input.now);
  const capturedAt = now.toISOString();
  const scenario = input.scenario ?? 'drift';
  const baselines = parseFixtureEntries('baselines', input.fixture.baselines);
  const observations = parseFixtureEntries('observations', input.fixture.observations);

  mkdirSync(input.stateDir, { recursive: true });

  let db: SqliteDatabase | undefined;
  try {
    const nowClock = () => new Date(now.getTime());
    db = openDatabase(join(input.stateDir, 'simulator.sqlite'), { now: nowClock });
    const baselineStore = new BaselineStore(db, SIMULATOR_HMAC_KEY);
    const eventStore = new EventStore(db, join(input.stateDir, 'events.jsonl'));
    const muteStore = new MuteStore(db, { now: nowClock, events: eventStore });
    const runtimeState = new RuntimeStateStore(db);

    seedBaselines(baselineStore, baselines, capturedAt);
    seedScenarioState(scenario, input.stateDir, muteStore, now);

    const result = await runScenario({
      scenario,
      collectors: buildCollectors(observations, capturedAt),
      scopes: uniqueSorted(observations.map((entry) => entry.scopeId)),
      baselines: baselineStore,
      events: eventStore,
      mutes: muteStore,
      runtimeState,
      now: nowClock,
      stateDir: input.stateDir,
    });

    return summarizeResult(result, eventStore);
  } finally {
    db?.close();
  }
}

interface RunScenarioInput {
  scenario: SimulatorScenario;
  collectors: FixtureCollector[];
  scopes: string[];
  baselines: BaselineStore;
  events: EventStore;
  mutes: MuteStore;
  runtimeState: RuntimeStateStore;
  now: () => Date;
  stateDir: string;
}

async function runScenario(input: RunScenarioInput): Promise<RunCycleResult> {
  const args: RunCycleArgs = {
    collectors: input.collectors,
    scopes: input.scopes,
    baselines: input.baselines,
    events: input.events,
    mutes: input.mutes,
    runtimeState: input.runtimeState,
    evaluatorFor: () => evaluatorForScenario(input.scenario),
    now: input.now,
  };
  const sinks = sinksForScenario(input.scenario);
  if (sinks) args.sinks = sinks;
  const selfSecrets = selfSecretsForScenario(input.scenario, input.stateDir);
  if (selfSecrets) args.selfSecrets = selfSecrets;

  if (input.scenario === 'dedup' || input.scenario === 'crit-storm') {
    await runCycle(args);
    return runCycle(args);
  }
  if (input.scenario === 'dedup-escalation') {
    const highArgs = {
      ...args,
      sinks: [memorySink('whatsoup', true)],
      evaluatorFor: () => evaluatorWithSeverity('high'),
    };
    await runCycle(highArgs);
    await runCycle(highArgs);
    return runCycle({
      ...highArgs,
      evaluatorFor: () => evaluatorWithSeverity('crit'),
    });
  }

  return runCycle(args);
}

function summarizeResult(result: RunCycleResult, events: EventStore): SimulatorResult {
  return {
    drifts: result.driftCount,
    probeErrors: result.probeErrorCount,
    totalEvents: result.totalEventCount,
    deliverySucceededCount: result.deliverySucceededCount,
    deliveryFailedCount: result.deliveryFailedCount,
    dedupSuppressedCount: result.dedupSuppressedCount,
    stormSuppressedCount: result.stormSuppressedCount,
    selfSecretWidenedCount: result.selfSecretWidenedCount,
    tokenAgingCount: result.tokenAgingCount,
    heartbeatCount: result.heartbeatCount,
    eventKinds: eventKinds(events),
  };
}

function seedScenarioState(scenario: SimulatorScenario, stateDir: string, mutes: MuteStore, now: Date): void {
  if (scenario === 'muted-drift') {
    mutes.create({
      host: 'scope-a',
      domain: 'exposure',
      expires_at: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
      reason: 'simulator scenario',
      created_by: 'simulator',
    });
  }

  if (scenario === 'self-secret-widened') {
    const path = join(stateDir, 'simulator-hmac.key');
    writeFileSync(path, 'simulator-secret-metadata-only');
    chmodSync(path, 0o644);
  }
}

function sinksForScenario(scenario: SimulatorScenario): Sink[] | undefined {
  switch (scenario) {
    case 'dedup':
    case 'crit-storm':
      return [memorySink('whatsoup', true)];
    case 'alert-fallthrough':
      return [memorySink('whatsoup', false), memorySink('external-push', true)];
    case 'transport-broken':
      return [memorySink('whatsoup', false)];
    default:
      return undefined;
  }
}

function selfSecretsForScenario(scenario: SimulatorScenario, stateDir: string) {
  if (scenario !== 'self-secret-widened') return undefined;
  return [{ path: join(stateDir, 'simulator-hmac.key'), mode: 0o600 }];
}

function memorySink(name: string, ok: boolean): Sink {
  return {
    name,
    isDurableLog: false,
    async deliver() {
      return ok ? { ok: true, channel: name } : { ok: false, channel: name, error: 'simulated failure' };
    },
  };
}

function eventKinds(events: EventStore): EventKindType[] {
  return EventKind.options.filter((kind) => events.queryByKind(kind).length > 0);
}

function severityForScenario(scenario: SimulatorScenario): Severity {
  return scenario === 'crit-storm' ? 'crit' : 'high';
}

function evaluatorForScenario(scenario: SimulatorScenario): Evaluator {
  return evaluatorWithSeverity(severityForScenario(scenario));
}

function evaluatorWithSeverity(severity: Severity): Evaluator {
  return (ctx) => driftRule({
    observed: ctx.observed,
    baseline: ctx.baseline,
    severity,
    domain: 'exposure',
  });
}

function parseNow(value: string): Date {
  if (!ISO_TIMESTAMP_PATTERN.test(value)) {
    throw new Error('simulator now must be a valid ISO timestamp');
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error('simulator now must be a valid ISO timestamp');
  }
  return new Date(parsed);
}

function parseFixtureEntries(
  label: 'baselines' | 'observations',
  fixtures: Record<string, Record<string, unknown>>,
): FixtureEntry[] {
  return Object.entries(fixtures).map(([key, fields]) => {
    const [probeId, scopeId] = parseFixtureKey(key, label);
    canonicalize(fields);
    return { probeId, scopeId, fields };
  });
}

function parseFixtureKey(key: string, label: 'baselines' | 'observations'): [string, string] {
  const parts = key.split('/');
  if (parts.length !== 2) {
    throw new Error(`fixture key must have exactly one "/" in ${label}`);
  }
  const [probeId, scopeId] = parts;
  if (!probeId || !scopeId) {
    throw new Error(`fixture key must include non-empty probe and scope ids in ${label}`);
  }
  return [probeId, scopeId];
}

function seedBaselines(store: BaselineStore, baselines: FixtureEntry[], capturedAt: string): void {
  for (const entry of baselines) {
    store.set({
      probe_id: entry.probeId,
      scope_id: entry.scopeId,
      expected_doc: canonicalize(entry.fields),
      captured_at: capturedAt,
      captured_by: 'simulator',
    });
  }
}

function buildCollectors(observations: FixtureEntry[], capturedAt: string): FixtureCollector[] {
  const docsByProbe = new Map<string, Record<string, { fields: Record<string, unknown>; captured_at: string }>>();
  for (const entry of observations) {
    const docs = docsByProbe.get(entry.probeId) ?? {};
    docs[entry.scopeId] = { fields: entry.fields, captured_at: capturedAt };
    docsByProbe.set(entry.probeId, docs);
  }

  return [...docsByProbe.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, docs]) => new FixtureCollector({ id, docs }));
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
