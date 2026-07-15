import { buildChildEnv, getProviderBinary } from '../session.ts';
import { buildOpenCodeRunArgs } from './opencode-execution-profile.ts';
import { classifyProviderFailure } from '../failure-taxonomy.ts';
import {
  probeBinaryCommand,
  probeBinaryAuthStatus,
  type BinaryAuthStatusResult,
  type BinaryCommandProbeOptions,
} from './binary-preflight.ts';
import { resolveApiKey, type ResolveApiKeyOptions } from '../../../lib/api-key-resolver.ts';
import {
  ensureClaudeFileStoreCredential,
  type ClaudeFileStoreHealResult,
} from './claude-filestore-heal.ts';
import type {
  ApiModelAccessProbeResult,
  BinaryModelProbeResult,
  PrimaryModelProbeAdapters,
} from './primary-model-usability.ts';

export interface PrimaryModelProbeAdapterDeps {
  cwd?: string;
  buildChildEnv?: typeof buildChildEnv;
  getProviderBinary?: (provider: string) => string | null;
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
   * Self-heal the claude file-store credential from the keychain before a
   * claude-cli probe (see claude-filestore-heal.ts). Injectable for tests.
   */
  ensureClaudeFileStoreCredential?: () => ClaudeFileStoreHealResult;
}

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
const API_PROBE_TIMEOUT_MS = 5_000;
const CLI_MODEL_PROBE_TIMEOUT_MS = 15_000;
const CLAUDE_MODEL_PROBE_PROMPT = 'Reply with OK only.';
const OPENCODE_MODEL_PROBE_PROMPT = 'Reply with OK only.';
const API_MODEL_PROBE_PROMPT = 'Reply with OK only.';

export function createPrimaryModelProbeAdapters(
  providerConfig?: Record<string, unknown>,
  deps: PrimaryModelProbeAdapterDeps = {},
): PrimaryModelProbeAdapters {
  return {
    probeBinaryModel: (target) => probeCliModel(target.provider, target.model, providerConfig, deps),
    probeApiModelAccess: (target) => probeApiModelAccess(target.provider, target.model, providerConfig, deps),
  };
}

async function probeCliModel(
  provider: string,
  model: string | null,
  providerConfig: Record<string, unknown> | undefined,
  deps: PrimaryModelProbeAdapterDeps,
): Promise<BinaryModelProbeResult> {
  const resolveBinary = deps.getProviderBinary ?? getProviderBinary;
  let binary: string | null;
  try {
    binary = resolveBinary(provider);
  } catch {
    return { status: 'provider_unavailable' };
  }
  if (!binary) return { status: 'provider_unavailable' };

  // Before probing claude-cli, ensure the file store the CLI is pinned to (via
  // CLAUDE_CONFIG_DIR) actually holds a usable token, mirroring it from the
  // keychain when stale/missing. Without this the probe false-negatives to
  // credential_unavailable whenever a native login refreshed only the keychain
  // — arming the fallback and preventing revert. No-op off-darwin / when
  // CLAUDE_CONFIG_DIR is unset / when the file store is already current.
  if (provider !== 'opencode-cli') {
    // Best-effort: the heal is fail-open by contract, but guard the call site too
    // so no future/injected heal fault can ever break the probe (a broken probe
    // would strand the fallback — the exact failure mode this change fixes).
    try {
      (deps.ensureClaudeFileStoreCredential ?? ensureClaudeFileStoreCredential)();
    } catch {
      // swallow — proceed to probe exactly as before
    }
  }

  const probe = deps.probeBinaryCommand
    ?? ((cmd: string, args: string[], env: NodeJS.ProcessEnv, options?: BinaryCommandProbeOptions) => {
      if (deps.probeBinaryAuthStatus) return deps.probeBinaryAuthStatus(cmd, args, env);
      return probeBinaryCommand(cmd, args, env, options);
    });
  const result = await probe(
    binary,
    modelProbeCommand(provider, model, providerConfig),
    modelProbeEnv(provider, model, providerConfig, deps),
    { ...(deps.cwd ? { cwd: deps.cwd } : {}), timeoutMs: CLI_MODEL_PROBE_TIMEOUT_MS },
  );
  return mapCliProbeResult(result);
}

function modelProbeCommand(
  provider: string,
  model: string | null,
  providerConfig: Record<string, unknown> | undefined,
): string[] {
  if (provider === 'opencode-cli') {
    return buildOpenCodeRunArgs({
      providerConfig,
      model: model ?? undefined,
      prompt: OPENCODE_MODEL_PROBE_PROMPT,
    });
  }
  // No configured model => probe the CLI's own default (omit --model) instead of
  // never probing at all — a model-less instance must be able to recover.
  return ['-p', CLAUDE_MODEL_PROBE_PROMPT, ...(model === null ? [] : ['--model', model])];
}

function modelProbeEnv(
  provider: string,
  model: string | null,
  providerConfig: Record<string, unknown> | undefined,
  deps: PrimaryModelProbeAdapterDeps,
): NodeJS.ProcessEnv {
  if (provider === 'opencode-cli') {
    const buildEnv = deps.buildChildEnv ?? buildChildEnv;
    return buildEnv('opencode-cli', undefined, model ?? undefined, providerConfig);
  }
  return {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    USER: process.env.USER,
    NO_COLOR: '1',
    // Mirror buildBaseChildEnv: forward CLAUDE_CONFIG_DIR (if set) so the
    // recovery/health probe resolves credentials the same way a real turn does.
    // On launchd-managed macOS hosts the keychain cred item is unreadable in the
    // non-GUI context; CLAUDE_CONFIG_DIR=$HOME/.claude routes the probe to the
    // readable `.credentials.json` file store. Omitting it pinned rb-bot in
    // auth-required fallback even after a successful reauth. undefined is dropped
    // by the spawn layer when the var is unset → no change on hosts that omit it.
    ...(process.env.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR } : {}),
  };
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
): Promise<ApiModelAccessProbeResult> {
  const apiKey = resolveProviderApiKey(provider, providerConfig, deps.resolveApiKey ?? resolveApiKey);
  if (!apiKey) return { status: 'credential_failed' };

  const fetchImpl = deps.fetch ?? globalThis.fetch;
  if (!fetchImpl) return { status: 'provider_unavailable' };

  try {
    const response = await fetchImpl(apiGenerationUrl(provider, providerConfig), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...apiHeaders(provider, apiKey),
      },
      body: JSON.stringify(apiGenerationProbeBody(provider, model, providerConfig)),
      signal: AbortSignal.timeout(API_PROBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      return mapApiGenerationFailure(response.status, errText);
    }
    return { status: 'found' };
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    return name === 'AbortError' || name === 'TimeoutError'
      ? { status: 'timeout' }
      : { status: 'provider_unavailable' };
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
