// tests/runtimes/agent/lib/runtime-mock-scaffold.ts
// Shared mock/fixture scaffolding extracted from runtime.test.ts (waiver #2951 payback).
// These pure helpers have zero coupling to vi.hoisted() or vi.mock() state — they
// import freely from src/ and vitest types just like any other test module.

import { vi, expect } from 'vitest';
import type { Database } from '../../../../src/core/database.ts';
import type { IncomingMessage, Messenger } from '../../../../src/core/types.ts';
import type { AgentEvent } from '../../../../src/runtimes/agent/stream-parser.ts';
import type { IOutboundQueue } from '../../../../src/runtimes/agent/outbound-queue.ts';
import { createRuntimeTurnContext } from '../../../../src/runtimes/agent/runtime-turn-context.ts';
import { createOpenCodeParser } from '../../../../src/runtimes/agent/providers/opencode-parser.ts';
import { AgentRuntime, type PendingPollQuestion } from '../../../../src/runtimes/agent/runtime.ts';
import type { SessionCheckpointRow } from '../../../../src/core/durability.ts';
import type {
  MarkSystemTurnInput,
  PendingSystemTurnSnapshot,
  SystemTurnLeaseToken,
  SystemTurnPurpose,
} from '../../../../src/runtimes/agent/pending-system-result-tracker.ts';

// ─── View types ────────────────────────────────────────────────────────────────

export type AutoCompactView = {
  cooldownUntil: Map<string, number>;
  lastSuccessAt: Map<string, number>;
  rapidRearmRecordedForSuccessAt: Map<string, number>;
  consecutiveRapidRearms: Map<string, number>;
  measureNextTurn: Set<string>;
  compactBoundaryScopes: Set<string>;
  silentCompactScopes: Map<string, unknown>;
  waiters: Map<string, unknown>;
};

export type ImageCoalescerView = {
  buffers: Map<string, {
    texts: string[];
    timer: ReturnType<typeof setTimeout>;
    msg: IncomingMessage;
    inboundSeqs: number[];
  }>;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function makeDb(): Database {
  return {
    assertWritableCompatibility: vi.fn(),
    raw: {
      prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn(), all: vi.fn(() => []) })),
      exec: vi.fn(),
    },
  } as unknown as Database;
}

export function makeMessenger(): { messenger: Messenger; sentMessages: Array<{ jid: string; text: string }> } {
  const sentMessages: Array<{ jid: string; text: string }> = [];
  const messenger: Messenger = {
    sendMessage: vi.fn(async (jid: string, text: string) => {
      sentMessages.push({ jid, text });
      return { waMessageId: null };
    }),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
  };
  return { messenger, sentMessages };
}

export function makeMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: 'msg-1',
    chatJid: 'test@s.whatsapp.net',
    senderJid: 'sender@s.whatsapp.net',
    senderName: 'Test User',
    content: 'hello',
    contentType: 'text',
    isFromMe: false,
    isGroup: false,
    mentionedJids: [],
    timestamp: Date.now(),
    quotedMessageId: null,
    contentText: null,
    isResponseWorthy: true,
    ...overrides,
  };
}

export function completedCheckpoint(args: {
  conversationKey: string;
  deliveryJid: string;
  deliveryNamespace: 's.whatsapp.net' | 'lid' | 'g.us';
  scope: 'per_chat' | 'shared' | 'singleton';
  sessionId: string;
  id?: number;
  inboundSeq?: number;
  logicalTurnId?: string;
  managerId?: string;
  generation?: number;
  updatedAt?: string | null;
}): SessionCheckpointRow {
  const inboundSeq = args.inboundSeq ?? 1;
  return {
    id: args.id ?? 1,
    conversation_key: args.conversationKey,
    session_id: args.sessionId,
    transcript_path: null,
    active_turn_id: null,
    last_inbound_seq: inboundSeq,
    completed_inbound_seq: inboundSeq,
    last_flushed_outbound_id: null,
    watchdog_state: null,
    workspace_path: null,
    claude_pid: null,
    session_status: 'active',
    checkpoint_version: 1,
    completed_delivery_jid: args.deliveryJid,
    completed_delivery_namespace: args.deliveryNamespace,
    completed_scope: args.scope,
    completed_logical_turn_id: args.logicalTurnId ?? `turn-${inboundSeq}`,
    completed_manager_id: args.managerId ?? 'resume-manager',
    completed_generation: args.generation ?? 1,
    updated_at: args.updatedAt === undefined
      ? new Date().toISOString().replace('T', ' ').replace('Z', '')
      : args.updatedAt,
  };
}

