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
import { assertKnownFlag, isHelpFlag, takeValue } from './lib/cli-args.ts';
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

const KNOWN_FLAGS = ['--binary', '--help', '-h'] as const;
const PROBE_TIMEOUT_MS = 15_000;

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
  let binary: string | null = null;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (isHelpFlag(arg)) {
      help = true;
      continue;
    }
    assertKnownFlag(arg, KNOWN_FLAGS);
    if (!arg.startsWith('-')) throw new Error(`unknown argument: ${arg}`);
    if (arg === '--binary') {
      if (binary !== null) throw new Error('--binary may be provided only once');
      const taken = takeValue(argv, index, arg);
      binary = taken.value;
      index = taken.index;
    }
  }
  return { binary, help };
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
  // The raw output is classified, never echoed.
  const observed = parseClaudeAuthStatusIdentity(probe.output);
  if (probe.status !== 'ok') {
    if (observed.kind === 'absent' && observed.reason === 'not-logged-in') {
      deps.stderr('claude CLI reports not logged in for this config root — log in interactively first, then re-run');
      return 2;
    }
    deps.stderr('auth-status probe exited non-zero; no digest captured');
    return 4;
  }
  if (observed.kind === 'unparseable') {
    deps.stderr('auth-status output unparseable; no digest captured');
    return 3;
  }
  if (observed.kind === 'absent') {
    if (observed.reason === 'not-logged-in') {
      deps.stderr('claude CLI reports not logged in for this config root — log in interactively first, then re-run');
      return 2;
    }
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
    // Explicit allow-list — never hand the CLI probe the operator's full shell
    // env. CLAUDE_CONFIG_DIR is forwarded when set so the digest is captured
    // for the config root the service resolves (mirrors the runtime's probe).
    env: {
      // env-allowed: child-env forward; explicit per-var allow-list, not passthrough
      HOME: process.env['HOME'],
      // env-allowed: ambient OS PATH contract for executable resolution
      PATH: process.env['PATH'],
      // env-allowed: child-env forward; explicit per-var allow-list, not passthrough
      USER: process.env['USER'],
      // env-allowed: external-tool interop; must track the env the spawned claude CLI sees
      ...(process.env['CLAUDE_CONFIG_DIR'] ? { CLAUDE_CONFIG_DIR: process.env['CLAUDE_CONFIG_DIR'] } : {}),
    },
    stdout: (line) => { process.stdout.write(`${line}\n`); },
    stderr: (line) => { process.stderr.write(`${line}\n`); },
  }).then((code) => { process.exitCode = code; });
}
