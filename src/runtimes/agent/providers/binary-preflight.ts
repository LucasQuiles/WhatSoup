// src/runtimes/agent/providers/binary-preflight.ts
// Pre-flight probe: verify a provider binary is spawnable on this host.
//
// Fail-open contract: anything other than a definitive ENOENT is 'unknown',
// so a binary that exists but misbehaves on --version (non-zero exit, garbled
// output) is still considered present — presence is the question, not perfect
// operation. The key invariant is that a clean ENOENT → 'missing' so operators
// receive a loud alert when the binary is simply not installed.

import { spawn, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { SIGNAL } from '../../../lib/signals.ts';
import { isNonEmptyString, isRecord } from '../../../lib/type-guards.ts';

export interface BinaryPreflightResult {
  status: 'present' | 'missing' | 'unknown' | 'incompatible';
  /** First line of stdout from `binary --version` when present, else null. */
  version: string | null;
}

const PROBE_TIMEOUT_MS = 5_000;
/** Hard ceiling for model-catalogue stdout. The configured-provider verbose
 *  catalogue is normally well below this; a larger stream is treated as an
 *  untrusted shape change instead of growing memory without bound. */
const MODEL_CATALOG_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;
/** Defensive ceiling for the native Codex JSON catalogue. */
const CODEX_MODEL_CATALOG_MAX_ENTRIES = 4_096;

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
    let stderrBuffer = '';
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
        stdio: ['ignore', 'pipe', 'pipe'] as const,
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
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString('utf8');
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

      // Incompatible architecture binary — stderr contains a recognized
      // exec-format error signal from the OS-level loader. Empty stdout is
      // an additional gate to avoid false-positives on CLIs that exit
      // non-zero for unrelated reasons (missing auth, first-run setup).
      const stderr = stderrBuffer.trim();
      if (
        !stdoutBuffer.trim()
        && stderr
        && /^(Exec format error|Bad CPU type|cannot execute binary file)/.test(stderr)
      ) {
        settle({ status: 'incompatible', version: null });
        return;
      }

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
  signal?: AbortSignal;
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
 * - caller abort → terminate, then settle only when the child closes
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
    let terminationStarted = false;
    let abortRequested = false;
    let abortListener: (() => void) | undefined;

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

    const removeAbortListener = (): void => {
      if (options.signal && abortListener) {
        options.signal.removeEventListener('abort', abortListener);
        abortListener = undefined;
      }
    };

    if (options.signal?.aborted) {
      notifyProcessClosed();
      settle({ status: 'failed', output: '' });
      return;
    }

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

    const terminate = (): void => {
      if (terminationStarted) return;
      terminationStarted = true;
      try { child.kill(); } catch { /* ignore kill errors */ }
      killEscalationTimer = setTimeout(() => {
        try { child.kill(SIGNAL.KILL); } catch { /* already exited: the probe process may have already exited before this escalation fires, so kill throwing here is expected and safe to ignore. */ }
      }, KILL_ESCALATION_GRACE_MS);
      killEscalationTimer.unref?.();
    };

    const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
    killTimer = setTimeout(() => {
      terminate();
      settle({ status: 'failed', output: combinedOutput() });
    }, timeoutMs);
    killTimer.unref?.();

    if (options.signal) {
      abortListener = () => {
        abortRequested = true;
        clearTimeout(killTimer);
        terminate();
      };
      options.signal.addEventListener('abort', abortListener, { once: true });
      if (options.signal.aborted) abortListener();
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString('utf8');
    });

    child.on('error', () => {
      clearTimeout(killTimer);
      // A failed spawn has no process lifetime to protect. For errors from an
      // already-spawned child, retain ownership until its close event. Keep
      // any termination escalation armed too: an error does not prove that
      // the spawned process closed or accepted the first termination signal.
      if (child.pid === undefined) {
        removeAbortListener();
        notifyProcessClosed();
      }
      // Once caller cancellation owns a spawned child, `close` is the shared
      // terminal event for both result settlement and lease release. An
      // intervening process error must not let the timeout receipt get ahead
      // of that process-lifetime boundary.
      if (!abortRequested || child.pid === undefined) {
        settle({ status: 'failed', output: combinedOutput() });
      }
    });

    child.on('close', (code) => {
      clearTimeout(killTimer);
      clearTimeout(killEscalationTimer);
      removeAbortListener();
      notifyProcessClosed();
      settle({ status: !abortRequested && code === 0 ? 'ok' : 'failed', output: combinedOutput() });
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
export type ModelCatalogUnavailableReason =
  | 'spawn-error'
  | 'timeout'
  | 'empty'
  | 'command-error'
  | 'unparseable'
  | 'output-limit';

export type ModelCatalogCaptureMode = 'refreshed' | 'cached' | 'legacy';

/** Normalized subset of OpenCode's verbose model record used by fallback
 *  discovery. Missing fields are UNKNOWN, never inferred. */
export interface ModelCatalogMetadata {
  status?: string;
  releaseDate?: string;
  textOutput?: boolean;
  toolCall?: boolean;
  zeroCost?: boolean;
}

/** Result of {@link listModelCatalog}: the harness's dynamic model catalogue.
 *  Discriminated so the resolver can label a timeout distinctly from an empty
 *  catalogue rather than collapse both to a bare "unavailable". */
export type ModelCatalogListing =
  | {
      status: 'ok';
      ids: string[];
      /** Optional for injected/legacy adapters; real captures always provide it. */
      metadata?: Record<string, ModelCatalogMetadata>;
      /** Optional for injected/legacy adapters; absence is treated as legacy. */
      captureMode?: ModelCatalogCaptureMode;
      /** Why the refreshed capture was unavailable when cached/legacy data won. */
      refreshFailure?: ModelCatalogUnavailableReason;
    }
  | { status: 'unavailable'; reason: ModelCatalogUnavailableReason };

/**
 * List the dynamic, per-harness model catalogue used by `/config model` and
 * fallback discovery. OpenCode is queried pure/refreshed/verbose first, then
 * pure/cached/verbose, then through the legacy ID-only command for older
 * gateways. Every successful path discloses its capture mode.
 *
 * Honest-degrade contract: anything that is not a clean close with ≥1 id →
 * `{ status: 'unavailable', reason }` so the resolver renders a reason-specific,
 * actionable line rather than an empty or fake list. Never throws.
 */
export async function listModelCatalog(
  binary: string,
  spawnImpl: typeof spawn = spawn,
): Promise<ModelCatalogListing> {
  const refreshed = await collectModelCatalogOutput(
    binary,
    ['models', '--pure', '--refresh', '--verbose'],
    spawnImpl,
  );
  if (refreshed.ok) {
    const parsed = parseVerboseModelCatalog(refreshed.output, true);
    if (parsed) {
      return { status: 'ok', ...parsed, captureMode: 'refreshed' };
    }
  } else if (refreshed.reason === 'spawn-error') {
    return { status: 'unavailable', reason: 'spawn-error' };
  }
  const refreshFailure: ModelCatalogUnavailableReason = refreshed.ok
    ? 'unparseable'
    : refreshed.reason;

  // A failed upstream refresh does not erase a usable on-disk models.dev
  // cache. Read it explicitly and label the result CACHED.
  const cached = await collectModelCatalogOutput(
    binary,
    ['models', '--pure', '--verbose'],
    spawnImpl,
  );
  if (cached.ok) {
    const parsed = parseVerboseModelCatalog(cached.output);
    if (parsed) {
      return { status: 'ok', ...parsed, captureMode: 'cached', refreshFailure };
    }
  } else if (cached.reason === 'spawn-error') {
    return { status: 'unavailable', reason: 'spawn-error' };
  } else if (cached.reason === 'timeout') {
    // A second PURE invocation wedged. A non-pure compatibility retry would
    // load more startup surfaces and extend boot delay without useful evidence.
    return { status: 'unavailable', reason: 'timeout' };
  }

  // Compatibility path for older/custom gateways that do not support pure or
  // verbose model listing. It preserves IDs but exposes no capability claims.
  const legacy = await collectModelCatalogOutput(binary, ['models'], spawnImpl);
  if (!legacy.ok) {
    return { status: 'unavailable', reason: legacy.reason };
  }
  const ids = parseLegacyModelCatalog(legacy.output);
  if (!ids) {
    return {
      status: 'unavailable',
      reason: isNonEmptyString(legacy.output) ? 'unparseable' : 'empty',
    };
  }
  return { status: 'ok', ids, metadata: {}, captureMode: 'legacy', refreshFailure };
}

/**
 * List picker-visible models from Codex's native runtime catalogue.
 *
 * Modern Codex releases expose `debug models` as JSON. Without `--bundled`,
 * Codex uses its own online-if-uncached policy; that policy may return a cache
 * or bundled fallback without disclosing which source won. This adapter only
 * claims what the command proves: the catalogue captured from this binary on
 * this host. Freshness provenance is disclosed by the resolver, not invented
 * here.
 *
 * The parser accepts the official visibility enum (`list`, `hide`, `none`),
 * returns only picker-visible slugs, and rejects the entire capture on a shape
 * change, unsafe slug, duplicate, oversized list, or command failure. Never
 * throws.
 */
export async function listCodexModelCatalog(
  binary: string,
  spawnImpl: typeof spawn = spawn,
): Promise<ModelCatalogListing> {
  const outcome = await collectModelCatalogOutput(
    binary,
    ['debug', 'models', '--disable', 'multi_agent'],
    spawnImpl,
  );
  if (!outcome.ok) return { status: 'unavailable', reason: outcome.reason };

  const ids = parseCodexModelCatalog(outcome.output);
  if (ids === null) return { status: 'unavailable', reason: 'unparseable' };
  if (ids.length === 0) return { status: 'unavailable', reason: 'empty' };
  return { status: 'ok', ids };
}

type CatalogCommandOutcome =
  | { ok: true; output: string }
  | { ok: false; reason: ModelCatalogUnavailableReason };

function collectModelCatalogOutput(
  binary: string,
  args: string[],
  spawnImpl: typeof spawn,
  env?: NodeJS.ProcessEnv,
): Promise<CatalogCommandOutcome> {
  return new Promise<CatalogCommandOutcome>((resolve) => {
    let settled = false;
    let stdoutBuffer = '';
    let stdoutBytes = 0;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let killEscalationTimer: ReturnType<typeof setTimeout> | undefined;

    const settle = (result: CatalogCommandOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve(result);
    };

    let child: ReturnType<typeof spawnImpl>;
    try {
      child = spawnImpl(binary, args, {
        stdio: ['ignore', 'pipe', 'ignore'],
        env,
        windowsHide: true,
      } as SpawnOptionsWithoutStdio);
    } catch {
      settle({ ok: false, reason: 'spawn-error' });
      return;
    }

    const terminate = (): void => {
      try { child.kill(); } catch { /* ignore kill errors */ }
      killEscalationTimer = setTimeout(() => {
        try { child.kill(SIGNAL.KILL); } catch { /* already exited: the catalogue process may finish during the grace period, so a failed escalation is expected and safe to ignore. */ }
      }, KILL_ESCALATION_GRACE_MS);
      killEscalationTimer.unref?.();
    };

    killTimer = setTimeout(() => {
      terminate();
      settle({ ok: false, reason: 'timeout' });
    }, PROBE_TIMEOUT_MS);
    killTimer.unref?.();

    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return;
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MODEL_CATALOG_OUTPUT_LIMIT_BYTES) {
        terminate();
        settle({ ok: false, reason: 'output-limit' });
        return;
      }
      stdoutBuffer += chunk.toString('utf8');
    });

    child.on('error', () => {
      settle({ ok: false, reason: 'spawn-error' });
    });

    child.on('close', (code) => {
      clearTimeout(killEscalationTimer);
      if (settled) return;
      if (code !== 0) {
        settle({ ok: false, reason: 'command-error' });
        return;
      }
      settle(
        isNonEmptyString(stdoutBuffer)
          ? { ok: true, output: stdoutBuffer }
          : { ok: false, reason: 'empty' },
      );
    });
  });
}

