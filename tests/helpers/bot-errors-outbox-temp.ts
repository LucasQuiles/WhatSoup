// Shared fixtures for the TypeScript outbox crash-orphan temp recovery tests
// (tests/lib/bot-errors-outbox-temp-recovery*.test.ts). The recovery contract
// these tests pin is described at the top of
// tests/lib/bot-errors-outbox-temp-recovery.test.ts.
//
// Each test file keeps its own temp root, live-children set and afterEach,
// because tests assign that root directly; the helpers that need the root take
// it as a parameter.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ENV_KEYS = [
  'BOT_ERRORS_ALLOW_LIVE_IN_TESTS',
  'BOT_ERRORS_OUTBOX_DIR',
  'BOT_ERRORS_STATE_DIR',
  'BOT_ERRORS_WRITEFAIL_DIR',
  // The breadcrumb-failure case redirects the two home/tmp writefail fallbacks.
  'HOME',
  'TMPDIR',
] as const;

const originalEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
/** The contract's grace period. */
export const GRACE_MS = 10 * MINUTE_MS;
/** Past the contract's 10-minute grace period. */
export const PAST_GRACE_MS = 11 * MINUTE_MS;
/**
 * A fixed version 4 UUID for tests that assert the event id in a sweep
 * summary. Every group holds a hex letter, so no run of 10 or more digits
 * joined by dashes can form, and the summary's phone redaction never applies.
 * A random id has its first two groups all digits about 0.36% of the time,
 * and is then redacted.
 */
export const LETTERED_EVENT_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5';
const SWEEP_SOURCE = 'bot-errors-outbox-temp-sweep';

/** The only keys a `.tempretire` breadcrumb may carry: metadata, never payload. */
export const RETIRE_BREADCRUMB_KEYS = [
  'class', 'emitPid', 'kind', 'mtime', 'pid', 'recordedAt', 'schemaVersion', 'size', 'tempName',
];

/** Put back every environment key a fixture may have changed. */
export function restoreFixtureEnv(): void {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

export interface Fixture {
  outbox: string;
  writefail: string;
}

/** Create the outbox and writefail dirs under `root` and point the writer at them. */
export function createFixtureDirs(root: string): Fixture {
  const outbox = join(root, 'state', 'outbox');
  const writefail = join(root, 'writefail');
  mkdirSync(outbox, { recursive: true, mode: 0o700 });
  mkdirSync(writefail, { recursive: true, mode: 0o700 });
  process.env['BOT_ERRORS_STATE_DIR'] = join(root, 'state');
  process.env['BOT_ERRORS_OUTBOX_DIR'] = outbox;
  process.env['BOT_ERRORS_WRITEFAIL_DIR'] = writefail;
  return { outbox, writefail };
}

export type OutboxModule = typeof import('../../src/lib/bot-errors-outbox.ts');

export async function importOutbox(): Promise<OutboxModule> {
  return await import('../../src/lib/bot-errors-outbox.ts');
}

/** A pid that existed and has been reaped: spawnSync waits for the exit. */
export function mintDeadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '0']);
  if (typeof child.pid !== 'number' || child.pid <= 0) throw new Error('could not mint a dead pid');
  return child.pid;
}

/** The writer's documented final-name shape: `<created>.<instance>.<source>.<id>.json`. */
export function finalNameFor(event: { createdAt: string; instance: string; source: string; id: string }): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/.exec(event.createdAt);
  if (!match) throw new Error(`unexpected createdAt shape: ${event.createdAt}`);
  const [, y, mo, d, h, mi, s, ms] = match;
  return `${y}${mo}${d}T${h}${mi}${s}Z_${ms}.${event.instance}.${event.source}.${event.id}.json`;
}

export function backdate(path: string, ageMs: number): void {
  const when = new Date(Date.now() - ageMs);
  utimesSync(path, when, when);
}

export interface PlantedTemp {
  tempPath: string;
  finalPath: string;
  content: string;
  id: string;
}

interface PlantOptions {
  pid: number;
  mtimeAgeMs: number;
  createdAgeMs?: number;
  id?: string;
  /** Mutate the parsed event before it is serialised (schema-invalid cases). */
  mutate?: (event: Record<string, unknown>) => void;
}

