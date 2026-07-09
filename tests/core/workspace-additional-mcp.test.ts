import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMcpAllowlist, provisionWorkspace, type ProvisionOptions } from '../../src/core/workspace.ts';
import type { AdditionalMcpServerConfig } from '../../src/core/provider-mcp-config.ts';

// Sandbox-workspace threading of instance-declared MCP servers (P1-24/P1-25).
// Real fs, mirroring tests/core/workspace.test.ts conventions.

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), 'ws-amcp-'));
}

const m365: AdditionalMcpServerConfig = {
  name: 'microsoft_365',
  command: '/pinned/node',
  args: ['/opt/agent/.claude/plugins/microsoft-365/mcp-server/dist/index.js'],
  env: { MS365_HUB_URL: 'https://hub.example:10000' },
};

function makeOpts(workspacePath: string, instanceCwd: string, over: Partial<ProvisionOptions> = {}): ProvisionOptions {
  return {
    workspacePath,
    instanceCwd,
    sandbox: {
      allowedPaths: ['/some/other/path'],
      allowedTools: ['Read', 'Write'],
      allowedMcpTools: ['whatsoup'],
      bash: { enabled: true, pathRestricted: true },
    },
    hookPath: '/abs/path/to/agent-sandbox.sh',
    mcpServerPath: '/abs/path/to/whatsoup-proxy.ts',
    sendMediaServerPath: '/abs/path/to/send-media-server.ts',
    ...over,
  };
}

describe('provisionWorkspace — additionalMcpServers threading', () => {
  it('appends declared servers AFTER send-media and asserts the required surface', () => {
    const workspacePath = makeTmp();
    const opts = makeOpts(workspacePath, makeTmp(), {
      additionalMcpServers: [m365],
      requiredMcpServerNames: ['whatsoup', 'microsoft_365'],
    });
    provisionWorkspace(opts);
    const parsed = JSON.parse(readFileSync(join(workspacePath, '.mcp.json'), 'utf8')) as {
      mcpServers: Record<string, { command: string }>;
    };
    expect(Object.keys(parsed.mcpServers)).toEqual(['whatsoup', 'send-media', 'microsoft_365']);
    expect(parsed.mcpServers.microsoft_365.command).toBe('/pinned/node');
  });

  it('leaves the legacy no-declaration shape untouched', () => {
    const workspacePath = makeTmp();
    provisionWorkspace(makeOpts(workspacePath, makeTmp()));
    const parsed = JSON.parse(readFileSync(join(workspacePath, '.mcp.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(parsed.mcpServers)).toEqual(['whatsoup', 'send-media']);
  });

  it('does NOT auto-mirror declared servers into the sandbox MCP allowlist', () => {
    // agent-sandbox.sh matches allowedMcpTools exactly; operators enumerate
    // mcp__<server>__<tool> entries in sandbox.allowedMcpTools themselves.
    expect(buildMcpAllowlist(['send_message'], true)).toEqual([
      'mcp__whatsoup__send_message',
      'mcp__send-media__send_media',
    ]);
  });
});
