import { buildChildEnv, getProviderBinary, opencodeUsesConfigModel } from '../session.ts';
import { classifyProviderFailure } from '../failure-taxonomy.ts';
import {
  probeBinaryCommand,
  probeBinaryAuthStatus,
  type BinaryAuthStatusResult,
  type BinaryCommandProbeOptions,
} from './binary-preflight.ts';
import { resolveApiKey, type ResolveApiKeyOptions } from './api-key-resolver.ts';
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
}

interface ModelsListResponse {
  data?: Array<{ id?: unknown }>;
}

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
const API_PROBE_TIMEOUT_MS = 5_000;
const CLI_MODEL_PROBE_TIMEOUT_MS = 15_000;
const CLAUDE_MODEL_PROBE_PROMPT = 'Reply with OK only.';
const OPENCODE_MODEL_PROBE_PROMPT = 'Reply with OK only.';

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
  model: string,
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
  model: string,
  providerConfig: Record<string, unknown> | undefined,
): string[] {
  if (provider === 'opencode-cli') {
    return [
      'run',
      '--format',
      'json',
      '--pure',
      ...(opencodeUsesConfigModel(providerConfig) ? [] : ['-m', model]),
      OPENCODE_MODEL_PROBE_PROMPT,
    ];
  }
  return ['-p', CLAUDE_MODEL_PROBE_PROMPT, '--model', model];
}

function modelProbeEnv(
  provider: string,
  model: string,
  providerConfig: Record<string, unknown> | undefined,
  deps: PrimaryModelProbeAdapterDeps,
): NodeJS.ProcessEnv {
  if (provider === 'opencode-cli') {
    const buildEnv = deps.buildChildEnv ?? buildChildEnv;
    return buildEnv('opencode-cli', undefined, model, providerConfig);
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

  const url = `${baseUrlFor(provider, providerConfig)}/models${provider === 'anthropic-api' ? '?limit=100' : ''}`;
  try {
    const response = await fetchImpl(url, {
      headers: apiHeaders(provider, apiKey),
      signal: AbortSignal.timeout(API_PROBE_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) return { status: 'credential_failed' };
    if (response.status === 404) return { status: 'not_found' };
    if (response.status === 408 || response.status === 504) return { status: 'timeout' };
    if (!response.ok) return { status: 'provider_unavailable' };

    const body = await response.json().catch(() => null) as ModelsListResponse | null;
    const ids = (body?.data ?? [])
      .map((entry) => entry.id)
      .filter((id): id is string => typeof id === 'string');
    return ids.includes(model) ? { status: 'found' } : { status: 'not_found' };
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    return name === 'AbortError' || name === 'TimeoutError'
      ? { status: 'timeout' }
      : { status: 'provider_unavailable' };
  }
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
