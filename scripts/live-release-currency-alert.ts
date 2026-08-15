#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { cleanGitEnv } from '../src/lib/git-env.ts';
import { isNonEmptyString } from '../src/lib/type-guards.ts';
import {
  parseReleaseSnapshotManifest,
  RELEASE_MANIFEST_FILE,
  type ReleaseSnapshotManifest,
} from './release-snapshot-plan.ts';
import { resolveReleasePathFromLaunchdPlist } from './live-release-drift-alert.ts';
import { emitReleaseAlert, type ReleaseAlertEmitResult } from './lib/live-release-alert.ts';
import { takeValue } from './lib/cli-args.ts';

export type ReleaseCurrencyState = 'current' | 'target-differs' | 'inconclusive';
export type ReleaseCurrencyReason =
  | 'exact-commit-match'
  | 'exact-commit-mismatch'
  | 'manifest-unavailable'
  | 'manifest-invalid'
  | 'manifest-release-path-mismatch'
  | 'invalid-deployed-commit'
  | 'unsafe-target-url'
  | 'invalid-target-ref'
  | 'target-unavailable'
  | 'target-output-invalid'
  | 'emit-failed';

export type ReleaseTargetResolution =
  | { ok: true; commit: string }
  | { ok: false; reason: 'target-unavailable' | 'target-output-invalid'; detail: string };

export type ReleaseTargetResolver = (
  targetUrl: string,
  targetRef: string,
) => ReleaseTargetResolution | Promise<ReleaseTargetResolution>;

export interface LiveReleaseCurrencyAlertOptions {
  repoRoot: string;
  releasePath: string;
  manifestPath?: string;
  targetUrl: string;
  targetRef: string;
  instance: string;
  source: string;
  emit: boolean;
  emitHelper: string;
  python: string;
  clearOnCurrent: boolean;
  resolveTarget?: ReleaseTargetResolver;
}

export interface LiveReleaseCurrencyAlertResult {
  check: 'live-release-currency-alert';
  state: ReleaseCurrencyState;
  reason: ReleaseCurrencyReason;
  healthImpact: 'none';
  observedAt: string;
  releasePath: string;
  manifestPath: string;
  deployed: { ref: string | null; commit: string | null };
  target: { ref: string; commit: string | null };
  resolutionHint: string;
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
  targetUrl?: string;
  targetRef: string;
  instance: string;
  source: string;
  emit: boolean;
  emitHelper?: string;
  python: string;
  clearOnCurrent: boolean;
  json: boolean;
}

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
const DEFAULT_INSTANCE = 'release-bot';
const DEFAULT_SOURCE = 'release-currency';
const DEFAULT_TARGET_REF = 'refs/heads/main';
const FULL_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

