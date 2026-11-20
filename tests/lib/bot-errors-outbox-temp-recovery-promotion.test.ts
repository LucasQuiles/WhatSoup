// Crash-orphan recovery for the TypeScript outbox writer: promotion failures,
// claims, promote scratch files, FIFO safety, content-free records and the
// process probe. The recovery contract these cases pin is described at the top
// of tests/lib/bot-errors-outbox-temp-recovery.test.ts; the shared fixtures
// are in tests/helpers/bot-errors-outbox-temp.ts.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  backdate,
  blockAllWritefailDirsUnder,
  createFixtureDirs,
  finalNameFor,
  GRACE_MS,
  hiddenTemps,
  HOUR_MS,
  importOutbox,
  lossBreadcrumbs,
  mintDeadPid,
  outboxEvents,
  ownPidAliveProbe,
  PAST_GRACE_MS,
  LETTERED_EVENT_ID,
  plantTemp,
  plantTornTemp,
  restoreFixtureEnv,
  RETIRE_BREADCRUMB_KEYS,
  retirementBreadcrumbs,
  summaryEvents,
  sweepCounts,
  type Fixture,
} from '../helpers/bot-errors-outbox-temp.ts';

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

describe('sweepBotErrorsOutboxTemps promotion failures', () => {
  it('recovers the alert on the next sweep when publishing fails before the final rename', async () => {
    const { outbox } = setup();
    const mod = await importOutbox();
    mod.setBotErrorsOutboxTempProcessProbeForTests(ownPidAliveProbe());
    const planted = plantTemp(mod, outbox, { pid: 4801, mtimeAgeMs: PAST_GRACE_MS });
    const finalName = planted.finalPath.slice(outbox.length + 1);
    // An existing scratch name makes the exclusive-create publish throw EEXIST.
    const obstacle = join(outbox, `.${finalName}.${process.pid}.promote.tmp`);
    writeFileSync(obstacle, 'scratch left by an earlier crash\n', { mode: 0o600 });

    const first = mod.sweepBotErrorsOutboxTemps();

    expect(first.errors).toBe(1);
    expect(first.promoted).toBe(0);
    expect(existsSync(planted.finalPath)).toBe(false);
    // The failed publish must not delete a scratch file it did not create.
    const obstacleSurvived = existsSync(obstacle);
    rmSync(obstacle, { force: true });

    // Immediately, with no time advance: the alert must be back in a state the
    // very next sweep recovers (a dead-pid temp with its original age).
    const second = mod.sweepBotErrorsOutboxTemps();

    expect(second.promoted).toBe(1);
    expect(readFileSync(planted.finalPath, 'utf8')).toBe(planted.content);
    expect(outboxEvents(outbox).filter(({ event }) => event.id === planted.id)).toHaveLength(1);
    expect(hiddenTemps(outbox)).toEqual([]);
    expect(obstacleSurvived).toBe(true);
  });

  it('removes a scratch file it created when writing it fails, so the next sweep can publish', async () => {
    const { outbox } = setup();
    const mod = await importOutbox();
    mod.setBotErrorsOutboxTempProcessProbeForTests(ownPidAliveProbe());
    const planted = plantTemp(mod, outbox, { pid: 4861, mtimeAgeMs: PAST_GRACE_MS });
    // Fails once, after the scratch file was created and before its bytes are
    // written (as ENOSPC or EIO would).
    let hookCalls = 0;
    mod.setBotErrorsOutboxTempScratchWriteHookForTests(() => {
      hookCalls += 1;
      if (hookCalls === 1) throw new Error('scratch write failed');
    });
    const promoteScratches = (): string[] => hiddenTemps(outbox).filter((name) => name.endsWith('.promote.tmp'));

    const first = mod.sweepBotErrorsOutboxTemps();

    expect(first.errors).toBe(1);
    expect(first.promoted).toBe(0);
    expect(promoteScratches()).toEqual([]);
    expect(existsSync(planted.tempPath)).toBe(true);

    const second = mod.sweepBotErrorsOutboxTemps();

    expect(second.promoted).toBe(1);
    expect(readFileSync(planted.finalPath, 'utf8')).toBe(planted.content);
    expect(outboxEvents(outbox).filter(({ event }) => event.id === planted.id)).toHaveLength(1);
    expect(hiddenTemps(outbox)).toEqual([]);
  });

  it('never delivers twice when publishing throws after the final rename', async () => {
    const { outbox } = setup();
    const mod = await importOutbox();
    mod.setBotErrorsOutboxTempProcessProbeForTests(ownPidAliveProbe());
    const planted = plantTemp(mod, outbox, { pid: 4821, mtimeAgeMs: PAST_GRACE_MS });
    const consumed = join(tmpRoot, 'consumed');
    mkdirSync(consumed, { mode: 0o700 });
    let deliveries = 0;
    // The dispatcher, which has no event-id dedupe: take the final away.
    const consumeFinal = (): void => {
      if (existsSync(planted.finalPath)) {
        deliveries += 1;
        renameSync(planted.finalPath, join(consumed, `delivery-${deliveries}.json`));
      }
    };
    // Throws once, right after the final rename (where chmod, fsync or the
    // claim cleanup could throw).
    let hookCalls = 0;
    mod.setBotErrorsOutboxTempAfterPublishHookForTests(() => {
      hookCalls += 1;
      if (hookCalls === 1) throw new Error('post-publish step failed');
    });

    const first = mod.sweepBotErrorsOutboxTemps();
    expect(first.errors).toBe(1);
    consumeFinal();

    // Later, after this process has exited: every pid now reads as dead.
    mod.setBotErrorsOutboxTempProcessProbeForTests(() => ({ alive: false }));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + PAST_GRACE_MS);
    mod.sweepBotErrorsOutboxTemps();
    consumeFinal();

    expect(deliveries).toBe(1);
    expect(readFileSync(join(consumed, 'delivery-1.json'), 'utf8')).toBe(planted.content);
    expect(hiddenTemps(outbox)).toEqual([]);
  });

  it('keeps both names inside the grace period while a claim restore holds both', async () => {
    const { outbox } = setup();
    const mod = await importOutbox();
    mod.setBotErrorsOutboxTempProcessProbeForTests(ownPidAliveProbe());
    const planted = plantTemp(mod, outbox, { pid: 4881, mtimeAgeMs: PAST_GRACE_MS });
    // A publish failure before the final rename triggers the restore.
    mod.setBotErrorsOutboxTempScratchWriteHookForTests(() => {
      throw new Error('scratch write failed');
    });
    const seen: Array<{ tempAgeMs: number; claimAgeMs: number }> = [];
    // At the point where the temp name is back and the claim name not yet gone.
    mod.setBotErrorsOutboxTempRestoreLinkedHookForTests((tempPath, claimPath) => {
      const now = Date.now();
      seen.push({
        tempAgeMs: now - lstatSync(tempPath).mtimeMs,
        claimAgeMs: now - lstatSync(claimPath).mtimeMs,
      });
    });

    const result = mod.sweepBotErrorsOutboxTemps();

    expect(result.errors).toBe(1);
    expect(seen).toHaveLength(1);
    // Two names for one event must never both look like orphans past grace:
    // a concurrent sweep could then take each of them.
    expect(seen[0]!.tempAgeMs).toBeLessThan(GRACE_MS);
    expect(seen[0]!.claimAgeMs).toBeLessThan(GRACE_MS);
    // Once restored: only the temp, back at its original age.
    expect(hiddenTemps(outbox)).toEqual([planted.tempPath.slice(outbox.length + 1)]);
    expect(Date.now() - lstatSync(planted.tempPath).mtimeMs).toBeGreaterThan(GRACE_MS);
  });

  it('never republishes a hard-linked claim sibling of a published temp', async () => {
    const { outbox } = setup();
    const mod = await importOutbox();
    mod.setBotErrorsOutboxTempProcessProbeForTests(ownPidAliveProbe());
    const planted = plantTemp(mod, outbox, { pid: 4891, mtimeAgeMs: PAST_GRACE_MS });
    const finalName = planted.finalPath.slice(outbox.length + 1);
    // What a restore whose claim unlink failed leaves: a second name (a dead
    // peer's claim) for the same file.
    const siblingPath = join(outbox, `.${finalName}.4999.c1.tmp`);
    linkSync(planted.tempPath, siblingPath);
    const consumed = join(tmpRoot, 'consumed');
    mkdirSync(consumed, { mode: 0o700 });
    let deliveries = 0;
    const consumeFinal = (): void => {
      if (existsSync(planted.finalPath)) {
        deliveries += 1;
        renameSync(planted.finalPath, join(consumed, `delivery-${deliveries}.json`));
      }
    };

    const first = mod.sweepBotErrorsOutboxTemps();
    // Whichever name is listed first is published and its sibling cleaned
    // up; the sibling's later ENOENT in this same sweep is not an error.
    expect(first.promoted).toBe(1);
    expect(first.errors).toBe(0);
    consumeFinal();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + PAST_GRACE_MS);
    mod.sweepBotErrorsOutboxTemps();
    consumeFinal();

    expect(deliveries).toBe(1);
    expect(hiddenTemps(outbox)).toEqual([]);
  });

  it('removes a hard-linked claim sibling right after the claim, before publishing', async () => {
    const { outbox } = setup();
    const mod = await importOutbox();
    mod.setBotErrorsOutboxTempProcessProbeForTests(ownPidAliveProbe());
    const planted = plantTemp(mod, outbox, { pid: 4892, mtimeAgeMs: PAST_GRACE_MS });
    const finalName = planted.finalPath.slice(outbox.length + 1);
    linkSync(planted.tempPath, join(outbox, `.${finalName}.4999.c1.tmp`));
    // Runs while publishing, before the final rename: by then the only
    // hidden names left should be this sweep's claim and its scratch file,
    // so a second sweep cannot claim the other name and publish it too.
    const namesWhilePublishing: string[][] = [];
    mod.setBotErrorsOutboxTempScratchWriteHookForTests(() => {
      namesWhilePublishing.push(hiddenTemps(outbox).filter((name) => !name.endsWith('.promote.tmp')));
    });

    const result = mod.sweepBotErrorsOutboxTemps();

    expect(result.promoted).toBe(1);
    expect(namesWhilePublishing).toHaveLength(1);
    expect(namesWhilePublishing[0]).toHaveLength(1);
    expect(namesWhilePublishing[0]![0]).toMatch(new RegExp(`\\.${process.pid}\\.c\\d+\\.tmp$`));
  });

  it('records a loss when two sweeps each remove the other claim and both publishes fail', async () => {
    const { outbox, writefail } = setup();
    const mod = await importOutbox();
    mod.setBotErrorsOutboxTempProcessProbeForTests(ownPidAliveProbe());
    const planted = plantTemp(mod, outbox, { pid: 4895, mtimeAgeMs: PAST_GRACE_MS, id: LETTERED_EVENT_ID });
    const finalName = planted.finalPath.slice(outbox.length + 1);
    // A W2 leftover: two names for one event, whose owner has exited.
    const siblingPath = join(outbox, `.${finalName}.4999.c1.tmp`);
    linkSync(planted.tempPath, siblingPath);
    const peerClaimPath = join(outbox, `.${finalName}.4998.c1.tmp`);
    // Before this sweep claims its name, a peer sweep claims the other one.
    // This sweep's early sibling cleanup then removes the peer's claim.
    let peerClaimed = false;
    mod.setBotErrorsOutboxTempBeforePromoteHookForTests((tempPath) => {
      if (peerClaimed) return;
      peerClaimed = true;
      renameSync(tempPath === planted.tempPath ? siblingPath : planted.tempPath, peerClaimPath);
    });
    // While this sweep publishes, the peer's own early cleanup removes this
    // sweep's claim, and this sweep's publish fails.
    const ownClaim = new RegExp(`\\.${process.pid}\\.c\\d+\\.tmp$`);
    mod.setBotErrorsOutboxTempScratchWriteHookForTests(() => {
      for (const name of hiddenTemps(outbox).filter((hidden) => ownClaim.test(hidden))) {
        unlinkSync(join(outbox, name));
      }
      throw new Error('scratch write failed');
    });

    const result = mod.sweepBotErrorsOutboxTemps();

    expect(peerClaimed).toBe(true);
    expect(result.promoted).toBe(0);
    // No name holds the event any more: it is not recoverable ...
    expect(existsSync(planted.finalPath)).toBe(false);
    expect(hiddenTemps(outbox).filter((name) => !name.endsWith('.promote.tmp'))).toEqual([]);
    // ... so the loss must not be silent: a breadcrumb and the summary name it.
    expect(lossBreadcrumbs(writefail)).toEqual([
      expect.objectContaining({ kind: 'outbox_temp_lost', class: 'restore-unheld', eventId: planted.id }),
    ]);
    expect(summaryEvents(outbox).flatMap((event) => sweepCounts(event))).toEqual(
      expect.arrayContaining(['lost-after-validation=1', `lost-event=${planted.id}`]),
    );
  });

  it('records no loss in that race when the peer already published the event', async () => {
    const { outbox, writefail } = setup();
    const mod = await importOutbox();
    mod.setBotErrorsOutboxTempProcessProbeForTests(ownPidAliveProbe());
    const planted = plantTemp(mod, outbox, { pid: 4896, mtimeAgeMs: PAST_GRACE_MS, id: LETTERED_EVENT_ID });
    const finalName = planted.finalPath.slice(outbox.length + 1);
    const siblingPath = join(outbox, `.${finalName}.4999.c1.tmp`);
    linkSync(planted.tempPath, siblingPath);
    const peerClaimPath = join(outbox, `.${finalName}.4998.c1.tmp`);
    let peerClaimed = false;
    mod.setBotErrorsOutboxTempBeforePromoteHookForTests((tempPath) => {
      if (peerClaimed) return;
      peerClaimed = true;
      renameSync(tempPath === planted.tempPath ? siblingPath : planted.tempPath, peerClaimPath);
    });
    // The peer removes this sweep's claim and, unlike the race above, its own
    // publish succeeds; then this sweep's publish fails.
    const ownClaim = new RegExp(`\\.${process.pid}\\.c\\d+\\.tmp$`);
    mod.setBotErrorsOutboxTempScratchWriteHookForTests(() => {
      for (const name of hiddenTemps(outbox).filter((hidden) => ownClaim.test(hidden))) {
        unlinkSync(join(outbox, name));
      }
      writeFileSync(planted.finalPath, planted.content, { mode: 0o600 });
      throw new Error('scratch write failed');
    });

    const result = mod.sweepBotErrorsOutboxTemps();

    expect(peerClaimed).toBe(true);
    expect(result.promoted).toBe(0);
    // Delivered once, by the peer: no name is left, but nothing was lost.
    expect(readFileSync(planted.finalPath, 'utf8')).toBe(planted.content);
    expect(lossBreadcrumbs(writefail)).toEqual([]);
    expect(summaryEvents(outbox).flatMap((event) => sweepCounts(event))).not.toContain(`lost-event=${planted.id}`);
  });

  it('still counts a sweep error for a listed temp that vanished for any other reason', async () => {
    const { outbox } = setup();
    const mod = await importOutbox();
    const temps = [
      plantTemp(mod, outbox, { pid: 4893, mtimeAgeMs: PAST_GRACE_MS }),
      plantTemp(mod, outbox, { pid: 4894, mtimeAgeMs: PAST_GRACE_MS }),
    ];
    // The first probe (after the first temp's lstat) removes the OTHER temp,
    // which this sweep has listed but not cleaned up itself.
    let removed = false;
    mod.setBotErrorsOutboxTempProcessProbeForTests((pid) => {
      if (!removed) {
        removed = true;
        unlinkSync(temps.find((temp) => !temp.tempPath.endsWith(`.${pid}.tmp`))!.tempPath);
      }
      return { alive: false };
    });

    const result = mod.sweepBotErrorsOutboxTemps();

    expect(removed).toBe(true);
    expect(result.promoted).toBe(1);
    expect(result.errors).toBe(1);
  });

  it('records a loss naming the event id when the validated file is destroyed before the claim', async () => {
    const { outbox, writefail } = setup();
    const mod = await importOutbox();
    mod.setBotErrorsOutboxTempProcessProbeForTests(ownPidAliveProbe());
    const planted = plantTemp(mod, outbox, { pid: 4901, mtimeAgeMs: PAST_GRACE_MS, id: LETTERED_EVENT_ID });
    const replacement = join(outbox, 'loss-swap-replacement');
    writeFileSync(replacement, 'swapped in after validation\n', { mode: 0o600 });
    backdate(replacement, 2 * HOUR_MS);
    // Renaming over the temp unlinks the validated file: after this, only the
    // sweep's open descriptor still holds it (link count 0).
    mod.setBotErrorsOutboxTempBeforePromoteHookForTests((tempPath) => {
      renameSync(replacement, tempPath);
    });

    const result = mod.sweepBotErrorsOutboxTemps();

    // Not published: publishing bytes the sweep no longer holds a file for is refused.
    expect(result.promoted).toBe(0);
    expect(existsSync(planted.finalPath)).toBe(false);
    // But the loss is recorded, naming the event, and the summary carries it.
    const lost = readdirSync(writefail)
      .filter((name) => name.endsWith('.templost'))
      .map((name) => JSON.parse(readFileSync(join(writefail, name), 'utf8')) as Record<string, unknown>);
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatchObject({
      kind: 'outbox_temp_lost',
      class: 'swapped-after-validation',
      eventId: planted.id,
    });
    const summaries = summaryEvents(outbox);
    expect(summaries).toHaveLength(1);
    expect(sweepCounts(summaries[0]!)).toEqual(
      expect.arrayContaining(['lost-after-validation=1', `lost-event=${planted.id}`]),
    );
  });
});

