// src/runtimes/agent/providers/binary-preflight.ts
// Pre-flight probe: verify a provider binary is spawnable on this host.
//
// Fail-open contract: anything other than a definitive ENOENT is 'unknown',
// so a binary that exists but misbehaves on --version (non-zero exit, garbled
// output) is still considered present — presence is the question, not perfect
// operation. The key invariant is that a clean ENOENT → 'missing' so operators
// receive a loud alert when the binary is simply not installed.

import { spawn, type SpawnOptionsWithoutStdio } from 'node:child_process';

export interface BinaryPreflightResult {
  status: 'present' | 'missing' | 'unknown';
  /** First line of stdout from `binary --version` when present, else null. */
  version: string | null;
}

const PROBE_TIMEOUT_MS = 5_000;

/**
 * Probe whether `binary` is spawnable on this host.
 *
 * Spawns `binary ['--version']` with piped stdio, a caller-supplied explicit
 * environment, and a 5 s timeout.
 *
 * - `ENOENT` spawn error → `{ status: 'missing', version: null }`
 * - stdout produced before exit (regardless of exit code) → `{ status: 'present', version: <first line> }`
 * - timeout or any non-ENOENT error → `{ status: 'unknown', version: null }` (fail-open)
 *
 * Injectable `spawnImpl` for unit tests (defaults to `node:child_process` `spawn`).
 * Never throws.
 */
export async function probeFallbackBinary(
  binary: string,
  env: NodeJS.ProcessEnv,
  spawnImpl: typeof spawn = spawn,
): Promise<BinaryPreflightResult> {
  return new Promise<BinaryPreflightResult>((resolve) => {
    let settled = false;
    let stdoutBuffer = '';
    // Declare killTimer before settle() captures it in a closure so there is no
    // TDZ hazard when spawnImpl throws synchronously (settle would be called
    // before the `const killTimer = …` assignment is reached).
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const settle = (result: BinaryPreflightResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve(result);
    };

    let child: ReturnType<typeof spawnImpl>;
    try {
      child = spawnImpl(binary, ['--version'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        env,
      } as SpawnOptionsWithoutStdio);
    } catch (err) {
      // Synchronous throw from spawn itself (rare, platform-dependent).
      // Treat as unknown rather than missing — we did not get a clean ENOENT.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        settle({ status: 'missing', version: null });
      } else {
        settle({ status: 'unknown', version: null });
      }
      return;
    }

    killTimer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore kill errors */ }
      settle({ status: 'unknown', version: null });
    }, PROBE_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8');
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        settle({ status: 'missing', version: null });
      } else {
        settle({ status: 'unknown', version: null });
      }
    });

    child.on('close', () => {
      if (settled) return;
      // Binary executed (even if it exited non-zero) — presence is confirmed.
      const firstLine = stdoutBuffer.split('\n')[0]?.trim() ?? null;
      settle({ status: 'present', version: firstLine || null });
    });
  });
}

export interface BinaryAuthStatusResult {
  /** 'ok' = exited 0 within the timeout; 'failed' = non-zero exit, spawn
   *  error, or timeout. */
  status: 'ok' | 'failed';
  /** Combined stdout+stderr captured before settling ('' when nothing was
   *  produced — spawn error or silent timeout). */
  output: string;
}

export interface BinaryCommandProbeOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Called once spawn is proven absent or the child emits close. */
  onProcessClosed?: () => void;
}

/** Grace period between the timeout kill (SIGTERM) and the SIGKILL escalation. */
const KILL_ESCALATION_GRACE_MS = 2_000;

/**
 * Probe a provider binary's auth status without blocking the event loop.
 *
 * Spawns `binary args` (e.g. `claude ['auth','status','--json']`) with piped
 * stdout+stderr, a caller-scrubbed env, and the same 5 s kill-timer discipline
 * as the other probes — plus SIGKILL escalation: if the child ignores the
 * timeout kill for {@link KILL_ESCALATION_GRACE_MS}, it is SIGKILLed so a
 * wedged probe can never accumulate zombie children across recheck cadences.
 *
 * - exit code 0 before the timeout → `{ status: 'ok', output }`
 * - non-zero exit, spawn error, or timeout → `{ status: 'failed', output }`
 *
 * Auth-message classification is the caller's job — this function only answers
 * "did the probe command complete cleanly, and what did it say".
 *
 * Injectable `spawnImpl` for unit tests. Never throws, never rejects.
 */
