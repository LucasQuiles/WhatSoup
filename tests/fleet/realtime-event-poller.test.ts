import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FleetRealtimeEventPoller } from '../../src/fleet/realtime-event-poller.ts';
import type { FleetRealtimePublisher } from '../../src/fleet/realtime-publisher.ts';

// Mock proxyToInstance
vi.mock('../../src/fleet/http-proxy.ts', () => ({
  proxyToInstance: vi.fn().mockResolvedValue({ status: 200, body: '{"composing":[]}' }),
}));

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

function makeDbReader(markers: { latestMessagePk: number | null; latestAccessMarker: string | null } = { latestMessagePk: null, latestAccessMarker: null }) {
  return {
    getLatestMarkers: vi.fn(() => ({ ok: true, data: { ...markers } })),
  } as any;
}

describe('FleetRealtimeEventPoller', () => {
  let publisher: ReturnType<typeof makePublisher>;

  beforeEach(() => {
    publisher = makePublisher();
    vi.useFakeTimers();
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
});
