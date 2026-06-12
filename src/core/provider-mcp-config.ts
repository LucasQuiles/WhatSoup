import { join } from 'node:path';
import { buildMcpLaunchCommand } from './mcp-launcher.ts';

/**
 * Subset of `agentOptions.providerConfig` consumed when writing an opencode
 * config file. `baseUrl` selects a custom OpenAI-compatible cloud endpoint;
 * `model` is the model id opencode should target on that endpoint.
 */
export interface OpencodeProviderConfig {
  baseUrl?: string;
  /** Provider id under opencode's top-level `provider` map. Defaults to `whatsoup-cloud`. */
  providerId?: string;
  model?: string;
}

export interface AdditionalMcpServerConfig {
  name: string;
  proxyScriptPath: string;
  env: Record<string, string>;
}

const DEFAULT_OPENCODE_PROVIDER_ID = 'whatsoup-cloud';

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
 * Merge the generated opencode `mcp` block into a possibly-existing
 * opencode.json object. Pure — does no IO. Preserves every unrelated top-level
 * key (model, provider catalog, watcher, …) and every sibling MCP server,
 * overwriting only generated MCP entries so stale socket paths are refreshed.
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
    const existingProvider = (base.provider && typeof base.provider === 'object' && !Array.isArray(base.provider))
      ? (base.provider as Record<string, unknown>)
      : {};
    base.provider = {
      ...existingProvider,
      [providerId]: {
        options: { baseURL: providerConfig.baseUrl },
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
