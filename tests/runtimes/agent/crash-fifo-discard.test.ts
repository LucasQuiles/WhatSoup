import { describe, expect, it, vi } from 'vitest';

import { Database } from '../../../src/core/database.ts';
import { DurabilityEngine } from '../../../src/core/durability.ts';
import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import {
  SessionManager,
  type SessionCrashInfo,
} from '../../../src/runtimes/agent/session.ts';
import { makeMessenger } from './lib/session-harness.ts';

vi.mock('../../../src/logger.ts', async () => {
  const { loggerMock } = await import('../../helpers/logger-mock.ts');
  const mock = loggerMock();
  const logger = mock.createChildLogger();
  return {
    ...mock,
    default: { ...logger, child: () => logger },
    flushLogger: vi.fn(),
  };
});

type RuntimeState = {
  perChatInboundSeqQueue: Map<string, number[]>;
  replyGuarantee: {
    arm(args: { inboundSeq: number; chatJid: string }): void;
    disarm(seq: number): void;
    isArmed(seq: number): boolean;
  } | null;
  sessionOwnership: {
    get(mapKey: string): { managerId: string; generation: number; state: string } | undefined;
    transition(mapKey: string, managerId: string, state: 'active'): void;
  };
  crashes: { record(scopeKey: string): number };
  getCrashCount(mapKey: string): number;
  setOwnedPerChatSession(mapKey: string, session: SessionManager): void;
  handlePerChatCrash(
    mapKey: string,
    chatJid: string,
    info: SessionCrashInfo,
    expectedSession: SessionManager,
  ): void;
};

type InboundRow = {
  seq: number;
  processing_status: string;
  terminal_reason: string | null;
  failure_class: string | null;
};

function readInboundRows(db: Database, seqA: number, seqB: number): InboundRow[] {
  return db.raw.prepare(`
    SELECT seq, processing_status, terminal_reason, failure_class
    FROM inbound_events
    WHERE seq IN (?, ?)
    ORDER BY seq
  `).all(seqA, seqB) as unknown as InboundRow[];
}

describe('per-chat crash FIFO retention', () => {
  it('retains a journaled FIFO when no immutable turn context can prove its terminal identity', () => {
    const db = new Database(':memory:');
    db.open();

    try {
      const durability = new DurabilityEngine(db);
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'crash-fifo-test', {
        sessionScope: 'per_chat',
      });
      runtime.setDurability(durability);
      const state = runtime as unknown as RuntimeState;
      const chatJid = 'crash-fifo@s.whatsapp.net';
      const manager = new SessionManager({ db, messenger, chatJid, onEvent: () => {} });

      state.setOwnedPerChatSession(chatJid, manager);
      const owner = state.sessionOwnership.get(chatJid);
      if (!owner) throw new Error('current-generation owner was not registered');
      state.sessionOwnership.transition(chatJid, owner.managerId, 'active');

      const seqA = durability.journalInbound('crash-fifo-a', chatJid, chatJid, 'agent');
      const seqB = durability.journalInbound('crash-fifo-b', chatJid, chatJid, 'agent');
      state.perChatInboundSeqQueue.set(chatJid, [seqA, seqB]);
      if (!state.replyGuarantee) throw new Error('reply guarantee was not initialized');
      state.replyGuarantee.arm({ inboundSeq: seqA, chatJid });
      state.replyGuarantee.arm({ inboundSeq: seqB, chatJid });
      const disarm = vi.spyOn(state.replyGuarantee, 'disarm');

      state.handlePerChatCrash(chatJid, chatJid, {
        exitCode: 42,
        signal: null,
        sessionId: null,
        dbRowId: null,
        generationIdentity: { managerId: owner.managerId, generation: owner.generation },
      }, manager);

      expect(readInboundRows(db, seqA, seqB)).toEqual([
        { seq: seqA, processing_status: 'processing', terminal_reason: null, failure_class: null },
        { seq: seqB, processing_status: 'processing', terminal_reason: null, failure_class: null },
      ]);
      expect(state.perChatInboundSeqQueue.get(chatJid)).toEqual([seqA, seqB]);
      expect(state.sessionOwnership.get(chatJid)).toMatchObject({
        managerId: owner.managerId,
        generation: owner.generation,
        state: 'recoverable_dead',
      });
      expect(state.getCrashCount(chatJid)).toBe(1);
      expect(disarm).not.toHaveBeenCalled();
      expect(state.replyGuarantee.isArmed(seqA)).toBe(true);
      expect(state.replyGuarantee.isArmed(seqB)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('retains exhausted ownership instead of guessing terminals for contextless journaled rows', () => {
    const db = new Database(':memory:');
    db.open();

    try {
      const durability = new DurabilityEngine(db);
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'crash-fifo-exhausted-test', {
        sessionScope: 'per_chat',
      });
      runtime.setDurability(durability);
      const state = runtime as unknown as RuntimeState;
      const chatJid = 'crash-fifo-exhausted@s.whatsapp.net';
      const manager = new SessionManager({ db, messenger, chatJid, onEvent: () => {} });

      state.setOwnedPerChatSession(chatJid, manager);
      const owner = state.sessionOwnership.get(chatJid);
      if (!owner) throw new Error('current-generation owner was not registered');
      state.sessionOwnership.transition(chatJid, owner.managerId, 'active');

      const seqA = durability.journalInbound('crash-fifo-exhausted-a', chatJid, chatJid, 'agent');
      const seqB = durability.journalInbound('crash-fifo-exhausted-b', chatJid, chatJid, 'agent');
      state.perChatInboundSeqQueue.set(chatJid, [seqA, seqB]);
      if (!state.replyGuarantee) throw new Error('reply guarantee was not initialized');
      state.replyGuarantee.arm({ inboundSeq: seqA, chatJid });
      state.replyGuarantee.arm({ inboundSeq: seqB, chatJid });
      const disarm = vi.spyOn(state.replyGuarantee, 'disarm');
      const legacyTerminalWrite = vi.spyOn(durability, 'markInboundFailed').mockImplementation(() => {
        throw new Error('contextless terminal write must not run');
      });
      for (let prior = 0; prior < 3; prior += 1) state.crashes.record(chatJid);

      expect(() => state.handlePerChatCrash(chatJid, chatJid, {
        exitCode: 42,
        signal: null,
        sessionId: null,
        dbRowId: null,
        generationIdentity: { managerId: owner.managerId, generation: owner.generation },
      }, manager)).not.toThrow();

      expect(legacyTerminalWrite).not.toHaveBeenCalled();
      expect(readInboundRows(db, seqA, seqB)).toEqual([
        { seq: seqA, processing_status: 'processing', terminal_reason: null, failure_class: null },
        { seq: seqB, processing_status: 'processing', terminal_reason: null, failure_class: null },
      ]);
      expect(state.perChatInboundSeqQueue.get(chatJid)).toEqual([seqA, seqB]);
      expect(state.sessionOwnership.get(chatJid)).toMatchObject({
        managerId: owner.managerId,
        generation: owner.generation,
        state: 'exhausted',
      });
      expect(state.getCrashCount(chatJid)).toBe(4);
      expect(disarm).not.toHaveBeenCalled();
      expect(state.replyGuarantee.isArmed(seqA)).toBe(true);
      expect(state.replyGuarantee.isArmed(seqB)).toBe(true);
    } finally {
      db.close();
    }
  });
});
