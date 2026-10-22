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

// #3017 AXIS C: content-free serving-context receipt. The probe is bound to
// the serving admission/environment: if the config root, credential-store
// class, binary digest, provider, or model differs from what the runtime
// is actually serving, the probe fail-closes with 'probe-blocked' rather
// than producing evidence about a DIFFERENT environment that could read green
// for a primary whose real serving context is broken. All fields are
// content-free hashes or identifiers — never credential material, paths
// that expose user data, or account identity.
export interface ServingContextReceipt {
  /** Short hash of the sandboxed config root (CLAUDE_CONFIG_DIR or equivalent). */
  configRootHash: string | null;
  /** Credential-store class identifier (e.g. 'keychain', 'file-store', 'api-key'). */
  credentialStoreClass: string | null;
  /** Short hash of the provider binary path + version, when applicable. */
  binaryDigest: string | null;
  /** The provider the runtime is serving turns with. */
  provider: string;
  /** The model the runtime is serving turns with (null = provider default). */
  model: string | null;
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

const DEFAULT_TIMEOUT_MS = 15_000;
const TIMEOUT = Symbol('primary-model-probe-timeout');
const PROBE_THROW = Symbol('primary-model-probe-throw');

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
    const probe = await withCancellationDeadline(
      (signal, onStage) => adapters.probeBinaryModel!({ provider, model }, signal, onStage),
      timeoutMs,
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
    controller.abort();
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
 * Whether a primary-model usability probe result should raise an operator alert.
 * Pure predicate over PrimaryModelUsabilityResult, relocated from AgentRuntime
 * (god-class decomposition slice BEAD-PURE-3). A transient 'unknown' caused by
 * missing config / unsupported provider is not actionable; any other non-'usable'
 * status is.
 */
export function primaryModelUsabilityRequiresAlert(result: PrimaryModelUsabilityResult): boolean {
  // model === null no longer implies not-probed: claude-cli default-model probes
  // carry null and their real failures (e.g. credential-unavailable) must alert.
  if (result.status === 'unknown') {
    return result.reason !== 'model-not-configured' && result.reason !== 'unsupported-provider';
  }
  return result.status !== 'usable';
}
