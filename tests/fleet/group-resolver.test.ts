import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscoveredInstance } from '../../src/fleet/discovery.ts';
import { SQLITE_BUSY_TIMEOUT_PRAGMA } from '../../src/lib/sqlite-constants.ts';

const mocks = vi.hoisted(() => {
  const run = vi.fn();
  const close = vi.fn();
  const prepare = vi.fn(() => ({ run }));
  const database = { prepare, close };

  return {
    existsSync: vi.fn(),
    mcpCall: vi.fn(),
    proxyToInstance: vi.fn(),
    conversationKeyToJid: vi.fn((key: string) => key.replace('_at_g.us', '@g.us')),
    DatabaseSync: vi.fn(function DatabaseSync() {
      return database;
    }),
    prepare,
    run,
    close,
    warn: vi.fn(),
    info: vi.fn(),
  };
});

vi.mock('node:fs', async (importOriginal: () => Promise<typeof import('node:fs')>) => ({
  ...await importOriginal(),
  existsSync: mocks.existsSync,
}));

vi.mock('node:sqlite', () => ({
  DatabaseSync: mocks.DatabaseSync,
}));

vi.mock('../../src/fleet/mcp-client.ts', () => ({
  mcpCall: mocks.mcpCall,
}));

vi.mock('../../src/fleet/http-proxy.ts', () => ({
  proxyToInstance: mocks.proxyToInstance,
}));

vi.mock('../../src/core/conversation-key.ts', async (importOriginal: () => Promise<typeof import('../../src/core/conversation-key.ts')>) => ({
  ...await importOriginal(),
  conversationKeyToJid: mocks.conversationKeyToJid,
}));

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({
    warn: mocks.warn,
    info: mocks.info,
  }),
}));

import * as groupResolverModule from '../../src/fleet/group-resolver.ts';

const BASE_INSTANCE: DiscoveredInstance = {
  name: 'q',
  type: 'agent',
  accessMode: 'self_only',
  healthPort: 4111,
  dbPath: '/tmp/q/bot.db',
  stateRoot: '/tmp/q/state',
  logDir: '/tmp/q/logs',
  healthToken: 'health-token',
  configPath: '/tmp/q/config.json',
  socketPath: '/tmp/q/whatsoup.sock',
};

function mcpMetadata(subject: string, size?: number) {
  return {
    success: true,
    toolError: false,
    result: {
      content: [
        { type: 'text', text: JSON.stringify({ subject, size }) },
      ],
    },
  };
}

