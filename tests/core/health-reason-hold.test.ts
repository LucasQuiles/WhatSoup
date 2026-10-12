// Bounded hold for the windowed health reasons (event_loop_starvation,
// connection_churn, outbound_flood). Each case drives the real producer:
// the loop-lag sampler, the connection manager's own disconnect record and
// prune-on-read code, and the outbound flood detector. Each reading goes
// through the same WindowedReasonHolds call health.ts makes once per
// evaluation, with the monotonic now health passes it (performance.now()).
//
// The fake timers drive both clocks. vi.advanceTimersByTime is time passing:
// it moves the wall clock (Date) and the monotonic clock (performance)
// together. vi.setSystemTime moves only the wall clock, as a host clock step
// does.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CONNECTION_CHURN_HOLD_MS,
  EVENT_LOOP_STARVATION_HOLD_MS,
  OUTBOUND_FLOOD_HOLD_MS,
  RECENT_DISCONNECT_DEGRADED_THRESHOLD,
  WindowedReasonHolds,
} from '../../src/core/health-reason-hold.ts';
import { clockDriftHoldExtensionMs } from '../../src/lib/clock.ts';
import {
  LOOP_LAG_SAMPLE_INTERVAL_MS,
  LOOP_LAG_WINDOW_SAMPLES,
  LoopLagSampler,
} from '../../src/lib/loop-lag-sampler.ts';
import { ConnectionManager, type ConnectionRecentDisconnects } from '../../src/transport/connection.ts';
import {
  OUTBOUND_FLOOD_THRESHOLD,
  OUTBOUND_FLOOD_WINDOW_MS,
  OutboundFloodDetector,
} from '../../src/transport/outbound-flood-detector.ts';

const MINUTE_MS = 60_000;
const FLOOD_DEST = '15551230009@s.whatsapp.net';
const SECOND_FLOOD_DEST = '15551230010@s.whatsapp.net';
const CHURN_WINDOW_MS = (ConnectionManager as unknown as { RECENT_DISCONNECT_WINDOW_MS: number })
  .RECENT_DISCONNECT_WINDOW_MS;
const NOON_MS = Date.parse('2026-10-09T12:00:00Z');
// Each hold runs this much past its window, for clock drift.
const CHURN_DRIFT_MS = 6_000;
const FLOOD_DRIFT_MS = 3_000;

const monoNow = (): number => performance.now();

// A pause after the first clock read inside `record`, whichever clock that
// is: the next read, of either clock, comes `pauseMs` later.
function withPauseAfterFirstClockRead(pauseMs: number, record: () => void): void {
  const dateNow = Date.now.bind(Date);
  const perfNow = performance.now.bind(performance);
  let paused = false;
  const pauseAfter = (valueMs: number): number => {
    if (!paused) {
      paused = true;
      vi.advanceTimersByTime(pauseMs);
    }
    return valueMs;
  };
  const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => pauseAfter(dateNow()));
  const perfSpy = vi.spyOn(performance, 'now').mockImplementation(() => pauseAfter(perfNow()));
  try {
    record();
  } finally {
    dateSpy.mockRestore();
    perfSpy.mockRestore();
  }
  expect(paused, 'record read no clock').toBe(true);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('hold values', () => {
  it('holds churn and flood for their own detection windows, and starvation for 5 minutes', () => {
    expect(CONNECTION_CHURN_HOLD_MS).toBe(CHURN_WINDOW_MS);
    expect(CONNECTION_CHURN_HOLD_MS).toBe(10 * MINUTE_MS);
    expect(OUTBOUND_FLOOD_HOLD_MS).toBe(OUTBOUND_FLOOD_WINDOW_MS);
    expect(OUTBOUND_FLOOD_HOLD_MS).toBe(5 * MINUTE_MS);
    expect(EVENT_LOOP_STARVATION_HOLD_MS).toBe(5 * MINUTE_MS);
    expect(RECENT_DISCONNECT_DEGRADED_THRESHOLD).toBe(3);
  });

  it('extends churn and flood holds by 1% of their windows for clock drift', () => {
    expect(clockDriftHoldExtensionMs(CHURN_WINDOW_MS)).toBe(CHURN_DRIFT_MS);
    expect(clockDriftHoldExtensionMs(OUTBOUND_FLOOD_WINDOW_MS)).toBe(FLOOD_DRIFT_MS);
    expect(clockDriftHoldExtensionMs(1_001)).toBe(11);
  });
});

// The real sampler on an injected monotonic clock, its interval fired by fake
// timers. The hold reads the same monotonic clock, as health does. A hold
// can also be read later than the sampler's last observation without the
// sampler seeing time pass, which isolates the hold's own arithmetic.
function makeLoop() {
  let monoMs = 0;
  let holdAheadMs = 0;
  const sampler = new LoopLagSampler({
    now: () => monoMs,
    eluReader: () => null,
    cpuReader: () => null,
  });
  const holds = new WindowedReasonHolds();
  sampler.start();
  const tick = (lagMs: number): void => {
    monoMs += LOOP_LAG_SAMPLE_INTERVAL_MS + lagMs;
    vi.advanceTimersByTime(LOOP_LAG_SAMPLE_INTERVAL_MS);
  };
  return {
    // `count` interval fires, each `lagMs` late. A lag over 10 s is a
    // discontinuity: the sampler empties its window and counts it.
    ticks: (count: number, lagMs = 0): void => {
      for (let fired = 0; fired < count; fired += 1) tick(lagMs);
    },
    // The sampler's own snapshot, read without the hold. With no time passed
    // since the last fire it records nothing.
    raw: () => sampler.snapshot(),
    // One health evaluation: one snapshot, read once.
    evaluate: () => {
      const snapshot = sampler.snapshot();
      return {
        held: holds.starvation(snapshot, monoMs + holdAheadMs),
        rawStarved: snapshot.locallyStarved,
        sampleCount: snapshot.sampleCount,
      };
    },
    holdNow: (): number => monoMs + holdAheadMs,
    // Moves only the clock the hold reads; the sampler sees no time pass.
    advanceHold: (ms: number): void => { holdAheadMs += ms; },
    // Time short of the next fire: the sampler's clock moves, nothing fires.
    advanceSampler: (ms: number): void => { monoMs += ms; },
    stop: (): void => sampler.stop(),
    start: (): void => sampler.start(),
  };
}

