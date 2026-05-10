import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadPolicy } from '../policy/loader.ts';
import { openDatabase, type StoreLogger } from '../store/connection.ts';
import { EventStore } from '../store/events.ts';
import { buildMetaAlertSinks } from '../transport/chain-builder.ts';
import type { Sink } from '../transport/types.ts';
import { runWatchdog, type WatchdogRunResult } from '../watchdog/runner.ts';

export interface WatchdogCommandDeps {
  write: (chunk: string) => void;
  now?: () => Date;
  logger?: StoreLogger;
  metaAlertSinks?: Sink[];
  runWatchdog?: ((input: WatchdogCommandInput) => Promise<WatchdogRunResult>) | undefined;
}

export interface WatchdogCommandInput {
  events: EventStore;
  metaAlertSinks: Sink[];
  thresholdHours: number;
  nowIso: string;
}

interface WatchdogOptions {
  stateDir: string;
  policy: string;
  now?: string;
  thresholdHours?: number;
}

type OptionResult<T> = { ok: true; value: T } | { ok: false; message: string };

const STATE_FILE = 'state.sqlite';
const WATCHDOG_USAGE = 'usage: whatsoup-guard watchdog --state-dir <dir> --policy <policy.yaml> [--now <iso>] [--threshold-hours <hours>]\n';

export async function watchdogCommand(args: string[], deps: WatchdogCommandDeps): Promise<number> {
  const parsed = parseWatchdogOptions(args);
  if (!parsed.ok) {
    deps.write(`${parsed.message}\n`);
    deps.write(WATCHDOG_USAGE);
    return 2;
  }

  try {
    const policy = loadPolicy(parsed.value.policy);
    return await runWatchdogCommand(parsed.value, deps, policy);
  } catch (error) {
    deps.write(`watchdog: ${safeErrorMessage(error)}\n`);
    return 1;
  }
}

async function runWatchdogCommand(
  options: WatchdogOptions,
  deps: WatchdogCommandDeps,
  policy: ReturnType<typeof loadPolicy>,
): Promise<number> {
  mkdirSync(options.stateDir, { recursive: true });
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    db = openDatabase(join(options.stateDir, STATE_FILE), {
      now: currentDate(deps),
      ...(deps.logger ? { logger: deps.logger } : {}),
    });
    const events = new EventStore(db, join(options.stateDir, 'events.jsonl'));
    const runner = deps.runWatchdog ?? runWatchdog;
    const result = await runner({
      events,
      metaAlertSinks: deps.metaAlertSinks ?? buildMetaAlertSinks(policy),
      thresholdHours: options.thresholdHours ?? 7,
      nowIso: options.now ?? currentDate(deps)().toISOString(),
    });
    deps.write(`alerts=${result.alerts} delivery_failed=${result.deliveryFailedCount}\n`);
    return result.alerts > 0 ? 1 : 0;
  } catch (error) {
    deps.write(`watchdog: ${safeErrorMessage(error)}\n`);
    return 1;
  } finally {
    db?.close();
  }
}

function parseWatchdogOptions(args: string[]): OptionResult<WatchdogOptions> {
  const values = new Map<string, string>();
  const allowed = new Set(['--state-dir', '--policy', '--now', '--threshold-hours']);

  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag || !allowed.has(flag)) {
      return { ok: false, message: `unknown option: ${flag ?? '<none>'}` };
    }
    if (value === undefined || value.startsWith('--')) {
      return { ok: false, message: `missing value for option: ${flag}` };
    }
    values.set(flag, value);
  }

  const stateDir = values.get('--state-dir') ?? '';
  const policy = values.get('--policy') ?? '';
  const now = values.get('--now');
  const thresholdHours = parseThresholdHours(values.get('--threshold-hours'));

  if (policy.trim().length === 0) return { ok: false, message: 'missing required option: --policy' };
  if (stateDir.trim().length === 0) return { ok: false, message: 'missing required option: --state-dir' };
  if (!thresholdHours.ok) return thresholdHours;

  return {
    ok: true,
    value: {
      stateDir,
      policy,
      ...(now === undefined ? {} : { now }),
      ...(thresholdHours.value === undefined ? {} : { thresholdHours: thresholdHours.value }),
    },
  };
}

function parseThresholdHours(value: string | undefined): OptionResult<number | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { ok: false, message: 'threshold-hours must be a positive number' };
  }
  return { ok: true, value: parsed };
}

function currentDate(deps: WatchdogCommandDeps): () => Date {
  return deps.now ?? (() => new Date());
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'operation failed';
}
