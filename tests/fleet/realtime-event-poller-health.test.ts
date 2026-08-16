// Falsifiers for #2522: realtime poller cycle freshness, coverage, and stall
// health. All timing goes through the injectable monotonic clock; probes are
// synthetic; no network, database, or identity is touched.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FleetRealtimeEventPoller } from '../../src/fleet/realtime-event-poller.ts';
import type { FleetRealtimePublisher } from '../../src/fleet/realtime-publisher.ts';
import { proxyToInstance } from '../../src/fleet/http-proxy.ts';

vi.mock('../../src/fleet/http-proxy.ts', () => ({
  proxyToInstance: vi.fn().mockResolvedValue({ status: 200, body: '{"composing":[]}' }),
}));

const mockProxyToInstance = vi.mocked(proxyToInstance);

function makePublisher(): FleetRealtimePublisher & { calls: unknown[] } {
  const calls: unknown[] = [];
  return { calls, publish: vi.fn((event) => calls.push(event)) } as FleetRealtimePublisher & { calls: unknown[] };
}

function makeDiscovery(instances: Record<string, unknown> = {}) {
  const map = new Map(Object.entries(instances));
  return { getInstances: () => map } as never;
}

function makeDbReader(ok = true) {
  return {
    getLatestMarkers: vi.fn(() =>
      ok
        ? { ok: true, data: { latestMessagePk: 1, latestMessageMarker: null, latestAccessMarker: null } }
        : { ok: false, error: 'synthetic-unavailable' },
    ),
  } as never;
}

const INSTANCE = { name: 'synthetic-a', dbPath: '/tmp/synthetic-a.db', logDir: '/tmp/synthetic-a-logs', healthPort: 0 };

function makePoller(
  instances: Record<string, unknown>,
  dbOk = true,
  clock: { nowMs: number } = { nowMs: 0 },
) {
  const poller = new FleetRealtimeEventPoller(
    { discovery: makeDiscovery(instances), dbReader: makeDbReader(dbOk), realtime: makePublisher() },
    100,
    { monotonicNow: () => clock.nowMs },
  );
  return { poller, clock };
}

beforeEach(() => {
  vi.useFakeTimers();
  mockProxyToInstance.mockReset();
  mockProxyToInstance.mockResolvedValue({ status: 200, body: '{"composing":[]}' });
});

