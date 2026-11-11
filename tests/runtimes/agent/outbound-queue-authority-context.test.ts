import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Messenger } from '../../../src/core/types.ts';
import type { TransportAdmissionInput } from '../../../src/transport/operations-authority-client.ts';
import {
  FinalTransportAuthorityGate,
  getTransportInboundContext,
  withTransportInboundContext,
} from '../../../src/transport/operations-authority-gate.ts';
import { OutboundQueue } from '../../../src/runtimes/agent/outbound-queue.ts';

vi.mock('../../../src/logger.ts', async () => (await import('../../helpers/logger-mock.ts')).loggerMock());

function fixture() {
  const admissions: TransportAdmissionInput[] = [];
  const gate = new FinalTransportAuthorityGate({
    admit: async (input) => {
      admissions.push(input);
      return { attemptId: `attempt-${admissions.length}`, payloadDigest: 'sha256:test' };
    },
    recordReceipt: async () => undefined,
  });
  const messenger: Messenger = {
    sendMessage: vi.fn(async (recipient, text) => {
      await gate.admit({ recipient, content: { text } });
      return { waMessageId: `fake-${admissions.length}` };
    }),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
    setTyping: vi.fn(async () => undefined),
  };
  const queue = new OutboundQueue(messenger, 'context@s.whatsapp.net', { conversationKey: 'context' });
  return { admissions, messenger, queue };
}

async function flush(queue: OutboundQueue): Promise<void> {
  const done = queue.flush();
  await vi.advanceTimersByTimeAsync(10_000);
  await done;
}

describe('outbound authority context', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    const pending = vi.getTimerCount();
    vi.clearAllTimers();
    vi.useRealTimers();
    expect(pending).toBe(0);
  });

  it('binds a pending B send to B and leaves a synthetic send unbound while A drains', async () => {
    const { admissions, messenger, queue } = fixture();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const send = messenger.sendMessage;
    let entered = false;
    messenger.sendMessage = async (...args) => {
      if (!entered) {
        entered = true;
        await blocked;
      }
      return send(...args);
    };
    withTransportInboundContext({ inbound_event_id: 'A' }, () => queue.enqueueText('answer A', 'answer'));
    await vi.advanceTimersByTimeAsync(0);
    expect(entered).toBe(true);
    withTransportInboundContext({ inbound_event_id: 'B', operation_id: 'approved-B' }, () => {
      queue.enqueueText('answer B', 'answer');
    });
    queue.enqueueText('synthetic answer', 'answer');
    release();
    await flush(queue);
    expect(admissions.map((input) => [input.context?.inbound_event_id, input.operationId])).toEqual([
      ['A', undefined], ['B', 'approved-B'], [undefined, undefined],
    ]);
  });

  it.each(['stream', 'tool', 'redirect'] as const)('does not combine %s buffers across authority contexts', async (kind) => {
    const { admissions, queue } = fixture();
    const committedContexts: Array<string | undefined> = [];
    if (kind === 'redirect') queue.setToolUpdateRedirectJid('status@s.whatsapp.net');
    const enqueue = (text: string): void => {
      if (kind === 'stream') queue.enqueueStreamingText(text, 'answer', () => {
        committedContexts.push(getTransportInboundContext()?.inbound_event_id);
      });
      else queue.enqueueToolUpdate({ category: 'running', detail: text });
    };
    withTransportInboundContext({ inbound_event_id: 'A' }, () => { enqueue('first A'); enqueue(' second A'); });
    withTransportInboundContext({ inbound_event_id: 'B' }, () => enqueue('answer B'));
    enqueue('synthetic answer');
    // The flush caller is unrelated to every buffered item.
    const done = withTransportInboundContext({ inbound_event_id: 'unrelated' }, () => queue.flush());
    await vi.advanceTimersByTimeAsync(10_000);
    await done;
    expect(admissions.map((input) => input.context?.inbound_event_id)).toEqual(['A', 'B', undefined]);
    expect(admissions[0].content).toEqual({ text: expect.stringContaining('first A') });
    expect(admissions[0].content).toEqual({ text: expect.stringContaining('second A') });
    expect(admissions[0].content).not.toEqual({ text: expect.stringContaining('answer B') });
    expect(admissions.map((input) => input.recipient)).toEqual(Array(3).fill(
      kind === 'redirect' ? 'status@s.whatsapp.net' : 'context@s.whatsapp.net',
    ));
    if (kind === 'stream') expect(committedContexts).toEqual(['A', 'A', 'B', undefined]);
  });

  it('keeps distinct approved operations separate within one inbound event', async () => {
    const { admissions, queue } = fixture();
    const context = { inbound_event_id: 'A', operation_id: 'approved-first' };
    withTransportInboundContext(context, () => queue.enqueueStreamingText('first operation', 'answer'));
    context.operation_id = 'approved-second';
    withTransportInboundContext(context, () => queue.enqueueStreamingText('second operation', 'answer'));
    await flush(queue);
    expect(admissions.map((input) => input.operationId)).toEqual(['approved-first', 'approved-second']);
    expect(admissions.map((input) => input.content)).toEqual([
      { text: 'first operation' }, { text: 'second operation' },
    ]);
  });

  it('keeps crash-salvaged buffers bound to their original inbound contexts', async () => {
    const { admissions, queue } = fixture();
    queue.setToolUpdateMode('minimal');
    withTransportInboundContext({ inbound_event_id: 'A' }, () => queue.enqueueStreamingText('held A', 'answer'));
    queue.discardPreToolAssistantText();
    withTransportInboundContext({ inbound_event_id: 'B' }, () => queue.enqueueStreamingText('held B', 'answer'));
    queue.enqueueStreamingText('held synthetic', 'answer');
    withTransportInboundContext({ inbound_event_id: 'crash-handler' }, () => {
      queue.abortTurn({ salvageOwedReply: true });
    });
    await flush(queue);
    expect(admissions.map((input) => input.context?.inbound_event_id)).toEqual(['A', 'B', undefined]);
    for (const [index, text] of ['held A', 'held B', 'held synthetic'].entries()) {
      expect(admissions[index].content).toEqual({ text: expect.stringContaining(text) });
    }
    expect(admissions[1].content).not.toEqual({ text: expect.stringContaining('held A') });
  });
});
