import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { cleanGitEnv } from './lib/guard-core.ts';
import { isRecord } from '../src/lib/type-guards.ts';

export type SourceRuntimeIssueKind =
  | 'invalid-manifest'
  | 'file-missing'
  | 'file-kind'
  | 'file-untracked'
  | 'file-uncommitted'
  | 'file-dirty'
  | 'file-staged'
  | 'file-sha256-drift'
  | 'file-marker-drift'
  | 'import-missing'
  | 'import-outside-repo'
  | 'git-error';

export interface SourceRuntimeEntry {
  path: string;
  sha256?: string;
  mustContain: string[];
  importGraph: boolean;
}

export interface SourceRuntimeManifest {
  schemaVersion: 1;
  scope: string;
  entrypoints: SourceRuntimeEntry[];
}

export interface SourceRuntimeIssue {
  kind: SourceRuntimeIssueKind;
  severity: 'critical' | 'high';
  path?: string;
  importedBy?: string;
  specifier?: string;
  importers?: Array<{ importedBy: string; specifier: string }>;
  expected?: string;
  actual?: string;
  message: string;
}

interface GitFileState {
  tracked: boolean;
  committed: boolean;
  dirty: boolean;
  staged: boolean;
  error?: string;
}

interface CheckOptions {
  cwd: string;
  manifestPath: string;
  json: boolean;
  suggest: boolean;
}

const DEFAULT_MANIFEST = 'deploy/source-runtime-manifest.json';
const EXTENSION_CANDIDATES = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json'];
const INDEX_CANDIDATES = ['index.ts', 'index.tsx', 'index.mts', 'index.cts', 'index.js', 'index.mjs', 'index.cjs', 'index.json'];
const IMPORT_PATTERN = /(?:\bimport\b|\bexport\b)\s+(?:type\s+)?(?:[^'"()]*?\s+from\s*)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function normalizeMarkers(value: unknown): string[] {
  if (value === undefined) return [];
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) {
    throw new Error('mustContain must be a string or string array');
  }
  return value.map((item) => {
    if (typeof item !== 'string' || item.length === 0) {
      throw new Error('mustContain entries must be non-empty strings');
    }
    return item;
  });
}

export function parseSourceRuntimeManifest(payload: unknown): SourceRuntimeManifest {
  if (!isRecord(payload)) throw new Error('source runtime manifest must be an object');
  if (payload['schemaVersion'] !== 1) {
    throw new Error(`unsupported source runtime manifest schemaVersion=${String(payload['schemaVersion'])}`);
  }
  const scope = typeof payload['scope'] === 'string' && payload['scope'].length > 0
    ? payload['scope']
    : 'source-runtime';
  const rawEntrypoints = payload['entrypoints'];
  if (!Array.isArray(rawEntrypoints)) {
    throw new Error('source runtime manifest entrypoints must be a list');
  }

  const seen = new Set<string>();
  const entrypoints = rawEntrypoints.map((item, index): SourceRuntimeEntry => {
    if (!isRecord(item)) throw new Error(`source runtime manifest entrypoint[${index}] must be an object`);
    const filePath = item['path'];
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new Error(`source runtime manifest entrypoint[${index}] missing path`);
    }
    if (path.isAbsolute(filePath) || filePath.includes('\0') || filePath.split(/[\\/]/).includes('..')) {
      throw new Error(`source runtime manifest entrypoint[${index}] path must be repo-relative`);
    }
    if (seen.has(filePath)) throw new Error(`source runtime manifest duplicate entrypoint ${filePath}`);
    seen.add(filePath);

    const sha256Value = item['sha256'];
    if (sha256Value !== undefined && (typeof sha256Value !== 'string' || !/^[0-9a-fA-F]{64}$/.test(sha256Value))) {
      throw new Error(`source runtime manifest ${filePath} invalid sha256`);
    }
    return {
      path: filePath,
      sha256: sha256Value?.toLowerCase(),
      mustContain: normalizeMarkers(item['mustContain']),
      importGraph: item['importGraph'] !== false,
    };
  });

  return { schemaVersion: 1, scope, entrypoints };
}

