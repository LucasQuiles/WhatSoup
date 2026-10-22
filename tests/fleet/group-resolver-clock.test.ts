/**
 * #2200 (src/fleet slice): the group-name resolver judges its retry window
 * with an injected Clock, not the raw wall clock.
 *
 * The fake clock sits months away from the real one. An attempt recorded one
 * second before the fake "now" is fresh by the injected clock and stale by the
 * wall clock, so a resolver that still reads the wall clock retries at once.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscoveredInstance } from '../../src/fleet/discovery.ts';
import { fakeClock } from '../../src/lib/clock.ts';

const mocks = vi.hoisted(() => {
  const run = vi.fn();
  const close = vi.fn();
  const prepare = vi.fn(() => ({ run }));
  const database = { prepare, close };
  return {
    existsSync: vi.fn(),
    mcpCall: vi.fn(),
    proxyToInstance: vi.fn(),
    DatabaseSync: vi.fn(function DatabaseSync() {
      return database;
    }),
  };
});

vi.mock('node:fs', async (importOriginal: () => Promise<typeof import('node:fs')>) => ({
  ...await importOriginal(),
  existsSync: mocks.existsSync,
}));
vi.mock('node:sqlite', () => ({ DatabaseSync: mocks.DatabaseSync }));
vi.mock('../../src/fleet/mcp-client.ts', () => ({ mcpCall: mocks.mcpCall }));
vi.mock('../../src/fleet/http-proxy.ts', () => ({ proxyToInstance: mocks.proxyToInstance }));
vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn() }),
}));

import * as groupResolver from '../../src/fleet/group-resolver.ts';

const FAKE_NOW_MS = Date.parse('2026-07-10T14:00:00.000Z');
/** RETRY_MS in group-resolver.ts. */
const RETRY_MS = 5 * 60 * 1000;
const GROUP_KEY = '1203630_at_g.us';

const INSTANCE: DiscoveredInstance = {
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

async function flushBackfill(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('#2200 group resolver reads time through its injected clock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.existsSync.mockReturnValue(true);
    mocks.mcpCall.mockResolvedValue({
      success: true,
      toolError: false,
      result: { content: [{ type: 'text', text: JSON.stringify({ subject: 'Ops Room', size: 3 }) }] },
    });
    groupResolver.__resetAttemptedCacheForTests();
  });

  it('skips a group attempted inside the retry window of the injected clock, and retries once it passes', async () => {
    const clock = fakeClock(FAKE_NOW_MS);
    groupResolver.__setAttemptedCacheEntryForTests(`${INSTANCE.name}:${GROUP_KEY}`, FAKE_NOW_MS - 1_000);

    groupResolver.resolveGroupNames(INSTANCE, [GROUP_KEY], clock);
    await flushBackfill();
    expect(mocks.mcpCall).not.toHaveBeenCalled();

    clock.advance(RETRY_MS);
    groupResolver.resolveGroupNames(INSTANCE, [GROUP_KEY], clock);
    await flushBackfill();
    expect(mocks.mcpCall).toHaveBeenCalledTimes(1);
  });
});
