import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  collectReleaseSnapshotDrift,
  createReleaseSnapshotPlan,
  parseReleaseSnapshotManifest,
} from '../../scripts/release-snapshot-plan.ts';

let tmpRoot = '';

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
  process.exitCode = undefined;
});

function makeFixtureSource(): string {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'whatsoup-release-snapshot-'));
  const sourceRoot = path.join(tmpRoot, 'source');
  mkdirSync(path.join(sourceRoot, 'src'), { recursive: true });
  writeFileSync(path.join(sourceRoot, 'package.json'), '{"name":"whatsoup-fixture"}\n', 'utf8');
  writeFileSync(path.join(sourceRoot, 'src/main.ts'), 'export const main = true;\n', 'utf8');
  return sourceRoot;
}

describe('release snapshot planning', () => {
  it('builds a deterministic dry-run manifest with rollback and exact copy actions', () => {
    const sourceRoot = makeFixtureSource();
    const plan = createReleaseSnapshotPlan({
      sourceRoot,
      sourceRef: 'main',
      sourceCommit: 'abc123def4567890',
      releaseRoot: path.join(tmpRoot, 'releases'),
      releaseName: 'WhatSoup-release-abc123def456',
      rollbackRoot: path.join(tmpRoot, 'rollback'),
      buildTime: '2026-06-13T06:00:00.000Z',
      trackedFiles: ['src/main.ts', 'package.json'],
    });

    expect(plan.manifest).toMatchObject({
      schemaVersion: 1,
      source: {
        commit: 'abc123def4567890',
        ref: 'main',
      },
      release: {
        path: path.join(tmpRoot, 'releases', 'WhatSoup-release-abc123def456'),
        createdAt: '2026-06-13T06:00:00.000Z',
        mutablePathExcludes: expect.arrayContaining(['node_modules/**', '**/*.log', '**/auth/**']),
      },
      rollback: {
        path: path.join(tmpRoot, 'rollback', 'WhatSoup-release-abc123def456-before'),
      },
    });
    expect(plan.manifest.files.map((file) => file.path)).toEqual(['package.json', 'src/main.ts']);
    expect(plan.actions).toEqual([
      expect.objectContaining({ kind: 'prepare-rollback', path: plan.manifest.rollback.path }),
      expect.objectContaining({ kind: 'create-directory', path: plan.manifest.release.path }),
      expect.objectContaining({ kind: 'copy-file', repoPath: 'package.json' }),
      expect.objectContaining({ kind: 'copy-file', repoPath: 'src/main.ts' }),
      expect.objectContaining({ kind: 'write-manifest', path: path.join(plan.manifest.release.path, '.whatsoup-release-manifest.json') }),
      expect.objectContaining({ kind: 'approval-required', operation: 'repoint-launchd-and-restart' }),
    ]);
  });

  it('parses manifests and rejects unsafe release paths', () => {
    expect(() => parseReleaseSnapshotManifest({
      schemaVersion: 1,
      source: { commit: 'abc123', ref: 'main' },
      release: {
        path: '../relative-release',
        createdAt: '2026-06-13T06:00:00.000Z',
        mutablePathExcludes: [],
      },
      rollback: { path: '/tmp/rollback' },
      files: [],
    })).toThrow(/absolute/);
  });

  it('flags code drift while ignoring mutable release paths', () => {
    const sourceRoot = makeFixtureSource();
    const releaseRoot = path.join(tmpRoot, 'releases');
    const plan = createReleaseSnapshotPlan({
      sourceRoot,
      sourceRef: 'main',
      sourceCommit: 'abc123def4567890',
      releaseRoot,
      buildTime: '2026-06-13T06:00:00.000Z',
      trackedFiles: ['package.json', 'src/main.ts'],
    });
    const releasePath = plan.manifest.release.path;
    mkdirSync(path.join(releasePath, 'src'), { recursive: true });
    writeFileSync(path.join(releasePath, 'package.json'), readFileSync(path.join(sourceRoot, 'package.json')));
    writeFileSync(path.join(releasePath, 'src/main.ts'), 'export const main = false;\n', 'utf8');
    writeFileSync(path.join(releasePath, 'src/hotpatch.ts'), 'export const hotpatch = true;\n', 'utf8');
    mkdirSync(path.join(releasePath, 'node_modules/cache'), { recursive: true });
    mkdirSync(path.join(releasePath, 'auth'), { recursive: true });
    writeFileSync(path.join(releasePath, 'node_modules/cache/file.js'), 'ignored\n', 'utf8');
    writeFileSync(path.join(releasePath, 'stdout.log'), 'ignored\n', 'utf8');
    writeFileSync(path.join(releasePath, 'auth/creds.json'), 'ignored\n', 'utf8');

    expect(collectReleaseSnapshotDrift(releasePath, plan.manifest)).toEqual([
      expect.objectContaining({ kind: 'file-sha256-drift', path: 'src/main.ts' }),
      expect.objectContaining({ kind: 'extra-file', path: 'src/hotpatch.ts' }),
    ]);
  });
});
