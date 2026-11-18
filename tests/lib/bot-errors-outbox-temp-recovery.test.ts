// Crash-orphan recovery for the TypeScript outbox writer.
//
// writeBotErrorsEvent publishes through `.<fileName>.<pid>.tmp` → rename. A
// producer killed between the durable temp write and the rename leaves the only
// copy of the alert in a hidden temp that the dispatcher never scans. These
// tests pin the recovery contract:
//
// - a temp is a candidate only when its mtime is older than the 10-minute grace
//   AND its embedded pid is dead, or alive but started after the temp's mtime
//   (pid reuse); an unknown start time is never a candidate;
// - a complete, schema-valid, unpublished temp inside the 24 h TTL is promoted
//   to its final name exactly once: claimed by an atomic rename to a claim
//   name unique per claim (one winner across processes; never overwriting a
//   retained file), refused if the claim is not the validated file, then
//   published from the exact bytes that were validated, never from whatever a
//   path names later. A publish that throws before the final rename puts the
//   temp back for the next sweep; one that throws after it still removes the
//   claim, so the event is not published twice. A `.promote.tmp` scratch file
//   older than the TTL is retired with a breadcrumb;
// - anything else is retired: a content-free `.tempretire` breadcrumb in the
//   writefail dir, then unlink. When no breadcrumb can be written the temp is
//   kept and counted retire-deferred. torn / schema-invalid / stale-ttl
//   retirements, and a deferred torn / schema-invalid / stale-ttl temp this
//   process has not reported before (a completed scan forgets keys it no
//   longer defers), add ONE summary outbox event per sweep, which also carries the
//   retire-deferred and sweep-error counts; already-published is
//   breadcrumb-only;
// - a symlink, directory or FIFO with the temp name is never read, and one
//   swapped in after the lstat is refused without blocking, as is a different
//   regular file (the opened device and inode must be the lstat's);
// - a temp whose processing throws is counted and the scan continues; each
//   distinct pid is probed once per sweep;
// - the sweep runs from the writer and never throws into the alert path.
//
// The behavioural cases drive a REAL writeBotErrorsEvent in a child process and
// SIGKILL it inside the crash window. The pause is injected by a preload that
// patches the shared `node:fs` object and calls `syncBuiltinESMExports()` so
// the writer's named `renameSync` / `writeFileSync` imports see the patch — the
// same "patch the child's fs, not the parent's" approach as
// tests/helpers/isolated-child-hook.ts. Production code carries no pause hook.
//
// Promotion failures, claims, promote scratch files, FIFO safety, content-free
// records and the process probe are in
// tests/lib/bot-errors-outbox-temp-recovery-promotion.test.ts; the shared
// fixtures are in tests/helpers/bot-errors-outbox-temp.ts.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  backdate,
  blockAllWritefailDirsUnder,
  createFixtureDirs,
  finalNameFor,
  hiddenTemps,
  HOUR_MS,
  importOutbox,
  lossBreadcrumbs,
  MINUTE_MS,
  outboxEvents,
  ownPidAliveProbe,
  PAST_GRACE_MS,
  LETTERED_EVENT_ID,
  plantTemp,
  plantTornTemp,
  restoreFixtureEnv,
  retirementBreadcrumbs,
  summaryEvents,
  sweepCounts,
  type Fixture,
  type OutboxModule,
} from '../helpers/bot-errors-outbox-temp.ts';

const OUTBOX_MODULE_URL = new URL('../../src/lib/bot-errors-outbox.ts', import.meta.url).href;
const CHILD_PAUSE_TIMEOUT_MS = 15_000;

let tmpRoot = '';
const liveChildren = new Set<ChildProcess>();

afterEach(() => {
  for (const child of liveChildren) child.kill('SIGKILL');
  liveChildren.clear();
  vi.useRealTimers();
  vi.resetModules();
  restoreFixtureEnv();
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
});

function setup(): Fixture {
  tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-temp-recovery-'));
  return createFixtureDirs(tmpRoot);
}

function blockAllWritefailDirs(): void {
  blockAllWritefailDirsUnder(tmpRoot);
}

// ---------------------------------------------------------------------------
// Child producer killed inside the crash window
// ---------------------------------------------------------------------------

const CHILD_SOURCE = String.raw`
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const mode = process.env.OUTBOX_TEST_PAUSE_MODE;
const marker = process.env.OUTBOX_TEST_PAUSE_MARKER;
const originalWriteFileSync = fs.writeFileSync;
const originalRenameSync = fs.renameSync;
const originalFsyncSync = fs.fsyncSync;
const OUTBOX_TEMP = /\.json\.\d+\.tmp$/;

// Signal the parent through a file (synchronous, so it cannot be lost), then
// block this thread until the parent SIGKILLs the process.
function signalAndPark(detail) {
  originalWriteFileSync(marker, detail);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

if (mode === 'before-rename') {
  fs.renameSync = function (from, to) {
    if (OUTBOX_TEMP.test(String(from))) signalAndPark('before-rename');
    return originalRenameSync.call(this, from, to);
  };
}
if (mode === 'mid-write') {
  fs.writeFileSync = function (target, data, ...rest) {
    if (typeof target === 'number' && typeof data === 'string' && data.includes('"schemaVersion"')) {
      originalWriteFileSync(target, data.slice(0, Math.floor(data.length / 2)));
      originalFsyncSync(target);
      signalAndPark('mid-write');
    }
    return originalWriteFileSync.call(this, target, data, ...rest);
  };
}
syncBuiltinESMExports();

const { writeBotErrorsEvent } = await import(process.env.OUTBOX_TEST_MODULE_URL);
writeBotErrorsEvent({
  eventType: 'alert',
  severity: 'critical',
  instance: 'orphan-child',
  source: 'temp-recovery-proof',
  summary: 'crash window proof',
});
originalWriteFileSync(marker, 'completed-without-pause');
`;

interface KilledChild {
  pid: number;
  pausedAt: string;
}

