import { beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../../src/core/database.ts';
import { DurabilityEngine } from '../../../src/core/durability.ts';
import { reconcileResidentSessionStatuses } from '../../../src/runtimes/agent/resident-session-reconciler.ts';
import { classifyActiveSessions } from '../../../src/runtimes/agent/session-classifier.ts';
import {
  createSession,
  ensureAgentSchema,
  updateSessionId,
  updateSessionStatus,
} from '../../../src/runtimes/agent/session-db.ts';
import type { SessionManager } from '../../../src/runtimes/agent/session.ts';

let db: Database;
let durability: DurabilityEngine;

beforeEach(() => {
  db = new Database(':memory:');
  db.open();
  ensureAgentSchema(db);
  durability = new DurabilityEngine(db);
});

function residentManager(fields: {
  rowId: number;
  provider?: string;
  conversationKey?: string;
  sessionId?: string | null;
  pid?: number | null;
  active?: boolean;
  durableFailureClosed?: boolean;
}): SessionManager {
  return {
    getDbRowId: () => fields.rowId,
    getProviderId: () => fields.provider ?? 'opencode-cli',
    getStatus: () => ({
      active: fields.active ?? true,
      pid: fields.pid ?? null,
      sessionId: fields.sessionId === undefined ? 'ses-resident' : fields.sessionId,
      startedAt: null,
      messageCount: 0,
      lastMessageAt: null,
      turnInFlight: false,
      durableFailureClosed: fields.durableFailureClosed ?? false,
    }),
  } as unknown as SessionManager;
}

function createOrphanedRow(fields?: {
  provider?: string;
  conversationKey?: string;
  sessionId?: string;
  pid?: number;
}): number {
  const provider = fields?.provider ?? 'opencode-cli';
  const conversationKey = fields?.conversationKey ?? 'resident';
  const sessionId = fields?.sessionId ?? 'ses-resident';
  const id = createSession(
    db,
    fields?.pid ?? 0,
    '/tmp/resident',
    `${conversationKey}@s.whatsapp.net`,
    conversationKey,
    provider,
  );
  updateSessionId(db, id, sessionId);
  updateSessionStatus(db, id, 'orphaned');
  return id;
}

function rowState(id: number): { status: string; ended_at: string | null } {
  return db.raw
    .prepare('SELECT status, ended_at FROM agent_sessions WHERE id = ?')
    .get(id) as { status: string; ended_at: string | null };
}

describe('reconcileResidentSessionStatuses', () => {
  it('restores an orphaned logical resident only when its active checkpoint matches', () => {
    const rowId = createOrphanedRow();
    durability.upsertSessionCheckpoint('resident', {
      sessionId: 'ses-resident',
      sessionStatus: 'active',
    });

    const residentRowIds = reconcileResidentSessionStatuses(
      db,
      [residentManager({ rowId })],
    );

    expect(residentRowIds).toEqual(new Set([rowId]));
    expect(rowState(rowId)).toEqual({ status: 'active', ended_at: null });
    expect(
      classifyActiveSessions(db, durability, () => ({ alive: false, owned: false })),
    ).toEqual([
      expect.objectContaining({
        id: rowId,
        classification: 'authoritative_live',
        conversationKey: 'resident',
      }),
    ]);
  });

  const refusalCases: Array<[string, {
    sessionStatus: string;
    sessionId?: string;
    conversationKey?: string;
    active?: boolean;
    durableFailureClosed?: boolean;
  }]> = [
    ['checkpoint status', { sessionStatus: 'orphaned' }],
    ['checkpoint session', { sessionStatus: 'active', sessionId: 'ses-other' }],
    ['conversation identity', { sessionStatus: 'active', conversationKey: 'other' }],
    ['durability closure', { sessionStatus: 'active', durableFailureClosed: true }],
    ['manager activity', { sessionStatus: 'active', active: false }],
  ];

  it.each(refusalCases)('refuses repair on mismatched %s', (_label, fields) => {
    const rowId = createOrphanedRow();
    durability.upsertSessionCheckpoint(
      fields.conversationKey ?? 'resident',
      {
        sessionId: fields.sessionId ?? 'ses-resident',
        sessionStatus: fields.sessionStatus,
      },
    );

    reconcileResidentSessionStatuses(
      db,
      [residentManager({
        rowId,
        active: fields.active,
        durableFailureClosed: fields.durableFailureClosed,
      })],
    );

    expect(rowState(rowId).status).toBe('orphaned');
  });

  it('requires an exact checkpoint PID for a persistent resident', () => {
    const rowId = createOrphanedRow({
      provider: 'claude-cli',
      pid: 4242,
    });
    durability.upsertSessionCheckpoint('resident', {
      sessionId: 'ses-resident',
      sessionStatus: 'active',
      claudePid: 9999,
    });
    const manager = residentManager({
      rowId,
      provider: 'claude-cli',
      pid: 4242,
    });

    reconcileResidentSessionStatuses(db, [manager]);
    expect(rowState(rowId).status).toBe('orphaned');

    durability.upsertSessionCheckpoint('resident', { claudePid: 4242 });
    reconcileResidentSessionStatuses(db, [manager]);
    expect(rowState(rowId).status).toBe('active');
  });

  it('refuses an invalid persistent process identity', () => {
    const rowId = createOrphanedRow({
      provider: 'claude-cli',
      pid: 0,
    });
    durability.upsertSessionCheckpoint('resident', {
      sessionId: 'ses-resident',
      sessionStatus: 'active',
      claudePid: 0,
    });

    reconcileResidentSessionStatuses(db, [
      residentManager({
        rowId,
        provider: 'claude-cli',
        pid: 0,
      }),
    ]);

    expect(rowState(rowId).status).toBe('orphaned');
  });
});
