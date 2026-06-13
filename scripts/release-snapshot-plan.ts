#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { cleanGitEnv } from './lib/guard-core.ts';

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
  schemaVersion: 1;
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

export type ReleaseSnapshotDriftKind = 'release-missing' | 'file-missing' | 'file-sha256-drift' | 'extra-file';

export interface ReleaseSnapshotDriftIssue {
  kind: ReleaseSnapshotDriftKind;
  path?: string;
  expected?: string;
  actual?: string;
  message: string;
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
}

interface ParsedArgs {
  releaseRoot?: string;
  releaseName?: string;
  rollbackRoot?: string;
  sourceRef: string;
  buildTime: string;
  json: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  if (payload['schemaVersion'] !== 1) {
    throw new Error(`unsupported release snapshot manifest schemaVersion=${String(payload['schemaVersion'])}`);
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

  return {
    schemaVersion: 1,
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

  const manifest: ReleaseSnapshotManifest = {
    schemaVersion: 1,
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
    if (entry.isDirectory()) {
      files.push(...listFiles(root, mutablePathExcludes, absolute));
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }
  return files.sort();
}

export function collectReleaseSnapshotDrift(
  releasePath: string,
  manifestPayload: ReleaseSnapshotManifest | unknown,
): ReleaseSnapshotDriftIssue[] {
  const manifest = parseReleaseSnapshotManifest(manifestPayload);
  const absoluteReleasePath = requireAbsolute('releasePath', releasePath);
  if (!existsSync(absoluteReleasePath)) {
    return [{ kind: 'release-missing', message: `release path does not exist: ${absoluteReleasePath}` }];
  }

  const issues: ReleaseSnapshotDriftIssue[] = [];
  const expected = new Map(manifest.files.map((file) => [file.path, file]));
  for (const file of manifest.files) {
    const absolute = path.join(absoluteReleasePath, file.path);
    if (!existsSync(absolute)) {
      issues.push({ kind: 'file-missing', path: file.path, expected: file.sha256, message: `release file missing: ${file.path}` });
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

  for (const relPath of listFiles(absoluteReleasePath, manifest.release.mutablePathExcludes)) {
    if (!expected.has(relPath)) {
      issues.push({ kind: 'extra-file', path: relPath, message: `release file is not in manifest: ${relPath}` });
    }
  }

  return issues;
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
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string => {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === '--release-root') options.releaseRoot = next();
    else if (arg === '--release-name') options.releaseName = next();
    else if (arg === '--rollback-root') options.rollbackRoot = next();
    else if (arg === '--source-ref') options.sourceRef = next();
    else if (arg === '--build-time') options.buildTime = next();
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') {
      throw new Error('Usage: scripts/release-snapshot-plan.ts --release-root /absolute/path [--release-name name] [--rollback-root /absolute/path] [--source-ref HEAD] [--build-time iso] [--json]');
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!options.releaseRoot) throw new Error('--release-root is required');
  return options;
}

export function run(argv: string[] = process.argv.slice(2), cwd = process.cwd()): ReleaseSnapshotPlan {
  const options = parseArgs(argv);
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
