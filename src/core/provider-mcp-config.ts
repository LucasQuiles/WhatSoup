import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { buildMcpLaunchCommand } from './mcp-launcher.ts';
import { WHATSOUP_HEADLESS_EXECUTION_PROFILE } from '../lib/opencode-execution-profile-contract.ts';
import { SERVICE_ENV_MAP, resolveProviderKeyService } from '../lib/provider-key-service.ts';
import { writePrivateFileSync } from '../lib/private-fs.ts';

const MAX_OPENCODE_CONFIG_BYTES = 1024 * 1024;

/**
 * Subset of `agentOptions.providerConfig` consumed when writing an opencode
 * config file. `baseUrl` selects a custom OpenAI-compatible cloud endpoint;
 * `model` is the model id opencode should target on that endpoint;
 * `apiKeyService` names the keyring service whose key authenticates the
 * endpoint (defaults to the model-prefix-derived service).
 */
export interface OpencodeProviderConfig {
  baseUrl?: string;
  /** Provider id under opencode's top-level `provider` map. Defaults to `whatsoup-cloud`. */
  providerId?: string;
  model?: string;
  apiKeyService?: string;
}

export interface AdditionalMcpServerConfig {
  name: string;
  proxyScriptPath: string;
  env: Record<string, string>;
}

const DEFAULT_OPENCODE_PROVIDER_ID = 'whatsoup-cloud';

function openCodeConfigSymlinkError(): NodeJS.ErrnoException {
  const err = new Error(
    'OpenCode configuration must be a regular non-symlink file',
  ) as NodeJS.ErrnoException;
  err.code = 'ELOOP';
  return err;
}

function openCodeConfigError(message: string, code: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

function openCodeConfigReadError(cause: unknown): NodeJS.ErrnoException {
  const code = (cause as NodeJS.ErrnoException | undefined)?.code ?? 'EIO';
  return openCodeConfigError('Unable to safely read existing OpenCode configuration', code);
}

function openCodeConfigWriteError(cause: unknown): NodeJS.ErrnoException {
  const code = (cause as NodeJS.ErrnoException | undefined)?.code ?? 'EIO';
  return openCodeConfigError('Unable to safely write OpenCode configuration', code);
}

function invalidOpenCodeConfigError(): NodeJS.ErrnoException {
  return openCodeConfigError(
    'Existing OpenCode configuration must be a valid JSON object',
    'EINVAL',
  );
}

function oversizedOpenCodeConfigError(): NodeJS.ErrnoException {
  return openCodeConfigError(
    'Existing OpenCode configuration exceeds the safe size limit',
    'EFBIG',
  );
}

function readExistingOpenCodeConfig(target: string): Record<string, unknown> | null {
  let fd: number;
  try {
    fd = openSync(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP') throw openCodeConfigSymlinkError();
    throw openCodeConfigReadError(err);
  }

  let operationFailed = false;
  let raw: string;
  try {
    let stat: ReturnType<typeof fstatSync>;
    try {
      stat = fstatSync(fd);
    } catch (err) {
      throw openCodeConfigReadError(err);
    }
    if (!stat.isFile()) {
      throw openCodeConfigError(
        'OpenCode configuration must be a regular non-symlink file',
        'EINVAL',
      );
    }
    if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > MAX_OPENCODE_CONFIG_BYTES) {
      throw oversizedOpenCodeConfigError();
    }

    const buffer = Buffer.allocUnsafe(MAX_OPENCODE_CONFIG_BYTES + 1);
    let total = 0;
    while (total <= MAX_OPENCODE_CONFIG_BYTES) {
      let count: number;
      try {
        count = readSync(
          fd,
          buffer,
          total,
          MAX_OPENCODE_CONFIG_BYTES + 1 - total,
          total,
        );
      } catch (err) {
        throw openCodeConfigReadError(err);
      }
      if (count === 0) break;
      total += count;
    }
    if (total > MAX_OPENCODE_CONFIG_BYTES) {
      throw oversizedOpenCodeConfigError();
    }
    raw = buffer.subarray(0, total).toString('utf8');
  } catch (err) {
    operationFailed = true;
    throw err;
  } finally {
    try {
      closeSync(fd);
    } catch (err) {
      if (!operationFailed) throw openCodeConfigReadError(err);
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalidOpenCodeConfigError();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalidOpenCodeConfigError();
  }
  return parsed as Record<string, unknown>;
}

/**
 * Merge a spawn-time providerConfig override (e.g. the QR-247 per-chat
 * actor-socket wire's `{ mcpConfig: [perChatCfgPath], strictMcpConfig: true }`)
 * onto the instance's configured providerConfig.
 *
 * Plain per-key override semantics for everything EXCEPT `mcpConfig`: the
 * claude CLI accepts multiple `--mcp-config` files and merges their servers,
 * so an instance-declared config (a host-local MCP server the bot depends on)
 * must survive the per-chat override rather than being clobbered by it.
 * Result order: override paths first, then instance paths, deduplicated.
 */
export function mergeSessionProviderConfig(
  base: Record<string, unknown> | undefined,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base, ...override };
  const baseMcp = base?.['mcpConfig'];
  const overrideMcp = override['mcpConfig'];
  if (baseMcp !== undefined && overrideMcp !== undefined) {
    const toPaths = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : [String(v)]);
    const overridePaths = toPaths(overrideMcp);
    merged['mcpConfig'] = [
      ...overridePaths,
      ...toPaths(baseMcp).filter((p) => !overridePaths.includes(p)),
    ];
  }
  return merged;
}

