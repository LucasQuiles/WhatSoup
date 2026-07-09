import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  McpSurfaceAssertionError,
  assertWrittenMcpSurface,
  generateMcpConfigFile,
  writeMcpConfigToPath,
  writeProviderMcpConfig,
  type AdditionalMcpServerConfig,
} from '../../src/core/provider-mcp-config.ts';

// Real-fs companion to provider-mcp-config.test.ts (which fully mocks fs):
// the surface assertion re-reads the file it just wrote, so these tests want
// actual bytes on disk.

const SOCKET = '/tmp/ws-test.sock';
const PROXY = '/repo/deploy/mcp/whatsoup-proxy.ts';

const m365: AdditionalMcpServerConfig = {
  name: 'microsoft_365',
  command: '/pinned/node',
  args: ['/opt/agent/.claude/plugins/microsoft-365/mcp-server/dist/index.js'],
  env: { MS365_HUB_URL: 'https://hub.example:10000', MS365_HUB_API_KEY: 'resolved' },
};

const proxyLane: AdditionalMcpServerConfig = {
  name: 'tmup',
  proxyScriptPath: '/opt/agent/tools/tmup-proxy.ts',
  env: {},
};

describe('generateMcpConfigFile — explicit command/args lane (P1-16)', () => {
  it('emits command/args verbatim for claude-cli and keeps whatsoup first', () => {
    const cfg = generateMcpConfigFile('claude-cli', SOCKET, PROXY, [m365]) as {
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    };
    expect(Object.keys(cfg.mcpServers)[0]).toBe('whatsoup');
    expect(cfg.mcpServers.microsoft_365.command).toBe('/pinned/node');
    expect(cfg.mcpServers.microsoft_365.args).toEqual([m365.args![0]]);
    expect(cfg.mcpServers.microsoft_365.env.MS365_HUB_URL).toBe('https://hub.example:10000');
    expect(cfg.mcpServers.whatsoup.env.WHATSOUP_SOCKET).toBe(SOCKET);
  });

  it('still supports the proxyScriptPath lane through the tsx launcher', () => {
    const cfg = generateMcpConfigFile('claude-cli', SOCKET, PROXY, [proxyLane]) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(cfg.mcpServers.tmup.args).toContain('/opt/agent/tools/tmup-proxy.ts');
  });

  it('emits the opencode command-array shape for the command lane', () => {
    const cfg = generateMcpConfigFile('opencode-cli', SOCKET, PROXY, [m365]) as {
      mcp: Record<string, { command: string[]; environment: Record<string, string> }>;
    };
    expect(cfg.mcp.microsoft_365.command).toEqual(['/pinned/node', m365.args![0]]);
    expect(cfg.mcp.microsoft_365.environment.MS365_HUB_API_KEY).toBe('resolved');
  });
});

describe('assertWrittenMcpSurface (P1-18)', () => {
  it('passes when every required server is present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-surface-'));
    const p = join(dir, 'cfg.mcp.json');
    writeMcpConfigToPath('claude-cli', p, SOCKET, PROXY, [m365], ['whatsoup', 'microsoft_365']);
    expect(() => assertWrittenMcpSurface('claude-cli', p, ['whatsoup', 'microsoft_365'])).not.toThrow();
  });

  it('throws McpSurfaceAssertionError naming the missing servers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-surface-'));
    const p = join(dir, 'cfg.mcp.json');
    writeMcpConfigToPath('claude-cli', p, SOCKET, PROXY, [], ['whatsoup']);
    try {
      assertWrittenMcpSurface('claude-cli', p, ['whatsoup', 'microsoft_365']);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(McpSurfaceAssertionError);
      expect((err as McpSurfaceAssertionError).missing).toEqual(['microsoft_365']);
      expect((err as Error).message).toContain(p);
    }
  });

  it('fails closed on an unparseable config file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-surface-'));
    const p = join(dir, 'broken.mcp.json');
    writeFileSync(p, '{not json');
    expect(() => assertWrittenMcpSurface('claude-cli', p, ['whatsoup', 'microsoft_365'])).toThrow();
  });

  it('fails closed on a missing file', () => {
    expect(() =>
      assertWrittenMcpSurface('claude-cli', '/nonexistent/cfg.mcp.json', ['whatsoup', 'microsoft_365']),
    ).toThrow();
  });

  it('skips the assertion entirely for platform-only surfaces (legacy behavior preserved)', () => {
    expect(() =>
      assertWrittenMcpSurface('claude-cli', '/nonexistent/cfg.mcp.json', ['whatsoup', 'send-media']),
    ).not.toThrow();
  });
});

describe('writeMcpConfigToPath — assertion wired in (P1-19)', () => {
  it('writes 0600 and self-asserts the required surface', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-wcp-'));
    const p = join(dir, 'per-chat.mcp.json');
    const written = writeMcpConfigToPath('claude-cli', p, SOCKET, PROXY, [m365], ['whatsoup', 'microsoft_365']);
    expect(written).toBe(p);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    expect(Object.keys(parsed.mcpServers)).toEqual(['whatsoup', 'microsoft_365']);
  });

  it('throws when a required server cannot be in the generated config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-wcp-'));
    const p = join(dir, 'per-chat.mcp.json');
    expect(() =>
      writeMcpConfigToPath('claude-cli', p, SOCKET, PROXY, [], ['whatsoup', 'microsoft_365']),
    ).toThrow(McpSurfaceAssertionError);
  });
});

describe('writeProviderMcpConfig — QR-254 unification pin (P1-20/P1-21)', () => {
  it('produces byte-identical .mcp.json for the legacy no-additional case', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-legacy-'));
    writeProviderMcpConfig('claude-cli', dir, SOCKET, PROXY);
    const bytes = readFileSync(join(dir, '.mcp.json'), 'utf8');
    const expected = JSON.stringify(generateMcpConfigFile('claude-cli', SOCKET, PROXY), null, 2);
    expect(bytes).toBe(expected);
  });

  it('threads additional servers and asserts when required names are passed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-thread-'));
    const written = writeProviderMcpConfig(
      'claude-cli',
      dir,
      SOCKET,
      PROXY,
      undefined,
      [m365],
      ['whatsoup', 'microsoft_365'],
    );
    expect(written).toBe(join(dir, '.mcp.json'));
    const parsed = JSON.parse(readFileSync(written!, 'utf8'));
    expect(parsed.mcpServers.microsoft_365.command).toBe('/pinned/node');
  });
});

describe('writeProviderMcpConfig — opencode symlink skip-guard scope', () => {
  it('keeps legacy warn-and-skip when only platform servers are required (send-media)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-oc-legacy-'));
    symlinkSync(join(dir, 'elsewhere.json'), join(dir, 'opencode.json'));
    const written = writeProviderMcpConfig(
      'opencode-cli',
      dir,
      SOCKET,
      PROXY,
      undefined,
      [],
      ['whatsoup', 'send-media'],
    );
    expect(written).toBeNull();
    // Skip means SKIP: nothing may be written through the symlink either.
    expect(existsSync(join(dir, 'elsewhere.json'))).toBe(false);
  });

  it('fails closed on a symlink when an instance-declared server is required', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-oc-declared-'));
    symlinkSync(join(dir, 'elsewhere.json'), join(dir, 'opencode.json'));
    expect(() =>
      writeProviderMcpConfig('opencode-cli', dir, SOCKET, PROXY, undefined, [m365], ['whatsoup', 'microsoft_365']),
    ).toThrow(/microsoft_365/);
  });
});
