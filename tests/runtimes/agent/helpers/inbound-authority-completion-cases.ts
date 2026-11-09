import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../../../src/core/database.ts';
import type { DurabilityEngine } from '../../../../src/core/durability.ts';
import { createIngestHandler, getIngestStats } from '../../../../src/core/ingest.ts';
import type { IncomingMessage } from '../../../../src/core/types.ts';
import type { AgentRuntime } from '../../../../src/runtimes/agent/runtime.ts';
import type { TurnQueue } from '../../../../src/runtimes/agent/turn-queue.ts';
import type { RuntimeTurnCoordinator } from '../../../../src/runtimes/agent/runtime-turn-coordinator.ts';
import { registerTrustedInbound } from '../../../../src/transport/operations-authority-gate.ts';

interface CompletionHarness {
  db: Database;
  engine: DurabilityEngine;
  runtime: AgentRuntime;
  ingest: ReturnType<typeof createIngestHandler>;
}

interface SessionProbe {
  turnInFlight: boolean;
  turnsSent: unknown[];
  emit(event: { type: 'result'; text: string }): void;
  failProviderTurn(error: unknown): void;
}

// Reuse the deferred-admission provider fixtures while keeping their test file
// within its size budget. Production runtime, ingest and SQLite remain real.
export function registerInboundAuthorityCompletionCases(fixtures: {
  createHarness(sessionScope?: 'single' | 'shared' | 'per_chat'): CompletionHarness;
  makeMsg(overrides: Partial<IncomingMessage>): IncomingMessage;
  sessions(): SessionProbe[];
  holdStartup(hold: Promise<void>, onEnter: () => void): void;
}): void {
  const { makeMsg } = fixtures;
  describe('inbound authority completion across admission', () => {
    let db: Database;
    let engine: DurabilityEngine;
    let runtime: AgentRuntime;
    let ingest: ReturnType<typeof createIngestHandler>;
    let shutdownVerified: boolean;
    const authority = {
      registerInbound: vi.fn(async () => ({ kind: 'inbound' as const, automationOperations: [], automationHolds: [] })),
      closeInbound: vi.fn(async (_input: { eventId: string }) => {}),
    };

    async function deliver(msg: IncomingMessage): Promise<void> {
      await registerTrustedInbound(authority, {
        eventId: msg.messageId,
        sender: msg.senderJid,
        conversation: msg.chatJid,
        receivedAt: new Date().toISOString(),
        content: msg.content,
      }, () => ingest(msg));
    }

    function finishProviderTurns(): void {
      for (const session of fixtures.sessions()) {
        if (!session.turnInFlight) continue;
        session.emit({ type: 'result', text: 'completed' });
      }
    }

    beforeEach(() => {
      vi.clearAllMocks();
      shutdownVerified = false;
      ({ db, engine, runtime, ingest } = fixtures.createHarness());
    });

    afterEach(async () => {
      finishProviderTurns();
      if (!shutdownVerified) await runtime.shutdown();
      db.close();
      vi.restoreAllMocks();
    });

    it('releases ingest capacity after queue admission but retains authority through cold startup and settlement', async () => {
      // Break caught: publishing queuedWork settles unadopted completion before bind.
      let release!: () => void;
      const startup = new Promise<void>((resolve) => { release = resolve; });
      let startupEntered = false;
      fixtures.holdStartup(startup, () => { startupEntered = true; });
      const handling = deliver(makeMsg({ messageId: 'authority-cold-start' }));
      try {
        await vi.waitFor(() => expect(startupEntered).toBe(true));
        await vi.waitFor(() => expect(getIngestStats().active).toBe(0));
        expect(fixtures.sessions().flatMap((session) => session.turnsSent)).toHaveLength(0);
        expect(authority.closeInbound).not.toHaveBeenCalled();
        release();
        await vi.waitFor(() => expect(fixtures.sessions().flatMap((session) => session.turnsSent)).toHaveLength(1));
        expect(authority.closeInbound).not.toHaveBeenCalled();
      } finally {
        release();
        await vi.waitFor(() => expect(fixtures.sessions().flatMap((session) => session.turnsSent)).toHaveLength(1));
        finishProviderTurns();
        const queues = (runtime as unknown as { perChatTurnQueues: Map<string, TurnQueue> }).perChatTurnQueues;
        await Promise.all([...queues.values()].map((queue) => queue.idle()));
        await handling;
      }
      expect(authority.closeInbound).toHaveBeenCalledExactlyOnceWith({ eventId: 'authority-cold-start' });
      // The outbound queue double produces no answer receipt; its failed terminal still
      // owns completion, rather than the earlier admission callback.
      expect(db.raw.prepare('SELECT processing_status FROM inbound_events WHERE message_id = ?')
        .get('authority-cold-start')).toEqual({ processing_status: 'failed' });
    });

    it('keeps queued predecessors independent within ingest capacity', async () => {
      const releases = new Map<string, () => void>();
      const holds = new Map(['authority-first', 'authority-second'].map((id) => [
        id,
        new Promise<void>((resolve) => { releases.set(id, resolve); }),
      ]));
      const entered: string[] = [];
      const admissionHost = runtime as unknown as { _handleMessageInner(msg: IncomingMessage): Promise<void> };
      const admit = admissionHost._handleMessageInner.bind(runtime);
      vi.spyOn(admissionHost, '_handleMessageInner').mockImplementation(async (msg) => {
        entered.push(msg.messageId);
        await holds.get(msg.messageId);
        await admit(msg);
      });
      const first = deliver(makeMsg({ messageId: 'authority-first', content: '/help' }));
      await vi.waitFor(() => expect(entered).toEqual(['authority-first']));
      let secondSettled = false;
      const second = deliver(makeMsg({ messageId: 'authority-second', content: '/help' }))
        .then(() => { secondSettled = true; });
      try {
        await vi.waitFor(() => expect(getIngestStats().queued).toBe(1));
        expect(db.raw.prepare('SELECT COUNT(*) AS n FROM inbound_events').get()).toEqual({ n: 1 });
        expect(getIngestStats().active).toBe(1);
        expect(authority.closeInbound).not.toHaveBeenCalled();
        releases.get('authority-first')!();
        await first;
        await vi.waitFor(() => expect(entered).toEqual(['authority-first', 'authority-second']));
        expect(authority.closeInbound).toHaveBeenCalledExactlyOnceWith({ eventId: 'authority-first' });
        expect(secondSettled).toBe(false);
      } finally {
        for (const release of releases.values()) release();
        await Promise.all([first, second]);
      }
      expect(authority.closeInbound).toHaveBeenCalledTimes(2);
      expect(authority.closeInbound).toHaveBeenLastCalledWith({ eventId: 'authority-second' });
    });

    async function useScope(scope: 'single' | 'shared' | 'per_chat'): Promise<void> {
      if (scope === 'per_chat') return;
      await runtime.shutdown();
      db.close();
      ({ db, engine, runtime, ingest } = fixtures.createHarness(scope));
    }

    it.each(['single', 'shared', 'per_chat'] as const)('bounds stalled %s admission and closes each displaced lease once', async (scope) => {
      await useScope(scope);
      let release!: () => void;
      const hold = new Promise<void>((resolve) => { release = resolve; });
      const host = runtime as unknown as {
        _handleMessageInner(msg: IncomingMessage, onAdmitted?: () => void): Promise<void>;
        inboundTurnCompletions: { completions: Map<string, unknown> };
      };
      const admit = host._handleMessageInner.bind(runtime);
      const entered: string[] = [];
      vi.spyOn(host, '_handleMessageInner').mockImplementation(async (msg, onAdmitted) => {
        entered.push(msg.messageId);
        await hold;
        await admit(msg, onAdmitted);
      });
      const droppedBefore = getIngestStats().dropped;
      const ids = Array.from({ length: 31 }, (_, i) => `authority-flood-${scope}-${i}`);
      const handling: Promise<void>[] = [];
      try {
        for (const messageId of ids) {
          handling.push(deliver(makeMsg({ messageId, content: '/help' })));
          // Allow each arrival to finish its synchronous admission microtasks;
          // a simultaneous burst alone would exercise only the overflow queue.
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        expect(authority.registerInbound).toHaveBeenCalledTimes(31);
        expect(getIngestStats()).toEqual({ active: 1, queued: 10, dropped: droppedBefore + 20 });
        expect(host.inboundTurnCompletions.completions.size).toBe(1);
        expect(entered).toEqual([ids[0]]);
        expect(authority.closeInbound.mock.calls.map(([input]) => input.eventId).sort()).toEqual(ids.slice(1, 21).sort());
        expect(fixtures.sessions().flatMap((session) => session.turnsSent)).toHaveLength(0);
      } finally {
        release();
        await Promise.all(handling);
      }
      expect(authority.closeInbound.mock.calls.map(([input]) => input.eventId).sort()).toEqual(ids.sort());
      expect(db.raw.prepare("SELECT COUNT(*) AS n FROM inbound_events WHERE processing_status = 'complete'").get()).toEqual({ n: 11 });
      expect(host.inboundTurnCompletions.completions.size).toBe(0);
      expect(getIngestStats().active).toBe(0);
      expect(getIngestStats().queued).toBe(0);
    });

    it.each(['single', 'shared', 'per_chat'] as const)('releases %s ingest capacity at provider admission while retaining its lease', async (scope) => {
      await useScope(scope);
      const messageId = `authority-provider-${scope}`;
      const handling = deliver(makeMsg({ messageId }));
      try {
        await vi.waitFor(() => expect(fixtures.sessions().flatMap((session) => session.turnsSent)).toHaveLength(1));
        await vi.waitFor(() => expect(getIngestStats().active).toBe(0));
        expect(authority.closeInbound).not.toHaveBeenCalled();
        expect(db.raw.prepare('SELECT processing_status FROM inbound_events WHERE message_id = ?').get(messageId)).toEqual({ processing_status: 'processing' });
      } finally {
        finishProviderTurns();
        await handling;
      }
      expect(authority.closeInbound).toHaveBeenCalledExactlyOnceWith({ eventId: messageId });
      expect(db.raw.prepare('SELECT processing_status FROM inbound_events WHERE message_id = ?').get(messageId)).toEqual({ processing_status: 'failed' });
    });

    it('retains the single-scope lease while provider failure finalization is stalled', async () => {
      await useScope('single');
      let release!: () => void;
      const hold = new Promise<void>((resolve) => { release = resolve; });
      const messageId = 'authority-single-failure';
      const handling = deliver(makeMsg({ messageId }));
      await vi.waitFor(() => expect(fixtures.sessions().flatMap((session) => session.turnsSent)).toHaveLength(1));
      const queue = (runtime as unknown as {
        queue: { flushTurnEvidence(turnId: string): Promise<unknown> };
      }).queue;
      const flush = vi.mocked(queue.flushTurnEvidence).getMockImplementation()!;
      let finalizationEntered = false;
      vi.spyOn(queue, 'flushTurnEvidence').mockImplementation(async (turnId) => {
        finalizationEntered = true;
        await hold;
        return flush(turnId);
      });
      try {
        fixtures.sessions()[0]!.failProviderTurn(new Error('injected provider failure'));
        await vi.waitFor(() => expect(finalizationEntered).toBe(true));
        expect(db.raw.prepare('SELECT processing_status FROM inbound_events WHERE message_id = ?').get(messageId)).toEqual({ processing_status: 'processing' });
        expect(authority.closeInbound).not.toHaveBeenCalled();
      } finally {
        release();
        await vi.waitFor(() => expect(db.raw.prepare('SELECT processing_status FROM inbound_events WHERE message_id = ?').get(messageId)).toEqual({ processing_status: 'failed' }));
        await handling;
      }
      expect(authority.closeInbound).toHaveBeenCalledExactlyOnceWith({ eventId: messageId });
    });

    it('keeps a following single turn behind failed-provider finalization', async () => {
      await useScope('single');
      const firstId = 'authority-single-failed-predecessor';
      const secondId = 'authority-single-following-turn';
      const host = runtime as unknown as {
        _handleMessageInner(msg: IncomingMessage, onAdmitted?: () => void): Promise<void>;
        queue: { flushTurnEvidence(turnId: string): Promise<unknown> };
      };
      const handle = host._handleMessageInner.bind(runtime);
      let releaseFollower!: () => void;
      const followerHold = new Promise<void>((resolve) => { releaseFollower = resolve; });
      let followerEntered = false;
      vi.spyOn(host, '_handleMessageInner').mockImplementation(async (msg, onAdmitted) => {
        if (msg.messageId === secondId) {
          followerEntered = true;
          // Preserve the predecessor during RED cleanup if serialization breaks.
          await followerHold;
        }
        await handle(msg, onAdmitted);
      });
      const first = deliver(makeMsg({ messageId: firstId }));
      await vi.waitFor(() => expect(fixtures.sessions().flatMap((session) => session.turnsSent)).toHaveLength(1));
      let releaseFinalization!: () => void;
      const finalizationHold = new Promise<void>((resolve) => { releaseFinalization = resolve; });
      const flush = vi.mocked(host.queue.flushTurnEvidence).getMockImplementation()!;
      let finalizationEntered = false;
      vi.spyOn(host.queue, 'flushTurnEvidence').mockImplementationOnce(async (turnId) => {
        finalizationEntered = true;
        await finalizationHold;
        return flush(turnId);
      });
      fixtures.sessions()[0]!.failProviderTurn(new Error('injected provider failure before follower'));
      await vi.waitFor(() => expect(finalizationEntered).toBe(true));
      const second = deliver(makeMsg({ messageId: secondId }));
      try {
        await vi.waitFor(() => expect(getIngestStats().active).toBe(1));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(followerEntered).toBe(false);
        expect(authority.closeInbound).not.toHaveBeenCalled();
        expect(fixtures.sessions().flatMap((session) => session.turnsSent)).toHaveLength(1);
      } finally {
        releaseFinalization();
        await first;
        releaseFollower();
        await vi.waitFor(() => expect(fixtures.sessions().flatMap((session) => session.turnsSent)).toHaveLength(2));
        finishProviderTurns();
        await second;
      }
      expect(authority.closeInbound.mock.calls.map(([input]) => input.eventId)).toEqual([firstId, secondId]);
      expect(db.raw.prepare("SELECT COUNT(*) AS n FROM inbound_events WHERE processing_status = 'failed'").get()).toEqual({ n: 2 });
    });

    it.each(['provider preflight', 'evidence publication'] as const)('retains single authority after %s rejects until finalization completes', async (failure) => {
      await useScope('single');
      const host = runtime as unknown as {
        sendTurnToSession(...args: unknown[]): Promise<void>;
        runtimeTurnCoordinator: RuntimeTurnCoordinator;
        isTurnInFlight(scopeKey: string): boolean;
      };
      const coordinator = host.runtimeTurnCoordinator;
      if (failure === 'provider preflight') {
        vi.spyOn(host, 'sendTurnToSession').mockRejectedValueOnce(new Error('injected provider preflight rejection'));
      } else {
        vi.spyOn(coordinator, 'beginRuntimeTurnEvidence').mockImplementationOnce(() => {
          throw new Error('injected evidence publication rejection');
        });
      }
      let release!: () => void;
      const hold = new Promise<void>((resolve) => { release = resolve; });
      const finalize = coordinator.finalizeUndispatchedRuntimeTurn.bind(coordinator);
      let finalizationEntered = false;
      vi.spyOn(coordinator, 'finalizeUndispatchedRuntimeTurn').mockImplementation(async (...args) => {
        finalizationEntered = true;
        await hold;
        return finalize(...args);
      });
      const messageId = `authority-single-preboundary-${failure}`;
      const handling = deliver(makeMsg({ messageId }));
      try {
        await vi.waitFor(() => expect(finalizationEntered).toBe(true));
        expect(fixtures.sessions().flatMap((session) => session.turnsSent)).toHaveLength(0);
        expect(authority.closeInbound).not.toHaveBeenCalled();
        expect(db.raw.prepare('SELECT processing_status FROM inbound_events WHERE message_id = ?').get(messageId)).toEqual({ processing_status: 'processing' });
        expect(host.isTurnInFlight('global')).toBe(true);
      } finally {
        release();
        await handling;
      }
      expect(authority.closeInbound).toHaveBeenCalledExactlyOnceWith({ eventId: messageId });
      expect(db.raw.prepare('SELECT processing_status FROM inbound_events WHERE message_id = ?').get(messageId)).toEqual({ processing_status: 'failed' });
      expect(host.isTurnInFlight('global')).toBe(false);
    });

    it('retains single authority when a preflight rejection cannot persist its terminal result', async () => {
      await useScope('single');
      const host = runtime as unknown as { sendTurnToSession(...args: unknown[]): Promise<void> };
      vi.spyOn(host, 'sendTurnToSession').mockRejectedValueOnce(new Error('injected provider preflight rejection'));
      const finalize = vi.spyOn(engine, 'finalizeTurnTerminal').mockImplementation(() => {
        throw new Error('injected preflight terminal persistence failure');
      });
      const messageId = 'authority-preflight-persistence-failure';
      let settled = false;
      void deliver(makeMsg({ messageId })).then(() => { settled = true; });
      try {
        await vi.waitFor(() => expect(finalize).toHaveBeenCalled());
        expect(authority.closeInbound).not.toHaveBeenCalled();
        expect(db.raw.prepare('SELECT processing_status FROM inbound_events WHERE message_id = ?').get(messageId)).toEqual({ processing_status: 'processing' });
        const shutdown = runtime.shutdown();
        await expect(shutdown).rejects.toThrow('AgentRuntime shutdown failed');
        shutdownVerified = true;
        expect(settled).toBe(false);
        expect(authority.closeInbound).not.toHaveBeenCalled();
      } finally {
        finalize.mockRestore();
      }
    });

    it('joins single-scope shutdown finalization before releasing an undispatched lease', async () => {
      await useScope('single');
      let releaseSend!: () => void;
      let releaseFinalization!: () => void;
      const sendHold = new Promise<void>((resolve) => { releaseSend = resolve; });
      const finalizationHold = new Promise<void>((resolve) => { releaseFinalization = resolve; });
      const host = runtime as unknown as {
        sendTurnToSession(...args: unknown[]): Promise<void>;
        runtimeTurnCoordinator: { finalizeUndispatchedRuntimeTurn(...args: unknown[]): Promise<unknown> };
      };
      const send = host.sendTurnToSession.bind(runtime);
      const coordinator = host.runtimeTurnCoordinator;
      const finalize = coordinator.finalizeUndispatchedRuntimeTurn.bind(coordinator);
      let sendEntered = false;
      let finalizationEntered = false;
      vi.spyOn(host, 'sendTurnToSession').mockImplementation(async (...args) => {
        sendEntered = true;
        await sendHold;
        await send(...args);
      });
      vi.spyOn(coordinator, 'finalizeUndispatchedRuntimeTurn').mockImplementation(async (...args) => {
        finalizationEntered = true;
        await finalizationHold;
        return finalize(...args);
      });
      const messageId = 'authority-single-undispatched-shutdown';
      const handling = deliver(makeMsg({ messageId }));
      let shutting: Promise<void> | undefined;
      try {
        await vi.waitFor(() => expect(sendEntered).toBe(true));
        shutting = runtime.shutdown();
        await vi.waitFor(() => expect(finalizationEntered).toBe(true));
        releaseSend();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(fixtures.sessions().flatMap((session) => session.turnsSent)).toHaveLength(0);
        expect(db.raw.prepare('SELECT processing_status FROM inbound_events WHERE message_id = ?').get(messageId)).toEqual({ processing_status: 'processing' });
        expect(authority.closeInbound).not.toHaveBeenCalled();
      } finally {
        releaseSend();
        releaseFinalization();
        await shutting;
        shutdownVerified = shutting !== undefined;
        await handling;
      }
      expect(authority.closeInbound).toHaveBeenCalledExactlyOnceWith({ eventId: messageId });
      expect(db.raw.prepare('SELECT processing_status FROM inbound_events WHERE message_id = ?').get(messageId)).toEqual({ processing_status: 'failed' });
    });

    it.each(['once', 'persistent'] as const)('retains undispatched single authority through a %s terminal-write fault', async (fault) => {
      await useScope('single');
      let releaseSend!: () => void;
      const sendHold = new Promise<void>((resolve) => { releaseSend = resolve; });
      const host = runtime as unknown as { sendTurnToSession(...args: unknown[]): Promise<void> };
      const send = host.sendTurnToSession.bind(runtime);
      let sendEntered = false;
      vi.spyOn(host, 'sendTurnToSession').mockImplementation(async (...args) => {
        sendEntered = true;
        await sendHold;
        await send(...args);
      });
      const finalize = engine.finalizeTurnTerminal.bind(engine);
      let writes = 0;
      vi.spyOn(engine, 'finalizeTurnTerminal').mockImplementation((...args) => {
        writes += 1;
        if (fault === 'persistent' || writes === 1) throw new Error('injected terminal-write fault');
        return finalize(...args);
      });
      const messageId = `authority-single-write-${fault}`;
      let handlingFinished = false;
      const handling = deliver(makeMsg({ messageId })).then(() => { handlingFinished = true; });
      let stopped: Promise<void> | undefined;
      try {
        await vi.waitFor(() => expect(sendEntered).toBe(true));
        const shutting = runtime.shutdown();
        stopped = expect(shutting).rejects.toThrow('AgentRuntime shutdown failed');
        await vi.waitFor(() => expect(writes).toBeGreaterThan(0));
        releaseSend();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(authority.closeInbound).not.toHaveBeenCalled();
        expect(db.raw.prepare('SELECT processing_status FROM inbound_events WHERE message_id = ?').get(messageId)).toEqual({ processing_status: 'processing' });
      } finally {
        releaseSend();
        await stopped;
        shutdownVerified = stopped !== undefined;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(fixtures.sessions().flatMap((session) => session.turnsSent)).toHaveLength(0);
      if (fault === 'once') {
        await handling;
        expect(authority.closeInbound).toHaveBeenCalledExactlyOnceWith({ eventId: messageId });
        expect(db.raw.prepare('SELECT processing_status FROM inbound_events WHERE message_id = ?').get(messageId)).toEqual({ processing_status: 'failed' });
      } else {
        expect(handlingFinished).toBe(false);
        expect(authority.closeInbound).not.toHaveBeenCalled();
        expect(db.raw.prepare('SELECT processing_status FROM inbound_events WHERE message_id = ?').get(messageId)).toEqual({ processing_status: 'processing' });
      }
    });

    it('settles an empty inbound without leaking an authority lease', async () => {
      await deliver(makeMsg({ messageId: 'authority-empty', content: '' }));
      expect(authority.closeInbound).toHaveBeenCalledExactlyOnceWith({ eventId: 'authority-empty' });
      expect(fixtures.sessions().flatMap((session) => session.turnsSent)).toHaveLength(0);
      expect(db.raw.prepare('SELECT processing_status FROM inbound_events WHERE message_id = ?')
        .get('authority-empty')).toEqual({ processing_status: 'complete' });
    });

    it('settles queued local handling that never binds a provider turn', async () => {
      await deliver(makeMsg({ messageId: 'authority-help', content: '/help' }));
      expect(authority.closeInbound).toHaveBeenCalledExactlyOnceWith({ eventId: 'authority-help' });
      expect(fixtures.sessions().flatMap((session) => session.turnsSent)).toHaveLength(0);
      expect(db.raw.prepare('SELECT processing_status FROM inbound_events WHERE message_id = ?')
        .get('authority-help')).toEqual({ processing_status: 'complete' });
    });

    it('settles shutdown rejection without publishing queued work', async () => {
      await runtime.shutdown();
      await deliver(makeMsg({ messageId: 'authority-after-shutdown' }));
      expect(authority.closeInbound).toHaveBeenCalledExactlyOnceWith({ eventId: 'authority-after-shutdown' });
      expect(fixtures.sessions().flatMap((session) => session.turnsSent)).toHaveLength(0);
      expect(db.raw.prepare('SELECT processing_status FROM inbound_events WHERE message_id = ?')
        .get('authority-after-shutdown')).toEqual({ processing_status: 'failed' });
    });

    it.each(['single', 'per_chat'] as const)('retains %s authority and reports unresolved shutdown after terminal persistence fails', async (scope) => {
      await useScope(scope);
      let settled = false;
      void deliver(makeMsg({ messageId: 'authority-retained-finalizer' })).then(() => { settled = true; });
      await vi.waitFor(() => expect(fixtures.sessions().flatMap((session) => session.turnsSent)).toHaveLength(1));
      const finalize = vi.spyOn(engine, 'finalizeTurnTerminal').mockImplementation(() => {
        throw new Error('injected terminal persistence failure');
      });
      try {
        finishProviderTurns();
        await vi.waitFor(() => expect(finalize).toHaveBeenCalled());
        expect(authority.closeInbound).not.toHaveBeenCalled();
        expect(db.raw.prepare('SELECT processing_status FROM inbound_events WHERE message_id = ?')
          .get('authority-retained-finalizer')).toEqual({ processing_status: 'processing' });
        const shutdown = runtime.shutdown();
        await expect(shutdown).rejects.toThrow('AgentRuntime shutdown failed');
        await expect(shutdown).rejects.toMatchObject({
          errors: expect.arrayContaining([
            expect.objectContaining({ message: 'Runtime turn shutdown left 1 retained finalization(s) unresolved' }),
          ]),
        });
        shutdownVerified = true;
        expect(settled).toBe(false);
        expect(authority.closeInbound).not.toHaveBeenCalled();
      } finally {
        finalize.mockRestore();
      }
    });

    it('joins published admission during shutdown and rejects its later dispatch', async () => {
      let release!: () => void;
      const admission = new Promise<void>((resolve) => { release = resolve; });
      let admissionEntered = false;
      const admissionHost = runtime as unknown as { flushImageCoalesce(mapKey: string): Promise<void> };
      const flush = admissionHost.flushImageCoalesce.bind(runtime);
      vi.spyOn(admissionHost, 'flushImageCoalesce').mockImplementation(async (mapKey) => {
        admissionEntered = true;
        await admission;
        await flush(mapKey);
      });
      const handling = deliver(makeMsg({ messageId: 'authority-startup-shutdown' }));
      await vi.waitFor(() => expect(admissionEntered).toBe(true));
      const lifecycle = (runtime as unknown as {
        routeRecycleLifecycle: { awaitForShutdown(deadline: number): Promise<void> };
      }).routeRecycleLifecycle;
      const join = vi.spyOn(lifecycle, 'awaitForShutdown');
      let shutdownFinished = false;
      const shutting = runtime.shutdown().then(() => { shutdownFinished = true; });
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(shutdownFinished).toBe(false);
        expect(authority.closeInbound).not.toHaveBeenCalled();
      } finally {
        release();
        await shutting;
        await handling;
      }
      expect(join).toHaveBeenCalled();
      expect(authority.closeInbound).toHaveBeenCalledExactlyOnceWith({ eventId: 'authority-startup-shutdown' });
      expect(fixtures.sessions().flatMap((session) => session.turnsSent)).toHaveLength(0);
      expect(db.raw.prepare('SELECT processing_status FROM inbound_events WHERE message_id = ?')
        .get('authority-startup-shutdown')).toEqual({ processing_status: 'failed' });
    });
  });

}
