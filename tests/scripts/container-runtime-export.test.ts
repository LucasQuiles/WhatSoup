import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const workflow = parse(readFileSync(path.join(repoRoot, '.github/workflows/quality.yml'), 'utf8')) as {
  jobs: { quality: { steps: { name: string; run?: string }[] } };
};
const tmp = trackTmpDirs('container-runtime-export-');
const revision = 'b'.repeat(40);
const imageId = `sha256:${'a'.repeat(64)}`;

function runExport(options: { receipt?: Record<string, unknown>; loadedImage?: string; buildExit?: number; sourceRef?: string } = {}) {
  const step = workflow.jobs.quality.steps.find((entry) => entry.name === 'Load verified deployment image and runtime providers');
  expect(step?.run).toBeTypeOf('string');
  const root = tmp.make('runtime');
  const bin = path.join(root, 'bin');
  const containerDir = path.join(root, 'whatsoup-container');
  mkdirSync(bin);
  mkdirSync(containerDir);
  mkdirSync(path.join(root, 'docker'));
  writeFileSync(path.join(root, 'docker/container-inputs.json'), readFileSync(path.join(repoRoot, 'docker/container-inputs.json')));
  writeFileSync(path.join(containerDir, 'container-build-receipt.json'), JSON.stringify({
    schemaVersion: 4,
    imageConfigDigest: imageId,
    sourceRevision: revision,
    sourceRepository: 'https://github.com/contributor/WhatSoup.git',
    builder: 'whatsoup-ci-builder|docker-container',
    platform: 'linux/amd64',
    ...options.receipt,
  }));
  const callsPath = path.join(root, 'docker-calls.jsonl');
  writeFileSync(callsPath, '');
  writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS_PATH, JSON.stringify(args) + '\\n');
if (args[0] === 'buildx' && args[1] === 'build') process.exit(Number(process.env.BUILD_EXIT));
if (args[0] === 'image' && args[1] === 'inspect') { console.log(process.env.LOADED_IMAGE); process.exit(0); }
if (args[0] === 'run') process.exit(0);
process.exit(2);
`, { mode: 0o755 });
  const result = spawnSync('bash', ['-c', step!.run!], {
    cwd: root,
    encoding: 'utf8',
    timeout: 5000,
    env: {
      ...process.env,
      PATH: `${bin}:${path.dirname(process.execPath)}:${process.env.PATH}`,
      RUNNER_TEMP: root,
      SOURCE_REVISION: revision,
      SOURCE_REF: options.sourceRef ?? revision,
      CALLS_PATH: callsPath,
      LOADED_IMAGE: options.loadedImage ?? imageId,
      BUILD_EXIT: String(options.buildExit ?? 0),
    },
  });
  expect(result.error).toBeUndefined();
  const calls = readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]);
  return { result, calls };
}

describe('verified container runtime export', () => {
  it('loads the exact reviewed fork source and imports providers by its verified immutable image identity', () => {
    const { result, calls } = runExport();
    expect(result.status, result.stderr).toBe(0);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual([
      'buildx', 'build', '--builder', 'whatsoup-ci-builder', '--file', 'docker/Dockerfile',
      '--platform', 'linux/amd64', '--tag', 'whatsoup-ci', '--provenance=false', '--sbom=false',
      '--load', `https://github.com/contributor/WhatSoup.git#${revision}`,
    ]);
    expect(calls[1]).toEqual(['image', 'inspect', '--format', '{{.Id}}', 'whatsoup-ci']);
    expect(calls[2]?.slice(0, 9)).toEqual(['run', '--rm', '--network', 'none', '--pull=never', '--entrypoint', 'node', imageId, '--experimental-strip-types']);
    expect(calls[2]?.at(-1)).toContain("await import('./src/runtimes/chat/providers/transcription/chain.ts')");
  });

  it.each([
    { imageConfigDigest: undefined },
    { imageConfigDigest: 'untrusted-image:latest' },
    { sourceRevision: 'c'.repeat(40) },
    { sourceRepository: 'https://example.invalid/unreviewed.git' },
  ])('refuses an unusable or differently bound receipt before exporting: %j', (receipt) => {
    const { result, calls } = runExport({ receipt });
    expect(result.status).not.toBe(0);
    expect(calls).toEqual([]);
  });

  it('refuses a loaded image that differs from the verified OCI configuration', () => {
    const { result, calls } = runExport({ loadedImage: `sha256:${'c'.repeat(64)}` });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('loaded runtime image differs from verified OCI configuration');
    expect(calls.map((args) => args[0])).toEqual(['buildx', 'image']);
  });

  it('exports a pull request through its merge ref, bound to the checked-out merge commit', () => {
    const { result, calls } = runExport({ sourceRef: 'refs/pull/7/merge' });
    expect(result.status, result.stderr).toBe(0);
    expect(calls[0]?.at(-1)).toBe('https://github.com/contributor/WhatSoup.git#refs/pull/7/merge');
  });

  it.each(['refs/pull/7/head', 'refs/heads/main', 'c'.repeat(40)])(
    'refuses source ref %s before exporting', (sourceRef) => {
      const { result, calls } = runExport({ sourceRef });
      expect(result.status).not.toBe(0);
      expect(calls).toEqual([]);
    },
  );

  it('runs the Linux policy probe after the verified load, on the loaded image, without a registry pull', () => {
    const steps = workflow.jobs.quality.steps;
    const load = steps.findIndex((step) => step.name === 'Load verified deployment image and runtime providers');
    const probe = steps.findIndex((step) => step.name === 'Verify Linux policy ownership and controller readability');
    expect(load).toBeGreaterThanOrEqual(0);
    expect(probe).toBeGreaterThan(load);
    const run = steps[probe]!.run ?? '';
    expect(run).toMatch(/docker run [^\n]*--pull=never/);
    expect(run).toContain('--entrypoint node whatsoup-ci /policy-probe.mjs');
    // No earlier step may run the tag: before the load it does not exist in the job's image store.
    for (const step of steps.slice(0, load)) expect(step.run ?? '').not.toMatch(/docker run\b/);
  });

  it('does not inspect or execute an old image after the exact-source export fails', () => {
    const { result, calls } = runExport({ buildExit: 7 });
    expect(result.status).toBe(7);
    expect(calls.map((args) => args[0])).toEqual(['buildx']);
  });
});
