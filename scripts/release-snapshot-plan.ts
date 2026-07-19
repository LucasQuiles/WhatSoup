#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { cleanGitEnv } from './lib/guard-core.ts';
import { isRecord } from '../src/lib/type-guards.ts';

export const RELEASE_MANIFEST_FILE = '.whatsoup-release-manifest.json';

export const DEFAULT_RELEASE_MUTABLE_EXCLUDES = [
  '.git/**',
  'node_modules/**',
  'artifacts/**',
  '.sweep/**',
  'coverage/**',
  '.DS_Store',
  '**/*.log',
  '**/*.db',
  '**/*.sqlite',
  '**/*.sqlite3',
  '**/auth/**',
  '**/tokens.env',
  RELEASE_MANIFEST_FILE,
] as const;

export interface ReleaseSnapshotFile {
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface ReleaseSnapshotManifest {
  /**
   * v1: files-only manifest (git-tracked files). v2: adds `requiredOutputs`,
   * release-relative paths that must exist in the release even though they are
   * not git-tracked — e.g. the built console assets under `dist/`, which are
   * gitignored and so never appear in the file list. A v1 manifest parses with
   * `requiredOutputs: []` (no required-output enforcement) for back-compat.
   */
  schemaVersion: 1 | 2;
  source: {
    ref: string;
    commit: string;
  };
  release: {
    path: string;
    createdAt: string;
    mutablePathExcludes: string[];
  };
  rollback: {
    path: string;
  };
  files: ReleaseSnapshotFile[];
  /** Release-relative build outputs that must exist (empty on legacy v1). */
  requiredOutputs: string[];
}

export type ReleaseSnapshotAction =
  | { kind: 'prepare-rollback'; path: string; condition: 'if-replacing-existing-release' }
  | { kind: 'create-directory'; path: string }
  | { kind: 'copy-file'; repoPath: string; source: string; destination: string }
  | { kind: 'write-manifest'; path: string }
  | { kind: 'approval-required'; operation: 'repoint-launchd-and-restart'; reason: string };

export interface ReleaseSnapshotPlan {
  dryRun: true;
  manifest: ReleaseSnapshotManifest;
  actions: ReleaseSnapshotAction[];
}

export type ReleaseSnapshotDriftKind =
  | 'release-missing'
  | 'manifest-missing'
  | 'manifest-release-path-mismatch'
  | 'file-missing'
  | 'file-type-drift'
  | 'file-sha256-drift'
  | 'extra-file'
  | 'required-output-missing';

export interface ReleaseSnapshotDriftIssue {
  kind: ReleaseSnapshotDriftKind;
  path?: string;
  expected?: string;
  actual?: string;
  message: string;
}

export interface ReleaseSnapshotDriftReport {
  check: 'release-drift';
  ok: boolean;
  releasePath: string;
  manifestPath: string;
  source: ReleaseSnapshotManifest['source'] | null;
  issues: ReleaseSnapshotDriftIssue[];
}

export interface CreateReleaseSnapshotPlanOptions {
  sourceRoot: string;
  sourceRef: string;
  sourceCommit: string;
  releaseRoot: string;
  releaseName?: string;
  rollbackRoot?: string;
  buildTime: string;
  trackedFiles: string[];
  mutablePathExcludes?: readonly string[];
  /** Release-relative build outputs that must exist (e.g. `dist/index.html`). */
  requiredOutputs?: readonly string[];
}

interface ParsedArgs {
  releaseRoot?: string;
  releaseName?: string;
  rollbackRoot?: string;
  checkRelease?: string;
  manifestPath?: string;
  sourceRef: string;
  buildTime: string;
  json: boolean;
}

function normalizeRepoPath(filePath: string): string {
  const normalized = filePath.split(path.sep).join('/').replace(/^\.\//, '');
  if (!normalized || path.isAbsolute(normalized) || normalized.includes('\0') || normalized.split('/').includes('..')) {
    throw new Error(`release manifest file path must be repo-relative: ${filePath}`);
  }
  return normalized;
}

function requireAbsolute(label: string, value: string): string {
  if (!path.isAbsolute(value)) throw new Error(`${label} must be absolute`);
  return path.resolve(value);
}

function safeReleaseName(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === '.' || value === '..') {
    throw new Error(`release name must be a safe single path segment: ${value}`);
  }
  return value;
}

function sha256(buffer: Buffer | string): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function readSourceFile(sourceRoot: string, repoPath: string): ReleaseSnapshotFile {
  const absolute = path.resolve(sourceRoot, repoPath);
  const relative = path.relative(sourceRoot, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`tracked file escapes source root: ${repoPath}`);
  }
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`tracked file must be a regular file: ${repoPath}`);
  }
  const body = readFileSync(absolute);
  return { path: repoPath, sha256: sha256(body), sizeBytes: body.byteLength };
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`release manifest missing ${key}`);
  return value;
}

