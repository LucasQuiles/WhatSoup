import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OutboundQueue } from '../../../src/runtimes/agent/outbound-queue.ts';
import type { Messenger } from '../../../src/core/types.ts';
import type { DurabilityEngine } from '../../../src/core/durability.ts';
import {
  parseClientOutputPolicies,
  type ClientOutputPolicyRegistry,
} from '../../../src/core/client-output-policy-config.ts';
import type { ConfiguredClientOutputPolicy } from '../../../src/core/client-output-policy-contract.ts';

// #3613: the outbound queue enforces the per-conversation client output
// policy. A rejected message is dropped (never sent, no outbound op) and
// leaves exactly one structured audit line that carries no message text.

const mockLog = vi.hoisted(() => ({} as Record<string, ReturnType<typeof vi.fn>>));

vi.mock('../../../src/logger.ts', async () => {
  const { hoistedLoggerMock } = await import('../../helpers/logger-mock.ts');
  const { createChildLogger } = hoistedLoggerMock(mockLog);
  return { createChildLogger };
});

const CONVERSATION_KEY = '15550000000';
const CHAT_JID = `${CONVERSATION_KEY}@s.whatsapp.net`;
const OTHER_KEY = '15551111111';
const OTHER_JID = `${OTHER_KEY}@s.whatsapp.net`;
const BLOCKED_TERM = 'zebracorn';

function makeMessenger(): { messenger: Messenger; calls: string[] } {
  const calls: string[] = [];
  const messenger: Messenger = {
    sendMessage: vi.fn(async (_jid: string, text: string) => {
      calls.push(text);
      return { waMessageId: null };
    }),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
    setTyping: vi.fn(async () => {}),
  };
  return { messenger, calls };
}

function makeDurabilityStub(): DurabilityEngine {
  let nextId = 0;
  return {
    createOutboundOp: vi.fn(() => {
      nextId += 1;
      return nextId;
    }),
    markSending: vi.fn(),
    markSubmitted: vi.fn(),
    markMaybeSent: vi.fn(),
    markFailedPermanent: vi.fn(),
    markDeferred: vi.fn(),
    markTerminal: vi.fn(),
  } as unknown as DurabilityEngine;
}

function registryFor(policy: Record<string, unknown>): ClientOutputPolicyRegistry {
  const parsed = parseClientOutputPolicies([policy]);
  if (!parsed.ok) throw new Error(`fixture policy invalid: ${parsed.error.field} ${parsed.error.reason}`);
  return parsed.registry;
}

const STRICT_POLICY = {
  conversationKey: CONVERSATION_KEY,
  maxCodePoints: 4000,
  maxQuestionMarks: 1,
  blockedTerms: [{ value: BLOCKED_TERM, match: 'whole_word', caseSensitive: false }],
  rejectInternalArtifacts: true,
  rejectWhatsAppJids: true,
};

function policyCalls(level: 'warn' | 'error'): unknown[][] {
  return mockLog[level]!.mock.calls.filter((call) => {
    const fields = call[0] as Record<string, unknown> | undefined;
    return fields?.['operation'] === 'client_output_policy';
  });
}

function makeQueue(
  registry: ClientOutputPolicyRegistry,
  chatJid = CHAT_JID,
  conversationKey = CONVERSATION_KEY,
): { queue: OutboundQueue; messenger: Messenger; calls: string[]; durability: DurabilityEngine } {
  const { messenger, calls } = makeMessenger();
  const queue = new OutboundQueue(messenger, chatJid, {
    conversationKey,
    clientOutputPolicies: registry,
  });
  const durability = makeDurabilityStub();
  queue.setDurability(durability);
  return { queue, messenger, calls, durability };
}

