import { describe, it, expect } from 'vitest';
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
          command: 'node',
          args: ['--experimental-strip-types', script],
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

  it('codex-cli output matches the same shape', () => {
    const result = generateMcpConfigFile('codex-cli', socketPath, proxyScript);
    expect(result).toEqual(inlineOracle(socketPath, proxyScript));
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