export function loadSourceRuntimeManifest(cwd: string, manifestPath = DEFAULT_MANIFEST): SourceRuntimeManifest {
  const absolute = path.resolve(cwd, manifestPath);
  return parseSourceRuntimeManifest(JSON.parse(readFileSync(absolute, 'utf8')));
}

function issue(
  kind: SourceRuntimeIssueKind,
  severity: 'critical' | 'high',
  message: string,
  details: Omit<SourceRuntimeIssue, 'kind' | 'severity' | 'message'> = {},
): SourceRuntimeIssue {
  return { kind, severity, message, ...details };
}

function repoRelative(cwd: string, absolutePath: string): string {
  return path.relative(cwd, absolutePath).split(path.sep).join('/');
}

function withinRepo(cwd: string, absolutePath: string): boolean {
  const rel = path.relative(cwd, absolutePath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function sha256(body: Buffer | string): string {
  return createHash('sha256').update(body).digest('hex');
}

// Intentional local wrapper: this guard needs status/stdout/stderr together to
// distinguish untracked, dirty, staged, and git-error states. guard-core's
// gitList/readText helpers intentionally expose narrower contracts.
function git(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string; error?: string } {
  const proc = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: cleanGitEnv(),
    maxBuffer: 1024 * 1024,
  });
  return {
    status: proc.status,
    stdout: proc.stdout ?? '',
    stderr: proc.stderr ?? '',
    error: proc.error?.message,
  };
}

function gitFileState(cwd: string, relPath: string): GitFileState {
  const tracked = git(cwd, ['ls-files', '--error-unmatch', '--', relPath]);
  if (tracked.status !== 0) {
    return { tracked: false, committed: false, dirty: false, staged: false, error: tracked.error };
  }

  const committed = git(cwd, ['cat-file', '-e', `HEAD:${relPath}`]);
  const worktree = git(cwd, ['diff', '--quiet', '--', relPath]);
  const index = git(cwd, ['diff', '--cached', '--quiet', '--', relPath]);
  const gitError = [committed, worktree, index].find((result) => result.error || (result.status !== 0 && result.status !== 1));
  return {
    tracked: true,
    committed: committed.status === 0,
    dirty: worktree.status === 1,
    staged: index.status === 1,
    error: gitError?.error || (gitError ? gitError.stderr.trim() : undefined),
  };
}

function resolveRelativeImport(cwd: string, importerRel: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const importerDir = path.dirname(path.resolve(cwd, importerRel));
  const base = path.resolve(importerDir, specifier);
  if (!withinRepo(cwd, base)) return repoRelative(cwd, base);

  const candidates: string[] = [];
  for (const suffix of EXTENSION_CANDIDATES) candidates.push(base + suffix);
  for (const indexFile of INDEX_CANDIDATES) candidates.push(path.join(base, indexFile));
  const match = candidates.find((candidate) => existsSync(candidate));
  return match ? repoRelative(cwd, match) : repoRelative(cwd, candidates[0] ?? base);
}

function readImports(cwd: string, relPath: string): Array<{ specifier: string; resolved: string | null }> {
  const absolute = path.resolve(cwd, relPath);
  const text = readFileSync(absolute, 'utf8');
  const imports: Array<{ specifier: string; resolved: string | null }> = [];
  for (const match of text.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1] ?? match[2];
    if (!specifier || !specifier.startsWith('.')) continue;
    imports.push({ specifier, resolved: resolveRelativeImport(cwd, relPath, specifier) });
  }
  return imports;
}