describe('event_loop_starvation', () => {
  it('a startup window still filling reads clear, as base', () => {
    const loop = makeLoop();
    loop.ticks(5);
    expect(loop.evaluate()).toEqual({ held: false, rawStarved: false, sampleCount: 5 });
  });

  it('a starved full window is reported until the hold has passed since the sample that ended it', () => {
    const loop = makeLoop();
    loop.ticks(LOOP_LAG_WINDOW_SAMPLES, 300);
    expect(loop.evaluate()).toMatchObject({ held: true, rawStarved: true });

    // p95 is the second-largest sample: starvation ends when one slow sample is left.
    while (loop.raw().locallyStarved) loop.ticks(1);
    const endedAtMs = loop.holdNow();
    expect(loop.evaluate()).toMatchObject({ held: true, rawStarved: false, sampleCount: LOOP_LAG_WINDOW_SAMPLES });
    loop.advanceHold(endedAtMs + EVENT_LOOP_STARVATION_HOLD_MS - 1 - loop.holdNow());
    expect(loop.evaluate().held).toBe(true);
    loop.advanceHold(1);
    expect(loop.evaluate().held).toBe(false);
  });

  it('recurring stalls over 10 s keep it reported while the raw verdict reads clear; it clears a hold after the last unreadable read', () => {
    const loop = makeLoop();
    loop.ticks(LOOP_LAG_WINDOW_SAMPLES);
    expect(loop.evaluate().held).toBe(false);

    let lastHeldAtMs = 0;
    // Twelve cycles of 27.5 s each, longer than the hold. The raw verdict
    // reads clear on every poll: empty, partial, then full and clean.
    for (let stall = 0; stall < 12; stall += 1) {
      loop.ticks(1, 12_000);
      expect(loop.evaluate()).toEqual({ held: true, rawStarved: false, sampleCount: 0 });
      loop.ticks(10);
      expect(loop.evaluate()).toEqual({ held: true, rawStarved: false, sampleCount: 10 });
      lastHeldAtMs = loop.holdNow();
      for (let poll = 0; poll < 2; poll += 1) {
        loop.ticks(10);
        expect(loop.evaluate()).toEqual({ held: true, rawStarved: false, sampleCount: LOOP_LAG_WINDOW_SAMPLES });
      }
    }

    // Stalls stopped; the window is full and clean.
    loop.advanceHold(lastHeldAtMs + EVENT_LOOP_STARVATION_HOLD_MS - 1 - loop.holdNow());
    expect(loop.evaluate().held).toBe(true);
    loop.advanceHold(1);
    expect(loop.evaluate()).toEqual({ held: false, rawStarved: false, sampleCount: LOOP_LAG_WINDOW_SAMPLES });
  });

  it('a starved episode between two reads is held from the sample that ended it', () => {
    const loop = makeLoop();
    loop.ticks(LOOP_LAG_WINDOW_SAMPLES);
    expect(loop.evaluate().held).toBe(false);

    loop.ticks(LOOP_LAG_WINDOW_SAMPLES, 300);
    while (loop.raw().locallyStarved) loop.ticks(1);
    // The sampler stamps every starved sample and the one that ends it.
    const endedAtMs = loop.holdNow();
    expect(loop.raw().lastStarvedMonotonicMs).toBe(endedAtMs);

    loop.advanceHold(2 * MINUTE_MS);
    expect(loop.evaluate()).toEqual({ held: true, rawStarved: false, sampleCount: LOOP_LAG_WINDOW_SAMPLES });
    loop.advanceHold(endedAtMs + EVENT_LOOP_STARVATION_HOLD_MS - 1 - loop.holdNow());
    expect(loop.evaluate().held).toBe(true);
    loop.advanceHold(1);
    expect(loop.evaluate().held).toBe(false);
  });

  it('a discontinuity since the last read is held even when the window has refilled clean', () => {
    const loop = makeLoop();
    loop.ticks(LOOP_LAG_WINDOW_SAMPLES);
    expect(loop.evaluate().held).toBe(false);
    loop.ticks(1, 12_000);
    loop.ticks(LOOP_LAG_WINDOW_SAMPLES);
    expect(loop.evaluate()).toEqual({ held: true, rawStarved: false, sampleCount: LOOP_LAG_WINDOW_SAMPLES });
  });

  it('a stall before the first read counts: the discontinuity baseline starts at zero', () => {
    const loop = makeLoop();
    loop.ticks(1, 12_000);
    loop.ticks(LOOP_LAG_WINDOW_SAMPLES);
    expect(loop.evaluate()).toEqual({ held: true, rawStarved: false, sampleCount: LOOP_LAG_WINDOW_SAMPLES });
  });

  it('a partial window after a reset reads held even after the hold has run out', () => {
    const loop = makeLoop();
    loop.ticks(LOOP_LAG_WINDOW_SAMPLES);
    expect(loop.evaluate().held).toBe(false);
    loop.ticks(1, 12_000);
    expect(loop.evaluate().held).toBe(true);
    // Only the hold's clock moves, so the window stays empty past the hold.
    loop.advanceHold(EVENT_LOOP_STARVATION_HOLD_MS + 1);
    expect(loop.evaluate()).toEqual({ held: true, rawStarved: false, sampleCount: 0 });
  });

  it('a sampler stopped while starved is stamped at the stop; restarted after the hold, on-time samples read clear', () => {
    const loop = makeLoop();
    loop.ticks(LOOP_LAG_WINDOW_SAMPLES, 300);
    expect(loop.evaluate()).toMatchObject({ held: true, rawStarved: true });
    // Stopped before the next fire: emptying the window ends the episode.
    loop.advanceSampler(400);
    const stoppedAtMs = loop.holdNow();
    loop.stop();
    expect(loop.raw()).toMatchObject({ sampleCount: 0, lastStarvedMonotonicMs: stoppedAtMs });
    loop.advanceHold(EVENT_LOOP_STARVATION_HOLD_MS - 1);
    expect(loop.evaluate().held).toBe(true);

    // Past the hold now. The old episode does not stamp the restart.
    loop.start();
    loop.ticks(5);
    expect(loop.evaluate()).toEqual({ held: false, rawStarved: false, sampleCount: 5 });
    expect(loop.raw().lastStarvedMonotonicMs).toBe(stoppedAtMs);
  });

  it('a sampler restarted after a past discontinuity reads clear while it refills: only a discontinuity makes a partial window unreadable', () => {
    const loop = makeLoop();
    loop.ticks(LOOP_LAG_WINDOW_SAMPLES);
    loop.ticks(1, 12_000);
    expect(loop.evaluate()).toMatchObject({ held: true, sampleCount: 0 });
    loop.ticks(LOOP_LAG_WINDOW_SAMPLES);
    loop.advanceHold(EVENT_LOOP_STARVATION_HOLD_MS);
    expect(loop.evaluate()).toEqual({ held: false, rawStarved: false, sampleCount: LOOP_LAG_WINDOW_SAMPLES });

    loop.stop();
    loop.start();
    loop.ticks(5);
    expect(loop.raw()).toMatchObject({ discontinuityCount: 1, refillingAfterDiscontinuity: false });
    expect(loop.evaluate()).toEqual({ held: false, rawStarved: false, sampleCount: 5 });
  });
});

// The connection manager's own record and prune-on-read code, on a bare
// instance with no socket, read through the live snapshot health reads.
function makeDisconnectWindow() {
  const manager = Object.create(ConnectionManager.prototype) as {
    recentDisconnects: unknown[];
    recordDisconnect(statusCode: number | null, reason: string): void;
    getRecentDisconnectSnapshot(): ConnectionRecentDisconnects;
  };
  manager.recentDisconnects = [];
  return {
    disconnect: (): void => manager.recordDisconnect(440, 'connectionReplaced'),
    // A disconnect in base's window that this process did not record: no
    // monotonic instant, as a reload from disk would leave it.
    addUnrecorded: (): void => {
      manager.recentDisconnects.push({ at: Date.now(), reason: 'connectionReplaced', statusCode: 440 });
    },
    read: (): ConnectionRecentDisconnects => manager.getRecentDisconnectSnapshot(),
  };
}

