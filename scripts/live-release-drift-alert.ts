#!/usr/bin/env node
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parsePlist } from './check-service-units.ts';
import { isNonEmptyString } from '../src/lib/type-guards.ts';
import {
  createReleaseSnapshotDriftReport,
  type ReleaseSnapshotDriftReport,
} from './release-snapshot-plan.ts';

export interface LiveReleaseDriftAlertOptions {
  repoRoot: string;
  releasePath: string;
  manifestPath?: string;
  instance: string;
  source: string;
  emit: boolean;
  emitHelper: string;
  python: string;
  clearOnOk: boolean;
}

export interface LiveReleaseDriftAlertResult {
  check: 'live-release-drift-alert';
  ok: boolean;
  releasePath: string;
  manifestPath: string;
  source: ReleaseSnapshotDriftReport['source'];
  issues: ReleaseSnapshotDriftReport['issues'];
  alert: {
    required: boolean;
    attempted: boolean;
    kind: 'alert' | 'clear' | null;
    status: number | null;
    stdout: string;
    stderr: string;
  };
}

interface ParsedArgs {
  releasePath?: string;
  launchdPlistPath?: string;
  manifestPath?: string;
  repoRoot: string;
  instance: string;
  source: string;
  emit: boolean;
  emitHelper?: string;
  python: string;
  clearOnOk: boolean;
  json: boolean;
}

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
const DEFAULT_SOURCE = 'release-drift';
const DEFAULT_INSTANCE = 'release-bot';
const EMIT_ENV_KEYS = [
  'BOT_ERRORS_ALLOW_TEST_LIVE_OUTBOX',
  'BOT_ERRORS_DRY_PLATFORM_RELEASE',
  'BOT_ERRORS_DRY_PLATFORM_SYSTEM',
  'BOT_ERRORS_DRY_SYS_PLATFORM',
  'BOT_ERRORS_LIVE_OUTBOX_DIR',
  'BOT_ERRORS_OUTBOX_DIR',
  'BOT_ERRORS_STATE_DIR',
  'BOT_ERRORS_WRITEFAIL_DIR',
  'HOME',
  'INVOCATION_ID',
  'JEST_WORKER_ID',
  'LOG_DIR',
  'NODE_ENV',
  'PATH',
  'PYTEST_CURRENT_TEST',
  'SYSTEMD_EXEC_PID',
  'SYSTEMD_UNIT',
  'TMPDIR',
  'VITEST',
  'VITEST_WORKER_ID',
  'WSL_DISTRO_NAME',
] as const;

function usage(): string {
  return [
    'Usage: scripts/live-release-drift-alert.ts (--release /absolute/release/path | --launchd-plist /absolute/plist) [options]',
    '',
    'Options:',
    '  --launchd-plist /absolute/plist     Read the current release path from plist WorkingDirectory',
    '  --manifest /absolute/manifest.json   Override manifest path for archived checks',
    '  --repo-root /absolute/repo            Repo root containing deploy/scripts/bot-errors-emit.py',
    '  --instance name                      BOT ERRORS instance label (default: release-bot)',
    '  --source name                        BOT ERRORS source label (default: release-drift)',
    '  --emit-helper /path/to/bot-errors-emit.py',
    '  --python /path/to/python             Python executable for emit helper (default: python3)',
    '  --no-emit                            Do not enqueue BOT ERRORS; still exits nonzero on drift',
    '  --clear-on-ok                        Enqueue a clear event when the release is clean',
    '  --json                               Print structured result',
  ].join('\n');
}

function requireAbsolute(label: string, value: string): string {
  if (!path.isAbsolute(value)) throw new Error(`${label} must be absolute: ${value}`);
  return path.resolve(value);
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    repoRoot: REPO_ROOT,
    instance: DEFAULT_INSTANCE,
    source: DEFAULT_SOURCE,
    emit: true,
    python: 'python3',
    clearOnOk: false,
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
    if (arg === '--release') parsed.releasePath = next();
    else if (arg === '--launchd-plist') parsed.launchdPlistPath = next();
    else if (arg === '--manifest') parsed.manifestPath = next();
    else if (arg === '--repo-root') parsed.repoRoot = next();
    else if (arg === '--instance') parsed.instance = next();
    else if (arg === '--source') parsed.source = next();
    else if (arg === '--emit-helper') parsed.emitHelper = next();
    else if (arg === '--python') parsed.python = next();
    else if (arg === '--no-emit') parsed.emit = false;
    else if (arg === '--clear-on-ok') parsed.clearOnOk = true;
    else if (arg === '--json') parsed.json = true;
    else if (arg === '--help' || arg === '-h') throw new Error(usage());
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!parsed.releasePath && !parsed.launchdPlistPath) throw new Error('one of --release or --launchd-plist is required');
  if (parsed.releasePath && parsed.launchdPlistPath) throw new Error('--release and --launchd-plist are mutually exclusive');
  if (parsed.releasePath) parsed.releasePath = requireAbsolute('--release', parsed.releasePath);
  if (parsed.launchdPlistPath) parsed.launchdPlistPath = requireAbsolute('--launchd-plist', parsed.launchdPlistPath);
  parsed.repoRoot = requireAbsolute('--repo-root', parsed.repoRoot);
  if (parsed.manifestPath) parsed.manifestPath = requireAbsolute('--manifest', parsed.manifestPath);
  if (!isNonEmptyString(parsed.instance)) throw new Error('--instance must be non-empty');
  if (!isNonEmptyString(parsed.source)) throw new Error('--source must be non-empty');
  return parsed;
}

