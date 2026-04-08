import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FleetRealtimeEventPoller } from '../../src/fleet/realtime-event-poller.ts';
import type { FleetRealtimePublisher } from '../../src/fleet/realtime-publisher.ts';

// Mock proxyToInstance (no typing polling in these tests)
vi.mock('../../src/fleet/http-proxy.ts', () => ({
  proxyToInstance: vi.fn().mockResolvedValue({ status: 200, body: '{"composing":[]}' }),
}));

// Mock findLatestLogFile
vi.mock('../../src/fleet/log-utils.ts', () => ({
  findLatestLogFile: vi.fn(),
  readTailLines: vi.fn().mockReturnValue([]),
}));

// Mock statSync from node:fs
vi.mock('node:fs', () => ({
  statSync: vi.fn(),
}));

import { findLatestLogFile } from '../../src/fleet/log-utils.ts';
import { statSync } from 'node:fs';

const mockFindLatestLogFile = vi.mocked(findLatestLogFile);
const mockStatSync = vi.mocked(statSync);

function makePublisher(): FleetRealtimePublisher & { calls: any[] } {
  const calls: any[] = [];
  return {
    calls,
    publish: vi.fn((event) => calls.push(event)),
  };
}

function makeDiscovery(instances: Record<string, any> = {}) {
  const map = new Map(Object.entries(instances));
  return { getInstances: () => map } as any;
}

function makeDbReader(
  markers: { latestMessagePk: number | null; latestAccessMarker: string | null } = {
    latestMessagePk: null,
    latestAccessMarker: null,
  },
) {
  return {
    getLatestMarkers: vi.fn(() => ({ ok: true, data: { ...markers } })),
  } as any;
}

describe('FleetRealtimeEventPoller — log change detection', () => {
  let publisher: ReturnType<typeof makePublisher>;

  beforeEach(() => {
    publisher = makePublisher();
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  it('emits log_entry + feed_event when log file mtime changes between polls', async () => {
    const logDir = '/tmp/test-logs';
    const logFile = `${logDir}/app.log`;

    mockFindLatestLogFile.mockReturnValue(logFile);
    // First poll mtime
    mockStatSync.mockReturnValueOnce({ mtimeMs: 1000 } as any);

    const discovery = makeDiscovery({
      test: { name: 'test', dbPath: '/tmp/test.db', logDir, healthPort: 0 },
    });
    const dbReader = makeDbReader({ latestMessagePk: 1, latestAccessMarker: 'a' });
    const poller = new FleetRealtimeEventPoller({ discovery, dbReader, realtime: publisher });

    // First poll — establishes baseline, no events yet
    await poller.poll();
    publisher.calls.length = 0;

    // Second poll — mtime advanced
    mockStatSync.mockReturnValueOnce({ mtimeMs: 2000 } as any);
    await poller.poll();

    const types = publisher.calls.map((e: any) => e.type);
    expect(types).toContain('log_entry');
    expect(types).toContain('feed_event');

    // Verify the events are for the correct instance
    const logEntryEvent = publisher.calls.find((e: any) => e.type === 'log_entry');
    expect(logEntryEvent.instance).toBe('test');

    poller.stop();
  });

  it('does not emit log events when mtime is unchanged', async () => {
    const logDir = '/tmp/test-logs';
    const logFile = `${logDir}/app.log`;

    mockFindLatestLogFile.mockReturnValue(logFile);
    mockStatSync.mockReturnValue({ mtimeMs: 1000 } as any);

    const discovery = makeDiscovery({
      test: { name: 'test', dbPath: '/tmp/test.db', logDir, healthPort: 0 },
    });
    const dbReader = makeDbReader({ latestMessagePk: 1, latestAccessMarker: 'a' });
    const poller = new FleetRealtimeEventPoller({ discovery, dbReader, realtime: publisher });

    // First poll — baseline
    await poller.poll();
    publisher.calls.length = 0;

    // Second poll — same mtime
    await poller.poll();

    const types = publisher.calls.map((e: any) => e.type);
    expect(types).not.toContain('log_entry');
    expect(types).not.toContain('feed_event');

    poller.stop();
  });

  it('does not emit log events when no log file exists for an instance', async () => {
    const logDir = '/tmp/empty-logs';

    // No log file found
    mockFindLatestLogFile.mockReturnValue(null);

    const discovery = makeDiscovery({
      test: { name: 'test', dbPath: '/tmp/test.db', logDir, healthPort: 0 },
    });
    const dbReader = makeDbReader({ latestMessagePk: 1, latestAccessMarker: 'a' });
    const poller = new FleetRealtimeEventPoller({ discovery, dbReader, realtime: publisher });

    // First poll
    await poller.poll();
    publisher.calls.length = 0;

    // Second poll — still no log file
    await poller.poll();

    const types = publisher.calls.map((e: any) => e.type);
    expect(types).not.toContain('log_entry');

    poller.stop();
  });

  it('does not emit log events on first poll (no previous snapshot to diff against)', async () => {
    const logDir = '/tmp/test-logs';
    const logFile = `${logDir}/app.log`;

    mockFindLatestLogFile.mockReturnValue(logFile);
    mockStatSync.mockReturnValue({ mtimeMs: 5000 } as any);

    const discovery = makeDiscovery({
      test: { name: 'test', dbPath: '/tmp/test.db', logDir, healthPort: 0 },
    });
    const dbReader = makeDbReader({ latestMessagePk: 1, latestAccessMarker: 'a' });
    const poller = new FleetRealtimeEventPoller({ discovery, dbReader, realtime: publisher });

    // Only first poll
    await poller.poll();

    const types = publisher.calls.map((e: any) => e.type);
    expect(types).not.toContain('log_entry');
    expect(types).not.toContain('feed_event');

    poller.stop();
  });

  it('handles statSync throwing (race: file deleted between find and stat)', async () => {
    const logDir = '/tmp/test-logs';
    const logFile = `${logDir}/app.log`;

    mockFindLatestLogFile.mockReturnValue(logFile);
    // First poll succeeds
    mockStatSync.mockReturnValueOnce({ mtimeMs: 1000 } as any);

    const discovery = makeDiscovery({
      test: { name: 'test', dbPath: '/tmp/test.db', logDir, healthPort: 0 },
    });
    const dbReader = makeDbReader({ latestMessagePk: 1, latestAccessMarker: 'a' });
    const poller = new FleetRealtimeEventPoller({ discovery, dbReader, realtime: publisher });

    await poller.poll();
    publisher.calls.length = 0;

    // Second poll: statSync throws (file deleted between find and stat)
    mockStatSync.mockImplementationOnce(() => { throw new Error('ENOENT'); });
    await poller.poll();

    // Should not throw, should not emit log_entry (mtime stays null)
    const types = publisher.calls.map((e: any) => e.type);
    expect(types).not.toContain('log_entry');

    poller.stop();
  });
});