function inspectSourceFile(
  cwd: string,
  relPath: string,
  options: { expectedSha256?: string; mustContain?: string[]; importedBy?: string; specifier?: string },
): SourceRuntimeIssue[] {
  const absolute = path.resolve(cwd, relPath);
  if (!withinRepo(cwd, absolute)) {
    return [issue('import-outside-repo', 'critical', `source import escapes repo: ${relPath}`, {
      path: relPath,
      importedBy: options.importedBy,
      specifier: options.specifier,
    })];
  }
  if (!existsSync(absolute)) {
    return [issue(options.importedBy ? 'import-missing' : 'file-missing', 'critical', `source runtime file missing: ${relPath}`, {
      path: relPath,
      importedBy: options.importedBy,
      specifier: options.specifier,
    })];
  }
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return [issue('file-kind', 'critical', `source runtime file is not a regular file: ${relPath}`, {
      path: relPath,
      importedBy: options.importedBy,
      specifier: options.specifier,
      actual: stat.isSymbolicLink() ? 'symlink' : 'not-file',
    })];
  }

  const issues: SourceRuntimeIssue[] = [];
  const state = gitFileState(cwd, relPath);
  if (state.error) {
    issues.push(issue('git-error', 'critical', `git state check failed for ${relPath}: ${state.error}`, { path: relPath }));
  }
  if (!state.tracked) {
    issues.push(issue('file-untracked', 'critical', `source runtime file is untracked: ${relPath}`, {
      path: relPath,
      importedBy: options.importedBy,
      specifier: options.specifier,
    }));
  } else if (!state.committed) {
    issues.push(issue('file-uncommitted', 'critical', `source runtime file is not committed at HEAD: ${relPath}`, {
      path: relPath,
      importedBy: options.importedBy,
      specifier: options.specifier,
    }));
  }
  if (state.dirty) {
    issues.push(issue('file-dirty', 'high', `source runtime file has unstaged worktree drift: ${relPath}`, { path: relPath }));
  }
  if (state.staged) {
    issues.push(issue('file-staged', 'high', `source runtime file has staged-but-uncommitted drift: ${relPath}`, { path: relPath }));
  }

  const body = readFileSync(absolute);
  const actualSha256 = sha256(body);
  if (options.expectedSha256 && actualSha256 !== options.expectedSha256) {
    issues.push(issue('file-sha256-drift', 'critical', `source runtime file hash drift: ${relPath}`, {
      path: relPath,
      expected: options.expectedSha256,
      actual: actualSha256,
    }));
  }

  const text = body.toString('utf8');
  const missingMarkers = (options.mustContain ?? []).filter((marker) => !text.includes(marker));
  if (missingMarkers.length > 0) {
    issues.push(issue('file-marker-drift', 'high', `source runtime file missing required markers: ${relPath} markers=${missingMarkers.join(',')}`, {
      path: relPath,
      expected: missingMarkers.join(','),
    }));
  }
  return issues;
}

export function collectSourceRuntimeIssues(
  cwd: string,
  manifest: SourceRuntimeManifest,
): SourceRuntimeIssue[] {
  const issues: SourceRuntimeIssue[] = [];
  const visited = new Set<string>();
  const queue: Array<{ path: string; entry?: SourceRuntimeEntry; importedBy?: string; specifier?: string }> =
    manifest.entrypoints.map((entry) => ({ path: entry.path, entry }));

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    const relPath = current.path;
    const visitKey = `${relPath}:${current.importedBy ?? ''}:${current.specifier ?? ''}`;
    if (visited.has(visitKey)) continue;
    visited.add(visitKey);

    const fileIssues = inspectSourceFile(cwd, relPath, {
      expectedSha256: current.entry?.sha256,
      mustContain: current.entry?.mustContain,
      importedBy: current.importedBy,
      specifier: current.specifier,
    });
    issues.push(...fileIssues);
    if (fileIssues.some((item) => item.kind === 'file-missing' || item.kind === 'file-kind' || item.kind === 'import-missing')) {
      continue;
    }
    if (current.entry && !current.entry.importGraph) continue;

    for (const imported of readImports(cwd, relPath)) {
      if (!imported.resolved) continue;
      if (visited.has(`${imported.resolved}:${relPath}:${imported.specifier}`)) continue;
      queue.push({ path: imported.resolved, importedBy: relPath, specifier: imported.specifier });
    }
  }

  return dedupeIssues(issues);
}

