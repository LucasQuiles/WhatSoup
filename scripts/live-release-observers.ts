#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  checkLiveReleaseCurrency,
  type LiveReleaseCurrencyAlertResult,
} from './live-release-currency-alert.ts';
import {
  checkLiveReleaseDrift,
  resolveReleasePathFromLaunchdPlist,
  type LiveReleaseDriftAlertResult,
} from './live-release-drift-alert.ts';
import { takeValue } from './lib/cli-args.ts';

interface ParsedArgs {
  releasePath?: string;
  launchdPlistPath?: string;
  repoRoot: string;
  targetUrl?: string;
  targetRef: string;
  instance: string;
  emit: boolean;
  clearOnOk: boolean;
  json: boolean;
}
export interface LiveReleaseObserversResult {
  check: 'live-release-observers';
  drift: LiveReleaseDriftAlertResult;
  currency: LiveReleaseCurrencyAlertResult;
}

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');

function requireAbsolute(label: string, value: string): string {
  if (!path.isAbsolute(value)) throw new Error(`${label} must be absolute: ${value}`);
  return path.resolve(value);
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    repoRoot: REPO_ROOT,
    targetRef: 'refs/heads/main',
    instance: 'release-bot',
    emit: true,
    clearOnOk: false,
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
    else if (arg === '--repo-root') parsed.repoRoot = next();
    else if (arg === '--target-url') parsed.targetUrl = next();
    else if (arg === '--target-ref') parsed.targetRef = next();
    else if (arg === '--instance') parsed.instance = next();
    else if (arg === '--no-emit') parsed.emit = false;
    else if (arg === '--clear-on-ok') parsed.clearOnOk = true;
    else if (arg === '--json') parsed.json = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!parsed.releasePath && !parsed.launchdPlistPath) throw new Error('one of --release or --launchd-plist is required');
  if (parsed.releasePath && parsed.launchdPlistPath) throw new Error('--release and --launchd-plist are mutually exclusive');
  if (!parsed.targetUrl) throw new Error('--target-url is required');
  if (parsed.releasePath) parsed.releasePath = requireAbsolute('--release', parsed.releasePath);
  if (parsed.launchdPlistPath) parsed.launchdPlistPath = requireAbsolute('--launchd-plist', parsed.launchdPlistPath);
  parsed.repoRoot = requireAbsolute('--repo-root', parsed.repoRoot);
  return parsed;
}

export async function run(argv: string[] = process.argv.slice(2)): Promise<LiveReleaseObserversResult> {
  const parsed = parseArgs(argv);
  const releasePath = parsed.releasePath ?? resolveReleasePathFromLaunchdPlist(parsed.launchdPlistPath!);
  const emitHelper = path.join(parsed.repoRoot, 'deploy/scripts/bot-errors-emit.py');
  const drift = checkLiveReleaseDrift({
    repoRoot: parsed.repoRoot,
    releasePath,
    instance: parsed.instance,
    source: 'release-drift',
    emit: parsed.emit,
    emitHelper,
    python: 'python3',
    clearOnOk: parsed.clearOnOk,
  });
  const currency = await checkLiveReleaseCurrency({
    repoRoot: parsed.repoRoot,
    releasePath,
    targetUrl: parsed.targetUrl!,
    targetRef: parsed.targetRef,
    instance: parsed.instance,
    source: 'release-currency',
    emit: parsed.emit,
    emitHelper,
    python: 'python3',
    clearOnCurrent: parsed.clearOnOk,
  });
  const result: LiveReleaseObserversResult = { check: 'live-release-observers', drift, currency };
  if (parsed.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`release integrity: ${drift.ok ? 'clean' : 'drifted'}`);
    console.log(`release currency: ${currency.state} (${currency.reason})`);
  }

  const driftInconclusive = !drift.ok && drift.issues.length === 0;
  if (driftInconclusive || currency.state === 'inconclusive') process.exitCode = 2;
  else if (!drift.ok || currency.state === 'target-differs') process.exitCode = 1;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
}
