// A provider-fallback replay recreates the held turn's session. It must hand the
// held turn's context to the recreate call, so that a queue the recreate creates
// can resume the turn. A dropped trailing optional argument still typechecks, so
// only these call records show it.

import { describe, expect, it, vi } from 'vitest';

import {
  replayTurnOnFallback,
  type FallbackReplayHost,
} from '../../../src/runtimes/agent/fallback-replay.ts';
import type { RuntimeTurnContext } from '../../../src/runtimes/agent/runtime-turn-context.ts';

const CHAT_JID = '15550190077@s.whatsapp.net';

/** The module only passes the context on, so any object serves. */
const heldContext = { identity: { logicalTurnId: 'turn-held' } } as unknown as RuntimeTurnContext;

function fakeHost(): FallbackReplayHost {
  return {
    perChatExecActorQueue: new Map(),
    session: {},
    currentTurnChatJid: null,
    currentTurnReplayText: null,
    currentTurnReplayActorJid: undefined,
    turnHadVisibleOutput: true,
    discardPerChatSessionForFallback: vi.fn(() => true),
    discardSingletonSessionForFallback: vi.fn(() => true),
    recreatePerChatSessionForFallback: vi.fn(),
    recreateSingletonSessionForFallback: vi.fn(),
    isReplayRouteCurrent: vi.fn(() => true),
    bindActiveGlobalMcpConversation: vi.fn(),
    sendTurnPerChat: vi.fn(async () => undefined),
    sendTurnToSession: vi.fn(async () => undefined),
  } as unknown as FallbackReplayHost;
}

function recreateCalls(host: FallbackReplayHost): { perChat: unknown[][]; single: unknown[][] } {
  return {
    perChat: vi.mocked(host.recreatePerChatSessionForFallback).mock.calls,
    single: vi.mocked(host.recreateSingletonSessionForFallback).mock.calls,
  };
}

describe('replayTurnOnFallback passes the held turn context to the recreate call', () => {
  it('passes it to the per-chat recreate', async () => {
    const host = fakeHost();

    await replayTurnOnFallback(host, {
      chatJid: CHAT_JID,
      mapKey: CHAT_JID,
      replayText: 'r',
      oldSession: null,
      runtimeContext: heldContext,
    });

    expect(recreateCalls(host)).toEqual({
      perChat: [[CHAT_JID, CHAT_JID, undefined, undefined, heldContext]],
      single: [],
    });
  });

  it('passes it to the singleton recreate', async () => {
    const host = fakeHost();

    await replayTurnOnFallback(host, {
      chatJid: CHAT_JID,
      replayText: 'r',
      oldSession: null,
      runtimeContext: heldContext,
    });

    expect(recreateCalls(host)).toEqual({
      perChat: [],
      single: [[CHAT_JID, undefined, undefined, heldContext]],
    });
  });
});