export async function probeBinaryAuthStatus(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  spawnImpl: typeof spawn = spawn,
): Promise<BinaryAuthStatusResult> {
  return probeBinaryCommand(binary, args, env, {}, spawnImpl);
}

export async function probeBinaryCommand(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  options: BinaryCommandProbeOptions = {},
  spawnImpl: typeof spawn = spawn,
): Promise<BinaryAuthStatusResult> {
  return new Promise<BinaryAuthStatusResult>((resolve) => {
    let settled = false;
    let stdoutBuffer = '';
    let stderrBuffer = '';
    // Declared before settle() captures them so a synchronous spawn throw
    // cannot hit a TDZ (same hazard as probeFallbackBinary above).
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let killEscalationTimer: ReturnType<typeof setTimeout> | undefined;
    let processClosedNotified = false;

    const notifyProcessClosed = (): void => {
      if (processClosedNotified) return;
      processClosedNotified = true;
      options.onProcessClosed?.();
    };

    const combinedOutput = (): string => `${stdoutBuffer}\n${stderrBuffer}`.trim();

    const settle = (result: BinaryAuthStatusResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child: ReturnType<typeof spawnImpl>;
    try {
      child = spawnImpl(binary, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        windowsHide: true,
      });
    } catch {
      notifyProcessClosed();
      settle({ status: 'failed', output: '' });
      return;
    }

    const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
    killTimer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore kill errors */ }
      // Escalate if the child ignores the polite kill. The probe result is
      // already settled below — escalation is pure child-cleanup.
      killEscalationTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore kill errors */ }
      }, KILL_ESCALATION_GRACE_MS);
      killEscalationTimer.unref?.();
      settle({ status: 'failed', output: combinedOutput() });
    }, timeoutMs);
    killTimer.unref?.();

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString('utf8');
    });

    child.on('error', () => {
      clearTimeout(killTimer);
      clearTimeout(killEscalationTimer);
      // A failed spawn has no process lifetime to protect. For errors from an
      // already-spawned child, retain ownership until its close event.
      if (child.pid === undefined) notifyProcessClosed();
      settle({ status: 'failed', output: combinedOutput() });
    });

    child.on('close', (code) => {
      clearTimeout(killTimer);
      clearTimeout(killEscalationTimer);
      notifyProcessClosed();
      settle({ status: code === 0 ? 'ok' : 'failed', output: combinedOutput() });
    });
  });
}

export type ModelCatalogResult = {
  status: 'found' | 'not_found' | 'unknown';
  /** Catalog id with the provider's exact casing when the configured model
   *  differs from it only by case, else null. */
  suggestion: string | null;
};

/**
 * Probe whether `model` exists in the provider binary's model catalog.
 *
 * Model ids are case-sensitive on the provider side: a wrong-case id fails
 * every session with an opaque provider error that is indistinguishable from
 * an unknown model. This probe lets the runtime warn operators at window-arm
 * time instead of at first-turn failure.
 *
 * Spawns `binary ['models']` with piped stdio, a caller-supplied explicit
 * environment, and the same 5 s kill-timer discipline as
 * probeFallbackBinary, then parses stdout lines as catalog ids (blank lines
 * and surrounding whitespace ignored).
 *
 * - a line equals `model` exactly → `{ status: 'found', suggestion: null }`
 * - a line matches case-insensitively only → `{ status: 'not_found', suggestion: <catalog casing> }`
 * - no line matches → `{ status: 'not_found', suggestion: null }`
 * - spawn error, timeout, or empty output → `{ status: 'unknown', suggestion: null }` (fail-open)
 *
 * Injectable `spawnImpl` for unit tests (defaults to `node:child_process` `spawn`).
 * Never throws.
 */
export async function probeModelCatalog(
  binary: string,
  model: string,
  env: NodeJS.ProcessEnv,
  spawnImpl: typeof spawn = spawn,
): Promise<ModelCatalogResult> {
  const outcome = await collectModelCatalogIds(binary, spawnImpl, env);
  // Any non-ok outcome (could-not-run or blank output) is indistinguishable
  // from a misbehaving binary for a MATCH verdict → fail open (unknown).
  if (!outcome.ok) {
    return { status: 'unknown', suggestion: null };
  }
  if (outcome.ids.includes(model)) {
    return { status: 'found', suggestion: null };
  }
  const lowerModel = model.toLowerCase();
  const caseInsensitive = outcome.ids.find((id) => id.toLowerCase() === lowerModel) ?? null;
  return { status: 'not_found', suggestion: caseInsensitive };
}