export function plantTemp(mod: OutboxModule, outbox: string, options: PlantOptions): PlantedTemp {
  // buildBotErrorsEvent types its id as randomUUID()'s template-literal type.
  const id = (options.id ?? randomUUID()) as ReturnType<typeof randomUUID>;
  const createdAt = new Date(Date.now() - (options.createdAgeMs ?? options.mtimeAgeMs)).toISOString();
  const event = mod.buildBotErrorsEvent(
    { eventType: 'alert', severity: 'critical', instance: 'unit', source: 'temp-sweep-unit', summary: 'planted' },
    id,
    createdAt,
  ) as unknown as Record<string, unknown>;
  const finalName = finalNameFor(event as { createdAt: string; instance: string; source: string; id: string });
  options.mutate?.(event);
  const content = `${JSON.stringify(event, null, 2)}\n`;
  const tempPath = join(outbox, `.${finalName}.${options.pid}.tmp`);
  writeFileSync(tempPath, content, { mode: 0o600 });
  backdate(tempPath, options.mtimeAgeMs);
  return { tempPath, finalPath: join(outbox, finalName), content, id };
}

/** A torn temp: the writer's exact name shape, but content that cannot parse. */
export function plantTornTemp(outbox: string, pid: number): string {
  const tempPath = join(outbox, `.${finalNameFor({
    createdAt: new Date(Date.now() - PAST_GRACE_MS).toISOString(),
    instance: 'unit',
    source: 'temp-sweep-unit',
    id: randomUUID(),
  })}.${pid}.tmp`);
  writeFileSync(tempPath, '{"schemaVersion": 2, "eventKind": "incident_al', { mode: 0o600 });
  backdate(tempPath, PAST_GRACE_MS);
  return tempPath;
}

/**
 * Make every writefail fallback refuse (the override, <state>/writefail,
 * ~/.bot-errors-writefail, $TMPDIR/bot-errors-writefail) by putting a regular
 * file where each directory should be. Call after the fixture dirs exist under
 * `root`. Fails closed if HOME did not reach os.homedir(), so no breadcrumb
 * can land in a real home.
 */
export function blockAllWritefailDirsUnder(root: string): void {
  const blockedOverride = join(root, 'writefail-blocked');
  const blockedHome = join(root, 'home');
  const blockedTmp = join(root, 'tmp');
  mkdirSync(blockedHome, { recursive: true, mode: 0o700 });
  mkdirSync(blockedTmp, { recursive: true, mode: 0o700 });
  for (const path of [
    blockedOverride,
    join(root, 'state', 'writefail'),
    join(blockedHome, '.bot-errors-writefail'),
    join(blockedTmp, 'bot-errors-writefail'),
  ]) {
    writeFileSync(path, 'not-a-directory', { mode: 0o600 });
  }
  process.env['BOT_ERRORS_WRITEFAIL_DIR'] = blockedOverride;
  process.env['HOME'] = blockedHome;
  process.env['TMPDIR'] = blockedTmp;
  if (homedir() !== blockedHome) throw new Error('HOME did not reach os.homedir(); refusing to run');
}

export function outboxEvents(outbox: string): Array<{ name: string; event: Record<string, unknown> }> {
  return readdirSync(outbox)
    .filter((name) => !name.startsWith('.') && name.endsWith('.json'))
    .map((name) => ({ name, event: JSON.parse(readFileSync(join(outbox, name), 'utf8')) as Record<string, unknown> }));
}

export function summaryEvents(outbox: string): Array<Record<string, unknown>> {
  return outboxEvents(outbox).map(({ event }) => event).filter((event) => event.source === SWEEP_SOURCE);
}

export function retirementBreadcrumbs(writefail: string): Array<Record<string, unknown>> {
  return readdirSync(writefail)
    .filter((name) => name.endsWith('.tempretire'))
    .map((name) => JSON.parse(readFileSync(join(writefail, name), 'utf8')) as Record<string, unknown>);
}

export function lossBreadcrumbs(writefail: string): Array<Record<string, unknown>> {
  return readdirSync(writefail)
    .filter((name) => name.endsWith('.templost'))
    .map((name) => JSON.parse(readFileSync(join(writefail, name), 'utf8')) as Record<string, unknown>);
}

export function hiddenTemps(outbox: string): string[] {
  return readdirSync(outbox).filter((name) => name.startsWith('.') && name.endsWith('.tmp'));
}

export function sweepCounts(event: Record<string, unknown>): string[] {
  const asset = event.criticalAsset as { evidenceRefs?: unknown } | undefined;
  return Array.isArray(asset?.evidenceRefs) ? (asset.evidenceRefs as string[]) : [];
}

/**
 * A production-shaped probe: THIS process (whose claims carry its pid) is
 * alive and started well before the test; every other pid is dead. The blanket
 * `alive: false` stub would make this process's own claims look orphaned.
 */
export function ownPidAliveProbe(): (pid: number) => { alive: false } | { alive: true; startedAtMs: number } {
  const startedAtMs = Date.now() - HOUR_MS;
  return (pid) => (pid === process.pid ? { alive: true, startedAtMs } : { alive: false });
}