function usage(): string {
  return [
    'Usage: scripts/live-release-currency-alert.ts (--release /absolute/release/path | --launchd-plist /absolute/plist) --target-url <git-url> [options]',
    '',
    'Options:',
    '  --target-url <git-url>               Explicit HTTPS or SSH Git remote',
    '  --target-ref refs/heads/<branch>     Exact comparison ref (default: refs/heads/main)',
    '  --manifest /absolute/manifest.json   Override the release manifest path',
    '  --repo-root /absolute/repo            Repo containing deploy/scripts/bot-errors-emit.py',
    '  --instance name                      BOT ERRORS instance label (default: release-bot)',
    '  --source name                        BOT ERRORS source label (default: release-currency)',
    '  --emit-helper /path/to/helper.py',
    '  --python /path/to/python             Python executable (default: python3)',
    '  --no-emit                            Observe only; retain fail-closed exit codes',
    '  --clear-on-current                   Emit a clear when exact equality is observed',
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
    targetRef: DEFAULT_TARGET_REF,
    instance: DEFAULT_INSTANCE,
    source: DEFAULT_SOURCE,
    emit: true,
    python: 'python3',
    clearOnCurrent: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string => {
      const taken = takeValue(argv, index, arg);
      index = taken.index;
      return taken.value;
    };
    if (arg === '--release') parsed.releasePath = next();
    else if (arg === '--launchd-plist') parsed.launchdPlistPath = next();
    else if (arg === '--manifest') parsed.manifestPath = next();
    else if (arg === '--repo-root') parsed.repoRoot = next();
    else if (arg === '--target-url') parsed.targetUrl = next();
    else if (arg === '--target-ref') parsed.targetRef = next();
    else if (arg === '--instance') parsed.instance = next();
    else if (arg === '--source') parsed.source = next();
    else if (arg === '--emit-helper') parsed.emitHelper = next();
    else if (arg === '--python') parsed.python = next();
    else if (arg === '--no-emit') parsed.emit = false;
    else if (arg === '--clear-on-current') parsed.clearOnCurrent = true;
    else if (arg === '--json') parsed.json = true;
    else if (arg === '--help' || arg === '-h') throw new Error(usage());
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!parsed.releasePath && !parsed.launchdPlistPath) throw new Error('one of --release or --launchd-plist is required');
  if (parsed.releasePath && parsed.launchdPlistPath) throw new Error('--release and --launchd-plist are mutually exclusive');
  if (!parsed.targetUrl) throw new Error('--target-url is required');
  if (parsed.releasePath) parsed.releasePath = requireAbsolute('--release', parsed.releasePath);
  if (parsed.launchdPlistPath) parsed.launchdPlistPath = requireAbsolute('--launchd-plist', parsed.launchdPlistPath);
  if (parsed.manifestPath) parsed.manifestPath = requireAbsolute('--manifest', parsed.manifestPath);
  parsed.repoRoot = requireAbsolute('--repo-root', parsed.repoRoot);
  if (!isNonEmptyString(parsed.instance)) throw new Error('--instance must be non-empty');
  if (!isNonEmptyString(parsed.source)) throw new Error('--source must be non-empty');
  return parsed;
}

function isSafeTargetUrl(targetUrl: string): boolean {
  if (/^git@[A-Za-z0-9.-]+:[^\s]+$/i.test(targetUrl)) return true;
  try {
    const parsed = new URL(targetUrl);
    if (parsed.protocol === 'https:') return !parsed.username && !parsed.password;
    return parsed.protocol === 'ssh:' && !parsed.password;
  } catch {
    return false;
  }
}

function isSafeTargetRef(targetRef: string): boolean {
  return /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(targetRef)
    && !targetRef.includes('..')
    && !targetRef.includes('//')
    && !targetRef.includes('@{')
    && !targetRef.endsWith('/')
    && !targetRef.endsWith('.');
}

export const resolveRemoteTarget: ReleaseTargetResolver = (targetUrl, targetRef) => {
  const proc = spawnSync('git', ['ls-remote', '--exit-code', '--refs', targetUrl, targetRef], {
    encoding: 'utf8',
    env: cleanGitEnv(),
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
  });
  if (proc.status !== 0 || proc.error) {
    return {
      ok: false,
      reason: 'target-unavailable',
      detail: proc.error?.message ?? `git ls-remote exited ${String(proc.status)}`,
    };
  }
  const rows = proc.stdout.trim().split('\n').filter(Boolean);
  const match = rows
    .map((row) => row.split(/\s+/))
    .find((parts) => parts.length === 2 && parts[1] === targetRef);
  const commit = match?.[0]?.toLowerCase() ?? '';
  if (!FULL_OBJECT_ID.test(commit)) {
    return { ok: false, reason: 'target-output-invalid', detail: 'remote did not return one full object ID for the exact target ref' };
  }
  return { ok: true, commit };
};

