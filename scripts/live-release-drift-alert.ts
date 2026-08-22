#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parsePlist } from './check-service-units.ts';
import { isNonEmptyString } from '../src/lib/type-guards.ts';
import {
  createReleaseSnapshotDriftReport,
  type ReleaseSnapshotDriftReport,
} from './release-snapshot-plan.ts';
import { emitReleaseAlert, type ReleaseAlertEmitResult } from './lib/live-release-alert.ts';

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
  /** Injected clock for deterministic observedAt in tests. */
  now?: () => Date;
}

export type LiveReleaseDriftOutcome = 'passed' | 'drift' | 'checker_failed' | 'emit_failed';

/**
 * Content-free (#2458): one JSON record per invocation. No absolute paths,
 * release basenames, instance labels, PIDs, raw manifest content, or issue
 * messages — only counts, digests, and bounded enums.
 */
export interface LiveReleaseDriftLogRecord {
  schemaVersion: 1;
  check: 'live-release-drift-alert';
  observedAt: string;
  invocationId: string;
  ok: boolean;
  outcome: LiveReleaseDriftOutcome;
  issueKinds: Record<string, number>;
  /** Domain-separated hash of the issue-kind set + release identity digest. */
  conditionFingerprint: string;
  desiredReleaseDigest: string;
  observedReleaseDigest: string;
  alert: {
    required: boolean;
    attempted: boolean;
    kind: 'alert' | 'clear' | null;
    status: number | null;
  };
  /** sha256 over a domain separator + the emitted BOT ERRORS event id; never the id itself. */
  correlationDigest: string | null;
}

export interface LiveReleaseDriftAlertResult {
  check: 'live-release-drift-alert';
  ok: boolean;
  releasePath: string;
  manifestPath: string;
  source: ReleaseSnapshotDriftReport['source'];
  issues: ReleaseSnapshotDriftReport['issues'];
  record: LiveReleaseDriftLogRecord;
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

function runEmit(
  options: LiveReleaseDriftAlertOptions,
  report: ReleaseSnapshotDriftReport,
  eventType: 'alert' | 'clear',
): ReleaseAlertEmitResult {
  return emitReleaseAlert({ ...options, eventId: randomUUID() }, {
    summary: alertSummary(report),
    evidence: alertEvidence(report),
    diagnostics: [`release=${report.releasePath}`, `manifest=${report.manifestPath}`],
    severity: 'critical',
  }, eventType);
}

const CONDITION_FINGERPRINT_DOMAIN = 'whatsoup-release-drift-condition-v1';
const CORRELATION_DIGEST_DOMAIN = 'whatsoup-release-drift-correlation-v1';

function domainDigest(domain: string, value: string): string {
  return createHash('sha256').update(`${domain}|${value}`).digest('hex');
}

function desiredReleaseDigest(manifestPath: string): string {
  try {
    return domainDigest('whatsoup-release-drift-manifest-v1', readFileSync(manifestPath, 'utf8'));
  } catch {
    return 'unknown';
  }
}

function countIssueKinds(issues: ReleaseSnapshotDriftReport['issues']): Record<string, number> {
  const issueKinds: Record<string, number> = {};
  for (const issue of issues) issueKinds[issue.kind] = (issueKinds[issue.kind] ?? 0) + 1;
  return issueKinds;
}

function buildLogRecord(input: {
  report: Pick<ReleaseSnapshotDriftReport, 'ok' | 'issues' | 'manifestPath'>;
  alertKind: 'alert' | 'clear' | null;
  emitResult: ReleaseAlertEmitResult | null;
  emitFailedOutcome: boolean;
  now: () => Date;
}): LiveReleaseDriftLogRecord {
  const issueKinds = countIssueKinds(input.report.issues);
  const desired = desiredReleaseDigest(input.report.manifestPath);
  // The observed tree identity is only attestable when verification passed.
  const observed = input.report.ok && desired !== 'unknown' ? desired : 'unknown';
  const kindSet = Object.keys(issueKinds).sort().join(',');
  const outcome: LiveReleaseDriftOutcome = input.emitFailedOutcome
    ? 'emit_failed'
    : input.report.ok ? 'passed' : 'drift';
  return {
    schemaVersion: 1,
    check: 'live-release-drift-alert',
    observedAt: input.now().toISOString(),
    invocationId: randomUUID(),
    ok: input.report.ok && (!input.emitResult || input.emitResult.status === 0),
    outcome,
    issueKinds,
    conditionFingerprint: domainDigest(CONDITION_FINGERPRINT_DOMAIN, `${kindSet}|${desired}`),
    desiredReleaseDigest: desired,
    observedReleaseDigest: observed,
    alert: {
      required: input.alertKind !== null,
      attempted: Boolean(input.emitResult),
      kind: input.alertKind,
      status: input.emitResult?.status ?? null,
    },
    correlationDigest: input.emitResult?.eventId && input.emitResult.status === 0
      ? domainDigest(CORRELATION_DIGEST_DOMAIN, input.emitResult.eventId)
      : null,
  };
}

export function checkLiveReleaseDrift(options: LiveReleaseDriftAlertOptions): LiveReleaseDriftAlertResult {
  const report = createReleaseSnapshotDriftReport(options.releasePath, options.manifestPath);
  const alertKind: 'alert' | 'clear' | null = report.ok ? (options.clearOnOk ? 'clear' : null) : 'alert';
  let emitResult: ReleaseAlertEmitResult | null = null;
  if (alertKind && options.emit) {
    emitResult = runEmit(options, report, alertKind);
  }
  const emitFailedOutcome = Boolean(emitResult && emitResult.status !== 0);
  const record = buildLogRecord({ report, alertKind, emitResult, emitFailedOutcome, now: options.now ?? (() => new Date()) });
  return {
    check: 'live-release-drift-alert',
    ok: report.ok && (!emitResult || emitResult.status === 0),
    releasePath: report.releasePath,
    manifestPath: report.manifestPath,
    source: report.source,
    issues: report.issues,
    record,
    alert: {
      required: alertKind !== null,
      attempted: Boolean(emitResult),
      kind: alertKind,
      status: emitResult?.status ?? null,
      stdout: emitResult?.stdout ?? '',
      stderr: emitResult?.stderr ?? '',
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
  let result: LiveReleaseDriftAlertResult;
  try {
    result = checkLiveReleaseDrift(toOptions(parsed));
  } catch (error) {
    // Checker failure (unreadable/invalid manifest, bad paths): still exactly one
    // structured record, no error-message leakage (messages embed paths).
    void error;
    const record: LiveReleaseDriftLogRecord = {
      schemaVersion: 1,
      check: 'live-release-drift-alert',
      observedAt: new Date().toISOString(),
      invocationId: randomUUID(),
      ok: false,
      outcome: 'checker_failed',
      issueKinds: {},
      conditionFingerprint: domainDigest(CONDITION_FINGERPRINT_DOMAIN, 'checker_failed'),
      desiredReleaseDigest: 'unknown',
      observedReleaseDigest: 'unknown',
      alert: { required: false, attempted: false, kind: null, status: null },
      correlationDigest: null,
    };
    console.log(JSON.stringify(record));
    process.exitCode = 2;
    return { check: 'live-release-drift-alert', ok: false, releasePath: '', manifestPath: '', source: null, issues: [], record, alert: { ...record.alert, stdout: '', stderr: '' } };
  }
  if (parsed.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(JSON.stringify(result.record));
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
