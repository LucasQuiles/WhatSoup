import { createHmac, randomBytes } from 'node:crypto';
import { buildChildEnv, getProviderBinary } from '../session.ts';
import {
  resolveProviderBinaryIdentity,
  type ProviderBinaryIdentity,
} from '../provider-canary-proof.ts';
import { scrubbedAuthStatusEnv } from './account-auth-status.ts';
import { buildOpenCodeRunArgs } from './opencode-execution-profile.ts';
import { classifyProviderFailure } from '../failure-taxonomy.ts';
import {
  probeBinaryCommand,
  probeBinaryAuthStatus,
  type BinaryAuthStatusResult,
  type BinaryCommandProbeOptions,
} from './binary-preflight.ts';
import { resolveApiKey, type ResolveApiKeyOptions } from '../../../lib/api-key-resolver.ts';
import { readBodyCapped } from '../../../lib/ssrf-fetch.ts';
import {
  claudeCredentialServiceForEnv,
  claudeCredentialServiceLabel,
  claudeSecureStorageDir,
  ensureClaudeFileStoreCredential,
  type ClaudeFileStoreHealResult,
} from './claude-filestore-heal.ts';
import { claudeRefreshLockGrace, refreshAheadDefersProbe, refreshClaudeLoginAhead } from './claude-refresh-ahead.ts';
import { DEFERRED_REFRESH_IN_FLIGHT, REFRESH_AHEAD_FAILED, REFRESH_OWNER_UNAVAILABLE } from './primary-model-usability.ts';
import { probeLifecycleObservers, type ProbeLifecycleLog } from './probe-lifecycle-log.ts';
import { createChildLogger } from '../../../logger.ts';
import type {
  ApiModelAccessProbeResult,
  BinaryModelProbeResult,
  PrimaryModelProbeAdapters,
  PrimaryModelProbeStageReporter,
  PrimaryProbeServiceContext,
  PrimaryProbeBinaryState,
} from './primary-model-usability.ts';
import type {
  ProviderExecutionGate,
  ProviderExecutionLease,
} from '../provider-execution-gate.ts';
import { shortHash } from '../../../lib/short-hash.ts';

const SELECTOR_FINGERPRINT_KEY = randomBytes(32);

function selectorFingerprint(value: string, length = 12): string {
  return createHmac('sha256', SELECTOR_FINGERPRINT_KEY).update(value).digest('hex').slice(0, length);
}

/** Why a primary-model probe runs; carried into its lifecycle log lines. */
export type PrimaryModelProbeTrigger = 'startup' | 'manual' | 'periodic' | 'recovery' | 'diagnostic';

/** Sink for the probe child's spawn and exit lines (a pino logger in production). */
export type PrimaryModelProbeLog = ProbeLifecycleLog;

