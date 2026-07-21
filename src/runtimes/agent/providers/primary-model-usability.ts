export type PrimaryModelUsabilityStatus =
  | 'usable'
  | 'model-unavailable'
  | 'credential-unavailable'
  | 'provider-unavailable'
  | 'timeout'
  | 'unknown';

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

export interface PrimaryModelProbeAdapters {
  // model: null = probe the CLI's own default model (claude-cli only) — a
  // model-less instance must still be probeable or recovery can never pass.
  probeBinaryModel?: (target: { provider: string; model: string | null }) => Promise<BinaryModelProbeResult>;
  // Despite the legacy name, this must exercise a generation-class API path:
  // catalog/list-model checks can pass while quota-limited turns still fail.
  probeApiModelAccess?: (target: { provider: 'openai-api' | 'anthropic-api'; model: string }) => Promise<ApiModelAccessProbeResult>;
}

export interface PrimaryModelProbeOptions {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const TIMEOUT = Symbol('primary-model-probe-timeout');
const PROBE_THROW = Symbol('primary-model-probe-throw');

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
    const probe = await withTimeout(() => adapters.probeBinaryModel!({ provider, model }), timeoutMs);
    if (probe === TIMEOUT) return result(target, model, 'timeout');
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
    const probe = await withTimeout(() => adapters.probeApiModelAccess!({ provider, model }), timeoutMs);
    if (probe === TIMEOUT) return result(target, model, 'timeout');
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

async function withTimeout<T>(
  run: () => Promise<T>,
  timeoutMs: number,
): Promise<T | typeof TIMEOUT | typeof PROBE_THROW> {
  if (timeoutMs <= 0) return TIMEOUT;
  return new Promise<T | typeof TIMEOUT | typeof PROBE_THROW>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(TIMEOUT);
    }, timeoutMs);
    timer.unref?.();

    let promise: Promise<T>;
    try {
      promise = run();
    } catch {
      settled = true;
      clearTimeout(timer);
      resolve(PROBE_THROW);
      return;
    }

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(PROBE_THROW);
      },
    );
  });
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