describe('sweepBotErrorsOutboxTemps claims', () => {
  it('never overwrites a file retained under a claim name when claiming the same final name again', async () => {
    const { outbox } = setup();
    const mod = await importOutbox();
    mod.setBotErrorsOutboxTempProcessProbeForTests(ownPidAliveProbe());
    const planted = plantTemp(mod, outbox, { pid: 4831, mtimeAgeMs: PAST_GRACE_MS });
    const finalName = planted.finalPath.slice(outbox.length + 1);
    // Evidence an earlier claim in this process left behind (a swapped-in
    // object kept for a later sweep), under the plain and the first counted
    // claim names. Fresh, and owned by this live process, so sweeps skip them.
    const retained = [
      join(outbox, `.${finalName}.${process.pid}.tmp`),
      join(outbox, `.${finalName}.${process.pid}.c1.tmp`),
    ];
    retained.forEach((path, index) => writeFileSync(path, `retained evidence ${index}\n`, { mode: 0o600 }));

    const result = mod.sweepBotErrorsOutboxTemps();

    expect(result.promoted).toBe(1);
    expect(readFileSync(planted.finalPath, 'utf8')).toBe(planted.content);
    retained.forEach((path, index) => {
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, 'utf8')).toBe(`retained evidence ${index}\n`);
    });
  });

  it('delivers at most once when a peer claimed the validated temp and a new file was swapped in before our claim', async () => {
    const { outbox } = setup();
    const mod = await importOutbox();
    mod.setBotErrorsOutboxTempProcessProbeForTests(ownPidAliveProbe());
    const planted = plantTemp(mod, outbox, { pid: 4841, mtimeAgeMs: PAST_GRACE_MS });
    const finalName = planted.finalPath.slice(outbox.length + 1);
    const peerClaimPath = join(outbox, `.${finalName}.4999.tmp`);
    const swapped = join(outbox, 'claim-race-swap');
    writeFileSync(swapped, 'swapped in after the peer claim\n', { mode: 0o600 });
    // After this sweep validated the temp and before it claims: a peer (pid
    // 4999) claims the validated file, then a new file appears at the temp path.
    mod.setBotErrorsOutboxTempBeforePromoteHookForTests((tempPath) => {
      renameSync(tempPath, peerClaimPath);
      renameSync(swapped, tempPath);
    });
    const consumed = join(tmpRoot, 'consumed');
    mkdirSync(consumed, { mode: 0o700 });
    let deliveries = 0;
    const consumeFinal = (): void => {
      if (existsSync(planted.finalPath)) {
        deliveries += 1;
        renameSync(planted.finalPath, join(consumed, `delivery-${deliveries}.json`));
      }
    };

    mod.sweepBotErrorsOutboxTemps();
    consumeFinal();
    // Later: the peer's claim is past grace and its pid is dead, so a sweep
    // recovers it. This process is still alive.
    mod.setBotErrorsOutboxTempBeforePromoteHookForTests(null);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + PAST_GRACE_MS);
    mod.sweepBotErrorsOutboxTemps();
    consumeFinal();

    expect(deliveries).toBe(1);
    expect(readFileSync(join(consumed, 'delivery-1.json'), 'utf8')).toBe(planted.content);
  });
});