export interface PrimaryModelProbeAdapterDeps {
  cwd?: string;
  buildChildEnv?: typeof buildChildEnv;
  getProviderBinary?: (provider: string) => string | null;
  resolveProviderBinaryIdentity?: (
    binary: string,
    pathValue: string,
  ) => ProviderBinaryIdentity;
  probeBinaryAuthStatus?: (
    binary: string,
    args: string[],
    env: NodeJS.ProcessEnv,
  ) => Promise<BinaryAuthStatusResult>;
  probeBinaryCommand?: (
    binary: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    options?: BinaryCommandProbeOptions,
  ) => Promise<BinaryAuthStatusResult>;
  resolveApiKey?: (opts: ResolveApiKeyOptions) => string;
  fetch?: typeof fetch;
  /**
   * Detect duplicate credential stores before a claude-cli probe without
   * copying credentials (see claude-filestore-heal.ts). Injectable for tests.
   */
  ensureClaudeFileStoreCredential?: () => ClaudeFileStoreHealResult;
  /**
   * Egress proxy port (#1607, F6). When the runtime has an active egress
   * allowlist proxy, its port is threaded here so the model/recovery probe's
   * child env carries `HTTP_PROXY`/`HTTPS_PROXY` (+ lowercase) and the probe's
   * own egress is adjudicated instead of leaking unproxied. Undefined when the
   * instance has not opted into the allowlist.
   */
  egressProxyPort?: number;
  /** Shared OpenCode state-store execution gate owned by the AgentRuntime. */
  providerExecutionGate?: ProviderExecutionGate;
  /** Immutable runtime-primary context captured before readiness consumers run. */
  serviceContext?: PrimaryProbeServiceContext;
  /** Production requires the immutable context; isolated legacy fixtures may omit it. */
  requireServiceContext?: boolean;
  /** Test seam for context comparison; production builds this from the final invocation. */
  currentServiceContext?: () => PrimaryProbeServiceContext | null;
  /** Why this probe runs. Logged with each CLI probe child; 'unspecified' when absent. */
  probeTrigger?: PrimaryModelProbeTrigger;
  /** Lifecycle log sink for CLI probe children. Injectable for tests. */
  log?: PrimaryModelProbeLog;
  /** claude-cli refresh-ahead run before the probe budget (claude-refresh-ahead.ts). Injectable for tests. */
  refreshClaudeLoginAhead?: (binary: string, env: NodeJS.ProcessEnv) => Promise<unknown>;
  /** claude-cli refresh-lock wait before the probe child is signalled. Injectable for tests. */
  claudeRefreshLockGrace?: (env: NodeJS.ProcessEnv) => Promise<unknown> | null;
}

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
const API_PROBE_TIMEOUT_MS = 5_000;
const API_ERROR_RESPONSE_LIMIT_BYTES = 64 * 1024;
const CLI_MODEL_PROBE_TIMEOUT_MS = 15_000;
const CLAUDE_MODEL_PROBE_PROMPT = 'Reply with OK only.';
const OPENCODE_MODEL_PROBE_PROMPT = 'Reply with OK only.';
const API_MODEL_PROBE_PROMPT = 'Reply with OK only.';

interface PrimaryProbeInvocation {
  readonly binaryToken: string | null;
  readonly executablePath: string | null;
  readonly binarySha256: string | null;
  readonly env: NodeJS.ProcessEnv;
  readonly context: PrimaryProbeServiceContext;
  readonly blockedReason: string | null;
}

function hashEnvValue(env: NodeJS.ProcessEnv, key: string): string | null {
  return Object.prototype.hasOwnProperty.call(env, key)
    ? selectorFingerprint(env[key] ?? '')
    : null;
}

function hashConfigValue(config: Record<string, unknown> | undefined, key: string): string | null {
  const value = config?.[key];
  return typeof value === 'string' ? selectorFingerprint(value) : null;
}

/**
 * Build the exact selector environment used by a CLI readiness probe. The
 * OpenCode path intentionally omits credential values; credentials do not
 * select the route, and this keeps startup context capture content-free.
 */
export function buildPrimaryProbeSelectorEnv(
  provider: string,
  model: string | null,
  providerConfig: Record<string, unknown> | undefined,
  deps: Pick<PrimaryModelProbeAdapterDeps, 'buildChildEnv' | 'egressProxyPort'> = {},
): NodeJS.ProcessEnv {
  const baseOpts = typeof deps.egressProxyPort === 'number' && deps.egressProxyPort > 0
    ? { egressProxyPort: deps.egressProxyPort }
    : undefined;
  if (provider === 'opencode-cli') {
    const buildEnv = deps.buildChildEnv ?? buildChildEnv;
    return buildEnv(
      'opencode-cli',
      { ...baseOpts, providerCredentials: 'omit' },
      model || undefined,
      providerConfig,
    );
  }
  if (provider === 'claude-cli') return buildPrimaryProbeEnv(provider, model, providerConfig, deps);
  return {};
}