function dedupeIssues(issues: SourceRuntimeIssue[]): SourceRuntimeIssue[] {
  const merged: SourceRuntimeIssue[] = [];
  const byKey = new Map<string, SourceRuntimeIssue>();

  for (const current of issues) {
    const key = current.kind === 'file-untracked'
      ? [current.kind, current.path ?? ''].join('\0')
      : [current.kind, current.path ?? '', current.importedBy ?? '', current.specifier ?? ''].join('\0');
    const existing = byKey.get(key);
    if (!existing) {
      const next = { ...current };
      if (current.kind === 'file-untracked' && current.importedBy && current.specifier) {
        next.importers = [{ importedBy: current.importedBy, specifier: current.specifier }];
      }
      byKey.set(key, next);
      merged.push(next);
      continue;
    }
    if (current.kind === 'file-untracked' && current.importedBy && current.specifier) {
      const importers = existing.importers ?? [];
      if (!importers.some((item) => item.importedBy === current.importedBy && item.specifier === current.specifier)) {
        existing.importers = [...importers, { importedBy: current.importedBy, specifier: current.specifier }];
      }
    }
  }

  return merged;
}

function parseArgs(argv: string[], cwd: string): CheckOptions {
  const options: CheckOptions = { cwd, manifestPath: DEFAULT_MANIFEST, json: false, suggest: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string => {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === '--manifest') options.manifestPath = next();
    else if (arg === '--json') options.json = true;
    else if (arg === '--suggest') options.suggest = true;
    else if (arg === '--help' || arg === '-h') {
      throw new Error('Usage: node --experimental-strip-types scripts/source-runtime-drift-check.ts [--manifest deploy/source-runtime-manifest.json] [--json] [--suggest]');
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

const SUGGEST_BANNER = '=== --suggest: review the diff before pasting — corrected hashes are printed only, the manifest is never written ===';

// Prints copy-pasteable "path"/"sha256" manifest lines for every entry whose
// pinned hash no longer matches its on-disk file. Read-only: never touches
// the manifest file (blessed-hash philosophy — a human reviews and pastes).
function printSuggestions(issues: SourceRuntimeIssue[]): void {
  const driftedEntries = issues.filter(
    (item): item is SourceRuntimeIssue & { path: string; actual: string } =>
      item.kind === 'file-sha256-drift' && typeof item.path === 'string' && typeof item.actual === 'string',
  );
  if (driftedEntries.length === 0) return;
  console.log(SUGGEST_BANNER);
  for (const entry of driftedEntries) {
    console.log(`  "path": "${entry.path}",`);
    console.log(`  "sha256": "${entry.actual}",`);
  }
}

export function run(argv: string[] = process.argv.slice(2), cwd = process.cwd()): SourceRuntimeIssue[] {
  const options = parseArgs(argv, cwd);
  const issues: SourceRuntimeIssue[] = [];
  let manifest: SourceRuntimeManifest | null = null;
  try {
    manifest = loadSourceRuntimeManifest(cwd, options.manifestPath);
  } catch (error) {
    issues.push(issue('invalid-manifest', 'critical', error instanceof Error ? error.message : String(error)));
  }
  if (manifest) issues.push(...collectSourceRuntimeIssues(cwd, manifest));

  if (options.json) {
    console.log(JSON.stringify({ ok: issues.length === 0, issues }, null, 2));
  } else if (issues.length === 0) {
    console.log('source runtime drift check passed');
  } else {
    for (const current of issues) {
      const suggestHint = current.kind === 'file-sha256-drift' && !options.suggest
        ? ' (run with --suggest to print the corrected sha256)'
        : '';
      console.error(`FAIL ${current.severity} ${current.kind}: ${current.message}${suggestHint}`);
    }
  }
  if (options.suggest && !options.json) printSuggestions(issues);
  if (issues.length > 0) process.exitCode = 1;
  return issues;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
