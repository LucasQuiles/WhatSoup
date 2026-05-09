import { readFileSync } from 'node:fs';
import { SIMULATOR_SCENARIOS, runSimulator, type SimulatorInput, type SimulatorScenario } from '../simulator.ts';

export interface SimulateCommandDeps {
  write: (chunk: string) => void;
  now?: () => Date;
}

interface SimulateOptions {
  stateDir: string;
  fixture: string;
  now?: string;
  scenario?: SimulatorScenario;
}

type OptionResult<T> = { ok: true; value: T } | { ok: false; message: string };

const SIMULATE_USAGE = 'usage: whatsoup-guard simulate --state-dir <dir> --fixture <fixture.json> [--scenario <name>] [--now <iso>]\n';

export async function simulateCommand(args: string[], deps: SimulateCommandDeps): Promise<number> {
  const parsed = parseSimulateOptions(args);
  if (!parsed.ok) {
    deps.write(`${parsed.message}\n`);
    deps.write(SIMULATE_USAGE);
    return 2;
  }

  const fixture = readFixture(parsed.value.fixture);
  if (!fixture.ok) {
    deps.write(`simulate: ${fixture.message}\n`);
    return 1;
  }

  try {
    const result = await runSimulator({
      stateDir: parsed.value.stateDir,
      fixture: fixture.value,
      now: parsed.value.now ?? currentIso(deps),
      ...(parsed.value.scenario ? { scenario: parsed.value.scenario } : {}),
    });
    const prefix = parsed.value.scenario ? `scenario=${parsed.value.scenario} ` : '';
    deps.write(`${prefix}drifts=${result.drifts} probe_errors=${result.probeErrors} total=${result.totalEvents}\n`);
    return 0;
  } catch (error) {
    deps.write(`simulate: ${safeErrorMessage(error)}\n`);
    return 1;
  }
}

function parseSimulateOptions(args: string[]): OptionResult<SimulateOptions> {
  const values = new Map<string, string>();
  const allowed = new Set(['--state-dir', '--fixture', '--scenario', '--now']);

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
  const fixture = values.get('--fixture') ?? '';
  const scenario = values.get('--scenario');
  const now = values.get('--now');

  if (stateDir.trim().length === 0) return { ok: false, message: 'missing required option: --state-dir' };
  if (fixture.trim().length === 0) return { ok: false, message: 'missing required option: --fixture' };
  if (scenario !== undefined && !isSimulatorScenario(scenario)) {
    return { ok: false, message: `unknown simulator scenario: ${scenario}` };
  }

  return {
    ok: true,
    value: {
      stateDir,
      fixture,
      ...(scenario ? { scenario } : {}),
      ...(now === undefined ? {} : { now }),
    },
  };
}

function isSimulatorScenario(value: string): value is SimulatorScenario {
  return (SIMULATOR_SCENARIOS as readonly string[]).includes(value);
}

function readFixture(path: string): OptionResult<SimulatorInput['fixture']> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { ok: false, message: 'unable to read fixture' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, message: 'invalid JSON fixture' };
  }

  if (!isFixture(parsed)) {
    return { ok: false, message: 'fixture must include baselines and observations objects' };
  }

  return { ok: true, value: parsed };
}

function isFixture(value: unknown): value is SimulatorInput['fixture'] {
  if (!isRecord(value)) return false;
  return isRecord(value.baselines) && isRecord(value.observations);
}

function isRecord(value: unknown): value is Record<string, Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function currentIso(deps: SimulateCommandDeps): string {
  return (deps.now ? deps.now() : new Date()).toISOString();
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'operation failed';
}