/** Build a content-free fingerprint from the effective launch selectors. */
export function buildPrimaryProbeServiceContext(input: {
  provider: string;
  model: string | null;
  serviceGeneration: string;
  cwd: string;
  providerConfig?: Record<string, unknown>;
  selectorEnv: NodeJS.ProcessEnv;
  binaryState: PrimaryProbeBinaryState;
  binaryIdentity?: ProviderBinaryIdentity | null;
}): PrimaryProbeServiceContext {
  const env = input.selectorEnv;
  const selectorShape = {
    cwdHash: selectorFingerprint(input.cwd),
    homeHash: hashEnvValue(env, 'HOME'),
    pathHash: hashEnvValue(env, 'PATH'),
    xdgConfigHash: hashEnvValue(env, 'XDG_CONFIG_HOME'),
    xdgDataHash: hashEnvValue(env, 'XDG_DATA_HOME'),
    httpProxyHash: hashEnvValue(env, 'HTTP_PROXY'),
    httpsProxyHash: hashEnvValue(env, 'HTTPS_PROXY'),
    httpProxyLowerHash: hashEnvValue(env, 'http_proxy'),
    httpsProxyLowerHash: hashEnvValue(env, 'https_proxy'),
    claudeConfigHash: input.provider === 'claude-cli' ? hashEnvValue(env, 'CLAUDE_CONFIG_DIR') : null,
    claudeSecureStorageHash: input.provider === 'claude-cli'
      ? hashEnvValue(env, 'CLAUDE_SECURESTORAGE_CONFIG_DIR') : null,
    claudeCredentialServiceHash: input.provider === 'claude-cli'
      ? selectorFingerprint(claudeCredentialServiceForEnv(env)) : null,
    claudeStorageDirHash: input.provider === 'claude-cli'
      ? selectorFingerprint(claudeSecureStorageDir(env)) : null,
    providerBaseUrlHash: hashConfigValue(input.providerConfig, 'baseUrl'),
    providerApiKeyServiceHash: hashConfigValue(input.providerConfig, 'apiKeyService'),
  };
  const identity = input.binaryIdentity ?? null;
  return {
    provider: input.provider,
    model: input.model,
    serviceGeneration: input.serviceGeneration,
    launchContextHash: selectorFingerprint(JSON.stringify(selectorShape)),
    binaryState: input.binaryState,
    resolvedBinaryPathHash: identity ? selectorFingerprint(identity.resolvedPath) : null,
    binarySha256: identity?.sha256 ?? null,
  };
}

function comparePrimaryProbeContext(
  target: { provider: string; model: string | null },
  expected: PrimaryProbeServiceContext | undefined,
  current: PrimaryProbeServiceContext | null,
  requireServiceContext: boolean,
): string | null {
  if (!expected) return requireServiceContext ? 'context-missing-service' : null;
  if (!current) return 'context-missing-current';
  if (expected.provider !== target.provider || current.provider !== target.provider) {
    return 'context-mismatch-provider';
  }
  if ((expected.model ?? null) !== (target.model ?? null) || (current.model ?? null) !== (target.model ?? null)) {
    return 'context-mismatch-model';
  }
  if (expected.serviceGeneration !== current.serviceGeneration) return 'context-mismatch-generation';
  if (expected.launchContextHash !== current.launchContextHash) return 'context-mismatch-launch';
  if (expected.binaryState !== current.binaryState) return 'context-mismatch-binary-state';
  if (expected.binaryState === 'resolved') {
    if (!current.resolvedBinaryPathHash || !current.binarySha256) return 'context-binary-missing';
    if (expected.resolvedBinaryPathHash !== current.resolvedBinaryPathHash) return 'context-mismatch-binary-path';
    if (expected.binarySha256 !== current.binarySha256) return 'context-mismatch-binary-sha';
  }
  return null;
}

// #3017 AXIS C: verify the probe target against the immutable runtime-primary
// service context. A current context callback is retained as a test seam;
// production CLI probes use the invocation snapshot below so the compared
// executable path is the path actually passed to probeBinaryCommand.
export function verifyServingContext(
  target: { provider: string; model: string | null },
  deps: PrimaryModelProbeAdapterDeps,
): string | null {
  return comparePrimaryProbeContext(
    target,
    deps.serviceContext,
    deps.currentServiceContext?.() ?? null,
    deps.requireServiceContext === true,
  );
}

