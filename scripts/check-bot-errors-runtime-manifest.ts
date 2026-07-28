#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { isRecord } from '../src/lib/type-guards.ts';

export type RuntimeManifestFindingCode =
  | 'manifest-unreadable'
  | 'manifest-not-object'
  | 'unsupported-schema'
  | 'files-not-list'
  | 'entry-not-object'
  | 'missing-path'
  | 'unsafe-path'
  | 'invalid-sha256'
  | 'invalid-must-contain'
  | 'duplicate-path'
  | 'missing-required-path'
  | 'missing-file'
  | 'hash-drift'
  | 'missing-marker';

export interface RuntimeManifestFinding {
  code: RuntimeManifestFindingCode;
  message: string;
  path?: string;
}

export interface RuntimeManifestCheckResult {
  ok: boolean;
  checked: number;
  findings: RuntimeManifestFinding[];
}

interface ManifestFileEntry {
  path: string;
  sha256: string;
  mustContain: string[];
}

// Historical explicit allowlist — retained for reference/back-compat. Completeness is now a
// GLOB (see computeRequiredRuntimePaths): every deploy/scripts python file must be pinned or
// suppressed, so new live scripts default to GUARDED instead of silently unpinned (L6-06).
export const REQUIRED_RUNTIME_MANIFEST_PATHS = [
  'deploy/scripts/bot-errors-dispatcher.py',
  'deploy/scripts/bot-errors-health-check.py',
  'deploy/scripts/bot-errors-heartbeat-watchdog.py',
  'deploy/scripts/bot-errors-q-loop.py',
  // Executed live: bot-errors-health-check.py exec_module()s this sibling on every
  // --daily run (health-check.py:5432-5449), so a tamper/drift of it runs in
  // production. It must carry a runtime-manifest hash like the other live scripts.
  'deploy/scripts/bot-errors-tree-provenance.py',
  'src/lib/bot-errors-outbox.ts',
  'deploy/scripts/bot-errors-collector.py',
  'deploy/scripts/bot-errors-emit.py',
  'deploy/scripts/bot-errors-runner.py',
  'deploy/scripts/lib/__init__.py',
  'deploy/scripts/lib/bot_errors_redaction.py',
  'deploy/scripts/lib/bot_errors_daily_health.py',
  'deploy/scripts/bot-errors-gui-session-monitor.py',
  'deploy/scripts/install-bot-errors-gui-monitor-launchd.sh',
] as const;

// Python scripts under deploy/scripts that are intentionally NOT integrity-pinned because they
// are operator CLIs (run by hand, not a live runtime path) or a known-orphaned monitor. Adding a
// script here is a deliberate, reviewable exemption — the alternative is to pin it.
export const SUPPRESSED_RUNTIME_PATHS: ReadonlySet<string> = new Set([
  'deploy/scripts/bot-errors-maintenance.py', // operator CLI: declare planned maintenance windows
  'deploy/scripts/retire-outbound-quarantine.py', // operator CLI: retire a known unsafe quarantine
]);

// Runtime files that must be pinned but are not covered by the deploy/scripts python glob.
export const EXPLICIT_REQUIRED_RUNTIME_PATHS = [
  'src/lib/bot-errors-outbox.ts',
  'src/lib/fault-taxonomy-registry.json',
  'deploy/scripts/install-bot-errors-gui-monitor-launchd.sh',
  'deploy/scripts/bot-errors-release-proof-run.sh',
  'deploy/scripts/install-bot-errors-release-proof.sh',
] as const;

const PYTHON_RUNTIME_DIRS = ['deploy/scripts', 'deploy/scripts/lib'] as const;

function listPythonRuntimeScripts(cwd: string): string[] {
  const found: string[] = [];
  for (const dir of PYTHON_RUNTIME_DIRS) {
    const absolute = path.resolve(cwd, dir);
    if (!existsSync(absolute)) continue;
    for (const name of readdirSync(absolute)) {
      if (name.endsWith('.py')) found.push(`${dir}/${name}`);
    }
  }
  return found;
}

/**
 * Compute the set of runtime files that MUST be integrity-pinned: every python file under
 * deploy/scripts (top-level + lib/, excluding the tests/ subdir) that is not explicitly
 * suppressed, plus the non-python EXPLICIT_REQUIRED_RUNTIME_PATHS. This makes the manifest a
 * glob, not an allowlist — a newly added live script fails the guard until it is pinned or
 * deliberately suppressed (L6-06).
 */
export function computeRequiredRuntimePaths(cwd: string = process.cwd()): string[] {
  const python = listPythonRuntimeScripts(cwd).filter((p) => !SUPPRESSED_RUNTIME_PATHS.has(p));
  return Array.from(new Set([...EXPLICIT_REQUIRED_RUNTIME_PATHS, ...python])).sort();
}

function finding(
  code: RuntimeManifestFindingCode,
  message: string,
  entryPath?: string,
): RuntimeManifestFinding {
  return entryPath === undefined ? { code, message } : { code, message, path: entryPath };
}

function sha256File(filePath: string): string {
  const digest = createHash('sha256');
  digest.update(readFileSync(filePath));
  return digest.digest('hex');
}

function isSafeRepoRelativePath(filePath: string): boolean {
  if (filePath.trim() !== filePath || filePath === '') return false;
  if (path.isAbsolute(filePath)) return false;
  const parts = filePath.split(/[\\/]+/);
  return parts.every((part) => part !== '' && part !== '.' && part !== '..');
}

