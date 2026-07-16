import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildMcpLaunchCommand } from './mcp-launcher.ts';
import { SERVICE_ENV_MAP, resolveProviderKeyService } from '../lib/provider-key-service.ts';
import { writePrivateFileSync } from '../lib/private-fs.ts';
import { createChildLogger } from '../logger.ts';

const log = createChildLogger('provider-mcp-config');

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

export function writeProviderMcpConfigTarget(providerId: string, agentCwd: string): string | null {
  switch (providerId) {
    case 'claude-cli':
    case 'gemini-cli':
    case 'codex-cli':
      return join(agentCwd, '.mcp.json');
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
    case 'codex-cli':
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

    default:
      return null;
  }
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
 * - claude/gemini/codex -> `<agentCwd>/.mcp.json` (claude `mcpServers` shape,
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
    try {
      const stat = lstatSync(target);
      if (stat.isSymbolicLink()) {
        throw openCodeConfigSymlinkError();
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ELOOP') {
        throw openCodeConfigSymlinkError();
      }
      if (code !== 'ENOENT') throw err;
    }

    let existing: Record<string, unknown> | null = null;
    if (existsSync(target)) {
      try {
        const parsed = JSON.parse(readFileSync(target, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          existing = parsed as Record<string, unknown>;
        }
      } catch (err) {
        // Corrupt/unreadable user config — fall back to a fresh merge base
        // rather than refusing to wire MCP. The whatsoup block is what matters.
        log.warn({ err, target }, 'failed to parse existing opencode.json before MCP config write; overwriting managed entries');
        existing = null;
      }
    }
    const merged = mergeOpencodeConfig(existing, generated, providerConfig);
    try {
      writePrivateFileSync(target, JSON.stringify(merged, null, 2));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ELOOP') {
        throw openCodeConfigSymlinkError();
      }
      throw err;
    }
    return target;
  }

  // claude / gemini / codex: overwrite .mcp.json with the mcpServers shape.
  writePrivateFileSync(target, JSON.stringify(generated, null, 2));
  return target;
}