describe('realtime poller health snapshot (#2522)', () => {
  it('starts stopped with no generation', () => {
    const { poller } = makePoller({});
    const snap = poller.healthSnapshot();
    expect(snap.lifecycle).toBe('stopped');
    expect(snap.generation).toBeNull();
    expect(snap.schemaVersion).toBe(1);
  });

  it('start() establishes starting — never current — and mints a fresh generation per start', () => {
    const { poller } = makePoller({});
    poller.start();
    expect(poller.healthSnapshot().lifecycle).toBe('starting');
    const g1 = poller.healthSnapshot().generation;
    expect(g1).toBeTypeOf('string');
    poller.stop();
    expect(poller.healthSnapshot().lifecycle).toBe('stopped');
    poller.start();
    const g2 = poller.healthSnapshot().generation;
    expect(g2, 'restart must mint a NEW generation').not.toBe(g1);
    poller.stop();
  });

  it('a fully observed cycle reads current with coverage counts', async () => {
    const { poller } = makePoller({ 'synthetic-a': INSTANCE });
    poller.start();
    await poller.poll();
    const snap = poller.healthSnapshot();
    expect(snap.lifecycle).toBe('current');
    expect(snap.completedCycles).toBe(1);
    expect(snap.cycleSequence).toBe(1);
    expect(snap.expectedSources).toBe(1); // db source only (healthPort 0 → no typing probe)
    expect(snap.observedSources).toBe(1);
    expect(snap.unavailableSources).toBe(0);
    expect(snap.lastCompletedAgeMs).not.toBeNull();
    expect(snap.lastFullyObservedAgeMs).not.toBeNull();
    expect(snap.durationBucket).toBe('under_interval');
  });

  it('an unavailable db source reads partial, preserving the distinction from current', async () => {
    const { poller } = makePoller({ 'synthetic-a': INSTANCE }, false);
    poller.start();
    await poller.poll();
    const snap = poller.healthSnapshot();
    expect(snap.lifecycle).toBe('partial');
    expect(snap.lastFullyObservedAgeMs, 'a partial cycle must not claim full observation').toBeNull();
    expect(snap.expectedSources).toBe(1);
    expect(snap.observedSources).toBe(0);
    expect(snap.unavailableSources).toBe(1);
  });

  it('a failed typing probe marks the typing source unavailable and the cycle partial', async () => {
    mockProxyToInstance.mockResolvedValue({ status: 503, body: 'synthetic-unavailable' });
    const withHealth = { ...INSTANCE, healthPort: 9999 };
    const { poller } = makePoller({ 'synthetic-a': withHealth });
    poller.start();
    await poller.poll();
    const snap = poller.healthSnapshot();
    expect(snap.lifecycle).toBe('partial');
    expect(snap.expectedSources).toBe(2); // db + typing
    expect(snap.observedSources).toBe(1); // db only
    expect(snap.unavailableSources).toBe(1);
  });

  it('a skipped overlap is a counted receipt, not a silent return', async () => {
    let release: () => void = () => {};
    mockProxyToInstance.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ status: 200, body: '{"composing":[]}' });
        }) as never,
    );
    const withHealth = { ...INSTANCE, healthPort: 9999 };
    const { poller } = makePoller({ 'synthetic-a': withHealth });
    const first = poller.poll();
    await Promise.resolve();
    await poller.poll(); // overlaps the held probe
    const snap = poller.healthSnapshot();
    expect(snap.skippedOverlaps).toBe(1);
    expect(snap.scheduledTicks).toBe(2);
    release();
    await first;
  });

  it('a thrown cycle reads failed with a bounded consecutive count, and recovery requires a fresh success', async () => {
    const clock = { nowMs: 0 };
    const publisher = makePublisher();
    let shouldThrow = true;
    const discovery = {
      getInstances: () => {
        if (shouldThrow) throw new Error('synthetic discovery failure');
        return new Map(Object.entries({ 'synthetic-a': INSTANCE }));
      },
    } as never;
    const poller = new FleetRealtimeEventPoller(
      { discovery, dbReader: makeDbReader(), realtime: publisher },
      100,
      { monotonicNow: () => clock.nowMs },
    );
    poller.start();
    await expect(poller.poll()).rejects.toThrow('synthetic discovery failure');
    let snap = poller.healthSnapshot();
    expect(snap.lifecycle).toBe('failed');
    expect(snap.consecutiveFailedCycles).toBe(1);
    expect(snap.lastRecoveredAgeMs).toBeNull();

    shouldThrow = false;
    clock.nowMs = 50;
    await poller.poll();
    snap = poller.healthSnapshot();
    expect(snap.lifecycle).toBe('current');
    expect(snap.consecutiveFailedCycles).toBe(0);
    expect(snap.lastRecoveredAgeMs, 'recovery is a fresh successful observation, never timer existence').not.toBeNull();
  });

  it('an in-flight cycle past the stalled budget reads stalled', async () => {
    const clock = { nowMs: 0 };
    let release: () => void = () => {};
    mockProxyToInstance.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ status: 200, body: '{"composing":[]}' });
        }) as never,
    );
    const withHealth = { ...INSTANCE, healthPort: 9999 };
    const { poller } = makePoller({ 'synthetic-a': withHealth }, true, clock);
    poller.start();
    const held = poller.poll();
    await Promise.resolve();
    clock.nowMs = 100 * 5 + 1; // past 5× interval
    expect(poller.healthSnapshot().lifecycle).toBe('stalled');
    release();
    await held;
    expect(poller.healthSnapshot().lifecycle).toBe('current');
  });

  it('an armed poller whose last completed cycle aged past the late budget reads late', async () => {
    const clock = { nowMs: 0 };
    const { poller } = makePoller({ 'synthetic-a': INSTANCE }, true, clock);
    poller.start();
    await poller.poll();
    expect(poller.healthSnapshot().lifecycle).toBe('current');
    clock.nowMs = 100 * 3 + 1; // past 3× interval with no new cycle
    expect(poller.healthSnapshot().lifecycle).toBe('late');
    poller.stop();
    expect(poller.healthSnapshot().lifecycle).toBe('stopped');
  });

  it('the snapshot exposes only bounded aggregate values', async () => {
    const { poller } = makePoller({ 'synthetic-a': INSTANCE });
    poller.start();
    await poller.poll();
    const snap = poller.healthSnapshot();
    expect(Object.keys(snap).sort()).toEqual(
      [
        'schemaVersion',
        'generation',
        'lifecycle',
        'cycleSequence',
        'inFlightAgeMs',
        'lastCompletedAgeMs',
        'lastFullyObservedAgeMs',
        'lastRecoveredAgeMs',
        'durationBucket',
        'scheduledTicks',
        'completedCycles',
        'skippedOverlaps',
        'consecutiveFailedCycles',
        'expectedSources',
        'observedSources',
        'unavailableSources',
      ].sort(),
    );
    expect(JSON.stringify(snap)).not.toContain('synthetic-a');
    expect(JSON.stringify(snap)).not.toContain('/tmp/');
  });

  it('restart resets prior-generation observation state and reads starting, never late', async () => {
    const clock = { nowMs: 0 };
    const { poller } = makePoller({ 'synthetic-a': INSTANCE }, true, clock);
    poller.start();
    await poller.poll();
    expect(poller.healthSnapshot().lifecycle).toBe('current');
    poller.stop();
    poller.start();
    clock.nowMs = 100 * 3 + 1; // past the late budget: stale marks would read late
    const snap = poller.healthSnapshot();
    expect(snap.lifecycle, 'a restarted poller must read starting until its own cycle completes').toBe('starting');
    expect(snap.lastCompletedAgeMs, 'prior-generation ages must not leak').toBeNull();
    expect(snap.lastFullyObservedAgeMs).toBeNull();
    expect(snap.durationBucket).toBeNull();
    poller.stop();
  });

  it('a restart does not clear a failure episode without post-restart cycle proof', async () => {
    const clock = { nowMs: 0 };
    let shouldThrow = true;
    const discovery = {
      getInstances: () => {
        if (shouldThrow) throw new Error('synthetic discovery failure');
        return new Map(Object.entries({ 'synthetic-a': INSTANCE }));
      },
    } as never;
    const poller = new FleetRealtimeEventPoller(
      { discovery, dbReader: makeDbReader(), realtime: makePublisher() },
      100,
      { monotonicNow: () => clock.nowMs },
    );
    poller.start();
    await expect(poller.poll()).rejects.toThrow('synthetic discovery failure');
    poller.stop();
    poller.start();
    expect(poller.healthSnapshot().consecutiveFailedCycles, 'restart alone is not recovery proof').toBe(1);
    shouldThrow = false;
    await poller.poll();
    expect(poller.healthSnapshot().consecutiveFailedCycles).toBe(0);
    poller.stop();
  });

  it('a cycle finishing after stop() cannot resurrect the lifecycle', async () => {
    let release: () => void = () => {};
    mockProxyToInstance.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ status: 200, body: '{"composing":[]}' });
        }) as never,
    );
    const withHealth = { ...INSTANCE, healthPort: 9999 };
    const { poller } = makePoller({ 'synthetic-a': withHealth });
    poller.start();
    const held = poller.poll();
    await Promise.resolve();
    poller.stop();
    release();
    await held;
    const snap = poller.healthSnapshot();
    expect(snap.lifecycle, 'an obsolete in-flight cycle must not overwrite stopped').toBe('stopped');
    expect(snap.completedCycles, 'an obsolete cycle must not publish a completion receipt').toBe(0);
  });

  it('a partial completion clears the failure episode but does not claim recovery', async () => {
    const clock = { nowMs: 0 };
    let mode: 'throw' | 'partial' | 'full' = 'throw';
    const discovery = {
      getInstances: () => {
        if (mode === 'throw') throw new Error('synthetic discovery failure');
        return new Map(Object.entries({ 'synthetic-a': INSTANCE }));
      },
    } as never;
    const dbReader = {
      getLatestMarkers: vi.fn(() =>
        mode === 'partial'
          ? { ok: false, error: 'synthetic-unavailable' }
          : { ok: true, data: { latestMessagePk: 1, latestMessageMarker: null, latestAccessMarker: null } },
      ),
    } as never;
    const poller = new FleetRealtimeEventPoller(
      { discovery, dbReader, realtime: makePublisher() },
      100,
      { monotonicNow: () => clock.nowMs },
    );
    poller.start();
    await expect(poller.poll()).rejects.toThrow('synthetic discovery failure');
    mode = 'partial';
    clock.nowMs = 50;
    await poller.poll();
    let snap = poller.healthSnapshot();
    expect(snap.consecutiveFailedCycles).toBe(0);
    expect(snap.lastRecoveredAgeMs, 'a partial observation must not overstate recovered').toBeNull();
    expect(snap.lifecycle).toBe('partial');
    mode = 'full';
    clock.nowMs = 100;
    await poller.poll();
    snap = poller.healthSnapshot();
    expect(snap.lastRecoveredAgeMs).not.toBeNull();
    expect(snap.lifecycle).toBe('current');
    poller.stop();
  });

  it('a never-started poller keeps its counters but claims no lifecycle', async () => {
    const { poller } = makePoller({ 'synthetic-a': INSTANCE });
    await poller.poll();
    const snap = poller.healthSnapshot();
    expect(snap.completedCycles).toBe(1);
    expect(snap.lifecycle, 'a poller that was never started cannot claim current').toBe('stopped');
  });
});
