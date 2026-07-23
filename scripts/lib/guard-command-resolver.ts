/**
 * Resolve a package.json `guard:*` script command to the REAL guard entrypoint.
 *
 * WHY THIS EXISTS — it encodes the exact bug that produced a false-green vacuity sweep this
 * session. A naive "first script-looking token" regex over each guard command matches
 * `scripts/run-with-pinned-node.sh` — the pinned-node WRAPPER that every `guard:*` command
 * begins with — NOT the guard. A sweep built on that regex spawned the wrapper 43 times
 * (node failing to load a `.sh` as a module, ~7ms each) and reported "0 vacuous of 41",
 * examining nothing. See `whatsoup-cicd-inflight-state-2026-07-22.md` (retraction, 2026-07-23).
 *
 * So the ONE invariant this module guarantees: a resolved entrypoint is NEVER a wrapper. If a
 * command's only script-shaped token is a wrapper, that is a resolver defect and we THROW
 * rather than hand back the wrapper — a loud failure the caller cannot mistake for a guard.
 *
 * PURE by design: string in, classification out. No fs, no spawn, no process. The spawning
 * lives in the test that consumes this, which is what makes the resolution rules unit-testable
 * (including the wrapper case) without running anything.
 */

/** The pinned-runtime wrappers every guard command is invoked through. Never an entrypoint. */
export const WRAPPERS: ReadonlySet<string> = new Set([
  'scripts/run-with-pinned-node.sh',
  'scripts/run-with-pinned-npm.sh',
]);

/**
 * A token that looks like a script entrypoint: a repo-relative `scripts/x.ts` /
 * `deploy/scripts/y.sh`, or an ABSOLUTE path to one. Real package.json commands only ever use
 * the relative form; the absolute form is accepted so a caller can resolve a full path (the
 * self-test uses a synthetic guard in a temp dir). The extension list is the runnable set.
 */
const ENTRYPOINT_TOKEN = /^(?:\/|(?:deploy\/)?scripts\/)[\w\-./]+\.(?:ts|mts|cts|mjs|cjs|js|jsx|sh)$/;

/** Interpreters we know how to drive from a test. */
export type Interpreter = 'node-strip' | 'node' | 'bash';

export interface ResolvedEntrypoint {
  kind: 'entrypoint';
  /** Repo-relative path of the guard's real entrypoint (never a wrapper). */
  script: string;
  interpreter: Interpreter;
  /** Literal trailing args after the entrypoint (e.g. `--check`), shell tokens excluded. */
  trailingArgs: string[];
}

export type SkipReason = 'alias' | 'network' | 'composite';

export interface SkippedCommand {
  kind: 'skip';
  reason: SkipReason;
  /** For `alias`, the base `guard:*` script it delegates to; otherwise a human detail. */
  detail: string;
}

export type ResolvedCommand = ResolvedEntrypoint | SkippedCommand;

/** Thrown when a command resolves to nothing but a wrapper — the line-2755 defect, made loud. */
export class WrapperResolutionError extends Error {
  constructor(command: string) {
    super(
      `guard command resolved only to a pinned-runtime wrapper, not a guard entrypoint: ${command}. ` +
        'This is the exact defect that produced a false-green vacuity sweep — refusing to return it.',
    );
    this.name = 'WrapperResolutionError';
  }
}

function interpreterFor(script: string): Interpreter {
  if (/\.(?:ts|mts|cts)$/.test(script)) return 'node-strip';
  if (script.endsWith('.sh')) return 'bash';
  return 'node';
}

/**
 * Classify one package.json `guard:*` command string.
 *
 * Order matters: network and alias/composite shapes are recognised BEFORE the entrypoint scan,
 * because those commands may also contain a script token that is not the thing actually run
 * (e.g. `gh api … | bash …wrapper… scripts/x.ts` is network, not a runnable x.ts probe).
 */
export function resolveGuardCommand(command: string): ResolvedCommand {
  const trimmed = command.trim();

  // Network: reaches a live API; cannot be judged against an offline empty tree.
  if (/\bgh\s+api\b/.test(trimmed)) {
    return { kind: 'skip', reason: 'network', detail: 'invokes `gh api` (live GitHub); not offline-judgeable' };
  }

  // Alias: delegates to another guard: script already covered by its own entry.
  const alias = trimmed.match(/npm run (guard:[\w:-]+)/);
  if (alias) {
    return { kind: 'skip', reason: 'alias', detail: alias[1]! };
  }

  // Any other `npm run` delegates to a non-guard script (e.g. drift:classify --self-check).
  if (/\bnpm run\b/.test(trimmed)) {
    return { kind: 'skip', reason: 'composite', detail: 'delegates via `npm run` to a non-guard script' };
  }

  // Shell composition / interpolation: piping, chaining, subshells, or `$VAR` args mean the
  // command is not a single runnable entrypoint with literal args (e.g. deployer-static's `"$PWD"`).
  if (/[|;]|&&|\$\(|`|\$\{|"\$|\s\$\w/.test(trimmed)) {
    return { kind: 'skip', reason: 'composite', detail: 'shell pipe/chain/variable-interpolation; not a single literal invocation' };
  }

  const tokens = trimmed.split(/\s+/);
  const scriptTokens = tokens.filter((t) => ENTRYPOINT_TOKEN.test(t));
  const entrypoint = scriptTokens.find((t) => !WRAPPERS.has(t));

  if (!entrypoint) {
    // Only-a-wrapper is a resolver defect; no-script-at-all is a composite we don't run.
    if (scriptTokens.length > 0 && scriptTokens.every((t) => WRAPPERS.has(t))) {
      throw new WrapperResolutionError(command);
    }
    return { kind: 'skip', reason: 'composite', detail: 'no guard entrypoint token found' };
  }

  const idx = tokens.indexOf(entrypoint);
  const trailingArgs = tokens.slice(idx + 1).filter((t) => t !== '' && t !== '-');

  return { kind: 'entrypoint', script: entrypoint, interpreter: interpreterFor(entrypoint), trailingArgs };
}

/**
 * Assert a value is a resolved entrypoint whose script is not a wrapper. The resolver already
 * guarantees this, but callers that spawn a process should re-assert at the boundary so the
 * line-2755 class can never silently reappear downstream of a refactor.
 */
export function assertRealEntrypoint(resolved: ResolvedCommand, command: string): asserts resolved is ResolvedEntrypoint {
  if (resolved.kind !== 'entrypoint') {
    throw new Error(`expected an entrypoint for: ${command} (got skip:${resolved.reason})`);
  }
  if (WRAPPERS.has(resolved.script)) {
    throw new WrapperResolutionError(command);
  }
}
