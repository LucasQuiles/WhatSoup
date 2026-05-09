import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RunCycleResult } from '../runner.ts';
import { loadPolicy } from '../policy/loader.ts';
import { buildRuntimeConfig, type RuntimePolicyConfig } from '../policy/runtime.ts';
import type { Policy } from '../policy/schema.ts';
import { openDatabase, type StoreLogger } from '../store/connection.ts';
import { EventStore } from '../store/events.ts';

export interface CycleRunInput {
  policyPath: string;
  policy: Policy;
  runtimeConfig: RuntimePolicyConfig;
  stateDir: string;
}

export interface CycleDeps {
  write: (chunk: string) => void;
  runCycle?: ((input: CycleRunInput) => Promise<RunCycleResult>) | undefined;
  logger?: StoreLogger;
}

export async function cycleCommand(args: string[], deps: CycleDeps): Promise<number> {
  const parsed = parseCycleOptions(args);
  if (!parsed.ok) {
    deps.write(`${parsed.message}\n`);
    deps.write(CYCLE_USAGE);
    return 2;
  }

  if (!deps.runCycle) {
    deps.write('cycle: runtime dependency missing\n');
    deps.write(CYCLE_USAGE);
    return 2;
  }

  let result: RunCycleResult;
  try {
    const policy = loadPolicy(parsed.value.policyPath);
    result = await deps.runCycle({
      policyPath: parsed.value.policyPath,
      policy,
      runtimeConfig: buildRuntimeConfig(policy),
      stateDir: parsed.value.stateDir,
    });
  } catch (error) {
    const message = safeErrorMessage(error);
    const ledgerError = appendCycleFailed(parsed.value.stateDir, message, deps.logger);
    deps.write(`cycle: ${message}\n`);
    if (ledgerError) deps.write(`cycle: failed to write cycle_failed: ${ledgerError}\n`);
    return 1;
  }
  if (parsed.value.json) {
    deps.write(`${JSON.stringify(formatCycleJsonResult(result))}\n`);
  } else {
    deps.write([
      `drifts=${result.driftCount}`,
      `probe_errors=${result.probeErrorCount}`,
      `total=${result.totalEventCount}`,
      `delivery_failed=${result.deliveryFailedCount}`,
      `baseline_integrity_fail=${result.baselineIntegrityFailCount}`,
      `token_aging=${result.tokenAgingCount}`,
      `self_secret_widened=${result.selfSecretWidenedCount}`,
    ].join(' ') + '\n');
  }

  return hasActionableResult(result) ? 1 : 0;
}

function appendCycleFailed(stateDir: string, message: string, logger: StoreLogger | undefined): string | undefined {
  mkdirSync(stateDir, { recursive: true });
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    db = openDatabase(join(stateDir, 'state.sqlite'), logger ? { logger } : {});
    const events = new EventStore(db, join(stateDir, 'events.jsonl'));
    events.append({
      ts: new Date().toISOString(),
      kind: 'cycle_failed',
      domain: 'alerting',
      severity: 'crit',
      payload: {
        error: message,
      },
      alerted_to: 'none',
    });
    return undefined;
  } catch (error) {
    return safeErrorMessage(error);
  } finally {
    db?.close();
  }
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'operation failed';
}

function formatCycleJsonResult(result: RunCycleResult): Record<string, number> {
  return {
    drift_count: result.driftCount,
    probe_error_count: result.probeErrorCount,
    total_event_count: result.totalEventCount,
    delivery_succeeded_count: result.deliverySucceededCount,
    delivery_failed_count: result.deliveryFailedCount,
    dedup_suppressed_count: result.dedupSuppressedCount,
    storm_suppressed_count: result.stormSuppressedCount,
    baseline_integrity_fail_count: result.baselineIntegrityFailCount,
    token_aging_count: result.tokenAgingCount,
    self_secret_widened_count: result.selfSecretWidenedCount,
    heartbeat_count: result.heartbeatCount,
  };
}

interface CycleOptions {
  json: boolean;
  policyPath: string;
  stateDir: string;
}

type OptionResult<T> = { ok: true; value: T } | { ok: false; message: string };

const CYCLE_USAGE = 'usage: whatsoup-guard cycle --policy <policy.yaml> --state-dir <dir> [--json]\n';

function parseCycleOptions(args: string[]): OptionResult<CycleOptions> {
  const values = new Map<string, string>();
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--json') {
      json = true;
      continue;
    }
    if (flag !== '--policy' && flag !== '--state-dir') {
      return { ok: false, message: `cycle: unknown argument ${flag ?? '<none>'}` };
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      return { ok: false, message: `missing value for option: ${flag}` };
    }
    values.set(flag, value);
    index += 1;
  }

  const policyPath = values.get('--policy') ?? '';
  const stateDir = values.get('--state-dir') ?? '';
  if (policyPath.trim().length === 0) return { ok: false, message: 'missing required option: --policy' };
  if (stateDir.trim().length === 0) return { ok: false, message: 'missing required option: --state-dir' };
  return { ok: true, value: { json, policyPath, stateDir } };
}

function hasActionableResult(result: RunCycleResult): boolean {
  return result.driftCount > 0
    || result.probeErrorCount > 0
    || result.deliveryFailedCount > 0
    || result.baselineIntegrityFailCount > 0
    || result.tokenAgingCount > 0
    || result.selfSecretWidenedCount > 0;
}