function buildPrimaryProbeInvocation(
  target: { provider: string; model: string | null },
  providerConfig: Record<string, unknown> | undefined,
  deps: PrimaryModelProbeAdapterDeps,
): PrimaryProbeInvocation {
  const env = buildPrimaryProbeEnv(target.provider, target.model, providerConfig, deps);
  const resolveBinary = deps.getProviderBinary ?? getProviderBinary;
  let binaryToken: string | null = null;
  try {
    binaryToken = resolveBinary(target.provider);
  } catch {
    binaryToken = null;
  }

  let identity: ProviderBinaryIdentity | null = null;
  const binaryState: PrimaryProbeBinaryState = binaryToken === null ? 'missing' : 'resolved';
  if (binaryToken !== null) {
    try {
      identity = (deps.resolveProviderBinaryIdentity ?? resolveProviderBinaryIdentity)(
        binaryToken,
        env.PATH ?? '',
      );
    } catch {
      identity = null;
    }
  }
  const context = buildPrimaryProbeServiceContext({
    provider: target.provider,
    model: target.model,
    serviceGeneration: deps.serviceContext?.serviceGeneration ?? '',
    cwd: deps.cwd ?? '',
    providerConfig,
    selectorEnv: env,
    binaryState: identity === null ? 'missing' : binaryState,
    binaryIdentity: identity,
  });
  return {
    binaryToken,
    executablePath: identity?.resolvedPath ?? null,
    binarySha256: identity?.sha256 ?? null,
    env,
    context,
    blockedReason: comparePrimaryProbeContext(
      target,
      deps.serviceContext,
      context,
      deps.requireServiceContext === true,
    ),
  };
}

export function createPrimaryModelProbeAdapters(
  providerConfig?: Record<string, unknown>,
  deps: PrimaryModelProbeAdapterDeps = {},
): PrimaryModelProbeAdapters {
  return {
    prepareBinaryModel: (target) => prepareCliModelProbe(target, providerConfig, deps),
    probeBinaryModel: (target, signal, onStage) =>
      probeCliModel(target.provider, target.model, providerConfig, deps, signal, onStage),
    probeApiModelAccess: (target, signal, onStage) => {
      const current = deps.currentServiceContext?.() ?? buildPrimaryProbeServiceContext({
        provider: target.provider,
        model: target.model,
        serviceGeneration: deps.serviceContext?.serviceGeneration ?? '',
        cwd: deps.cwd ?? '',
        providerConfig,
        selectorEnv: {},
        binaryState: 'none',
      });
      const mismatch = comparePrimaryProbeContext(
        target,
        deps.serviceContext,
        current,
        deps.requireServiceContext === true,
      );
      if (mismatch !== null) {
        return Promise.resolve({ status: 'unknown', reason: mismatch });
      }
      return probeApiModelAccess(target.provider, target.model, providerConfig, deps, signal, onStage);
    },
  };
}

/**
 * claude-cli only: run the refresh-ahead child with the probe child's env, so
 * a due token refresh happens in a child nothing kills rather than in the
 * probe (see claude-refresh-ahead.ts). The usability probe awaits this before
 * it arms its deadline. Never rejects.
 */
async function prepareCliModelProbe(
  target: { provider: string; model: string | null },
  providerConfig: Record<string, unknown> | undefined,
  deps: PrimaryModelProbeAdapterDeps,
): Promise<void | { defer: string }> {
  if (target.provider !== 'claude-cli') return;
  try {
    // This preflight only decides whether refresh-ahead may run. The final
    // probe builds a fresh invocation and passes that exact resolved path to
    // probeBinaryCommand; this preflight is never readiness evidence.
    const invocation = buildPrimaryProbeInvocation(target, providerConfig, deps);
    if (invocation.blockedReason !== null || !invocation.binaryToken || !invocation.executablePath) return;
    const refreshed = await (deps.refreshClaudeLoginAhead ?? refreshClaudeLoginAhead)(invocation.binaryToken, invocation.env);
    // Only a currently held refresh suppresses alerts. Other refresh failures still block the
    // killable probe, but carry an alertable reason because no running child was established.
    if (refreshAheadDefersProbe(refreshed)) {
      const outcome = typeof refreshed === 'object' && refreshed !== null
        ? (refreshed as { outcome?: unknown }).outcome : undefined;
      if (outcome === 'still-running') return { defer: DEFERRED_REFRESH_IN_FLIGHT };
      if (outcome === 'owner-unavailable') return { defer: REFRESH_OWNER_UNAVAILABLE };
      return { defer: REFRESH_AHEAD_FAILED };
    }
  } catch {
    return { defer: REFRESH_AHEAD_FAILED };
  }
  return undefined;
}

