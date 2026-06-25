import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FleetRealtimeEventPoller } from '../../src/fleet/realtime-event-poller.ts';
import type { FleetRealtimePublisher } from '../../src/fleet/realtime-publisher.ts';

// Mock proxyToInstance (no typing polling in these tests)
vi.mock('../../src/fleet/http-proxy.ts', () => ({
  proxyToInstance: vi.fn().mockResolvedValue({ status: 200, body: '{"composing":[]}' }),
}));

// Mock findLatestLogFile — now returns { path, mtimeMs } | null
vi.mock('../../src/fleet/log-utils.ts', () => ({
  findLatestLogFile: vi.fn(),
}));

import { findLatestLogFile } from '../../src/fleet/log-utils.ts';

const mockFindLatestLogFile = vi.mocked(findLatestLogFile);

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

    const discovery = makeDiscovery({
      test: { name: 'test', dbPath: '/tmp/test.db', logDir, healthPort: 0 },
    });
    const dbReader = makeDbReader({ latestMessagePk: 1, latestAccessMarker: 'a' });
    const poller = new FleetRealtimeEventPoller({ discovery, dbReader, realtime: publisher });

    // First poll — establishes baseline, no events yet
    mockFindLatestLogFile.mockReturnValueOnce({ path: logFile, mtimeMs: 1000 });
    await poller.poll();
    publisher.calls.length = 0;

    // Second poll — mtime advanced
    mockFindLatestLogFile.mockReturnValueOnce({ path: logFile, mtimeMs: 2000 });
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

    mockFindLatestLogFile.mockReturnValue({ path: logFile, mtimeMs: 1000 });

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

  it('emits log_entry when pino-roll rotates to a new file with an identical mtime (#1086)', async () => {
    // pino-roll rotation creates a NEW numbered file. When the new file lands on
    // the same mtimeMs as the prior one (coarse FS granularity, or rotation +
    // first write within one mtime tick), an mtime-only predicate misses the
    // rotation entirely and the dashboard goes stale. The active log PATH
    // changing is itself a change worth emitting.
    const logDir = '/tmp/test-logs';

    const discovery = makeDiscovery({
      test: { name: 'test', dbPath: '/tmp/test.db', logDir, healthPort: 0 },
    });
    const dbReader = makeDbReader({ latestMessagePk: 1, latestAccessMarker: 'a' });
    const poller = new FleetRealtimeEventPoller({ discovery, dbReader, realtime: publisher });

    // First poll — baseline on the pre-rotation file.
    mockFindLatestLogFile.mockReturnValueOnce({ path: `${logDir}/app.log.1`, mtimeMs: 1000 });
    await poller.poll();
    publisher.calls.length = 0;

    // Second poll — rotated to a NEW file but with the SAME mtimeMs.
    mockFindLatestLogFile.mockReturnValueOnce({ path: `${logDir}/app.log.2`, mtimeMs: 1000 });
    await poller.poll();

    const types = publisher.calls.map((e: any) => e.type);
    expect(types).toContain('log_entry');
    expect(types).toContain('feed_event');

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

    mockFindLatestLogFile.mockReturnValue({ path: logFile, mtimeMs: 5000 });

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

  it('handles log file disappearing between polls gracefully', async () => {
    const logDir = '/tmp/test-logs';
    const logFile = `${logDir}/app.log`;

    const discovery = makeDiscovery({
      test: { name: 'test', dbPath: '/tmp/test.db', logDir, healthPort: 0 },
    });
    const dbReader = makeDbReader({ latestMessagePk: 1, latestAccessMarker: 'a' });
    const poller = new FleetRealtimeEventPoller({ discovery, dbReader, realtime: publisher });

    // First poll — log file exists
    mockFindLatestLogFile.mockReturnValueOnce({ path: logFile, mtimeMs: 1000 });
    await poller.poll();
    publisher.calls.length = 0;

    // Second poll — log file gone
    mockFindLatestLogFile.mockReturnValueOnce(null);
    await poller.poll();

    // Should not emit log_entry (mtime is null, guard prevents it)
    const types = publisher.calls.map((e: any) => e.type);
    expect(types).not.toContain('log_entry');

    poller.stop();
  });
});
