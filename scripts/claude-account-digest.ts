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
import {
  CLAUDE_AUTH_STATUS_ARGS,
  scrubbedAuthStatusEnv,
} from '../src/runtimes/agent/providers/account-auth-status.ts';
import { probeBinaryCommand } from '../src/runtimes/agent/providers/binary-preflight.ts';
import { parseClaudeAuthStatusIdentity } from '../src/runtimes/agent/providers/claude-account-identity.ts';
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
  ) => Promise<{ status: 'ok' | 'failed'; output: string }>;
  env: NodeJS.ProcessEnv;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const PROBE_TIMEOUT_MS = 15_000;

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

  let binary: string | null = args.binary;
  if (binary === null) {
    try {
      binary = deps.getProviderBinary();
    } catch {
      binary = null;
    }
  }
  if (!binary) {
    deps.stderr('claude binary not found: pass --binary <path> or fix PATH');
    return 4;
  }

  let probe: { status: 'ok' | 'failed'; output: string };
  try {
    probe = await deps.probe(binary, [...CLAUDE_AUTH_STATUS_ARGS], scrubbedAuthStatusEnv(deps.env));
  } catch {
    deps.stderr('auth-status probe failed to run');
    return 4;
  }
  // The raw output is classified, never echoed. Not-logged-in is recognized
  // regardless of exit status (the CLI reports it structurally either way).
  const observed = parseClaudeAuthStatusIdentity(probe.output);
  if (observed.kind === 'absent' && observed.reason === 'not-logged-in') {
    deps.stderr('claude CLI reports not logged in for this config root — log in interactively first, then re-run');
    return 2;
  }
  if (probe.status !== 'ok') {
    deps.stderr('auth-status probe exited non-zero; no digest captured');
    return 4;
  }
  if (observed.kind === 'unparseable') {
    deps.stderr('auth-status output unparseable; no digest captured');
    return 3;
  }
  if (observed.kind === 'absent') {
    deps.stderr('auth-status output has identity fields missing; no digest captured');
    return 3;
  }
  deps.stdout(observed.digest);
  return 0;
}

if (process.argv[1]?.endsWith('claude-account-digest.ts')) {
  runClaudeAccountDigest(process.argv.slice(2), {
    getProviderBinary: () => getProviderBinary('claude-cli'),
    probe: (binary, args, env) => probeBinaryCommand(binary, args, env, { timeoutMs: PROBE_TIMEOUT_MS }),
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