function readStringList(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new Error(`release manifest ${key} must be a string list`);
  }
  return [...value] as string[];
}

function parseFileEntry(value: unknown, index: number): ReleaseSnapshotFile {
  if (!isRecord(value)) throw new Error(`release manifest files[${index}] must be an object`);
  const filePath = normalizeRepoPath(readString(value, 'path'));
  const fileSha = readString(value, 'sha256').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(fileSha)) throw new Error(`release manifest files[${index}] invalid sha256`);
  const sizeBytes = value['sizeBytes'];
  if (typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new Error(`release manifest files[${index}] invalid sizeBytes`);
  }
  return { path: filePath, sha256: fileSha, sizeBytes };
}

export function parseReleaseSnapshotManifest(payload: unknown): ReleaseSnapshotManifest {
  if (!isRecord(payload)) throw new Error('release snapshot manifest must be an object');
  const schemaVersion = payload['schemaVersion'];
  if (schemaVersion !== 1 && schemaVersion !== 2) {
    throw new Error(`unsupported release snapshot manifest schemaVersion=${String(schemaVersion)}`);
  }
  if (!isRecord(payload['source'])) throw new Error('release manifest source must be an object');
  if (!isRecord(payload['release'])) throw new Error('release manifest release must be an object');
  if (!isRecord(payload['rollback'])) throw new Error('release manifest rollback must be an object');
  if (!Array.isArray(payload['files'])) throw new Error('release manifest files must be a list');

  const releasePath = requireAbsolute('release.path', readString(payload['release'], 'path'));
  const rollbackPath = requireAbsolute('rollback.path', readString(payload['rollback'], 'path'));
  const files = payload['files'].map(parseFileEntry);
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.path)) throw new Error(`release manifest duplicate file ${file.path}`);
    seen.add(file.path);
  }

  // requiredOutputs is v2-only; a v1 manifest (or a v2 without the key) yields []
  // — no required-output enforcement, preserving legacy behavior. Each entry is
  // validated as repo-relative to reject absolute paths / traversal.
  const requiredOutputs = payload['requiredOutputs'] === undefined
    ? []
    : readStringList(payload, 'requiredOutputs').map(normalizeRepoPath);

  return {
    schemaVersion,
    source: {
      ref: readString(payload['source'], 'ref'),
      commit: readString(payload['source'], 'commit'),
    },
    release: {
      path: releasePath,
      createdAt: readString(payload['release'], 'createdAt'),
      mutablePathExcludes: readStringList(payload['release'], 'mutablePathExcludes'),
    },
    rollback: { path: rollbackPath },
    files,
    requiredOutputs,
  };
}

