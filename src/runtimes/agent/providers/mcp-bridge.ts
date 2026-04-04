// src/runtimes/agent/providers/mcp-bridge.ts
// Provider-aware MCP bridge: generates .mcp.json configs for CLI providers and
// converts MCP tool definitions to API function-calling formats for API providers.

import type { McpMode } from './types.ts';

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
            command: 'node',
            args: ['--experimental-strip-types', proxyScriptPath],
            env: { WHATSOUP_SOCKET: socketPath },
          },
        },
      };

    default:
      // API providers don't need config files
      return null;
  }
}

// ---------------------------------------------------------------------------
// API tool conversion
// ---------------------------------------------------------------------------

/**
 * Convert MCP tool definitions to OpenAI function calling format.
 * Used by API providers (openai-api) to include WhatSoup's tools in requests.
 */
export function convertMcpToolsToOpenAI(
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>,
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
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>,
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
      return 'config_file';
    case 'openai-api':
    case 'anthropic-api':
      return 'native_bridge';
    default:
      return 'none';
  }
}
