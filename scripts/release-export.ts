#!/usr/bin/env node
/**
 * Release export executor — the apply mode the snapshot planner deliberately
 * does not have. Materializes a content-addressed release directory from an
 * EXACT commit (never the working tree), writes the v2 release manifest, and
 * self-verifies with the same drift checker the fleet runs, so "exported" and
 * "verifiable" can never diverge.
 *
 * The approval boundary is preserved: this script creates release bytes on
 * disk and nothing else. Repointing a service at the new release and
 * restarting it remain separately-approved host mutations, exactly as the
 * planner's `approval-required` action records.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { cleanGitEnv } from './lib/guard-core.ts';
import {
  RELEASE_MANIFEST_FILE,
  collectReleaseSnapshotDrift,
  createReleaseSnapshotDriftReport,
  createReleaseSnapshotPlan,
  type ReleaseSnapshotDriftReport,
  type ReleaseSnapshotManifest,
} from './release-snapshot-plan.ts';

export interface ReleaseExportOptions {
  /** Git repository that contains the commit (bare or work tree). */
  repoRoot: string;
  /** Full 40-hex commit id to export. Abbreviations are rejected. */
  commit: string;
  /** Absolute directory that holds release directories. */
  releaseRoot: string;
  /** Defaults to WhatSoup-release-<commit12>, matching deployed naming. */
  releaseName?: string;
  /** Defaults to <releaseRoot>/.rollback (the planner's default). */
  rollbackRoot?: string;
  /** Manifest source.ref label; defaults to the commit id itself. */
  sourceRef?: string;
  /** ISO build time recorded in the manifest. */
  buildTime: string;
  /** Release-relative build outputs that must exist (v2 requiredOutputs). */
  requiredOutputs?: readonly string[];
  /** Replace an existing release, preserving it at the rollback path. */
  replace?: boolean;
  mutablePathExcludes?: readonly string[];
}

export interface ReleaseExportReport {
  ok: true;
  commit: string;
  releasePath: string;
  manifestPath: string;
  /** Where the displaced prior release was preserved; null when none existed. */
  rollbackPath: string | null;
  fileCount: number;
  /** Digest over the sorted (path, sha256) manifest rows — the release identity. */
  treeSha256: string;
  selfCheck: ReleaseSnapshotDriftReport;
  approvalPending: string;
}

function git(repoRoot: string, args: string[], input?: string): Buffer {
  const proc = spawnSync('git', ['-C', repoRoot, ...args], {
    env: cleanGitEnv(),
    input,
    maxBuffer: 1024 * 1024 * 1024,
    timeout: 120_000,
  });
  if (proc.status !== 0) {
    throw new Error(
      (proc.stderr?.toString('utf8') || proc.error?.message || `git ${args[0]} failed`).trim(),
    );
  }
  return proc.stdout ?? Buffer.alloc(0);
}

