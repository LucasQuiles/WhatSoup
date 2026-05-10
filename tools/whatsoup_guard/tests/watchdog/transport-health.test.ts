import { describe, expect, it } from 'vitest';
import { detectTransportBroken } from '../../src/watchdog/transport-health.ts';

describe('detectTransportBroken', () => {
  it('reports broken when drift is accumulating with zero successful deliveries and engine is alive', () => {
    const result = detectTransportBroken({
      engineAlive: true,
      deliveriesSucceeded: 0,
      deliveriesFailed: 5,
      driftEvents: 5,
    });

    expect(result).toEqual({ broken: true, reason: 'drift accumulating with zero successful deliveries' });
  });

  it('does not report broken when there is no drift', () => {
    const result = detectTransportBroken({
      engineAlive: true,
      deliveriesSucceeded: 0,
      deliveriesFailed: 5,
      driftEvents: 0,
    });

    expect(result).toEqual({ broken: false, reason: 'no drift required delivery' });
  });

  it('does not report broken when engine is not alive', () => {
    const result = detectTransportBroken({
      engineAlive: false,
      deliveriesSucceeded: 0,
      deliveriesFailed: 5,
      driftEvents: 5,
    });

    expect(result).toEqual({ broken: false, reason: 'engine not alive - separate problem' });
  });

  it('does not report broken when at least one delivery succeeded', () => {
    const result = detectTransportBroken({
      engineAlive: true,
      deliveriesSucceeded: 1,
      deliveriesFailed: 5,
      driftEvents: 5,
    });

    expect(result).toEqual({ broken: false, reason: 'successful delivery observed' });
  });

  it('reports inconclusive when drift exists but no delivery attempts are recorded', () => {
    const result = detectTransportBroken({
      engineAlive: true,
      deliveriesSucceeded: 0,
      deliveriesFailed: 0,
      driftEvents: 3,
    });

    expect(result).toEqual({ broken: false, reason: 'drift observed without delivery attempts' });
  });
});