// A promotion writes a durable intent after its scratch is complete and before
// the final rename, and removes it after the claim unlink. After a crash the
// next sweep reads the intent and the scratch: a scratch still present means the
// rename never happened (publish exactly once); a scratch gone means it did
// (unlink the claim, never publish again, even once the final is consumed).
// The crash states below are rebuilt from what the real promotion wrote at
// that point: the intent's bytes, and the claim through a hard link, so it keeps
// the identity the intent names.

function promoteIntents(outbox: string): string[] {
  return readdirSync(outbox).filter((name) => name.startsWith('.') && name.endsWith('.promote.intent'));
}

interface CrashCapture {
  claimName: string;
  intentName: string;
  intentBytes: Buffer | null;
  scratchName: string;
  scratchBytes: Buffer | null;
}

function captureCrashState(outbox: string, finalName: string): CrashCapture {
  const names = readdirSync(outbox);
  const claimName = names.find((name) => name.startsWith(`.${finalName}.${process.pid}.c`) && name.endsWith('.tmp')) ?? '';
  const intentName = promoteIntents(outbox)[0] ?? '';
  const scratchName = names.find((name) => name.startsWith(`.${finalName}.`) && name.endsWith('.promote.tmp')) ?? '';
  return {
    claimName,
    intentName,
    intentBytes: intentName ? readFileSync(join(outbox, intentName)) : null,
    scratchName,
    scratchBytes: scratchName ? readFileSync(join(outbox, scratchName)) : null,
  };
}

