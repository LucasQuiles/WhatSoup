import { isHelpFlag, takeValue } from './lib/cli-args.ts';
import {
  LaunchdReconcileRefusedError,
  reconcileLaunchdPlist,
  type LaunchdReconcileOptions,
  type LaunchdReconcileResult,
} from '../src/fleet/platform.ts';
import { isValidInstanceName } from '../src/fleet/instance-name.ts';
import { LaunchdRenderConfigError } from '../src/lib/launchd-service-config.ts';

export interface ReconcileLaunchdRestartPolicyArgs {
  instance: string | null;
  apply: boolean;
  /** Acknowledge that --apply may drop installed non-governed EnvironmentVariables keys. */
  dropNonGovernedEnv: boolean;
  help: boolean;
}

export interface ReconcileLaunchdRestartPolicyDependencies {
  platform: NodeJS.Platform;
  reconcile: (
    name: string,
    options: LaunchdReconcileOptions,
  ) => Promise<LaunchdReconcileResult>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const USAGE = [
  'Usage: npm run reconcile-launchd-restart-policy -- --instance <name> [--apply [--drop-non-governed-env]]',
  '',
  'Dry-run is the default. --apply reloads and starts/restarts one named macOS job after validating its generated plist identity.',
  'Applying regenerates the whole plist: installed EnvironmentVariables keys the render does not own are dropped from the job.',
  '--apply refuses when the dry-run report lists such keys unless --drop-non-governed-env acknowledges the drop.',
].join('\n');

/** Parse a deliberately narrow, one-instance launchd reconciliation command. */
export function parseReconcileLaunchdRestartPolicyArgs(
  argv: readonly string[],
): ReconcileLaunchdRestartPolicyArgs {
  let instance: string | null = null;
  let apply = false;
  let dropNonGovernedEnv = false;
  let dryRunRequested = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (isHelpFlag(arg)) {
      help = true;
      continue;
    }
    if (arg === '--instance') {
      if (instance !== null) throw new Error('--instance may be provided only once');
      const taken = takeValue(argv, index, arg);
      instance = taken.value;
      index = taken.index;
      continue;
    }
    if (arg === '--apply') {
      apply = true;
      continue;
    }
    if (arg === '--drop-non-governed-env') {
      dropNonGovernedEnv = true;
      continue;
    }
    if (arg === '--dry-run') {
      dryRunRequested = true;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  if (apply && dryRunRequested) {
    throw new Error('--apply and --dry-run cannot be used together');
  }
  if (help) return { instance, apply, dropNonGovernedEnv, help };
  if (dropNonGovernedEnv && !apply) {
    throw new Error('--drop-non-governed-env requires --apply');
  }
  if (instance === null) throw new Error('--instance is required');
  if (!isValidInstanceName(instance)) {
    throw new Error('invalid instance name');
  }

  return { instance, apply, dropNonGovernedEnv, help };
}

/**
 * Governed-env report lines for operator output: key names, states, and
 * short value digests only — installed plists carry live credentials, so no
 * environment value is ever printed. The all-clear line is printed only when
 * there is nothing at all to report: governed drift, a differing PATH tail,
 * and keys an apply would drop each suppress it.
 */
function governedEnvLines(comparison: LaunchdReconcileResult['governedEnvDrift']): string[] {
  if (!comparison) return [];
  if (!comparison.comparable) {
    return ['governed env: installed EnvironmentVariables unparseable (fail-closed: treat as drift; --apply refuses without --drop-non-governed-env)'];
  }
  const digest = (value: string | null): string =>
    value === null ? 'absent' : `sha256:${value.slice(0, 12)}`;
  const lines = comparison.drift.map((entry) =>
    `governed env drift: ${entry.key} ${entry.state} expected=${digest(entry.expectedDigest)} observed=${digest(entry.observedDigest)}`);
  const prefix = comparison.pathPrefix;
  if (prefix && prefix.satisfied && prefix.ambientTailDiffers) {
    const prefixState = prefix.configured ? 'PATH configured prefix satisfied' : 'PATH no pathPrepend configured';
    lines.push(`governed env: ${prefixState}; tail differs from this shell's PATH (expected=${digest(prefix.expectedDigest)} observed=${digest(prefix.observedDigest)}) — --apply bakes this shell's PATH tail`);
  }
  const dropped = comparison.droppedNonGovernedKeys ?? [];
  if (dropped.length > 0) {
    lines.push(`installed plist has ${dropped.length} non-governed EnvironmentVariables keys (${dropped.join(', ')}) that --apply will drop`);
  }
  if (lines.length === 0) lines.push('governed env: no drift');
  return lines;
}

function defaultDependencies(): ReconcileLaunchdRestartPolicyDependencies {
  return {
    platform: process.platform,
    reconcile: reconcileLaunchdPlist,
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  };
}

/**
 * Execute the opt-in reloader without exposing an arbitrary plist path, uid,
 * launchd label, or shell command to the caller.
 */
export async function runReconcileLaunchdRestartPolicy(
  argv: readonly string[],
  deps: ReconcileLaunchdRestartPolicyDependencies = defaultDependencies(),
): Promise<number> {
  let args: ReconcileLaunchdRestartPolicyArgs;
  try {
    args = parseReconcileLaunchdRestartPolicyArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid arguments';
    deps.stderr(`reconcile-launchd-restart-policy: ${message}`);
    return 2;
  }

  if (args.help) {
    deps.stdout(USAGE);
    return 0;
  }
  if (deps.platform !== 'darwin') {
    deps.stderr('reconcile-launchd-restart-policy: this command is only available on macOS');
    return 2;
  }

  try {
    const result = await deps.reconcile(args.instance!, {
      dryRun: !args.apply,
      dropNonGovernedEnv: args.dropNonGovernedEnv,
    });
    const verb = result.dryRun ? 'DRY RUN: would reload and start' : 'reloaded and started';
    deps.stdout(`${verb} ${result.label}`);
    for (const line of governedEnvLines(result.governedEnvDrift)) deps.stdout(line);
    return 0;
  } catch (error) {
    // Render-config and refusal messages are content-free by construction
    // (rule text, errno codes, key names); every other failure class
    // (launchctl output, filesystem paths) stays behind the generic line.
    if (error instanceof LaunchdRenderConfigError || error instanceof LaunchdReconcileRefusedError) {
      deps.stderr(`reconcile-launchd-restart-policy: ${error.message}`);
    } else {
      deps.stderr(`reconcile-launchd-restart-policy: reconciliation failed for ${args.instance}`);
    }
    return 1;
  }
}

if (process.argv[1]?.endsWith('reconcile-launchd-restart-policy.ts')) {
  void runReconcileLaunchdRestartPolicy(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