async function flushBackfill(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('group resolver attemptedCache eviction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.conversationKeyToJid.mockImplementation((key: string) => key.replace('_at_g.us', '@g.us'));
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    (groupResolverModule as any).__resetAttemptedCacheForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prunes expired attemptedCache entries while retaining unexpired ones', () => {
    const groupResolverAny = groupResolverModule as any;
    const now = (10 * 60 * 1000) + (5 * 60 * 1000);

    groupResolverAny.__setAttemptedCacheEntryForTests('stale', 0);
    groupResolverAny.__setAttemptedCacheEntryForTests('fresh', now - (5 * 60 * 1000) + 1);

    groupResolverAny.__pruneAttemptedCacheForTests(now);

    expect(groupResolverAny.__getAttemptedCacheKeysForTests()).toEqual(['fresh']);
  });

  it('does not attempt backfill when there are no group keys', async () => {
    groupResolverModule.resolveGroupNames(BASE_INSTANCE, []);

    await flushBackfill();

    expect(mocks.mcpCall).not.toHaveBeenCalled();
    expect(mocks.proxyToInstance).not.toHaveBeenCalled();
    expect(mocks.DatabaseSync).not.toHaveBeenCalled();
  });

  it('resolves missing group metadata through an available MCP socket', async () => {
    mocks.existsSync.mockReturnValue(true);
    mocks.mcpCall.mockResolvedValueOnce(mcpMetadata('Ops Room', 7));

    groupResolverModule.resolveGroupNames(BASE_INSTANCE, ['1203630_at_g.us']);

    await flushBackfill();

    expect(mocks.mcpCall).toHaveBeenCalledWith(
      '/tmp/q/whatsoup.sock',
      'get_group_metadata',
      { jid: '1203630@g.us' },
      8000,
    );
    expect(mocks.proxyToInstance).not.toHaveBeenCalled();
    expect(mocks.DatabaseSync).toHaveBeenCalledWith('/tmp/q/bot.db', { open: true });
    // Concurrent-writer safety: backfill must set busy_timeout before writing the live bot.db.
    expect(mocks.prepare).toHaveBeenCalledWith(SQLITE_BUSY_TIMEOUT_PRAGMA);
    expect(mocks.run).toHaveBeenCalledWith('1203630@g.us', 'Ops Room', 7);
    expect(mocks.close).toHaveBeenCalled();
    expect(mocks.info).toHaveBeenCalledWith(
      { instance: 'q', resolved: 1, total: 1 },
      'backfilled group names',
    );
  });

  it('falls back to HTTP metadata when MCP content is unavailable', async () => {
    mocks.existsSync.mockReturnValue(true);
    mocks.mcpCall.mockResolvedValueOnce({ success: true, toolError: true, result: {} });
    mocks.proxyToInstance.mockResolvedValueOnce({
      status: 200,
      body: JSON.stringify({ subject: 'HTTP Room' }),
    });

    groupResolverModule.resolveGroupNames(BASE_INSTANCE, ['1203631_at_g.us']);

    await flushBackfill();

    expect(mocks.proxyToInstance).toHaveBeenCalledWith(
      4111,
      '/group-metadata',
      'POST',
      JSON.stringify({ groupJid: '1203631@g.us' }),
      'health-token',
    );
    expect(mocks.run).toHaveBeenCalledWith('1203631@g.us', 'HTTP Room', 0);
  });

  it('falls back to HTTP metadata when MCP content has no text item', async () => {
    mocks.existsSync.mockReturnValue(true);
    mocks.mcpCall.mockResolvedValueOnce({
      success: true,
      toolError: false,
      result: { content: [{ type: 'image', text: 'ignored' }] },
    });
    mocks.proxyToInstance.mockResolvedValueOnce({
      status: 200,
      body: JSON.stringify({ subject: 'Textless MCP' }),
    });

    groupResolverModule.resolveGroupNames(BASE_INSTANCE, ['1203640_at_g.us']);

    await flushBackfill();

    expect(mocks.proxyToInstance).toHaveBeenCalled();
    expect(mocks.run).toHaveBeenCalledWith('1203640@g.us', 'Textless MCP', 0);
  });

  it('falls back to HTTP metadata when MCP text is not valid JSON', async () => {
    mocks.existsSync.mockReturnValue(true);
    mocks.mcpCall.mockResolvedValueOnce({
      success: true,
      toolError: false,
      result: { content: [{ type: 'text', text: '{not-json' }] },
    });
    mocks.proxyToInstance.mockResolvedValueOnce({
      status: 200,
      body: JSON.stringify({ subject: 'Parsed Via HTTP', size: 6 }),
    });

    groupResolverModule.resolveGroupNames(BASE_INSTANCE, ['1203641_at_g.us']);

    await flushBackfill();

    expect(mocks.proxyToInstance).toHaveBeenCalled();
    expect(mocks.run).toHaveBeenCalledWith('1203641@g.us', 'Parsed Via HTTP', 6);
  });

  it('skips database writes when HTTP metadata has no subject', async () => {
    mocks.existsSync.mockReturnValue(false);
    mocks.proxyToInstance.mockResolvedValueOnce({
      status: 200,
      body: JSON.stringify({ size: 3 }),
    });

    groupResolverModule.resolveGroupNames(BASE_INSTANCE, ['1203632_at_g.us']);

    await flushBackfill();

    expect(mocks.DatabaseSync).not.toHaveBeenCalled();
    expect(mocks.info).not.toHaveBeenCalled();
  });

  it('skips writes when MCP returns no text metadata and HTTP is unavailable', async () => {
    mocks.existsSync.mockReturnValue(true);
    mocks.mcpCall.mockResolvedValueOnce({
      success: true,
      toolError: false,
      result: { content: { type: 'text', text: JSON.stringify({ subject: 'ignored' }) } },
    });

    groupResolverModule.resolveGroupNames(
      { ...BASE_INSTANCE, healthPort: 0 },
      ['1203635_at_g.us'],
    );

    await flushBackfill();

    expect(mocks.proxyToInstance).not.toHaveBeenCalled();
    expect(mocks.DatabaseSync).not.toHaveBeenCalled();
    expect(mocks.info).not.toHaveBeenCalled();
  });

  it('skips writes when the HTTP metadata endpoint fails', async () => {
    mocks.proxyToInstance.mockResolvedValueOnce({
      status: 503,
      body: JSON.stringify({ error: 'not ready' }),
    });

    groupResolverModule.resolveGroupNames(
      { ...BASE_INSTANCE, socketPath: null },
      ['1203636_at_g.us'],
    );

    await flushBackfill();

    expect(mocks.DatabaseSync).not.toHaveBeenCalled();
    expect(mocks.info).not.toHaveBeenCalled();
  });

  it('suppresses repeated attempts within the retry window', async () => {
    mocks.existsSync.mockReturnValue(true);
    mocks.mcpCall.mockResolvedValue(mcpMetadata('Ops Room', 7));

    groupResolverModule.resolveGroupNames(BASE_INSTANCE, ['1203633_at_g.us']);
    await flushBackfill();
    mocks.mcpCall.mockClear();

    groupResolverModule.resolveGroupNames(BASE_INSTANCE, ['1203633_at_g.us']);
    await flushBackfill();

    expect(mocks.mcpCall).not.toHaveBeenCalled();
  });

  it('records attempts for distinct keys across batches when no resolution channel is available', async () => {
    mocks.existsSync.mockReturnValue(false);
    const offline = { ...BASE_INSTANCE, healthPort: 0 };

    groupResolverModule.resolveGroupNames(offline, ['1203650_at_g.us']);
    await flushBackfill();
    groupResolverModule.resolveGroupNames(offline, ['1203651_at_g.us']);
    await flushBackfill();

    expect((groupResolverModule as any).__getAttemptedCacheKeysForTests()).toEqual([
      'q:1203650_at_g.us',
      'q:1203651_at_g.us',
    ]);
    expect(mocks.mcpCall).not.toHaveBeenCalled();
    expect(mocks.proxyToInstance).not.toHaveBeenCalled();
  });

  it('logs and closes the database when storing resolved metadata fails', async () => {
    const writeError = new Error('database is locked');
    mocks.existsSync.mockReturnValue(true);
    mocks.mcpCall.mockResolvedValueOnce(mcpMetadata('Ops Room', 7));
    mocks.run.mockImplementationOnce(() => {
      throw writeError;
    });

    groupResolverModule.resolveGroupNames(BASE_INSTANCE, ['1203634_at_g.us']);

    await flushBackfill();

    expect(mocks.close).toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledWith(
      { jid: '1203634@g.us', err: 'database is locked' },
      'failed to store group metadata',
    );
    expect(mocks.info).not.toHaveBeenCalled();
  });

  it('logs fire-and-forget backfill failures with the instance name', async () => {
    mocks.conversationKeyToJid.mockImplementationOnce(() => {
      throw new Error('bad conversation key');
    });

    groupResolverModule.resolveGroupNames(BASE_INSTANCE, ['not-a-group']);

    await flushBackfill();

    expect(mocks.warn).toHaveBeenCalledWith(
      { instance: 'q', err: 'bad conversation key' },
      'group backfill failed',
    );
  });
});