export function fakeTimerHandle(label: string): ReturnType<typeof setTimeout> {
  return { label } as unknown as ReturnType<typeof setTimeout>;
}

export type RegisteredTool = {
  name: string;
  handler: (params: unknown) => Promise<unknown>;
};

export function getRegisteredTool(runtime: AgentRuntime, name: string): RegisteredTool {
  const registry = (runtime as unknown as {
    registry: { register: ReturnType<typeof vi.fn> };
  }).registry;
  const tools = registry.register.mock.calls.map(([tool]) => tool as RegisteredTool);
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`registered tool not found: ${name}`);
  return tool;
}

export async function expectRejectsWithError(promise: Promise<unknown>, message: string): Promise<void> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe('Error');
    expect((err as Error).message).toBe(message);
    return;
  }

  throw new Error(`expected rejection: ${message}`);
}

/**
 * Call handleMessage and wait for the turn chain to settle.
 * handleMessage enqueues work onto turnChain without awaiting it, so tests
 * must drain the chain to observe side effects synchronously.
 */
export async function sendAndDrain(runtime: AgentRuntime, msg: IncomingMessage): Promise<void> {
  await runtime.handleMessage(msg);
  // Access the private turnChain field to wait for the queued inner work.
  await (runtime as unknown as { turnChain: Promise<void> }).turnChain;
}

export type ProviderOwnerView = {
  currentRuntimeTurnContext: unknown | null;
  perChatRuntimeTurnContexts: Map<string, unknown[]>;
  legacyProviderTurnOwners: Map<string, unknown>;
};

export function hasPublishedProviderOwner(runtime: AgentRuntime, scopeKey: string): boolean {
  const state = runtime as unknown as ProviderOwnerView;
  if (scopeKey === '__global__') {
    return state.currentRuntimeTurnContext !== null
      || state.legacyProviderTurnOwners.has(scopeKey);
  }
  return (state.perChatRuntimeTurnContexts.get(scopeKey)?.length ?? 0) > 0
    || state.legacyProviderTurnOwners.has(scopeKey);
}

/**
 * Like sendAndDrain, but also waits for the TurnQueue to fully drain.
 * Required for shared-mode tests where turns are processed asynchronously
 * inside the TurnQueue rather than inline in _handleMessageInner.
 */
export async function sendAndDrainShared(runtime: AgentRuntime, msg: IncomingMessage): Promise<void> {
  await sendAndDrain(runtime, msg);
  // Wait for the TurnQueue to fully drain
  await (runtime as unknown as { turnQueue: { idle: () => Promise<void> } }).turnQueue.idle();
}

export function attachRuntimeFaultMarkerSpies(runtime: AgentRuntime): {
  durability: {
    completeInbound: ReturnType<typeof vi.fn>;
    markContinuityCandidateIfNoTerminalOutbound: ReturnType<typeof vi.fn>;
    markInboundFailed: ReturnType<typeof vi.fn>;
    upsertSessionCheckpoint: ReturnType<typeof vi.fn>;
    getResumableCheckpoints: ReturnType<typeof vi.fn>;
    getOutboundDeliverySnapshot: ReturnType<typeof vi.fn>;
    finalizeTurnTerminal: ReturnType<typeof vi.fn>;
  };
  replyGuarantee: {
    arm: ReturnType<typeof vi.fn>;
    disarm: ReturnType<typeof vi.fn>;
    isArmed: ReturnType<typeof vi.fn>;
    shutdown: ReturnType<typeof vi.fn>;
  };
} {
  const durability = {
    completeInbound: vi.fn(),
    markContinuityCandidateIfNoTerminalOutbound: vi.fn(() => true),
    markInboundFailed: vi.fn(),
    upsertSessionCheckpoint: vi.fn(),
    getResumableCheckpoints: vi.fn(() => []),
    ...makeTerminalDurabilityMock(),
  };
  const replyGuarantee = {
    arm: vi.fn(),
    disarm: vi.fn(),
    isArmed: vi.fn(() => true),
    notifyActivity: vi.fn(),
    shutdown: vi.fn(),
  };
  (runtime as unknown as { durability: unknown }).durability = durability;
  (runtime as unknown as { replyGuarantee: unknown }).replyGuarantee = replyGuarantee;
  return { durability, replyGuarantee };
}

