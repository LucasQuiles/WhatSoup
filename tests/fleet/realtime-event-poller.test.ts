import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FleetRealtimeEventPoller } from '../../src/fleet/realtime-event-poller.ts';
import type { FleetRealtimePublisher } from '../../src/fleet/realtime-publisher.ts';
import { proxyToInstance } from '../../src/fleet/http-proxy.ts';

// Mock proxyToInstance
vi.mock('../../src/fleet/http-proxy.ts', () => ({
  proxyToInstance: vi.fn().mockResolvedValue({ status: 200, body: '{"composing":[]}' }),
}));

const mockProxyToInstance = vi.mocked(proxyToInstance);

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

function makeDbReader(markers: { latestMessagePk: number | null; latestMessageMarker?: string | null; latestAccessMarker: string | null } = { latestMessagePk: null, latestMessageMarker: null, latestAccessMarker: null }) {
  return {
    getLatestMarkers: vi.fn(() => ({ ok: true, data: { ...markers } })),
  } as any;
}

describe('FleetRealtimeEventPoller', () => {
  let publisher: ReturnType<typeof makePublisher>;

  beforeEach(() => {
    publisher = makePublisher();
    vi.useFakeTimers();
    mockProxyToInstance.mockReset();
    mockProxyToInstance.mockResolvedValue({ status: 200, body: '{"composing":[]}' });
  });

  it('does not broadcast on identical snapshots', async () => {
    const discovery = makeDiscovery({ test: { name: 'test', dbPath: '/tmp/test.db', logDir: '/tmp/test-logs', healthPort: 0 } });
    const dbReader = makeDbReader({ latestMessagePk: 10, latestAccessMarker: '2026-01-01' });
    const poller = new FleetRealtimeEventPoller({ discovery, dbReader, realtime: publisher });

    // First poll — sets baseline
    await poller.poll();
    publisher.calls.length = 0;

    // Second poll — identical markers, no broadcasts
    await poller.poll();
    expect(publisher.calls.length).toBe(0);

    poller.stop();
  });

  it('broadcasts message_received + chat_updated when latest message pk changes', async () => {
    const markers = { latestMessagePk: 10, latestAccessMarker: '2026-01-01' };
    const discovery = makeDiscovery({ test: { name: 'test', dbPath: '/tmp/test.db', logDir: '/tmp/test-logs', healthPort: 0 } });
    const dbReader = makeDbReader(markers);
    const poller = new FleetRealtimeEventPoller({ discovery, dbReader, realtime: publisher });

    // Baseline
    await poller.poll();
    publisher.calls.length = 0;

    // Advance message pk
    markers.latestMessagePk = 11;
    await poller.poll();

    const types = publisher.calls.map((e) => e.type);
    expect(types).toContain('message_received');
    expect(types).toContain('chat_updated');
    expect(types).toContain('feed_event');

    poller.stop();
  });

  it('broadcasts message_received + chat_updated when a message row changes without a new pk', async () => {
    const markers = { latestMessagePk: 10, latestMessageMarker: '10:2026-01-01T00:00:00.000Z', latestAccessMarker: '2026-01-01' };
    const discovery = makeDiscovery({ test: { name: 'test', dbPath: '/tmp/test.db', logDir: '/tmp/test-logs', healthPort: 0 } });
    const dbReader = makeDbReader(markers);
    const poller = new FleetRealtimeEventPoller({ discovery, dbReader, realtime: publisher });

    await poller.poll();
    publisher.calls.length = 0;

    markers.latestMessageMarker = '10:2026-01-01T00:00:02.000Z';
    await poller.poll();

    const types = publisher.calls.map((e) => e.type);
    expect(types).toContain('message_received');
    expect(types).toContain('chat_updated');
    expect(types).toContain('feed_event');

    poller.stop();
  });

  it('broadcasts access_changed when access marker changes', async () => {
    const markers = { latestMessagePk: 10, latestAccessMarker: '2026-01-01' };
    const discovery = makeDiscovery({ test: { name: 'test', dbPath: '/tmp/test.db', logDir: '/tmp/test-logs', healthPort: 0 } });
    const dbReader = makeDbReader(markers);
    const poller = new FleetRealtimeEventPoller({ discovery, dbReader, realtime: publisher });

    await poller.poll();
    publisher.calls.length = 0;

    markers.latestAccessMarker = '2026-01-02';
    await poller.poll();

    const types = publisher.calls.map((e) => e.type);
    expect(types).toContain('access_changed');
    expect(types).toContain('feed_event');

    poller.stop();
  });

  it('start/stop clears timers cleanly', () => {
    const discovery = makeDiscovery();
    const dbReader = makeDbReader();
    const poller = new FleetRealtimeEventPoller({ discovery, dbReader, realtime: publisher });

    poller.start();
    poller.stop();
    expect(() => poller.stop()).not.toThrow();
    expect(publisher.calls).toHaveLength(0);
  });

  it('does not start duplicate timers and contains rejected poll ticks', async () => {
    const discovery = makeDiscovery();
    const dbReader = makeDbReader();
    const poller = new FleetRealtimeEventPoller({ discovery, dbReader, realtime: publisher }, 100);
    const pollSpy = vi.spyOn(poller, 'poll').mockRejectedValue(new Error('tick failed'));

    try {
      poller.start();
      poller.start();
      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();

      expect(pollSpy).toHaveBeenCalledTimes(1);
      expect(publisher.calls).toHaveLength(0);
    } finally {
      poller.stop();
      pollSpy.mockRestore();
    }
  });

  it('skips a poll tick while the previous typing probe is still in flight', async () => {
    let resolveTyping!: (value: { status: number; body: string }) => void;
    mockProxyToInstance.mockImplementation(() => new Promise((resolve) => {
      resolveTyping = resolve;
    }));
    const discovery = makeDiscovery({
      test: { name: 'test', dbPath: '/tmp/test.db', logDir: '/tmp/test-logs', healthPort: 9099 },
    });
    const dbReader = makeDbReader();
    const poller = new FleetRealtimeEventPoller({ discovery, dbReader, realtime: publisher });

    const firstTick = poller.poll();
    expect(mockProxyToInstance).toHaveBeenCalledTimes(1);

    const overlappingTick = poller.poll();
    expect(mockProxyToInstance).toHaveBeenCalledTimes(1);

    resolveTyping({
      status: 200,
      body: JSON.stringify({ composing: [{ jid: 'group@g.us', since: 30 }] }),
    });
    await Promise.all([firstTick, overlappingTick]);

    expect(mockProxyToInstance).toHaveBeenCalledTimes(1);
    expect(publisher.calls).toEqual([
      expect.objectContaining({
        type: 'typing_update',
        instance: 'test',
        jid: 'group@g.us',
        composing: true,
      }),
    ]);

    poller.stop();
  });

  it('detects log rotation while the previous log file still exists', async () => {
    const logDir = mkdtempSync(join(tmpdir(), 'realtime-log-rotation-'));
    try {
      const oldLog = join(logDir, 'app.log');
      const newLog = join(logDir, 'app.1.log');
      const oldTime = new Date('2026-06-21T10:00:00.000Z');
      const newTime = new Date('2026-06-21T10:01:00.000Z');
      writeFileSync(oldLog, 'before rotation\n');
      utimesSync(oldLog, oldTime, oldTime);

      const discovery = makeDiscovery({
        test: { name: 'test', dbPath: '/tmp/test.db', logDir, healthPort: 0 },
      });
      const dbReader = makeDbReader({ latestMessagePk: 1, latestAccessMarker: 'a' });
      const poller = new FleetRealtimeEventPoller({ discovery, dbReader, realtime: publisher });

      await poller.poll();
      publisher.calls.length = 0;

      writeFileSync(newLog, 'after rotation\n');
      utimesSync(newLog, newTime, newTime);

      await poller.poll();

      const types = publisher.calls.map((event) => event.type);
      expect(types).toContain('log_entry');
      expect(types).toContain('feed_event');

      poller.stop();
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  it('prunes stale snapshots for instances removed from discovery', async () => {
    const instances = new Map(Object.entries({
      alpha: { name: 'alpha', dbPath: '/tmp/alpha.db', logDir: '/tmp/test-logs', healthPort: 0 },
      beta: { name: 'beta', dbPath: '/tmp/beta.db', logDir: '/tmp/test-logs', healthPort: 0 },
    }));
    const discovery = { getInstances: () => instances } as any;
    const dbReader = {
      getLatestMarkers: vi.fn((name: string) => ({
        ok: true,
        data: {
          latestMessagePk: name === 'alpha' ? 1 : 2,
          latestAccessMarker: `${name}-marker`,
        },
      })),
    } as any;
    const poller = new FleetRealtimeEventPoller({ discovery, dbReader, realtime: publisher });

    await poller.poll();
    expect((poller as any).snapshots.has('alpha')).toBe(true);
    expect((poller as any).snapshots.has('beta')).toBe(true);

    instances.delete('beta');
    await poller.poll();

    expect((poller as any).snapshots.has('alpha')).toBe(true);
    expect((poller as any).snapshots.has('beta')).toBe(false);
  });

  it('ignores malformed typing entries without publishing invalid updates', async () => {
    mockProxyToInstance.mockResolvedValueOnce({
      status: 200,
      body: JSON.stringify({
        composing: [
          {},
          { jid: '', since: 10 },
          { jid: 'bad-since@g.us', since: 'now' },
          { jid: 12345, since: 20 },
          { jid: 'group@g.us', since: 30 },
        ],
      }),
    });
    const discovery = makeDiscovery({
      test: { name: 'test', dbPath: '/tmp/test.db', logDir: '/tmp/test-logs', healthPort: 9099 },
    });
    const dbReader = makeDbReader();
    const poller = new FleetRealtimeEventPoller({ discovery, dbReader, realtime: publisher });

    await poller.poll();

    expect(publisher.calls).toEqual([
      expect.objectContaining({
        type: 'typing_update',
        instance: 'test',
        jid: 'group@g.us',
        composing: true,
      }),
    ]);

    poller.stop();
  });

  it('publishes typing stops for disappeared entries without re-publishing unchanged or invalid states', async () => {
    mockProxyToInstance
      .mockResolvedValueOnce({
        status: 200,
        body: JSON.stringify({ composing: [{ jid: 'group@g.us', since: 30 }] }),
      })
      .mockResolvedValueOnce({
        status: 200,
        body: JSON.stringify({ composing: [{ jid: 'group@g.us', since: 30 }] }),
      })
      .mockResolvedValueOnce({ status: 503, body: 'unavailable' })
      .mockResolvedValueOnce({ status: 200, body: JSON.stringify({ composing: { jid: 'group@g.us', since: 40 } }) });
    const discovery = makeDiscovery({
      test: { name: 'test', dbPath: '/tmp/test.db', logDir: '/tmp/test-logs', healthPort: 9099 },
    });
    const dbReader = makeDbReader();
    const poller = new FleetRealtimeEventPoller({ discovery, dbReader, realtime: publisher });

    await poller.poll();
    expect(publisher.calls).toEqual([
      expect.objectContaining({
        type: 'typing_update',
        instance: 'test',
        jid: 'group@g.us',
        composing: true,
      }),
    ]);

    publisher.calls.length = 0;
    await poller.poll();
    expect(publisher.calls).toHaveLength(0);

    // Poll 3 is a 503. Before #2137 this published `composing: false`, treating
    // failure-to-observe as observed-empty. A failed probe now says nothing.
    await poller.poll();
    expect(publisher.calls).toHaveLength(0);

    // Poll 4 answers 200 with an invalid (non-array) composing field, so the
    // instance reports nobody typing. THAT is an observation of absence, and the
    // entry carried forward across the 503 is retired here.
    publisher.calls.length = 0;
    await poller.poll();
    expect(publisher.calls).toEqual([
      expect.objectContaining({
        type: 'typing_update',
        instance: 'test',
        jid: 'group@g.us',
        composing: false,
      }),
    ]);

    poller.stop();
  });
});

// ---------------------------------------------------------------------------
// #2137 — a failed probe is not an observation of "nobody is typing"
// ---------------------------------------------------------------------------

/**
 * `proxyToInstance` turns timeouts and transport errors into `{ status: 502 }`,
 * and the production window behind this issue recorded 857 failed `/typing`
 * probes (848 of them timeouts) over ~38 hours. Each one previously emitted a
 * false `composing: false` for every active typing entry on that instance, then
 * replaced `lastTyping` with the partial map — so recovery emitted a spurious
 * `composing: true` as well.
 *
 * Each test below asserts the exact published set, not merely that something
 * was or was not published: the defect was about which edges were emitted.
 */
describe('FleetRealtimeEventPoller — #2137 failed typing probe', () => {
  let publisher: ReturnType<typeof makePublisher>;

  beforeEach(() => {
    publisher = makePublisher();
    vi.useFakeTimers();
    mockProxyToInstance.mockReset();
  });

  function typingOk(jid: string, since: number) {
    return { status: 200, body: JSON.stringify({ composing: [{ jid, since }] }) };
  }
  const typingEmpty = { status: 200, body: JSON.stringify({ composing: [] }) };

  function onePoller(publisherRef: ReturnType<typeof makePublisher>) {
    const discovery = makeDiscovery({
      test: { name: 'test', dbPath: '/tmp/test.db', logDir: '/tmp/test-logs', healthPort: 9099 },
    });
    return new FleetRealtimeEventPoller({ discovery, dbReader: makeDbReader(), realtime: publisherRef });
  }

  it('publishes NOTHING when the probe times out mid-composing', async () => {
    mockProxyToInstance
      .mockResolvedValueOnce(typingOk('group@g.us', 30))
      .mockResolvedValueOnce({ status: 502, body: 'timeout' });
    const poller = onePoller(publisher);

    await poller.poll();
    expect(publisher.calls).toHaveLength(1);

    publisher.calls.length = 0;
    await poller.poll();
    expect(publisher.calls).toHaveLength(0); // was: one false composing:false

    poller.stop();
  });

  it('does not re-publish composing:true when the probe recovers unchanged', async () => {
    mockProxyToInstance
      .mockResolvedValueOnce(typingOk('group@g.us', 30))
      .mockResolvedValueOnce({ status: 502, body: 'timeout' })
      .mockResolvedValueOnce(typingOk('group@g.us', 30));
    const poller = onePoller(publisher);

    await poller.poll();
    publisher.calls.length = 0;
    await poller.poll();
    await poller.poll();

    // The entry was carried across the failure, so recovery is a no-op. Before
    // #2137 `lastTyping` had been wiped, so this re-published composing:true.
    expect(publisher.calls).toHaveLength(0);

    poller.stop();
  });

  it('still retires the entry when the instance answers with an empty set', async () => {
    mockProxyToInstance
      .mockResolvedValueOnce(typingOk('group@g.us', 30))
      .mockResolvedValueOnce(typingEmpty);
    const poller = onePoller(publisher);

    await poller.poll();
    publisher.calls.length = 0;
    await poller.poll();

    expect(publisher.calls).toEqual([
      expect.objectContaining({ type: 'typing_update', instance: 'test', jid: 'group@g.us', composing: false }),
    ]);

    poller.stop();
  });

  it('retires the entry after a failure once the instance answers empty', async () => {
    mockProxyToInstance
      .mockResolvedValueOnce(typingOk('group@g.us', 30))
      .mockResolvedValueOnce({ status: 502, body: 'timeout' })
      .mockResolvedValueOnce(typingEmpty);
    const poller = onePoller(publisher);

    await poller.poll();
    publisher.calls.length = 0;
    await poller.poll();
    expect(publisher.calls).toHaveLength(0);
    await poller.poll();

    expect(publisher.calls).toEqual([
      expect.objectContaining({ type: 'typing_update', instance: 'test', jid: 'group@g.us', composing: false }),
    ]);

    poller.stop();
  });

  it('treats an unparseable 200 body as unobserved, not as empty', async () => {
    mockProxyToInstance
      .mockResolvedValueOnce(typingOk('group@g.us', 30))
      .mockResolvedValueOnce({ status: 200, body: 'not json at all' });
    const poller = onePoller(publisher);

    await poller.poll();
    publisher.calls.length = 0;
    await poller.poll();

    // JSON.parse throws before the instance is marked observed.
    expect(publisher.calls).toHaveLength(0);

    poller.stop();
  });

  it('does NOT carry entries forward for an instance that left the fleet', async () => {
    mockProxyToInstance.mockResolvedValueOnce(typingOk('group@g.us', 30));
    // `makeDiscovery` snapshots its argument into a Map at call time, so the
    // removal has to happen on the Map the poller actually reads.
    const live = new Map<string, unknown>([
      ['test', { name: 'test', dbPath: '/tmp/test.db', logDir: '/tmp/test-logs', healthPort: 9099 }],
    ]);
    const discovery = { getInstances: () => live } as never;
    const poller = new FleetRealtimeEventPoller({ discovery, dbReader: makeDbReader(), realtime: publisher });

    await poller.poll();
    publisher.calls.length = 0;

    // Instance removed: it can never be observed again, so holding its key would
    // leak it forever. Retire it instead.
    live.delete('test');
    await poller.poll();

    expect(publisher.calls).toEqual([
      expect.objectContaining({ type: 'typing_update', instance: 'test', jid: 'group@g.us', composing: false }),
    ]);

    poller.stop();
  });
});