function looksLikeCatalogModelId(id: string): boolean {
  const slash = id.indexOf('/');
  return slash > 0
    && slash < id.length - 1
    && !/[\s{}\[\]",]/.test(id);
}

function looksLikeCodexModelSlug(value: unknown): value is string {
  return isNonEmptyString(value)
    && value.length <= 256
    && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value);
}

function parseCodexModelCatalog(output: string): string[] | null {
  let root: unknown;
  try {
    root = JSON.parse(output);
  } catch {
    return null;
  }
  if (!isRecord(root) || !Array.isArray(root.models)) return null;
  if (root.models.length > CODEX_MODEL_CATALOG_MAX_ENTRIES) return null;

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of root.models) {
    if (!isRecord(entry) || !looksLikeCodexModelSlug(entry.slug)) return null;
    if (entry.visibility !== 'list' && entry.visibility !== 'hide' && entry.visibility !== 'none') {
      return null;
    }
    if (seen.has(entry.slug)) return null;
    seen.add(entry.slug);
    if (entry.visibility === 'list') ids.push(entry.slug);
  }
  return ids;
}

function parseLegacyModelCatalog(output: string): string[] | null {
  const ids = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (ids.length === 0 || ids.some((id) => !looksLikeCatalogModelId(id))) return null;
  return ids;
}