export function makeQueueMock(targetChatJid: string): IOutboundQueue {
  return {
    enqueueText: vi.fn(),
    getSenderToken: () => 'mock-sender-token',
    enqueueStreamingText: vi.fn(),
    enqueueResultText: vi.fn(),
    enqueueToolUpdate: vi.fn(),
    enqueueProgressUpdate: vi.fn(),
    indicateTyping: vi.fn(),
    flush: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    abortTurn: vi.fn(),
    endTurn: vi.fn(),
    updateDeliveryJid: vi.fn(),
    setInboundSeq: vi.fn(),
    markLastTerminal: vi.fn(),
    clearLastOpId: vi.fn(),
    beginTurnEvidence: vi.fn(),
    flushTurnEvidence: vi.fn(async (turnId: string) => ({
      turnId,
      answerOpIds: [] as number[],
      lifecycleOpIds: [] as number[],
      statusOpIds: [] as number[],
    })),
    setToolUpdateMode: vi.fn(),
    setToolUpdateRedirectJid: vi.fn(),
    setTextAggregateDelayMs: vi.fn(),
    enqueuePoll: vi.fn(async (fn: () => Promise<void>) => { await fn(); }),
    hasPendingPoll: vi.fn(() => false),
    setPollPending: vi.fn(),
    targetChatJid,
    getLastOpId: vi.fn(() => undefined),
    setDurability: vi.fn(),
  };
}

export function makeTerminalDurabilityMock() {
  return {
    getOutboundDeliverySnapshot: vi.fn(),
    finalizeTurnTerminal: vi.fn(() => ({
      applied: true,
      winnerMatchesRequest: true,
      recordId: 1,
      duplicateFinalizeCount: 0,
      replyGuaranteeDisarmed: true,
      effectiveReplyGuaranteeDisarmed: true,
    })),
  };
}

export function makeRuntimeTurnContext(
  scope: 'per_chat' | 'shared' | 'singleton',
  conversationKey: string,
  deliveryJid: string,
  inboundSeq: number,
  logicalTurnId: string,
) {
  return createRuntimeTurnContext({
    identity: {
      scope,
      conversationKey,
      deliveryJid,
      inboundSeq,
      logicalTurnId,
      managerId: `manager-${scope}`,
      generation: 1,
    },
    recoveryOwner: {
      logicalTurnId: `${logicalTurnId}:recovery`,
      managerId: 'manager-recovery',
      generation: 2,
    },
    replay: {
      sourceMessageId: `wamid-${logicalTurnId}`,
      receivedAtUnixSeconds: 1_780_000_000,
      replaySafe: true,
      senderJid: '15550009999@s.whatsapp.net',
      senderName: null,
      text: 'original turn',
      isGroup: false,
    },
    contentType: 'text',
    toolScopeKey: scope === 'per_chat' ? conversationKey : '__global__',
  });
}

export type ToolResultEvent = Extract<AgentEvent, { type: 'tool_result' }>;

export function parseOpenCodeToolResult(
  toolName: string | undefined,
  isError: boolean,
  toolId: string,
): ToolResultEvent {
  const event = createOpenCodeParser().parse(JSON.stringify({
    type: 'tool_use',
    part: {
      type: 'tool',
      ...(toolName === undefined ? {} : { tool: toolName }),
      callID: toolId,
      state: isError
        ? { status: 'rejected', error: 'permission requested; auto-rejecting' }
        : { status: 'completed', output: 'completed' },
    },
  }));
  if (event?.type !== 'tool_result') {
    throw new Error(`Expected OpenCode tool_result, received ${event?.type ?? 'null'}`);
  }
  return event;
}

export type PerChatCleanupRuntimeState = {
  cleanupPerChatState: (mapKey: string) => void;
  crashes: { record(k: string): number; count(k: string): number; size: number };
  perChatInboundSeqQueue: Map<string, number[]>;
  perChatTurnContentType: Map<string, string>;
  perChatTurnText: Map<string, string>;
  perChatAssistantItemText: Map<string, Map<string, string>>;
  pendingTurnText: Map<string, string>;
  pendingPolls: { questions: Map<string, PendingPollQuestion> };
  resumeFailedHandling: Set<string>;
  pendingRecycle: Set<string>;
  lastSpawnRouteProvider: Map<string, string>;
  lastPinBlockNotice: Map<string, string>;
  autoCompact: AutoCompactView;
  imageCoalesce: ImageCoalescerView;
};

