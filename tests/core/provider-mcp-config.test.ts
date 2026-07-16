import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Hoisted mocks for `node:fs`. `writeProviderMcpConfig` descriptor-pins an
// existing OpenCode config before parsing it, and calls `writePrivateFileSync`
// for the actual write. Mock both boundaries to keep these tests hermetic.
// ---------------------------------------------------------------------------
const {
  mockOpenSync,
  mockFstatSync,
  mockReadSync,
  mockCloseSync,
  mockWritePrivate,
} = vi.hoisted(() => ({
  mockOpenSync: vi.fn(),
  mockFstatSync: vi.fn(),
  mockReadSync: vi.fn(),
  mockCloseSync: vi.fn(),
  mockWritePrivate: vi.fn(),
}));

vi.mock('../../src/lib/private-fs.ts', () => ({
  writePrivateFileSync: mockWritePrivate,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: mockOpenSync,
    fstatSync: mockFstatSync,
    readSync: mockReadSync,
    closeSync: mockCloseSync,
  };
});

import {
  generateMcpConfigFile,
  mergeOpencodeConfig,
  writeProviderMcpConfig,
  writeProviderMcpConfigTarget,
} from '../../src/core/provider-mcp-config.ts';

const SOCKET = '/tmp/whatsoup-test.sock';
const PROXY = '/opt/whatsoup/deploy/mcp/whatsoup-proxy.ts';

function generated(): Record<string, unknown> {
  return generateMcpConfigFile('opencode-cli', SOCKET, PROXY) as Record<string, unknown>;
}

beforeEach(() => {
  mockOpenSync.mockReset();
  mockFstatSync.mockReset();
  mockReadSync.mockReset();
  mockCloseSync.mockReset();
  mockWritePrivate.mockReset();
  mockOpenSync.mockImplementation(() => {
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  });
  // Default: writePrivateFileSync succeeds (covers the happy path).
  mockWritePrivate.mockImplementation(() => undefined);
});