describe('connection_churn', () => {
  it('a connection flapping every 4 minutes reads held throughout; it clears a hold after the last churn ended', () => {
    const window = makeDisconnectWindow();
    const holds = new WindowedReasonHolds();
    const startMs = monoNow();
    let dippedBelowThreshold = false;
    for (let minute = 0; minute <= 28; minute += 1) {
      if (minute % 4 === 0) window.disconnect();
      const stats = window.read();
      const held = holds.churn(stats, monoNow());
      if (stats.count < RECENT_DISCONNECT_DEGRADED_THRESHOLD && minute >= 8) dippedBelowThreshold = true;
      if (minute >= 8) expect(held, `minute ${minute}`).toBe(true);
      vi.advanceTimersByTime(MINUTE_MS);
    }
    expect(dippedBelowThreshold, 'the window never dipped below the threshold').toBe(true);

    for (let stats = window.read(); stats.count >= RECENT_DISCONNECT_DEGRADED_THRESHOLD; stats = window.read()) {
      expect(holds.churn(stats, monoNow())).toBe(true);
      vi.advanceTimersByTime(MINUTE_MS);
    }
    // The last churn ended when its third-newest disconnect (minute 20) left
    // the window, plus the drift extension.
    const heldUntilMs = startMs + 20 * MINUTE_MS + CHURN_WINDOW_MS + CHURN_DRIFT_MS;
    vi.advanceTimersByTime(heldUntilMs + CONNECTION_CHURN_HOLD_MS - 1 - monoNow());
    expect(holds.churn(window.read(), monoNow())).toBe(true);
    vi.advanceTimersByTime(1);
    expect(holds.churn(window.read(), monoNow())).toBe(false);
  });

  it.each([
    { period: '4 minutes', periodMs: 4 * MINUTE_MS },
    { period: '4.9 minutes', periodMs: 4.9 * MINUTE_MS },
  ])('a flap every $period read only at minutes 19 and 31 is held at both; it clears one hold after churn last held', ({ periodMs }) => {
    const window = makeDisconnectWindow();
    const holds = new WindowedReasonHolds();
    const startMs = monoNow();
    const at = (offsetMs: number): void => { vi.advanceTimersByTime(startMs + offsetMs - monoNow()); };
    const flaps: number[] = [];
    for (let t = 0; t <= 31 * MINUTE_MS; t += periodMs) flaps.push(t);
    const reads = [19 * MINUTE_MS, 31 * MINUTE_MS];
    let flapIndex = 0;
    for (const readAtMs of reads) {
      for (; flapIndex < flaps.length && flaps[flapIndex]! <= readAtMs; flapIndex += 1) {
        at(flaps[flapIndex]!);
        window.disconnect();
      }
      at(readAtMs);
      const stats = window.read();
      // The window itself has fallen below the threshold at each read.
      expect(stats.count).toBeLessThan(RECENT_DISCONNECT_DEGRADED_THRESHOLD);
      expect(holds.churn(stats, monoNow())).toBe(true);
    }
    // Churn last held until the third-newest disconnect left the window, plus
    // the drift extension.
    const lastHeldMs = flaps[flaps.length - 3]! + CHURN_WINDOW_MS + CHURN_DRIFT_MS;
    at(lastHeldMs + CONNECTION_CHURN_HOLD_MS - 1);
    expect(holds.churn(window.read(), monoNow())).toBe(true);
    at(lastHeldMs + CONNECTION_CHURN_HOLD_MS);
    expect(holds.churn(window.read(), monoNow())).toBe(false);
  });

  it('three disconnects read once 12 minutes later are held, from when they left the window plus the drift extension', () => {
    const window = makeDisconnectWindow();
    const holds = new WindowedReasonHolds();
    const startMs = monoNow();
    for (let n = 0; n < RECENT_DISCONNECT_DEGRADED_THRESHOLD; n += 1) window.disconnect();
    vi.advanceTimersByTime(12 * MINUTE_MS);
    const stats = window.read();
    const heldUntilMs = startMs + CHURN_WINDOW_MS + CHURN_DRIFT_MS;
    expect(stats).toMatchObject({ count: 0, lastChurnMonotonicMs: heldUntilMs });
    expect(holds.churn(stats, monoNow())).toBe(true);
    vi.advanceTimersByTime(heldUntilMs + CONNECTION_CHURN_HOLD_MS - 1 - monoNow());
    expect(holds.churn(window.read(), monoNow())).toBe(true);
    vi.advanceTimersByTime(1);
    expect(holds.churn(window.read(), monoNow())).toBe(false);
  });

  it('three disconnects spread over more than the window never hold churn', () => {
    const window = makeDisconnectWindow();
    const holds = new WindowedReasonHolds();
    for (let minute = 0; minute <= 30; minute += 1) {
      if (minute % 6 === 0) window.disconnect();
      expect(holds.churn(window.read(), monoNow()), `minute ${minute}`).toBe(false);
      vi.advanceTimersByTime(MINUTE_MS);
    }
  });

  it('a missing disconnect window reads held and refreshes the hold on every read', () => {
    const holds = new WindowedReasonHolds();
    expect(holds.churn(makeDisconnectWindow().read(), 0)).toBe(false);
    expect(holds.churn(undefined, 1_000)).toBe(true);
    expect(holds.churn(undefined, 1_000 + CONNECTION_CHURN_HOLD_MS)).toBe(true);
    const lastUnknownAtMs = 1_000 + CONNECTION_CHURN_HOLD_MS;
    expect(holds.churn(makeDisconnectWindow().read(), lastUnknownAtMs + 1)).toBe(true);
    expect(holds.churn(makeDisconnectWindow().read(), lastUnknownAtMs + CONNECTION_CHURN_HOLD_MS - 1)).toBe(true);
    expect(holds.churn(makeDisconnectWindow().read(), lastUnknownAtMs + CONNECTION_CHURN_HOLD_MS)).toBe(false);
  });
});

describe('outbound_flood', () => {
  it('a flood recurring every 7 minutes reads held throughout; it clears a hold after the last flood ended', () => {
    const detector = new OutboundFloodDetector();
    const holds = new WindowedReasonHolds();
    const startMs = monoNow();
    let dippedBelowThreshold = false;
    for (let minute = 0; minute <= 28; minute += 1) {
      if (minute % 7 === 0) {
        for (let sent = 0; sent < OUTBOUND_FLOOD_THRESHOLD; sent += 1) detector.record(FLOOD_DEST, Date.now());
      }
      const stats = detector.stats(Date.now());
      expect(holds.flood(stats, monoNow()), `minute ${minute}`).toBe(true);
      if (!stats.flooding) dippedBelowThreshold = true;
      vi.advanceTimersByTime(MINUTE_MS);
    }
    expect(dippedBelowThreshold, 'the window never dipped below the threshold').toBe(true);

    for (let stats = detector.stats(Date.now()); stats.flooding; stats = detector.stats(Date.now())) {
      expect(holds.flood(stats, monoNow())).toBe(true);
      vi.advanceTimersByTime(MINUTE_MS);
    }
    // The last burst (minute 28) flooded until its sends left the window,
    // plus the drift extension.
    const heldUntilMs = startMs + 28 * MINUTE_MS + OUTBOUND_FLOOD_WINDOW_MS + FLOOD_DRIFT_MS;
    vi.advanceTimersByTime(heldUntilMs + OUTBOUND_FLOOD_HOLD_MS - 1 - monoNow());
    expect(holds.flood(detector.stats(Date.now()), monoNow())).toBe(true);
    vi.advanceTimersByTime(1);
    expect(holds.flood(detector.stats(Date.now()), monoNow())).toBe(false);
  });

  it('a flood burst read once 7 minutes later is held, from when its sends left the window plus the drift extension', () => {
    const detector = new OutboundFloodDetector();
    const holds = new WindowedReasonHolds();
    const startMs = monoNow();
    for (let sent = 0; sent < OUTBOUND_FLOOD_THRESHOLD; sent += 1) detector.record(FLOOD_DEST, Date.now());
    vi.advanceTimersByTime(7 * MINUTE_MS);
    const stats = detector.stats(Date.now());
    const endedAtMs = startMs + OUTBOUND_FLOOD_WINDOW_MS + FLOOD_DRIFT_MS;
    expect(stats).toMatchObject({ flooding: false, lastFloodingMonotonicMs: endedAtMs });
    expect(holds.flood(stats, monoNow())).toBe(true);
    vi.advanceTimersByTime(endedAtMs + OUTBOUND_FLOOD_HOLD_MS - 1 - monoNow());
    expect(holds.flood(detector.stats(Date.now()), monoNow())).toBe(true);
    vi.advanceTimersByTime(1);
    expect(holds.flood(detector.stats(Date.now()), monoNow())).toBe(false);
  });

  it('threshold sends spread over more than the window never hold a flood', () => {
    const detector = new OutboundFloodDetector();
    const holds = new WindowedReasonHolds();
    // One send every 20 s: at most 16 fall in any 5-minute window.
    for (let sent = 0; sent < 2 * OUTBOUND_FLOOD_THRESHOLD; sent += 1) {
      detector.record(FLOOD_DEST, Date.now());
      expect(holds.flood(detector.stats(Date.now()), monoNow()), `send ${sent}`).toBe(false);
      vi.advanceTimersByTime(20_000);
    }
  });

  it('the flood that holds longest sets the hold, whichever destination reached the threshold last', () => {
    const detector = new OutboundFloodDetector();
    const holds = new WindowedReasonHolds();
    const startMs = monoNow();
    // The second destination starts first and reaches the threshold last,
    // but its flood ends a minute before the first destination's.
    for (let sent = 1; sent < OUTBOUND_FLOOD_THRESHOLD; sent += 1) detector.record(SECOND_FLOOD_DEST, Date.now());
    vi.advanceTimersByTime(MINUTE_MS);
    for (let sent = 0; sent < OUTBOUND_FLOOD_THRESHOLD; sent += 1) detector.record(FLOOD_DEST, Date.now());
    vi.advanceTimersByTime(MINUTE_MS);
    detector.record(SECOND_FLOOD_DEST, Date.now());
    const endedAtMs = startMs + MINUTE_MS + OUTBOUND_FLOOD_WINDOW_MS + FLOOD_DRIFT_MS;
    vi.advanceTimersByTime(endedAtMs + OUTBOUND_FLOOD_HOLD_MS - 1 - monoNow());
    expect(holds.flood(detector.stats(Date.now()), monoNow())).toBe(true);
    vi.advanceTimersByTime(1);
    expect(holds.flood(detector.stats(Date.now()), monoNow())).toBe(false);
  });

  it('a snapshot never supplied reads clear; one missing after being supplied reads held', () => {
    // A transport with no flood detector (the SMS bridge) never supplies one.
    const never = new WindowedReasonHolds();
    expect(never.flood(undefined, 0)).toBe(false);
    expect(never.flood(null, 1_000)).toBe(false);

    const holds = new WindowedReasonHolds();
    expect(holds.flood(new OutboundFloodDetector().stats(0), 0)).toBe(false);
    expect(holds.flood(undefined, 1_000)).toBe(true);
    expect(holds.flood(null, 1_000 + OUTBOUND_FLOOD_HOLD_MS)).toBe(true);
  });
});

