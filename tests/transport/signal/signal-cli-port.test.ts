import net, { type Server, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSocketConnection,
  SignalCliPort,
  type SignalRpcConnection,
} from '../../../src/transport/signal/signal-cli-port.ts';
import { DEFAULT_SIGNAL, type SignalConfig } from '../../../src/transport/signal/types.ts';
import type { SignalPortError } from '../../../src/transport/signal/port.ts';
import { SignalAdapter } from '../../../src/transport/signal/adapter.ts';
import { makeChannelId } from '../../../src/core/transport-refs.ts';

interface RpcFrame {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

function config(overrides: Partial<SignalConfig> = {}): SignalConfig {
  return {
    account: 'test',
    phoneNumber: '+15551110000',
    socketPath: '/tmp/signalc-test.sock',
    ...DEFAULT_SIGNAL,
    ...overrides,
  };
}

class ScriptedConnection implements SignalRpcConnection {
  readonly calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  closeCalls = 0;

  constructor(private readonly handler: (method: string, params?: Record<string, unknown>) => unknown) {}

  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params });
    return this.handler(method, params);
  }

  close(): void {
    this.closeCalls += 1;
  }
}

describe('SignalCliPort — RPC contract', () => {
  it('fails closed when send returns no canonical timestamp', async () => {
    const rpc = new ScriptedConnection(() => ({}));
    const port = new SignalCliPort(config(), () => rpc);

    await expect(port.send({ recipient: '+15559990000', body: 'hello' })).rejects.toMatchObject({
      code: 'MalformedResponse',
      status: 502,
    });
  });

  it('uses the real remoteDelete RPC instead of reaction removal', async () => {
    const rpc = new ScriptedConnection(() => ({}));
    const port = new SignalCliPort(config(), () => rpc);

    await port.remoteDelete({ recipient: '+15559990000', targetTimestamp: 12345 });

    expect(rpc.calls).toEqual([{
      method: 'remoteDelete',
      params: { recipient: ['+15559990000'], targetTimestamp: 12345 },
    }]);
  });

  it('uses signal-cli JSON-RPC parameter names for portable extensions', async () => {
    const rpc = new ScriptedConnection(() => ({}));
    const port = new SignalCliPort(config(), () => rpc);

    await port.sendReaction({
      targetTimestamp: 12345,
      targetAuthor: '+15559990000',
      targetInGroup: false,
      emoji: '👍',
      remove: false,
    });
    await port.sendReadReceipts({ target: '+15559990000', timestamps: [12345] });
    await port.sendTypingIndicator({ target: '+15559990000', composing: false });
    await port.sendTypingIndicator({ groupId: 'Z3JvdXAtY29udmVyc2F0aW9u', composing: true });

    expect(rpc.calls).toEqual([
      {
        method: 'sendReaction',
        params: {
          recipients: ['+15559990000'],
          targetAuthor: '+15559990000',
          targetTimestamp: 12345,
          emoji: '👍',
        },
      },
      {
        method: 'sendReceipt',
        params: {
          recipient: '+15559990000',
          type: 'read',
          targetTimestamp: 12345,
        },
      },
      {
        method: 'sendTyping',
        params: { recipient: ['+15559990000'], stop: true },
      },
      {
        method: 'sendTyping',
        params: { groupId: 'Z3JvdXAtY29udmVyc2F0aW9u' },
      },
    ]);
  });

  it('uses the daemon receive RPC for bounded polling', async () => {
    const rpc = new ScriptedConnection(() => []);
    const port = new SignalCliPort(config(), () => rpc);

    await port.listInboundSince(new Date(0), 500);

    expect(rpc.calls).toEqual([{
      method: 'receive',
      params: { timeout: 1, maxMessages: 500 },
    }]);
  });

  it('bounds each destructive provider receive call without retaining an unbounded RAM page', async () => {
    const providerQueue = Array.from({ length: 502 }, (_, index) => ({
      envelope: {
        sourceUuid: `sender-${index}`,
        timestamp: index + 1,
        dataMessage: { message: `message-${index}` },
      },
    }));
    const rpc = new ScriptedConnection((method, params) => {
      if (method !== 'receive') return {};
      return providerQueue.splice(0, params?.['maxMessages'] as number);
    });
    const port = new SignalCliPort(config(), () => rpc);

    const first = await port.listInboundSince(new Date(0), 500);
    const second = await port.listInboundSince(new Date(500), 500);

    expect(first).toHaveLength(500);
    expect(second.map((row) => row.timestamp)).toEqual([501, 502]);
    expect(rpc.calls.filter((call) => call.method === 'receive')).toEqual([
      { method: 'receive', params: { timeout: 1, maxMessages: 500 } },
      { method: 'receive', params: { timeout: 1, maxMessages: 500 } },
    ]);
  });

  it('does not discard a newly drained envelope whose timestamp is older than a prior batch', async () => {
    const batches = [
      [{ envelope: { sourceUuid: 'future-peer', timestamp: 9_000, dataMessage: { message: 'future' } } }],
      [{ envelope: { sourceUuid: 'older-peer', timestamp: 100, dataMessage: { message: 'older' } } }],
    ];
    const rpc = new ScriptedConnection(() => batches.shift() ?? []);
    const port = new SignalCliPort(config(), () => rpc);

    const first = await port.listInboundSince(new Date(0), 500);
    const second = await port.listInboundSince(new Date(9_000), 500);

    expect(first.map((row) => row.timestamp)).toEqual([9_000]);
    expect(second.map((row) => row.timestamp)).toEqual([100]);
  });

  it('drops malformed provider envelopes instead of synthesizing timestamp or identity fields', async () => {
    const rpc = new ScriptedConnection(() => [
      { envelope: { sourceUuid: 'missing-timestamp', dataMessage: { message: 'drop' } } },
      { envelope: { sourceUuid: 'zero-timestamp', timestamp: 0, dataMessage: { message: 'drop' } } },
      { envelope: { sourceUuid: '', timestamp: 1, dataMessage: { message: 'drop' } } },
      { envelope: { timestamp: 2, dataMessage: { message: 'drop' } } },
      { envelope: { timestamp: 3, syncMessage: { sentMessage: { message: 'drop' } } } },
      { envelope: { sourceUuid: 'valid-source', timestamp: 4, dataMessage: { message: 'keep' } } },
    ]);
    const port = new SignalCliPort(config(), () => rpc);

    await expect(port.listInboundSince(new Date(0))).resolves.toEqual([
      expect.objectContaining({ timestamp: 4, source: 'valid-source', body: 'keep' }),
    ]);
  });

  it('uses a provider E.164 identity when exposed and otherwise falls back to UUID', async () => {
    const uuid = '01234567-89ab-cdef-0123-456789abcdef';
    const rpc = new ScriptedConnection(() => [
      {
        envelope: {
          sourceUuid: uuid,
          sourceNumber: '+15559990000',
          timestamp: 10,
          dataMessage: { message: 'number-visible' },
        },
      },
      {
        envelope: {
          sourceUuid: uuid,
          timestamp: 11,
          dataMessage: { message: 'number-private' },
        },
      },
      {
        envelope: {
          timestamp: 12,
          syncMessage: {
            sentMessage: {
              timestamp: 12,
              destinationNumber: '+15558880000',
              destinationUuid: uuid,
              message: 'echo',
            },
          },
        },
      },
    ]);
    const port = new SignalCliPort(config(), () => rpc);

    const rows = await port.listInboundSince(new Date(0));

    expect(rows.map((row) => [row.source, row.destination])).toEqual([
      ['+15559990000', '+15551110000'],
      [uuid, '+15551110000'],
      ['+15551110000', '+15558880000'],
    ]);
  });

  it('fails closed when the provider ignores the receive bound', async () => {
    const rpc = new ScriptedConnection(() => Array.from({ length: 3 }, () => ({ envelope: {} })));
    const port = new SignalCliPort(config(), () => rpc);

    await expect(port.listInboundSince(new Date(0), 2)).rejects.toMatchObject({
      code: 'MalformedResponse',
      status: 502,
    });
  });

  it('probes the account-bound single-account daemon through listDevices', async () => {
    const rpc = new ScriptedConnection(() => []);
    const port = new SignalCliPort(config(), () => rpc);

    await port.verifyCredentials();

    expect(rpc.calls).toEqual([{ method: 'listDevices', params: undefined }]);
  });

  it('rejects a malformed listDevices response', async () => {
    const rpc = new ScriptedConnection(() => ({}));
    const port = new SignalCliPort(config(), () => rpc);

    await expect(port.verifyCredentials()).rejects.toMatchObject({
      code: 'MalformedResponse',
      status: 502,
    });
  });

  it('rejects missing, dual, and non-loopback endpoints at direct construction', () => {
    expect(() => new SignalCliPort(config({ socketPath: undefined }))).toThrow(/exactly one/);
    expect(() => new SignalCliPort(config({ tcpPort: 7583 }))).toThrow(/exactly one/);
    expect(() => new SignalCliPort(config({
      socketPath: undefined,
      tcpHost: '192.0.2.10',
      tcpPort: 7583,
    }))).toThrow(/loopback/);
    expect(() => new SignalCliPort(config({ socketPath: 'relative/signal.sock' })))
      .toThrow(/absolute/);
  });

  it('ignores a stale terminal callback from an older connection generation', async () => {
    const terminalCallbacks: Array<() => void> = [];
    const connections: ScriptedConnection[] = [];
    const port = new SignalCliPort(config(), (_config, onTerminal) => {
      terminalCallbacks.push(onTerminal ?? (() => undefined));
      const rpc = new ScriptedConnection(() => []);
      connections.push(rpc);
      return rpc;
    });

    await port.verifyCredentials();
    port.resetConnection();
    await port.verifyCredentials();
    terminalCallbacks[0]!();
    await port.verifyCredentials();

    expect(connections).toHaveLength(2);
    expect(connections[1]?.calls).toHaveLength(2);
  });
});