export function resolveReleasePathFromLaunchdPlist(plistPath: string): string {
  const absolutePlistPath = requireAbsolute('--launchd-plist', plistPath);
  const parsed = parsePlist(readFileSync(absolutePlistPath, 'utf8'));
  if (!parsed) throw new Error(`invalid launchd plist: ${absolutePlistPath}`);
  const workingDirectory = parsed.scalarKeys['WorkingDirectory']?.trim();
  if (!workingDirectory) throw new Error(`launchd plist missing WorkingDirectory: ${absolutePlistPath}`);
  return requireAbsolute('WorkingDirectory', workingDirectory);
}

function defaultEmitHelper(repoRoot: string): string {
  return path.join(repoRoot, 'deploy/scripts/bot-errors-emit.py');
}

function alertSummary(report: ReleaseSnapshotDriftReport): string {
  if (report.ok) return `release drift recovered: ${path.basename(report.releasePath)}`;
  return `release drift detected: ${path.basename(report.releasePath)} (${report.issues.length} issue${report.issues.length === 1 ? '' : 's'})`;
}

function alertEvidence(report: ReleaseSnapshotDriftReport): string {
  return JSON.stringify({
    check: report.check,
    ok: report.ok,
    releasePath: report.releasePath,
    manifestPath: report.manifestPath,
    source: report.source,
    issueCount: report.issues.length,
    issues: report.issues.slice(0, 20),
  }, null, 2);
}

function emitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of EMIT_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function runEmit(
  options: LiveReleaseDriftAlertOptions,
  report: ReleaseSnapshotDriftReport,
  eventType: 'alert' | 'clear',
): SpawnSyncReturns<string> {
  const args = [
    options.emitHelper,
    '--instance',
    options.instance,
    '--source',
    options.source,
    '--summary',
    alertSummary(report),
    '--evidence',
    alertEvidence(report),
    '--diagnostic',
    `release=${report.releasePath}`,
    '--diagnostic',
    `manifest=${report.manifestPath}`,
  ];
  if (eventType === 'clear') {
    args.push('--clear');
  } else {
    args.push('--severity', 'critical');
  }
  return spawnSync(options.python, args, {
    cwd: options.repoRoot,
    encoding: 'utf8',
    env: emitEnvironment(),
    maxBuffer: 1024 * 1024,
  });
}

function normalizeSpawnStatus(proc: SpawnSyncReturns<string>): number | null {
  return proc.status ?? (proc.error ? 1 : null);
}

export function checkLiveReleaseDrift(options: LiveReleaseDriftAlertOptions): LiveReleaseDriftAlertResult {
  const report = createReleaseSnapshotDriftReport(options.releasePath, options.manifestPath);
  const alertKind: 'alert' | 'clear' | null = report.ok ? (options.clearOnOk ? 'clear' : null) : 'alert';
  let emitResult: SpawnSyncReturns<string> | null = null;
  if (alertKind && options.emit) {
    emitResult = runEmit(options, report, alertKind);
  }
  return {
    check: 'live-release-drift-alert',
    ok: report.ok && (!emitResult || normalizeSpawnStatus(emitResult) === 0),
    releasePath: report.releasePath,
    manifestPath: report.manifestPath,
    source: report.source,
    issues: report.issues,
    alert: {
      required: alertKind !== null,
      attempted: Boolean(emitResult),
      kind: alertKind,
      status: emitResult ? normalizeSpawnStatus(emitResult) : null,
      stdout: emitResult?.stdout ?? '',
      stderr: emitResult?.stderr || emitResult?.error?.message || '',
    },
  };
}

function toOptions(parsed: ParsedArgs): LiveReleaseDriftAlertOptions {
  const releasePath = parsed.releasePath ?? resolveReleasePathFromLaunchdPlist(parsed.launchdPlistPath!);
  return {
    repoRoot: parsed.repoRoot,
    releasePath,
    manifestPath: parsed.manifestPath,
    instance: parsed.instance,
    source: parsed.source,
    emit: parsed.emit,
    emitHelper: parsed.emitHelper ? requireAbsolute('--emit-helper', parsed.emitHelper) : defaultEmitHelper(parsed.repoRoot),
    python: parsed.python,
    clearOnOk: parsed.clearOnOk,
  };
}

export function run(argv: string[] = process.argv.slice(2)): LiveReleaseDriftAlertResult {
  const parsed = parseArgs(argv);
  const result = checkLiveReleaseDrift(toOptions(parsed));
  if (parsed.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    console.log(`release drift alert check passed: ${result.releasePath}`);
  } else {
    console.error(`release drift alert check failed: ${result.releasePath}`);
    for (const issue of result.issues) console.error(`${issue.kind}: ${issue.path ?? '<release>'} ${issue.message}`);
    if (result.alert.attempted && result.alert.status !== 0) {
      console.error(`BOT ERRORS emit failed: ${result.alert.stderr || result.alert.stdout || 'unknown error'}`);
    }
  }
  if (!result.ok) process.exitCode = result.issues.length > 0 ? 1 : 2;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
