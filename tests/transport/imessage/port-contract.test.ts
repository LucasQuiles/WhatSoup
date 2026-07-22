// tests/transport/imessage/port-contract.test.ts
// Compile-time + duck-type contract for the ImessagePort interface.
import { describe, it, expect } from 'vitest';
import type {
  ImessagePort,
  SendImessageArgs,
  InboundImessage,
  ReactImessageArgs,
  SendReadReceiptArgs,
  SendTypingArgs,
  ImessagePortError,
} from '../../../src/transport/imessage/port.ts';

function makeStubPort(): ImessagePort {
  const sent: SendImessageArgs[] = [];
  const reactions: ReactImessageArgs[] = [];
  const receipts: SendReadReceiptArgs[] = [];
  const typings: SendTypingArgs[] = [];
  return {
    async verifyCredentials() { /* no-op */ },
    async send(args) {
      sent.push(args);
      return { guid: `guid-${sent.length}` };
    },
    async listInboundSince(_since: Date, _pageSize?: number, _offset?: number) {
      return [] as readonly InboundImessage[];
    },
    async sendReaction(args) { reactions.push(args); },
    async sendReadReceipts(args) { receipts.push(args); },
    async sendTypingIndicator(args) { typings.push(args); },
  };
}

describe('imessage transport — port interface contract', () => {
  it('a minimal stub satisfies ImessagePort at compile + runtime', () => {
    const port = makeStubPort();
    expect(typeof port.verifyCredentials).toBe('function');
    expect(typeof port.send).toBe('function');
    expect(typeof port.listInboundSince).toBe('function');
    expect(typeof port.sendReaction).toBe('function');
    expect(typeof port.sendReadReceipts).toBe('function');
    expect(typeof port.sendTypingIndicator).toBe('function');
  });

  it('send() returns a guid envelope id', async () => {
    const port = makeStubPort();
    const r = await port.send({ recipient: 'user@icloud.com', body: 'hi' });
    expect(typeof r.guid).toBe('string');
  });

  it('listInboundSince returns an empty array by default', async () => {
    const port = makeStubPort();
    const rows = await port.listInboundSince(new Date(0));
    expect(rows).toEqual([]);
  });

  it('InboundImessage carries the documented fields', () => {
    const env: InboundImessage = {
      guid: 'guid-1',
      from: 'user@icloud.com',
      to: 'us@icloud.com',
      body: 'hello',
      fromMe: false,
      kind: 'text',
      timestamp: 1000,
    };
    expect(env.body).toBe('hello');
    expect(env.fromMe).toBe(false);
  });

  it('ReactImessageArgs carries target guid + conversation + emoji', () => {
    const args: ReactImessageArgs = {
      targetGuid: 'guid-1',
      conversation: 'user@icloud.com',
      emoji: '❤️',
      remove: false,
    };
    expect(args.emoji).toBe('❤️');
  });

  it('SendReadReceiptArgs carries multiple guids', () => {
    const args: SendReadReceiptArgs = {
      conversation: 'user@icloud.com',
      guids: ['guid-1', 'guid-2', 'guid-3'],
    };
    expect(args.guids).toHaveLength(3);
  });

  it('SendTypingArgs carries the composing boolean', () => {
    const started: SendTypingArgs = { conversation: 'peer', composing: true };
    const stopped: SendTypingArgs = { conversation: 'peer', composing: false };
    expect(started.composing).toBe(true);
    expect(stopped.composing).toBe(false);
  });

  it('ImessagePortError shape allows optional code + status', () => {
    const e: ImessagePortError = { message: 'fail' };
    const e2: ImessagePortError = { message: 'fail', code: 'Unauthorized', status: 401 };
    expect(e.code).toBeUndefined();
    expect(e2.code).toBe('Unauthorized');
  });

  it('all extension methods resolve cleanly on the stub', async () => {
    const port = makeStubPort();
    await expect(port.sendReaction({
      targetGuid: 'g', conversation: 'p', emoji: '❤️', remove: false,
    })).resolves.toBeUndefined();
    await expect(port.sendReadReceipts({
      conversation: 'p', guids: ['g'],
    })).resolves.toBeUndefined();
    await expect(port.sendTypingIndicator({
      conversation: 'p', composing: true,
    })).resolves.toBeUndefined();
  });
});
