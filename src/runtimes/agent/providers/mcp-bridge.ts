// src/runtimes/agent/providers/mcp-bridge.ts
// Provider-aware MCP bridge: generates .mcp.json configs for CLI providers and
// converts MCP tool definitions to API function-calling formats for API providers.

import type { ToolRegistry } from '../../../mcp/registry.ts';
import type { SessionContext, ToolCallResult } from '../../../mcp/types.ts';
import { createChildLogger } from '../../../logger.ts';
import {
  buildProviderMcpConfigArgs,
  generateMcpConfigFile,
  mergeOpencodeConfig,
  mergeSessionProviderConfig,
  writeMcpConfigToPath,
  writeProviderMcpConfig,
  writeProviderMcpConfigTarget,
  type AdditionalMcpServerConfig,
  type OpencodeProviderConfig,
} from '../../../core/provider-mcp-config.ts';
import type {
  ProviderMcpBridge,
  ProviderMcpTool,
  ProviderMcpToolResult,
} from './types.ts';
import { errorMessage } from '../../../lib/error-message.ts';

const log = createChildLogger('mcp-bridge');

export { buildProviderMcpConfigArgs, generateMcpConfigFile, mergeOpencodeConfig, writeMcpConfigToPath, writeProviderMcpConfig, writeProviderMcpConfigTarget };
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

/**
 * Shared tool execution helper for provider classes that use a native MCP bridge.
 * Replaces identical private `executeTool` methods in anthropic-api and openai-api.
 */
export async function executeBridgeTool(
  bridge: ProviderMcpBridge | undefined,
  name: string,
  input: Record<string, unknown>,
): Promise<ProviderMcpToolResult> {
  if (!bridge) {
    return {
      content: `Tool "${name}" failed: MCP bridge not configured`,
      isError: true,
    };
  }

  try {
    return await bridge.executeTool(name, input);
  } catch (err) {
    const message = errorMessage(err);
    return {
      content: `Tool "${name}" failed: ${message}`,
      isError: true,
    };
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
