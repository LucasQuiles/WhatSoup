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
      const providerText = calls[0]?.[0] as string | undefined;
      expect(providerText).toContain('Trusted WhatSoup delivery context');
      expect(providerText).toContain('Queue age: 95 seconds');
      expect(providerText).toContain('Delivery: queued');
      expect(providerText?.endsWith('\nstop the stale action')).toBe(true);
      expect(runtime.getHealthSnapshot().details).toMatchObject({
        chronologyDelayedDispatches: 1,
        chronologyRecoveryReplayDispatches: 0,
        chronologyMaxQueueAgeSeconds: 95,
      });
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
      const providerText = calls[0]?.[0] as string | undefined;
      expect(providerText).toContain('Delivery: recovery replay');
      expect(providerText?.endsWith(`\n${runtimeContext.replay.text}`)).toBe(true);
      expect(state.perChatRuntimeTurnContexts.get(mapKey)?.[0]).toBe(runtimeContext);
    } finally {
      db.close();
    }
  });
});
