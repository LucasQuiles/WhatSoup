import { describe, expect, it } from 'vitest';
import { deriveFleetMessageSparklines } from '../../console/src/lib/metrics-sparklines.ts';

describe('deriveFleetMessageSparklines', () => {
  it('sorts buckets and normalizes inbound/outbound series independently', () => {
    const result = deriveFleetMessageSparklines([
      { bucket: '2026-04-05T19:00:00.000Z', inbound: 2, outbound: 3 },
      { bucket: '2026-04-05T17:00:00.000Z', inbound: 1, outbound: 6 },
      { bucket: '2026-04-05T18:00:00.000Z', inbound: 4, outbound: 0 },
    ]);

    expect(result).toEqual({
      inbound: [0.25, 1, 0.5],
      outbound: [1, 0, 0.5],
    });
  });

  it('returns undefined when there is no message volume', () => {
    expect(deriveFleetMessageSparklines(undefined)).toBeUndefined();
    expect(deriveFleetMessageSparklines([])).toBeUndefined();
  });
});
