// tests/transport/imessage/connection-bridge.test.ts
import { describe, it, expect, vi } from 'vitest';
import { ImessageAdapter } from '../../../src/transport/imessage/adapter.ts';
import { ImessageConnection } from '../../../src/transport/imessage/connection-bridge.ts';
import { MockImessagePort, makeImessageConfig } from './mock-port.ts';

describe('ImessageConnection — shutdown', () => {
  it('disposes the provider port during shutdown (#2322 H2)', async () => {
    const port = new MockImessagePort();
    const adapter = new ImessageAdapter(makeImessageConfig({ pollIntervalMs: 0 }), port);
    const connection = new ImessageConnection(adapter, port);

    await connection.shutdown();

    expect(port.disposeCalls).toBe(1);
  });

  it('does not throw when constructed without a port (bluebubbles has none)', async () => {
    const port = new MockImessagePort();
    const adapter = new ImessageAdapter(makeImessageConfig({ pollIntervalMs: 0 }), port);
    const connection = new ImessageConnection(adapter);

    await expect(connection.shutdown()).resolves.toBeUndefined();
  });

  it('disposes the port before disconnecting the adapter, mirroring the signal bridge order', async () => {
    const port = new MockImessagePort();
    const adapter = new ImessageAdapter(makeImessageConfig({ pollIntervalMs: 0 }), port);
    const connection = new ImessageConnection(adapter, port);
    const order: string[] = [];
    const originalDispose = port.dispose.bind(port);
    vi.spyOn(port, 'dispose').mockImplementation(() => {
      order.push('port.dispose');
      originalDispose();
    });
    const disconnectSpy = vi.spyOn(adapter, 'disconnect').mockImplementation(async () => {
      order.push('adapter.disconnect');
    });

    await connection.shutdown();

    expect(order).toEqual(['port.dispose', 'adapter.disconnect']);
    disconnectSpy.mockRestore();
  });

  it('is idempotent across a double shutdown (double-dispose safety)', async () => {
    const port = new MockImessagePort();
    const adapter = new ImessageAdapter(makeImessageConfig({ pollIntervalMs: 0 }), port);
    const connection = new ImessageConnection(adapter, port);

    await connection.shutdown();
    await expect(connection.shutdown()).resolves.toBeUndefined();

    expect(port.disposeCalls).toBe(2);
  });
});
