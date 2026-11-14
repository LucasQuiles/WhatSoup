export type PrimaryModelUsabilityStatus =
  | 'usable'
  | 'model-unavailable'
  | 'credential-unavailable'
  | 'provider-unavailable'
  | 'timeout'
  | 'unknown'
  // #3017 AXIS C: probe fail-closed outcomes. 'probe-blocked' = the probe
  // target context (config root, credential-store class, binary digest,
  // provider, or model) differs from the serving context receipt — the probe
  // cannot prove anything about the serving environment, so it blocks rather
  // than producing a misleading green. 'probe-error' = the probe itself threw
  // or failed in a way that is not a timeout.
  | 'probe-blocked'
  | 'probe-error';

// #3017 AXIS C: content-free runtime-primary service context. This is captured
// once for the configured service generation, independently of any active child.
// Every later probe compares its effective selector environment and the exact
// executable identity it will invoke against this immutable context.
export type PrimaryProbeBinaryState = 'none' | 'missing' | 'resolved';

export interface PrimaryProbeServiceContext {
  /** Configured primary provider for this runtime generation. */
  readonly provider: string;
  /** Configured primary model; null means the provider default. */
  readonly model: string | null;
  /** Runtime/configuration generation; never serialized raw. */
  readonly serviceGeneration: string;
  /** Hash of the safe effective launch selectors only. */
  readonly launchContextHash: string;
  /** APIs have no CLI identity; CLI is either resolved or missing. */
  readonly binaryState: PrimaryProbeBinaryState;
  /** Hash of the resolved executable path, never the raw path. */
  readonly resolvedBinaryPathHash: string | null;
  /** Full SHA-256 of the resolved executable, when present. */
  readonly binarySha256: string | null;
}

export interface PrimaryModelProbeTarget {
  provider: string;
  model?: string | null;
  binary?: string | null;
}

export interface PrimaryModelUsabilityResult {
  status: PrimaryModelUsabilityStatus;
  provider: string;
  model: string | null;
  reason?: string;
  suggestion?: string | null;
}

/**
 * The selected Claude CLI cleanly reported no strict-MCP parser option, so no
 * model child ran. This is inconclusive rather than an actionable model fault.
 */
export const CLAUDE_CLI_LACKS_STRICT_MCP_CONFIG = 'claude-cli-lacks-strict-mcp-config';

export type BinaryModelProbeResult =
  | { status: 'ok' }
  | { status: 'model_unavailable' }
  | { status: 'credential_unavailable' }
  | { status: 'provider_unavailable' }
  | { status: 'timeout' }
  | { status: 'unknown'; reason?: string };

export type ApiModelAccessProbeResult =
  | { status: 'found' }
  | { status: 'not_found' }
  | { status: 'credential_failed' }
  | { status: 'provider_unavailable' }
  | { status: 'timeout' }
  | { status: 'unknown'; reason?: string };

// #3557: the probe stage an adapter has entered. A cancelled probe's timeout
// reason names the stage that was in flight, so a stalled credential heal, gate
// wait, child run, or API request is distinguishable after the fact. Bounded,
// content-free vocabulary: it is surfaced verbatim in /health
// primaryModelUsability.reason and in the diagnostic finding's data.
export type PrimaryModelProbeStage =
  | 'prepare'
  | 'credential-heal'
  | 'gate-wait'
  | 'child-run'
  | 'api-request';

export type PrimaryModelProbeStageReporter = (stage: PrimaryModelProbeStage) => void;

export interface PrimaryModelProbeAdapters {
  // Preparation run BEFORE the probe's deadline is armed (the claude-cli
  // refresh-ahead, see claude-refresh-ahead.ts). Nothing aborts it and the default
  // probe budget is never charged for it. A caller's signal or explicit timeoutMs
  // ends only the wait: the work keeps running. Must never reject.
  // Resolving { defer } means the probe must not run now (a refresh-ahead
  // child is still running); the result is an inconclusive 'unknown'.
  prepareBinaryModel?: (target: { provider: string; model: string | null }) => Promise<void | { defer: string }>;
  // model: null = probe the CLI's own default model (claude-cli only) — a
  // model-less instance must still be probeable or recovery can never pass.
  // When a signal is supplied, production adapters must settle after abort so
  // the caller's timeout receipt cannot precede cancellation acknowledgement.
  // onStage is called synchronously on entry to each stage; an adapter that
  // never calls it yields an '-unreported' stage on cancellation.
  probeBinaryModel?: (
    target: { provider: string; model: string | null },
    signal?: AbortSignal,
    onStage?: PrimaryModelProbeStageReporter,
  ) => Promise<BinaryModelProbeResult>;
  // Despite the legacy name, this must exercise a generation-class API path:
  // catalog/list-model checks can pass while quota-limited turns still fail.
  probeApiModelAccess?: (
    target: { provider: 'openai-api' | 'anthropic-api'; model: string },
    signal?: AbortSignal,
    onStage?: PrimaryModelProbeStageReporter,
  ) => Promise<ApiModelAccessProbeResult>;
}

