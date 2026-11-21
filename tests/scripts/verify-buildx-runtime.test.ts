import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseArgs, verifyBuildxRuntime } from '../../scripts/verify-buildx-runtime.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const tmp = trackTmpDirs('verify-buildx-runtime-');

const INSPECT_OUTPUT = `Name:          whatsoup-ci-builder
Driver:        docker-container
Last Activity: 2026-10-13 20:40:02 +0000 UTC

Nodes:
Name:                  whatsoup-ci-builder0
Endpoint:              unix:///var/run/docker.sock
Status:                running
BuildKit version:      v0.33.1
Platforms:             linux/amd64
`;

function makeRepo(): string {
  const repoRoot = tmp.make('repo');
  mkdirSync(path.join(repoRoot, 'docker'), { recursive: true });
  writeFileSync(path.join(repoRoot, 'docker/container-inputs.json'), `${JSON.stringify({
    builder: {
      name: 'whatsoup-ci-builder',
      driver: 'docker-container',
    },
    buildx: {
      version: 'v0.38.0',
      buildkitImage: `moby/buildkit:v0.33.1@sha256:${'a'.repeat(64)}`,
    },
  })}\n`);
  return repoRoot;
}

function commandRunner(options: {
  version?: string;
  inspect?: string;
  failure?: Error;
  containerImage?: string;
  containerImageId?: string;
} = {}) {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const runCommand = (file: string, args: readonly string[]): string => {
    calls.push({ file, args });
    if (options.failure) throw options.failure;
    if (args.join(' ') === 'buildx version') {
      return options.version ?? 'github.com/docker/buildx v0.38.0 0a4c3b2';
    }
    if (args.join(' ') === 'buildx inspect whatsoup-ci-builder --bootstrap') {
      return options.inspect ?? INSPECT_OUTPUT;
    }
    if (args[0] === '--host' && args[2] === 'image' && args[3] === 'inspect') {
      return JSON.stringify([{ Id: `sha256:${'b'.repeat(64)}` }]);
    }
    if (args[0] === '--host' && args[2] === 'container' && args[3] === 'inspect') {
      return JSON.stringify([{
        Id: 'c'.repeat(64), Name: '/buildx_buildkit_whatsoup-ci-builder0',
        Image: options.containerImageId ?? `sha256:${'b'.repeat(64)}`,
        Config: { Image: options.containerImage ?? `moby/buildkit:v0.33.1@sha256:${'a'.repeat(64)}` },
        State: { Running: true },
      }]);
    }
    throw new Error(`unexpected command: ${file} ${args.join(' ')}`);
  };
  return { calls, runCommand };
}