// Whether churn or a flood exists is decided only by base's own wall-clock
// count; the monotonic clock only times the hold. These cases make the two
// clocks disagree without a step: a fractional tick moves only the monotonic
// clock's fraction, a setSystemTime correction models slew, a spy freezes or
// jumps performance, and a pause separates the two reads inside one record.
describe('detection by base\'s count, timed on the monotonic clock', () => {
  it('three disconnects base counted, 0.8 ms over a window apart on the monotonic clock, are held from the first read after', () => {
    const window = makeDisconnectWindow();
    const holds = new WindowedReasonHolds();
    const wallStartMs = Date.now();
    const monoStartMs = monoNow();
    vi.advanceTimersByTime(0.1);
    const firstMs = monoNow();
    window.disconnect();
    vi.advanceTimersByTime(300_000.4);
    window.disconnect();
    vi.advanceTimersByTime(300_000.4);
    const lastMs = monoNow();
    window.disconnect();
    // (wall, monotonic) offsets: (0, 0.1), (300000, 300000.5), (600000, 600000.9).
    expect(Date.now() - wallStartMs).toBe(CHURN_WINDOW_MS);
    expect(lastMs - monoStartMs).toBeCloseTo(CHURN_WINDOW_MS + 0.9, 6);
    expect(window.read().count).toBe(RECENT_DISCONNECT_DEGRADED_THRESHOLD);
    // The first read, 1 ms later, finds base's window below the threshold.
    vi.advanceTimersByTime(1);
    const stats = window.read();
    expect(stats.count).toBe(2);
    expect(holds.churn(stats, monoNow())).toBe(true);
    // Held until the oldest of the three left the window, plus the drift extension.
    const heldUntilMs = firstMs + (CHURN_WINDOW_MS + CHURN_DRIFT_MS);
    vi.advanceTimersByTime(10_000);
    expect(window.read().lastChurnMonotonicMs).toBe(heldUntilMs);
    expect(holds.churn(window.read(), heldUntilMs + CONNECTION_CHURN_HOLD_MS - 1)).toBe(true);
    expect(holds.churn(window.read(), heldUntilMs + CONNECTION_CHURN_HOLD_MS + 1)).toBe(false);
  });

  it('three disconnects base counted, with the wall clock slewed 500 ppm slow, clear exactly one hold after the oldest left the window plus the drift extension', () => {
    const window = makeDisconnectWindow();
    const holds = new WindowedReasonHolds();
    const slewMs = 150;
    const firstMs = monoNow();
    window.disconnect();
    for (let n = 1; n < RECENT_DISCONNECT_DEGRADED_THRESHOLD; n += 1) {
      vi.advanceTimersByTime(CHURN_WINDOW_MS / 2 + slewMs);
      vi.setSystemTime(Date.now() - slewMs);
      window.disconnect();
    }
    expect(window.read().count).toBe(RECENT_DISCONNECT_DEGRADED_THRESHOLD);
    vi.advanceTimersByTime(1);
    expect(holds.churn(window.read(), monoNow())).toBe(true);
    const heldUntilMs = firstMs + CHURN_WINDOW_MS + CHURN_DRIFT_MS;
    vi.advanceTimersByTime(heldUntilMs + CONNECTION_CHURN_HOLD_MS - 1 - monoNow());
    expect(window.read().lastChurnMonotonicMs).toBe(heldUntilMs);
    expect(holds.churn(window.read(), monoNow())).toBe(true);
    vi.advanceTimersByTime(1);
    expect(holds.churn(window.read(), monoNow())).toBe(false);
  });

  // macOS's adjtime slews at up to about 5000 ppm. At that rate base keeps
  // counting the oldest disconnect about 3 s longer on the monotonic clock
  // than one window; the drift extension covers it.
  it('three disconnects with the wall clock slewed 5000 ppm slow stay held until one hold after base stops counting them', () => {
    const window = makeDisconnectWindow();
    const holds = new WindowedReasonHolds();
    // Every 300 s on the monotonic clock, the wall clock advances 1.5 s less.
    const slewMs = 1_500;
    const firstMs = monoNow();
    window.disconnect();
    for (let n = 1; n < RECENT_DISCONNECT_DEGRADED_THRESHOLD; n += 1) {
      vi.advanceTimersByTime(CHURN_WINDOW_MS / 2);
      vi.setSystemTime(Date.now() - slewMs);
      window.disconnect();
    }
    // (wall, monotonic): (0, 0), (298500, 300000), (597000, 600000). Base
    // counts the oldest until wall 600000, about monotonic 603015 at this rate.
    vi.advanceTimersByTime(3_016);
    vi.setSystemTime(Date.now() - 15);
    // The first read: wall 600001, monotonic 603016.
    const stats = window.read();
    expect(stats.count).toBe(2);
    const baseEndedMs = monoNow() - 1;
    expect(holds.churn(stats, monoNow())).toBe(true);
    vi.advanceTimersByTime(baseEndedMs + CONNECTION_CHURN_HOLD_MS - 1 - monoNow());
    expect(holds.churn(window.read(), monoNow()), 'one hold after base stopped counting').toBe(true);
    const heldUntilMs = firstMs + CHURN_WINDOW_MS + CHURN_DRIFT_MS;
    vi.advanceTimersByTime(heldUntilMs + CONNECTION_CHURN_HOLD_MS - 1 - monoNow());
    expect(holds.churn(window.read(), monoNow())).toBe(true);
    vi.advanceTimersByTime(1);
    expect(holds.churn(window.read(), monoNow())).toBe(false);
  });

  it('three disconnects spread over the window plus 2 s never hold churn', () => {
    const window = makeDisconnectWindow();
    const holds = new WindowedReasonHolds();
    const at = [0, CHURN_WINDOW_MS / 2, CHURN_WINDOW_MS + 2_000];
    const startMs = monoNow();
    for (let readMs = 0; readMs <= CHURN_WINDOW_MS + 2 * CONNECTION_CHURN_HOLD_MS; readMs += 1_000) {
      vi.advanceTimersByTime(startMs + readMs - monoNow());
      if (at.includes(readMs)) window.disconnect();
      expect(holds.churn(window.read(), monoNow()), `${readMs} ms`).toBe(false);
    }
  });

  it('threshold sends base counted, 0.8 ms over a window apart on the monotonic clock, are held from the first read after', () => {
    const detector = new OutboundFloodDetector();
    const holds = new WindowedReasonHolds();
    vi.advanceTimersByTime(0.1);
    const firstMs = monoNow();
    detector.record(FLOOD_DEST, Date.now());
    vi.advanceTimersByTime(150_000.4);
    for (let sent = 2; sent < OUTBOUND_FLOOD_THRESHOLD; sent += 1) detector.record(FLOOD_DEST, Date.now());
    vi.advanceTimersByTime(150_000.4);
    expect(detector.record(FLOOD_DEST, Date.now()).flooding).toBe(true);
    vi.advanceTimersByTime(1);
    const stats = detector.stats(Date.now());
    expect(stats).toMatchObject({ flooding: false, worstCount: OUTBOUND_FLOOD_THRESHOLD - 1 });
    expect(holds.flood(stats, monoNow())).toBe(true);
    const heldUntilMs = firstMs + (OUTBOUND_FLOOD_WINDOW_MS + FLOOD_DRIFT_MS);
    vi.advanceTimersByTime(10_000);
    expect(detector.stats(Date.now()).lastFloodingMonotonicMs).toBe(heldUntilMs);
    expect(holds.flood(detector.stats(Date.now()), heldUntilMs + OUTBOUND_FLOOD_HOLD_MS - 1)).toBe(true);
    expect(holds.flood(detector.stats(Date.now()), heldUntilMs + OUTBOUND_FLOOD_HOLD_MS + 1)).toBe(false);
  });

  it('threshold sends with the wall clock slewed 5000 ppm slow stay held until one hold after base stops counting them, and clear exactly one hold after the extended held-until', () => {
    const detector = new OutboundFloodDetector();
    const holds = new WindowedReasonHolds();
    // Every 150 s on the monotonic clock, the wall clock advances 0.75 s less.
    const slewMs = 750;
    const firstMs = monoNow();
    detector.record(FLOOD_DEST);
    vi.advanceTimersByTime(OUTBOUND_FLOOD_WINDOW_MS / 2);
    vi.setSystemTime(Date.now() - slewMs);
    for (let sent = 2; sent < OUTBOUND_FLOOD_THRESHOLD; sent += 1) detector.record(FLOOD_DEST);
    vi.advanceTimersByTime(OUTBOUND_FLOOD_WINDOW_MS / 2);
    vi.setSystemTime(Date.now() - slewMs);
    expect(detector.record(FLOOD_DEST).flooding).toBe(true);
    // The last send at (wall 298500, monotonic 300000). Base counts the first
    // until wall 300000, about monotonic 301507 at this rate.
    vi.advanceTimersByTime(1_508);
    vi.setSystemTime(Date.now() - 7);
    // The first read: wall 300001, monotonic 301508.
    const stats = detector.stats(Date.now());
    expect(stats.flooding).toBe(false);
    const baseEndedMs = monoNow() - 1;
    expect(holds.flood(stats, monoNow())).toBe(true);
    vi.advanceTimersByTime(baseEndedMs + OUTBOUND_FLOOD_HOLD_MS - 1 - monoNow());
    expect(holds.flood(detector.stats(Date.now()), monoNow()), 'one hold after base stopped counting').toBe(true);
    const heldUntilMs = firstMs + OUTBOUND_FLOOD_WINDOW_MS + FLOOD_DRIFT_MS;
    vi.advanceTimersByTime(heldUntilMs + OUTBOUND_FLOOD_HOLD_MS - 1 - monoNow());
    expect(detector.stats(Date.now()).lastFloodingMonotonicMs).toBe(heldUntilMs);
    expect(holds.flood(detector.stats(Date.now()), monoNow())).toBe(true);
    vi.advanceTimersByTime(1);
    expect(holds.flood(detector.stats(Date.now()), monoNow())).toBe(false);
  });

  it('a read between a burst and its last send keeps the sends base still counts; the flood holds from the oldest plus the drift extension', () => {
    const detector = new OutboundFloodDetector();
    const holds = new WindowedReasonHolds();
    const slewMs = 150;
    const firstMs = monoNow();
    for (let sent = 1; sent < OUTBOUND_FLOOD_THRESHOLD; sent += 1) detector.record(FLOOD_DEST, Date.now());
    vi.advanceTimersByTime(OUTBOUND_FLOOD_WINDOW_MS + slewMs);
    vi.setSystemTime(Date.now() - slewMs);
    // A read just before the last send: the first sends are a window plus
    // 150 ms old on the monotonic clock, still inside base's wall window.
    expect(holds.flood(detector.stats(Date.now()), monoNow())).toBe(false);
    expect(detector.record(FLOOD_DEST, Date.now()).flooding).toBe(true);
    vi.advanceTimersByTime(1);
    const stats = detector.stats(Date.now());
    expect(stats.flooding).toBe(false);
    expect(holds.flood(stats, monoNow())).toBe(true);
    const heldUntilMs = firstMs + OUTBOUND_FLOOD_WINDOW_MS + FLOOD_DRIFT_MS;
    vi.advanceTimersByTime(heldUntilMs + 1 - monoNow());
    expect(detector.stats(Date.now()).lastFloodingMonotonicMs).toBe(heldUntilMs);
  });

  it('threshold sends spread over the window plus 2 s never hold a flood', () => {
    const detector = new OutboundFloodDetector();
    const holds = new WindowedReasonHolds();
    const startMs = monoNow();
    for (let readMs = 0; readMs <= OUTBOUND_FLOOD_WINDOW_MS + 2 * OUTBOUND_FLOOD_HOLD_MS; readMs += 1_000) {
      vi.advanceTimersByTime(startMs + readMs - monoNow());
      if (readMs === 0 || readMs === OUTBOUND_FLOOD_WINDOW_MS + 2_000) detector.record(FLOOD_DEST, Date.now());
      if (readMs === OUTBOUND_FLOOD_WINDOW_MS / 2) {
        for (let sent = 2; sent < OUTBOUND_FLOOD_THRESHOLD; sent += 1) detector.record(FLOOD_DEST, Date.now());
      }
      expect(holds.flood(detector.stats(Date.now()), monoNow()), `${readMs} ms`).toBe(false);
    }
  });

  // Base decides on the wall reading; the hold is timed from the monotonic
  // reading after it, so a pause between the two cannot lose the episode.
  it('a 2 s pause inside the disconnect that completes churn cannot lose it: held from the first read after', () => {
    const window = makeDisconnectWindow();
    const holds = new WindowedReasonHolds();
    const wallStartMs = Date.now();
    const firstMs = monoNow();
    window.disconnect();
    vi.advanceTimersByTime(CHURN_WINDOW_MS / 2);
    window.disconnect();
    vi.advanceTimersByTime(CHURN_WINDOW_MS / 2);
    withPauseAfterFirstClockRead(2_000, () => window.disconnect());
    // (wall, monotonic): (0, 0), (300000, 300000), (600000, 602000).
    vi.advanceTimersByTime(1);
    const stats = window.read();
    expect(stats).toMatchObject({ count: 2, lastAt: new Date(wallStartMs + CHURN_WINDOW_MS).toISOString() });
    expect(holds.churn(stats, monoNow())).toBe(true);
    const heldUntilMs = firstMs + CHURN_WINDOW_MS + CHURN_DRIFT_MS;
    vi.advanceTimersByTime(heldUntilMs + CONNECTION_CHURN_HOLD_MS - 1 - monoNow());
    expect(window.read().lastChurnMonotonicMs).toBe(heldUntilMs);
    expect(holds.churn(window.read(), monoNow())).toBe(true);
    vi.advanceTimersByTime(1);
    expect(holds.churn(window.read(), monoNow())).toBe(false);
  });

  it('a 2 s pause inside the send that completes a flood cannot lose it: held from the first read after', () => {
    const detector = new OutboundFloodDetector();
    const holds = new WindowedReasonHolds();
    const firstMs = monoNow();
    detector.record(FLOOD_DEST);
    vi.advanceTimersByTime(OUTBOUND_FLOOD_WINDOW_MS / 2);
    for (let sent = 2; sent < OUTBOUND_FLOOD_THRESHOLD; sent += 1) detector.record(FLOOD_DEST);
    vi.advanceTimersByTime(OUTBOUND_FLOOD_WINDOW_MS / 2);
    let flooding = false;
    withPauseAfterFirstClockRead(2_000, () => { flooding = detector.record(FLOOD_DEST).flooding; });
    // The last send at (wall 300000, monotonic 302000): base counts all 20.
    expect(flooding).toBe(true);
    vi.advanceTimersByTime(1);
    const stats = detector.stats(Date.now());
    expect(stats).toMatchObject({ flooding: false, worstCount: OUTBOUND_FLOOD_THRESHOLD - 1 });
    expect(holds.flood(stats, monoNow())).toBe(true);
    const heldUntilMs = firstMs + OUTBOUND_FLOOD_WINDOW_MS + FLOOD_DRIFT_MS;
    vi.advanceTimersByTime(heldUntilMs + OUTBOUND_FLOOD_HOLD_MS - 1 - monoNow());
    expect(detector.stats(Date.now()).lastFloodingMonotonicMs).toBe(heldUntilMs);
    expect(holds.flood(detector.stats(Date.now()), monoNow())).toBe(true);
    vi.advanceTimersByTime(1);
    expect(holds.flood(detector.stats(Date.now()), monoNow())).toBe(false);
  });

  // Base may count the oldest disconnect until one window after either read
  // inside its record; the hold must run from the later one.
  it('a pause between the two clock reads of the oldest counted disconnect lengthens the hold, never shortens it', () => {
    const window = makeDisconnectWindow();
    const holds = new WindowedReasonHolds();
    withPauseAfterFirstClockRead(2_000, () => window.disconnect());
    const pauseEndMs = monoNow();
    vi.advanceTimersByTime(MINUTE_MS);
    window.disconnect();
    vi.advanceTimersByTime(MINUTE_MS);
    window.disconnect();
    expect(holds.churn(window.read(), monoNow())).toBe(true);
    const heldUntilMs = pauseEndMs + CHURN_WINDOW_MS + CHURN_DRIFT_MS;
    vi.advanceTimersByTime(heldUntilMs + CONNECTION_CHURN_HOLD_MS - 1 - monoNow());
    expect(window.read().lastChurnMonotonicMs).toBe(heldUntilMs);
    expect(holds.churn(window.read(), monoNow())).toBe(true);
    vi.advanceTimersByTime(1);
    expect(holds.churn(window.read(), monoNow())).toBe(false);
  });

  const spreads = [
    { spread: 'within the window', withinWindow: true },
    { spread: 'over the window by 2 s', withinWindow: false },
  ];

  it.each(spreads)('with performance frozen, three disconnects $spread are detected exactly as base counts them', ({ withinWindow }) => {
    const window = makeDisconnectWindow();
    const gapMs = withinWindow ? CHURN_WINDOW_MS / 2 - 5_000 : CHURN_WINDOW_MS / 2 + 1_000;
    const perfSpy = vi.spyOn(performance, 'now').mockReturnValue(monoNow());
    try {
      let baseCounted = false;
      for (let n = 0; n < RECENT_DISCONNECT_DEGRADED_THRESHOLD; n += 1) {
        if (n > 0) vi.advanceTimersByTime(gapMs);
        window.disconnect();
        baseCounted ||= window.read().count >= RECENT_DISCONNECT_DEGRADED_THRESHOLD;
      }
      expect(baseCounted).toBe(withinWindow);
      expect(window.read().lastChurnMonotonicMs !== null).toBe(withinWindow);
    } finally {
      perfSpy.mockRestore();
    }
  });

  it.each(spreads)('with performance frozen, threshold sends $spread are detected exactly as base counts them', ({ withinWindow }) => {
    const detector = new OutboundFloodDetector();
    const gapMs = withinWindow ? OUTBOUND_FLOOD_WINDOW_MS / 2 - 2_500 : OUTBOUND_FLOOD_WINDOW_MS / 2 + 1_000;
    const perfSpy = vi.spyOn(performance, 'now').mockReturnValue(monoNow());
    try {
      detector.record(FLOOD_DEST);
      vi.advanceTimersByTime(gapMs);
      for (let sent = 2; sent < OUTBOUND_FLOOD_THRESHOLD; sent += 1) detector.record(FLOOD_DEST);
      vi.advanceTimersByTime(gapMs);
      expect(detector.record(FLOOD_DEST).flooding).toBe(withinWindow);
      expect(detector.stats(Date.now()).lastFloodingMonotonicMs !== null).toBe(withinWindow);
    } finally {
      perfSpy.mockRestore();
    }
  });

  // performance jumps 10 s ahead before each later entry while the wall clock
  // moves normally, so the monotonic span is 20 s longer than base's. The
  // hold is then floored at the entry that completed the episode.
  it.each(spreads)('with performance jumping 10 s ahead, three disconnects $spread are detected exactly as base counts them', ({ withinWindow }) => {
    const window = makeDisconnectWindow();
    const gapMs = withinWindow ? CHURN_WINDOW_MS / 2 - 5_000 : CHURN_WINDOW_MS / 2 + 1_000;
    let baseCounted = false;
    let lastMs = 0;
    for (let n = 0; n < RECENT_DISCONNECT_DEGRADED_THRESHOLD; n += 1) {
      if (n > 0) {
        vi.advanceTimersByTime(gapMs + 10_000);
        vi.setSystemTime(Date.now() - 10_000);
      }
      lastMs = monoNow();
      window.disconnect();
      baseCounted ||= window.read().count >= RECENT_DISCONNECT_DEGRADED_THRESHOLD;
    }
    expect(baseCounted).toBe(withinWindow);
    // Read once any hold has passed its held-until.
    vi.advanceTimersByTime(CHURN_WINDOW_MS + CHURN_DRIFT_MS + MINUTE_MS);
    expect(window.read().lastChurnMonotonicMs).toBe(withinWindow ? lastMs : null);
  });

  it.each(spreads)('with performance jumping 10 s ahead, threshold sends $spread are detected exactly as base counts them', ({ withinWindow }) => {
    const detector = new OutboundFloodDetector();
    const gapMs = withinWindow ? OUTBOUND_FLOOD_WINDOW_MS / 2 - 2_500 : OUTBOUND_FLOOD_WINDOW_MS / 2 + 1_000;
    const jump = (): void => {
      vi.advanceTimersByTime(gapMs + 10_000);
      vi.setSystemTime(Date.now() - 10_000);
    };
    detector.record(FLOOD_DEST);
    jump();
    for (let sent = 2; sent < OUTBOUND_FLOOD_THRESHOLD; sent += 1) detector.record(FLOOD_DEST);
    jump();
    const lastMs = monoNow();
    expect(detector.record(FLOOD_DEST).flooding).toBe(withinWindow);
    vi.advanceTimersByTime(OUTBOUND_FLOOD_WINDOW_MS + FLOOD_DRIFT_MS + MINUTE_MS);
    expect(detector.stats(Date.now()).lastFloodingMonotonicMs).toBe(withinWindow ? lastMs : null);
  });

  it('five disconnects in the window hold from the third-newest, not the oldest', () => {
    const window = makeDisconnectWindow();
    const holds = new WindowedReasonHolds();
    const startMs = monoNow();
    for (let minute = 0; minute <= 4; minute += 1) {
      if (minute > 0) vi.advanceTimersByTime(MINUTE_MS);
      window.disconnect();
    }
    // Base counts 3 until the third-newest (minute 2) leaves the window. The
    // first read comes just after.
    vi.advanceTimersByTime(startMs + 2 * MINUTE_MS + CHURN_WINDOW_MS + 1 - monoNow());
    const stats = window.read();
    expect(stats.count).toBe(2);
    expect(holds.churn(stats, monoNow())).toBe(true);
    const heldUntilMs = startMs + 2 * MINUTE_MS + CHURN_WINDOW_MS + CHURN_DRIFT_MS;
    vi.advanceTimersByTime(heldUntilMs + CONNECTION_CHURN_HOLD_MS - 1 - monoNow());
    expect(window.read().lastChurnMonotonicMs).toBe(heldUntilMs);
    expect(holds.churn(window.read(), monoNow())).toBe(true);
    vi.advanceTimersByTime(1);
    expect(holds.churn(window.read(), monoNow())).toBe(false);
  });

  it('twenty-two sends in the window hold from the twentieth-newest, not the oldest', () => {
    const detector = new OutboundFloodDetector();
    const holds = new WindowedReasonHolds();
    const startMs = monoNow();
    for (let sent = 0; sent < OUTBOUND_FLOOD_THRESHOLD + 2; sent += 1) {
      if (sent > 0) vi.advanceTimersByTime(1_000);
      detector.record(FLOOD_DEST);
    }
    // Base counts 20 until the twentieth-newest (the third send, at 2 s)
    // leaves the window. The first read comes just after.
    vi.advanceTimersByTime(startMs + 2_000 + OUTBOUND_FLOOD_WINDOW_MS + 1 - monoNow());
    const stats = detector.stats(Date.now());
    expect(stats).toMatchObject({ flooding: false, worstCount: OUTBOUND_FLOOD_THRESHOLD - 1 });
    expect(holds.flood(stats, monoNow())).toBe(true);
    const heldUntilMs = startMs + 2_000 + OUTBOUND_FLOOD_WINDOW_MS + FLOOD_DRIFT_MS;
    vi.advanceTimersByTime(heldUntilMs + OUTBOUND_FLOOD_HOLD_MS - 1 - monoNow());
    expect(detector.stats(Date.now()).lastFloodingMonotonicMs).toBe(heldUntilMs);
    expect(holds.flood(detector.stats(Date.now()), monoNow())).toBe(true);
    vi.advanceTimersByTime(1);
    expect(holds.flood(detector.stats(Date.now()), monoNow())).toBe(false);
  });

  // An entry this process did not record (as a reload would leave it) has
  // no monotonic instant, so its age on that clock is unknown.
  it('a counted disconnect without a monotonic instant holds churn one window, plus the drift extension, from detection', () => {
    const window = makeDisconnectWindow();
    window.addUnrecorded();
    vi.advanceTimersByTime(MINUTE_MS);
    for (let n = 0; n < RECENT_DISCONNECT_DEGRADED_THRESHOLD; n += 1) {
      if (n > 0) vi.advanceTimersByTime(MINUTE_MS);
      window.disconnect();
    }
    // The last disconnect makes 4 counted, one of them without an instant.
    const lastMs = monoNow();
    expect(window.read().count).toBe(RECENT_DISCONNECT_DEGRADED_THRESHOLD + 1);
    const heldUntilMs = lastMs + CHURN_WINDOW_MS + CHURN_DRIFT_MS;
    vi.advanceTimersByTime(heldUntilMs + 1 - monoNow());
    expect(window.read().lastChurnMonotonicMs).toBe(heldUntilMs);
  });
});

