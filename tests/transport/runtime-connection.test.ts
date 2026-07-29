import { describe, expect, it } from 'vitest';
import { isFullyConnected } from '../../src/transport/runtime-connection.ts';
import type { ConnectionStateSnapshot } from '../../src/transport/connection.ts';

type ReadinessSnapshot = Pick<ConnectionStateSnapshot, 'connected' | 'state'>;

const readinessCases: Array<readonly [ReadinessSnapshot, boolean]> = [
  [{ state: 'disconnected', connected: false }, false],
  [{ state: 'disconnected', connected: true }, false],
  [{ state: 'connecting', connected: false }, false],
  [{ state: 'connecting', connected: true }, false],
  [{ state: 'connected', connected: false }, false],
  [{ state: 'connected', connected: true }, true],
  [{ state: 'reconnecting', connected: false }, false],
  [{ state: 'reconnecting', connected: true }, false],
  [{ state: 'cooldown', connected: false }, false],
  [{ state: 'cooldown', connected: true }, false],
  [{ state: 'shutting_down', connected: false }, false],
  [{ state: 'shutting_down', connected: true }, false],
];

describe('isFullyConnected', () => {
  it.each(readinessCases)('returns %s for %o', (snapshot, expected) => {
    expect(isFullyConnected(snapshot)).toBe(expected);
  });
});
