import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildMcpLaunchCommand } from './mcp-launcher.ts';
import { SERVICE_ENV_MAP, resolveProviderKeyService } from '../lib/provider-key-service.ts';
import { writePrivateFileSync } from '../lib/private-fs.ts';
import { createChildLogger } from '../logger.ts';
import { REQUIRED_DENY } from './settings-template.ts';

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

/** Reserved OpenCode primary agent used only by WhatSoup's headless launcher. */
export const WHATSOUP_OPENCODE_AGENT_ID = 'whatsoup-headless';

function translateClaudeMcpPermissionToOpencodeTool(permission: string): string {
  const qualifiedName = permission.startsWith('mcp__')
    ? permission.slice('mcp__'.length)
    : '';
  const separator = qualifiedName.indexOf('__');
  const serverName = separator > 0 ? qualifiedName.slice(0, separator) : '';
  const toolName = separator > 0 ? qualifiedName.slice(separator + 2) : '';
  if (!serverName || !toolName) {
    throw new Error(`Invalid Claude MCP permission identifier: ${permission}`);
  }
  return [serverName, toolName]
    .map((component) => component.replace(/[^a-zA-Z0-9_-]/g, '_'))
    .join('_');
}

const translatedRequiredDeny = REQUIRED_DENY.map(translateClaudeMcpPermissionToOpencodeTool);
if (new Set(translatedRequiredDeny).size !== translatedRequiredDeny.length) {
  throw new Error('OpenCode REQUIRED_DENY translation produced duplicate tool names');
}

/** OpenCode tool names corresponding one-for-one with the Claude MCP deny floor. */
export const OPENCODE_REQUIRED_DENY: readonly string[] = Object.freeze(translatedRequiredDeny);

/**
 * Build the repo-managed OpenCode primary agent used for unattended turns.
 * This is an OpenCode permission policy, not an operating-system isolation
 * boundary: explicit denials contain known interactive, external-directory,
 * environment-file, and connector-mutation surfaces while local work remains
 * usable without the CLI's blanket --auto switch.
 */
export function buildManagedOpencodeAgentConfig(): Record<string, unknown> {
  const permission: Record<string, unknown> = {
    '*': 'allow',
    question: 'deny',
    plan_enter: 'deny',
    plan_exit: 'deny',
    external_directory: 'deny',
    doom_loop: 'allow',
    read: {
      '*': 'allow',
      '*.env': 'deny',
      '*.env.*': 'deny',
      '*.env.example': 'allow',
    },
  };

  for (const toolName of OPENCODE_REQUIRED_DENY) permission[toolName] = 'deny';

  return {
    description: 'WhatSoup unattended primary agent with managed permission boundaries',
    mode: 'primary',
    permission,
  };
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
 * Merge the generated opencode `mcp` block and WhatSoup's reserved headless
 * agent into a possibly-existing opencode.json object. Pure — does no IO.
 * Preserves every unrelated top-level key, sibling MCP server, and user agent;
 * overwrites only generated MCP entries and the reserved agent id.
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

  const existingAgents = (base.agent && typeof base.agent === 'object' && !Array.isArray(base.agent))
    ? (base.agent as Record<string, unknown>)
    : {};
  base.agent = {
    ...existingAgents,
    [WHATSOUP_OPENCODE_AGENT_ID]: buildManagedOpencodeAgentConfig(),
  };

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
 * - opencode-cli -> `<agentCwd>/opencode.json` (opencode `mcp` shape plus the
 *   reserved WhatSoup headless agent), merged with any pre-existing user config
 *   while preserving unrelated keys and user-owned agents.
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
        log.warn({ target }, 'skipping opencode MCP config write because opencode.json is a symlink');
        return null;
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ELOOP') {
        log.warn({ err, target }, 'skipping opencode MCP config write after file stat failed');
        return null;
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
        log.warn({ err, target }, 'skipping opencode MCP config write because opencode.json is a symlink');
        return null;
      }
      throw err;
    }
    return target;
  }

  // claude / gemini / codex: overwrite .mcp.json with the mcpServers shape.
  writePrivateFileSync(target, JSON.stringify(generated, null, 2));
  return target;
}
