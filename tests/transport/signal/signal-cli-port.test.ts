// tests/transport/signal/signal-cli-port.test.ts
import { describe, it, expect } from 'vitest';
import {
  SignalCliPort,
  type SignalRpcConnection,
} from '../../../src/transport/signal/signal-cli-port.ts';
import { DEFAULT_SIGNAL, type SignalConfig } from '../../../src/transport/signal/types.ts';
import type { SignalPortError } from '../../../src/transport/signal/port.ts';

// ---------------------------------------------------------------------------
// Scripted mock connection
// ---------------------------------------------------------------------------

interface RpcCall {
  method: string;
  params?: Record<string, unknown>;
}

class MockRpcConnection implements SignalRpcConnection {
  readonly calls: RpcCall[] = [];
  closeCalls = 0;
  private readonly handlers = new Map<string, (params?: Record<string, unknown>) => unknown>();

  on(method: string, handler: (params?: Record<string, unknown>) => unknown): this {
    this.handlers.set(method, handler);
    return this;
  }

  failWith(method: string, err: SignalPortError): this {
    this.handlers.set(method, () => { throw err; });
    return this;
  }

  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params });
    const handler = this.handlers.get(method);
    if (!handler) throw Object.assign(new Error(`no mock handler for ${method}`), { code: 'Unmocked' });
    return handler(params);
  }

  close(): void { this.closeCalls += 1; }
}

function makeConfig(overrides: Partial<SignalConfig> = {}): SignalConfig {
  return {
    account: 'test',
    phoneNumber: '+15551110000',
    ...DEFAULT_SIGNAL,
    ...overrides,
  };
}

function makePort(configOverrides: Partial<SignalConfig> = {}) {
  const mock = new MockRpcConnection();
  const port = new SignalCliPort(makeConfig(configOverrides), () => mock);
  return { port, mock };
}

// ---------------------------------------------------------------------------
// verifyCredentials
// ---------------------------------------------------------------------------

describe('SignalCliPort — verifyCredentials', () => {
  it('resolves when the version RPC succeeds', async () => {
    const { port, mock } = makePort();
    mock.on('version', () => ({ version: '0.13.22' }));
    await expect(port.verifyCredentials()).resolves.toBeUndefined();
    expect(mock.calls).toEqual([{ method: 'version', params: undefined }]);
  });

  it('propagates an RPC error (daemon unreachable/unlinked) as a SignalPortError', async () => {
    const { port, mock } = makePort();
    mock.failWith('version', { message: 'Connection refused', code: 'SocketError', status: 503 });
    await expect(port.verifyCredentials()).rejects.toMatchObject({
      message: 'Connection refused',
      code: 'SocketError',
      status: 503,
    });
  });

  it('opens the connection lazily — factory not called until first use', async () => {
    let factoryCalls = 0;
    const mock = new MockRpcConnection();
    mock.on('version', () => ({}));
    const port = new SignalCliPort(makeConfig(), () => { factoryCalls += 1; return mock; });
    expect(factoryCalls).toBe(0);
    await port.verifyCredentials();
    expect(factoryCalls).toBe(1);
    await port.verifyCredentials();
    expect(factoryCalls).toBe(1); // reused, not re-opened
  });
});

// ---------------------------------------------------------------------------
// send
// ---------------------------------------------------------------------------

describe('SignalCliPort — send', () => {
  it('sends to a 1:1 recipient with the recipient array shape', async () => {
    const { port, mock } = makePort();
    mock.on('send', () => ({ timestamp: 1718100000000 }));
    const result = await port.send({ recipient: '+15559990000', body: 'hello' });
    expect(result.timestamp).toBe(1718100000000);
    expect(mock.calls[0]).toEqual({
      method: 'send',
      params: { message: 'hello', recipient: ['+15559990000'] },
    });
  });

  it('sends to a group with the groupId shape', async () => {
    const { port, mock } = makePort();
    mock.on('send', () => ({ timestamp: 1718100000001 }));
    await port.send({ groupId: 'Zm9vYmFy', body: 'group hi' });
    expect(mock.calls[0]?.params).toEqual({ message: 'group hi', groupId: 'Zm9vYmFy' });
  });

  it('rejects recipient+groupId together', async () => {
    const { port } = makePort();
    await expect(port.send({ recipient: '+15559990000', groupId: 'Zm9v', body: 'x' }))
      .rejects.toMatchObject({ code: 'BadArgs' });
  });

  it('rejects neither recipient nor groupId', async () => {
    const { port } = makePort();
    await expect(port.send({ body: 'x' })).rejects.toMatchObject({ code: 'BadArgs' });
  });

  it('falls back to args.timestamp / Date.now when the daemon omits a timestamp', async () => {
    const { port, mock } = makePort();
    mock.on('send', () => ({}));
    const withTs = await port.send({ recipient: '+15559990000', body: 'x', timestamp: 42 });
    expect(withTs.timestamp).toBe(42);
    const without = await port.send({ recipient: '+15559990000', body: 'x' });
    expect(without.timestamp).toBeGreaterThan(0);
  });

  it('propagates daemon send failures', async () => {
    const { port, mock } = makePort();
    mock.failWith('send', { message: 'Unregistered user', code: 'UnregisteredUser' });
    await expect(port.send({ recipient: '+15559990000', body: 'x' }))
      .rejects.toMatchObject({ code: 'UnregisteredUser' });
  });
});