/** Later, after the crashed process exited: every pid reads as dead and the claim is past the grace period. */
function afterTheCrashedProcessExited(mod: Awaited<ReturnType<typeof importOutbox>>): void {
  mod.setBotErrorsOutboxTempProcessProbeForTests(() => ({ alive: false }));
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + PAST_GRACE_MS);
}

describe('sweepBotErrorsOutboxTemps promotion intent', () => {
  it('writes the intent before the final rename and removes it after the claim unlink', async () => {
    const { outbox } = setup();
    const mod = await importOutbox();
    mod.setBotErrorsOutboxTempProcessProbeForTests(ownPidAliveProbe());
    plantTemp(mod, outbox, { pid: 4901, mtimeAgeMs: PAST_GRACE_MS });
    const seen = { beforeRename: [] as string[], afterPublish: [] as string[] };
    mod.setBotErrorsOutboxTempBeforeFinalRenameHookForTests(() => { seen.beforeRename = promoteIntents(outbox); });
    mod.setBotErrorsOutboxTempAfterPublishHookForTests(() => { seen.afterPublish = promoteIntents(outbox); });

    expect(mod.sweepBotErrorsOutboxTemps().promoted).toBe(1);

    expect(seen.beforeRename).toHaveLength(1);
    expect(seen.afterPublish).toEqual(seen.beforeRename);
    expect(promoteIntents(outbox)).toEqual([]);
    expect(hiddenTemps(outbox)).toEqual([]);
  });

  it('never publishes again after a crash between the final rename and the claim unlink, once the final is consumed', async () => {
    const { outbox } = setup();
    const mod = await importOutbox();
    mod.setBotErrorsOutboxTempProcessProbeForTests(ownPidAliveProbe());
    const planted = plantTemp(mod, outbox, { pid: 4911, mtimeAgeMs: PAST_GRACE_MS });
    const finalName = planted.finalPath.slice(outbox.length + 1);
    const kept = join(tmpRoot, 'crash-state');
    mkdirSync(kept, { mode: 0o700 });
    let captured: CrashCapture | undefined;
    mod.setBotErrorsOutboxTempAfterPublishHookForTests(() => {
      captured = captureCrashState(outbox, finalName);
      linkSync(join(outbox, captured.claimName), join(kept, 'claim'));
    });

    expect(mod.sweepBotErrorsOutboxTemps().promoted).toBe(1);
    mod.setBotErrorsOutboxTempAfterPublishHookForTests(null);
    // The dispatcher, which has no event-id dedupe, consumes the final.
    const consumed = join(tmpRoot, 'consumed');
    mkdirSync(consumed, { mode: 0o700 });
    renameSync(planted.finalPath, join(consumed, 'delivery-1.json'));
    // What a crash right after the final rename leaves: the claim and the intent, no scratch.
    const state = captured!;
    linkSync(join(kept, 'claim'), join(outbox, state.claimName));
    if (state.intentBytes) writeFileSync(join(outbox, state.intentName), state.intentBytes, { mode: 0o600 });

    afterTheCrashedProcessExited(mod);
    const after = mod.sweepBotErrorsOutboxTemps();

    expect(after.promoted).toBe(0);
    expect(existsSync(planted.finalPath)).toBe(false);
    expect(readdirSync(consumed)).toEqual(['delivery-1.json']);
    expect(state.scratchBytes).toBeNull();
    expect(state.intentBytes).not.toBeNull();
    expect(hiddenTemps(outbox)).toEqual([]);
    expect(promoteIntents(outbox)).toEqual([]);
    expect(after.errors).toBe(0);
  });

  it('publishes exactly once after a crash between the intent and the final rename', async () => {
    const { outbox } = setup();
    const mod = await importOutbox();
    mod.setBotErrorsOutboxTempProcessProbeForTests(ownPidAliveProbe());
    const planted = plantTemp(mod, outbox, { pid: 4921, mtimeAgeMs: PAST_GRACE_MS });
    const finalName = planted.finalPath.slice(outbox.length + 1);
    let captured: CrashCapture | undefined;
    mod.setBotErrorsOutboxTempBeforeFinalRenameHookForTests(() => {
      captured = captureCrashState(outbox, finalName);
      throw new Error('stop at the crash point, before the final rename');
    });

    const first = mod.sweepBotErrorsOutboxTemps();

    expect(first.errors).toBe(1);
    expect(first.promoted).toBe(0);
    // A failed rename removes the intent before the scratch, and puts the claim back.
    expect(promoteIntents(outbox)).toEqual([]);
    expect(hiddenTemps(outbox)).toEqual([planted.tempPath.slice(outbox.length + 1)]);
    mod.setBotErrorsOutboxTempBeforeFinalRenameHookForTests(null);
    // What the crash leaves: the claim (the restore kept its inode), the complete scratch and the intent.
    const state = captured!;
    expect(state.intentBytes).not.toBeNull();
    expect(state.scratchBytes?.toString('utf8')).toBe(planted.content);
    renameSync(planted.tempPath, join(outbox, state.claimName));
    writeFileSync(join(outbox, state.scratchName), state.scratchBytes!, { mode: 0o600 });
    writeFileSync(join(outbox, state.intentName), state.intentBytes!, { mode: 0o600 });

    afterTheCrashedProcessExited(mod);
    const second = mod.sweepBotErrorsOutboxTemps();
    const third = mod.sweepBotErrorsOutboxTemps();

    expect(second.promoted + third.promoted).toBe(1);
    expect(readFileSync(planted.finalPath, 'utf8')).toBe(planted.content);
    expect(outboxEvents(outbox).filter(({ event }) => event.id === planted.id)).toHaveLength(1);
    expect(hiddenTemps(outbox)).toEqual([]);
    expect(promoteIntents(outbox)).toEqual([]);
  });

  it('removes the intent and then the scratch when writing the intent fails, so the next sweep publishes once', async () => {
    const { outbox } = setup();
    const mod = await importOutbox();
    mod.setBotErrorsOutboxTempProcessProbeForTests(ownPidAliveProbe());
    const planted = plantTemp(mod, outbox, { pid: 4931, mtimeAgeMs: PAST_GRACE_MS });
    // Fails once, after the intent file was created and before its bytes are written.
    let hookCalls = 0;
    mod.setBotErrorsOutboxTempIntentWriteHookForTests(() => {
      hookCalls += 1;
      if (hookCalls === 1) throw new Error('intent write failed');
    });

    const first = mod.sweepBotErrorsOutboxTemps();

    expect(first.errors).toBe(1);
    expect(first.promoted).toBe(0);
    expect(promoteIntents(outbox)).toEqual([]);
    expect(hiddenTemps(outbox)).toEqual([planted.tempPath.slice(outbox.length + 1)]);

    const second = mod.sweepBotErrorsOutboxTemps();

    expect(second.promoted).toBe(1);
    expect(readFileSync(planted.finalPath, 'utf8')).toBe(planted.content);
    expect(hiddenTemps(outbox)).toEqual([]);
    expect(promoteIntents(outbox)).toEqual([]);
  });
});

