import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Hoisted mocks for `node:fs`. `writeProviderMcpConfig` calls
// `lstatSync`/`existsSync`/`readFileSync` directly (for symlink detection and
// pre-existing-config parsing), and it calls `writePrivateFileSync` from
// `private-fs.ts` for the actual write — we mock that helper directly to keep
// these tests off the real filesystem and to drive the ELOOP branches.
// ---------------------------------------------------------------------------
const {
  mockLstatSync,
  mockExistsSync,
  mockReadFileSync,
  mockLogWarn,
  mockWritePrivate,
} = vi.hoisted(() => ({
  mockLstatSync: vi.fn(),
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockLogWarn: vi.fn(),
  mockWritePrivate: vi.fn(),
}));

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: mockLogWarn,
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../src/lib/private-fs.ts', () => ({
  writePrivateFileSync: mockWritePrivate,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    lstatSync: mockLstatSync,
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
  };
});

import {
  buildManagedOpencodeAgentConfig,
  generateMcpConfigFile,
  mergeOpencodeConfig,
  OPENCODE_REQUIRED_DENY,
  WHATSOUP_OPENCODE_AGENT_ID,
  writeProviderMcpConfig,
  writeProviderMcpConfigTarget,
} from '../../src/core/provider-mcp-config.ts';
import { REQUIRED_DENY } from '../../src/core/settings-template.ts';

const SOCKET = '/tmp/whatsoup-test.sock';
const PROXY = '/opt/whatsoup/deploy/mcp/whatsoup-proxy.ts';

function generated(): Record<string, unknown> {
  return generateMcpConfigFile('opencode-cli', SOCKET, PROXY) as Record<string, unknown>;
}

beforeEach(() => {
  mockLstatSync.mockReset();
  mockExistsSync.mockReset();
  mockReadFileSync.mockReset();
  mockLogWarn.mockReset();
  mockWritePrivate.mockReset();
  // Default: writePrivateFileSync succeeds (covers the happy path).
  mockWritePrivate.mockImplementation(() => undefined);
});

