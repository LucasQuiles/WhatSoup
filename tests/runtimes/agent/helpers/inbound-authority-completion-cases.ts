import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../../../src/core/database.ts';
import type { DurabilityEngine } from '../../../../src/core/durability.ts';
import { createIngestHandler, getIngestStats } from '../../../../src/core/ingest.ts';
import type { IncomingMessage } from '../../../../src/core/types.ts';
import type { AgentRuntime } from '../../../../src/runtimes/agent/runtime.ts';
import type { TurnQueue } from '../../../../src/runtimes/agent/turn-queue.ts';
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
}

// Reuse the deferred-admission provider fixtures while keeping their test file
// within its size budget. Production runtime, ingest and SQLite remain real.
export function registerInboundAuthorityCompletionCases(fixtures: {
  createHarness(): CompletionHarness;
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
      closeInbound: vi.fn(async () => {}),
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

    it('releases ingest capacity but retains authority through cold startup and provider settlement', async () => {
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

    it('keeps queued predecessors independent without retaining ingest capacity', async () => {
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
        await vi.waitFor(() => expect(db.raw.prepare('SELECT COUNT(*) AS n FROM inbound_events').get())
          .toEqual({ n: 2 }));
        await vi.waitFor(() => expect(getIngestStats().active).toBe(0));
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

    it('retains authority and reports unresolved shutdown after terminal persistence fails', async () => {
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
        await vi.waitFor(() => expect(join).toHaveBeenCalled());
        expect(shutdownFinished).toBe(false);
        expect(authority.closeInbound).not.toHaveBeenCalled();
      } finally {
        release();
        await shutting;
        await handling;
      }
      expect(authority.closeInbound).toHaveBeenCalledExactlyOnceWith({ eventId: 'authority-startup-shutdown' });
      expect(fixtures.sessions().flatMap((session) => session.turnsSent)).toHaveLength(0);
      expect(db.raw.prepare('SELECT processing_status FROM inbound_events WHERE message_id = ?')
        .get('authority-startup-shutdown')).toEqual({ processing_status: 'failed' });
    });
  });

}