describe('pinned Buildx runtime verification', () => {
  it('accepts only one explicit repository root through the shared CLI parser', () => {
    expect(parseArgs(['--repo-root', '/workspace'])).toEqual({ repoRoot: '/workspace' });
    expect(() => parseArgs([])).toThrow('usage: verify-buildx-runtime.ts --repo-root PATH');
    expect(() => parseArgs(['--repo-root'])).toThrow('usage: verify-buildx-runtime.ts --repo-root PATH');
    expect(() => parseArgs(['--repo-root', '--unknown'])).toThrow(
      'usage: verify-buildx-runtime.ts --repo-root PATH',
    );
    expect(() => parseArgs(['--repo-root', '/one', '--repo-root', '/two'])).toThrow(
      'usage: verify-buildx-runtime.ts --repo-root PATH',
    );
  });

  it('uses the v0.38 supported text interface and binds builder, driver, Buildx, and BuildKit', () => {
    const runner = commandRunner();

    expect(verifyBuildxRuntime({ repoRoot: makeRepo(), runCommand: runner.runCommand })).toEqual({
      builderName: 'whatsoup-ci-builder',
      builderDriver: 'docker-container',
      buildxVersion: 'v0.38.0',
      buildkitVersion: 'v0.33.1',
      buildkitImage: `moby/buildkit:v0.33.1@sha256:${'a'.repeat(64)}`,
      nodeName: 'whatsoup-ci-builder0', endpoint: 'unix:///var/run/docker.sock',
      containerId: 'c'.repeat(64), imageId: `sha256:${'b'.repeat(64)}`,
    });
    expect(runner.calls).toEqual([
      { file: 'docker', args: ['buildx', 'version'] },
      {
        file: 'docker',
        args: ['buildx', 'inspect', 'whatsoup-ci-builder', '--bootstrap'],
      },
      { file: 'docker', args: ['--host', 'unix:///var/run/docker.sock', 'image', 'inspect', `moby/buildkit:v0.33.1@sha256:${'a'.repeat(64)}`] },
      { file: 'docker', args: ['--host', 'unix:///var/run/docker.sock', 'container', 'inspect', 'buildx_buildkit_whatsoup-ci-builder0'] },
    ]);
    expect(runner.calls.flatMap((call) => call.args)).not.toContain('--format');
  });

  it('rejects a different builder name', () => {
    const runner = commandRunner({
      inspect: INSPECT_OUTPUT.replace('Name:          whatsoup-ci-builder', 'Name:          substituted-builder'),
    });
    expect(() => verifyBuildxRuntime({ repoRoot: makeRepo(), runCommand: runner.runCommand }))
      .toThrow('Buildx builder name differs from reviewed policy');
  });

  it('rejects a different builder driver', () => {
    const runner = commandRunner({ inspect: INSPECT_OUTPUT.replace('docker-container', 'docker') });
    expect(() => verifyBuildxRuntime({ repoRoot: makeRepo(), runCommand: runner.runCommand }))
      .toThrow('Buildx builder driver differs from reviewed policy');
  });

  it('rejects a different Buildx version', () => {
    const runner = commandRunner({ version: 'github.com/docker/buildx v0.39.0 deadbeef' });
    expect(() => verifyBuildxRuntime({ repoRoot: makeRepo(), runCommand: runner.runCommand }))
      .toThrow('Buildx version differs from reviewed policy');
  });

  it('rejects a different BuildKit version', () => {
    const runner = commandRunner({ inspect: INSPECT_OUTPUT.replace('v0.33.1', 'v0.34.0') });
    expect(() => verifyBuildxRuntime({ repoRoot: makeRepo(), runCommand: runner.runCommand }))
      .toThrow('BuildKit version differs from reviewed policy');
  });

  it('fails closed when inspect omits the BuildKit version', () => {
    const runner = commandRunner({
      inspect: INSPECT_OUTPUT.replace('BuildKit version:      v0.33.1\n', ''),
    });
    expect(() => verifyBuildxRuntime({ repoRoot: makeRepo(), runCommand: runner.runCommand }))
      .toThrow('Buildx inspect output has no unambiguous BuildKit version');
  });

  it('fails closed when inspect reports multiple BuildKit versions', () => {
    const runner = commandRunner({
      inspect: `${INSPECT_OUTPUT}BuildKit version:      v0.33.1\n`,
    });
    expect(() => verifyBuildxRuntime({ repoRoot: makeRepo(), runCommand: runner.runCommand }))
      .toThrow('Buildx inspect output has no unambiguous BuildKit version');
  });

  it('preserves command failure instead of treating an unavailable probe as a match', () => {
    const runner = commandRunner({ failure: new Error('docker daemon unavailable') });
    expect(() => verifyBuildxRuntime({ repoRoot: makeRepo(), runCommand: runner.runCommand }))
      .toThrow('docker daemon unavailable');
  });
});

it('rejects a same-version BuildKit container with a different immutable image', () => {
  const runner = commandRunner({ containerImageId: `sha256:${'d'.repeat(64)}` });
  expect(() => verifyBuildxRuntime({ repoRoot: makeRepo(), runCommand: runner.runCommand }))
    .toThrow('BuildKit container image does not match reviewed digest');
});
it('rejects a same-version BuildKit container created from another digest', () => {
  const runner = commandRunner({ containerImage: `moby/buildkit:v0.33.1@sha256:${'d'.repeat(64)}` });
  expect(() => verifyBuildxRuntime({ repoRoot: makeRepo(), runCommand: runner.runCommand }))
    .toThrow('BuildKit container image does not match reviewed digest');
});
