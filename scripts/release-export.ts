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
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { isHelpFlag, takeValue } from './lib/cli-args.ts';
import {
  stageDeploymentQualificationBundle,
  type DeploymentQualificationBundleReport,
  type DeploymentQualificationExportBinding,
} from './lib/deployment-qualification-export.ts';
import { assertNoLegacyGrafts } from './lib/ci-control/git-input-core.ts';
import { cleanGitEnv } from './lib/guard-core.ts';
import {
  RELEASE_MANIFEST_FILE,
  collectReleaseSnapshotDrift,
  createReleaseSnapshotDriftReport,
  createReleaseSnapshotPlan,
  type ReleaseSnapshotDriftReport,
  type ReleaseSnapshotManifest,
} from './release-snapshot-plan.ts';
import {
  collectSourceRuntimeIssues,
  loadSourceRuntimeManifest,
} from './source-runtime-drift-check.ts';

export interface ReleaseExportOptions {
  /** Clone of the canonical repository that contains the commit and `refs/remotes/origin/main`. */
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
  /** Optional, fully explicit immutable bundle for the deployment qualifier. */
  qualificationBundle?: DeploymentQualificationExportBinding;
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
  /** The main commit the source was proven to be (an ancestor of) at export time. */
  sourceOnMain: { ref: string; mainCommit: string };
  qualificationBundle?: DeploymentQualificationBundleReport;
  approvalPending: string;
}

/**
 * Every host runs `main` or an ancestor of it; a commit that has not landed on
 * main is backlog, not a deployable build. The check reads the local
 * remote-tracking ref of an `origin` that resolves to the canonical GitHub
 * repository, not the network: `main` there is protected against force-push,
 * so a stale ref can only refuse a landed commit (fetch, then retry), never
 * admit an unlanded one. Local `refs/heads/main` is not used because a clone
 * can carry unpushed commits there, and an `origin` that is a fork, mirror or
 * local checkout would make its own unpushed commits look landed. Replace refs
 * and legacy grafts can rewrite ancestry locally, so every git call here runs
 * with `--no-replace-objects` and a graft file refuses the export.
 */
export const RELEASE_MAIN_REF = 'refs/remotes/origin/main';
export const RELEASE_MAIN_REPOSITORY = 'github.com/LucasQuiles/WhatSoup';
const CANONICAL_ORIGIN_RE = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)LucasQuiles\/WhatSoup(?:\.git)?\/?$/i;
const FETCH_MAIN = `git fetch origin +refs/heads/main:${RELEASE_MAIN_REF}`;

function gitStatus(repoRoot: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync('git', ['--no-replace-objects', '-C', repoRoot, ...args], {
    encoding: 'utf8',
    env: cleanGitEnv(),
    timeout: 30_000,
  });
}

function mainCheckFailed(step: string, proc: ReturnType<typeof gitStatus>): Error {
  return new Error(
    `release source must be on main: ${step} failed: ${(proc.stderr || proc.error?.message || `git exited ${String(proc.status)}`).trim()}`,
  );
}