// A wall-clock step does not move a hold already recorded on the monotonic
// clock. It moves base's own wall-clock windows (count, flooding), which alone
// decide whether churn or a flood exists, exactly as in base.
describe('wall clock steps', () => {
  it('the fake clocks model a step: setSystemTime moves only the wall clock', () => {
    const wallMs = Date.now();
    const startMs = monoNow();
    vi.setSystemTime(wallMs - 60 * MINUTE_MS);
    expect(Date.now()).toBe(wallMs - 60 * MINUTE_MS);
    expect(monoNow()).toBe(startMs);
    vi.advanceTimersByTime(MINUTE_MS);
    expect(Date.now()).toBe(wallMs - 59 * MINUTE_MS);
    expect(monoNow()).toBe(startMs + MINUTE_MS);
  });

  it('a new churn episode after a backward step is held until one hold after its own held-until', () => {
    const window = makeDisconnectWindow();
    const holds = new WindowedReasonHolds();
    vi.setSystemTime(NOON_MS);
    // 12:00: three disconnects, held until 12:10; healthy at 12:21.
    for (let n = 0; n < RECENT_DISCONNECT_DEGRADED_THRESHOLD; n += 1) window.disconnect();
    expect(holds.churn(window.read(), monoNow())).toBe(true);
    vi.advanceTimersByTime(21 * MINUTE_MS);
    expect(holds.churn(window.read(), monoNow())).toBe(false);
    // Stepped back to 11:21; three new disconnects at 11:25.
    vi.setSystemTime(Date.now() - 60 * MINUTE_MS);
    expect(holds.churn(window.read(), monoNow())).toBe(false);
    vi.advanceTimersByTime(4 * MINUTE_MS);
    const episodeMs = monoNow();
    for (let n = 0; n < RECENT_DISCONNECT_DEGRADED_THRESHOLD; n += 1) window.disconnect();
    // 11:36: the window has emptied, and the episode held until 11:35 plus
    // the drift extension.
    vi.advanceTimersByTime(11 * MINUTE_MS);
    const stats = window.read();
    const heldUntilMs = episodeMs + CHURN_WINDOW_MS + CHURN_DRIFT_MS;
    expect(stats).toMatchObject({ count: 0, lastChurnMonotonicMs: heldUntilMs });
    expect(holds.churn(stats, monoNow())).toBe(true);
    vi.advanceTimersByTime(heldUntilMs + CONNECTION_CHURN_HOLD_MS - 1 - monoNow());
    expect(holds.churn(window.read(), monoNow())).toBe(true);
    vi.advanceTimersByTime(1);
    expect(holds.churn(window.read(), monoNow())).toBe(false);
  });

  it('a new flood to another destination after a backward step is held until one hold after its own held-until', () => {
    const detector = new OutboundFloodDetector();
    const holds = new WindowedReasonHolds();
    vi.setSystemTime(NOON_MS);
    // 12:00: a burst, flooding until 12:05; healthy at 12:11.
    for (let sent = 0; sent < OUTBOUND_FLOOD_THRESHOLD; sent += 1) detector.record(FLOOD_DEST, Date.now());
    expect(holds.flood(detector.stats(Date.now()), monoNow())).toBe(true);
    vi.advanceTimersByTime(11 * MINUTE_MS);
    expect(holds.flood(detector.stats(Date.now()), monoNow())).toBe(false);
    // Stepped back to 11:11; a burst to another destination at 11:15.
    vi.setSystemTime(Date.now() - 60 * MINUTE_MS);
    expect(holds.flood(detector.stats(Date.now()), monoNow())).toBe(false);
    vi.advanceTimersByTime(4 * MINUTE_MS);
    const burstMs = monoNow();
    for (let sent = 0; sent < OUTBOUND_FLOOD_THRESHOLD; sent += 1) detector.record(SECOND_FLOOD_DEST, Date.now());
    // 11:21: its sends have left the window, and it flooded until 11:20 plus
    // the drift extension.
    vi.advanceTimersByTime(6 * MINUTE_MS);
    const stats = detector.stats(Date.now());
    const heldUntilMs = burstMs + OUTBOUND_FLOOD_WINDOW_MS + FLOOD_DRIFT_MS;
    expect(stats).toMatchObject({ flooding: false, lastFloodingMonotonicMs: heldUntilMs });
    expect(holds.flood(stats, monoNow())).toBe(true);
    vi.advanceTimersByTime(heldUntilMs + OUTBOUND_FLOOD_HOLD_MS - 1 - monoNow());
    expect(holds.flood(detector.stats(Date.now()), monoNow())).toBe(true);
    vi.advanceTimersByTime(1);
    expect(holds.flood(detector.stats(Date.now()), monoNow())).toBe(false);
  });

  it('cleared churn and flood stay clear at every read after a backward step', () => {
    const window = makeDisconnectWindow();
    const detector = new OutboundFloodDetector();
    const holds = new WindowedReasonHolds();
    vi.setSystemTime(NOON_MS);
    for (let n = 0; n < RECENT_DISCONNECT_DEGRADED_THRESHOLD; n += 1) window.disconnect();
    for (let sent = 0; sent < OUTBOUND_FLOOD_THRESHOLD; sent += 1) detector.record(FLOOD_DEST, Date.now());
    expect(holds.churn(window.read(), monoNow())).toBe(true);
    expect(holds.flood(detector.stats(Date.now()), monoNow())).toBe(true);
    vi.advanceTimersByTime(21 * MINUTE_MS);
    expect(holds.churn(window.read(), monoNow())).toBe(false);
    expect(holds.flood(detector.stats(Date.now()), monoNow())).toBe(false);

    // Stepped back an hour, and read every minute past the old held-untils.
    vi.setSystemTime(Date.now() - 60 * MINUTE_MS);
    for (let minute = 0; minute <= 70; minute += 1) {
      expect(holds.churn(window.read(), monoNow()), `churn, minute ${minute}`).toBe(false);
      expect(holds.flood(detector.stats(Date.now()), monoNow()), `flood, minute ${minute}`).toBe(false);
      vi.advanceTimersByTime(MINUTE_MS);
    }
  });

  it('a forward step does not end detected churn or flood early: each holds until one hold after its held-until', () => {
    const window = makeDisconnectWindow();
    const detector = new OutboundFloodDetector();
    const holds = new WindowedReasonHolds();
    const startMs = monoNow();
    for (let n = 0; n < RECENT_DISCONNECT_DEGRADED_THRESHOLD; n += 1) window.disconnect();
    for (let sent = 0; sent < OUTBOUND_FLOOD_THRESHOLD; sent += 1) detector.record(FLOOD_DEST, Date.now());
    // An hour forward: base's wall-clock windows drop every entry.
    vi.setSystemTime(Date.now() + 60 * MINUTE_MS);
    expect(window.read().count).toBe(0);
    expect(detector.stats(Date.now()).flooding).toBe(false);
    const churnClearAtMs = startMs + CHURN_WINDOW_MS + CHURN_DRIFT_MS + CONNECTION_CHURN_HOLD_MS;
    const floodClearAtMs = startMs + OUTBOUND_FLOOD_WINDOW_MS + FLOOD_DRIFT_MS + OUTBOUND_FLOOD_HOLD_MS;
    for (let minute = 0; minute <= 25; minute += 1) {
      expect(holds.churn(window.read(), monoNow()), `churn, minute ${minute}`).toBe(monoNow() < churnClearAtMs);
      expect(holds.flood(detector.stats(Date.now()), monoNow()), `flood, minute ${minute}`)
        .toBe(monoNow() < floodClearAtMs);
      vi.advanceTimersByTime(MINUTE_MS);
    }
  });

  it('base\'s wall-clock count and flooding still count entries a backward step leaves later than now, as base: fail-closed', () => {
    const window = makeDisconnectWindow();
    const detector = new OutboundFloodDetector();
    const holds = new WindowedReasonHolds();
    vi.setSystemTime(NOON_MS);
    for (let n = 0; n < RECENT_DISCONNECT_DEGRADED_THRESHOLD; n += 1) window.disconnect();
    for (let sent = 0; sent < OUTBOUND_FLOOD_THRESHOLD; sent += 1) detector.record(FLOOD_DEST, Date.now());
    vi.advanceTimersByTime(MINUTE_MS);
    // Stepped back to 11:01: the 12:00 entries are later than now.
    vi.setSystemTime(NOON_MS - 59 * MINUTE_MS);
    expect(window.read().count).toBe(3);
    expect(detector.stats(Date.now()).flooding).toBe(true);
    // Each reason stays held until one hold after base's window drops the
    // entries, timed by the wall clock passing them: 12:20 and 12:10.
    const wallMinute = (): number => (Date.now() - NOON_MS) / MINUTE_MS;
    while (Date.now() < NOON_MS + 25 * MINUTE_MS) {
      expect(holds.churn(window.read(), monoNow()), `churn at ${wallMinute()}`).toBe(wallMinute() < 20);
      expect(holds.flood(detector.stats(Date.now()), monoNow()), `flood at ${wallMinute()}`).toBe(wallMinute() < 10);
      vi.advanceTimersByTime(MINUTE_MS);
    }
  });

  it('a flap continuing across a backward step reads held throughout', () => {
    const window = makeDisconnectWindow();
    const holds = new WindowedReasonHolds();
    let dippedAfterStep = false;
    // A disconnect every 4 minutes, read every minute; at minute 21 the
    // wall clock steps back 30 minutes and the flap goes on.
    for (let minute = 0; minute <= 70; minute += 1) {
      if (minute === 21) vi.setSystemTime(Date.now() - 30 * MINUTE_MS);
      if (minute % 4 === 0) window.disconnect();
      const stats = window.read();
      const held = holds.churn(stats, monoNow());
      if (minute >= 8) expect(held, `minute ${minute}`).toBe(true);
      if (minute > 21 && stats.count < RECENT_DISCONNECT_DEGRADED_THRESHOLD) dippedAfterStep = true;
      vi.advanceTimersByTime(MINUTE_MS);
    }
    expect(dippedAfterStep, 'the window never dipped below the threshold after the step').toBe(true);
  });

  // Detection is base's: entries a forward step drops can no longer complete
  // an episode, exactly as base's count no longer sees them.
  it('a forward step between disconnects stops churn from being detected, as base\'s count does', () => {
    const window = makeDisconnectWindow();
    const holds = new WindowedReasonHolds();
    window.disconnect();
    vi.advanceTimersByTime(MINUTE_MS);
    window.disconnect();
    vi.setSystemTime(Date.now() + 60 * MINUTE_MS);
    vi.advanceTimersByTime(MINUTE_MS);
    window.disconnect();
    const stats = window.read();
    expect(stats).toMatchObject({ count: 1, lastChurnMonotonicMs: null });
    expect(holds.churn(stats, monoNow())).toBe(false);
  });

  // Sparse reads after a backward step: base's count still holds the
  // stepped-over disconnects, but only a read refreshes the hold from it.
  it.each([
    { reads: 'only right after the step', readAtMinutes: [1], heldAtMinute71: false },
    { reads: 'right after the step and while base still counts', readAtMinutes: [1, 69], heldAtMinute71: true },
  ])('after a backward step with reads $reads, churn clears one hold after the last read base counted it, or after its held-until if later', ({ readAtMinutes, heldAtMinute71 }) => {
    const window = makeDisconnectWindow();
    const holds = new WindowedReasonHolds();
    vi.setSystemTime(NOON_MS);
    const startMs = monoNow();
    // 12:00: three disconnects. 12:01: stepped back to 11:01, so base counts
    // them until the wall clock reaches 12:10, 69 minutes later.
    for (let n = 0; n < RECENT_DISCONNECT_DEGRADED_THRESHOLD; n += 1) window.disconnect();
    vi.advanceTimersByTime(MINUTE_MS);
    vi.setSystemTime(NOON_MS - 59 * MINUTE_MS);
    const at = (minute: number): void => { vi.advanceTimersByTime(startMs + minute * MINUTE_MS - monoNow()); };
    for (const minute of readAtMinutes) {
      at(minute);
      const stats = window.read();
      expect(stats.count, `minute ${minute}`).toBe(RECENT_DISCONNECT_DEGRADED_THRESHOLD);
      expect(holds.churn(stats, monoNow()), `minute ${minute}`).toBe(true);
    }
    // 12:11 on the wall clock: base's window has dropped them.
    at(71);
    const stats = window.read();
    expect(stats.count).toBe(0);
    expect(holds.churn(stats, monoNow())).toBe(heldAtMinute71);
    if (heldAtMinute71) {
      at(69 + CONNECTION_CHURN_HOLD_MS / MINUTE_MS);
      expect(holds.churn(window.read(), monoNow() - 1)).toBe(true);
      expect(holds.churn(window.read(), monoNow())).toBe(false);
    }
  });
});