function resolutionHint(state: ReleaseCurrencyState, reason: ReleaseCurrencyReason): string {
  if (state === 'current') return 'The deployed manifest commit exactly matches the observed target ref.';
  if (state === 'target-differs') {
    return 'Review the approved release and required capabilities before rollout; this observation does not authorize deploying the target.';
  }
  if (reason === 'manifest-unavailable' || reason === 'manifest-invalid' || reason === 'manifest-release-path-mismatch' || reason === 'invalid-deployed-commit') {
    return 'Verify the active release path and repair or re-cut its manifest through the reviewed release workflow.';
  }
  if (reason === 'unsafe-target-url' || reason === 'invalid-target-ref') {
    return 'Configure an explicit HTTPS/SSH Git remote and a full refs/heads/... target ref.';
  }
  return 'Verify the configured remote/ref/network path and rerun the read-only currency observation.';
}

function runEmit(
  options: LiveReleaseCurrencyAlertOptions,
  result: Omit<LiveReleaseCurrencyAlertResult, 'alert'>,
  eventType: 'alert' | 'clear',
): ReleaseAlertEmitResult {
  const summary = result.state === 'current'
    ? `release currency current: ${path.basename(result.releasePath)}`
    : result.state === 'target-differs'
      ? `release currency target differs: ${path.basename(result.releasePath)}`
      : `release currency inconclusive: ${path.basename(result.releasePath)} (${result.reason})`;
  return emitReleaseAlert(options, {
    summary,
    evidence: JSON.stringify(result, null, 2),
    diagnostics: [
      `release=${result.releasePath}`,
      `manifest=${result.manifestPath}`,
      `target_ref=${result.target.ref}`,
    ],
    severity: 'warning',
  }, eventType);
}

function baseResult(
  options: LiveReleaseCurrencyAlertOptions,
  manifestPath: string,
  state: ReleaseCurrencyState,
  reason: ReleaseCurrencyReason,
  deployed: LiveReleaseCurrencyAlertResult['deployed'],
  targetCommit: string | null,
): Omit<LiveReleaseCurrencyAlertResult, 'alert'> {
  return {
    check: 'live-release-currency-alert',
    state,
    reason,
    healthImpact: 'none',
    observedAt: new Date().toISOString(),
    releasePath: path.resolve(options.releasePath),
    manifestPath,
    deployed,
    target: { ref: options.targetRef, commit: targetCommit },
    resolutionHint: resolutionHint(state, reason),
  };
}

export async function checkLiveReleaseCurrency(
  options: LiveReleaseCurrencyAlertOptions,
): Promise<LiveReleaseCurrencyAlertResult> {
  const manifestPath = path.resolve(options.manifestPath ?? path.join(options.releasePath, RELEASE_MANIFEST_FILE));
  let deployed: LiveReleaseCurrencyAlertResult['deployed'] = { ref: null, commit: null };
  let observation: Omit<LiveReleaseCurrencyAlertResult, 'alert'>;
  let manifestBody: string;
  try {
    manifestBody = readFileSync(manifestPath, 'utf8');
  } catch {
    observation = baseResult(options, manifestPath, 'inconclusive', 'manifest-unavailable', deployed, null);
    return finalize(options, observation);
  }
  let manifest: ReleaseSnapshotManifest;
  try {
    manifest = parseReleaseSnapshotManifest(JSON.parse(manifestBody) as unknown);
  } catch {
    const reason: ReleaseCurrencyReason = 'manifest-invalid';
    observation = baseResult(options, manifestPath, 'inconclusive', reason, deployed, null);
    return finalize(options, observation);
  }
  deployed = { ref: manifest.source.ref, commit: manifest.source.commit.toLowerCase() };
  if (path.resolve(manifest.release.path) !== path.resolve(options.releasePath)) {
    observation = baseResult(options, manifestPath, 'inconclusive', 'manifest-release-path-mismatch', deployed, null);
    return finalize(options, observation);
  }
  if (!deployed.commit || !FULL_OBJECT_ID.test(deployed.commit)) {
    observation = baseResult(options, manifestPath, 'inconclusive', 'invalid-deployed-commit', deployed, null);
    return finalize(options, observation);
  }
  if (!isSafeTargetUrl(options.targetUrl)) {
    observation = baseResult(options, manifestPath, 'inconclusive', 'unsafe-target-url', deployed, null);
    return finalize(options, observation);
  }
  if (!isSafeTargetRef(options.targetRef)) {
    observation = baseResult(options, manifestPath, 'inconclusive', 'invalid-target-ref', deployed, null);
    return finalize(options, observation);
  }
  let resolved: ReleaseTargetResolution;
  try {
    resolved = await (options.resolveTarget ?? resolveRemoteTarget)(options.targetUrl, options.targetRef);
  } catch {
    resolved = { ok: false, reason: 'target-unavailable', detail: 'target resolver failed' };
  }
  if (!resolved.ok) {
    observation = baseResult(options, manifestPath, 'inconclusive', resolved.reason, deployed, null);
    return finalize(options, observation);
  }
  const targetCommit = resolved.commit.toLowerCase();
  if (!FULL_OBJECT_ID.test(targetCommit)) {
    observation = baseResult(options, manifestPath, 'inconclusive', 'target-output-invalid', deployed, null);
    return finalize(options, observation);
  }
  const matches = deployed.commit === targetCommit;
  observation = baseResult(
    options,
    manifestPath,
    matches ? 'current' : 'target-differs',
    matches ? 'exact-commit-match' : 'exact-commit-mismatch',
    deployed,
    targetCommit,
  );
  return finalize(options, observation);
}

