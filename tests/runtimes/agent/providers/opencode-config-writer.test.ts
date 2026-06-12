import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMcpLaunchCommand } from '../../../../src/core/mcp-launcher.ts';
import {
  generateMcpConfigFile,
  mergeOpencodeConfig,
  writeProviderMcpConfig,
} from '../../../../src/runtimes/agent/providers/mcp-bridge.ts';

// ---------------------------------------------------------------------------
// mergeOpencodeConfig — pure merge of the generated opencode `mcp` block into a
// possibly-existing opencode.json. Must NOT clobber unrelated top-level keys
// (model, provider catalog) nor sibling mcp servers. Optionally merges a
// `provider` block when a custom cloud baseUrl is configured.
// ---------------------------------------------------------------------------

const socketPath = '/tmp/test.sock';
const proxyScript = '/opt/whatsoup/deploy/mcp/whatsoup-proxy.ts';

function generatedMcp(): Record<string, unknown> {
  const cfg = generateMcpConfigFile('opencode-cli', socketPath, proxyScript);
  return cfg as Record<string, unknown>;
}

describe('mergeOpencodeConfig — merge without clobbering', () => {
  it('adds mcp.whatsoup into an empty (absent) config', () => {
    const launch = buildMcpLaunchCommand(proxyScript);
    const merged = mergeOpencodeConfig(null, generatedMcp());
    expect(merged).toEqual({
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

  it('preserves existing top-level keys and sibling mcp servers', () => {
    const existing = {
      $schema: 'https://opencode.ai/config.json',
      model: 'minimax/MiniMax-M2',
      mcp: {
        github: { type: 'local', command: ['npx', 'gh-mcp'], enabled: true },
      },
    };
    const merged = mergeOpencodeConfig(existing, generatedMcp());
    expect(merged.model).toBe('minimax/MiniMax-M2');
    expect(merged.$schema).toBe('https://opencode.ai/config.json');
    const mcp = merged.mcp as Record<string, Record<string, unknown>>;
    expect(mcp.github).toEqual({ type: 'local', command: ['npx', 'gh-mcp'], enabled: true });
    expect(mcp.whatsoup.environment).toEqual({ WHATSOUP_SOCKET: socketPath });
  });

  it('overwrites a stale whatsoup entry with the freshly generated one', () => {
    const existing = {
      mcp: {
        whatsoup: { type: 'local', command: ['old'], environment: { WHATSOUP_SOCKET: '/old.sock' }, enabled: true },
      },
    };
    const merged = mergeOpencodeConfig(existing, generatedMcp());
    const mcp = merged.mcp as Record<string, Record<string, unknown>>;
    expect(mcp.whatsoup.command).not.toContain('old');
    expect(mcp.whatsoup.environment).toEqual({ WHATSOUP_SOCKET: socketPath });
  });

  it('adds a provider block + model when a custom baseUrl is configured', () => {
    const merged = mergeOpencodeConfig(null, generatedMcp(), {
      baseUrl: 'https://cloud.example.com/v1',
      providerId: 'mycloud',
      model: 'big-model',
    });
    const provider = merged.provider as Record<string, Record<string, unknown>>;
    expect(provider.mycloud).toBeDefined();
    const options = provider.mycloud.options as Record<string, unknown>;
    expect(options.baseURL).toBe('https://cloud.example.com/v1');
    const models = provider.mycloud.models as Record<string, unknown>;
    expect(models['big-model']).toEqual({});
    expect(merged.model).toBe('mycloud/big-model');
  });

  it('does NOT add a provider block when no baseUrl is set', () => {
    const merged = mergeOpencodeConfig(null, generatedMcp(), { model: 'x' });
    // Without a baseUrl the merge stays MCP-only: exactly the `mcp` key, no
    // `provider` block and no top-level `model` rewrite leaked in.
    expect(Object.keys(merged).sort()).toEqual(['mcp']);
  });
});

// ---------------------------------------------------------------------------
// writeProviderMcpConfig — routes to the right on-disk file per provider:
// claude/gemini/codex → <cwd>/.mcp.json (mcpServers shape, overwrite),
// opencode-cli → <cwd>/opencode.json (mcp shape, merged with any existing).
// ---------------------------------------------------------------------------

describe('writeProviderMcpConfig — per-provider file routing', () => {
  function tmp(): string {
    return mkdtempSync(join(tmpdir(), 'ws-mcp-writer-'));
  }

  it('claude-cli writes .mcp.json with mcpServers and no opencode.json', () => {
    const dir = tmp();
    try {
      const written = writeProviderMcpConfig('claude-cli', dir, socketPath, proxyScript);
      expect(written).toBe(join(dir, '.mcp.json'));
      const parsed = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'));
      expect(parsed.mcpServers.whatsoup).toBeDefined();
      expect(parsed.mcpServers.whatsoup.env).toEqual({ WHATSOUP_SOCKET: socketPath });
      expect(existsSync(join(dir, 'opencode.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('opencode-cli writes opencode.json with mcp shape and no .mcp.json', () => {
    const dir = tmp();
    try {
      const written = writeProviderMcpConfig('opencode-cli', dir, socketPath, proxyScript);
      expect(written).toBe(join(dir, 'opencode.json'));
      const parsed = JSON.parse(readFileSync(join(dir, 'opencode.json'), 'utf8'));
      expect(parsed.mcp.whatsoup.type).toBe('local');
      expect(parsed.mcp.whatsoup.environment).toEqual({ WHATSOUP_SOCKET: socketPath });
      expect(existsSync(join(dir, '.mcp.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('opencode-cli merges into a pre-existing user opencode.json without clobbering', () => {
    const dir = tmp();
    try {
      writeFileSync(
        join(dir, 'opencode.json'),
        JSON.stringify({ model: 'user/model', mcp: { custom: { type: 'local', command: ['c'] } } }),
      );
      writeProviderMcpConfig('opencode-cli', dir, socketPath, proxyScript);
      const parsed = JSON.parse(readFileSync(join(dir, 'opencode.json'), 'utf8'));
      expect(parsed.model).toBe('user/model');
      expect(parsed.mcp.custom).toEqual({ type: 'local', command: ['c'] });
      expect(parsed.mcp.whatsoup.environment).toEqual({ WHATSOUP_SOCKET: socketPath });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('opencode-cli writes a provider block when providerConfig.baseUrl is set', () => {
    const dir = tmp();
    try {
      writeProviderMcpConfig('opencode-cli', dir, socketPath, proxyScript, {
        baseUrl: 'https://api.cloud.test/v1',
        model: 'm',
      });
      const parsed = JSON.parse(readFileSync(join(dir, 'opencode.json'), 'utf8'));
      const providerIds = Object.keys(parsed.provider);
      expect(providerIds.length).toBe(1);
      const block = parsed.provider[providerIds[0]];
      expect(block.options.baseURL).toBe('https://api.cloud.test/v1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null for native-bridge providers (no config file)', () => {
    const dir = tmp();
    try {
      const written = writeProviderMcpConfig('openai-api', dir, socketPath, proxyScript);
      expect(written).toBeNull();
      expect(existsSync(join(dir, '.mcp.json'))).toBe(false);
      expect(existsSync(join(dir, 'opencode.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