// ---------------------------------------------------------------------------
// writeProviderMcpConfigTarget — pure dispatcher; must point at the right
// on-disk file for each CLI provider and return null for native-bridge / API
// providers that do not consume a config file.
// ---------------------------------------------------------------------------
describe('writeProviderMcpConfigTarget', () => {
  it('routes claude-cli to .mcp.json under the agent cwd', () => {
    expect(writeProviderMcpConfigTarget('claude-cli', '/agent/cwd'))
      .toBe(join('/agent/cwd', '.mcp.json'));
  });

  it('routes gemini-cli to .mcp.json under the agent cwd', () => {
    expect(writeProviderMcpConfigTarget('gemini-cli', '/agent/cwd'))
      .toBe(join('/agent/cwd', '.mcp.json'));
  });

  it('routes codex-cli to .mcp.json under the agent cwd', () => {
    expect(writeProviderMcpConfigTarget('codex-cli', '/agent/cwd'))
      .toBe(join('/agent/cwd', '.mcp.json'));
  });

  it('routes opencode-cli to opencode.json under the agent cwd', () => {
    expect(writeProviderMcpConfigTarget('opencode-cli', '/agent/cwd'))
      .toBe(join('/agent/cwd', 'opencode.json'));
  });

  it('returns null for native-bridge providers (openai-api, anthropic-api, chat-api)', () => {
    expect(writeProviderMcpConfigTarget('openai-api', '/agent/cwd')).toBeNull();
    expect(writeProviderMcpConfigTarget('anthropic-api', '/agent/cwd')).toBeNull();
    expect(writeProviderMcpConfigTarget('chat-api', '/agent/cwd')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// generateMcpConfigFile — pure config generation. Covers each provider arm
// plus the `additionalServers` default-empty case and the prepend behaviour.
// ---------------------------------------------------------------------------
describe('generateMcpConfigFile', () => {
  it('returns null for native-bridge providers', () => {
    expect(generateMcpConfigFile('openai-api', SOCKET, PROXY)).toBeNull();
    expect(generateMcpConfigFile('anthropic-api', SOCKET, PROXY)).toBeNull();
  });

  it('emits the mcpServers shape for claude-cli with a whatsoup entry', () => {
    const cfg = generateMcpConfigFile('claude-cli', SOCKET, PROXY) as Record<string, Record<string, Record<string, unknown>>>;
    expect(Object.keys(cfg)).toEqual(['mcpServers']);
    const whatsoup = cfg.mcpServers.whatsoup as Record<string, unknown>;
    expect(whatsoup.env).toEqual({ WHATSOUP_SOCKET: SOCKET });
    expect(typeof whatsoup.command).toBe('string');
    expect(Array.isArray(whatsoup.args)).toBe(true);
  });

  it('emits the same mcpServers shape for gemini-cli and codex-cli', () => {
    const gem = generateMcpConfigFile('gemini-cli', SOCKET, PROXY) as Record<string, Record<string, unknown>>;
    const cdx = generateMcpConfigFile('codex-cli', SOCKET, PROXY) as Record<string, Record<string, unknown>>;
    expect(Object.keys(gem)).toEqual(['mcpServers']);
    expect(Object.keys(cdx)).toEqual(['mcpServers']);
    expect((gem.mcpServers.whatsoup as Record<string, unknown>).env).toEqual({ WHATSOUP_SOCKET: SOCKET });
    expect((cdx.mcpServers.whatsoup as Record<string, unknown>).env).toEqual({ WHATSOUP_SOCKET: SOCKET });
  });

  it('emits the opencode `mcp` shape with type:local, environment, enabled:true', () => {
    const cfg = generateMcpConfigFile('opencode-cli', SOCKET, PROXY) as Record<string, Record<string, Record<string, unknown>>>;
    expect(Object.keys(cfg)).toEqual(['mcp']);
    const whatsoup = cfg.mcp.whatsoup;
    expect(whatsoup.type).toBe('local');
    expect(whatsoup.environment).toEqual({ WHATSOUP_SOCKET: SOCKET });
    expect(whatsoup.enabled).toBe(true);
    expect(Array.isArray(whatsoup.command)).toBe(true);
  });

  it('prepends the whatsoup entry and appends additionalServers in order', () => {
    const extras: { name: string; proxyScriptPath: string; env: Record<string, string> }[] = [
      { name: 'github', proxyScriptPath: '/p/github.ts', env: { TOKEN: 'x' } },
      { name: 'sentry', proxyScriptPath: '/p/sentry.ts', env: { SENTRY_TOKEN: 'y' } },
    ];
    const cfg = generateMcpConfigFile('opencode-cli', SOCKET, PROXY, extras) as Record<string, Record<string, Record<string, unknown>>>;
    expect(Object.keys(cfg.mcp)).toEqual(['whatsoup', 'github', 'sentry']);
    expect(cfg.mcp.github.environment).toEqual({ TOKEN: 'x' });
    expect(cfg.mcp.sentry.environment).toEqual({ SENTRY_TOKEN: 'y' });
  });
});

// ---------------------------------------------------------------------------
// mergeOpencodeConfig — pure merge. Covers the truthy/falsy existing path,
// the shape guards (mcp / provider), the `baseUrl`-set vs unset branches,
// apiKeyService resolution, model rewrite, and the provider/model removal
// path on the unset branch.
// ---------------------------------------------------------------------------
describe('mergeOpencodeConfig', () => {
  it('seeds mcp.whatsoup and the reserved WhatSoup headless agent when existing is null', () => {
    const merged = mergeOpencodeConfig(null, generated());
    expect(Object.keys(merged)).toEqual(['mcp', 'agent']);
    expect(merged.mcp).toHaveProperty('whatsoup');

    const agents = merged.agent as Record<string, Record<string, unknown>>;
    expect(WHATSOUP_OPENCODE_AGENT_ID).toBe('whatsoup-headless');
    expect(Object.keys(agents)).toEqual([WHATSOUP_OPENCODE_AGENT_ID]);
    expect(agents[WHATSOUP_OPENCODE_AGENT_ID]).toEqual(buildManagedOpencodeAgentConfig());
    expect(agents[WHATSOUP_OPENCODE_AGENT_ID]).toMatchObject({ mode: 'primary' });
    expect(agents[WHATSOUP_OPENCODE_AGENT_ID].permission).toMatchObject({
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
    });
  });

  it('translates the Claude mutation deny floor into collision-free OpenCode tool names', () => {
    const merged = mergeOpencodeConfig(null, generated());
    const agents = merged.agent as Record<string, Record<string, unknown>>;
    const permission = agents['whatsoup-headless'].permission as Record<string, unknown>;

    expect(OPENCODE_REQUIRED_DENY).toHaveLength(REQUIRED_DENY.length);
    expect(new Set(OPENCODE_REQUIRED_DENY).size).toBe(REQUIRED_DENY.length);
    expect(OPENCODE_REQUIRED_DENY[0]).toBe('claude_ai_Gmail_create_draft');
    expect(OPENCODE_REQUIRED_DENY).toContain(
      'plugin_microsoft_365_microsoft_365_send-mail',
    );
    expect(OPENCODE_REQUIRED_DENY.every((entry) => !entry.startsWith('mcp_'))).toBe(true);
    for (const toolName of OPENCODE_REQUIRED_DENY) expect(permission[toolName]).toBe('deny');
  });

  it('preserves user agents and global permissions while replacing only the reserved agent', () => {
    const userAgent = {
      description: 'user-owned',
      mode: 'subagent',
      permission: { '*': 'ask' },
    };
    const globalPermission = { '*': 'deny', read: 'allow' };
    const merged = mergeOpencodeConfig({
      permission: globalPermission,
      agent: {
        personal: userAgent,
        'whatsoup-headless': { description: 'stale managed config', permission: { '*': 'deny' } },
      },
    }, generated());

    expect(merged.permission).toEqual(globalPermission);
    const agents = merged.agent as Record<string, Record<string, unknown>>;
    expect(agents.personal).toEqual(userAgent);
    expect(agents['whatsoup-headless']).not.toHaveProperty('description', 'stale managed config');
    expect(agents['whatsoup-headless']).toMatchObject({ mode: 'primary' });
  });

  it.each(['broken', [], null])('treats corrupt agent value %j as empty', (agent) => {
    const merged = mergeOpencodeConfig({ agent: agent as never }, generated());
    const agents = merged.agent as Record<string, Record<string, unknown>>;
    expect(Object.keys(agents)).toEqual(['whatsoup-headless']);
  });

  it('tolerates a generated object without an mcp key (?? {} fallback)', () => {
    // mergeOpencodeConfig never crashes when callers pass a generated payload
    // missing the mcp block; base.mcp is still assembled from the existing
    // side alone.
    const existing = { mcp: { keep: { type: 'local', command: ['k'] } } };
    const merged = mergeOpencodeConfig(existing, { notMcp: true });
    expect(merged.mcp).toEqual({ keep: { type: 'local', command: ['k'] } });
  });

  it('preserves a non-object base.mcp value by treating it as empty', () => {
    const merged = mergeOpencodeConfig({ mcp: 'not-an-object' as never }, generated());
    expect(merged.mcp).toHaveProperty('whatsoup');
  });

  it('preserves an array-shaped base.mcp by treating it as empty', () => {
    const merged = mergeOpencodeConfig({ mcp: ['nope'] as never }, generated());
    expect(merged.mcp).toHaveProperty('whatsoup');
  });

  it('merges into an existing mcp object without clobbering sibling servers', () => {
    const existing = { mcp: { custom: { type: 'local', command: ['x'], environment: {}, enabled: true } } };
    const merged = mergeOpencodeConfig(existing, generated());
    expect(merged.mcp).toHaveProperty('custom');
    expect(merged.mcp).toHaveProperty('whatsoup');
  });

  it('overrides a stale whatsoup entry on merge (refreshes socket path)', () => {
    const existing = {
      mcp: {
        whatsoup: {
          type: 'local',
          command: ['stale-runner', 'stale.ts'],
          environment: { WHATSOUP_SOCKET: '/stale.sock' },
          enabled: true,
        },
      },
    };
    const merged = mergeOpencodeConfig(existing, generated());
    const whatsoup = (merged.mcp as Record<string, Record<string, unknown>>).whatsoup;
    expect(whatsoup.environment).toEqual({ WHATSOUP_SOCKET: SOCKET });
  });

  it('uses the default providerId (whatsoup-cloud) when none is supplied with baseUrl', () => {
    const merged = mergeOpencodeConfig(null, generated(), {
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
    });
    expect(Object.keys(merged.provider as Record<string, unknown>)).toEqual(['whatsoup-cloud']);
  });

  it('respects an explicit providerId when supplied with baseUrl', () => {
    const merged = mergeOpencodeConfig(null, generated(), {
      baseUrl: 'https://api.example.com/v1',
      providerId: 'my-cloud',
      model: 'm',
    });
    expect(Object.keys(merged.provider as Record<string, unknown>)).toEqual(['my-cloud']);
  });

  it('uses an explicit apiKeyService override and looks up its env var in SERVICE_ENV_MAP', () => {
    const merged = mergeOpencodeConfig(null, generated(), {
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      apiKeyService: 'minimax',
    });
    const provider = merged.provider as Record<string, Record<string, Record<string, unknown>>>;
    expect(provider['whatsoup-cloud'].options.apiKey).toBe('{env:MINIMAX_API_KEY}');
  });

  it('derives the apiKeyService from the model prefix when no override is given', () => {
    const merged = mergeOpencodeConfig(null, generated(), {
      baseUrl: 'https://api.example.com/v1',
      model: 'openai/gpt-4o',
    });
    const provider = merged.provider as Record<string, Record<string, Record<string, unknown>>>;
    expect(provider['whatsoup-cloud'].options.apiKey).toBe('{env:OPENAI_API_KEY}');
  });

  it('omits apiKey when no SERVICE_ENV_MAP entry is known for the resolved service', () => {
    const merged = mergeOpencodeConfig(null, generated(), {
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      apiKeyService: 'totally-unknown-service',
    });
    const provider = merged.provider as Record<string, Record<string, Record<string, unknown>>>;
    expect(Object.prototype.hasOwnProperty.call(provider['whatsoup-cloud'].options, 'apiKey')).toBe(false);
  });

  it('omits models and top-level model rewrite when model is absent on the baseUrl branch', () => {
    const merged = mergeOpencodeConfig(null, generated(), {
      baseUrl: 'https://api.example.com/v1',
    });
    const provider = merged.provider as Record<string, Record<string, Record<string, unknown>>>;
    expect(provider['whatsoup-cloud'].models).toEqual({});
    expect(Object.prototype.hasOwnProperty.call(merged, 'model')).toBe(false);
  });

  it('preserves an existing provider catalog when adding the whatsoup-cloud provider', () => {
    const existing = { provider: { other: { options: { baseURL: 'https://other.example/v1' } } } };
    const merged = mergeOpencodeConfig(existing, generated(), {
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
    });
    const provider = merged.provider as Record<string, Record<string, unknown>>;
    expect(Object.keys(provider).sort()).toEqual(['other', 'whatsoup-cloud']);
  });

  it('removes a stale provider block when no baseUrl is set (else-branch cleanup)', () => {
    const existing = {
      mcp: {},
      provider: { 'whatsoup-cloud': { options: { baseURL: 'https://x/v1' } } },
    };
    const merged = mergeOpencodeConfig(existing, generated(), { model: 'm' });
    expect(Object.prototype.hasOwnProperty.call(merged, 'provider')).toBe(false);
  });

  it('removes only the managed providerId and keeps sibling providers when no baseUrl is set', () => {
    const existing = {
      mcp: {},
      provider: {
        'whatsoup-cloud': { options: { baseURL: 'https://x/v1' } },
        'other-cloud': { options: { baseURL: 'https://y/v1' } },
      },
    };
    const merged = mergeOpencodeConfig(existing, generated(), { model: 'm' });
    const provider = merged.provider as Record<string, unknown>;
    expect(Object.keys(provider)).toEqual(['other-cloud']);
  });

  it('removes a stale top-level model that is namespaced under the managed providerId', () => {
    const existing = { mcp: {}, model: 'whatsoup-cloud/m', provider: { 'whatsoup-cloud': {} } };
    const merged = mergeOpencodeConfig(existing, generated(), { model: 'm' });
    expect(Object.prototype.hasOwnProperty.call(merged, 'model')).toBe(false);
  });

  it('keeps a top-level model that is not namespaced under the managed providerId', () => {
    const existing = { mcp: {}, model: 'some-other/model', provider: { 'whatsoup-cloud': {} } };
    const merged = mergeOpencodeConfig(existing, generated(), { model: 'm' });
    expect(merged.model).toBe('some-other/model');
  });

  it('keeps an existing provider block on the else branch when it is not an object', () => {
    const merged = mergeOpencodeConfig(
      { mcp: {}, provider: 'broken' as never },
      generated(),
      { model: 'm' },
    );
    expect(merged.provider).toBe('broken');
  });

  it('keeps an existing provider block on the else branch when it is an array', () => {
    const merged = mergeOpencodeConfig(
      { mcp: {}, provider: [] as never },
      generated(),
      { model: 'm' },
    );
    expect(merged.provider).toEqual([]);
  });

  it('uses the default providerId on the else branch when no providerConfig is provided', () => {
    const existing = {
      mcp: {},
      model: 'whatsoup-cloud/m',
      provider: { 'whatsoup-cloud': {}, 'other-cloud': {} },
    };
    const merged = mergeOpencodeConfig(existing, generated());
    const provider = merged.provider as Record<string, unknown>;
    expect(Object.keys(provider)).toEqual(['other-cloud']);
    expect(Object.prototype.hasOwnProperty.call(merged, 'model')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// writeProviderMcpConfig — IO boundary. We mock the private-fs writer and
// `node:fs` so we can drive every code path including ELOOP symlink skips,
// corrupt pre-existing JSON, and the ELOOP-after-write branch. The tests
// assert against the return value (target path or null), the args passed to
// `writePrivateFileSync`, and the logger warn side effects.
// ---------------------------------------------------------------------------
describe('writeProviderMcpConfig', () => {
  it('returns null for native-bridge providers (openai-api, anthropic-api)', () => {
    expect(writeProviderMcpConfig('openai-api', '/agent', SOCKET, PROXY)).toBeNull();
    expect(writeProviderMcpConfig('anthropic-api', '/agent', SOCKET, PROXY)).toBeNull();
  });

  it('writes the mcpServers shape to .mcp.json for claude-cli/gemini-cli/codex-cli', () => {
    const target = writeProviderMcpConfig('claude-cli', '/agent', SOCKET, PROXY);
    expect(target).toBe(join('/agent', '.mcp.json'));
    expect(mockWritePrivate).toHaveBeenCalledTimes(1);
    const [writtenPath, writtenJson] = mockWritePrivate.mock.calls[0];
    expect(writtenPath).toBe(join('/agent', '.mcp.json'));
    const parsed = JSON.parse(writtenJson);
    expect(Object.keys(parsed)).toEqual(['mcpServers']);
    expect(parsed.mcpServers.whatsoup.env).toEqual({ WHATSOUP_SOCKET: SOCKET });
  });

  it('appends additionalServers into the written .mcp.json for claude-cli', () => {
    const target = writeProviderMcpConfig(
      'claude-cli',
      '/agent',
      SOCKET,
      PROXY,
      undefined,
      [{ name: 'github', proxyScriptPath: '/p/gh.ts', env: { TOKEN: 'x' } }],
    );
    expect(target).toBe(join('/agent', '.mcp.json'));
    const parsed = JSON.parse(mockWritePrivate.mock.calls[0][1]);
    expect(Object.keys(parsed.mcpServers)).toEqual(['whatsoup', 'github']);
    expect(parsed.mcpServers.github.env).toEqual({ TOKEN: 'x' });
  });

  it('writes the mcp shape to opencode.json for opencode-cli (no existing file)', () => {
    mockLstatSync.mockImplementation(() => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });
    mockExistsSync.mockReturnValue(false);
    const target = writeProviderMcpConfig('opencode-cli', '/agent', SOCKET, PROXY);
    expect(target).toBe(join('/agent', 'opencode.json'));
    const parsed = JSON.parse(mockWritePrivate.mock.calls[0][1]);
    expect(Object.keys(parsed)).toEqual(['mcp', 'agent']);
    expect(parsed.mcp.whatsoup.environment).toEqual({ WHATSOUP_SOCKET: SOCKET });
    expect(parsed.agent['whatsoup-headless']).toMatchObject({ mode: 'primary' });
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it('merges into a pre-existing opencode.json when one is found', () => {
    mockLstatSync.mockReturnValue({ isSymbolicLink: () => false });
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ model: 'keep/me', mcp: { keep: { type: 'local', command: ['k'] } } }));
    const target = writeProviderMcpConfig('opencode-cli', '/agent', SOCKET, PROXY);
    expect(target).toBe(join('/agent', 'opencode.json'));
    const parsed = JSON.parse(mockWritePrivate.mock.calls[0][1]);
    expect(parsed.model).toBe('keep/me');
    expect((parsed.mcp as Record<string, unknown>).keep).toEqual({ type: 'local', command: ['k'] });
    expect((parsed.mcp as Record<string, Record<string, unknown>>).whatsoup.environment).toEqual({ WHATSOUP_SOCKET: SOCKET });
  });

  it('falls back to a fresh base when the pre-existing opencode.json is corrupt JSON', () => {
    mockLstatSync.mockReturnValue({ isSymbolicLink: () => false });
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('{ this is not valid json');
    const target = writeProviderMcpConfig('opencode-cli', '/agent', SOCKET, PROXY);
    expect(target).toBe(join('/agent', 'opencode.json'));
    const parsed = JSON.parse(mockWritePrivate.mock.calls[0][1]);
    expect(parsed.mcp).toHaveProperty('whatsoup');
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.objectContaining({ target: join('/agent', 'opencode.json') }),
      'failed to parse existing opencode.json before MCP config write; overwriting managed entries',
    );
  });

  it('falls back to a fresh base when the pre-existing opencode.json is a non-object value', () => {
    mockLstatSync.mockReturnValue({ isSymbolicLink: () => false });
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('"a string"');
    const target = writeProviderMcpConfig('opencode-cli', '/agent', SOCKET, PROXY);
    expect(target).toBe(join('/agent', 'opencode.json'));
    const parsed = JSON.parse(mockWritePrivate.mock.calls[0][1]);
    expect(parsed.mcp).toHaveProperty('whatsoup');
  });

  it('falls back to a fresh base when the pre-existing opencode.json is an array', () => {
    mockLstatSync.mockReturnValue({ isSymbolicLink: () => false });
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('[1,2,3]');
    const target = writeProviderMcpConfig('opencode-cli', '/agent', SOCKET, PROXY);
    expect(target).toBe(join('/agent', 'opencode.json'));
    const parsed = JSON.parse(mockWritePrivate.mock.calls[0][1]);
    expect(parsed.mcp).toHaveProperty('whatsoup');
  });

  it('skips the write and returns null when opencode.json is a symlink (lstat path)', () => {
    mockLstatSync.mockReturnValue({ isSymbolicLink: () => true });
    const target = writeProviderMcpConfig('opencode-cli', '/agent', SOCKET, PROXY);
    expect(target).toBeNull();
    expect(mockWritePrivate).not.toHaveBeenCalled();
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.objectContaining({ target: join('/agent', 'opencode.json') }),
      'skipping opencode MCP config write because opencode.json is a symlink',
    );
  });

  it('skips the write and returns null when lstat fails with ELOOP', () => {
    mockLstatSync.mockImplementation(() => {
      throw Object.assign(new Error('too many symlinks'), { code: 'ELOOP' });
    });
    const target = writeProviderMcpConfig('opencode-cli', '/agent', SOCKET, PROXY);
    expect(target).toBeNull();
    expect(mockWritePrivate).not.toHaveBeenCalled();
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.objectContaining({ target: join('/agent', 'opencode.json') }),
      'skipping opencode MCP config write after file stat failed',
    );
  });

  it('rethrows when lstat fails with a non-ENOENT, non-ELOOP errno', () => {
    mockLstatSync.mockImplementation(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });
    expect(() => writeProviderMcpConfig('opencode-cli', '/agent', SOCKET, PROXY))
      .toThrow(/permission denied/);
  });

  it('skips the write and returns null when writePrivateFileSync throws ELOOP', () => {
    mockLstatSync.mockReturnValue({ isSymbolicLink: () => false });
    mockExistsSync.mockReturnValue(false);
    mockWritePrivate.mockImplementation(() => {
      throw Object.assign(new Error('ELOOP after write'), { code: 'ELOOP' });
    });
    const target = writeProviderMcpConfig('opencode-cli', '/agent', SOCKET, PROXY);
    expect(target).toBeNull();
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.objectContaining({ target: join('/agent', 'opencode.json') }),
      'skipping opencode MCP config write because opencode.json is a symlink',
    );
  });

  it('rethrows non-ELOOP errors from writePrivateFileSync', () => {
    mockLstatSync.mockReturnValue({ isSymbolicLink: () => false });
    mockExistsSync.mockReturnValue(false);
    mockWritePrivate.mockImplementation(() => {
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    });
    expect(() => writeProviderMcpConfig('opencode-cli', '/agent', SOCKET, PROXY))
      .toThrow(/disk full/);
  });

  it('writes a provider block to opencode.json when providerConfig.baseUrl is set', () => {
    mockLstatSync.mockImplementation(() => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });
    mockExistsSync.mockReturnValue(false);
    writeProviderMcpConfig('opencode-cli', '/agent', SOCKET, PROXY, {
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
    });
    const parsed = JSON.parse(mockWritePrivate.mock.calls[0][1]);
    expect(Object.keys(parsed)).toEqual(['mcp', 'agent', 'provider', 'model']);
    expect(parsed.model).toBe('whatsoup-cloud/m');
    const provider = parsed.provider as Record<string, Record<string, Record<string, unknown>>>;
    expect(provider['whatsoup-cloud'].options.baseURL).toBe('https://api.example.com/v1');
  });
});
