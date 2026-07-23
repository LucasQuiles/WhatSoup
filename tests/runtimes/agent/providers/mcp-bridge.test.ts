import { describe, it, expect } from 'vitest';
import { buildMcpLaunchCommand } from '../../../../src/core/mcp-launcher.ts';
import { generateMcpConfigFile } from '../../../../src/runtimes/agent/providers/mcp-bridge.ts';

// ---------------------------------------------------------------------------
// Oracle audit: ensures generateMcpConfigFile produces the exact shape that
// runtime.ts previously generated inline (~lines 643-656).  Any drift between
// the bridge helper and the expected structure is caught here.
// ---------------------------------------------------------------------------

describe('generateMcpConfigFile – oracle comparison', () => {
  const socketPath = '/tmp/test.sock';
  const proxyScript = '/opt/whatsoup/deploy/mcp/whatsoup-proxy.ts';

  /** The config shape that runtime.ts used to build inline. */
  function inlineOracle(socket: string, script: string): Record<string, unknown> {
    return {
      mcpServers: {
        whatsoup: {
          ...buildMcpLaunchCommand(script),
          env: { WHATSOUP_SOCKET: socket },
        },
      },
    };
  }

  it('claude-cli output matches the former inline config', () => {
    const result = generateMcpConfigFile('claude-cli', socketPath, proxyScript);
    expect(result).toEqual(inlineOracle(socketPath, proxyScript));
  });

  it('gemini-cli output matches the same shape', () => {
    const result = generateMcpConfigFile('gemini-cli', socketPath, proxyScript);
    expect(result).toEqual(inlineOracle(socketPath, proxyScript));
  });

  it('codex-cli does not emit the unsupported project JSON shape', () => {
    const result = generateMcpConfigFile('codex-cli', socketPath, proxyScript);
    expect(result).toStrictEqual(null);
  });

  it('API providers return null (no config file needed)', () => {
    expect(generateMcpConfigFile('openai-api', socketPath, proxyScript)).toBeNull();
    expect(generateMcpConfigFile('anthropic-api', socketPath, proxyScript)).toBeNull();
  });

  it('unknown providers return null', () => {
    expect(generateMcpConfigFile('unknown', socketPath, proxyScript)).toBeNull();
  });

  it('serialized JSON is stable and well-formed', () => {
    const config = generateMcpConfigFile('claude-cli', socketPath, proxyScript);
    const json = JSON.stringify(config, null, 2);
    expect(JSON.parse(json)).toEqual(config);
    expect(json).toContain('"whatsoup"');
    expect(json).toContain(socketPath);
    expect(json).toContain(proxyScript);
  });
});

// ---------------------------------------------------------------------------
// opencode-cli uses a different schema than claude/gemini/codex: a top-level
// `mcp` object whose entries are `{ type: 'local', command: [argv...],
// environment: {...}, enabled: true }` — verified against the installed
// opencode 1.16.2 global config (~/.config/opencode/opencode.json). The single
// `command` array is the flattened launch argv (command + args), and the env
// vars live under `environment` (NOT claude's `env`). The whatsoup MCP must be
// emitted for opencode-cli or the agent loses send_message + all tools.
// ---------------------------------------------------------------------------

describe('generateMcpConfigFile – opencode-cli schema', () => {
  const socketPath = '/tmp/test.sock';
  const proxyScript = '/opt/whatsoup/deploy/mcp/whatsoup-proxy.ts';

  it('emits opencode mcp shape with flattened command argv and environment', () => {
    const launch = buildMcpLaunchCommand(proxyScript);
    const result = generateMcpConfigFile('opencode-cli', socketPath, proxyScript);
    expect(result).toEqual({
      mcp: {
        whatsoup: {
          type: 'local',
          command: [launch.command, ...launch.args],
          environment: { WHATSOUP_SOCKET: socketPath },
          enabled: true,
        },
      },
    });
  });

  it('does NOT use claude-style mcpServers/env keys for opencode', () => {
    const result = generateMcpConfigFile('opencode-cli', socketPath, proxyScript);
    const json = JSON.stringify(result);
    expect(json).not.toContain('mcpServers');
    expect(json).toContain('"environment"');
    expect(json).not.toContain('"env"');
    expect(json).toContain('"type":"local"');
  });

  it('serialized JSON is well-formed and contains the proxy script and socket', () => {
    const config = generateMcpConfigFile('opencode-cli', socketPath, proxyScript);
    const json = JSON.stringify(config, null, 2);
    expect(JSON.parse(json)).toEqual(config);
    expect(json).toContain(proxyScript);
    expect(json).toContain(socketPath);
  });
});

// ---------------------------------------------------------------------------
// executeBridgeTool — shared tool execution helper (Step 5)
// ---------------------------------------------------------------------------

describe('executeBridgeTool', () => {
  it('returns isError result containing "MCP bridge not configured" when bridge is undefined', async () => {
    const { executeBridgeTool } = await import('../../../../src/runtimes/agent/providers/mcp-bridge.ts');
    const result = await executeBridgeTool(undefined, 'my_tool', {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('MCP bridge not configured');
  });

  it('returns isError result containing "failed" and the error message when bridge throws', async () => {
    const { executeBridgeTool } = await import('../../../../src/runtimes/agent/providers/mcp-bridge.ts');
    const bridge = {
      listTools: () => [],
      executeTool: async () => { throw new Error('boom'); },
    };
    const result = await executeBridgeTool(bridge, 'my_tool', {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('failed');
    expect(result.content).toContain('boom');
  });

  it('passes through the result from a resolving bridge', async () => {
    const { executeBridgeTool } = await import('../../../../src/runtimes/agent/providers/mcp-bridge.ts');
    const expected = { content: 'tool result', isError: false };
    const bridge = {
      listTools: () => [],
      executeTool: async () => expected,
    };
    const result = await executeBridgeTool(bridge, 'my_tool', {});
    expect(result).toEqual(expected);
  });
});