export function createReleaseSnapshotPlan(options: CreateReleaseSnapshotPlanOptions): ReleaseSnapshotPlan {
  const sourceRoot = requireAbsolute('sourceRoot', options.sourceRoot);
  const releaseRoot = requireAbsolute('releaseRoot', options.releaseRoot);
  const releaseName = safeReleaseName(options.releaseName ?? `WhatSoup-release-${options.sourceCommit.slice(0, 12)}`);
  const releasePath = path.join(releaseRoot, releaseName);
  const rollbackRoot = requireAbsolute('rollbackRoot', options.rollbackRoot ?? path.join(releaseRoot, '.rollback'));
  const rollbackPath = path.join(rollbackRoot, `${releaseName}-before`);
  const mutablePathExcludes = [...(options.mutablePathExcludes ?? DEFAULT_RELEASE_MUTABLE_EXCLUDES)];
  const files = [...new Set(options.trackedFiles.map(normalizeRepoPath))]
    .filter((filePath) => !matchesExclude(filePath, mutablePathExcludes))
    .sort()
    .map((filePath) => readSourceFile(sourceRoot, filePath));

  const requiredOutputs = [...new Set((options.requiredOutputs ?? []).map(normalizeRepoPath))].sort();

  const manifest: ReleaseSnapshotManifest = {
    schemaVersion: 2,
    source: {
      ref: options.sourceRef,
      commit: options.sourceCommit,
    },
    release: {
      path: releasePath,
      createdAt: options.buildTime,
      mutablePathExcludes,
    },
    rollback: { path: rollbackPath },
    files,
    requiredOutputs,
  };

  return {
    dryRun: true,
    manifest,
    actions: [
      { kind: 'prepare-rollback', path: rollbackPath, condition: 'if-replacing-existing-release' },
      { kind: 'create-directory', path: releasePath },
      ...files.map((file): ReleaseSnapshotAction => ({
        kind: 'copy-file',
        repoPath: file.path,
        source: path.join(sourceRoot, file.path),
        destination: path.join(releasePath, file.path),
      })),
      { kind: 'write-manifest', path: path.join(releasePath, RELEASE_MANIFEST_FILE) },
      {
        kind: 'approval-required',
        operation: 'repoint-launchd-and-restart',
        reason: 'source PR approval does not authorize live launchd/service mutation or release re-cut execution',
      },
    ],
  };
}

function matchesExclude(relPath: string, patterns: readonly string[]): boolean {
  const normalized = normalizeRepoPath(relPath);
  const base = path.posix.basename(normalized);
  return patterns.some((pattern) => {
    const candidate = pattern.split(path.sep).join('/');
    if (candidate === normalized || candidate === base) return true;
    if (candidate.endsWith('/**') && candidate.startsWith('**/')) {
      const segment = candidate.slice(3, -3).replace(/\/$/, '');
      return normalized === segment || normalized.startsWith(`${segment}/`) || normalized.includes(`/${segment}/`);
    }
    if (candidate.endsWith('/**')) {
      const prefix = candidate.slice(0, -3).replace(/\/$/, '');
      return normalized === prefix || normalized.startsWith(`${prefix}/`);
    }
    if (candidate.startsWith('**/*.')) return normalized.endsWith(candidate.slice(4));
    if (candidate.startsWith('*.')) return base.endsWith(candidate.slice(1));
    return false;
  });
}

function listFiles(root: string, mutablePathExcludes: readonly string[], current = root): string[] {
  const entries = readdirSync(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const rel = path.relative(root, absolute).split(path.sep).join('/');
    if (matchesExclude(rel, mutablePathExcludes)) continue;
    if (entry.isDirectory()) files.push(...listFiles(root, mutablePathExcludes, absolute));
    else files.push(rel);
  }
  return files.sort();
}

function fileTypeName(stat: Stats): string {
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isDirectory()) return 'directory';
  if (stat.isFile()) return 'regular-file';
  return 'non-file';
}

