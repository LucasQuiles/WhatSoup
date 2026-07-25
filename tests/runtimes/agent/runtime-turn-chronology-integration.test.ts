import { afterEach, describe, expect, it, vi } from 'vitest';

import { Database } from '../../../src/core/database.ts';
import type { RuntimeTurnContext } from '../../../src/runtimes/agent/runtime-turn-context.ts';
import {
  type RuntimeState,
  context,
  makeRuntimeState,
  queueStub,
  sessionStub,
} from './lib/runtime-terminal-coordinator-harness.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runtime turn chronology integration', () => {
  it('renders chronology at the provider boundary and exposes content-free delay metrics', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { runtime, state } = makeRuntimeState<RuntimeState & {
        sendTurnToSession(
          session: ReturnType<typeof sessionStub>,
          chatJid: string,
          text: string,
          mapKey?: string,
          actorJid?: string,
          beforeUserSend?: () => void,
          systemTurnLease?: undefined,
          dispatchAllowed?: undefined,
          runtimeContext?: RuntimeTurnContext,
          deliveryKind?: 'live' | 'queued' | 'recovery_replay',
        ): Promise<void>;
      }>(db);
      const baseContext = context('singleton', '15550190039', 81, 'turn-delayed-boundary');
      const receivedAtUnixSeconds = 1_780_000_000;
      vi.spyOn(Date, 'now').mockReturnValue((receivedAtUnixSeconds + 95) * 1000);
      const runtimeContext: RuntimeTurnContext = {
        ...baseContext,
        replay: { ...baseContext.replay, receivedAtUnixSeconds },
      };
      const session = sessionStub();

      await state.sendTurnToSession(
        session,
        runtimeContext.identity.deliveryJid,
        'stop the stale action',
        undefined,
        runtimeContext.replay.senderJid,
        undefined,
        undefined,
        undefined,
        runtimeContext,
        'queued',
      );

      const calls = vi.mocked(session.sendTurn).mock.calls as unknown[][];
      const providerInput = calls[0]?.[0] as {
        applicationContext: string[];
        userText: string;
      };
      expect(providerInput.applicationContext[0]).toContain('WhatSoup delivery context');
      expect(providerInput.applicationContext[0]).toContain('Queue age: 95 seconds');
      expect(providerInput.applicationContext[0]).toContain('Delivery: queued');
      expect(providerInput.userText).toBe('stop the stale action');
      expect(runtime.getHealthSnapshot().details).toMatchObject({
        chronologyDelayedDispatches: 1,
        chronologyRecoveryReplayDispatches: 0,
        chronologyMaxQueueAgeSeconds: 95,
      });
    } finally {
      db.close();
    }
  });

  it('delivers exact user text when the stored receipt timestamp is invalid', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { state } = makeRuntimeState<RuntimeState>(db);
      const baseContext = context('singleton', '15550190041', 83, 'turn-invalid-receipt');
      const runtimeContext: RuntimeTurnContext = {
        ...baseContext,
        replay: { ...baseContext.replay, receivedAtUnixSeconds: Number.NaN },
      };
      const session = sessionStub();

      await state.sendTurnToSession(
        session,
        runtimeContext.identity.deliveryJid,
        'deliver this exact text',
        undefined,
        runtimeContext.replay.senderJid,
        undefined,
        undefined,
        undefined,
        runtimeContext,
        'queued',
      );

      expect(session.sendTurn).toHaveBeenCalledWith('deliver this exact text');
    } finally {
      db.close();
    }
  });

  it('keeps the captured fallback chronology when ambient turn state changes during shutdown', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { state } = makeRuntimeState<RuntimeState>(db);
      const captured = context('singleton', '15550190042', 84, 'turn-captured-fallback');
      const ambientReplacement = context('singleton', '15550190043', 85, 'turn-ambient-replacement');
      const oldSession = sessionStub();
      const replacementSession = sessionStub();
      let releaseShutdown!: () => void;
      const shutdownGate = new Promise<void>((resolve) => {
        releaseShutdown = resolve;
      });
      oldSession.shutdown.mockImplementation(async () => shutdownGate);

      const dispatch = vi.fn(async (..._args: unknown[]) => {});
      const mutable = state as RuntimeState & {
        session: ReturnType<typeof sessionStub> | null;
        recreateSingletonSessionForFallback(chatJid: string, actorJid?: string): void;
        sendTurnToSession: typeof dispatch;
      };
      mutable.recreateSingletonSessionForFallback = vi.fn(() => {
        mutable.session = replacementSession;
      });
      mutable.sendTurnToSession = dispatch;
      state.currentRuntimeTurnContext = captured;

      const replay = (
        state.runtimeTurnCoordinator as unknown as {
          replayTurnOnFallback(args: {
            chatJid: string;
            replayText: string;
            oldSession: ReturnType<typeof sessionStub>;
            runtimeContext: RuntimeTurnContext;
          }): Promise<void>;
        }
      ).replayTurnOnFallback({
        chatJid: captured.identity.deliveryJid,
        replayText: captured.replay.text,
        oldSession,
        runtimeContext: captured,
      });

      await vi.waitFor(() => expect(oldSession.shutdown).toHaveBeenCalledWith(false));
      state.currentRuntimeTurnContext = ambientReplacement;
      releaseShutdown();
      await replay;

      const call = dispatch.mock.calls[0]!;
      expect(call[2]).toBe(captured.replay.text);
      expect(call[8]).toBe(captured);
      expect(call[9]).toBe('recovery_replay');
    } finally {
      db.close();
    }
  });

  it('labels a held per-chat fallback continuation without re-admitting its context', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { runtime, state } = makeRuntimeState<RuntimeState & {
        sessionEventToolScopes: WeakMap<object, string>;
        runtimeTurnCoordinator: RuntimeState['runtimeTurnCoordinator'] & {
          beginRuntimeTurnContinuation(context: RuntimeTurnContext): boolean;
        };
      }>(db, { sessionScope: 'per_chat' });
      const mapKey = '15550190040';
      const baseContext = context('per_chat', mapKey, 82, 'turn-fallback-chronology');
      const receivedAtUnixSeconds = 1_780_000_000;
      vi.spyOn(Date, 'now').mockReturnValue((receivedAtUnixSeconds + 1) * 1000);
      const runtimeContext: RuntimeTurnContext = {
        ...baseContext,
        replay: { ...baseContext.replay, receivedAtUnixSeconds },
      };
      const session = sessionStub();
      const managerId = state.managerIdFor(session);
      state.sessionOwnership.claim(mapKey, managerId);
      state.chatSessions.set(mapKey, session);
      state.sessionEventToolScopes.set(session, `${mapKey}#fallback`);
      state.chatQueues.set(mapKey, queueStub(runtimeContext.identity.deliveryJid));
      state.perChatRuntimeTurnContexts.set(mapKey, [runtimeContext]);
      expect(state.runtimeTurnCoordinator.beginRuntimeTurnContinuation(runtimeContext)).toBe(true);

      const sendTurnPerChat = state.sendTurnPerChat as unknown as (
        chatJid: string,
        text: string,
        mapKey: string,
        actorJid: string,
      ) => Promise<void>;
      await sendTurnPerChat.call(
        state,
        runtimeContext.identity.deliveryJid,
        runtimeContext.replay.text,
        mapKey,
        runtimeContext.replay.senderJid,
      );

      const calls = vi.mocked(session.sendTurn).mock.calls as unknown[][];
      const providerInput = calls[0]?.[0] as {
        applicationContext: string[];
        userText: string;
      };
      expect(providerInput.applicationContext[0]).toContain('Delivery: recovery replay');
      expect(providerInput.userText).toBe(runtimeContext.replay.text);
      expect(state.perChatRuntimeTurnContexts.get(mapKey)?.[0]).toBe(runtimeContext);
    } finally {
      db.close();
    }
  });
});