async function probeCliModel(
  provider: string,
  model: string | null,
  providerConfig: Record<string, unknown> | undefined,
  deps: PrimaryModelProbeAdapterDeps,
  signal?: AbortSignal,
  onStage?: PrimaryModelProbeStageReporter,
): Promise<BinaryModelProbeResult> {
  if (signal?.aborted) return { status: 'timeout' };
  onStage?.('prepare');

  // Duplicate credential stores can leave a stale refresh token available to
  // the CLI. Detect that state without copying or deleting either credential.
  if (provider !== 'opencode-cli') {
    onStage?.('credential-heal');
    // Detection must not prevent the probe from observing provider usability.
    try {
      (deps.ensureClaudeFileStoreCredential ?? ensureClaudeFileStoreCredential)();
    } catch {
      // Intentional: detection is advisory; the probe still verifies whether the provider can run.
    }
    onStage?.('prepare');
  }

  const probe = deps.probeBinaryCommand
    ?? ((cmd: string, args: string[], env: NodeJS.ProcessEnv, options?: BinaryCommandProbeOptions) => {
      if (deps.probeBinaryAuthStatus) return deps.probeBinaryAuthStatus(cmd, args, env);
      return probeBinaryCommand(cmd, args, env, options);
    });
  const args = modelProbeCommand(provider, model, providerConfig);
  let executionLease: ProviderExecutionLease | null = null;
  if (provider === 'opencode-cli' && deps.providerExecutionGate) {
    onStage?.('gate-wait');
    executionLease = await deps.providerExecutionGate.acquire({
      ...(signal ? { signal } : {}),
      work: { kind: 'probe', scopeHash: shortHash(`${provider}\0${model ?? ''}`) },
    });
  }
  const terminalizeExecutionLease = (): void => {
    executionLease?.setPhase('terminalizing');
    executionLease?.markProgress();
  };
  const abortListener = (): void => terminalizeExecutionLease();
  if (executionLease && signal) {
    signal.addEventListener('abort', abortListener, { once: true });
    if (signal.aborted) abortListener();
  }
  const releaseExecutionLease = (): void => {
    if (signal) signal.removeEventListener('abort', abortListener);
    executionLease?.setPhase('cleanup');
    executionLease?.markProgress();
    executionLease?.release();
    executionLease = null;
  };
  try {
    // Resolve and hash only after all waits above. The executable path passed
    // to the child is therefore the identity observed after the execution
    // gate, rather than a SHA captured before a long gate wait. Keep every
    // post-acquire setup step in this cleanup scope: environment construction,
    // lifecycle observer construction, and context mapping can all throw before
    // probeBinaryCommand gets a chance to invoke onProcessClosed.
    const invocation = buildPrimaryProbeInvocation({ provider, model }, providerConfig, deps);
    if (invocation.blockedReason !== null) {
      releaseExecutionLease();
      return { status: 'unknown', reason: invocation.blockedReason };
    }
    if (!invocation.binaryToken || !invocation.executablePath || !invocation.binarySha256) {
      releaseExecutionLease();
      return { status: 'provider_unavailable' };
    }
    const env = invocation.env;
    const lifecycle = probeChildLifecycleLog(provider, env, deps, signal);
    onStage?.('child-run');
    if (!signal?.aborted) {
      executionLease?.setPhase('executing');
      executionLease?.markProgress();
    }
    const result = await probe(
      invocation.executablePath,
      args,
      env,
      {
        ...(deps.cwd ? { cwd: deps.cwd } : {}),
        timeoutMs: CLI_MODEL_PROBE_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
        ...lifecycle,
        ...(provider === 'claude-cli'
          ? {
              terminationGrace: () => (deps.claudeRefreshLockGrace
                ?? ((childEnv: NodeJS.ProcessEnv) => claudeRefreshLockGrace(childEnv, 'primary-model-probe')))(env),
            }
          : {}),
        ...(executionLease ? {
          onProcessClosed: () => {
            terminalizeExecutionLease();
            releaseExecutionLease();
          },
        } : {}),
      },
    );
    // Injected test/probe adapters predate onProcessClosed and may not invoke
    // it. Their returned promise is their complete process-lifetime contract.
    terminalizeExecutionLease();
    if (deps.probeBinaryCommand || deps.probeBinaryAuthStatus) releaseExecutionLease();
    return mapCliProbeResult(result);
  } catch (err) {
    terminalizeExecutionLease();
    releaseExecutionLease();
    throw err;
  }
}