export type PerChatSendTurnRuntimeState = PerChatCleanupRuntimeState & {
  chatSessions: Map<string, unknown>;
  durability: { markInboundFailed: ReturnType<typeof vi.fn> } | null;
  ensureSessionAndQueue: ReturnType<typeof vi.fn>;
  ensureSessionAndQueueSync: ReturnType<typeof vi.fn>;
  pendingTurnActorJid: Map<string, string | undefined>;
  replyGuarantee: { disarm: ReturnType<typeof vi.fn> };
  sendTurnPerChat: (chatJid: string, text: string, mapKey: string, actorJid?: string) => Promise<void>;
  processPerChatTurn(
    scopeRef: { value: string },
    turn: {
      sourceMessageId: string;
      conversationKey: string;
      chatJid: string;
      senderJid: string;
      senderName: string | null;
      text: string;
      isGroup: boolean;
      contentType: 'text';
      runtimeContext: ReturnType<typeof makeRuntimeTurnContext>;
      inboundSeq: number;
    },
  ): Promise<void>;
};

export function getPerChatCleanupState(runtime: AgentRuntime): PerChatCleanupRuntimeState {
  return runtime as unknown as PerChatCleanupRuntimeState;
}

export function setOwnedTestSession(
  runtime: AgentRuntime,
  mapKey: string,
  session: object,
  toolScopeKey = `${mapKey}#test`,
): string {
  const state = runtime as unknown as {
    setOwnedPerChatSession: (key: string, value: unknown) => void;
    sessionEventToolScopes: WeakMap<object, string>;
  };
  state.setOwnedPerChatSession(mapKey, session);
  state.sessionEventToolScopes.set(session, toolScopeKey);
  return toolScopeKey;
}

export type PendingSystemResultTrackerView = {
  mark(input: MarkSystemTurnInput): SystemTurnLeaseToken;
  cancel(lease: SystemTurnLeaseToken | null | undefined): boolean;
  peek(scopeKey: string): PendingSystemTurnSnapshot | null;
  count(scopeKey: string): number;
  blockingCount(scopeKey: string): number;
};

export function pendingSystemResults(runtime: AgentRuntime): PendingSystemResultTrackerView {
  return (runtime as unknown as {
    pendingSystemResults: PendingSystemResultTrackerView;
  }).pendingSystemResults;
}

export function markOwnedSystemTurn(
  runtime: AgentRuntime,
  sourceSession: object,
  scopeKey: string,
  purpose: SystemTurnPurpose,
  routeChatJid?: string,
): SystemTurnLeaseToken {
  const state = runtime as unknown as {
    captureSystemTurnOwner(
      session: object,
      key: string,
    ): MarkSystemTurnInput['owner'];
  };
  return pendingSystemResults(runtime).mark({
    scopeKey,
    purpose,
    owner: state.captureSystemTurnOwner(sourceSession, scopeKey),
    ...(routeChatJid !== undefined ? { routeChatJid } : {}),
  });
}

export function publishSingletonTestOwner(
  runtime: AgentRuntime,
  sourceSession: object,
  routeChatJid: string,
): void {
  const state = runtime as unknown as {
    session: object | null;
    managerIdFor(session: object): string;
    sessionEventToolScopes: WeakMap<object, string>;
    publishLegacyProviderTurn(
      session: object,
      scopeKey: string,
      routeChatJid: string,
    ): unknown;
  };
  state.session = sourceSession;
  state.managerIdFor(sourceSession);
  state.sessionEventToolScopes.set(sourceSession, '__global__');
  state.publishLegacyProviderTurn(sourceSession, '__global__', routeChatJid);
}

export function handlePerChatProviderEvent(
  runtime: AgentRuntime,
  sourceSession: object,
  event: AgentEvent,
): void {
  const state = runtime as unknown as {
    sessionEventToolScopes: WeakMap<object, string>;
    handleEventPerChat(session: object, event: AgentEvent, toolScopeKey: string): void;
  };
  const toolScopeKey = state.sessionEventToolScopes.get(sourceSession);
  if (!toolScopeKey) throw new Error('test source session has no registered tool scope');
  state.handleEventPerChat(sourceSession, event, toolScopeKey);
}

export function currentCrashIdentity(runtime: AgentRuntime, mapKey: string): {
  generationIdentity: { managerId: string; generation: number };
} {
  const owner = (runtime as unknown as {
    sessionOwnership: { get: (key: string) => { managerId: string; generation: number } | undefined };
  }).sessionOwnership.get(mapKey);
  if (!owner) throw new Error(`missing test owner for ${mapKey}`);
  return {
    generationIdentity: {
      managerId: owner.managerId,
      generation: owner.generation,
    },
  };
}
