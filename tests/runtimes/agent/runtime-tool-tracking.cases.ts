import { expect, it, vi } from 'vitest';
import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import type { AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';
import type { IOutboundQueue } from '../../../src/runtimes/agent/outbound-queue.ts';
import { makeDb, makeMessenger, makeQueueMock, makeRuntimeTurnContext } from './lib/runtime-mock-scaffold.ts';

export function registerRuntimeToolTrackingTests(): void {
  it('scoped result-only tool events preserve identity and make replay unsafe without a tracker start', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
    const queue = makeQueueMock('scoped@s.whatsapp.net');
    const tracker = {
      onToolStart: vi.fn(),
      onToolEnd: vi.fn(),
    };
    const mapKey = 'scoped@s.whatsapp.net';
    const toolScopeKey = `${mapKey}#1`;
    const context = makeRuntimeTurnContext('per_chat', 'scoped', queue.targetChatJid, 41, 'turn-scoped');
    const state = runtime as unknown as {
      operationTrackers: Map<string, typeof tracker>;
      perChatRuntimeTurnContexts: Map<string, Array<typeof context>>;
      turnHadToolActivity: Set<string>;
      activeToolNames: Map<string, Map<string, string>>;
      handleEventWithContext(
        event: AgentEvent,
        queue: IOutboundQueue,
        session: null,
        conversationKey: string,
        inboundSeq: number,
        mapKey: string,
        toolScopeKey: string,
      ): void;
    };
    state.operationTrackers.set(mapKey, tracker);
    state.perChatRuntimeTurnContexts.set(mapKey, [context]);

    state.handleEventWithContext(
      {
        type: 'tool_result',
        toolId: 'call_edit_rejected',
        toolName: 'edit',
        isError: true,
        content: 'permission requested: edit; auto-rejecting',
      },
      queue,
      null,
      'scoped',
      41,
      mapKey,
      toolScopeKey,
    );

    expect(queue.enqueueToolUpdate).toHaveBeenCalledWith(expect.objectContaining({
      category: 'error',
      detail: expect.stringContaining('edit'),
    }));
    expect(state.turnHadToolActivity.has(toolScopeKey)).toBe(true);
    expect(state.perChatRuntimeTurnContexts.get(mapKey)?.[0]?.replay.replaySafe).toBe(false);
    expect(tracker.onToolEnd).toHaveBeenCalledWith('call_edit_rejected');
    expect(tracker.onToolStart).not.toHaveBeenCalled();
    expect(state.activeToolNames.has(toolScopeKey)).toBe(false);
  });

  it.each([
    { content: 'Selected A', isError: false },
    { content: 'Poll expired', isError: false },
    { content: 'Poll cancelled', isError: true },
    { content: 'Vote transport failed', isError: true },
  ])('scoped poll forwards its wait and clears both trackers on $content', ({ content, isError }) => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
    const queue = makeQueueMock('scoped@s.whatsapp.net');
    const tracker = {
      onToolStart: vi.fn(),
      onToolEnd: vi.fn(),
    };
    const mapKey = 'scoped@s.whatsapp.net';
    const toolScopeKey = `${mapKey}#1`;
    const context = makeRuntimeTurnContext('per_chat', 'scoped', queue.targetChatJid, 42, 'turn-scoped-poll');
    const session = { tickWatchdog: vi.fn(), trackToolStart: vi.fn(), trackToolEnd: vi.fn() };
    const state = runtime as unknown as {
      operationTrackers: Map<string, typeof tracker>;
      perChatRuntimeTurnContexts: Map<string, Array<typeof context>>;
      handleEventWithContext(
        event: AgentEvent,
        queue: IOutboundQueue,
        session: typeof session,
        conversationKey: string,
        inboundSeq: number,
        mapKey: string,
        toolScopeKey: string,
      ): void;
    };
    state.operationTrackers.set(mapKey, tracker);
    state.perChatRuntimeTurnContexts.set(mapKey, [context]);
    const toolInput = { question: 'Pick one', options: ['A', 'B'], awaitResult: true, timeoutMs: 600_000 };

    state.handleEventWithContext(
      { type: 'tool_use', toolId: 'call_poll', toolName: 'mcp__whatsoup__send_poll', toolInput },
      queue,
      session,
      'scoped',
      42,
      mapKey,
      toolScopeKey,
    );

    expect(tracker.onToolStart).toHaveBeenCalledWith(
      'call_poll',
      'mcp__whatsoup__send_poll',
      expect.any(String),
      toolInput,
    );
    expect(session.trackToolStart).toHaveBeenCalledWith('call_poll', 'mcp__whatsoup__send_poll', toolInput);

    state.handleEventWithContext(
      { type: 'tool_result', toolId: 'call_poll', toolName: 'mcp__whatsoup__send_poll', content, isError },
      queue, session, 'scoped', 42, mapKey, toolScopeKey,
    );
    expect(tracker.onToolEnd).toHaveBeenCalledWith('call_poll');
    expect(session.trackToolEnd).toHaveBeenCalledWith('call_poll');
  });

}