/** Why `<binary> models` produced no usable catalogue. The catalogue resolver
 *  maps each to a distinct render reason (Q 2b#3): a timeout must not read as an
 *  empty catalogue, and a spawn failure (binary not runnable) is its own fix. */
export type ModelCatalogUnavailableReason = 'spawn-error' | 'timeout' | 'empty';

/** Result of {@link listModelCatalog}: the harness's dynamic model catalogue.
 *  Discriminated so the resolver can label a timeout distinctly from an empty
 *  catalogue rather than collapse both to a bare "unavailable". */
export type ModelCatalogListing =
  | { status: 'ok'; ids: string[] }
  | { status: 'unavailable'; reason: ModelCatalogUnavailableReason };

/**
 * List the model catalogue a provider binary self-reports via `<binary> models`
 * — the dynamic, PER-HARNESS source for the `/config model` catalogue render
 * (owner ask 2026-07-19). Same spawn + 5 s kill-timer discipline as
 * probeModelCatalog, but returns the full id list instead of a match verdict.
 *
 * Honest-degrade contract: anything that is not a clean close with ≥1 id →
 * `{ status: 'unavailable', reason }` (reason distinguishes spawn-error /
 * timeout / empty) so the resolver renders a reason-specific, actionable line
 * rather than an empty or fake list. Never throws.
 */
export async function listModelCatalog(
  binary: string,
  spawnImpl: typeof spawn = spawn,
): Promise<ModelCatalogListing> {
  const outcome = await collectModelCatalogIds(binary, spawnImpl);
  if (!outcome.ok) {
    return { status: 'unavailable', reason: outcome.reason };
  }
  return { status: 'ok', ids: outcome.ids };
}

/** Discriminated outcome of the shared `<binary> models` probe. */
type CatalogProbeOutcome =
  | { ok: true; ids: string[] }
  | { ok: false; reason: ModelCatalogUnavailableReason };

/**
 * Shared spawn+parse core for `<binary> models`, consumed by both
 * probeModelCatalog (match verdict) and listModelCatalog (full list). Spawns
 * the command with a 5 s kill-timer, collects stdout, and resolves to:
 *  - `{ ok: true, ids }` — trimmed, non-empty catalog id lines (in order) on a
 *    clean close with ≥1 line, or
 *  - `{ ok: false, reason }` — `'timeout'` (kill-timer fired), `'spawn-error'`
 *    (synchronous throw or 'error' event), or `'empty'` (clean close, no
 *    non-blank lines). The distinct reason lets the resolver label a timeout
 *    apart from an empty catalogue (Q 2b#3).
 * Never throws. `killTimer` is declared before `settle` captures it so a
 * synchronous spawn throw cannot hit a TDZ (same hazard as probeFallbackBinary).
 */
function collectModelCatalogIds(
  binary: string,
  spawnImpl: typeof spawn,
  env?: NodeJS.ProcessEnv,
): Promise<CatalogProbeOutcome> {
  return new Promise<CatalogProbeOutcome>((resolve) => {
    let settled = false;
    let stdoutBuffer = '';
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const settle = (result: CatalogProbeOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve(result);
    };

    let child: ReturnType<typeof spawnImpl>;
    try {
      child = spawnImpl(binary, ['models'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        // probeModelCatalog threads its explicit (egress-scrubbed) env so the
        // catalog probe routes like a real turn (exec-profile egress coverage);
        // listModelCatalog passes none, leaving env undefined → the child
        // inherits process.env, i.e. main's prior no-env behavior on that path.
        env,
      } as SpawnOptionsWithoutStdio);
    } catch {
      settle({ ok: false, reason: 'spawn-error' });
      return;
    }

    killTimer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore kill errors */ }
      settle({ ok: false, reason: 'timeout' });
    }, PROBE_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8');
    });

    child.on('error', () => {
      settle({ ok: false, reason: 'spawn-error' });
    });

    child.on('close', () => {
      const ids = stdoutBuffer
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      settle(ids.length > 0 ? { ok: true, ids } : { ok: false, reason: 'empty' });
    });
  });
}