function mockExistingOpenCodeConfig(content: string): void {
  const bytes = Buffer.from(content, 'utf8');
  mockOpenSync.mockReturnValue(42);
  mockFstatSync.mockReturnValue({
    isFile: () => true,
    size: bytes.length,
  });
  mockReadSync.mockImplementation((
    _fd: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => {
    if (position >= bytes.length) return 0;
    const count = Math.min(length, bytes.length - position);
    bytes.copy(buffer, offset, position, position + count);
    return count;
  });
}

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
  it('seeds only mcp.whatsoup and never synthesizes an inline agent policy', () => {
    const merged = mergeOpencodeConfig(null, generated());
    expect(Object.keys(merged)).toEqual(['mcp']);
    expect(merged.mcp).toHaveProperty('whatsoup');
    expect(merged).not.toHaveProperty('agent');
  });

  it('preserves sibling agents and global permissions while removing the reserved inline profile', () => {
    const userAgent = {
      description: 'user-owned',
      mode: 'subagent',
      permission: { '*': 'ask' },
    };
    const fleetAgent = {
      description: 'fleet-owned',
      mode: 'primary',
      permission: { edit: 'deny', bash: 'allow' },
    };
    const globalPermission = { '*': 'deny', read: 'allow' };
    const merged = mergeOpencodeConfig({
      permission: globalPermission,
      agent: {
        personal: userAgent,
        'whatsoup-headless': fleetAgent,
      },
    }, generated());

    expect(merged.permission).toEqual(globalPermission);
    const agents = merged.agent as Record<string, Record<string, unknown>>;
    expect(agents.personal).toEqual(userAgent);
    expect(agents).not.toHaveProperty('whatsoup-headless');
  });

  it('removes an empty agent map after migrating the reserved inline profile', () => {
    const merged = mergeOpencodeConfig({
      agent: {
        'whatsoup-headless': { mode: 'primary' },
      },
    }, generated());

    expect(merged).not.toHaveProperty('agent');
  });

  it.each(['broken', [], null])('preserves unrelated agent value %j without normalizing it', (agent) => {
    const merged = mergeOpencodeConfig({ agent: agent as never }, generated());
    expect(merged.agent).toEqual(agent);
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
// `node:fs` so we can drive every code path including descriptor type checks,
// corrupt pre-existing JSON, and write failures. The tests assert against the
// return value (target path or null) and the args passed to the private writer.
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
    const target = writeProviderMcpConfig('opencode-cli', '/agent', SOCKET, PROXY);
    expect(target).toBe(join('/agent', 'opencode.json'));
    const parsed = JSON.parse(mockWritePrivate.mock.calls[0][1]);
    expect(Object.keys(parsed)).toEqual(['mcp']);
    expect(parsed.mcp.whatsoup.environment).toEqual({ WHATSOUP_SOCKET: SOCKET });
    expect(parsed).not.toHaveProperty('agent');
  });

  it('merges into a pre-existing opencode.json when one is found', () => {
    mockExistingOpenCodeConfig(JSON.stringify({ model: 'keep/me', mcp: { keep: { type: 'local', command: ['k'] } } }));
    const target = writeProviderMcpConfig('opencode-cli', '/agent', SOCKET, PROXY);
    expect(target).toBe(join('/agent', 'opencode.json'));
    const parsed = JSON.parse(mockWritePrivate.mock.calls[0][1]);
    expect(parsed.model).toBe('keep/me');
    expect((parsed.mcp as Record<string, unknown>).keep).toEqual({ type: 'local', command: ['k'] });
    expect((parsed.mcp as Record<string, Record<string, unknown>>).whatsoup.environment).toEqual({ WHATSOUP_SOCKET: SOCKET });
  });

  it('fails closed without overwriting when the pre-existing opencode.json is corrupt JSON', () => {
    mockExistingOpenCodeConfig('{ this is not valid json');
    expect(() => writeProviderMcpConfig('opencode-cli', '/agent', SOCKET, PROXY))
      .toThrow('Existing OpenCode configuration must be a valid JSON object');
    expect(mockWritePrivate).not.toHaveBeenCalled();
  });

  it('fails closed without overwriting when the pre-existing opencode.json is a non-object value', () => {
    mockExistingOpenCodeConfig('"a string"');
    expect(() => writeProviderMcpConfig('opencode-cli', '/agent', SOCKET, PROXY))
      .toThrow('Existing OpenCode configuration must be a valid JSON object');
    expect(mockWritePrivate).not.toHaveBeenCalled();
  });

  it('fails closed without overwriting when the pre-existing opencode.json is an array', () => {
    mockExistingOpenCodeConfig('[1,2,3]');
    expect(() => writeProviderMcpConfig('opencode-cli', '/agent', SOCKET, PROXY))
      .toThrow('Existing OpenCode configuration must be a valid JSON object');
    expect(mockWritePrivate).not.toHaveBeenCalled();
  });

  it('fails closed when the descriptor open reports a symlink', () => {
    mockOpenSync.mockImplementation(() => {
      throw Object.assign(new Error('path detail must not escape'), { code: 'ELOOP' });
    });
    let thrown: NodeJS.ErrnoException | undefined;
    try {
      writeProviderMcpConfig('opencode-cli', '/agent', SOCKET, PROXY);
    } catch (err) {
      thrown = err as NodeJS.ErrnoException;
    }

    expect(thrown?.message).toBe('OpenCode configuration must be a regular non-symlink file');
    expect(thrown?.message).not.toContain('/agent');
    expect(thrown?.code).toBe('ELOOP');
    expect(mockWritePrivate).not.toHaveBeenCalled();
  });

  it('fails closed on a non-regular descriptor without attempting a read or write', () => {
    mockOpenSync.mockReturnValue(42);
    mockFstatSync.mockReturnValue({ isFile: () => false, size: 0 });
    expect(() => writeProviderMcpConfig('opencode-cli', '/agent', SOCKET, PROXY))
      .toThrow('OpenCode configuration must be a regular non-symlink file');
    expect(mockReadSync).not.toHaveBeenCalled();
    expect(mockWritePrivate).not.toHaveBeenCalled();
    expect(mockCloseSync).toHaveBeenCalledWith(42);
  });

  it('normalizes descriptor read failures without leaking paths or parser content', () => {
    mockExistingOpenCodeConfig('{"safe":true}');
    mockReadSync.mockImplementation(() => {
      throw Object.assign(new Error("EACCES: '/private/fixture/opencode.json' marker-value"), { code: 'EACCES' });
    });
    let thrown: NodeJS.ErrnoException | undefined;
    try {
      writeProviderMcpConfig('opencode-cli', '/agent', SOCKET, PROXY);
    } catch (err) {
      thrown = err as NodeJS.ErrnoException;
    }
    expect(thrown?.message).toBe('Unable to safely read existing OpenCode configuration');
    expect(thrown?.message).not.toContain('/private/fixture');
    expect(thrown?.message).not.toContain('marker-value');
    expect(thrown?.code).toBe('EACCES');
    expect(mockWritePrivate).not.toHaveBeenCalled();
  });

  it('fails closed when writePrivateFileSync throws ELOOP', () => {
    mockWritePrivate.mockImplementation(() => {
      throw Object.assign(new Error('ELOOP after write'), { code: 'ELOOP' });
    });
    expect(() => writeProviderMcpConfig('opencode-cli', '/agent', SOCKET, PROXY))
      .toThrow(/OpenCode configuration.*non-symlink/i);
  });

  it('normalizes non-ELOOP write errors without leaking paths', () => {
    mockWritePrivate.mockImplementation(() => {
      throw Object.assign(new Error("ENOSPC: '/private/fixture/opencode.json'"), { code: 'ENOSPC' });
    });
    let thrown: NodeJS.ErrnoException | undefined;
    try {
      writeProviderMcpConfig('opencode-cli', '/agent', SOCKET, PROXY);
    } catch (err) {
      thrown = err as NodeJS.ErrnoException;
    }
    expect(thrown?.message).toBe('Unable to safely write OpenCode configuration');
    expect(thrown?.message).not.toContain('/private/fixture');
    expect(thrown?.code).toBe('ENOSPC');
  });

  it('writes a provider block to opencode.json when providerConfig.baseUrl is set', () => {
    writeProviderMcpConfig('opencode-cli', '/agent', SOCKET, PROXY, {
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
    });
    const parsed = JSON.parse(mockWritePrivate.mock.calls[0][1]);
    expect(Object.keys(parsed)).toEqual(['mcp', 'provider', 'model']);
    expect(parsed.model).toBe('whatsoup-cloud/m');
    const provider = parsed.provider as Record<string, Record<string, Record<string, unknown>>>;
    expect(provider['whatsoup-cloud'].options.baseURL).toBe('https://api.example.com/v1');
  });
});
