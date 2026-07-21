// tests/transport/signal/port-contract.test.ts
// Compile-time + duck-type contract for the SignalPort interface.
// The port is the seam the adapter depends on; this file pins its shape so
// any rename/narrow/widen surfaces here before the adapter breaks.
//
// A live signal-cli-backed port implementation (signal-cli-port.ts) lands
// in a follow-on; here we exercise the interface via a minimal stub.
import { describe, it, expect } from 'vitest';
import type {
  SignalPort,
  SendSignalArgs,
  InboundSignal,
  ReactSignalArgs,
  SendReadReceiptArgs,
  SendTypingArgs,
  RemoteDeleteSignalArgs,
  SignalPortError,
} from '../../../src/transport/signal/port.ts';

/** Minimal in-memory stub used to exercise the interface at compile+runtime. */
function makeStubPort(): SignalPort {
  const sent: SendSignalArgs[] = [];
  const reactions: ReactSignalArgs[] = [];
  const receipts: SendReadReceiptArgs[] = [];
  const typings: SendTypingArgs[] = [];
  const deletes: RemoteDeleteSignalArgs[] = [];
  return {
    async verifyCredentials() { /* no-op */ },
    async send(args) {
      sent.push(args);
      return { timestamp: args.timestamp ?? Date.now() };
    },
    async listInboundSince(_since: Date, _pageSize?: number) {
      return [] as readonly InboundSignal[];
    },
    async sendReaction(args) { reactions.push(args); },
    async sendReadReceipts(args) { receipts.push(args); },
    async sendTypingIndicator(args) { typings.push(args); },
    async remoteDelete(args) { deletes.push(args); },
  };
}

describe('signal transport — port interface contract', () => {
  it('a minimal stub satisfies SignalPort at compile + runtime', () => {
    const port = makeStubPort();
    // The assignment above is the compile-time assertion; this runtime check
    // confirms all methods are present.
    expect(typeof port.verifyCredentials).toBe('function');
    expect(typeof port.send).toBe('function');
    expect(typeof port.listInboundSince).toBe('function');
    expect(typeof port.sendReaction).toBe('function');
    expect(typeof port.sendReadReceipts).toBe('function');
    expect(typeof port.sendTypingIndicator).toBe('function');
    expect(typeof port.remoteDelete).toBe('function');
  });

  it('send() returns a timestamp envelope id', async () => {
    const port = makeStubPort();
    const r = await port.send({ recipient: '+15551234567', body: 'hi', timestamp: 12345 });
    expect(r.timestamp).toBe(12345);
  });

  it('listInboundSince returns an empty array by default', async () => {
    const port = makeStubPort();
    const rows = await port.listInboundSince(new Date(0));
    expect(rows).toEqual([]);
  });

  it('InboundSignal carries the documented fields', () => {
    const env: InboundSignal = {
      timestamp: 1,
      source: '01234567-89ab-cdef-0123-456789abcdef',
      destination: 'fedcba98-7654-3210-fedc-ba9876543210',
      body: 'hello',
      fromMe: false,
      type: 'data',
    };
    expect(env.body).toBe('hello');
    expect(env.fromMe).toBe(false);
  });

  it('ReactSignalArgs carries the target author + emoji', () => {
    const args: ReactSignalArgs = {
      targetTimestamp: 12345,
      targetAuthor: 'peer-uuid',
      targetInGroup: false,
      emoji: '👍',
      remove: false,
    };
    expect(args.emoji).toBe('👍');
  });

  it('SendReadReceiptArgs carries multiple timestamps', () => {
    const args: SendReadReceiptArgs = {
      target: 'peer-uuid',
      timestamps: [1, 2, 3],
    };
    expect(args.timestamps).toHaveLength(3);
  });

  it('SendTypingArgs carries the composing boolean', () => {
    const started: SendTypingArgs = { target: 'peer', composing: true };
    const stopped: SendTypingArgs = { target: 'peer', composing: false };
    expect(started.composing).toBe(true);
    expect(stopped.composing).toBe(false);
  });

  it('RemoteDeleteSignalArgs separates a recipient from the target timestamp', () => {
    const args: RemoteDeleteSignalArgs = { recipient: 'peer', targetTimestamp: 12345 };
    expect(args).toEqual({ recipient: 'peer', targetTimestamp: 12345 });
  });

  it('SignalPortError shape allows optional code + status', () => {
    const e: SignalPortError = { message: 'fail' };
    const e2: SignalPortError = { message: 'fail', code: 'ControllableException', status: 500 };
    expect(e.code).toBeUndefined();
    expect(e2.code).toBe('ControllableException');
  });

  it('sendReaction / sendReadReceipts / sendTypingIndicator resolve cleanly on the stub', async () => {
    const port = makeStubPort();
    await expect(port.sendReaction({
      targetTimestamp: 1, targetAuthor: 'p', targetInGroup: false, emoji: '🎉', remove: false,
    })).resolves.toBeUndefined();
    await expect(port.sendReadReceipts({ target: 'p', timestamps: [1] })).resolves.toBeUndefined();
    await expect(port.sendTypingIndicator({ target: 'p', composing: true })).resolves.toBeUndefined();
    await expect(port.remoteDelete({ recipient: 'p', targetTimestamp: 1 })).resolves.toBeUndefined();
  });
});