describe('OutboundQueue client output policy enforcement (#3613)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const fn of Object.values(mockLog)) fn.mockClear();
  });

  afterEach(() => {
    const leakedTimers = vi.getTimerCount();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    expect(leakedTimers, 'Test leaked pending timers').toBe(0);
  });

  it('drops a rejected message: nothing is sent and no outbound op is created', async () => {
    const { queue, messenger, durability } = makeQueue(registryFor(STRICT_POLICY));

    queue.enqueueText(`Please ask about the ${BLOCKED_TERM} launch.`);
    await queue.flush();

    expect(messenger.sendMessage).not.toHaveBeenCalled();
    expect(durability.createOutboundOp).not.toHaveBeenCalled();
  });

  it('logs exactly one structured warn audit line with no message text or blocked term', async () => {
    const { queue } = makeQueue(registryFor(STRICT_POLICY));
    const secretText = `Unique sentence mentioning ${BLOCKED_TERM} twice? Really?`;

    queue.enqueueText(secretText);
    await queue.flush();

    const warns = policyCalls('warn');
    expect(warns).toHaveLength(1);
    expect(warns[0]![0]).toEqual({
      operation: 'client_output_policy',
      decision: 'rejected',
      conversationKey: CONVERSATION_KEY,
      reason: 'client_output_policy',
      violationCodes: ['max_question_marks', 'blocked_term'],
      messageKind: 'answer',
    });
    const serialized = JSON.stringify(warns);
    expect(serialized).not.toContain('Unique sentence');
    expect(serialized.toLowerCase()).not.toContain(BLOCKED_TERM);
    expect(policyCalls('error')).toHaveLength(0);
  });

  it('evaluates the whole message once, before it is split into chunks', async () => {
    const { queue, messenger } = makeQueue(registryFor({ ...STRICT_POLICY, maxCodePoints: 50 }));

    // Two paragraphs of 3000 characters each: the queue would send 2 chunks.
    queue.enqueueText(`${'a'.repeat(3000)}\n\n${'b'.repeat(3000)}`);
    await queue.flush();

    expect(messenger.sendMessage).not.toHaveBeenCalled();
    const warns = policyCalls('warn');
    expect(warns).toHaveLength(1);
    expect((warns[0]![0] as Record<string, unknown>)['violationCodes']).toEqual(['max_code_points']);
  });

  it('checks internal artifacts against the pre-redaction source text', async () => {
    const { queue, messenger } = makeQueue(registryFor(STRICT_POLICY));

    queue.enqueueText('The file is at /Users/testuser/LAB/example/secret.txt');
    await queue.flush();

    expect(messenger.sendMessage).not.toHaveBeenCalled();
    const warns = policyCalls('warn');
    expect(warns).toHaveLength(1);
    expect((warns[0]![0] as Record<string, unknown>)['violationCodes']).toEqual(['internal_artifact']);
  });

  it('drops rejected streaming text but still fires its commit callback', async () => {
    // The runtime's commit bookkeeping means "the agent produced output this
    // turn". Withheld output still counts: it blocks a fallback replay and the
    // empty-turn fallback, as the policy decision satisfies the reply guarantee.
    const { queue, messenger } = makeQueue(registryFor(STRICT_POLICY));
    queue.setToolUpdateMode('minimal');
    const onCommit = vi.fn();

    queue.enqueueStreamingText(`streamed ${BLOCKED_TERM} answer`, 'answer', onCommit);
    await queue.flush();

    expect(messenger.sendMessage).not.toHaveBeenCalled();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(policyCalls('warn')).toHaveLength(1);
  });

  it('counts a withheld answer in the turn evidence without creating an answer op', async () => {
    const { queue } = makeQueue(registryFor(STRICT_POLICY));
    queue.beginTurnEvidence('turn-withheld');

    queue.enqueueText(`the ${BLOCKED_TERM} answer`);
    const evidence = await queue.flushTurnEvidence('turn-withheld');

    expect(evidence.answerOpIds).toEqual([]);
    expect(evidence.withheldAnswerCount).toBe(1);
  });

  it('reports zero withheld answers when the answer was admitted', async () => {
    const { queue } = makeQueue(registryFor(STRICT_POLICY));
    queue.beginTurnEvidence('turn-allowed');

    queue.enqueueText('A plain answer.');
    const evidence = await queue.flushTurnEvidence('turn-allowed');

    expect(evidence.answerOpIds).toHaveLength(1);
    expect(evidence.withheldAnswerCount).toBe(0);
  });

  it('exposes a withheld answer once through consumeClientOutputWithheld', async () => {
    const { queue } = makeQueue(registryFor(STRICT_POLICY));

    expect(queue.consumeClientOutputWithheld()).toBe(false);
    queue.enqueueText(`the ${BLOCKED_TERM} answer`);
    await queue.flush();

    expect(queue.consumeClientOutputWithheld()).toBe(true);
    expect(queue.consumeClientOutputWithheld()).toBe(false);
  });

  it('clears the withheld flag when the turn is aborted', async () => {
    const { queue } = makeQueue(registryFor(STRICT_POLICY));

    queue.enqueueText(`the ${BLOCKED_TERM} answer`);
    await queue.flush();
    queue.abortTurn();

    expect(queue.consumeClientOutputWithheld()).toBe(false);
  });

  it('does not salvage deferred pre-tool narration after an answer was withheld', async () => {
    const { queue, messenger } = makeQueue(registryFor(STRICT_POLICY));
    queue.setToolUpdateMode('minimal');

    queue.enqueueStreamingText('Let me check the records first.');
    queue.discardPreToolAssistantText();
    queue.enqueueText(`the ${BLOCKED_TERM} answer`);
    queue.endTurn();
    await queue.flush();

    expect(messenger.sendMessage).not.toHaveBeenCalled();
  });

  it('lets a dropped placeholder take the rate-floor slot so repeated stalls log once', async () => {
    const { queue, messenger } = makeQueue(registryFor({
      ...STRICT_POLICY,
      blockedTerms: [{ value: 'working', match: 'substring', caseSensitive: false }],
    }));
    const stall = {
      type: 'operation_stalled' as const,
      toolId: 'tool-1',
      toolName: 'Bash',
      category: 'running' as const,
      elapsedMs: 65_000,
    };

    queue.enqueueProgressUpdate(stall, 'Bot');
    queue.enqueueProgressUpdate({ ...stall, toolId: 'tool-2', elapsedMs: 70_000 }, 'Bot');
    await vi.runAllTimersAsync();
    await queue.flush();

    expect(messenger.sendMessage).not.toHaveBeenCalled();
    expect(policyCalls('warn')).toHaveLength(1);
  });

  it('sends allowed streaming text and fires its commit callback', async () => {
    const { queue, calls } = makeQueue(registryFor(STRICT_POLICY));
    queue.setToolUpdateMode('minimal');
    const onCommit = vi.fn();

    queue.enqueueStreamingText('a plain streamed answer', 'answer', onCommit);
    await queue.flush();

    expect(calls).toEqual(['a plain streamed answer']);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(policyCalls('warn')).toHaveLength(0);
  });

  it('drops a rejected progress placeholder', async () => {
    const { queue, messenger } = makeQueue(registryFor({
      ...STRICT_POLICY,
      blockedTerms: [{ value: 'working', match: 'substring', caseSensitive: false }],
    }));

    queue.enqueueProgressUpdate({
      type: 'operation_stalled',
      toolId: 'tool-1',
      toolName: 'Bash',
      category: 'running',
      elapsedMs: 65_000,
    }, 'Bot');
    await vi.runAllTimersAsync();
    await queue.flush();

    expect(messenger.sendMessage).not.toHaveBeenCalled();
    const warns = policyCalls('warn');
    expect(warns).toHaveLength(1);
    expect((warns[0]![0] as Record<string, unknown>)['messageKind']).toBe('status');
    // Only a withheld answer marks the turn; a status placeholder does not.
    expect(queue.consumeClientOutputWithheld()).toBe(false);
  });

  it('sends an allowed message unchanged', async () => {
    const { queue, calls, durability } = makeQueue(registryFor(STRICT_POLICY));

    queue.enqueueText('Your order ships tomorrow.');
    await queue.flush();

    expect(calls).toEqual(['Your order ships tomorrow.']);
    expect(durability.createOutboundOp).toHaveBeenCalledTimes(1);
    expect(policyCalls('warn')).toHaveLength(0);
    expect(policyCalls('error')).toHaveLength(0);
  });

  it('leaves a conversation without a policy untouched', async () => {
    const { queue, calls } = makeQueue(registryFor(STRICT_POLICY), OTHER_JID, OTHER_KEY);
    const text = `Two questions? About ${BLOCKED_TERM}?`;

    queue.enqueueText(text);
    await queue.flush();

    expect(calls).toEqual([text]);
    expect(policyCalls('warn')).toHaveLength(0);
    expect(policyCalls('error')).toHaveLength(0);
  });

  it('leaves a queue built without an injected registry untouched (default config has no policies)', async () => {
    const { messenger, calls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID, { conversationKey: CONVERSATION_KEY });
    const text = `Two questions? About ${BLOCKED_TERM}?`;

    queue.enqueueText(text);
    await queue.flush();

    expect(calls).toEqual([text]);
    expect(policyCalls('warn')).toHaveLength(0);
  });

  it('fails closed when the evaluator throws for a configured policy: drops and logs one error line', async () => {
    const valid = registryFor(STRICT_POLICY).get(CONVERSATION_KEY)!;
    const throwing = {
      ...valid,
      get blockedTerms(): never {
        throw new TypeError(`policy exploded near ${BLOCKED_TERM}`);
      },
    } as unknown as ConfiguredClientOutputPolicy;
    const registry = new Map([[CONVERSATION_KEY, throwing]]) as unknown as ClientOutputPolicyRegistry;
    const { queue, messenger, durability } = makeQueue(registry);

    queue.enqueueText('An otherwise harmless reply.');
    await queue.flush();

    expect(messenger.sendMessage).not.toHaveBeenCalled();
    expect(durability.createOutboundOp).not.toHaveBeenCalled();
    const errors = policyCalls('error');
    expect(errors).toHaveLength(1);
    expect(errors[0]![0]).toEqual({
      operation: 'client_output_policy',
      decision: 'error',
      conversationKey: CONVERSATION_KEY,
      messageKind: 'answer',
      errorName: 'TypeError',
    });
    const serialized = JSON.stringify(errors);
    expect(serialized).not.toContain('harmless reply');
    expect(serialized.toLowerCase()).not.toContain(BLOCKED_TERM);
    expect(policyCalls('warn')).toHaveLength(0);
  });
});
