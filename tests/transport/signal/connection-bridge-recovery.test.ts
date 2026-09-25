// tests/transport/signal/connection-bridge-recovery.test.ts
// #2394 signal_cli_unregistered recovery-handoff ownership. A successful
// connect unconditionally proves recovery (restart-safe by design), but the
// checked clear handoff can be rejected — the bridge must retain a bounded
// pending obligation and retry it on later transport activity, never by
// repeating provider connection or account-repair actions.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SignalAdapter } from '../../../src/transport/signal/adapter.ts';
import { SignalConnection } from '../../../src/transport/signal/connection-bridge.ts';
import { MockSignalPort, makeSignalConfig } from './mock-port.ts';

const emitAlert = vi.hoisted(() => vi.fn(() => true));
const clearAlertSource = vi.hoisted(() => vi.fn(() => true));

vi.mock('../../../src/lib/emit-alert.ts', () => ({
  emitAlert,
  emitAlertChecked: emitAlert,
  emitObservationChecked: vi.fn(() => true),
  clearAlertSource,
  clearAlertSourceChecked: clearAlertSource,
}));

function makeConnection(port = new MockSignalPort()) {
  const adapter = new SignalAdapter(makeSignalConfig({ pollIntervalMs: 60_000 }), port);
  const connection = new SignalConnection(adapter, undefined, 'test-signal-instance');
  return { adapter, connection };
}

function unregisteredPort(): MockSignalPort {
  return new MockSignalPort({
    verifyError: Object.assign(new Error('unregistered'), {
      code: 'NotRegisteredException',
      status: 401,
    }),
  });
}

function inboundRecord(timestamp: number) {
  return {
    timestamp,
    source: 'member-uuid',
    destination: 'Z3JvdXAtY29udmVyc2F0aW9u',
    groupId: 'Z3JvdXAtY29udmVyc2F0aW9u',
    body: 'activity',
    fromMe: false,
    type: 'data' as const,
  };
}

function syntheticAuthError(): unknown {
  return {
    payload: {
      code: 'transport.auth_required',
      providerCode: 'NotRegisteredException',
    },
  };
}

const unregisteredClears = () => clearAlertSource.mock.calls.filter(
  (call) => (call as unknown[])[1] === 'signal_cli_unregistered',
);
const unregisteredAlerts = () => emitAlert.mock.calls.filter(
  (call) => (call as unknown[])[1] === 'signal_cli_unregistered',
);

describe('signal_cli_unregistered recovery authority (#2394)', () => {
  beforeEach(() => {
    // mockReturnValue survives vi.clearAllMocks() — re-assert the durable
    // accept defaults so rejection-path tests cannot leak into later ones.
    emitAlert.mockClear();
    emitAlert.mockReturnValue(true);
    clearAlertSource.mockClear();
    clearAlertSource.mockReturnValue(true);
  });

  it('clean connects emit one idempotent recovery clear each and never stack pending work', async () => {
    const { adapter, connection } = makeConnection();

    await connection.connect();
    expect(unregisteredClears()).toHaveLength(1);

    await connection.connect();
    await connection.connect();
    expect(unregisteredClears()).toHaveLength(3);

    // All clears were accepted: transport activity adds no recovery work.
    adapter.handleInboundRecord(inboundRecord(1001));
    expect(unregisteredClears()).toHaveLength(3);
    expect(unregisteredAlerts()).toHaveLength(0);
    await connection.shutdown();
  });

  it('a rejected onset alert stays retryable on the next auth failure', async () => {
    const { connection } = makeConnection(unregisteredPort());

    emitAlert.mockReturnValueOnce(false);
    await expect(connection.connect()).rejects.toThrow();
    expect(unregisteredAlerts()).toHaveLength(1);

    // Rejection left the latch unarmed — the next failure re-emits, and its
    // acceptance arms ownership.
    await expect(connection.connect()).rejects.toThrow();
    expect(unregisteredAlerts()).toHaveLength(2);

    // Now latched: further failures do not duplicate the critical.
    await expect(connection.connect()).rejects.toThrow();
    expect(unregisteredAlerts()).toHaveLength(2);
  });

  it('a rejected recovery clear is retried on inbound activity without reconnecting', async () => {
    const { adapter, connection } = makeConnection();

    clearAlertSource.mockReturnValueOnce(false);
    await connection.connect();
    expect(unregisteredClears()).toHaveLength(1);

    // The repaired connection stays up; the next inbound message carries the
    // retry, and its acceptance resolves the obligation.
    adapter.handleInboundRecord(inboundRecord(2001));
    expect(unregisteredClears()).toHaveLength(2);

    adapter.handleInboundRecord(inboundRecord(2002));
    expect(unregisteredClears()).toHaveLength(2);
    await connection.shutdown();
  });

  it('a rejected recovery clear is retried after a successful send', async () => {
    const { connection } = makeConnection();

    clearAlertSource.mockReturnValueOnce(false);
    await connection.connect();
    expect(unregisteredClears()).toHaveLength(1);

    await connection.sendMessage('+15559990000@signal', 'hello');
    expect(unregisteredClears()).toHaveLength(2);

    await connection.sendMessage('+15559990000@signal', 'again');
    expect(unregisteredClears()).toHaveLength(2);
    await connection.shutdown();
  });

  it('continued clear rejection retries exactly once per activity and retains the obligation', async () => {
    const { adapter, connection } = makeConnection();

    clearAlertSource.mockReturnValue(false);
    await connection.connect();
    adapter.handleInboundRecord(inboundRecord(3001));
    await connection.sendMessage('+15559990000@signal', 'hello');

    expect(unregisteredClears()).toHaveLength(3);
    await connection.shutdown();
  });

  it('an accepted fresh onset invalidates a stale pending clear', async () => {
    const { adapter, connection } = makeConnection();

    clearAlertSource.mockReturnValueOnce(false);
    await connection.connect();
    expect(unregisteredClears()).toHaveLength(1);

    // The account broke again: the earlier connect's proof is no longer
    // recovery evidence and must not close the new incident.
    (connection as unknown as {
      emitUnregisteredAlert(error: unknown): void;
    }).emitUnregisteredAlert(syntheticAuthError());
    expect(unregisteredAlerts()).toHaveLength(1);

    adapter.handleInboundRecord(inboundRecord(4001));
    expect(unregisteredClears()).toHaveLength(1);
    await connection.shutdown();
  });
});