describe('signal-cli UNIX socket lifecycle', () => {
  let dir: string;
  let socketPath: string;
  const servers = new Set<Server>();
  const sockets = new Set<Socket>();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'whatsoup-signal-rpc-'));
    socketPath = join(dir, 'signal.sock');
  });

  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([...servers].map((server) => new Promise<void>((resolve) => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
    })));
    rmSync(dir, { recursive: true, force: true });
  });

  async function startServer(onFrame: (frame: RpcFrame, socket: Socket) => void): Promise<Server> {
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line !== '') onFrame(JSON.parse(line) as RpcFrame, socket);
          newline = buffer.indexOf('\n');
        }
      });
    });
    servers.add(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    return server;
  }

  async function stopServer(server: Server): Promise<void> {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    servers.delete(server);
  }

  it('parses a normal NDJSON response', async () => {
    await startServer((frame, socket) => {
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { version: 'test' } })}\n`);
    });
    const connection = createSocketConnection(config({ socketPath }));

    await expect(connection.request('version')).resolves.toEqual({ version: 'test' });
    connection.close();
  });

  it('preserves UTF-8 when a socket chunk splits a multibyte code point', async () => {
    await startServer((frame, socket) => {
      const response = Buffer.from(`${JSON.stringify({
        jsonrpc: '2.0',
        id: frame.id,
        result: { message: 'x😀y' },
      })}\n`);
      const emojiOffset = response.indexOf(Buffer.from('😀'));
      socket.write(response.subarray(0, emojiOffset + 2));
      let eventLoopTurns = 0;
      const writeRemainder = (): void => {
        if (eventLoopTurns++ < 4) {
          setImmediate(writeRemainder);
          return;
        }
        socket.write(response.subarray(emojiOffset + 2));
      };
      setImmediate(writeRemainder);
    });
    const connection = createSocketConnection(config({ socketPath }));

    await expect(connection.request('unicode')).resolves.toEqual({ message: 'x😀y' });
    connection.close();
  });

  it('uses TCP when tcpPort is configured without socketPath', async () => {
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('data', (chunk) => {
        const frame = JSON.parse(chunk.toString('utf8').trim()) as RpcFrame;
        socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: 'tcp' })}\n`);
      });
    });
    servers.add(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected TCP address');
    const connection = createSocketConnection(config({
      socketPath: undefined,
      tcpHost: '127.0.0.1',
      tcpPort: address.port,
    }));

    await expect(connection.request('version')).resolves.toBe('tcp');
    connection.close();
  });

  it('rejects every concurrent pending request promptly when the peer ends', async () => {
    await startServer((_frame, socket) => socket.end());
    const connection = createSocketConnection(config({ socketPath }));

    const requests = [connection.request('one'), connection.request('two')];

    await expect(Promise.allSettled(requests)).resolves.toEqual([
      expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ code: 'Closed' }) }),
      expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ code: 'Closed' }) }),
    ]);
  });

  it('rejects every pending request when the peer closes without an orderly end', async () => {
    await startServer((_frame, socket) => socket.destroy());
    const connection = createSocketConnection(config({ socketPath }));

    const requests = [connection.request('one'), connection.request('two')];

    const settled = await Promise.allSettled(requests);
    expect(settled).toHaveLength(2);
    expect(settled.every((result) =>
      result.status === 'rejected' && (result.reason as SignalPortError).code === 'Closed'))
      .toBe(true);
    // Pinning test (behavior already correct, no RED phase): the connection
    // reached the server and only failed AFTER 'connect' fired — contact
    // cannot be disproven for whichever request was mid-flight, so phase
    // must stay absent (the adapter's provider_call_started default then
    // applies), never over-corrected to not_started just because the peer
    // vanished.
    expect(settled.every((result) =>
      result.status === 'rejected' && !('phase' in (result.reason as SignalPortError))))
      .toBe(true);
  });

  it('rejects a pending request on a socket connection error', async () => {
    const connection = createSocketConnection(config({ socketPath }));
    await expect(connection.request('version')).rejects.toMatchObject({
      code: 'SocketError',
      status: 503,
      // No server is listening on socketPath, so this is a provable
      // pre-write failure: 'error' fires before 'connect' ever could, and
      // Node buffers (never transmits) any write() issued on an unconnected
      // socket. This is the RED case for GAP 1 — currently phase is absent.
      phase: 'not_started',
    });
  });

  it('sends phase not_started end-to-end through SignalAdapter on connection refusal', async () => {
    // No server listening on socketPath — sendText's underlying connection
    // attempt is provably refused before any request byte leaves the
    // process. The adapter must surface that as phase 'not_started' in the
    // typed payload, not the provider_call_started default.
    const port = new SignalCliPort(config({ socketPath }));
    const adapter = new SignalAdapter(config({ socketPath }), port);
    const channelId = makeChannelId('signal', 'test');

    await expect(
      adapter.sendText({ channel: channelId, id: '+15559990000' }, 'hi'),
    ).rejects.toMatchObject({
      payload: {
        code: 'transport.transient_provider',
        phase: 'not_started',
      },
    });
  });

  it('reconnects the same port after daemon shutdown and restart', async () => {
    const first = await startServer((_frame, socket) => socket.end());
    const port = new SignalCliPort(config({ socketPath }));

    await expect(port.verifyCredentials()).rejects.toMatchObject({ code: 'Closed' });
    await stopServer(first);
    await startServer((frame, socket) => {
      socket.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: frame.id,
        result: [],
      })}\n`);
    });

    await expect(port.verifyCredentials()).resolves.toBeUndefined();
    port.resetConnection();
  });

  it('resetConnection is idempotent and the next call creates one fresh socket', async () => {
    let connections = 0;
    await startServer((frame, socket) => {
      socket.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: frame.id,
        result: [],
      })}\n`);
    }).then((server) => server.on('connection', () => { connections += 1; }));
    const port = new SignalCliPort(config({ socketPath }));

    await port.verifyCredentials();
    port.resetConnection();
    port.resetConnection();
    await port.verifyCredentials();

    expect(connections).toBe(2);
    port.dispose();
  });
});