function requireAbsolute(label: string, value: string): string {
  if (!path.isAbsolute(value)) throw new Error(`${label} must be absolute`);
  return path.resolve(value);
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Extract the exact commit tree into a staging directory via `git archive`. */
function stageCommitTree(repoRoot: string, commit: string, stagingSource: string): void {
  const archive = git(repoRoot, ['archive', '--format=tar', commit]);
  const untar = spawnSync('tar', ['-x', '-C', stagingSource], {
    input: archive,
    maxBuffer: 1024 * 1024,
    timeout: 120_000,
  });
  if (untar.status !== 0) {
    throw new Error((untar.stderr?.toString('utf8') || 'tar extraction failed').trim());
  }
}

function manifestTreeSha256(manifest: ReleaseSnapshotManifest): string {
  return sha256(manifest.files.map((file) => `${file.path}\n${file.sha256}\n`).join(''));
}

export function exportRelease(options: ReleaseExportOptions): ReleaseExportReport {
  const repoRoot = requireAbsolute('repoRoot', options.repoRoot);
  const releaseRoot = requireAbsolute('releaseRoot', options.releaseRoot);
  const commit = options.commit;
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`commit must be the full 40-hex object id, got: ${commit}`);
  }
  const exists = spawnSync('git', ['-C', repoRoot, 'cat-file', '-e', `${commit}^{commit}`], {
    env: cleanGitEnv(),
    timeout: 30_000,
  });
  if (exists.status !== 0) {
    throw new Error(`commit not found in repository ${repoRoot}: ${commit}`);
  }

  mkdirSync(releaseRoot, { recursive: true });
  const stagingRoot = mkdtempSync(path.join(releaseRoot, '.export-staging-'));
  try {
    const stagingSource = path.join(stagingRoot, 'source');
    const stagingRelease = path.join(stagingRoot, 'release');
    mkdirSync(stagingSource, { recursive: true });
    mkdirSync(stagingRelease, { recursive: true });
    stageCommitTree(repoRoot, commit, stagingSource);

    const trackedFiles = git(repoRoot, ['ls-tree', '-r', '--name-only', '-z', commit])
      .toString('utf8')
      .split('\0')
      .filter((entry) => entry.length > 0);

    const plan = createReleaseSnapshotPlan({
      sourceRoot: stagingSource,
      sourceRef: options.sourceRef ?? commit,
      sourceCommit: commit,
      releaseRoot,
      releaseName: options.releaseName,
      rollbackRoot: options.rollbackRoot,
      buildTime: options.buildTime,
      trackedFiles,
      mutablePathExcludes: options.mutablePathExcludes,
      requiredOutputs: options.requiredOutputs,
    });
    const manifest = plan.manifest;
    const releasePath = manifest.release.path;

    // Assemble the release in staging first so every failure below leaves the
    // release root untouched (fail closed: no partial release ever lands).
    for (const file of manifest.files) {
      const destination = path.join(stagingRelease, file.path);
      mkdirSync(path.dirname(destination), { recursive: true });
      cpSync(path.join(stagingSource, file.path), destination);
    }
    const manifestBody = `${JSON.stringify(manifest, null, 2)}\n`;
    writeFileSync(path.join(stagingRelease, RELEASE_MANIFEST_FILE), manifestBody, 'utf8');

    // Pre-publication self-check against the staged bytes. The manifest clone
    // only repoints release.path at the staging dir; every byte-level check is
    // identical to what the fleet drift checker will run post-publication.
    const stagedIssues = collectReleaseSnapshotDrift(stagingRelease, {
      ...manifest,
      release: { ...manifest.release, path: stagingRelease },
    });
    if (stagedIssues.length > 0) {
      const kinds = [...new Set(stagedIssues.map((issue) => issue.kind))].sort().join(', ');
      throw new Error(`release export self-check failed (${kinds}): ${stagedIssues[0]?.message ?? ''}`);
    }

    // Publication: displace an existing release only after staging proved
    // clean, and only under an explicit replace instruction.
    let rollbackPath: string | null = null;
    if (existsSync(releasePath)) {
      if (!options.replace) {
        throw new Error(`release path exists; refusing to clobber without replace: ${releasePath}`);
      }
      rollbackPath = manifest.rollback.path;
      if (existsSync(rollbackPath)) {
        throw new Error(`rollback path already occupied; refusing to overwrite prior rollback: ${rollbackPath}`);
      }
      mkdirSync(path.dirname(rollbackPath), { recursive: true });
      renameSync(releasePath, rollbackPath);
    }
    try {
      renameSync(stagingRelease, releasePath);
    } catch (error) {
      // Publication failed mid-flight: restore the displaced release so the
      // host is never left without its prior known-good bytes.
      if (rollbackPath && existsSync(rollbackPath) && !existsSync(releasePath)) {
        renameSync(rollbackPath, releasePath);
      }
      throw error;
    }

    const selfCheck = createReleaseSnapshotDriftReport(releasePath);
    if (!selfCheck.ok) {
      const quarantine = `${releasePath}.quarantine-${Date.now()}`;
      renameSync(releasePath, quarantine);
      if (rollbackPath && existsSync(rollbackPath)) renameSync(rollbackPath, releasePath);
      throw new Error(`post-publication self-check failed; release quarantined at ${quarantine}`);
    }

    return {
      ok: true,
      commit,
      releasePath,
      manifestPath: path.join(releasePath, RELEASE_MANIFEST_FILE),
      rollbackPath,
      fileCount: manifest.files.length,
      treeSha256: manifestTreeSha256(manifest),
      selfCheck,
      approvalPending:
        'repoint-launchd-and-restart: release bytes exported only; service repoint/restart remain separately-approved host mutations',
    };
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

interface ParsedArgs {
  repoRoot: string;
  commit?: string;
  releaseRoot?: string;
  releaseName?: string;
  rollbackRoot?: string;
  sourceRef?: string;
  buildTime: string;
  requiredOutputs: string[];
  replace: boolean;
  json: boolean;
}

function parseArgs(argv: string[], cwd: string): ParsedArgs {
  const options: ParsedArgs = {
    repoRoot: cwd,
    buildTime: new Date().toISOString(),
    requiredOutputs: [],
    replace: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string => {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === '--repo-root') options.repoRoot = next();
    else if (arg === '--commit') options.commit = next();
    else if (arg === '--release-root') options.releaseRoot = next();
    else if (arg === '--release-name') options.releaseName = next();
    else if (arg === '--rollback-root') options.rollbackRoot = next();
    else if (arg === '--source-ref') options.sourceRef = next();
    else if (arg === '--build-time') options.buildTime = next();
    else if (arg === '--required-output') options.requiredOutputs.push(next());
    else if (arg === '--replace') options.replace = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') {
      throw new Error(
        'Usage: scripts/release-export.ts --commit <full-sha> --release-root /absolute/path [--repo-root /absolute/path] [--release-name name] [--rollback-root /absolute/path] [--source-ref label] [--build-time iso] [--required-output rel/path ...] [--replace] [--json]',
      );
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!options.commit) throw new Error('--commit is required');
  if (!options.releaseRoot) throw new Error('--release-root is required');
  return options;
}

export function run(argv: string[] = process.argv.slice(2), cwd = process.cwd()): ReleaseExportReport {
  const options = parseArgs(argv, cwd);
  const report = exportRelease({
    repoRoot: options.repoRoot,
    commit: options.commit as string,
    releaseRoot: options.releaseRoot as string,
    releaseName: options.releaseName,
    rollbackRoot: options.rollbackRoot,
    sourceRef: options.sourceRef,
    buildTime: options.buildTime,
    requiredOutputs: options.requiredOutputs,
    replace: options.replace,
  });
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`exported ${report.commit} -> ${report.releasePath}`);
    console.log(`files=${report.fileCount} tree=${report.treeSha256}`);
    console.log(`self-check ok=${report.selfCheck.ok}`);
    console.log(`pending approval: ${report.approvalPending}`);
  }
  return report;
}

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  try {
    run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