// ---------------------------------------------------------------------------
// listInboundSince
// ---------------------------------------------------------------------------

function dataEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    envelope: {
      sourceUuid: 'uuid-peer-1',
      timestamp: 1000,
      dataMessage: { message: 'hi' },
      ...overrides,
    },
  };
}

describe('SignalCliPort — listInboundSince', () => {
  it('normalizes inbound data envelopes (peer→us, fromMe=false)', async () => {
    const { port, mock } = makePort();
    mock.on('receive', () => [dataEnvelope()]);
    const out = await port.listInboundSince(new Date(0));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      timestamp: 1000,
      source: 'uuid-peer-1',
      destination: '+15551110000',
      body: 'hi',
      fromMe: false,
      type: 'data',
    });
    expect(mock.calls[0]).toEqual({ method: 'receive', params: { timeout: 1 } });
  });

  it('normalizes sync echoes of our own sends (fromMe=true)', async () => {
    const { port, mock } = makePort();
    mock.on('receive', () => [{
      envelope: {
        timestamp: 2000,
        syncMessage: {
          sentMessage: {
            message: 'my echo',
            destinationUuid: 'uuid-peer-9',
            timestamp: 2000,
          },
        },
      },
    }]);
    const out = await port.listInboundSince(new Date(0));
    expect(out[0]).toMatchObject({
      timestamp: 2000,
      source: '+15551110000',
      destination: 'uuid-peer-9',
      body: 'my echo',
      fromMe: true,
      type: 'sync',
    });
  });

  it('carries groupId on group envelopes', async () => {
    const { port, mock } = makePort();
    mock.on('receive', () => [dataEnvelope({
      dataMessage: { message: 'g', groupInfo: { groupId: 'Z3JvdXA=' } },
    })]);
    const out = await port.listInboundSince(new Date(0));
    expect(out[0]).toMatchObject({ groupId: 'Z3JvdXA=', destination: 'Z3JvdXA=' });
  });

  it('drops envelopes older than `since` but keeps the inclusive boundary', async () => {
    const { port, mock } = makePort();
    mock.on('receive', () => [
      dataEnvelope({ timestamp: 500 }),   // older — dropped
      dataEnvelope({ timestamp: 1000 }),  // == since — kept (at-least-once)
      dataEnvelope({ timestamp: 1500 }),  // newer — kept
    ]);
    const out = await port.listInboundSince(new Date(1000));
    expect(out.map((e) => e.timestamp)).toEqual([1000, 1500]);
  });

  it('returns results ascending by timestamp even if the daemon sends them unordered', async () => {
    const { port, mock } = makePort();
    mock.on('receive', () => [
      dataEnvelope({ timestamp: 3000 }),
      dataEnvelope({ timestamp: 1000 }),
      dataEnvelope({ timestamp: 2000 }),
    ]);
    const out = await port.listInboundSince(new Date(0));
    expect(out.map((e) => e.timestamp)).toEqual([1000, 2000, 3000]);
  });

  it('caps results at pageSize', async () => {
    const { port, mock } = makePort();
    mock.on('receive', () => [
      dataEnvelope({ timestamp: 1000 }),
      dataEnvelope({ timestamp: 2000 }),
      dataEnvelope({ timestamp: 3000 }),
    ]);
    const out = await port.listInboundSince(new Date(0), 2);
    expect(out).toHaveLength(2);
  });

  it('pageSize keeps the OLDEST envelopes when the daemon sends unordered', async () => {
    const { port, mock } = makePort();
    mock.on('receive', () => [
      dataEnvelope({ timestamp: 3000 }),
      dataEnvelope({ timestamp: 1000 }),
      dataEnvelope({ timestamp: 2000 }),
    ]);
    const out = await port.listInboundSince(new Date(0), 2);
    // Sort-then-cap: the cap must not keep the first-arriving envelope.
    expect(out.map((e) => e.timestamp)).toEqual([1000, 2000]);
  });

  it('rejects non-positive / non-integer pageSize with RangeError', async () => {
    const { port, mock } = makePort();
    mock.on('receive', () => []);
    await expect(port.listInboundSince(new Date(0), 0)).rejects.toThrow(RangeError);
    await expect(port.listInboundSince(new Date(0), -1)).rejects.toThrow(RangeError);
    await expect(port.listInboundSince(new Date(0), 1.5)).rejects.toThrow(RangeError);
  });

  it('surfaces typing envelopes as type=typing (presence)', async () => {
    const { port, mock } = makePort();
    mock.on('receive', () => [
      { envelope: { sourceUuid: 'u', timestamp: 1001, typingMessage: { action: 'STARTED' } } },
      dataEnvelope({ timestamp: 1002 }),
    ]);
    const out = await port.listInboundSince(new Date(0));
    expect(out).toHaveLength(2);
    expect(out[0]?.type).toBe('typing');
    expect(out[0]?.typing).toEqual({ composing: true });
    expect(out[1]?.timestamp).toBe(1002);
  });

  it('surfaces typing STOPPED as composing:false', async () => {
    const { port, mock } = makePort();
    mock.on('receive', () => [
      { envelope: { sourceUuid: 'u', timestamp: 1001, typingMessage: { action: 'STOPPED' } } },
    ]);
    const out = await port.listInboundSince(new Date(0));
    expect(out).toHaveLength(1);
    expect(out[0]?.typing).toEqual({ composing: false });
  });

  it('drops delivery receipts (no extension event for delivery in v1)', async () => {
    const { port, mock } = makePort();
    mock.on('receive', () => [
      { envelope: { sourceUuid: 'u', timestamp: 1001, receiptMessage: { type: 'DELIVERY', timestamps: [500] } } },
      dataEnvelope({ timestamp: 1002 }),
    ]);
    const out = await port.listInboundSince(new Date(0));
    expect(out).toHaveLength(1);
    expect(out[0]?.timestamp).toBe(1002);
  });

  it('treats a null/undefined daemon result as empty', async () => {
    const { port, mock } = makePort();
    mock.on('receive', () => undefined);
    await expect(port.listInboundSince(new Date(0))).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// sendReaction / sendReadReceipts / sendTypingIndicator
// ---------------------------------------------------------------------------

describe('SignalCliPort — sendReaction', () => {
  it('sends the reaction with target author + timestamp (1:1)', async () => {
    const { port, mock } = makePort();
    mock.on('sendReaction', () => ({}));
    await port.sendReaction({ targetTimestamp: 1718100000000, targetAuthor: 'uuid-peer-1', targetInGroup: false, emoji: '👍', remove: false });
    expect(mock.calls[0]).toEqual({
      method: 'sendReaction',
      params: { emoji: '👍', targetAuthor: 'uuid-peer-1', targetTimestamp: 1718100000000, recipient: ['uuid-peer-1'] },
    });
  });

  it('marks removals with remove:true and routes groups via groupId', async () => {
    const { port, mock } = makePort();
    mock.on('sendReaction', () => ({}));
    await port.sendReaction({ targetTimestamp: 1, targetAuthor: 'Z3JvdXA=', targetInGroup: true, emoji: '', remove: true });
    expect(mock.calls[0]?.params).toMatchObject({ remove: true, groupId: 'Z3JvdXA=' });
  });
});

describe('SignalCliPort — sendReadReceipts', () => {
  it('coalesces timestamps into one receipt', async () => {
    const { port, mock } = makePort();
    mock.on('sendReceipt', () => ({}));
    await port.sendReadReceipts({ target: 'uuid-peer-1', timestamps: [1000, 2000, 3000] });
    expect(mock.calls[0]).toEqual({
      method: 'sendReceipt',
      params: { recipient: ['uuid-peer-1'], type: 'read', targetTimestamps: [1000, 2000, 3000] },
    });
  });
});

describe('SignalCliPort — sendTypingIndicator', () => {
  it('maps composing=true to TYPING and false to STOPPED', async () => {
    const { port, mock } = makePort();
    mock.on('sendTyping', () => ({}));
    await port.sendTypingIndicator({ target: 'uuid-peer-1', composing: true });
    await port.sendTypingIndicator({ target: 'uuid-peer-1', composing: false });
    expect(mock.calls[0]?.params).toMatchObject({ when: 'TYPING' });
    expect(mock.calls[1]?.params).toMatchObject({ when: 'STOPPED' });
  });
});

// ---------------------------------------------------------------------------
// dispose
// ---------------------------------------------------------------------------

describe('SignalCliPort — dispose', () => {
  it('closes the connection and allows a fresh one on next use', async () => {
    const { port, mock } = makePort();
    mock.on('version', () => ({}));
    await port.verifyCredentials();
    port.dispose();
    expect(mock.closeCalls).toBe(1);
    port.dispose(); // idempotent
    expect(mock.closeCalls).toBe(1);
  });
});