export function collectReleaseSnapshotDrift(
  releasePath: string,
  manifestPayload: ReleaseSnapshotManifest | unknown,
): ReleaseSnapshotDriftIssue[] {
  const manifest = parseReleaseSnapshotManifest(manifestPayload);
  const absoluteReleasePath = requireAbsolute('releasePath', releasePath);
  const issues: ReleaseSnapshotDriftIssue[] = [];
  if (path.resolve(manifest.release.path) !== absoluteReleasePath) {
    issues.push({
      kind: 'manifest-release-path-mismatch',
      expected: path.resolve(manifest.release.path),
      actual: absoluteReleasePath,
      message: `release path does not match manifest release.path: ${absoluteReleasePath}`,
    });
  }
  if (!existsSync(absoluteReleasePath)) {
    issues.push({ kind: 'release-missing', message: `release path does not exist: ${absoluteReleasePath}` });
    return issues;
  }

  const expected = new Map(manifest.files.map((file) => [file.path, file]));
  for (const file of manifest.files) {
    const absolute = path.join(absoluteReleasePath, file.path);
    if (!existsSync(absolute)) {
      issues.push({
        kind: 'file-missing',
        path: file.path,
        expected: file.sha256,
        message: `release file missing: ${file.path}`,
      });
      continue;
    }
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      issues.push({
        kind: 'file-type-drift',
        path: file.path,
        expected: 'regular-file',
        actual: fileTypeName(stat),
        message: `release file is not a regular file: ${file.path}`,
      });
      continue;
    }
    const actual = sha256(readFileSync(absolute));
    if (actual !== file.sha256) {
      issues.push({
        kind: 'file-sha256-drift',
        path: file.path,
        expected: file.sha256,
        actual,
        message: `release file hash drift: ${file.path}`,
      });
    }
  }

  // Required outputs are expected-but-untracked, so they must not read as
  // extra files even though they are absent from `files`.
  const requiredOutputSet = new Set(manifest.requiredOutputs);
  for (const relPath of listFiles(absoluteReleasePath, manifest.release.mutablePathExcludes)) {
    if (!expected.has(relPath) && !requiredOutputSet.has(relPath)) {
      issues.push({ kind: 'extra-file', path: relPath, message: `release file is not in manifest: ${relPath}` });
    }
  }

  // Required build outputs (v2): declared release-relative products (e.g. the
  // built console assets) that must exist even though they are not git-tracked
  // and so never appear in `files`. Their absence is the packaging blind spot a
  // files-only manifest cannot see — a release that omits the console build
  // reads clean without this check.
  for (const relPath of manifest.requiredOutputs) {
    if (!existsSync(path.join(absoluteReleasePath, relPath))) {
      issues.push({
        kind: 'required-output-missing',
        path: relPath,
        message: `required build output missing from release: ${relPath}`,
      });
    }
  }

  return issues;
}

export function createReleaseSnapshotDriftReport(releasePath: string, manifestPath?: string): ReleaseSnapshotDriftReport {
  const absoluteReleasePath = requireAbsolute('check-release', releasePath);
  const absoluteManifestPath = requireAbsolute(
    'manifest',
    manifestPath ?? path.join(absoluteReleasePath, RELEASE_MANIFEST_FILE),
  );
  if (!existsSync(absoluteManifestPath)) {
    return {
      check: 'release-drift',
      ok: false,
      releasePath: absoluteReleasePath,
      manifestPath: absoluteManifestPath,
      source: null,
      issues: [
        {
          kind: 'manifest-missing',
          path: RELEASE_MANIFEST_FILE,
          message: `release manifest not found: ${absoluteManifestPath}`,
        },
      ],
    };
  }
  const manifest = parseReleaseSnapshotManifest(JSON.parse(readFileSync(absoluteManifestPath, 'utf8')));
  const issues = collectReleaseSnapshotDrift(absoluteReleasePath, manifest);
  return {
    check: 'release-drift',
    ok: issues.length === 0,
    releasePath: absoluteReleasePath,
    manifestPath: absoluteManifestPath,
    source: manifest.source,
    issues,
  };
}

