import { describe, expect, it } from 'vitest';
import { detectHeartbeatSilence } from '../../src/watchdog/heartbeat.ts';

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-05-08T12:00:00.000Z');

describe('detectHeartbeatSilence', () => {
  it('does not trigger when last heartbeat is within threshold', () => {
    const result = detectHeartbeatSilence({
      now: NOW,
      lastHeartbeatTs: NOW - 4 * HOUR,
      thresholdHours: 7,
    });

    expect(result).toEqual({ silent: false, elapsedHours: 4 });
  });

  it('does not trigger at the exact threshold', () => {
    const result = detectHeartbeatSilence({
      now: NOW,
      lastHeartbeatTs: NOW - 7 * HOUR,
      thresholdHours: 7,
    });

    expect(result).toEqual({ silent: false, elapsedHours: 7 });
  });

  it('triggers when silence exceeds threshold', () => {
    const result = detectHeartbeatSilence({
      now: NOW,
      lastHeartbeatTs: NOW - 8 * HOUR,
      thresholdHours: 7,
    });

    expect(result.silent).toBe(true);
    expect(result.elapsedHours).toBe(8);
    expect(result.reason).toBe('heartbeat silence threshold exceeded');
  });

  it('triggers when there has never been a heartbeat', () => {
    const result = detectHeartbeatSilence({
      now: NOW,
      lastHeartbeatTs: undefined,
      thresholdHours: 7,
    });

    expect(result).toEqual({
      silent: true,
      elapsedHours: Infinity,
      reason: 'no heartbeat recorded',
    });
  });

  it('does not trigger when the last heartbeat timestamp is in the future', () => {
    const result = detectHeartbeatSilence({
      now: NOW,
      lastHeartbeatTs: NOW + HOUR,
      thresholdHours: 7,
    });

    expect(result).toEqual({
      silent: false,
      elapsedHours: -1,
      reason: 'last heartbeat is in the future',
    });
  });
});