/** Return a sortable lower-bound day for a models.dev release date. The
 *  upstream schema permits both YYYY-MM and YYYY-MM-DD; month precision maps
 *  to its first day for ordering without inventing day precision in health. */
export function modelCatalogReleaseDateSortKey(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}(?:-\d{2})?$/.test(value)) return null;
  const candidate = value.length === 7 ? `${value}-01` : value;
  const parsed = new Date(`${candidate}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate
    ? candidate
    : null;
}

/** Parse the `model-id` + pretty-printed JSON record stream emitted by
 *  `opencode models --verbose`. Any framing/id mismatch rejects the verbose
 *  attempt; individual optional fields are retained only when type-valid. */
function parseVerboseModelCatalog(
  output: string,
  allowRefreshBanner = false,
): { ids: string[]; metadata: Record<string, ModelCatalogMetadata> } | null {
  const lines = output.split(/\r?\n/);
  const ids: string[] = [];
  const metadata: Record<string, ModelCatalogMetadata> = {};
  let index = 0;

  while (index < lines.length && !isNonEmptyString(lines[index])) index += 1;
  if (
    allowRefreshBanner
    && index < lines.length
    && /^(?:\u001b\[[0-9;]*m)*Models cache refreshed(?:\u001b\[[0-9;]*m)*$/.test(lines[index]!)
  ) {
    index += 1;
  }

  while (index < lines.length) {
    while (index < lines.length && !isNonEmptyString(lines[index])) index += 1;
    if (index >= lines.length) break;

    const modelId = lines[index]!.trim();
    if (!looksLikeCatalogModelId(modelId)) return null;
    if (Object.prototype.hasOwnProperty.call(metadata, modelId)) return null;
    index += 1;
    while (index < lines.length && !isNonEmptyString(lines[index])) index += 1;
    if (index >= lines.length || lines[index]!.trim() !== '{') return null;

    const jsonLines: string[] = [];
    let depth = 0;
    let inString = false;
    let escaped = false;
    let completed = false;
    for (; index < lines.length; index += 1) {
      const line = lines[index]!;
      jsonLines.push(line);
      for (const char of line) {
        if (inString) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') inString = false;
          continue;
        }
        if (char === '"') inString = true;
        else if (char === '{') depth += 1;
        else if (char === '}') depth -= 1;
        if (depth < 0) return null;
      }
      if (depth === 0) {
        completed = true;
        index += 1;
        break;
      }
    }
    if (!completed || inString) return null;

    let record: unknown;
    try {
      record = JSON.parse(jsonLines.join('\n'));
    } catch {
      return null;
    }
    if (!isRecord(record)) return null;

    const slash = modelId.indexOf('/');
    if (record['providerID'] !== modelId.slice(0, slash) || record['id'] !== modelId.slice(slash + 1)) {
      return null;
    }

    const normalized: ModelCatalogMetadata = {};
    if (isNonEmptyString(record['status'])) {
      normalized.status = record['status'].trim().toLowerCase();
    }
    const releaseDate = record['release_date'];
    if (typeof releaseDate === 'string' && modelCatalogReleaseDateSortKey(releaseDate) !== null) {
      normalized.releaseDate = releaseDate;
    }
    const cost = record['cost'];
    if (isRecord(cost)) {
      const numericCosts = finiteNumericLeaves(cost);
      if (
        typeof cost['input'] === 'number'
        && Number.isFinite(cost['input'])
        && typeof cost['output'] === 'number'
        && Number.isFinite(cost['output'])
        && numericCosts !== null
      ) {
        normalized.zeroCost = numericCosts.every((price) => price === 0);
      }
    }
    const capabilities = record['capabilities'];
    if (isRecord(capabilities)) {
      if (typeof capabilities['toolcall'] === 'boolean') {
        normalized.toolCall = capabilities['toolcall'];
      }
      const outputCapabilities = capabilities['output'];
      if (isRecord(outputCapabilities) && typeof outputCapabilities['text'] === 'boolean') {
        normalized.textOutput = outputCapabilities['text'];
      }
    }

    ids.push(modelId);
    metadata[modelId] = normalized;
  }

  return ids.length > 0 ? { ids, metadata } : null;
}

/** Every model-catalogue cost leaf must be a finite number before we make a
 *  zero-cost claim. This includes nested cache prices and fails closed when a
 *  gateway adds an unrecognized non-numeric charge field. */
function finiteNumericLeaves(value: Record<string, unknown>): number[] | null {
  const values: number[] = [];
  for (const nested of Object.values(value)) {
    if (typeof nested === 'number' && Number.isFinite(nested)) {
      values.push(nested);
      continue;
    }
    if (!isRecord(nested)) return null;
    const leaves = finiteNumericLeaves(nested);
    if (leaves === null) return null;
    values.push(...leaves);
  }
  return values;
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
 *    apart from an empty catalogue (reason-specific degradation contract).
 * Never throws. `killTimer` is declared before `settle` captures it so a
 * synchronous spawn throw cannot hit a TDZ (same hazard as probeFallbackBinary).
 */
function collectModelCatalogIds(
  binary: string,
  spawnImpl: typeof spawn,
  env?: NodeJS.ProcessEnv,
): Promise<CatalogProbeOutcome> {
  return collectModelCatalogOutput(binary, ['models'], spawnImpl, env).then((outcome) => {
    if (!outcome.ok) return outcome;
    const ids = parseLegacyModelCatalog(outcome.output);
    return ids
      ? { ok: true, ids }
      : { ok: false, reason: isNonEmptyString(outcome.output) ? 'unparseable' : 'empty' };
  });
}
