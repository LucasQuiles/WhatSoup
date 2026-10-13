/**
 * #3703 T6 — release:activate must not stop an instance that is holding a live
 * turn. The stop preflight (`scripts/restart-safety-preflight.ts --mode stop`,
 * exit 3 = open inbound received in the last 15 min) exists but has no caller;
 * the activation's `reload` step boots the instance out unconditionally.
 *
 * Contract pinned here (activation-tool ORDERING and fail-closed behaviour only):
 *  - the apply runs the stop preflight against the instance database before
 *    the instance's `launchctl bootout`;
 *  - while the preflight exits 3 the apply waits and re-checks, bounded;
 *  - past the bound it fails CLOSED: refused, no bootout/bootstrap/kickstart,
 *    the wrapper symlink and plists untouched.
 * There is no stop override. A blocked apply is refused; nothing here may be
 * satisfied by adding one.
 *
 * What these cases do NOT prove:
 *  - That no work enters between the check and the bootout. The running
 *    transport ingests asynchronously, without any activation-tool call, so
 *    the order of tool calls says nothing about admission in that gap.
 *  - Anything about the FIRST old-to-new cutover. That stop is executed by the
 *    OLD release's shutdown, which finalizes an in-flight turn failed
 *    (mini2 ar-bot 3603). That boundary stays separate. It needs the accepted
 *    admission/drain/ownership property shown through the actual supported
 *    route before rollout.
 *  - That an older turn is dead. The preflight's 15-minute horizon is pinned
 *    separately in stop-safety-gate.test.ts.
 *
 * History: committed red as `it.fails` at 50100084e (native failures in
 * docs/superpowers/specs/2026-10-13-3703-planned-stop-handoff-design.md),
 * promoted to plain assertions with the stop gate in
 * scripts/lib/release-activation/apply.ts.
 *
 * Harness: the simulated launchd world of release-activate.test.ts, with the
 * preflight exec answered by a scripted verdict sequence.
 */
import { readFileSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RELEASE_ACTIVATE_EXIT } from '../../scripts/release-activate.ts';
import type { ActivationHost } from '../../scripts/lib/release-activation/host.ts';
import {
  activationArgs,
  type Fixture,
  installFixture,
  INSTANCE,
  INSTANCE_LABEL,
  run,
  SimulatedLaunchd,
  type WorldOptions,
} from '../helpers/release-activate-world.ts';

const PREFLIGHT_SCRIPT = 'restart-safety-preflight.ts';

function verdict(code: number): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    ok: code === 0,
    decision: code === 0 ? 'allow' : 'block',
    reason: code === 0 ? 'stop_safe' : 'live_turns_in_flight',
    quickCheck: 'ok',
    liveTurns: { inFlight: code === 0 ? 0 : 1, staleIgnored: 0, windowSeconds: 900 },
  })}\n`;
}

/** The simulated world, with the stop preflight answered from a scripted verdict sequence (last value repeats). */
class GatedLaunchd extends SimulatedLaunchd {
  /** Index into `calls` of every preflight exec, and the tool clock at each. */
  readonly preflightAt: number[] = [];
  readonly preflightClock: number[] = [];

  constructor(fixture: Fixture, private readonly verdicts: readonly number[], options: WorldOptions = {}) {
    super(fixture, options);
  }

  override host(): ActivationHost {
    const base = super.host();
    return {
      ...base,
      exec: async (file, args, options) => {
        if (![file, ...args].some((arg) => arg.endsWith(PREFLIGHT_SCRIPT))) return base.exec(file, args, options);
        this.calls.push([file, ...args]);
        this.preflightAt.push(this.calls.length - 1);
        this.preflightClock.push(base.now());
        const code = this.verdicts[Math.min(this.preflightAt.length - 1, this.verdicts.length - 1)]!;
        return { code, stdout: verdict(code), stderr: '' };
      },
    };
  }

  preflightCalls(): string[][] {
    return this.preflightAt.map((index) => this.calls[index]!);
  }

  instanceBootoutAt(): number {
    return this.calls.findIndex(([file, verb, target]) =>
      file === 'launchctl' && verb === 'bootout' && target?.endsWith(`/${INSTANCE_LABEL}`));
  }
}

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

describe('release:activate --apply: stop gate before reload (#3703 T6)', () => {
  it('T6a: runs the stop preflight on the instance database before the instance bootout (ordering only)', async () => {
    const world = new GatedLaunchd(fixture, [0]);

    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(world.preflightCalls().length).toBeGreaterThanOrEqual(1);
    const last = world.preflightCalls().at(-1)!;
    expect(last).toEqual(expect.arrayContaining(['--mode', 'stop', '--db', fixture.dbPath, '--json']));
    // Ordering only: the check precedes the stop. This cannot show that no work
    // is admitted in between (the old transport ingests without a tool call).
    expect(world.preflightAt.at(-1)!).toBeLessThan(world.instanceBootoutAt());
    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.ok);
  });

  it('T6b: while the preflight exits 3 the apply waits and re-checks, then proceeds once it is quiet', async () => {
    const world = new GatedLaunchd(fixture, [3, 3, 0]);

    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(world.preflightAt).toHaveLength(3);
    // It waited between checks (the simulated clock only moves on host.sleep).
    expect(world.preflightClock[1]!).toBeGreaterThan(world.preflightClock[0]!);
    expect(world.preflightClock[2]!).toBeGreaterThan(world.preflightClock[1]!);
    expect(world.preflightAt.at(-1)!).toBeLessThan(world.instanceBootoutAt());
    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.ok);
    expect(result.json.outcome).toBe('activated');
  });

  it('T6c: past the bound it fails closed — refused, no reload, symlink and plists untouched', async () => {
    const installedPlist = readFileSync(path.join(fixture.launchAgents, `${INSTANCE_LABEL}.plist`), 'utf8');
    const world = new GatedLaunchd(fixture, [3]);

    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(world.preflightAt.length).toBeGreaterThan(1);
    expect(world.mutatingCalls()).toEqual([]);
    expect(world.isAlive(world.initialInstancePid)).toBe(true);
    expect(readlinkSync(fixture.wrapperLink)).toBe(path.join(fixture.oldRelease, 'deploy', 'whatsoup'));
    expect(readFileSync(path.join(fixture.launchAgents, `${INSTANCE_LABEL}.plist`), 'utf8')).toBe(installedPlist);
    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.refused);
    expect(result.json.outcome).toBe('refused');
  });

  it('T6 control: a quiet world still activates', async () => {
    const world = new GatedLaunchd(fixture, [0]);
    const result = await run(world, activationArgs(fixture, ['--apply']));
    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.ok);
    expect(result.json.outcome).toBe('activated');
  });
});