/**
 * The spawn and exit lines of a CLI probe child (probe-lifecycle-log.ts). They
 * name the keychain item of the child's config dir ('default' for the bare
 * item), never the directory itself, any other environment value, or the
 * child's output.
 */
function probeChildLifecycleLog(
  provider: string,
  env: NodeJS.ProcessEnv,
  deps: PrimaryModelProbeAdapterDeps,
  signal: AbortSignal | undefined,
): Required<Pick<BinaryCommandProbeOptions, 'onSpawned' | 'onExited'>> {
  return probeLifecycleObservers(
    deps.log ?? createChildLogger('primary-model-probe'),
    {
      spawnEvent: 'primary_model_probe_spawn',
      spawnMessage: 'primary model probe spawned',
      exitEvent: 'primary_model_probe_exit',
      exitMessage: 'primary model probe exited',
    },
    {
      trigger: deps.probeTrigger ?? 'unspecified',
      provider,
      ...(provider === 'claude-cli' ? { credentialService: claudeCredentialServiceLabel(env) } : {}),
    },
    signal,
  );
}

function modelProbeCommand(
  provider: string,
  model: string | null,
  providerConfig: Record<string, unknown> | undefined,
): string[] {
  if (provider === 'opencode-cli') {
    // opencode-cli is guaranteed a non-null model here: config admission requires
    // one (agent-config-validator) and probePrimaryModelUsability short-circuits a
    // null-model opencode-cli to 'model-not-configured' before invoking this
    // adapter (see primary-model-usability.ts). Unlike claude-cli below, opencode
    // has no default-model probe — omitting -m for a null model would produce a
    // credential-routeless spawn that buildChildEnv rejects.
    return buildOpenCodeRunArgs({
      providerConfig,
      model: model ?? undefined,
      prompt: OPENCODE_MODEL_PROBE_PROMPT,
    });
  }
  // claude-cli only: no configured model => probe the CLI's own default (omit
  // --model) instead of never probing at all — a model-less instance must be able
  // to recover (subscription auth needs no per-model credential).
  return ['-p', CLAUDE_MODEL_PROBE_PROMPT, ...(model === null ? [] : ['--model', model])];
}

export function buildPrimaryProbeEnv(
  provider: string,
  model: string | null,
  providerConfig: Record<string, unknown> | undefined,
  deps: PrimaryModelProbeAdapterDeps,
): NodeJS.ProcessEnv {
  // Egress proxy (#1607, F6): thread the runtime's proxy port through so the
  // probe child egresses through the same allowlist as a real turn. Undefined
  // when the instance has no allowedEgress → no proxy vars, behaviour unchanged.
  const baseOpts =
    typeof deps.egressProxyPort === 'number' && deps.egressProxyPort > 0
      ? { egressProxyPort: deps.egressProxyPort }
      : undefined;
  if (provider === 'opencode-cli') {
    const buildEnv = deps.buildChildEnv ?? buildChildEnv;
    return buildEnv('opencode-cli', baseOpts, model ?? undefined, providerConfig);
  }
  // env-allowed: shared allowlist preserves credential selection and configured proxy routing
  return scrubbedAuthStatusEnv(process.env, deps.egressProxyPort);
}

function mapCliProbeResult(result: BinaryAuthStatusResult): BinaryModelProbeResult {
  if (result.status === 'ok') return { status: 'ok' };
  const kind = classifyProviderFailure(result.output);
  switch (kind) {
    case 'model-unavailable':
      return { status: 'model_unavailable' };
    case 'auth-required':
      return { status: 'credential_unavailable' };
    case 'usage-limit':
    case 'rate-limit':
    case 'server-error':
      return { status: 'provider_unavailable' };
    case 'context-overflow':
    case 'policy-block':
    case 'transient-network':
      return { status: 'unknown', reason: kind };
    case null:
      return result.output.trim()
        ? { status: 'unknown', reason: 'binary-model-probe-failed' }
        : { status: 'provider_unavailable' };
  }
}