function requireCommitOnMain(repoRoot: string, commit: string): ReleaseExportReport['sourceOnMain'] {
  try {
    assertNoLegacyGrafts(repoRoot);
  } catch {
    throw new Error(
      `release source must be on main: ${repoRoot} carries legacy history grafts (info/grafts) or its git directory is unreadable; export from a clean clone`,
    );
  }

  // `--get-url` applies insteadOf rewrites and never contacts the remote. The
  // URL itself is not echoed: it can carry credentials.
  const origin = gitStatus(repoRoot, ['ls-remote', '--get-url', 'origin']);
  if (origin.status !== 0) throw mainCheckFailed('reading the origin URL', origin);
  if (!CANONICAL_ORIGIN_RE.test(origin.stdout.trim())) {
    throw new Error(
      `release source must be on main: origin does not resolve to ${RELEASE_MAIN_REPOSITORY} in ${repoRoot}; export from a clone of that repository`,
    );
  }

  // show-ref --verify takes the full ref name only; rev-parse would fall back
  // to look-alikes such as refs/heads/refs/remotes/origin/main.
  const ref = gitStatus(repoRoot, ['show-ref', '--verify', '--hash', RELEASE_MAIN_REF]);
  if (ref.status === 1 || (ref.status === 128 && /not a valid ref/.test(ref.stderr))) {
    throw new Error(
      `release source must be on main: ${RELEASE_MAIN_REF} is missing in ${repoRoot}; run \`${FETCH_MAIN}\` and retry`,
    );
  }
  if (ref.status !== 0) throw mainCheckFailed(`reading ${RELEASE_MAIN_REF}`, ref);
  const peeled = gitStatus(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref.stdout.trim()}^{commit}`]);
  const mainCommit = peeled.stdout?.trim() ?? '';
  if (peeled.status !== 0 || !/^[0-9a-f]{40}$/.test(mainCommit)) throw mainCheckFailed(`peeling ${RELEASE_MAIN_REF}`, peeled);

  const ancestry = gitStatus(repoRoot, ['merge-base', '--is-ancestor', commit, mainCommit]);
  if (ancestry.status === 0) return { ref: RELEASE_MAIN_REF, mainCommit };
  if (ancestry.status !== 1) throw mainCheckFailed('the ancestry check', ancestry);
  const shallow = gitStatus(repoRoot, ['rev-parse', '--is-shallow-repository']);
  const remedy = shallow.status === 0 && shallow.stdout.trim() === 'true'
    ? 'this clone is shallow, so older history is unknown: run `git fetch --unshallow origin` and retry'
    : `land it on main first (if it already landed, run \`${FETCH_MAIN}\` and retry)`;
  throw new Error(
    `release source must be on main: commit ${commit} is not ${RELEASE_MAIN_REF} (${mainCommit}) or an ancestor of it; ${remedy}`,
  );
}

function git(repoRoot: string, args: string[], input?: string): Buffer {
  // Replace refs would make the exported bytes differ from the named commit.
  const proc = spawnSync('git', ['--no-replace-objects', '-C', repoRoot, ...args], {
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

/**
 * A WhatSoup source-runtime manifest is an additional release contract: its
 * pinned entrypoints must agree with the exact staged export before the
 * ordinary snapshot-byte self-check publishes it. Repositories that do not
 * declare that contract keep the generic export behavior.
 */
function verifyStagedSourceRuntime(stagingRelease: string): void {
  const manifestPath = path.join(stagingRelease, 'deploy/source-runtime-manifest.json');
  if (!existsSync(manifestPath)) return;
  let issues;
  try {
    issues = collectSourceRuntimeIssues(stagingRelease, loadSourceRuntimeManifest(stagingRelease));
  } catch (error) {
    throw new Error(`release export source-runtime self-check failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (issues.length > 0) {
    const kinds = [...new Set(issues.map((issue) => issue.kind))].sort().join(', ');
    throw new Error(`release export source-runtime self-check failed (${kinds}): ${issues[0]?.message ?? ''}`);
  }
}

export function exportRelease(options: ReleaseExportOptions): ReleaseExportReport {
  const repoRoot = requireAbsolute('repoRoot', options.repoRoot);
  const releaseRoot = requireAbsolute('releaseRoot', options.releaseRoot);
  const commit = options.commit;
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`commit must be the full 40-hex object id, got: ${commit}`);
  }
  const exists = spawnSync('git', ['--no-replace-objects', '-C', repoRoot, 'cat-file', '-e', `${commit}^{commit}`], {
    env: cleanGitEnv(),
    timeout: 30_000,
  });
  if (exists.status !== 0) {
    throw new Error(`commit not found in repository ${repoRoot}: ${commit}`);
  }
  const sourceOnMain = requireCommitOnMain(repoRoot, commit);

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
    const stagedQualificationBundle = options.qualificationBundle
      ? stageDeploymentQualificationBundle({
        sourceRoot: stagingSource,
        stagingReleaseRoot: stagingRelease,
        sourceCommit: commit,
        binding: options.qualificationBundle,
      })
      : undefined;
    if (stagedQualificationBundle) {
      manifest.files = [...manifest.files, ...stagedQualificationBundle.releaseFiles]
        .sort((left, right) => left.path.localeCompare(right.path));
    }
    const manifestBody = `${JSON.stringify(manifest, null, 2)}\n`;
    writeFileSync(path.join(stagingRelease, RELEASE_MANIFEST_FILE), manifestBody, 'utf8');

    verifyStagedSourceRuntime(stagingRelease);

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
      sourceOnMain,
      qualificationBundle: stagedQualificationBundle
        ? {
          ...stagedQualificationBundle.report,
          executionRoot: path.join(releasePath, stagedQualificationBundle.report.executionRootRelativePath),
          manifestPath: path.join(releasePath, stagedQualificationBundle.report.manifestRelativePath),
        }
        : undefined,
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
  qualificationBundle?: DeploymentQualificationExportBinding;
  qualificationBundleEnabled: boolean;
  qualificationSourceCommit?: string;
  qualificationArcCommit?: string;
  qualificationQfleetCommit?: string;
  qualificationPolicyVersion?: string;
  qualificationQualifier?: string;
  qualificationSourceTestProfile?: string;
  qualificationDeploymentProfiles: string[];
  qualificationHealthHelpers: string[];
  json: boolean;
}

function parseArgs(argv: string[], cwd: string): ParsedArgs {
  const options: ParsedArgs = {
    repoRoot: cwd,
    buildTime: new Date().toISOString(),
    requiredOutputs: [],
    replace: false,
    qualificationBundleEnabled: false,
    qualificationDeploymentProfiles: [],
    qualificationHealthHelpers: [],
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string => {
      const taken = takeValue(argv, index, arg);
      index = taken.index;
      return taken.value;
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
    else if (arg === '--qualification-bundle') options.qualificationBundleEnabled = true;
    else if (arg === '--qualification-source-commit') options.qualificationSourceCommit = next();
    else if (arg === '--qualification-arc-commit') options.qualificationArcCommit = next();
    else if (arg === '--qualification-qfleet-commit') options.qualificationQfleetCommit = next();
    else if (arg === '--qualification-policy-version') options.qualificationPolicyVersion = next();
    else if (arg === '--qualification-qualifier') options.qualificationQualifier = next();
    else if (arg === '--qualification-source-test-profile') options.qualificationSourceTestProfile = next();
    else if (arg === '--qualification-deployment-profile') options.qualificationDeploymentProfiles.push(next());
    else if (arg === '--qualification-health-helper') options.qualificationHealthHelpers.push(next());
    else if (arg === '--json') options.json = true;
    else if (isHelpFlag(arg)) {
      throw new Error(
        'Usage: scripts/release-export.ts --commit <full-sha> --release-root /absolute/path [--repo-root /absolute/path] [--release-name name] [--rollback-root /absolute/path] [--source-ref label] [--build-time iso] [--required-output rel/path ...] [--replace] [--qualification-bundle --qualification-source-commit sha --qualification-arc-commit sha --qualification-qfleet-commit sha --qualification-policy-version version --qualification-qualifier path --qualification-source-test-profile path --qualification-deployment-profile path --qualification-deployment-profile path --qualification-health-helper path ...] [--json]',
      );
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!options.commit) throw new Error('--commit is required');
  if (!options.releaseRoot) throw new Error('--release-root is required');
  const qualificationArgumentsPresent = options.qualificationSourceCommit !== undefined
    || options.qualificationArcCommit !== undefined
    || options.qualificationQfleetCommit !== undefined
    || options.qualificationPolicyVersion !== undefined
    || options.qualificationQualifier !== undefined
    || options.qualificationSourceTestProfile !== undefined
    || options.qualificationDeploymentProfiles.length > 0
    || options.qualificationHealthHelpers.length > 0;
  if (!options.qualificationBundleEnabled && qualificationArgumentsPresent) {
    throw new Error('qualification bundle arguments require --qualification-bundle');
  }
  if (options.qualificationBundleEnabled) {
    const required = [
      ['--qualification-source-commit', options.qualificationSourceCommit],
      ['--qualification-arc-commit', options.qualificationArcCommit],
      ['--qualification-qfleet-commit', options.qualificationQfleetCommit],
      ['--qualification-policy-version', options.qualificationPolicyVersion],
      ['--qualification-qualifier', options.qualificationQualifier],
      ['--qualification-source-test-profile', options.qualificationSourceTestProfile],
    ].filter(([, value]) => value === undefined).map(([name]) => name);
    if (required.length > 0 || options.qualificationDeploymentProfiles.length === 0 || options.qualificationHealthHelpers.length === 0) {
      throw new Error(`qualification bundle binding is incomplete: ${[...required, '--qualification-deployment-profile', '--qualification-health-helper'].join(', ')}`);
    }
    options.qualificationBundle = {
      sourceCommit: options.qualificationSourceCommit as string,
      arcCommit: options.qualificationArcCommit as string,
      qfleetCommit: options.qualificationQfleetCommit as string,
      policyVersion: options.qualificationPolicyVersion as string,
      qualifier: options.qualificationQualifier as string,
      sourceTestProfile: options.qualificationSourceTestProfile as string,
      deploymentProfiles: options.qualificationDeploymentProfiles,
      healthHelpers: options.qualificationHealthHelpers,
    };
  }
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
    qualificationBundle: options.qualificationBundle,
  });
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`exported ${report.commit} -> ${report.releasePath}`);
    console.log(`files=${report.fileCount} tree=${report.treeSha256}`);
    console.log(`source on main: ${report.sourceOnMain.ref} ${report.sourceOnMain.mainCommit}`);
    console.log(`self-check ok=${report.selfCheck.ok}`);
    if (report.qualificationBundle) {
      console.log(`qualification bundle=${report.qualificationBundle.manifestPath} sha256=${report.qualificationBundle.manifestSha256}`);
    }
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