export interface PrimaryModelProbeOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Reason of a probe deferred because a refresh-ahead child is still running. */
export const DEFERRED_REFRESH_IN_FLIGHT = 'deferred-refresh-in-flight';
/** A refresh owner could not be safely read or published; the probe was not started. */
export const REFRESH_OWNER_UNAVAILABLE = 'refresh-owner-unavailable';
/** A refresh child completed unsuccessfully; the probe was not started. */
export const REFRESH_AHEAD_FAILED = 'refresh-failed';

const DEFAULT_TIMEOUT_MS = 15_000;
const TIMEOUT = Symbol('primary-model-probe-timeout');
const PROBE_THROW = Symbol('primary-model-probe-throw');
const PREPARATION_DEADLINE = Symbol('primary-model-preparation-deadline');

// A cancelled probe. reason is one of: 'caller-pre-aborted',
// 'deadline-nonpositive', or '<cause>-<stage>' where cause is 'deadline' or
// 'caller-abort' and stage is a PrimaryModelProbeStage or 'unreported'.
interface ProbeTimeout {
  readonly kind: typeof TIMEOUT;
  readonly reason: string;
}

export async function probePrimaryModelUsability(
  target: PrimaryModelProbeTarget,
  adapters: PrimaryModelProbeAdapters = {},
  options: PrimaryModelProbeOptions = {},
): Promise<PrimaryModelUsabilityResult> {
  const provider = target.provider;
  const model = normalizedModel(target.model);
  // claude-cli resolves its own default model, so a null model is probeable for it
  // (its probe adapter omits the model flag, mirroring turn argv) — short-circuiting
  // claude-cli here stranded model-less instances in permanent fallback (recovery
  // probe could never return usable — observed in production as a permanently
  // extending fallback window). opencode-cli is NOT default-probeable: it derives
  // the child's credential from the model prefix (buildChildEnv) and has no usable
  // default, and config admission requires a model for it (agent-config-validator).
  // A null-model opencode-cli is therefore not-configured, same as codex/gemini/api
  // providers — probing it would only hit buildChildEnv's credential-route throw.
  if (model === null && provider !== 'claude-cli') {
    return result(target, null, 'unknown', 'model-not-configured');
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (provider === 'claude-cli' || provider === 'opencode-cli') {
    if (!adapters.probeBinaryModel) {
      return result(target, model, 'unknown', 'binary-model-probe-unavailable');
    }
    let probeBudgetMs = timeoutMs;
    if (adapters.prepareBinaryModel && !options.signal?.aborted && timeoutMs > 0) {
      const startedAt = performance.now();
      const prepared = await waitForPreparation(
        () => adapters.prepareBinaryModel!({ provider, model }),
        options.timeoutMs,
        options.signal,
      );
      if (prepared === PREPARATION_DEADLINE) return result(target, model, 'timeout', 'deadline-prepare');
      // A caller that cancelled meanwhile gets its cancellation outcome below
      // (caller-pre-aborted), not the deferral.
      if (prepared && prepared.defer && !options.signal?.aborted) return result(target, model, 'unknown', prepared.defer);
      // An explicit deadline covers preparation, so it is not rebased here.
      if (options.timeoutMs !== undefined) probeBudgetMs = options.timeoutMs - (performance.now() - startedAt);
    }
    const probe = await withCancellationDeadline(
      (signal, onStage) => adapters.probeBinaryModel!({ provider, model }, signal, onStage),
      probeBudgetMs,
      options.signal,
    );
    if (isProbeTimeout(probe)) return result(target, model, 'timeout', probe.reason);
    if (probe === PROBE_THROW) return result(target, model, 'unknown', 'probe-threw');
    return mapBinaryModelProbe(target, model, probe);
  }

  if (provider === 'openai-api' || provider === 'anthropic-api') {
    if (model === null) {
      // Unreachable (the non-claude null-model case returned above) — kept as a
      // real branch so the compiler narrows without a cast and a future reorder
      // of the early return cannot silently send null into the API probe.
      return result(target, null, 'unknown', 'model-not-configured');
    }
    if (!adapters.probeApiModelAccess) {
      return result(target, model, 'unknown', 'api-model-probe-unavailable');
    }
    const probe = await withCancellationDeadline(
      (signal, onStage) => adapters.probeApiModelAccess!({ provider, model }, signal, onStage),
      timeoutMs,
      options.signal,
    );
    if (isProbeTimeout(probe)) return result(target, model, 'timeout', probe.reason);
    if (probe === PROBE_THROW) return result(target, model, 'unknown', 'probe-threw');
    return mapApiModelProbe(target, model, probe);
  }

  return result(target, model, 'unknown', 'unsupported-provider');
}

function mapBinaryModelProbe(
  target: PrimaryModelProbeTarget,
  model: string | null,
  probe: BinaryModelProbeResult,
): PrimaryModelUsabilityResult {
  switch (probe.status) {
    case 'ok':
      return result(target, model, 'usable');
    case 'model_unavailable':
      return result(target, model, 'model-unavailable');
    case 'credential_unavailable':
      return result(target, model, 'credential-unavailable');
    case 'provider_unavailable':
      return result(target, model, 'provider-unavailable');
    case 'timeout':
      return result(target, model, 'timeout');
    case 'unknown':
      return result(target, model, 'unknown', probe.reason);
  }
}

function mapApiModelProbe(
  target: PrimaryModelProbeTarget,
  model: string,
  probe: ApiModelAccessProbeResult,
): PrimaryModelUsabilityResult {
  switch (probe.status) {
    case 'found':
      return result(target, model, 'usable');
    case 'not_found':
      return result(target, model, 'model-unavailable');
    case 'credential_failed':
      return result(target, model, 'credential-unavailable');
    case 'provider_unavailable':
      return result(target, model, 'provider-unavailable');
    case 'timeout':
      return result(target, model, 'timeout');
    case 'unknown':
      return result(target, model, 'unknown', probe.reason);
  }
}

function result(
  target: PrimaryModelProbeTarget,
  model: string | null,
  status: PrimaryModelUsabilityStatus,
  reason?: string,
): PrimaryModelUsabilityResult {
  return {
    status,
    provider: target.provider,
    model,
    ...(reason ? { reason } : {}),
  };
}

function normalizedModel(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function probeTimeout(reason: string): ProbeTimeout {
  return { kind: TIMEOUT, reason };
}

function isProbeTimeout(value: unknown): value is ProbeTimeout {
  return typeof value === 'object' && value !== null && (value as ProbeTimeout).kind === TIMEOUT;
}

/**
 * Wait for preparation, or until the caller stops waiting. No signal reaches the
 * preparation: the refresh child it protects keeps running after the wait ends,
 * and later callers join it. A throw or late rejection stays fail-open.
 */
async function waitForPreparation(
  prepare: () => Promise<void | { defer: string }>,
  explicitDeadlineMs: number | undefined,
  callerSignal: AbortSignal | undefined,
): Promise<void | { defer: string } | typeof PREPARATION_DEADLINE> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onCallerAbort: (() => void) | undefined;
  const stopped = new Promise<void | typeof PREPARATION_DEADLINE>((resolve) => {
    onCallerAbort = () => resolve();
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
    if (explicitDeadlineMs !== undefined) {
      timer = setTimeout(() => resolve(PREPARATION_DEADLINE), explicitDeadlineMs);
      timer.unref?.();
    }
  });
  try {
    const preparation = (async () => prepare())().catch(() => undefined);
    return await Promise.race([preparation, stopped]);
  } finally {
    clearTimeout(timer);
    if (onCallerAbort) callerSignal?.removeEventListener('abort', onCallerAbort);
  }
}

async function withCancellationDeadline<T>(
  run: (signal: AbortSignal, onStage: PrimaryModelProbeStageReporter) => Promise<T>,
  timeoutMs: number,
  callerSignal?: AbortSignal,
): Promise<T | ProbeTimeout | typeof PROBE_THROW> {
  if (callerSignal?.aborted) return probeTimeout('caller-pre-aborted');
  if (timeoutMs <= 0) return probeTimeout('deadline-nonpositive');

  const controller = new AbortController();
  // Monotonic, like the timer: a wall-clock step must not move the deadline.
  const deadlineAt = performance.now() + timeoutMs;
  let cause: 'deadline' | 'caller-abort' | null = null;
  let currentStage: PrimaryModelProbeStage | null = null;
  // Adapter stages can be synchronous (the credential heal blocks the event
  // loop), so the deadline timer may only run after a later stage has begun.
  // Attribute a deadline to the stage in flight at the deadline instant, not
  // the stage in flight when the timer callback finally runs.
  let stageAtDeadline: PrimaryModelProbeStage | null = null;
  const onStage = (stage: PrimaryModelProbeStage): void => {
    if (controller.signal.aborted) return;
    currentStage = stage;
    if (performance.now() <= deadlineAt) stageAtDeadline = stage;
  };
  const abortFor = (kind: 'deadline' | 'caller-abort') => (): void => {
    cause ??= kind;
    // A deadline aborts with a TimeoutError reason (as AbortSignal.timeout does)
    // so an adapter can tell its own deadline from a caller's cancellation.
    controller.abort(kind === 'deadline' ? new DOMException('primary model probe deadline', 'TimeoutError') : undefined);
  };
  const onCallerAbort = abortFor('caller-abort');
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
  const timer = setTimeout(abortFor('deadline'), timeoutMs);
  timer.unref?.();
  const timedOut = (): ProbeTimeout => {
    const kind = cause ?? 'caller-abort';
    const stage = kind === 'deadline' ? stageAtDeadline : currentStage;
    return probeTimeout(`${kind}-${stage ?? 'unreported'}`);
  };

  try {
    let promise: Promise<T>;
    try {
      promise = run(controller.signal, onStage);
    } catch {
      return controller.signal.aborted ? timedOut() : PROBE_THROW;
    }
    try {
      const value = await promise;
      return controller.signal.aborted ? timedOut() : value;
    } catch {
      return controller.signal.aborted ? timedOut() : PROBE_THROW;
    }
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }
}

/**
 * Whether a probe result raises, clears or keeps the alert for a claude CLI that
 * lacks --strict-mcp-config. Such a CLI is never model-probed, so it makes no
 * usability claim, but the missing capability is actionable. Only a usable probe
 * clears: its model child ran with --strict-mcp-config, so the CLI accepted the
 * option, while any other result proves nothing about it. A usable result clears
 * even when no alert is known, so a restarted process also retires an alert raised
 * before it started. Callers pass probe results only, never a turn success.
 */
export function probeIncompatibilityAlertAction(
  result: PrimaryModelUsabilityResult,
  alertActive: boolean,
): 'raise' | 'clear' | 'none' {
  if (result.status === 'unknown' && result.reason === CLAUDE_CLI_LACKS_STRICT_MCP_CONFIG) return alertActive ? 'none' : 'raise';
  return result.status === 'usable' ? 'clear' : 'none';
}

/**
 * Whether a primary-model usability probe result should raise an operator alert.
 * Pure predicate over PrimaryModelUsabilityResult, relocated from AgentRuntime
 * (god-class decomposition slice BEAD-PURE-3). An 'unknown' caused by missing
 * config, an unsupported provider, a deferred refresh, or a skipped strict-MCP
 * Claude probe is not actionable; any other non-'usable' status is.
 */
export function primaryModelUsabilityRequiresAlert(result: PrimaryModelUsabilityResult): boolean {
  // model === null no longer implies not-probed: claude-cli default-model probes
  // carry null and their real failures (e.g. credential-unavailable) must alert.
  if (result.status === 'unknown') {
    // A probe deferred behind a running refresh-ahead child proved nothing
    // either way; the refresh-ahead module logs the child (error at its cap).
    return result.reason !== 'model-not-configured'
      && result.reason !== 'unsupported-provider'
      && result.reason !== DEFERRED_REFRESH_IN_FLIGHT
      && result.reason !== CLAUDE_CLI_LACKS_STRICT_MCP_CONFIG;
  }
  return result.status !== 'usable';
}
