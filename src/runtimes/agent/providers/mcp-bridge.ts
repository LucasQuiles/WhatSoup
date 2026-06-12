// src/runtimes/agent/providers/mcp-bridge.ts
// Provider-aware MCP bridge: generates .mcp.json configs for CLI providers and
// converts MCP tool definitions to API function-calling formats for API providers.

import { existsSync, lstatSync, readFileSync } from 'node:fs';
import type { ToolRegistry } from '../../../mcp/registry.ts';
import type { SessionContext, ToolCallResult } from '../../../mcp/types.ts';
import { writePrivateFileSync } from '../../../core/workspace.ts';
import { createChildLogger } from '../../../logger.ts';
import {
  generateMcpConfigFile,
  mergeOpencodeConfig,
  writeProviderMcpConfigTarget,
  type AdditionalMcpServerConfig,
  type OpencodeProviderConfig,
} from '../../../core/provider-mcp-config.ts';
import type {
  McpMode,
  ProviderMcpBridge,
  ProviderMcpTool,
  ProviderMcpToolResult,
} from './types.ts';

const log = createChildLogger('mcp-bridge');

export { generateMcpConfigFile, mergeOpencodeConfig, writeProviderMcpConfigTarget };
export type { AdditionalMcpServerConfig, OpencodeProviderConfig };

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

// ---------------------------------------------------------------------------
// opencode.json merge + per-provider config-file writer
// ---------------------------------------------------------------------------

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