async function probeApiModelAccess(
  provider: 'openai-api' | 'anthropic-api',
  model: string,
  providerConfig: Record<string, unknown> | undefined,
  deps: PrimaryModelProbeAdapterDeps,
  signal?: AbortSignal,
  onStage?: PrimaryModelProbeStageReporter,
): Promise<ApiModelAccessProbeResult> {
  if (signal?.aborted) return { status: 'timeout' };
  onStage?.('prepare');
  const apiKey = resolveProviderApiKey(provider, providerConfig, deps.resolveApiKey ?? resolveApiKey);
  if (!apiKey) return { status: 'credential_failed' };

  const fetchImpl = deps.fetch ?? globalThis.fetch;
  if (!fetchImpl) return { status: 'provider_unavailable' };

  const controller = new AbortController();
  const abort = (): void => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, API_PROBE_TIMEOUT_MS);
  timer.unref?.();

  try {
    onStage?.('api-request');
    const response = await fetchImpl(apiGenerationUrl(provider, providerConfig), {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        ...apiHeaders(provider, apiKey),
      },
      body: JSON.stringify(apiGenerationProbeBody(provider, model, providerConfig)),
      signal: controller.signal,
    });
    if (!response.ok) {
      const errText = response.body
        ? await readBodyCapped(response, API_ERROR_RESPONSE_LIMIT_BYTES).catch(() => '')
        : '';
      return mapApiGenerationFailure(response.status, errText);
    }
    return { status: 'found' };
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    return name === 'AbortError' || name === 'TimeoutError'
      ? { status: 'timeout' }
      : { status: 'provider_unavailable' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

function apiGenerationUrl(
  provider: 'openai-api' | 'anthropic-api',
  providerConfig: Record<string, unknown> | undefined,
): string {
  const baseUrl = baseUrlFor(provider, providerConfig);
  return provider === 'openai-api'
    ? `${baseUrl}/chat/completions`
    : `${baseUrl}/messages`;
}

function apiGenerationProbeBody(
  provider: 'openai-api' | 'anthropic-api',
  model: string,
  providerConfig: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (provider === 'openai-api') {
    return {
      model,
      messages: [{ role: 'user', content: API_MODEL_PROBE_PROMPT }],
      max_tokens: 1,
      stream: false,
    };
  }
  return {
    model,
    max_tokens: 1,
    messages: [{ role: 'user', content: API_MODEL_PROBE_PROMPT }],
    stream: false,
  };
}

function mapApiGenerationFailure(status: number, errText: string): ApiModelAccessProbeResult {
  if (status === 408 || status === 504) return { status: 'timeout' };
  const kind = classifyProviderFailure(errText);
  switch (kind) {
    case 'auth-required':
      return { status: 'credential_failed' };
    case 'model-unavailable':
      return { status: 'not_found' };
    case 'usage-limit':
    case 'rate-limit':
    case 'server-error':
    case 'transient-network':
      return { status: 'provider_unavailable' };
    case 'context-overflow':
    case 'policy-block':
      return { status: 'unknown', reason: kind };
    case null:
      break;
  }
  if (status === 401 || status === 403) return { status: 'credential_failed' };
  if (status === 404) return { status: 'not_found' };
  if (status === 429 || status >= 500) return { status: 'provider_unavailable' };
  return { status: 'provider_unavailable' };
}

function resolveProviderApiKey(
  provider: 'openai-api' | 'anthropic-api',
  providerConfig: Record<string, unknown> | undefined,
  resolver: (opts: ResolveApiKeyOptions) => string,
): string {
  const service = typeof providerConfig?.apiKeyService === 'string'
    ? providerConfig.apiKeyService
    : undefined;
  const envVar = provider === 'openai-api' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
  return resolver({ service, envVar });
}

function baseUrlFor(provider: 'openai-api' | 'anthropic-api', providerConfig: Record<string, unknown> | undefined): string {
  const configured = typeof providerConfig?.baseUrl === 'string' ? providerConfig.baseUrl.trim() : '';
  const baseUrl = configured || (provider === 'openai-api' ? DEFAULT_OPENAI_BASE_URL : DEFAULT_ANTHROPIC_BASE_URL);
  return baseUrl.replace(/\/+$/, '');
}

function apiHeaders(provider: 'openai-api' | 'anthropic-api', apiKey: string): Record<string, string> {
  if (provider === 'openai-api') {
    return { Authorization: `Bearer ${apiKey}` };
  }
  return {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  };
}
