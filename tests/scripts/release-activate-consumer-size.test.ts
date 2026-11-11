/**
 * release:activate reads the loaded BOT ERRORS health consumer's manifest,
 * runner and checker through one bounded reader. The other activation tests
 * use one-line consumer bodies, so they cannot see a read cap smaller than the
 * real files. These cases use consumer files at real sizes, and a ratchet keeps
 * the repo's own consumer files well under the cap. All identifiers are
 * fabricated.
 */
import { statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RELEASE_ACTIVATE_EXIT } from '../../scripts/release-activate.ts';
import { BOT_ERRORS_HEALTH_CONSUMER_MAX_BYTES } from '../../scripts/lib/release-activation/plan.ts';
import {
  activationArgs,
  botErrorsHealthPrint,
  type Fixture,
  installFixture,
  INSTANCE,
  run,
  SimulatedLaunchd,
  writeBotErrorsRuntime,
} from '../helpers/release-activate-world.ts';

const CHECKER = 'deploy/scripts/bot-errors-health-check.py';
const CONSUMER_FILES = ['deploy/bot-errors-runtime-manifest.json', 'deploy/scripts/bot-errors-runner.py', CHECKER];

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

/** A fabricated checker of exactly `size` bytes that still carries the sealed selector marker. */
function checkerOfSize(size: number): string {
  const header = '# fabricated BOT ERRORS health checker forwards CLAUDE_SECURESTORAGE_CONFIG_DIR\n';
  const line = `#${'-'.repeat(78)}\n`;
  const body = header + line.repeat(Math.ceil((size - header.length) / line.length));
  return body.slice(0, size - 1) + '\n';
}

function consumerCheck(result: Awaited<ReturnType<typeof run>>): { ok: boolean; detail: string } | undefined {
  return (result.json.preconditions as Array<{ id: string; ok: boolean; detail: string }>)
    .find((entry) => entry.id === 'bot-errors-health-consumer-compatible');
}

describe('release:activate BOT ERRORS consumer read cap', () => {
  it('accepts a loaded consumer whose checker is larger than 256 KiB, as the real checker is', async () => {
    const checkerBody = checkerOfSize(300 * 1024);
    expect(Buffer.byteLength(checkerBody)).toBe(300 * 1024);
    writeBotErrorsRuntime(fixture.newRelease, { requirement: 1 });
    writeBotErrorsRuntime(fixture.oldRelease, { capability: 2, checkerBody });
    const world = new SimulatedLaunchd(fixture, {
      botErrorsHealthPrint: () => ({ code: 0, stdout: botErrorsHealthPrint(fixture, fixture.oldRelease), stderr: '' }),
    });

    const result = await run(world, activationArgs(fixture));

    expect(consumerCheck(result)).toMatchObject({ ok: true });
    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.ok);
    expect(result.json.ready).toBe(true);
    expect(world.mutatingCalls()).toEqual([]);
  });

  it('refuses a consumer checker over the read cap and names the file and the cap', async () => {
    writeBotErrorsRuntime(fixture.newRelease, { requirement: 1 });
    writeBotErrorsRuntime(fixture.oldRelease, { capability: 2, checkerBody: checkerOfSize(BOT_ERRORS_HEALTH_CONSUMER_MAX_BYTES + 1) });
    const world = new SimulatedLaunchd(fixture, {
      botErrorsHealthPrint: () => ({ code: 0, stdout: botErrorsHealthPrint(fixture, fixture.oldRelease), stderr: '' }),
    });

    const result = await run(world, activationArgs(fixture));

    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.refused);
    const check = consumerCheck(result);
    expect(check).toMatchObject({ ok: false });
    expect(check!.detail).toContain(CHECKER);
    expect(check!.detail).toContain(`larger than the ${BOT_ERRORS_HEALTH_CONSUMER_MAX_BYTES}-byte read cap`);
    expect(world.mutatingCalls()).toEqual([]);
  });

  it.each(CONSUMER_FILES)("keeps the repo's own %s under half the read cap", (relative) => {
    const size = statSync(new URL(`../../${relative}`, import.meta.url)).size;
    expect(size).toBeLessThan(BOT_ERRORS_HEALTH_CONSUMER_MAX_BYTES / 2);
  });
});
