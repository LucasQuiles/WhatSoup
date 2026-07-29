import { describe, expect, it } from 'vitest';
import * as runtimeConnection from '../../src/transport/runtime-connection.ts';
import type { ConnectionLifecycleState, ConnectionStateSnapshot } from '../../src/transport/connection.ts';

type ReadinessSnapshot = Pick<ConnectionStateSnapshot, 'connected' | 'state'>;

const isFullyConnected = (runtimeConnection as {
  isFullyConnected?: (snapshot: ReadinessSnapshot) => boolean;
}).isFullyConnected;

const lifecycleStates: ConnectionLifecycleState[] = [
  'disconnected',
  'connecting',
  'connected',
  'reconnecting',
  'cooldown',
  'shutting_down',
];

describe('isFullyConnected', () => {
  it.each(lifecycleStates.flatMap((state) => [
    { state, connected: false },
    { state, connected: true },
  ]))('accepts only connected=true with state=connected: %o', (snapshot) => {
    expect(isFullyConnected?.(snapshot) === true).toBe(
      snapshot.connected === true && snapshot.state === 'connected',
    );
  });
});