async function killChildInsideCrashWindow(
  fixture: Fixture,
  mode: 'before-rename' | 'mid-write',
): Promise<KilledChild> {
  const childPath = join(tmpRoot, `outbox-crash-child-${mode}.mjs`);
  const marker = join(tmpRoot, `outbox-crash-child-${mode}.marker`);
  writeFileSync(childPath, CHILD_SOURCE, { mode: 0o600 });

  const child = spawn(process.execPath, [
    '--disable-warning=ExperimentalWarning',
    '--experimental-strip-types',
    childPath,
  ], {
    env: {
      ...process.env,
      BOT_ERRORS_OUTBOX_DIR: fixture.outbox,
      BOT_ERRORS_STATE_DIR: join(tmpRoot, 'state'),
      BOT_ERRORS_WRITEFAIL_DIR: fixture.writefail,
      OUTBOX_TEST_PAUSE_MODE: mode,
      OUTBOX_TEST_PAUSE_MARKER: marker,
      OUTBOX_TEST_MODULE_URL: OUTBOX_MODULE_URL,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  liveChildren.add(child);
  let stderr = '';
  child.stderr!.on('data', (chunk) => { stderr += String(chunk); });
  child.stdout!.resume();
  let exited = false;
  const exit = new Promise<void>((resolve) => {
    child.once('exit', () => { exited = true; resolve(); });
  });

  // Poll the marker's CONTENT: the file exists before its bytes land.
  const readMarker = (): string => {
    try {
      return readFileSync(marker, 'utf8');
    } catch {
      return '';
    }
  };
  const deadline = Date.now() + CHILD_PAUSE_TIMEOUT_MS;
  let pausedAt = readMarker();
  while (pausedAt === '') {
    if (exited) throw new Error(`crash-window child exited before pausing: ${stderr}`);
    if (Date.now() >= deadline) throw new Error(`crash-window child never paused: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    pausedAt = readMarker();
  }
  if (pausedAt !== mode) throw new Error(`crash-window child did not pause at ${mode}: ${pausedAt}`);

  const pid = child.pid!;
  child.kill('SIGKILL');
  await exit;
  liveChildren.delete(child);
  return { pid, pausedAt };
}

describe('crash-orphaned outbox temp recovery (real producer killed in the crash window)', () => {
  it('promotes a complete temp left by a producer killed between the durable write and the rename, exactly once', async () => {
    const fixture = setup();
    const { pid } = await killChildInsideCrashWindow(fixture, 'before-rename');

    // Fixture sanity: the kill left exactly one complete temp and no final file.
    const temps = hiddenTemps(fixture.outbox);
    expect(temps).toHaveLength(1);
    expect(temps[0]!.endsWith(`.${pid}.tmp`)).toBe(true);
    expect(outboxEvents(fixture.outbox)).toEqual([]);
    const tempPath = join(fixture.outbox, temps[0]!);
    const orphanContent = readFileSync(tempPath, 'utf8');
    const orphan = JSON.parse(orphanContent) as { id: string };
    const finalName = temps[0]!.slice(1, -`.${pid}.tmp`.length);

    backdate(tempPath, PAST_GRACE_MS);

    const mod = await importOutbox();
    mod.writeBotErrorsEvent({
      eventType: 'alert',
      severity: 'warning',
      instance: 'parent-writer',
      source: 'later-write',
      summary: 'a later write on the same host',
    });

    const finalPath = join(fixture.outbox, finalName);
    expect(existsSync(finalPath)).toBe(true);
    expect(readFileSync(finalPath, 'utf8')).toBe(orphanContent);
    expect(statSync(finalPath).mode & 0o777).toBe(0o600);
    expect(existsSync(tempPath)).toBe(false);
    expect(hiddenTemps(fixture.outbox)).toEqual([]);

    // A later sweep (past the throttle) must not publish it a second time.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 2 * MINUTE_MS);
    mod.writeBotErrorsEvent({
      eventType: 'alert',
      severity: 'warning',
      instance: 'parent-writer',
      source: 'later-write-2',
      summary: 'another later write',
    });
    const withOrphanId = outboxEvents(fixture.outbox).filter(({ event }) => event.id === orphan.id);
    expect(withOrphanId).toHaveLength(1);
    // Promotion is not a retirement: no breadcrumb and no summary event.
    expect(retirementBreadcrumbs(fixture.writefail)).toEqual([]);
    expect(summaryEvents(fixture.outbox)).toEqual([]);
  }, 30_000);

  it('retires a torn temp left by a producer killed mid-write, with a breadcrumb and a torn=1 summary', async () => {
    const fixture = setup();
    const { pid } = await killChildInsideCrashWindow(fixture, 'mid-write');

    const temps = hiddenTemps(fixture.outbox);
    expect(temps).toHaveLength(1);
    const tempName = temps[0]!;
    const tempPath = join(fixture.outbox, tempName);
    const tornContent = readFileSync(tempPath, 'utf8');
    expect(() => JSON.parse(tornContent)).toThrow();
    const finalName = tempName.slice(1, -`.${pid}.tmp`.length);

    backdate(tempPath, PAST_GRACE_MS);

    const mod = await importOutbox();
    mod.writeBotErrorsEvent({
      eventType: 'alert',
      severity: 'warning',
      instance: 'parent-writer',
      source: 'later-write',
      summary: 'a later write on the same host',
    });

    expect(existsSync(tempPath)).toBe(false);
    expect(existsSync(join(fixture.outbox, finalName))).toBe(false);

    const breadcrumbs = retirementBreadcrumbs(fixture.writefail);
    expect(breadcrumbs).toHaveLength(1);
    const breadcrumb = breadcrumbs[0]!;
    expect(breadcrumb).toMatchObject({
      kind: 'outbox_temp_retired',
      class: 'torn',
      tempName,
      size: Buffer.byteLength(tornContent),
      pid,
    });
    expect(typeof breadcrumb.mtime).toBe('string');
    // Content-free: the breadcrumb carries no part of the payload.
    expect(breadcrumb).not.toHaveProperty('event');
    expect(breadcrumb).not.toHaveProperty('contentHead');
    expect(JSON.stringify(breadcrumb)).not.toContain('schemaVersion\\"');
    expect(JSON.stringify(breadcrumb)).not.toContain('incident_alert');

    const summaries = summaryEvents(fixture.outbox);
    expect(summaries).toHaveLength(1);
    expect(sweepCounts(summaries[0]!)).toEqual(expect.arrayContaining(['torn=1', 'schema-invalid=0', 'stale-ttl=0']));
    // The summary names no orphan: counts only.
    expect(JSON.stringify(summaries[0])).not.toContain('orphan-child');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Sweep decisions (injected process probe, stubbed mtimes)
// ---------------------------------------------------------------------------

describe('sweepBotErrorsOutboxTemps candidate rules', () => {
  it('skips a temp whose pid is alive and started before the temp was written', async () => {
    const { outbox } = setup();
    const mod = await importOutbox();
    const planted = plantTemp(mod, outbox, { pid: 4242, mtimeAgeMs: PAST_GRACE_MS });
    const mtimeMs = statSync(planted.tempPath).mtimeMs;
    mod.setBotErrorsOutboxTempProcessProbeForTests(() => ({ alive: true, startedAtMs: mtimeMs - HOUR_MS }));

    mod.sweepBotErrorsOutboxTemps();

    expect(existsSync(planted.tempPath)).toBe(true);
    expect(existsSync(planted.finalPath)).toBe(false);
  });

  it('treats a live pid that started after the temp was written as pid reuse and promotes the temp', async () => {
    const { outbox } = setup();
    const mod = await importOutbox();
    const planted = plantTemp(mod, outbox, { pid: 4242, mtimeAgeMs: PAST_GRACE_MS });
    const mtimeMs = statSync(planted.tempPath).mtimeMs;
    mod.setBotErrorsOutboxTempProcessProbeForTests(() => ({ alive: true, startedAtMs: mtimeMs + MINUTE_MS }));

    mod.sweepBotErrorsOutboxTemps();

    expect(existsSync(planted.tempPath)).toBe(false);
    expect(readFileSync(planted.finalPath, 'utf8')).toBe(planted.content);
  });

  it('skips a temp whose live pid has an unknown start time', async () => {
    const { outbox } = setup();
    const mod = await importOutbox();
    const planted = plantTemp(mod, outbox, { pid: 4242, mtimeAgeMs: PAST_GRACE_MS });
    mod.setBotErrorsOutboxTempProcessProbeForTests(() => ({ alive: true, startedAtMs: null }));

    mod.sweepBotErrorsOutboxTemps();

    expect(existsSync(planted.tempPath)).toBe(true);
    expect(existsSync(planted.finalPath)).toBe(false);
  });

  it('skips a dead-pid temp still inside the grace period', async () => {
    const { outbox } = setup();
    const mod = await importOutbox();
    const planted = plantTemp(mod, outbox, { pid: 4242, mtimeAgeMs: MINUTE_MS });
    mod.setBotErrorsOutboxTempProcessProbeForTests(() => ({ alive: false }));

    mod.sweepBotErrorsOutboxTemps();

    expect(existsSync(planted.tempPath)).toBe(true);
    expect(existsSync(planted.finalPath)).toBe(false);
  });

  it('probes each distinct pid once per sweep, not once per temp', async () => {
    const { outbox } = setup();
    const mod = await importOutbox();
    const sharedPid = [
      plantTemp(mod, outbox, { pid: 4501, mtimeAgeMs: PAST_GRACE_MS }),
      plantTemp(mod, outbox, { pid: 4501, mtimeAgeMs: PAST_GRACE_MS }),
      plantTemp(mod, outbox, { pid: 4501, mtimeAgeMs: PAST_GRACE_MS }),
    ];
    const otherPid = plantTemp(mod, outbox, { pid: 4502, mtimeAgeMs: PAST_GRACE_MS });
    const probedPids: number[] = [];
    mod.setBotErrorsOutboxTempProcessProbeForTests((pid) => {
      probedPids.push(pid);
      return { alive: false };
    });

    mod.sweepBotErrorsOutboxTemps();

    expect([...probedPids].sort()).toEqual([4501, 4502]);
    // The cached answer still applies to every temp of that pid.
    for (const planted of [...sharedPid, otherPid]) {
      expect(existsSync(planted.tempPath)).toBe(false);
      expect(readFileSync(planted.finalPath, 'utf8')).toBe(planted.content);
    }

    // The cache is per sweep: a later sweep probes again.
    plantTemp(mod, outbox, { pid: 4501, mtimeAgeMs: PAST_GRACE_MS });
    mod.sweepBotErrorsOutboxTemps();
    expect(probedPids.filter((pid) => pid === 4501)).toHaveLength(2);
  });

  it('never touches files outside the TypeScript writer temp pattern', async () => {
    const { outbox, writefail } = setup();
    const mod = await importOutbox();
    mod.setBotErrorsOutboxTempProcessProbeForTests(() => ({ alive: false }));
    const validFinal = finalNameFor({
      createdAt: new Date(Date.now() - PAST_GRACE_MS).toISOString(),
      instance: 'unit',
      source: 'temp-sweep-unit',
      id: randomUUID(),
    });
    const untouched = [
      // post-tool-use hook producer: no millisecond suffix, non-UUID id.
      join(outbox, '.20260101T000000Z.unit.hook.tool-session-Read-1-abcdef12.json.4242.tmp'),
      // dispatcher durable-json temp.
      join(outbox, '.durable-json.abc123.tmp'),
      // unrelated dot-temp.
      join(outbox, '.unrelated.4242.tmp'),
      // right final shape but no pid segment.
      join(outbox, `.${validFinal}.tmp`),
      // pid 0 would address the process group; never a candidate.
      join(outbox, `.${validFinal}.0.tmp`),
      // writefail-dir temp from the breadcrumb writer.
      join(writefail, '.20260101T000000Z.unit.some-id.writefail.4242.tmp'),
    ];
    for (const path of untouched) {
      writeFileSync(path, 'not-an-event', { mode: 0o600 });
      backdate(path, 2 * HOUR_MS);
    }

    mod.sweepBotErrorsOutboxTemps();

    for (const path of untouched) expect(existsSync(path)).toBe(true);
    expect(retirementBreadcrumbs(writefail)).toEqual([]);
    expect(summaryEvents(outbox)).toEqual([]);
  });
});

describe('sweepBotErrorsOutboxTemps retirement', () => {
  it('retires an already-published temp with a breadcrumb only (no summary event)', async () => {
    const { outbox, writefail } = setup();
    const mod = await importOutbox();
    mod.setBotErrorsOutboxTempProcessProbeForTests(() => ({ alive: false }));
    const planted = plantTemp(mod, outbox, { pid: 4242, mtimeAgeMs: PAST_GRACE_MS });
    writeFileSync(planted.finalPath, '{"published":"by-the-original-rename"}\n', { mode: 0o600 });

    mod.sweepBotErrorsOutboxTemps();

    expect(existsSync(planted.tempPath)).toBe(false);
    expect(readFileSync(planted.finalPath, 'utf8')).toBe('{"published":"by-the-original-rename"}\n');
    const breadcrumbs = retirementBreadcrumbs(writefail);
    expect(breadcrumbs).toHaveLength(1);
    expect(breadcrumbs[0]).toMatchObject({ kind: 'outbox_temp_retired', class: 'already-published', pid: 4242 });
    expect(summaryEvents(outbox)).toEqual([]);
  });

  it('retires schema-invalid temps (wrong schema version, id not matching the file name) and emits one summary', async () => {
    const { outbox, writefail } = setup();
    const mod = await importOutbox();
    mod.setBotErrorsOutboxTempProcessProbeForTests(() => ({ alive: false }));
    const wrongVersion = plantTemp(mod, outbox, {
      pid: 4242,
      mtimeAgeMs: PAST_GRACE_MS,
      mutate: (event) => { event.schemaVersion = 1; },
    });
    const wrongId = plantTemp(mod, outbox, {
      pid: 4243,
      mtimeAgeMs: PAST_GRACE_MS,
      mutate: (event) => { event.id = randomUUID(); },
    });

    mod.sweepBotErrorsOutboxTemps();

    for (const planted of [wrongVersion, wrongId]) {
      expect(existsSync(planted.tempPath)).toBe(false);
      expect(existsSync(planted.finalPath)).toBe(false);
    }
    const breadcrumbs = retirementBreadcrumbs(writefail);
    expect(breadcrumbs.map((crumb) => crumb.class)).toEqual(['schema-invalid', 'schema-invalid']);
    const summaries = summaryEvents(outbox);
    expect(summaries).toHaveLength(1);
    expect(sweepCounts(summaries[0]!)).toEqual(expect.arrayContaining(['torn=0', 'schema-invalid=2', 'stale-ttl=0']));
  });

  it('retires a complete temp older than the 24 h TTL and emits a summary', async () => {
    const { outbox, writefail } = setup();
    const mod = await importOutbox();
    mod.setBotErrorsOutboxTempProcessProbeForTests(() => ({ alive: false }));
    const planted = plantTemp(mod, outbox, { pid: 4242, mtimeAgeMs: 25 * HOUR_MS });

    mod.sweepBotErrorsOutboxTemps();

    expect(existsSync(planted.tempPath)).toBe(false);
    expect(existsSync(planted.finalPath)).toBe(false);
    const breadcrumbs = retirementBreadcrumbs(writefail);
    expect(breadcrumbs).toHaveLength(1);
    expect(breadcrumbs[0]).toMatchObject({ class: 'stale-ttl', pid: 4242 });
    const summaries = summaryEvents(outbox);
    expect(summaries).toHaveLength(1);
    expect(sweepCounts(summaries[0]!)).toEqual(expect.arrayContaining(['torn=0', 'schema-invalid=0', 'stale-ttl=1']));
  });

  it('keeps a temp whose retirement breadcrumb cannot be written, reports each deferred temp once per process, and retires it once breadcrumbs work', async () => {
    const { outbox, writefail } = setup();
    // Every writefail fallback must refuse: the override, <state>/writefail,
    // ~/.bot-errors-writefail and $TMPDIR/bot-errors-writefail. A regular file
    // where each directory should be makes the private-dir check throw.
    const blockedOverride = join(tmpRoot, 'writefail-blocked');
    const blockedHome = join(tmpRoot, 'home');
    const blockedTmp = join(tmpRoot, 'tmp');
    mkdirSync(blockedHome, { recursive: true, mode: 0o700 });
    mkdirSync(blockedTmp, { recursive: true, mode: 0o700 });
    for (const path of [
      blockedOverride,
      join(tmpRoot, 'state', 'writefail'),
      join(blockedHome, '.bot-errors-writefail'),
      join(blockedTmp, 'bot-errors-writefail'),
    ]) {
      writeFileSync(path, 'not-a-directory', { mode: 0o600 });
    }
    process.env['BOT_ERRORS_WRITEFAIL_DIR'] = blockedOverride;
    process.env['HOME'] = blockedHome;
    process.env['TMPDIR'] = blockedTmp;
    // Fail closed: if HOME did not reach os.homedir(), a breadcrumb could land
    // in the real home directory instead of failing.
    expect(homedir()).toBe(blockedHome);
    const mod = await importOutbox();
    mod.setBotErrorsOutboxTempProcessProbeForTests(() => ({ alive: false }));
    const tornPath = plantTornTemp(outbox, 4401);

    const deferredCount = (event: Record<string, unknown>): string | undefined =>
      sweepCounts(event).find((count) => count.startsWith('retire-deferred='));

    const first = mod.sweepBotErrorsOutboxTemps();

    // No breadcrumb, so the only record of the loss is the temp itself: keep it.
    expect(existsSync(tornPath)).toBe(true);
    expect(first.retireDeferred).toBe(1);
    expect(first.retired['torn']).toBe(0);
    // Every writefail dir refusing must not hide the loss: the deferred temp
    // is reported even though every loss count is 0.
    expect(first.summaryEmitted).toBe(true);
    const firstSummaries = summaryEvents(outbox);
    expect(firstSummaries).toHaveLength(1);
    expect(sweepCounts(firstSummaries[0]!)).toEqual(expect.arrayContaining([
      'torn=0', 'schema-invalid=0', 'stale-ttl=0', 'retire-deferred=1', 'retire-deferred-new=1',
    ]));

    // Same process, same temp still deferred: not reported again.
    const second = mod.sweepBotErrorsOutboxTemps();
    expect(existsSync(tornPath)).toBe(true);
    expect(second.retireDeferred).toBe(1);
    expect(second.summaryEmitted).toBe(false);
    expect(summaryEvents(outbox)).toHaveLength(1);

    // A NEW deferred temp is reported, with the total deferred count.
    const secondTornPath = plantTornTemp(outbox, 4402);
    const third = mod.sweepBotErrorsOutboxTemps();
    expect(existsSync(secondTornPath)).toBe(true);
    expect(third.retireDeferred).toBe(2);
    expect(third.summaryEmitted).toBe(true);
    const thirdSummaries = summaryEvents(outbox);
    expect(thirdSummaries).toHaveLength(2);
    expect(thirdSummaries.map(deferredCount).sort()).toEqual(['retire-deferred=1', 'retire-deferred=2']);
    const newest = thirdSummaries.find((event) => deferredCount(event) === 'retire-deferred=2')!;
    expect(sweepCounts(newest)).toEqual(expect.arrayContaining(['torn=0', 'retire-deferred-new=1']));

    // Breadcrumbs work again: the next sweep retires both and the loss is summarised.
    process.env['BOT_ERRORS_WRITEFAIL_DIR'] = writefail;
    const retired = mod.sweepBotErrorsOutboxTemps();

    expect(existsSync(tornPath)).toBe(false);
    expect(existsSync(secondTornPath)).toBe(false);
    expect(retired.retireDeferred).toBe(0);
    expect(retired.retired['torn']).toBe(2);
    expect(retirementBreadcrumbs(writefail).map((crumb) => crumb.class)).toEqual(['torn', 'torn']);
    const finalSummaries = summaryEvents(outbox);
    expect(finalSummaries).toHaveLength(3);
    const lossSummary = finalSummaries.find((event) => sweepCounts(event).includes('torn=2'))!;
    expect(sweepCounts(lossSummary)).toEqual(expect.arrayContaining(['retire-deferred=0', 'retire-deferred-new=0']));
  });
});

describe('sweepBotErrorsOutboxTemps deferred reporting', () => {
  it('does not report a deferred already-published temp on its own, but still counts it retire-deferred', async () => {
    const { outbox } = setup();
    blockAllWritefailDirs();
    const mod = await importOutbox();
    mod.setBotErrorsOutboxTempProcessProbeForTests(() => ({ alive: false }));
    const planted = plantTemp(mod, outbox, { pid: 4701, mtimeAgeMs: PAST_GRACE_MS });
    writeFileSync(planted.finalPath, '{"published":"by-the-original-rename"}\n', { mode: 0o600 });

    const result = mod.sweepBotErrorsOutboxTemps();

    // Its breadcrumb could not be written, so it is kept and counted ...
    expect(existsSync(planted.tempPath)).toBe(true);
    expect(result.retireDeferred).toBe(1);
    // ... but it lost nothing, and the summary asserts an unrecoverable,
    // confirmed loss: it must not trigger one.
    expect(result.retireDeferredNew).toBe(0);
    expect(result.summaryEmitted).toBe(false);
    expect(summaryEvents(outbox)).toEqual([]);
  });

  it('forgets reported keys of temps that vanished, so a full set cannot silence a new deferred temp', async () => {
    const { outbox } = setup();
    blockAllWritefailDirs();
    const mod = await importOutbox();
    mod.setBotErrorsOutboxTempProcessProbeForTests(() => ({ alive: false }));
    // A cap of 1 stands in for 1024 without creating 1024 files.
    mod.setBotErrorsOutboxTempDeferredReportCapForTests(1);

    const first = plantTornTemp(outbox, 4711);
    expect(mod.sweepBotErrorsOutboxTemps().retireDeferredNew).toBe(1);
    expect(summaryEvents(outbox)).toHaveLength(1);

    // The reported temp disappears outside the sweep (an operator removed it),
    // so the sweep never retires it and never frees its entry that way.
    unlinkSync(first);
    const second = plantTornTemp(outbox, 4712);

    const result = mod.sweepBotErrorsOutboxTemps();

    expect(existsSync(second)).toBe(true);
    expect(result.retireDeferred).toBe(1);
    expect(result.retireDeferredNew).toBe(1);
    expect(result.summaryEmitted).toBe(true);
    expect(summaryEvents(outbox)).toHaveLength(2);
  });

  it('keeps reported keys when the directory scan did not complete', async () => {
    const { outbox } = setup();
    blockAllWritefailDirs();
    const mod = await importOutbox();
    mod.setBotErrorsOutboxTempProcessProbeForTests(() => ({ alive: false }));
    const torn = plantTornTemp(outbox, 4721);
    expect(mod.sweepBotErrorsOutboxTemps().retireDeferredNew).toBe(1);
    expect(summaryEvents(outbox)).toHaveLength(1);

    // An unreadable outbox: the scan fails before seeing any temp. That is not
    // evidence the temp is gone, so its key must survive.
    process.env['BOT_ERRORS_OUTBOX_DIR'] = join(tmpRoot, 'no-such-outbox');
    const failed = mod.sweepBotErrorsOutboxTemps();
    expect(failed.errors).toBe(1);
    process.env['BOT_ERRORS_OUTBOX_DIR'] = outbox;

    const again = mod.sweepBotErrorsOutboxTemps();

    expect(existsSync(torn)).toBe(true);
    expect(again.retireDeferred).toBe(1);
    expect(again.retireDeferredNew).toBe(0);
    expect(summaryEvents(outbox)).toHaveLength(1);
  });
});

describe('sweepBotErrorsOutboxTemps safety', () => {
  it('never throws when the outbox cannot be read', async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-temp-recovery-'));
    const notADirectory = join(tmpRoot, 'outbox-is-a-file');
    writeFileSync(notADirectory, 'x', { mode: 0o600 });
    process.env['BOT_ERRORS_OUTBOX_DIR'] = notADirectory;
    process.env['BOT_ERRORS_WRITEFAIL_DIR'] = join(tmpRoot, 'writefail');
    const mod = await importOutbox();

    expect(() => mod.sweepBotErrorsOutboxTemps()).not.toThrow();
  });

  it('keeps the alert path working when the process probe throws', async () => {
    const { outbox } = setup();
    const mod = await importOutbox();
    const planted = plantTemp(mod, outbox, { pid: 4242, mtimeAgeMs: PAST_GRACE_MS });
    mod.setBotErrorsOutboxTempProcessProbeForTests(() => {
      throw new Error('probe exploded');
    });

    expect(() => mod.sweepBotErrorsOutboxTemps()).not.toThrow();
    const write = mod.writeBotErrorsEvent({
      eventType: 'alert',
      severity: 'warning',
      instance: 'unit',
      source: 'alert-path',
      summary: 'still delivered',
    });

    expect(existsSync(write.path)).toBe(true);
    expect(existsSync(planted.tempPath)).toBe(true);
  });

  it('keeps sweeping past a temp whose processing throws, and reports it as sweep-error in the one summary', async () => {
    const { outbox, writefail } = setup();
    const mod = await importOutbox();
    // Distinct pids, so each temp costs one probe call. The SECOND call throws,
    // whatever readdir order the filesystem uses: one torn temp is processed
    // before the throw and one after it.
    const pids = [4301, 4302, 4303];
    const tornPaths = new Map(pids.map((pid) => [pid, plantTornTemp(outbox, pid)]));
    let probeCalls = 0;
    const threwFor: number[] = [];
    mod.setBotErrorsOutboxTempProcessProbeForTests((pid) => {
      probeCalls += 1;
      if (probeCalls === 2) {
        threwFor.push(pid);
        throw new Error('probe exploded mid-sweep');
      }
      return { alive: false };
    });

    const result = mod.sweepBotErrorsOutboxTemps();

    // The sweep continued past the throwing temp to the third one.
    expect(probeCalls).toBe(3);
    expect(threwFor).toHaveLength(1);
    for (const [pid, tempPath] of tornPaths) {
      expect(existsSync(tempPath)).toBe(pid === threwFor[0]);
    }
    expect(result.retired['torn']).toBe(2);
    expect(result.errors).toBe(1);
    expect(retirementBreadcrumbs(writefail).map((crumb) => crumb.class)).toEqual(['torn', 'torn']);
    // The retirements done around the failure stay visible: exactly one summary.
    expect(result.summaryEmitted).toBe(true);
    const summaries = summaryEvents(outbox);
    expect(summaries).toHaveLength(1);
    expect(sweepCounts(summaries[0]!)).toEqual(expect.arrayContaining(['torn=2', 'sweep-error=1']));
  });
});

describe('writeBotErrorsEvent sweep isolation', () => {
  it('still publishes and returns when the sweep step throws', async () => {
    const { outbox } = setup();
    const mod = await importOutbox();
    // The publish path reads the clock only through `new Date()`; Date.now() is
    // read only by the sweep's throttle and scan, so this throws inside the
    // sweep step and nowhere in the publish.
    let clockReads = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => {
      clockReads += 1;
      throw new Error('clock exploded inside the sweep');
    });
    let write: ReturnType<OutboxModule['writeBotErrorsEvent']> | undefined;
    try {
      write = mod.writeBotErrorsEvent({
        eventType: 'alert',
        severity: 'warning',
        instance: 'unit',
        source: 'sweep-throws',
        summary: 'still delivered',
      });
    } finally {
      clock.mockRestore();
    }

    expect(clockReads).toBeGreaterThan(0);
    expect(write).toBeDefined();
    expect(existsSync(write!.path)).toBe(true);
    expect(outboxEvents(outbox).map(({ event }) => event.source)).toEqual(['sweep-throws']);
  });
});

describe('writeBotErrorsEvent sweep cadence', () => {
  it('sweeps on the first write, throttles later writes, and sweeps again after the interval', async () => {
    const { outbox } = setup();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now());
    const mod = await importOutbox();
    mod.setBotErrorsOutboxTempProcessProbeForTests(() => ({ alive: false }));
    const write = (source: string) => mod.writeBotErrorsEvent({
      eventType: 'alert',
      severity: 'warning',
      instance: 'unit',
      source,
      summary: 'cadence',
    });

    const first = plantTemp(mod, outbox, { pid: 4242, mtimeAgeMs: PAST_GRACE_MS });
    write('first');
    expect(existsSync(first.finalPath)).toBe(true);

    const second = plantTemp(mod, outbox, { pid: 4243, mtimeAgeMs: PAST_GRACE_MS });
    vi.setSystemTime(Date.now() + 10_000);
    write('throttled');
    expect(existsSync(second.tempPath)).toBe(true);

    vi.setSystemTime(Date.now() + 61_000);
    write('after-interval');
    expect(existsSync(second.tempPath)).toBe(false);
    expect(existsSync(second.finalPath)).toBe(true);
  });

  it('emits exactly one summary per sweep and does not sweep again from inside the summary write', async () => {
    const { outbox, writefail } = setup();
    const mod = await importOutbox();
    mod.setBotErrorsOutboxTempProcessProbeForTests(() => ({ alive: false }));
    plantTemp(mod, outbox, { pid: 4242, mtimeAgeMs: 25 * HOUR_MS });
    const torn = join(outbox, `.${finalNameFor({
      createdAt: new Date(Date.now() - PAST_GRACE_MS).toISOString(),
      instance: 'unit',
      source: 'temp-sweep-unit',
      id: randomUUID(),
    })}.4244.tmp`);
    writeFileSync(torn, '{"schemaVersion": 2, "eventKind": "incident_al', { mode: 0o600 });
    backdate(torn, PAST_GRACE_MS);

    mod.writeBotErrorsEvent({
      eventType: 'alert',
      severity: 'warning',
      instance: 'unit',
      source: 'trigger',
      summary: 'trigger a sweep',
    });

    const summaries = summaryEvents(outbox);
    expect(summaries).toHaveLength(1);
    expect(sweepCounts(summaries[0]!)).toEqual(expect.arrayContaining(['torn=1', 'schema-invalid=0', 'stale-ttl=1']));
    expect(retirementBreadcrumbs(writefail).map((crumb) => crumb.class).sort()).toEqual(['stale-ttl', 'torn']);
    expect(hiddenTemps(outbox)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Mutant-killing cases: each pins one rule that an earlier case let drift.
// ---------------------------------------------------------------------------

describe('sweepBotErrorsOutboxTemps dedupe and validation', () => {
  it('treats a published final with the same id under a different name as already published', async () => {
    const { outbox, writefail } = setup();
    const mod = await importOutbox();
    mod.setBotErrorsOutboxTempProcessProbeForTests(() => ({ alive: false }));
    const planted = plantTemp(mod, outbox, { pid: 4601, mtimeAgeMs: PAST_GRACE_MS });
    // Same id, different createdAt / instance / source: only the id matches.
    const sameIdOtherName = join(outbox, finalNameFor({
      createdAt: new Date(Date.now() - HOUR_MS).toISOString(),
      instance: 'other-instance',
      source: 'other-source',
      id: planted.id,
    }));
    expect(sameIdOtherName).not.toBe(planted.finalPath);
    writeFileSync(sameIdOtherName, '{"published":"same-id-other-name"}\n', { mode: 0o600 });

    const result = mod.sweepBotErrorsOutboxTemps();

    expect(result.promoted).toBe(0);
    expect(result.retired['already-published']).toBe(1);
    expect(existsSync(planted.tempPath)).toBe(false);
    expect(existsSync(planted.finalPath)).toBe(false);
    expect(readFileSync(sameIdOtherName, 'utf8')).toBe('{"published":"same-id-other-name"}\n');
    expect(retirementBreadcrumbs(writefail).map((crumb) => crumb.class)).toEqual(['already-published']);
    expect(summaryEvents(outbox)).toEqual([]);
  });

  it('retires a v2 temp whose envelope buildBotErrorsEvent cannot produce as schema-invalid', async () => {
    const { outbox, writefail } = setup();
    const mod = await importOutbox();
    mod.setBotErrorsOutboxTempProcessProbeForTests(() => ({ alive: false }));
    // schemaVersion stays 2 and the identity fields still re-derive the file
    // name, so only the envelope check can reject these.
    const unknownKind = plantTemp(mod, outbox, {
      pid: 4611,
      mtimeAgeMs: PAST_GRACE_MS,
      mutate: (event) => { event.eventKind = 'not-an-event-kind'; },
    });
    const impossibleCombination = plantTemp(mod, outbox, {
      pid: 4612,
      mtimeAgeMs: PAST_GRACE_MS,
      mutate: (event) => { event.severity = 'info'; },
    });

    const result = mod.sweepBotErrorsOutboxTemps();

    expect(result.promoted).toBe(0);
    expect(result.retired['schema-invalid']).toBe(2);
    for (const planted of [unknownKind, impossibleCombination]) {
      expect(existsSync(planted.tempPath)).toBe(false);
      expect(existsSync(planted.finalPath)).toBe(false);
    }
    expect(retirementBreadcrumbs(writefail).map((crumb) => crumb.class)).toEqual(['schema-invalid', 'schema-invalid']);
  });

  // The dispatcher requires a string in each envelope field
  // (deploy/scripts/lib/bot_errors_envelope.py, _required_string); String()
  // would read a one-element array such as ["critical"] as its only element.
  it.each(['eventKind', 'eventType', 'severity'])(
    'retires a v2 temp whose %s is a one-element array as schema-invalid',
    async (field) => {
      const { outbox, writefail } = setup();
      const mod = await importOutbox();
      mod.setBotErrorsOutboxTempProcessProbeForTests(() => ({ alive: false }));
      const planted = plantTemp(mod, outbox, {
        pid: 4613,
        mtimeAgeMs: PAST_GRACE_MS,
        mutate: (event) => { event[field] = [event[field]]; },
      });

      const result = mod.sweepBotErrorsOutboxTemps();

      expect(result.promoted).toBe(0);
      expect(result.retired['schema-invalid']).toBe(1);
      expect(existsSync(planted.tempPath)).toBe(false);
      expect(existsSync(planted.finalPath)).toBe(false);
      expect(retirementBreadcrumbs(writefail).map((crumb) => crumb.class)).toEqual(['schema-invalid']);
    },
  );

  it('retires an otherwise valid temp larger than 1 MiB as schema-invalid', async () => {
    const { outbox } = setup();
    const mod = await importOutbox();
    mod.setBotErrorsOutboxTempProcessProbeForTests(() => ({ alive: false }));
    const oversized = plantTemp(mod, outbox, {
      pid: 4621,
      mtimeAgeMs: PAST_GRACE_MS,
      mutate: (event) => { event.padding = 'x'.repeat(1024 * 1024); },
    });

    const result = mod.sweepBotErrorsOutboxTemps();

    expect(result.retired['schema-invalid']).toBe(1);
    expect(existsSync(oversized.tempPath)).toBe(false);
    expect(existsSync(oversized.finalPath)).toBe(false);
  });

  // An orphaned temp did not necessarily come from the production builder, so
  // recovery must not publish a capability carried in a URL fragment or a
  // protected #v3 (managed delivery) or #i1 (intake) fragment, at any depth.
  it.each([
    ['a URL fragment', 'see https://example.invalid/open#capability-token'],
    ['a scheme-relative URL fragment', 'see //example.invalid/open#capability-token'],
    ['an ftp URL fragment', 'see ftp://example.invalid/open#capability-token'],
    ['a wss URL fragment', 'see wss://example.invalid/socket#capability-token'],
    ['a protected delivery fragment', `#v3.${'d'.repeat(22)}.${'k'.repeat(43)}`],
    ['a protected intake fragment', `#i1.${'i'.repeat(22)}.${'k'.repeat(43)}`],
    ['a bare www. host fragment', 'see www.example.invalid/open#capability-token'],
    ['a URL fragment after an earlier hash in its token', 'ref#12(https://example.invalid/open#capability-token)'],
  ])('retires a valid temp carrying %s as unsafe-content without publishing or recording it', async (_label, secret) => {
    const { outbox, writefail } = setup();
    const mod = await importOutbox();
    mod.setBotErrorsOutboxTempProcessProbeForTests(() => ({ alive: false }));
    const planted = plantTemp(mod, outbox, {
      pid: 4631,
      mtimeAgeMs: PAST_GRACE_MS,
      mutate: (event) => { event.arbitrary = { nested: { note: secret } }; },
    });

    const result = mod.sweepBotErrorsOutboxTemps();

    expect(result.promoted).toBe(0);
    expect(result.retired['unsafe-content']).toBe(1);
    expect(existsSync(planted.tempPath)).toBe(false);
    expect(existsSync(planted.finalPath)).toBe(false);
    const breadcrumbs = retirementBreadcrumbs(writefail);
    expect(breadcrumbs.map((crumb) => crumb.class)).toEqual(['unsafe-content']);
    expect(JSON.stringify(breadcrumbs)).not.toContain(secret);
    const summaries = summaryEvents(outbox);
    expect(summaries).toHaveLength(1);
    expect(sweepCounts(summaries[0]!)).toEqual(expect.arrayContaining(['unsafe-content=1']));
    expect(JSON.stringify(summaries)).not.toContain(secret);
  });

  it('still promotes a valid temp whose text has a bare hash or a URL without a fragment', async () => {
    const { outbox } = setup();
    const mod = await importOutbox();
    mod.setBotErrorsOutboxTempProcessProbeForTests(() => ({ alive: false }));
    const planted = plantTemp(mod, outbox, {
      pid: 4632,
      mtimeAgeMs: PAST_GRACE_MS,
      mutate: (event) => { event.arbitrary = { note: 'issue #42; see https://example.invalid/status; a // comment #7' }; },
    });

    const result = mod.sweepBotErrorsOutboxTemps();

    expect(result.promoted).toBe(1);
    expect(result.retired['unsafe-content']).toBe(0);
    expect(existsSync(planted.finalPath)).toBe(true);
  });

  // A capability needs a `#` after the URL start in the same run of characters.
  it('still promotes a valid temp whose only hash comes before its URL', async () => {
    const { outbox } = setup();
    const mod = await importOutbox();
    mod.setBotErrorsOutboxTempProcessProbeForTests(() => ({ alive: false }));
    const planted = plantTemp(mod, outbox, {
      pid: 4633,
      mtimeAgeMs: PAST_GRACE_MS,
      mutate: (event) => { event.arbitrary = { note: 'see #https://example.invalid/status and #www.example.invalid' }; },
    });

    const result = mod.sweepBotErrorsOutboxTemps();

    expect(result.promoted).toBe(1);
    expect(result.retired['unsafe-content']).toBe(0);
    expect(existsSync(planted.finalPath)).toBe(true);
  });
});

// The fragment check is linear in the text, like the redactor
// (tests/lib/redaction-text-linear.test.ts). Its alternatives used to restart at
// every letter and at every `x://`, `www.` or `-//x` prefix and rescan the rest
// of the run, so recovery spent quadratic time in the alert path on a run of
// scheme characters without `://` or on prefixes with no `#` after them. The
// sweep also reads and writes files, so its cap is four times the redactor's; a
// quadratic check still exceeds the cap or the growth bound.
const FRAGMENT_SIZES = [32_768, 65_536, 131_072] as const;
const FRAGMENT_CAP_MS_AT_128_KB = 600;
// The sweep's own file work takes milliseconds at any size; the growth bound starts above it.
const FRAGMENT_FLOOR_MS = 10;
const FRAGMENT_SHAPES: Array<[shape: string, note: (size: number) => string, refused: boolean]> = [
  ['a scheme-character run without ://', (size) => `${'a'.repeat(size)}#`, false],
  ['repeated x:// prefixes with no hash after them', (size) => `#${'x://'.repeat(size / 4)}`, false],
  ['repeated www. prefixes with no hash after them', (size) => `#${'www.'.repeat(size / 4)}`, false],
  ['repeated -//x prefixes with no hash after them', (size) => `#${'-//x'.repeat(size / 4)}`, false],
  ['a URL fragment at the end of a long run', (size) => `${'a'.repeat(size)}://example.invalid/open#capability-token`, true],
];

describe('sweepBotErrorsOutboxTemps fragment check stays linear', () => {
  it.each(FRAGMENT_SHAPES)('%s at 32, 64 and 128 KB', async (_shape, note, refused) => {
    const { outbox } = setup();
    const mod = await importOutbox();
    mod.setBotErrorsOutboxTempProcessProbeForTests(() => ({ alive: false }));
    const sweepMs = (text: string): number => {
      plantTemp(mod, outbox, {
        pid: 4711,
        mtimeAgeMs: PAST_GRACE_MS,
        mutate: (event) => { event.arbitrary = { note: text }; },
      });
      const start = process.hrtime.bigint();
      const result = mod.sweepBotErrorsOutboxTemps();
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
      expect(refused ? result.retired['unsafe-content'] : result.promoted).toBe(1);
      return elapsedMs;
    };
    const timings: number[] = [];
    for (const size of FRAGMENT_SIZES) {
      const text = note(size);
      sweepMs(text); // warm the JIT on this shape first
      const best = Math.min(sweepMs(text), sweepMs(text), sweepMs(text));
      timings.push(best);
      // Checked at each size, so a quadratic check fails at the first size it is too slow for.
      expect(best, JSON.stringify(timings)).toBeLessThan(FRAGMENT_CAP_MS_AT_128_KB * size / FRAGMENT_SIZES[2]);
    }
    // Linear growth from 32 KB to 128 KB is 4x; a quadratic check grows 16x.
    expect(timings[2], JSON.stringify(timings)).toBeLessThan(8 * Math.max(timings[0]!, FRAGMENT_FLOOR_MS));
  });
});

describe('sweepBotErrorsOutboxTemps TTL anchor', () => {
  it('retires as stale-ttl when only the mtime is past the TTL (createdAt recent)', async () => {
    const { outbox, writefail } = setup();
    const mod = await importOutbox();
    mod.setBotErrorsOutboxTempProcessProbeForTests(() => ({ alive: false }));
    const planted = plantTemp(mod, outbox, { pid: 4631, mtimeAgeMs: 25 * HOUR_MS, createdAgeMs: PAST_GRACE_MS });

    mod.sweepBotErrorsOutboxTemps();

    expect(existsSync(planted.tempPath)).toBe(false);
    expect(existsSync(planted.finalPath)).toBe(false);
    expect(retirementBreadcrumbs(writefail).map((crumb) => crumb.class)).toEqual(['stale-ttl']);
  });

  it('retires as stale-ttl when only createdAt is past the TTL (mtime recent)', async () => {
    const { outbox, writefail } = setup();
    const mod = await importOutbox();
    mod.setBotErrorsOutboxTempProcessProbeForTests(() => ({ alive: false }));
    const planted = plantTemp(mod, outbox, { pid: 4632, mtimeAgeMs: PAST_GRACE_MS, createdAgeMs: 25 * HOUR_MS });

    mod.sweepBotErrorsOutboxTemps();

    expect(existsSync(planted.tempPath)).toBe(false);
    expect(existsSync(planted.finalPath)).toBe(false);
    expect(retirementBreadcrumbs(writefail).map((crumb) => crumb.class)).toEqual(['stale-ttl']);
  });
});

describe('sweepBotErrorsOutboxTemps limit boundaries', () => {
  it('skips a dead-pid temp just inside the 10-minute grace and takes one just past it', async () => {
    const { outbox } = setup();
    const mod = await importOutbox();
    mod.setBotErrorsOutboxTempProcessProbeForTests(() => ({ alive: false }));
    const inside = plantTemp(mod, outbox, { pid: 4641, mtimeAgeMs: 9.5 * MINUTE_MS });
    const past = plantTemp(mod, outbox, { pid: 4642, mtimeAgeMs: 10.5 * MINUTE_MS });

    mod.sweepBotErrorsOutboxTemps();

    expect(existsSync(inside.tempPath)).toBe(true);
    expect(existsSync(inside.finalPath)).toBe(false);
    expect(existsSync(past.tempPath)).toBe(false);
    expect(readFileSync(past.finalPath, 'utf8')).toBe(past.content);
  });

  it('promotes a temp just inside the 24 h TTL and retires one just past it', async () => {
    const { outbox, writefail } = setup();
    const mod = await importOutbox();
    mod.setBotErrorsOutboxTempProcessProbeForTests(() => ({ alive: false }));
    const inside = plantTemp(mod, outbox, { pid: 4651, mtimeAgeMs: 23.5 * HOUR_MS });
    const past = plantTemp(mod, outbox, { pid: 4652, mtimeAgeMs: 24.5 * HOUR_MS });

    mod.sweepBotErrorsOutboxTemps();

    expect(readFileSync(inside.finalPath, 'utf8')).toBe(inside.content);
    expect(existsSync(past.tempPath)).toBe(false);
    expect(existsSync(past.finalPath)).toBe(false);
    expect(retirementBreadcrumbs(writefail).map((crumb) => crumb.class)).toEqual(['stale-ttl']);
  });

  it('throttles a write 59 s after a sweep and sweeps again at 61 s', async () => {
    const { outbox } = setup();
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.now();
    vi.setSystemTime(t0);
    const mod = await importOutbox();
    mod.setBotErrorsOutboxTempProcessProbeForTests(() => ({ alive: false }));
    const write = (source: string) => mod.writeBotErrorsEvent({
      eventType: 'alert',
      severity: 'warning',
      instance: 'unit',
      source,
      summary: 'throttle boundary',
    });

    write('first-sweep');
    const planted = plantTemp(mod, outbox, { pid: 4661, mtimeAgeMs: PAST_GRACE_MS });

    vi.setSystemTime(t0 + 59_000);
    write('at-59s');
    expect(existsSync(planted.tempPath)).toBe(true);

    vi.setSystemTime(t0 + 61_000);
    write('at-61s');
    expect(existsSync(planted.tempPath)).toBe(false);
    expect(readFileSync(planted.finalPath, 'utf8')).toBe(planted.content);
  });
});

describe('sweepBotErrorsOutboxTemps refuses non-regular temps', () => {
  it('skips a symlink with the temp name, even one pointing at a valid event', async () => {
    const { outbox } = setup();
    const mod = await importOutbox();
    mod.setBotErrorsOutboxTempProcessProbeForTests(() => ({ alive: false }));
    const planted = plantTemp(mod, outbox, { pid: 4681, mtimeAgeMs: PAST_GRACE_MS });
    const target = join(tmpRoot, 'symlink-target.json');
    writeFileSync(target, planted.content, { mode: 0o600 });
    unlinkSync(planted.tempPath);
    symlinkSync(target, planted.tempPath);
    const old = new Date(Date.now() - PAST_GRACE_MS);
    lutimesSync(planted.tempPath, old, old);

    const result = mod.sweepBotErrorsOutboxTemps();

    // Refused at the lstat isFile check: skipped, not an open error.
    expect(result.scanned).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.errors).toBe(0);
    expect(result.promoted).toBe(0);
    expect(lstatSync(planted.tempPath).isSymbolicLink()).toBe(true);
    expect(existsSync(planted.finalPath)).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe(planted.content);
  });

  it('skips a directory with the temp name', async () => {
    const { outbox } = setup();
    const mod = await importOutbox();
    mod.setBotErrorsOutboxTempProcessProbeForTests(() => ({ alive: false }));
    const dirPath = join(outbox, `.${finalNameFor({
      createdAt: new Date(Date.now() - PAST_GRACE_MS).toISOString(),
      instance: 'unit',
      source: 'temp-sweep-unit',
      id: randomUUID(),
    })}.4682.tmp`);
    mkdirSync(dirPath, { mode: 0o700 });
    backdate(dirPath, PAST_GRACE_MS);

    const result = mod.sweepBotErrorsOutboxTemps();

    expect(result.scanned).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.errors).toBe(0);
    expect(statSync(dirPath).isDirectory()).toBe(true);
  });

  it('refuses to follow a temp swapped for a symlink between the lstat and the open', async () => {
    const { outbox } = setup();
    const mod = await importOutbox();
    const planted = plantTemp(mod, outbox, { pid: 4683, mtimeAgeMs: PAST_GRACE_MS });
    const target = join(tmpRoot, 'swap-target.json');
    writeFileSync(target, planted.content, { mode: 0o600 });
    // The probe runs after the lstat and before the open: swap the regular
    // temp for a symlink to an identical, publishable event right there.
    mod.setBotErrorsOutboxTempProcessProbeForTests(() => {
      unlinkSync(planted.tempPath);
      symlinkSync(target, planted.tempPath);
      return { alive: false };
    });

    const result = mod.sweepBotErrorsOutboxTemps();

    // O_NOFOLLOW makes the open fail: a sweep error, nothing promoted.
    expect(result.errors).toBe(1);
    expect(result.promoted).toBe(0);
    expect(existsSync(planted.finalPath)).toBe(false);
    expect(lstatSync(planted.tempPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe(planted.content);
  });
});

describe('sweepBotErrorsOutboxTemps file identity', () => {
  it('refuses a temp swapped for a different regular file between the lstat and the open', async () => {
    const { outbox, writefail } = setup();
    const mod = await importOutbox();
    const planted = plantTemp(mod, outbox, { pid: 4691, mtimeAgeMs: PAST_GRACE_MS });
    const validatedIno = lstatSync(planted.tempPath).ino;
    // Created while the original still exists, so it cannot reuse its inode.
    const replacement = join(outbox, 'identity-swap-replacement');
    writeFileSync(replacement, planted.content, { mode: 0o600 });
    backdate(replacement, PAST_GRACE_MS);
    // The probe runs after the lstat and before the open: atomically replace
    // the temp with a different regular file carrying valid event content.
    mod.setBotErrorsOutboxTempProcessProbeForTests(() => {
      renameSync(replacement, planted.tempPath);
      return { alive: false };
    });

    const result = mod.sweepBotErrorsOutboxTemps();

    // Not the object the lstat checked: refused as a sweep error, never promoted.
    expect(result.promoted).toBe(0);
    expect(result.errors).toBe(1);
    expect(existsSync(planted.finalPath)).toBe(false);
    // The swapped-in file is left where it was, and really is another inode.
    expect(lstatSync(planted.tempPath).ino).not.toBe(validatedIno);
    expect(readFileSync(planted.tempPath, 'utf8')).toBe(planted.content);
    expect(retirementBreadcrumbs(writefail)).toEqual([]);
    // The original's only name was replaced, so its loss is recorded.
    expect(lossBreadcrumbs(writefail)).toEqual([
      expect.objectContaining({ class: 'swapped-before-open', eventId: planted.id }),
    ]);
  });

  it('records a loss naming the event id when a swap between the lstat and the open destroys the original', async () => {
    const { outbox, writefail } = setup();
    const mod = await importOutbox();
    const planted = plantTemp(mod, outbox, { pid: 4694, mtimeAgeMs: PAST_GRACE_MS, id: LETTERED_EVENT_ID });
    const replacement = join(outbox, 'open-swap-replacement');
    writeFileSync(replacement, 'swapped in before the open\n', { mode: 0o600 });
    backdate(replacement, PAST_GRACE_MS);
    // The probe runs after the lstat and before the open. Renaming over the
    // temp unlinks the original, its only name: the event is gone.
    mod.setBotErrorsOutboxTempProcessProbeForTests(() => {
      renameSync(replacement, planted.tempPath);
      return { alive: false };
    });

    const result = mod.sweepBotErrorsOutboxTemps();

    // Refused at the open, nothing published ...
    expect(result.promoted).toBe(0);
    expect(existsSync(planted.finalPath)).toBe(false);
    // ... but not silent: the event id, known from the temp's file name at
    // lstat time, is recorded and named in the summary.
    expect(lossBreadcrumbs(writefail)).toEqual([
      expect.objectContaining({ kind: 'outbox_temp_lost', class: 'swapped-before-open', eventId: planted.id }),
    ]);
    const summaries = summaryEvents(outbox);
    expect(summaries).toHaveLength(1);
    expect(sweepCounts(summaries[0]!)).toEqual(
      expect.arrayContaining(['lost-after-validation=1', `lost-event=${planted.id}`]),
    );
  });

  it('pins that a lost event id whose first two groups are all digits is redacted in the summary', async () => {
    // Conservative over-redaction, pinned so that changing it is deliberate:
    // the summary's phone rule reads 12 digits joined by a dash as a phone
    // number. The breadcrumb still names the full id.
    const digitLedId = '12345678-9012-4abc-8def-abcdef012345';
    const { outbox, writefail } = setup();
    const mod = await importOutbox();
    const planted = plantTemp(mod, outbox, { pid: 4698, mtimeAgeMs: PAST_GRACE_MS, id: digitLedId });
    const replacement = join(outbox, 'open-swap-replacement');
    writeFileSync(replacement, 'swapped in before the open\n', { mode: 0o600 });
    backdate(replacement, PAST_GRACE_MS);
    mod.setBotErrorsOutboxTempProcessProbeForTests(() => {
      renameSync(replacement, planted.tempPath);
      return { alive: false };
    });

    mod.sweepBotErrorsOutboxTemps();

    expect(lossBreadcrumbs(writefail)).toEqual([
      expect.objectContaining({ class: 'swapped-before-open', eventId: digitLedId }),
    ]);
    const counts = sweepCounts(summaryEvents(outbox)[0]!);
    expect(counts).toContain('lost-event=[REDACTED PHONE]-4abc-8def-abcdef012345');
    expect(counts).not.toContain(`lost-event=${digitLedId}`);
  });

  it('records no loss when the original survives a swap between the lstat and the open under another name', async () => {
    const { outbox, writefail } = setup();
    const mod = await importOutbox();
    const planted = plantTemp(mod, outbox, { pid: 4695, mtimeAgeMs: PAST_GRACE_MS });
    const finalName = planted.finalPath.slice(outbox.length + 1);
    // A peer's claim took the original; then a new file appeared at the path.
    const peerClaimPath = join(outbox, `.${finalName}.4999.c1.tmp`);
    const replacement = join(outbox, 'open-swap-survivor-replacement');
    writeFileSync(replacement, 'swapped in before the open\n', { mode: 0o600 });
    mod.setBotErrorsOutboxTempProcessProbeForTests(() => {
      if (!existsSync(peerClaimPath)) {
        renameSync(planted.tempPath, peerClaimPath);
        renameSync(replacement, planted.tempPath);
      }
      return { alive: false };
    });

    const result = mod.sweepBotErrorsOutboxTemps();

    // A sweep error only: the original is still in the outbox (the peer holds it).
    expect(result.errors).toBe(1);
    expect(readFileSync(peerClaimPath, 'utf8')).toBe(planted.content);
    expect(lossBreadcrumbs(writefail)).toEqual([]);
    expect(summaryEvents(outbox)).toEqual([]);
  });

  it('records no loss when a peer claims the temp between the lstat and the open', async () => {
    const { outbox, writefail } = setup();
    const mod = await importOutbox();
    const planted = plantTemp(mod, outbox, { pid: 4696, mtimeAgeMs: PAST_GRACE_MS });
    const finalName = planted.finalPath.slice(outbox.length + 1);
    // The normal single-winner race: a peer sweep's claim renames the temp
    // away and nothing takes its place, so this sweep's open finds no file.
    const peerClaimPath = join(outbox, `.${finalName}.4999.c1.tmp`);
    mod.setBotErrorsOutboxTempProcessProbeForTests(() => {
      if (existsSync(planted.tempPath)) renameSync(planted.tempPath, peerClaimPath);
      return { alive: false };
    });

    const result = mod.sweepBotErrorsOutboxTemps();

    expect(result.errors).toBe(1);
    expect(result.promoted).toBe(0);
    expect(readFileSync(peerClaimPath, 'utf8')).toBe(planted.content);
    expect(lossBreadcrumbs(writefail)).toEqual([]);
    expect(summaryEvents(outbox)).toEqual([]);
  });

  it('records no loss for a swap between the lstat and the open when the event is already published', async () => {
    const { outbox, writefail } = setup();
    const mod = await importOutbox();
    const planted = plantTemp(mod, outbox, { pid: 4697, mtimeAgeMs: PAST_GRACE_MS });
    // Published already, under another final name with the same id (a peer
    // published it); the temp's own final name does not exist.
    const publishedPath = join(outbox, finalNameFor({
      createdAt: new Date(Date.now() - HOUR_MS).toISOString(),
      instance: 'other-instance',
      source: 'other-source',
      id: planted.id,
    }));
    writeFileSync(publishedPath, '{"published":"same-id-other-name"}\n', { mode: 0o600 });
    const replacement = join(outbox, 'open-swap-published-replacement');
    writeFileSync(replacement, 'swapped in before the open\n', { mode: 0o600 });
    // After the lstat, before the open: the original's only name is replaced.
    mod.setBotErrorsOutboxTempProcessProbeForTests(() => {
      renameSync(replacement, planted.tempPath);
      return { alive: false };
    });

    const result = mod.sweepBotErrorsOutboxTemps();

    // Refused at the open, but the event was delivered: not a loss.
    expect(result.errors).toBe(1);
    expect(existsSync(planted.finalPath)).toBe(false);
    expect(lossBreadcrumbs(writefail)).toEqual([]);
    expect(summaryEvents(outbox)).toEqual([]);
  });

  it('refuses to publish when the temp is replaced after validation, and retires the replacement visibly', async () => {
    const { outbox, writefail } = setup();
    const mod = await importOutbox();
    mod.setBotErrorsOutboxTempProcessProbeForTests(() => ({ alive: false }));
    const planted = plantTemp(mod, outbox, { pid: 4692, mtimeAgeMs: PAST_GRACE_MS, id: LETTERED_EVENT_ID });
    const swappedBytes = 'swapped in after validation, never validated\n';
    const replacement = join(outbox, 'promote-swap-replacement');
    writeFileSync(replacement, swappedBytes, { mode: 0o600 });
    // Older than this process's start (ownPidAliveProbe: an hour ago), so once
    // it sits under this process's claim name the production start-time rule,
    // not a blanket stub, is what makes it an orphan for the second sweep.
    backdate(replacement, 2 * HOUR_MS);
    let hookCalls = 0;
    // Runs after the temp was read and validated, before it is published.
    mod.setBotErrorsOutboxTempBeforePromoteHookForTests((tempPath) => {
      hookCalls += 1;
      renameSync(replacement, tempPath);
    });

    const first = mod.sweepBotErrorsOutboxTemps();

    expect(hookCalls).toBe(1);
    // The claim is not the validated object, so nothing is published: neither
    // the swapped-in bytes nor the validated ones (publishing those without
    // holding the validated file could deliver an event a peer also holds).
    expect(first.promoted).toBe(0);
    expect(first.errors).toBe(1);
    expect(existsSync(planted.finalPath)).toBe(false);
    // The claim (this process's first claim name) moved the replacement off
    // the temp path; it waits under the claim name ...
    const finalName = planted.finalPath.slice(outbox.length + 1);
    const claimName = `.${finalName}.${process.pid}.c1.tmp`;
    const claimPath = join(outbox, claimName);
    expect(existsSync(planted.tempPath)).toBe(false);
    expect(readFileSync(claimPath, 'utf8')).toBe(swappedBytes);
    // ... and no promotion scratch file exists.
    expect(hiddenTemps(outbox)).toEqual([claimName]);

    // The replacement is not lost silently either: the next sweep retires it
    // with a breadcrumb and a summary. Production-shaped probe: this process
    // is alive, so its own claim is an orphan only through the start-time rule.
    mod.setBotErrorsOutboxTempBeforePromoteHookForTests(null);
    mod.setBotErrorsOutboxTempProcessProbeForTests(ownPidAliveProbe());
    const second = mod.sweepBotErrorsOutboxTemps();

    expect(second.retired['torn']).toBe(1);
    expect(existsSync(claimPath)).toBe(false);
    expect(existsSync(planted.finalPath)).toBe(false);
    expect(retirementBreadcrumbs(writefail).map((crumb) => crumb.class)).toEqual(['torn']);
    // The refusal is visible to the monitor: a breadcrumb naming the refused
    // object's file, and a summary that counts it.
    expect(retirementBreadcrumbs(writefail)[0]).toMatchObject({
      kind: 'outbox_temp_retired',
      class: 'torn',
      tempName: claimName,
      size: Buffer.byteLength(swappedBytes),
    });
    // Two summaries: the first sweep's loss of the validated event (the swap
    // destroyed it) and the second sweep's retirement of the replacement.
    // Their order in the listing is not asserted.
    const summaryCounts = summaryEvents(outbox).map((event) => sweepCounts(event));
    expect(summaryCounts).toHaveLength(2);
    expect(summaryCounts.filter((counts) => counts.includes('torn=1'))).toHaveLength(1);
    expect(summaryCounts.filter((counts) => counts.includes(`lost-event=${planted.id}`))).toHaveLength(1);
    // The validated event's loss is also a breadcrumb naming its id.
    const lost = readdirSync(writefail)
      .filter((name) => name.endsWith('.templost'))
      .map((name) => JSON.parse(readFileSync(join(writefail, name), 'utf8')) as Record<string, unknown>);
    expect(lost).toEqual([expect.objectContaining({ kind: 'outbox_temp_lost', eventId: planted.id })]);
  });

  it('publishes nothing when a sweep in another process claimed the validated temp first', async () => {
    const { outbox } = setup();
    const mod = await importOutbox();
    mod.setBotErrorsOutboxTempProcessProbeForTests(() => ({ alive: false }));
    const planted = plantTemp(mod, outbox, { pid: 4693, mtimeAgeMs: PAST_GRACE_MS });
    const finalName = planted.finalPath.slice(outbox.length + 1);
    // A peer's claim: the same temp renamed to that peer's writer-shaped name.
    const peerClaimPath = join(outbox, `.${finalName}.4999.tmp`);
    // Runs after this sweep validated the temp, before it claims it.
    mod.setBotErrorsOutboxTempBeforePromoteHookForTests((tempPath) => {
      renameSync(tempPath, peerClaimPath);
    });

    const result = mod.sweepBotErrorsOutboxTemps();

    // This sweep lost the single-winner claim: a sweep error, and no final
    // from it. The peer that holds the claim publishes (once).
    expect(result.promoted).toBe(0);
    expect(result.errors).toBe(1);
    expect(existsSync(planted.finalPath)).toBe(false);
    expect(readFileSync(peerClaimPath, 'utf8')).toBe(planted.content);
  });
});
