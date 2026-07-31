import { isHelpFlag, takeValue } from './lib/cli-args.ts';
import {
  reconcileLaunchdPlist,
  type LaunchdReconcileOptions,
  type LaunchdReconcileResult,
} from '../src/fleet/platform.ts';
import { isValidInstanceName } from '../src/fleet/instance-name.ts';

export interface ReconcileLaunchdRestartPolicyArgs {
  instance: string | null;
  apply: boolean;
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
  'Usage: npm run reconcile-launchd-restart-policy -- --instance <name> [--apply]',
  '',
  'Dry-run is the default. --apply reloads and starts/restarts one named macOS job after validating its generated plist identity.',
].join('\n');

/** Parse a deliberately narrow, one-instance launchd reconciliation command. */
export function parseReconcileLaunchdRestartPolicyArgs(
  argv: readonly string[],
): ReconcileLaunchdRestartPolicyArgs {
  let instance: string | null = null;
  let apply = false;
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
    if (arg === '--dry-run') {
      dryRunRequested = true;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  if (apply && dryRunRequested) {
    throw new Error('--apply and --dry-run cannot be used together');
  }
  if (help) return { instance, apply, help };
  if (instance === null) throw new Error('--instance is required');
  if (!isValidInstanceName(instance)) {
    throw new Error('invalid instance name');
  }

  return { instance, apply, help };
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
    });
    const verb = result.dryRun ? 'DRY RUN: would reload and start' : 'reloaded and started';
    deps.stdout(`${verb} ${result.label}`);
    return 0;
  } catch {
    deps.stderr(`reconcile-launchd-restart-policy: reconciliation failed for ${args.instance}`);
    return 1;
  }
}

if (process.argv[1]?.endsWith('reconcile-launchd-restart-policy.ts')) {
  void runReconcileLaunchdRestartPolicy(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
