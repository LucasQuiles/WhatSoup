/**
 * `npm run claude-account-digest` — capture the ratified account-identity
 * digest for `service.expectedAccountDigest` (task-21).
 *
 * Runs the SAME read-only probe the runtime verifier runs
 * (`claude auth status --json`, scrubbed allow-list env, CLAUDE_CONFIG_DIR
 * taken from the invoking shell so the digest is captured for the config
 * root the service resolves) and the SAME canonicalization
 * (lib/account-identity-digest.ts), then prints exactly one line: the
 * opaque digest. No raw identifier ever reaches stdout or stderr, so the
 * command is safe to run into a shared terminal log. Never logs in.
 *
 * Exit codes: 0 digest printed; 2 not logged in; 3 identity fields missing
 * or output unparseable; 4 binary missing or probe failed; 64 usage.
 */
import { parseClosedOptions, type ClosedOptionError } from './lib/cli-args.ts';
import { scrubbedAuthStatusEnv } from '../src/runtimes/agent/providers/account-auth-status.ts';
import {
  probeBinaryCommand,
  type BinaryAuthStatusResult,
  type BinaryCommandProbeOptions,
} from '../src/runtimes/agent/providers/binary-preflight.ts';
import {
  observeClaudeAccountIdentity,
  type ObservedAccountIdentityFailureReason,
} from '../src/runtimes/agent/providers/claude-account-identity.ts';
import { getProviderBinary } from '../src/runtimes/agent/session.ts';

export interface ClaudeAccountDigestArgs {
  binary: string | null;
  help: boolean;
}

export interface ClaudeAccountDigestDependencies {
  getProviderBinary: () => string | null;
  probe: (
    binary: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    options?: BinaryCommandProbeOptions,
  ) => Promise<BinaryAuthStatusResult>;
  env: NodeJS.ProcessEnv;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

/**
 * Exit code and operator message per observation-failure class.
 *
 * A total Record over the shared failure union, so a new failure class in the
 * runtime observer is a compile error here until this script decides what it
 * means to an operator — rather than silently collapsing into a wrong code.
 * Every message is content-free: no raw identifier, no CLI output.
 */
const FAILURE_EXITS: Record<
  ObservedAccountIdentityFailureReason,
  { code: number; message: string }
> = {
  'binary-missing': { code: 4, message: 'claude binary not found: pass --binary <path> or fix PATH' },
  'probe-threw': { code: 4, message: 'auth-status probe failed to run' },
  'probe-failed': { code: 4, message: 'auth-status probe exited non-zero; no digest captured' },
  'not-logged-in': {
    code: 2,
    message: 'claude CLI reports not logged in for this config root — log in interactively first, then re-run',
  },
  unparseable: { code: 3, message: 'auth-status output unparseable; no digest captured' },
  'identity-fields-missing': { code: 3, message: 'auth-status output has identity fields missing; no digest captured' },
};

const CLOSED_OPTION_MESSAGES: Record<ClosedOptionError, string> = {
  'ci.input.duplicate-option': 'each option may be provided only once',
  'ci.input.option-unknown': 'unknown argument',
  'ci.input.option-value-missing': '--binary requires a value, but none was given',
};

const USAGE = [
  'Usage: npm run claude-account-digest [-- --binary <path-to-claude>]',
  '',
  'Prints ONE line — the opaque sha256 digest of the account the claude CLI is',
  'logged in as — for `service.expectedAccountDigest` in the instance config.',
  'Run it in the same CLAUDE_CONFIG_DIR context the service resolves, e.g.',
  '  CLAUDE_CONFIG_DIR=/absolute/claude-root npm run claude-account-digest',
  'No raw account identifier is printed. Exit 2 = not logged in, 3 = identity',
  'unreadable, 4 = binary missing or probe failed.',
].join('\n');

export function parseClaudeAccountDigestArgs(argv: readonly string[]): ClaudeAccountDigestArgs {
  const parsed = parseClosedOptions(argv, {
    booleanOptions: ['--help', '-h'],
    valueOptions: ['--binary'],
  });
  if (parsed.error !== null) throw new Error(CLOSED_OPTION_MESSAGES[parsed.error]);
  return {
    binary: parsed.values.get('--binary') ?? null,
    help: parsed.flags.has('--help') || parsed.flags.has('-h'),
  };
}

export async function runClaudeAccountDigest(
  argv: readonly string[],
  deps: ClaudeAccountDigestDependencies,
): Promise<number> {
  let args: ClaudeAccountDigestArgs;
  try {
    args = parseClaudeAccountDigestArgs(argv);
  } catch (error) {
    deps.stderr(error instanceof Error ? error.message : String(error));
    deps.stderr(USAGE);
    return 64;
  }
  if (args.help) {
    deps.stdout(USAGE);
    return 0;
  }

  // The SAME binary-resolve + probe + parse + classify ladder the runtime
  // verifier runs, including the shared probe timeout and the shared
  // auth-status env scrub. This script only decides what each outcome means to
  // an operator. The raw output is classified inside the observer, never echoed.
  const observed = await observeClaudeAccountIdentity({
    binary: args.binary,
    getProviderBinary: () => deps.getProviderBinary(),
    probeBinaryCommand: (binary, probeArgs, env, options) => deps.probe(binary, probeArgs, env, options),
    env: deps.env,
  });
  if (observed.kind === 'identity') {
    deps.stdout(observed.digest);
    return 0;
  }
  const failure = FAILURE_EXITS[observed.reason];
  deps.stderr(failure.message);
  return failure.code;
}

if (process.argv[1]?.endsWith('claude-account-digest.ts')) {
  runClaudeAccountDigest(process.argv.slice(2), {
    getProviderBinary: () => getProviderBinary('claude-cli'),
    // `options` MUST be forwarded: the probe bound is supplied by the shared
    // observer (ACCOUNT_IDENTITY_PROBE_TIMEOUT_MS), so dropping it here would
    // leave the real capture run unbounded while every test fake still passed.
    probe: (binary, args, env, options) => probeBinaryCommand(binary, args, env, options),
    // Single allow-list: scrubbedAuthStatusEnv (the same scrub the runtime
    // verifier applies) is the ONLY env filter, applied here and again —
    // idempotently — before the spawn, so the captured digest context cannot
    // drift from the service probe context. Never forwarded whole.
    // env-allowed: scrubbed to the shared auth-status allow-list, not passthrough
    env: scrubbedAuthStatusEnv(process.env),
    stdout: (line) => { process.stdout.write(`${line}\n`); },
    stderr: (line) => { process.stderr.write(`${line}\n`); },
  }).then((code) => { process.exitCode = code; });
}
