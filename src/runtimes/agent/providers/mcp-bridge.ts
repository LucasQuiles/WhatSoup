// src/runtimes/agent/providers/mcp-bridge.ts
// Provider-aware MCP bridge: generates .mcp.json configs for CLI providers and
// converts MCP tool definitions to API function-calling formats for API providers.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolRegistry } from '../../../mcp/registry.ts';
import type { SessionContext, ToolCallResult } from '../../../mcp/types.ts';
import { buildMcpLaunchCommand } from '../../../core/mcp-launcher.ts';
import { writePrivateFileSync } from '../../../core/workspace.ts';
import type {
  McpMode,
  ProviderMcpBridge,
  ProviderMcpTool,
  ProviderMcpToolResult,
} from './types.ts';

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

// ---------------------------------------------------------------------------
// API tool definition types
// ---------------------------------------------------------------------------

/**
 * Tool definition in a format suitable for API providers.
 * Matches OpenAI's function calling schema.
 */
export interface ApiToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

/**
 * Tool definition in Anthropic's native format.
 * Anthropic uses a slightly different schema than OpenAI.
 */
export interface AnthropicToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

function normalizeToolResult(result: ToolCallResult): ProviderMcpToolResult {
  return {
    content: result.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n'),
    isError: result.isError === true,
  };
}

// ---------------------------------------------------------------------------
// CLI config file generation
// ---------------------------------------------------------------------------

/**
 * Generate .mcp.json content for a CLI provider.
 * Different providers may need slightly different formats.
 *
 * Returns null for API providers that do not use config files.
 */
export function generateMcpConfigFile(
  providerId: string,
  socketPath: string,
  proxyScriptPath: string,
): Record<string, unknown> | null {
  switch (providerId) {
    case 'claude-cli':
    case 'gemini-cli':
    case 'codex-cli':
      // Claude, Gemini, and Codex all share the same .mcp.json format
      return {
        mcpServers: {
          whatsoup: {
            ...buildMcpLaunchCommand(proxyScriptPath),
            env: { WHATSOUP_SOCKET: socketPath },
          },
        },
      };

    case 'opencode-cli': {
      // opencode (1.16.x) uses a different schema than Claude/Gemini/Codex:
      // a top-level `mcp` object whose entries are
      //   { type: 'local', command: [argv...], environment: {...}, enabled: true }
      // The single `command` array is the flattened launch argv (command + args),
      // and env vars live under `environment` (NOT claude's `env`). Verified
      // against the installed opencode global config (~/.config/opencode/opencode.json).
      const { command, args } = buildMcpLaunchCommand(proxyScriptPath);
      return {
        mcp: {
          whatsoup: {
            type: 'local',
            command: [command, ...args],
            environment: { WHATSOUP_SOCKET: socketPath },
            enabled: true,
          },
        },
      };
    }

    default:
      // API providers don't need config files
      return null;
  }
}

// ---------------------------------------------------------------------------
// opencode.json merge + per-provider config-file writer
// ---------------------------------------------------------------------------

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
 * Merge the generated opencode `mcp` block into a possibly-existing
 * opencode.json object. Pure — does no IO. Preserves every unrelated top-level
 * key (model, provider catalog, watcher, …) and every sibling MCP server,
 * overwriting only the `mcp.whatsoup` entry so a stale socket path is refreshed.
 *
 * When `providerConfig.baseUrl` is set, also merges a top-level `provider`
 * block (models.dev-style) pointing at that OpenAI-compatible endpoint and
 * rewrites the top-level `model` to `<providerId>/<model>` so opencode routes
 * the configured model through the custom cloud. Best-effort: opencode's
 * provider schema is broad; we emit the documented `options.baseURL` +
 * `models` shape and leave catalog merging to opencode's own load step.
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
  }

  return base;
}

/**
 * Write the whatsoup MCP config to the file the given provider's CLI reads,
 * returning the absolute path written (or `null` for native-bridge/API
 * providers that need no config file).
 *
 * - claude/gemini/codex → `<agentCwd>/.mcp.json` (claude `mcpServers` shape,
 *   deterministic overwrite, exactly as before).
 * - opencode-cli → `<agentCwd>/opencode.json` (opencode `mcp` shape), MERGED
 *   with any pre-existing user opencode.json so a hand-authored config is never
 *   clobbered.
 *
 * Both paths go through {@link writePrivateFileSync} (0600, symlink-safe).
 */
export function writeProviderMcpConfig(
  providerId: string,
  agentCwd: string,
  socketPath: string,
  proxyScriptPath: string,
  providerConfig?: OpencodeProviderConfig,
): string | null {
  const generated = generateMcpConfigFile(providerId, socketPath, proxyScriptPath);
  if (generated === null) return null;

  const target = writeProviderMcpConfigTarget(providerId, agentCwd);
  if (target === null) return null;

  if (providerId === 'opencode-cli') {
    let existing: Record<string, unknown> | null = null;
    if (existsSync(target)) {
      try {
        const parsed = JSON.parse(readFileSync(target, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          existing = parsed as Record<string, unknown>;
        }
      } catch {
        // Corrupt/unreadable user config — fall back to a fresh merge base
        // rather than refusing to wire MCP. The whatsoup block is what matters.
        existing = null;
      }
    }
    const merged = mergeOpencodeConfig(existing, generated, providerConfig);
    writePrivateFileSync(target, JSON.stringify(merged, null, 2));
    return target;
  }

  // claude / gemini / codex: overwrite .mcp.json with the mcpServers shape.
  writePrivateFileSync(target, JSON.stringify(generated, null, 2));
  return target;
}

// ---------------------------------------------------------------------------
// API tool conversion
// ---------------------------------------------------------------------------

/**
 * Convert MCP tool definitions to OpenAI function calling format.
 * Used by API providers (openai-api) to include WhatSoup's tools in requests.
 */
export function convertMcpToolsToOpenAI(
  tools: ProviderMcpTool[],
): ApiToolDefinition[] {
  return tools.map(tool => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

/**
 * Convert MCP tool definitions to Anthropic tool format.
 * Used by API providers (anthropic-api) to include WhatSoup's tools in requests.
 */
export function convertMcpToolsToAnthropic(
  tools: ProviderMcpTool[],
): AnthropicToolDefinition[] {
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}

// ---------------------------------------------------------------------------
// Strategy selector
// ---------------------------------------------------------------------------

/**
 * Determine if a provider needs a config file or uses direct tool bridging.
 */
export function getMcpStrategy(providerId: string): McpMode {
  switch (providerId) {
    case 'claude-cli':
    case 'codex-cli':
    case 'gemini-cli':
    case 'opencode-cli':
      return 'config_file';
    case 'openai-api':
    case 'anthropic-api':
      return 'native_bridge';
    default:
      return 'none';
  }
}

/**
 * Create a provider-native MCP bridge backed by WhatSoup's in-process registry.
 * Used by managed-loop HTTP providers to advertise and execute tools directly.
 */
export function createProviderMcpBridge(
  registry: ToolRegistry,
  session: SessionContext,
): ProviderMcpBridge {
  return {
    listTools(): ProviderMcpTool[] {
      return registry.listTools(session);
    },
    async executeTool(name: string, params: Record<string, unknown>): Promise<ProviderMcpToolResult> {
      return normalizeToolResult(await registry.call(name, params, session));
    },
  };
}