function git(cwd: string, args: string[]): string {
  const proc = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: cleanGitEnv(),
    maxBuffer: 20 * 1024 * 1024,
  });
  if (proc.status !== 0) throw new Error((proc.stderr || proc.error?.message || 'git command failed').trim());
  return proc.stdout.trim();
}

function parseArgs(argv: string[]): ParsedArgs {
  const options: ParsedArgs = {
    sourceRef: 'HEAD',
    buildTime: new Date().toISOString(),
    json: false,
  };
  const planningOnlyFlags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string => {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === '--release-root') {
      planningOnlyFlags.add(arg);
      options.releaseRoot = next();
    } else if (arg === '--release-name') {
      planningOnlyFlags.add(arg);
      options.releaseName = next();
    } else if (arg === '--rollback-root') {
      planningOnlyFlags.add(arg);
      options.rollbackRoot = next();
    } else if (arg === '--check-release') options.checkRelease = next();
    else if (arg === '--manifest') options.manifestPath = next();
    else if (arg === '--source-ref') {
      planningOnlyFlags.add(arg);
      options.sourceRef = next();
    } else if (arg === '--build-time') {
      planningOnlyFlags.add(arg);
      options.buildTime = next();
    } else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') {
      throw new Error('Usage: scripts/release-snapshot-plan.ts --release-root /absolute/path [--release-name name] [--rollback-root /absolute/path] [--source-ref HEAD] [--build-time iso] [--json]\n       scripts/release-snapshot-plan.ts --check-release /absolute/path [--manifest /absolute/path] [--json]');
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (options.checkRelease) {
    if (planningOnlyFlags.size > 0) {
      throw new Error(
        `--check-release cannot be combined with release planning flags: ${[...planningOnlyFlags].sort().join(', ')}`,
      );
    }
    return options;
  }
  if (options.manifestPath) throw new Error('--manifest requires --check-release');
  if (!options.releaseRoot) throw new Error('--release-root is required');
  return options;
}

export function run(argv: string[] = process.argv.slice(2), cwd = process.cwd()): ReleaseSnapshotPlan | ReleaseSnapshotDriftReport {
  const options = parseArgs(argv);
  if (options.checkRelease) {
    const report = createReleaseSnapshotDriftReport(options.checkRelease, options.manifestPath);
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else if (report.ok) {
      console.log(`release drift check passed: ${report.releasePath}`);
      if (report.source) console.log(`source: ${report.source.ref} ${report.source.commit}`);
    } else {
      console.error(`release drift detected: ${report.releasePath}`);
      if (report.source) console.error(`source: ${report.source.ref} ${report.source.commit}`);
      for (const issue of report.issues) console.error(`${issue.kind}: ${issue.path ?? '<release>'} ${issue.message}`);
    }
    if (!report.ok) process.exitCode = 1;
    return report;
  }

  const releaseRoot = options.releaseRoot;
  if (!releaseRoot) throw new Error('--release-root is required');
  const sourceCommit = git(cwd, ['rev-parse', options.sourceRef]);
  const trackedFiles = git(cwd, ['ls-files']).split(/\r?\n/).filter(Boolean);
  const plan = createReleaseSnapshotPlan({
    sourceRoot: cwd,
    sourceRef: options.sourceRef,
    sourceCommit,
    releaseRoot,
    releaseName: options.releaseName,
    rollbackRoot: options.rollbackRoot,
    buildTime: options.buildTime,
    trackedFiles,
  });

  if (options.json) {
    console.log(JSON.stringify(plan, null, 2));
  } else {
    console.log(`release dry-run: ${plan.manifest.release.path}`);
    console.log(`source: ${plan.manifest.source.ref} ${plan.manifest.source.commit}`);
    console.log(`files: ${plan.manifest.files.length}`);
    console.log(`manifest: ${path.join(plan.manifest.release.path, RELEASE_MANIFEST_FILE)}`);
    console.log('live launchd/service mutation requires separate approval');
  }
  return plan;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
