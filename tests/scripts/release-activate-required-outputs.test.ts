/**
 * Host-built required outputs (manifest v2 `requiredOutputs`, the built console) against an isolated simulated
 * launchd world. Test titles keep the release:activate --plan/--apply describe labels so qualification full-name
 * membership is unchanged for the case moved here from release-activate.test.ts.
 */
import { mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RELEASE_ACTIVATE_EXIT } from '../../scripts/release-activate.ts';
import {
  activationArgs,
  type Fixture,
  installFixture,
  INSTANCE,
  run,
  SimulatedLaunchd,
} from '../helpers/release-activate-world.ts';

let fixture: Fixture;

function useFixture(next: Fixture): void {
  fixture = next;
  vi.stubEnv('HOME', fixture.home);
  vi.stubEnv('XDG_CONFIG_HOME', path.join(fixture.home, '.config'));
  vi.stubEnv('XDG_DATA_HOME', path.join(fixture.home, '.local', 'share'));
  vi.stubEnv('XDG_STATE_HOME', path.join(fixture.home, '.local', 'state'));
  vi.stubEnv('WHATSOUP_HEALTH_TOKEN', undefined);
  vi.stubEnv(`BOT_ERRORS_HEALTH_TOKEN_${INSTANCE.replace(/-/g, '_').toUpperCase()}`, undefined);
}

beforeEach(() => {
  useFixture(installFixture());
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Make the new release's manifest require the built console; returns the output's path. */
function requireConsoleOutput(): string {
  const manifestPath = path.join(fixture.newRelease, '.whatsoup-release-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { requiredOutputs?: string[] };
  manifest.requiredOutputs = ['dist/index.html'];
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return path.join(fixture.newRelease, 'dist/index.html');
}

function writeBuiltConsole(output: string): void {
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, '<!doctype html><html></html>\n');
}

function failedPreconditions(json: Record<string, unknown>): Array<{ id: string; ok: boolean; detail: string }> {
  return (json.preconditions as Array<{ id: string; ok: boolean; detail: string }>).filter((entry) => !entry.ok);
}

describe('release:activate --plan', () => {
  it('refuses a new release until the host-built outputs its manifest requires exist', async () => {
    const world = new SimulatedLaunchd(fixture);
    const output = requireConsoleOutput();

    const refused = await run(world, activationArgs(fixture));
    expect(refused.code).toBe(RELEASE_ACTIVATE_EXIT.refused);
    const failed = failedPreconditions(refused.json);
    expect(failed.map((entry) => entry.id)).toEqual(['release-required-outputs-present']);
    expect(failed[0]?.detail).toContain('dist/index.html');

    writeBuiltConsole(output);
    const planned = await run(world, activationArgs(fixture));
    expect(failedPreconditions(planned.json)).toEqual([]);
  });

  // The fleet serves the console only as a regular file confined to the release
  // (src/fleet/static.ts), so anything else at the output path is not a build.
  it.each([
    ['a directory', (output: string) => mkdirSync(output, { recursive: true })],
    ['a symlink to a file outside the release', (output: string) => {
      const outside = path.join(fixture.base, 'outside-index.html');
      writeFileSync(outside, '<!doctype html><html></html>\n');
      mkdirSync(path.dirname(output), { recursive: true });
      symlinkSync(outside, output);
    }],
    ['a regular file below a symlinked dist directory', (output: string) => {
      const outsideDist = path.join(fixture.base, 'outside-dist');
      writeBuiltConsole(path.join(outsideDist, 'index.html'));
      symlinkSync(outsideDist, path.dirname(output));
    }],
  ])('refuses a required output that is %s', async (_kind, place) => {
    const world = new SimulatedLaunchd(fixture);
    place(requireConsoleOutput());

    const refused = await run(world, activationArgs(fixture));

    expect(refused.code).toBe(RELEASE_ACTIVATE_EXIT.refused);
    expect(failedPreconditions(refused.json).map((entry) => entry.id)).toEqual(['release-required-outputs-present']);
  });
});

describe('release:activate --apply', () => {
  it('rechecks the host-built outputs immediately before switching', async () => {
    const output = requireConsoleOutput();
    writeBuiltConsole(output);
    // A host writer removes the build after planning, while apply stages the plists.
    const world = new SimulatedLaunchd(fixture, {
      onExec: (file) => {
        if (file === 'plutil') rmSync(output, { force: true });
      },
    });

    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.refused);
    expect(result.json.outcome).toBe('refused');
    expect(String(result.json.failure)).toContain('dist/index.html');
    expect(readlinkSync(fixture.wrapperLink)).toBe(path.join(fixture.oldRelease, 'deploy', 'whatsoup'));
    expect(world.mutatingCalls()).toEqual([]);
  });

  // The recheck must use the outputs the plan checked, not whatever the manifest
  // says at switch time: an edited manifest could otherwise drop the requirement.
  it('refuses a candidate manifest whose requiredOutputs changed after planning', async () => {
    const output = requireConsoleOutput();
    writeBuiltConsole(output);
    const manifestPath = path.join(fixture.newRelease, '.whatsoup-release-manifest.json');
    // A host writer drops the requirement and the build after planning, while apply stages the plists.
    const world = new SimulatedLaunchd(fixture, {
      onExec: (file) => {
        if (file !== 'plutil') return;
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { requiredOutputs?: string[] };
        manifest.requiredOutputs = [];
        writeFileSync(manifestPath, JSON.stringify(manifest));
        rmSync(output, { force: true });
      },
    });

    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.refused);
    expect(result.json.outcome).toBe('refused');
    expect(String(result.json.failure)).toContain('requiredOutputs changed');
    expect(readlinkSync(fixture.wrapperLink)).toBe(path.join(fixture.oldRelease, 'deploy', 'whatsoup'));
    expect(world.mutatingCalls()).toEqual([]);
  });
});