function parseManifestEntries(payload: unknown): {
  entries: ManifestFileEntry[];
  findings: RuntimeManifestFinding[];
} {
  const findings: RuntimeManifestFinding[] = [];
  const entries: ManifestFileEntry[] = [];

  if (!isRecord(payload)) {
    findings.push(finding('manifest-not-object', 'BOT ERRORS runtime manifest must be a JSON object'));
    return { entries, findings };
  }
  if (payload['schemaVersion'] !== 1) {
    findings.push(finding('unsupported-schema', `unsupported schemaVersion=${String(payload['schemaVersion'])}`));
  }
  if (!Array.isArray(payload['files'])) {
    findings.push(finding('files-not-list', 'manifest files must be a list'));
    return { entries, findings };
  }

  const seen = new Set<string>();
  for (const [index, rawEntry] of payload['files'].entries()) {
    if (!isRecord(rawEntry)) {
      findings.push(finding('entry-not-object', `manifest files[${index}] must be an object`));
      continue;
    }

    const rawPath = rawEntry['path'];
    if (typeof rawPath !== 'string') {
      findings.push(finding('missing-path', `manifest files[${index}] missing string path`));
      continue;
    }
    if (!isSafeRepoRelativePath(rawPath)) {
      findings.push(finding('unsafe-path', `manifest path is not repo-relative and safe: ${rawPath}`, rawPath));
      continue;
    }
    if (seen.has(rawPath)) {
      findings.push(finding('duplicate-path', `duplicate manifest path: ${rawPath}`, rawPath));
      continue;
    }
    seen.add(rawPath);

    const sha256 = rawEntry['sha256'];
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
      findings.push(finding('invalid-sha256', `manifest ${rawPath} has invalid sha256`, rawPath));
      continue;
    }

    const rawMustContain = rawEntry['mustContain'];
    const mustContain = rawMustContain === undefined
      ? []
      : Array.isArray(rawMustContain)
        ? rawMustContain
        : [rawMustContain];
    if (!mustContain.every((marker): marker is string => typeof marker === 'string')) {
      findings.push(finding('invalid-must-contain', `manifest ${rawPath} mustContain entries must be strings`, rawPath));
      continue;
    }

    entries.push({ path: rawPath, sha256, mustContain });
  }

  return { entries, findings };
}

export function checkBotErrorsRuntimeManifest(
  cwd = process.cwd(),
  manifestPath = 'deploy/bot-errors-runtime-manifest.json',
  requiredPaths: readonly string[] = computeRequiredRuntimePaths(cwd),
): RuntimeManifestCheckResult {
  const absoluteManifestPath = path.resolve(cwd, manifestPath);
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(absoluteManifestPath, 'utf8'));
  } catch (err) {
    return {
      ok: false,
      checked: 0,
      findings: [finding('manifest-unreadable', `cannot read runtime manifest ${manifestPath}: ${(err as Error).message}`)],
    };
  }

  const { entries, findings } = parseManifestEntries(payload);
  const entryPaths = new Set(entries.map((entry) => entry.path));
  for (const requiredPath of requiredPaths) {
    if (!entryPaths.has(requiredPath)) {
      findings.push(finding(
        'missing-required-path',
        `runtime manifest is missing required BOT ERRORS entry: ${requiredPath}`,
        requiredPath,
      ));
    }
  }

  for (const entry of entries) {
    const absoluteFilePath = path.resolve(cwd, entry.path);
    if (!absoluteFilePath.startsWith(path.resolve(cwd) + path.sep) && absoluteFilePath !== path.resolve(cwd)) {
      findings.push(finding('unsafe-path', `manifest path escapes repository: ${entry.path}`, entry.path));
      continue;
    }
    if (!existsSync(absoluteFilePath)) {
      findings.push(finding('missing-file', `manifest file is missing: ${entry.path}`, entry.path));
      continue;
    }

    const actual = sha256File(absoluteFilePath);
    if (actual !== entry.sha256) {
      findings.push(finding(
        'hash-drift',
        `runtime manifest hash drift for ${entry.path}: expected=${entry.sha256} actual=${actual}`,
        entry.path,
      ));
    }

    const text = readFileSync(absoluteFilePath, 'utf8');
    for (const marker of entry.mustContain) {
      if (!text.includes(marker)) {
        findings.push(finding('missing-marker', `runtime manifest marker missing in ${entry.path}: ${marker}`, entry.path));
      }
    }
  }

  return { ok: findings.length === 0, checked: entries.length, findings };
}

function parseArgs(argv: string[]): { manifestPath: string; help: boolean } {
  let manifestPath = 'deploy/bot-errors-runtime-manifest.json';
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--manifest') {
      const value = argv[index + 1];
      if (!value) throw new Error('--manifest requires a path');
      manifestPath = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${String(arg)}`);
    }
  }
  return { manifestPath, help };
}

export function run(argv = process.argv.slice(2), cwd = process.cwd()): RuntimeManifestCheckResult {
  const args = parseArgs(argv);
  if (args.help) {
    console.log('Usage: check-bot-errors-runtime-manifest.ts [--manifest deploy/bot-errors-runtime-manifest.json]');
    return { ok: true, checked: 0, findings: [] };
  }

  const result = checkBotErrorsRuntimeManifest(cwd, args.manifestPath);
  if (!result.ok) {
    console.error('BOT ERRORS runtime manifest guard failed');
    for (const item of result.findings) {
      console.error(`${item.code}: ${item.message}`);
    }
    process.exitCode = 1;
  } else {
    console.log(`BOT ERRORS runtime manifest guard passed (${result.checked} file(s))`);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    run();
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}
