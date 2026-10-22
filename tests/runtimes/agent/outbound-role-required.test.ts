// Every outbound send names its role.
//
// Only an 'answer' op becomes a turn's answer evidence, so a send that leaves
// its role out must not compile. Each fixture below is a call without a valid
// role, under a type-check directive, paired with the same call on the same
// receiver carrying a valid role. If any declaration makes the role optional
// again, its directive goes unused and the test type check fails. The
// fixtures are type-checked with the test tsconfig and never run.

import { describe, expect, it, vi } from 'vitest';

import { Database } from '../../../src/core/database.ts';
import { DurabilityEngine } from '../../../src/core/durability.ts';
import type { Messenger } from '../../../src/core/types.ts';
import {
  sendDirect,
  sendDirectWithReceipt,
  type ChatTransportPort,
} from '../../../src/runtimes/agent/chat-transport.ts';
import type { ControlQueue } from '../../../src/runtimes/agent/control-queue.ts';
import type { ModelCatalogueRenderPort } from '../../../src/runtimes/agent/model-catalogue-render.ts';
import type { ModelPinPort } from '../../../src/runtimes/agent/model-pin.ts';
import { OutboundQueue, type IOutboundQueue } from '../../../src/runtimes/agent/outbound-queue.ts';
import type { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import type { NewCommandHost } from '../../../src/runtimes/agent/runtime-new-command.ts';
import type { RuntimePollBridgePort } from '../../../src/runtimes/agent/runtime-poll-bridge.ts';
import type { RuntimeRoutingPort } from '../../../src/runtimes/agent/runtime-routing.ts';
import type { RuntimeSessionLifecycleHost } from '../../../src/runtimes/agent/runtime-session-lifecycle.ts';
import type { StopCommandHost } from '../../../src/runtimes/agent/runtime-stop-command.ts';

vi.mock('../../../src/logger.ts', async () => {
  const { singletonLoggerMock } = await import('../../helpers/logger-mock.ts');
  const runtimeLogger = singletonLoggerMock();
  return {
    default: { ...runtimeLogger, child: () => runtimeLogger },
    createChildLogger: () => runtimeLogger,
    flushLogger: () => Promise.resolve(),
  };
});

/** Never called: the test type check reads these calls; nothing runs them. */
export function roleRequiredFixtures(
  jid: string,
  queue: IOutboundQueue,
  outboundQueue: OutboundQueue,
  controlQueue: ControlQueue,
  port: ChatTransportPort,
  pollBridge: RuntimePollBridgePort,
  catalogue: ModelCatalogueRenderPort,
  modelPin: ModelPinPort,
  routing: RuntimeRoutingPort,
  lifecycle: RuntimeSessionLifecycleHost<never, never>,
  newCommand: NewCommandHost<never, never>,
  stopCommand: StopCommandHost<never, never>,
  runtime: AgentRuntime,
): void {
  // The queue interface.
  // @ts-expect-error -- role is required; expires 2027-10-03
  queue.enqueueText('text');
  queue.enqueueText('text', 'status');
  // @ts-expect-error -- role is required; expires 2027-10-03
  queue.enqueueStreamingText('text');
  queue.enqueueStreamingText('text', 'answer');
  // @ts-expect-error -- role is required; expires 2027-10-03
  queue.enqueueResultText('text');
  queue.enqueueResultText('text', 'answer');

  // The real queue.
  // @ts-expect-error -- role is required; expires 2027-10-03
  outboundQueue.enqueueText('text');
  outboundQueue.enqueueText('text', 'status');
  // @ts-expect-error -- role is required; expires 2027-10-03
  outboundQueue.enqueueStreamingText('text');
  outboundQueue.enqueueStreamingText('text', 'answer');
  // @ts-expect-error -- role is required; expires 2027-10-03
  outboundQueue.enqueueResultText('text');
  outboundQueue.enqueueResultText('text', 'answer');

  // The control queue, which ignores the role but must not default it.
  // @ts-expect-error -- role is required; expires 2027-10-03
  controlQueue.enqueueText('text');
  controlQueue.enqueueText('text', 'status');
  // @ts-expect-error -- role is required; expires 2027-10-03
  controlQueue.enqueueStreamingText('text');
  controlQueue.enqueueStreamingText('text', 'answer');
  // @ts-expect-error -- role is required; expires 2027-10-03
  controlQueue.enqueueResultText('text');
  controlQueue.enqueueResultText('text', 'answer');

  // The chat transport's direct sends.
  // @ts-expect-error -- role is required; expires 2027-10-03
  void sendDirectWithReceipt(port, jid, 'text');
  void sendDirectWithReceipt(port, jid, 'text', 'status');
  // @ts-expect-error -- role is required; expires 2027-10-03
  void sendDirect(port, jid, 'text');
  void sendDirect(port, jid, 'text', 'status');

  // The ports that carry a direct send.
  // @ts-expect-error -- role is required; expires 2027-10-03
  pollBridge.sendDirect(jid, 'text');
  pollBridge.sendDirect(jid, 'text', 'status');
  // @ts-expect-error -- role is required; expires 2027-10-03
  catalogue.sendDirect(jid, 'text');
  catalogue.sendDirect(jid, 'text', 'status');
  // @ts-expect-error -- role is required; expires 2027-10-03
  void modelPin.sendDirectWithReceipt(jid, 'text');
  void modelPin.sendDirectWithReceipt(jid, 'text', 'status');
  // @ts-expect-error -- role is required; expires 2027-10-03
  routing.sendDirect(jid, 'text');
  routing.sendDirect(jid, 'text', 'status');
  // Every argument but a valid role: leaving out force as well would fail for force alone.
  // @ts-expect-error -- role is required; expires 2027-10-03
  lifecycle.sendDirect(jid, 'text', undefined, true);
  lifecycle.sendDirect(jid, 'text', 'status', true);
  // @ts-expect-error -- role is required; expires 2027-10-03
  newCommand.sendDirect('text');
  newCommand.sendDirect('text', 'status');
  // @ts-expect-error -- role is required; expires 2027-10-03
  stopCommand.sendDirect('text');
  stopCommand.sendDirect('text', 'status');

  // The runtime's own direct sends; the private one is reached by element access.
  // @ts-expect-error -- role is required; expires 2027-10-03
  void runtime.sendDirectWithReceipt(jid, 'text');
  void runtime.sendDirectWithReceipt(jid, 'text', 'status');
  // @ts-expect-error -- role is required; expires 2027-10-03
  runtime['sendDirect'](jid, 'text');
  runtime['sendDirect'](jid, 'text', 'status');
  // A bypass flag in the role slot is not a role.
  // @ts-expect-error -- role is required; expires 2027-10-03
  runtime['sendDirect'](jid, 'text', true);
  runtime['sendDirect'](jid, 'text', 'status', true);
}

describe('outbound roles', () => {
  it('files each role\'s op under that role\'s evidence list', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const engine = new DurabilityEngine(db);
      const key = '15550194900';
      const jid = `${key}@s.whatsapp.net`;
      const seq = engine.journalInbound('wamid-turn-roles', key, jid, 'agent');
      let sends = 0;
      const messenger: Messenger = {
        sendMessage: vi.fn(async () => {
          sends += 1;
          return { waMessageId: `wa-roles-${sends}` };
        }),
        sendMedia: vi.fn(async () => ({ waMessageId: null })),
      };
      const queue = new OutboundQueue(messenger, jid, { conversationKey: key });
      queue.setDurability(engine);
      queue.setInboundSeq(seq);
      queue.beginTurnEvidence('turn-roles');

      queue.enqueueText('Here is the answer you asked for.', 'answer');
      queue.enqueueText('The backup model could not continue this turn.', 'status');
      queue.enqueueText('Context compacted, older details summarized.', 'lifecycle');
      const evidence = await queue.flushTurnEvidence('turn-roles');

      const opIdFor = (text: string): number | undefined => (db.raw.prepare(
        "SELECT id FROM outbound_ops WHERE json_extract(payload, '$.text') = ?",
      ).get(text) as { id: number } | undefined)?.id;
      expect({
        answer: evidence.answerOpIds,
        status: evidence.statusOpIds,
        lifecycle: evidence.lifecycleOpIds,
      }).toEqual({
        answer: [opIdFor('Here is the answer you asked for.')],
        status: [opIdFor('The backup model could not continue this turn.')],
        lifecycle: [opIdFor('Context compacted, older details summarized.')],
      });
    } finally {
      db.close();
    }
  });
});