function finalize(
  options: LiveReleaseCurrencyAlertOptions,
  observation: Omit<LiveReleaseCurrencyAlertResult, 'alert'>,
): LiveReleaseCurrencyAlertResult {
  const alertKind: 'alert' | 'clear' | null = observation.state === 'current'
    ? (options.clearOnCurrent ? 'clear' : null)
    : 'alert';
  const emitResult = alertKind && options.emit ? runEmit(options, observation, alertKind) : null;
  const emitStatus = emitResult?.status ?? null;
  const result = {
    ...observation,
    alert: {
      required: alertKind !== null,
      attempted: Boolean(emitResult),
      kind: alertKind,
      status: emitStatus,
      stdout: emitResult?.stdout ?? '',
      stderr: emitResult?.stderr ?? '',
    },
  };
  if (emitResult && emitStatus !== 0) {
    return {
      ...result,
      state: 'inconclusive',
      reason: 'emit-failed',
      resolutionHint: 'The observation completed but BOT ERRORS publication failed; inspect the local outbox and emitter path.',
    };
  }
  return result;
}

function toOptions(parsed: ParsedArgs): LiveReleaseCurrencyAlertOptions {
  const releasePath = parsed.releasePath ?? resolveReleasePathFromLaunchdPlist(parsed.launchdPlistPath!);
  return {
    repoRoot: parsed.repoRoot,
    releasePath,
    manifestPath: parsed.manifestPath,
    targetUrl: parsed.targetUrl!,
    targetRef: parsed.targetRef,
    instance: parsed.instance,
    source: parsed.source,
    emit: parsed.emit,
    emitHelper: parsed.emitHelper ? requireAbsolute('--emit-helper', parsed.emitHelper) : path.join(parsed.repoRoot, 'deploy/scripts/bot-errors-emit.py'),
    python: parsed.python,
    clearOnCurrent: parsed.clearOnCurrent,
  };
}

export async function run(argv: string[] = process.argv.slice(2)): Promise<LiveReleaseCurrencyAlertResult> {
  const parsed = parseArgs(argv);
  const result = await checkLiveReleaseCurrency(toOptions(parsed));
  if (parsed.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`release currency ${result.state}: ${result.releasePath} (${result.reason})`);
  if (result.state === 'target-differs') process.exitCode = 1;
  else if (result.state === 'inconclusive') process.exitCode = 2;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
}