/** A `.promote.tmp` scratch file as a crash mid-publish would leave it. */
function plantPromoteScratch(outbox: string, pid: number, ageMs: number): string {
  const scratchPath = join(outbox, `.${finalNameFor({
    createdAt: new Date(Date.now() - ageMs).toISOString(),
    instance: 'unit',
    source: 'temp-sweep-unit',
    id: randomUUID(),
  })}.${pid}.promote.tmp`);
  writeFileSync(scratchPath, '{"leaked":"promote scratch"}\n', { mode: 0o600 });
  backdate(scratchPath, ageMs);
  return scratchPath;
}

describe('sweepBotErrorsOutboxTemps promote scratch files', () => {
  it('retires a promote scratch older than the TTL with a breadcrumb, and keeps a younger one', async () => {
    const { outbox, writefail } = setup();
    const mod = await importOutbox();
    mod.setBotErrorsOutboxTempProcessProbeForTests(() => ({ alive: false }));
    const stale = plantPromoteScratch(outbox, 4851, 25 * HOUR_MS);
    const young = plantPromoteScratch(outbox, 4852, HOUR_MS);

    const result = mod.sweepBotErrorsOutboxTemps();

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(young)).toBe(true);
    expect(result.scratchRetired).toBe(1);
    const breadcrumbs = retirementBreadcrumbs(writefail);
    expect(breadcrumbs).toHaveLength(1);
    expect(breadcrumbs[0]).toMatchObject({
      kind: 'outbox_temp_retired',
      class: 'stale-promote-scratch',
      tempName: stale.slice(outbox.length + 1),
      pid: 4851,
    });
    expect(Object.keys(breadcrumbs[0]!).sort()).toEqual(RETIRE_BREADCRUMB_KEYS);
    // Litter, not a lost alert: no summary.
    expect(summaryEvents(outbox)).toEqual([]);
  });

  it('keeps a stale promote scratch when no breadcrumb can be written', async () => {
    const { outbox } = setup();
    blockAllWritefailDirs();
    const mod = await importOutbox();
    mod.setBotErrorsOutboxTempProcessProbeForTests(() => ({ alive: false }));
    const stale = plantPromoteScratch(outbox, 4853, 25 * HOUR_MS);

    const result = mod.sweepBotErrorsOutboxTemps();

    expect(existsSync(stale)).toBe(true);
    expect(result.scratchRetired ?? 0).toBe(0);
  });
});