export function writeProviderMcpConfigTarget(providerId: string, agentCwd: string): string | null {
  switch (providerId) {
    case 'claude-cli':
    case 'gemini-cli':
      return join(agentCwd, '.mcp.json');
    case 'codex-cli':
      return null;
    case 'opencode-cli':
      return join(agentCwd, 'opencode.json');
    default:
      return null;
  }
}

/**
 * Generate provider-specific MCP config file content.
 * Returns null for API providers that do not use config files.
 */
export function generateMcpConfigFile(
  providerId: string,
  socketPath: string,
  proxyScriptPath: string,
  additionalServers: AdditionalMcpServerConfig[] = [],
): Record<string, unknown> | null {
  const servers: AdditionalMcpServerConfig[] = [
    {
      name: 'whatsoup',
      proxyScriptPath,
      env: { WHATSOUP_SOCKET: socketPath },
    },
    ...additionalServers,
  ];

  switch (providerId) {
    case 'claude-cli':
    case 'gemini-cli':
      return {
        mcpServers: Object.fromEntries(
          servers.map((server) => [
            server.name,
            {
              ...buildMcpLaunchCommand(server.proxyScriptPath),
              env: server.env,
            },
          ]),
        ),
      };

    case 'opencode-cli':
      return {
        mcp: Object.fromEntries(
          servers.map((server) => {
            const { command, args } = buildMcpLaunchCommand(server.proxyScriptPath);
            return [
              server.name,
              {
                type: 'local',
                command: [command, ...args],
                environment: server.env,
                enabled: true,
              },
            ];
          }),
        ),
      };

    case 'codex-cli':
    default:
      return null;
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

/**
 * Provider CLI arguments that carry the same generated MCP transport used by
 * file-configured providers. Codex consumes canonical `mcp_servers` config
 * overrides; it does not read Claude/Gemini's project `.mcp.json`.
 */
export function buildProviderMcpConfigArgs(
  providerId: string,
  agentCwd: string,
  socketPath: string,
  proxyScriptPath: string,
): readonly string[] {
  if (providerId === 'claude-cli') {
    return ['--mcp-config', join(agentCwd, '.mcp.json')];
  }
  if (providerId !== 'codex-cli') return [];
  const { command, args } = buildMcpLaunchCommand(proxyScriptPath);
  return [
    '-c', `mcp_servers.whatsoup.command=${tomlString(command)}`,
    '-c', `mcp_servers.whatsoup.args=${tomlStringArray(args)}`,
    '-c', `mcp_servers.whatsoup.env={ WHATSOUP_SOCKET = ${tomlString(socketPath)} }`,
  ];
}

/**
 * F-STICKY-ACTOR (QR-247): generate + write a provider MCP config to an arbitrary
 * absolute path (0600), reusing generateMcpConfigFile. Used to give a per-chat
 * claude-cli session its own --mcp-config pointing at its per-chat socket, without
 * touching the shared cwd .mcp.json. Returns the path written, or null for API
 * providers that use no config file.
 */
export function writeMcpConfigToPath(
  providerId: string,
  absPath: string,
  socketPath: string,
  proxyScriptPath: string,
  additionalServers: AdditionalMcpServerConfig[] = [],
): string | null {
  const generated = generateMcpConfigFile(providerId, socketPath, proxyScriptPath, additionalServers);
  if (generated === null) return null;
  writePrivateFileSync(absPath, JSON.stringify(generated, null, 2));
  return absPath;
}

/**
 * Merge the generated opencode `mcp` block into a possibly-existing
 * opencode.json object. Pure — does no IO. Preserves every unrelated top-level
 * key, sibling MCP server, and fleet/user-owned agent policy; overwrites only
 * generated MCP entries.
 */
export function mergeOpencodeConfig(
  existing: Record<string, unknown> | null,
  generated: Record<string, unknown>,
  providerConfig?: OpencodeProviderConfig,
): Record<string, unknown> {
  const base: Record<string, unknown> = existing ? { ...existing } : {};

  const generatedMcp = (generated.mcp ?? {}) as Record<string, unknown>;
  const existingMcp = (base.mcp && typeof base.mcp === 'object' && !Array.isArray(base.mcp))
    ? (base.mcp as Record<string, unknown>)
    : {};
  base.mcp = { ...existingMcp, ...generatedMcp };

  if (base.agent && typeof base.agent === 'object' && !Array.isArray(base.agent)) {
    const existingAgents = { ...(base.agent as Record<string, unknown>) };
    delete existingAgents[WHATSOUP_HEADLESS_EXECUTION_PROFILE];
    if (Object.keys(existingAgents).length > 0) {
      base.agent = existingAgents;
    } else {
      delete base.agent;
    }
  }

  if (providerConfig?.baseUrl) {
    const providerId = providerConfig.providerId ?? DEFAULT_OPENCODE_PROVIDER_ID;
    const model = providerConfig.model;
    // Auth: reference the endpoint key via opencode's env interpolation so the
    // key VALUE never lands on disk — buildChildEnv injects the matching env
    // var into the session child. Service: explicit apiKeyService override,
    // else derived from the model prefix. A service SERVICE_ENV_MAP does not
    // know has no env var to interpolate, so apiKey is omitted entirely
    // (the validator rejects unknown apiKeyService values at config load).
    const keyService =
      providerConfig.apiKeyService ?? resolveProviderKeyService('opencode-cli', model);
    const keyEnvVar = keyService ? SERVICE_ENV_MAP[keyService] : undefined;
    const existingProvider = (base.provider && typeof base.provider === 'object' && !Array.isArray(base.provider))
      ? (base.provider as Record<string, unknown>)
      : {};
    base.provider = {
      ...existingProvider,
      [providerId]: {
        options: {
          baseURL: providerConfig.baseUrl,
          ...(keyEnvVar ? { apiKey: `{env:${keyEnvVar}}` } : {}),
        },
        models: model ? { [model]: {} } : {},
      },
    };
    if (model) {
      base.model = `${providerId}/${model}`;
    }
  } else {
    const providerId = providerConfig?.providerId ?? DEFAULT_OPENCODE_PROVIDER_ID;
    if (base.provider && typeof base.provider === 'object' && !Array.isArray(base.provider)) {
      const existingProvider = { ...(base.provider as Record<string, unknown>) };
      delete existingProvider[providerId];
      if (Object.keys(existingProvider).length > 0) {
        base.provider = existingProvider;
      } else {
        delete base.provider;
      }
    }
    if (typeof base.model === 'string' && base.model.startsWith(`${providerId}/`)) {
      delete base.model;
    }
  }

  return base;
}

/**
 * Write the whatsoup MCP config to the file the given provider's CLI reads,
 * returning the absolute path written (or `null` for native-bridge/API
 * providers that need no config file).
 *
 * - claude/gemini -> `<agentCwd>/.mcp.json` (claude `mcpServers` shape,
 *   deterministic overwrite, exactly as before).
 * - opencode-cli -> `<agentCwd>/opencode.json` (opencode `mcp` shape), merged
 *   with any pre-existing user config while preserving unrelated keys and
 *   fleet/user-owned agents. Agent-policy deployment is owned outside this
 *   writer.
 *
 * Both paths go through {@link writePrivateFileSync} (0600, symlink-safe).
 */
export function writeProviderMcpConfig(
  providerId: string,
  agentCwd: string,
  socketPath: string,
  proxyScriptPath: string,
  providerConfig?: OpencodeProviderConfig,
  additionalServers: AdditionalMcpServerConfig[] = [],
): string | null {
  const generated = generateMcpConfigFile(providerId, socketPath, proxyScriptPath, additionalServers);
  if (generated === null) return null;

  const target = writeProviderMcpConfigTarget(providerId, agentCwd);
  if (target === null) return null;

  if (providerId === 'opencode-cli') {
    const existing = readExistingOpenCodeConfig(target);
    const merged = mergeOpencodeConfig(existing, generated, providerConfig);
    try {
      writePrivateFileSync(target, JSON.stringify(merged, null, 2));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ELOOP') {
        throw openCodeConfigSymlinkError();
      }
      throw openCodeConfigWriteError(err);
    }
    return target;
  }

  // Claude and Gemini overwrite .mcp.json with the mcpServers shape.
  writePrivateFileSync(target, JSON.stringify(generated, null, 2));
  return target;
}
