import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DURATION_PATTERN } from '../lib/duration.ts';
import { safeErrorMessage } from '../lib/error-utils.ts';
import { loadPolicy } from '../policy/loader.ts';
import { openDatabase, type StoreLogger } from '../store/connection.ts';
import { EventStore } from '../store/events.ts';
import { MuteStore } from '../store/mutes.ts';

export interface MuteCommandDeps {
  write: (chunk: string) => void;
  now?: () => Date;
  logger?: StoreLogger;
}

interface MuteOptions {
  stateDir: string;
  host: string;
  domain: string;
  duration: string;
  reason: string;
  policyPath?: string;
}

interface StatusOptions {
  stateDir: string;
}

type OptionResult<T> = { ok: true; value: T } | { ok: false; message: string };

const STATE_FILE = 'state.sqlite';
const MUTE_USAGE = 'usage: whatsoup-guard mute --state-dir <dir> --host <host> --domain <domain> --duration <Ns|Nm|Nh|Nd> --reason <text> [--policy <policy.yaml>]\n';
const STATUS_USAGE = 'usage: whatsoup-guard status --state-dir <dir>\n';
const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

export async function muteCommand(args: string[], deps: MuteCommandDeps): Promise<number> {
  const parsed = parseMuteOptions(args);
  if (!parsed.ok) {
    deps.write(`${parsed.message}\n`);
    deps.write(MUTE_USAGE);
    return 2;
  }

  const duration = parseDurationMs(parsed.value.duration);
  if (!duration.ok) {
    deps.write(`${duration.message}\n`);
    deps.write(MUTE_USAGE);
    return 2;
  }

  let maxDurationMs: number | undefined;
  if (parsed.value.policyPath !== undefined) {
    try {
      const policy = loadPolicy(parsed.value.policyPath);
      const policyMax = parseDurationMs(policy.mute_constraints.default_max_duration);
      if (!policyMax.ok) {
        deps.write(`mute: policy default_max_duration is invalid: ${policyMax.message}\n`);
        return 1;
      }
      maxDurationMs = policyMax.value;
    } catch (error) {
      deps.write(`mute: ${safeErrorMessage(error)}\n`);
      return 1;
    }
  }

  mkdirSync(parsed.value.stateDir, { recursive: true });

  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    const now = currentDate(deps);
    db = openDatabase(join(parsed.value.stateDir, STATE_FILE), databaseOptions(deps));
    const events = new EventStore(db, join(parsed.value.stateDir, 'events.jsonl'));
    const store = new MuteStore(db, {
      ...databaseOptions(deps),
      events,
      ...(maxDurationMs !== undefined ? { maxDurationMs } : {}),
    });
    const expiresAt = new Date(now.getTime() + duration.value).toISOString();
    const id = store.create({
      host: parsed.value.host,
      domain: parsed.value.domain,
      expires_at: expiresAt,
      reason: parsed.value.reason,
      created_by: 'cli',
    });
    deps.write(`mute id=${id} host=${parsed.value.host} domain=${parsed.value.domain} expires_at=${expiresAt}\n`);
    return 0;
  } catch (error) {
    deps.write(`mute: ${safeErrorMessage(error)}\n`);
    return 1;
  } finally {
    db?.close();
  }
}

export async function statusCommand(args: string[], deps: MuteCommandDeps): Promise<number> {
  const parsed = parseStatusOptions(args);
  if (!parsed.ok) {
    deps.write(`${parsed.message}\n`);
    deps.write(STATUS_USAGE);
    return 2;
  }

  mkdirSync(parsed.value.stateDir, { recursive: true });

  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    db = openDatabase(join(parsed.value.stateDir, STATE_FILE), databaseOptions(deps));
    const store = new MuteStore(db, databaseOptions(deps));
    const active = store.listActive(currentDate(deps).toISOString());

    if (active.length === 0) {
      deps.write('no active mutes\n');
      return 0;
    }

    deps.write('host\tdomain\texpires_at\treason\n');
    for (const mute of active) {
      deps.write(`${mute.host}\t${mute.domain}\t${mute.expires_at}\t${mute.reason}\n`);
    }
    return 0;
  } catch (error) {
    deps.write(`status: ${safeErrorMessage(error)}\n`);
    return 1;
  } finally {
    db?.close();
  }
}

function parseMuteOptions(args: string[]): OptionResult<MuteOptions> {
  const parsed = parseFlagValues(args, new Set(['--state-dir', '--host', '--domain', '--duration', '--reason', '--policy']));
  if (!parsed.ok) return parsed;

  const options = {
    '--state-dir': parsed.value.get('--state-dir') ?? '',
    '--host': parsed.value.get('--host') ?? '',
    '--domain': parsed.value.get('--domain') ?? '',
    '--duration': parsed.value.get('--duration') ?? '',
    '--reason': parsed.value.get('--reason') ?? '',
  };

  for (const [label, value] of Object.entries(options)) {
    if (value.trim().length === 0) return { ok: false, message: `missing required option: ${label}` };
  }

  const policyPath = parsed.value.get('--policy');

  return {
    ok: true,
    value: {
      stateDir: options['--state-dir'],
      host: options['--host'],
      domain: options['--domain'],
      duration: options['--duration'],
      reason: options['--reason'],
      ...(policyPath !== undefined ? { policyPath } : {}),
    },
  };
}

function parseStatusOptions(args: string[]): OptionResult<StatusOptions> {
  const parsed = parseFlagValues(args, new Set(['--state-dir']));
  if (!parsed.ok) return parsed;

  const stateDir = parsed.value.get('--state-dir') ?? '';
  if (stateDir.trim().length === 0) return { ok: false, message: 'missing required option: --state-dir' };
  return { ok: true, value: { stateDir } };
}

function parseFlagValues(args: string[], allowed: ReadonlySet<string>): OptionResult<Map<string, string>> {
  const values = new Map<string, string>();

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

  return { ok: true, value: values };
}

function parseDurationMs(value: string): OptionResult<number> {
  const match = DURATION_PATTERN.exec(value);
  if (!match) {
    return { ok: false, message: 'duration must be a positive integer with unit s, m, h, or d' };
  }

  const amountText = match[1];
  const unit = match[2];
  if (!amountText || !unit) {
    return { ok: false, message: 'duration must be a positive integer with unit s, m, h, or d' };
  }

  const amount = Number(amountText);
  const unitMs = UNIT_MS[unit];
  if (!Number.isSafeInteger(amount) || amount <= 0 || unitMs === undefined) {
    return { ok: false, message: 'duration must be a positive integer with unit s, m, h, or d' };
  }

  return { ok: true, value: amount * unitMs };
}

function currentDate(deps: MuteCommandDeps): Date {
  return deps.now ? deps.now() : new Date();
}

function databaseOptions(deps: MuteCommandDeps): { now?: () => Date; logger?: StoreLogger } {
  return {
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.logger ? { logger: deps.logger } : {}),
  };
}