const FIFO_PLATFORM = process.platform === 'linux' || process.platform === 'darwin';

/** mkfifo by absolute path, never through PATH. */
function mkfifoBinary(): string {
  for (const dir of ['/usr/bin', '/bin']) {
    const candidate = join(dir, 'mkfifo');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('mkfifo not found in /usr/bin or /bin');
}

function makeFifo(path: string): boolean {
  return spawnSync(mkfifoBinary(), [path], { stdio: 'ignore' }).status === 0;
}

// Timing for the FIFO tests. If the sweep's open blocks on the FIFO (the
// O_NONBLOCK-removed mutant), it waits until the delayed writer opens the write
// end at 10 s, reads EOF and returns, so the test FAILS on the elapsed bound
// (8 s) well before the 20 s test timeout, instead of hanging the worker. A
// correct sweep never waits, leaving 8 s of headroom on a loaded host.
const FIFO_WRITER_DELAY_MS = 10_000;
const FIFO_ELAPSED_BOUND_MS = 8_000;
const FIFO_TEST_TIMEOUT_MS = 20_000;
// The delay runs inside the child: the parent's own timers cannot fire while a
// synchronous open blocks it. One node process and no grandchild, so SIGKILL
// removes the timer and the pending writer together.
const DELAYED_FIFO_WRITER_SOURCE = "const fs = require('node:fs');"
  + ' setTimeout(() => { fs.closeSync(fs.openSync(process.argv[1], "w")); }, Number(process.argv[2]));';

function startDelayedFifoWriter(fifoPath: string): ChildProcess {
  const writer = spawn(
    process.execPath,
    ['-e', DELAYED_FIFO_WRITER_SOURCE, fifoPath, String(FIFO_WRITER_DELAY_MS)],
    { stdio: 'ignore' },
  );
  // afterEach also kills anything left in liveChildren, as a backstop.
  liveChildren.add(writer);
  return writer;
}

/** Kill the delayed writer (its timer, or its open blocked on the FIFO). */
function stopDelayedFifoWriter(writer: ChildProcess): void {
  writer.kill('SIGKILL');
  liveChildren.delete(writer);
}

describe('sweepBotErrorsOutboxTemps FIFO safety', () => {
  it.runIf(FIFO_PLATFORM)('skips a FIFO with the temp name without opening it', async () => {
    const { outbox, writefail } = setup();
    const mod = await importOutbox();
    mod.setBotErrorsOutboxTempProcessProbeForTests(() => ({ alive: false }));
    const fifoPath = join(outbox, `.${finalNameFor({
      createdAt: new Date(Date.now() - PAST_GRACE_MS).toISOString(),
      instance: 'unit',
      source: 'temp-sweep-unit',
      id: randomUUID(),
    })}.4741.tmp`);
    expect(makeFifo(fifoPath)).toBe(true);
    backdate(fifoPath, PAST_GRACE_MS);
    const writer = startDelayedFifoWriter(fifoPath);
    try {
      const startedAt = Date.now();
      const result = mod.sweepBotErrorsOutboxTemps();

      expect(Date.now() - startedAt).toBeLessThan(FIFO_ELAPSED_BOUND_MS);
      expect(result.scanned).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.errors).toBe(0);
      expect(lstatSync(fifoPath).isFIFO()).toBe(true);
      expect(retirementBreadcrumbs(writefail)).toEqual([]);
    } finally {
      stopDelayedFifoWriter(writer);
    }
  }, FIFO_TEST_TIMEOUT_MS);

  it.runIf(FIFO_PLATFORM)(
    'refuses, without blocking, a temp swapped for a FIFO between the lstat and the open',
    async () => {
      const { outbox, writefail } = setup();
      const mod = await importOutbox();
      const planted = plantTemp(mod, outbox, { pid: 4742, mtimeAgeMs: PAST_GRACE_MS });
      let fifoMade = false;
      let writer: ChildProcess | undefined;
      mod.setBotErrorsOutboxTempProcessProbeForTests(() => {
        unlinkSync(planted.tempPath);
        fifoMade = makeFifo(planted.tempPath);
        if (fifoMade) writer = startDelayedFifoWriter(planted.tempPath);
        return { alive: false };
      });

      try {
        const startedAt = Date.now();
        const result = mod.sweepBotErrorsOutboxTemps();
        const elapsedMs = Date.now() - startedAt;

        expect(fifoMade).toBe(true);
        // The open neither blocked nor produced a retirement: refused as an error.
        expect(elapsedMs).toBeLessThan(FIFO_ELAPSED_BOUND_MS);
        expect(result.errors).toBe(1);
        expect(result.promoted).toBe(0);
        expect(result.retired).toEqual({
          'torn': 0, 'schema-invalid': 0, 'unsafe-content': 0, 'stale-ttl': 0, 'already-published': 0,
        });
        expect(result.retireDeferred).toBe(0);
        expect(lstatSync(planted.tempPath).isFIFO()).toBe(true);
        expect(existsSync(planted.finalPath)).toBe(false);
        expect(retirementBreadcrumbs(writefail)).toEqual([]);
      } finally {
        if (writer) stopDelayedFifoWriter(writer);
      }
    },
    FIFO_TEST_TIMEOUT_MS,
  );
});

