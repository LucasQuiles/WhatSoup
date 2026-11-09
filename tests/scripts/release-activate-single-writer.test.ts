/**
 * Activation's single-writer contract against the simulated launchd world: the
 * lock serializes writers and refuses with no change, a dead holder cannot block
 * the next run, and the identity checks catch a writer that ignored the lock.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyActivation, type ApplyOutcome } from '../../scripts/lib/release-activation/apply.ts';
import { acquireActivationLock, activationLockPath } from '../../scripts/lib/release-activation/lock.ts';
import { type ActivationContext, buildActivationContext } from '../../scripts/lib/release-activation/plan.ts';
import { parseActivationArgs } from '../../scripts/release-activate.ts';
import { acquireProcessLock, releaseProcessLock } from '../../src/lib/process-lock.ts';
import {
  activationArgs,
  diagnosticBody,
  type Fixture,
  installFixture,
  INSTANCE,
  NEW_COMMIT,
  OLD_COMMIT,
  SimulatedLaunchd,
  snapshotTree,
  TIMER_LABEL,
  type WorldOptions,
} from '../helpers/release-activate-world.ts';

let fixture: Fixture;

beforeEach(() => {
  fixture = installFixture();
  vi.stubEnv('HOME', fixture.home);
  vi.stubEnv('XDG_CONFIG_HOME', path.join(fixture.home, '.config'));
  vi.stubEnv('XDG_DATA_HOME', path.join(fixture.home, '.local', 'share'));
  vi.stubEnv('XDG_STATE_HOME', path.join(fixture.home, '.local', 'state'));
  vi.stubEnv('WHATSOUP_HEALTH_TOKEN', undefined);
  vi.stubEnv(`BOT_ERRORS_HEALTH_TOKEN_${INSTANCE.replace(/-/g, '_').toUpperCase()}`, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const FOREIGN_PLIST = '<!-- written by another writer -->\n';
const timerPlist = (): string => path.join(fixture.launchAgents, `${TIMER_LABEL}.plist`);
const oldTarget = (): string => path.join(fixture.oldRelease, 'deploy', 'whatsoup');
const newTarget = (): string => path.join(fixture.newRelease, 'deploy', 'whatsoup');

async function planned(options?: WorldOptions): Promise<{ world: SimulatedLaunchd; context: ActivationContext }> {
  const world = new SimulatedLaunchd(fixture, options);
  const context = await buildActivationContext(world.host(), parseActivationArgs(activationArgs(fixture, ['--apply'])));
  expect(context.preconditions.filter((entry) => !entry.ok)).toEqual([]);
  return { world, context };
}

function repointWrapper(target: string): void {
  unlinkSync(fixture.wrapperLink);
  symlinkSync(target, fixture.wrapperLink);
}

function expectNoLiveChange(world: SimulatedLaunchd, outcome: ApplyOutcome): void {
  expect(outcome.outcome).toBe('refused');
  expect(world.mutatingCalls()).toEqual([]);
}

describe('activation lock', () => {
  it('refuses while another writer holds it, changing nothing', async () => {
    const { world, context } = await planned();
    const holder = acquireActivationLock(fixture.home);
    const before = snapshotTree(fixture.base);

    const outcome = await applyActivation(world.host(), context);

    expectNoLiveChange(world, outcome);
    expect(outcome.backupPath).toBeNull();
    expect(outcome.steps).toEqual([expect.objectContaining({ step: 'acquire-activation-lock', ok: false })]);
    expect(snapshotTree(fixture.base)).toEqual(before);
    expect(releaseProcessLock(holder)).toBe(true);
  });

  it('lets one of two concurrent activations through and refuses the other', async () => {
    const { world, context } = await planned();
    const first = applyActivation(world.host(), context);
    const secondWorld = new SimulatedLaunchd(fixture);

    const second = await applyActivation(secondWorld.host(), context);

    expectNoLiveChange(secondWorld, second);
    expect(second.steps).toEqual([expect.objectContaining({ step: 'acquire-activation-lock', ok: false })]);
    await expect(first).resolves.toMatchObject({ outcome: 'activated' });
    expect(existsSync(activationLockPath(fixture.home))).toBe(false);
  });

  it('reclaims a lock whose holder died, so the next run is not blocked', async () => {
    const dead = spawnSync(process.execPath, ['-e', '']);
    expect(dead.status).toBe(0);
    mkdirSync(path.dirname(activationLockPath(fixture.home)), { recursive: true });
    acquireProcessLock(activationLockPath(fixture.home), { pid: dead.pid });
    const { world, context } = await planned();

    const outcome = await applyActivation(world.host(), context);

    expect(outcome.outcome).toBe('activated');
    expect(existsSync(activationLockPath(fixture.home))).toBe(false);
  });

  it('refuses a lock it cannot read, leaving the file for the operator', async () => {
    mkdirSync(path.dirname(activationLockPath(fixture.home)), { recursive: true });
    writeFileSync(activationLockPath(fixture.home), 'not a lock');
    const { world, context } = await planned();

    const outcome = await applyActivation(world.host(), context);

    expectNoLiveChange(world, outcome);
    expect(outcome.backupPath).toBeNull();
    expect(readFileSync(activationLockPath(fixture.home), 'utf8')).toBe('not a lock');
    expect(existsSync(fixture.backupDir)).toBe(false);
  });

  it('is released after a rollback and after a refusal', async () => {
    const failing = await planned({
      health: (root) => ({ status: 200, body: diagnosticBody(root === fixture.newRelease ? NEW_COMMIT : OLD_COMMIT, root !== fixture.newRelease) }),
    });
    await expect(applyActivation(failing.world.host(), failing.context)).resolves.toMatchObject({ outcome: 'rolled-back' });
    expect(existsSync(activationLockPath(fixture.home))).toBe(false);

    const refused = await planned();
    repointWrapper(path.join(fixture.base, 'foreign-release'));
    await expect(applyActivation(refused.world.host(), refused.context)).resolves.toMatchObject({ outcome: 'refused' });
    expect(existsSync(activationLockPath(fixture.home))).toBe(false);
  });
});

describe('activation identity checks', () => {
  it('refuses before the switch when the wrapper target changed after planning', async () => {
    const { world, context } = await planned();
    const foreign = path.join(fixture.base, 'foreign-release', 'deploy', 'whatsoup');
    repointWrapper(foreign);

    const outcome = await applyActivation(world.host(), context);

    expectNoLiveChange(world, outcome);
    expect(outcome.steps).toContainEqual(expect.objectContaining({ step: 'recheck-live-identity-before-switch', ok: false }));
    expect(readlinkSync(fixture.wrapperLink)).toBe(foreign);
  });

  it('refuses before the switch when an installed plist changed after planning', async () => {
    const { world, context } = await planned();
    writeFileSync(timerPlist(), FOREIGN_PLIST);

    const outcome = await applyActivation(world.host(), context);

    expectNoLiveChange(world, outcome);
    expect(outcome.failure).toContain(TIMER_LABEL);
    expect(readFileSync(timerPlist(), 'utf8')).toBe(FOREIGN_PLIST);
    expect(readlinkSync(fixture.wrapperLink)).toBe(oldTarget());
  });

  it('does not report activated over a plist another writer replaced, and does not restore over it', async () => {
    const { world, context } = await planned({
      health: (root) => {
        if (root === fixture.newRelease) writeFileSync(timerPlist(), FOREIGN_PLIST);
        return { status: 200, body: diagnosticBody(root === fixture.newRelease ? NEW_COMMIT : OLD_COMMIT, true) };
      },
    });

    const outcome = await applyActivation(world.host(), context);

    expect(outcome.outcome).toBe('rollback-unverified');
    expect(outcome.steps).toContainEqual(expect.objectContaining({ step: 'verify-live-identity', ok: false }));
    expect(outcome.rollback?.steps).toContainEqual(expect.objectContaining({ step: 'recheck-live-identity-before-instance-stop', ok: false }));
    expect(readFileSync(timerPlist(), 'utf8')).toBe(FOREIGN_PLIST);
    expect(readlinkSync(fixture.wrapperLink)).toBe(newTarget());
    expect(world.releasesStarted().filter((root) => root === fixture.oldRelease)).toHaveLength(1);
  });

  it('does not restore over a wrapper another writer replaced during the instance stop', async () => {
    const foreign = path.join(fixture.base, 'foreign-release', 'deploy', 'whatsoup');
    const { world, context } = await planned({
      health: (root) => ({ status: 200, body: diagnosticBody(root === fixture.newRelease ? NEW_COMMIT : OLD_COMMIT, root !== fixture.newRelease) }),
      onInstanceExit: (root, via) => {
        if (root === fixture.newRelease && via === 'bootout') repointWrapper(foreign);
      },
    });

    const outcome = await applyActivation(world.host(), context);

    expect(outcome.outcome).toBe('rollback-unverified');
    expect(outcome.rollback?.steps).toContainEqual(expect.objectContaining({ step: 'recheck-live-identity-before-restore', ok: false }));
    expect(readlinkSync(fixture.wrapperLink)).toBe(foreign);
    expect(world.releasesStarted().filter((root) => root === fixture.oldRelease)).toHaveLength(1);
  });
});