describe('sweepBotErrorsOutboxTemps content-free records', () => {
  it('writes breadcrumbs of every class with metadata keys only, and a summary that names no orphan', async () => {
    const { outbox, writefail } = setup();
    const mod = await importOutbox();
    mod.setBotErrorsOutboxTempProcessProbeForTests(() => ({ alive: false }));
    plantTornTemp(outbox, 4671);
    plantTemp(mod, outbox, { pid: 4672, mtimeAgeMs: PAST_GRACE_MS, mutate: (event) => { event.schemaVersion = 1; } });
    plantTemp(mod, outbox, { pid: 4673, mtimeAgeMs: 25 * HOUR_MS });
    const published = plantTemp(mod, outbox, { pid: 4674, mtimeAgeMs: PAST_GRACE_MS });
    writeFileSync(published.finalPath, '{"published":"by-the-original-rename"}\n', { mode: 0o600 });

    mod.sweepBotErrorsOutboxTemps();

    const breadcrumbs = retirementBreadcrumbs(writefail);
    expect(breadcrumbs.map((crumb) => crumb.class).sort()).toEqual(
      ['already-published', 'schema-invalid', 'stale-ttl', 'torn'],
    );
    for (const crumb of breadcrumbs) {
      expect(Object.keys(crumb).sort()).toEqual(RETIRE_BREADCRUMB_KEYS);
      expect(crumb.kind).toBe('outbox_temp_retired');
    }
    const summaries = summaryEvents(outbox);
    expect(summaries).toHaveLength(1);
    // The orphans' source is metadata of the lost alerts, not of the summary.
    expect(JSON.stringify(summaries[0])).not.toContain('temp-sweep-unit');
  });
});

describe('probeOutboxTempProcess', () => {
  it('reports a reaped pid as not alive', async () => {
    setup();
    const mod = await importOutbox();
    expect(mod.probeOutboxTempProcess(mintDeadPid())).toEqual({ alive: false });
  });

  it.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'reports a live process with a start time bracketed by its spawn',
    async () => {
      setup();
      const mod = await importOutbox();
      const before = Date.now();
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
      liveChildren.add(child);
      const after = Date.now();

      const state = mod.probeOutboxTempProcess(child.pid!);

      expect(state.alive).toBe(true);
      if (!state.alive) return;
      expect(state.startedAtMs).not.toBeNull();
      // Both platform sources have one-second resolution and can only read early.
      expect(state.startedAtMs!).toBeGreaterThanOrEqual(before - 2_000);
      expect(state.startedAtMs!).toBeLessThanOrEqual(after + 1_000);
    },
    15_000,
  );
});
