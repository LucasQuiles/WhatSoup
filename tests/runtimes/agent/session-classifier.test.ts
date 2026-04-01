import { describe, it, expect, beforeEach } from 'vitest';
import { Database } from '../../../src/core/database.ts';
import { DurabilityEngine } from '../../../src/core/durability.ts';
import { ensureAgentSchema } from '../../../src/runtimes/agent/session-db.ts';
import {
  classifyActiveSessions,
  type PidOwnershipChecker,
} from '../../../src/runtimes/agent/session-classifier.ts';

let db: Database;
let durability: DurabilityEngine;

function setup() {
  db = new Database(':memory:');
  db.open();
  ensureAgentSchema(db);
  durability = new DurabilityEngine(db);
}

function insertSession(fields: {
  sessionId?: string;
  claudePid: number;
  chatJid?: string;
  status?: string;
}): number {
  const result = db.raw.prepare(`
    INSERT INTO agent_sessions (session_id, claude_pid, started_in_directory, chat_jid, status, started_at)
    VALUES (?, ?, '/tmp', ?, ?, datetime('now'))
  `).run(
    fields.sessionId ?? null,
    fields.claudePid,
    fields.chatJid ?? null,
    fields.status ?? 'active',
  );
  return Number(result.lastInsertRowid);
}

/** All PIDs alive and owned by this service */
const allOwned: PidOwnershipChecker = () => ({ alive: true, owned: true });

/** All PIDs alive but NOT owned (unverified) */
const allAliveNotOwned: PidOwnershipChecker = () => ({ alive: true, owned: false });

/** All PIDs dead */
const allDead: PidOwnershipChecker = () => ({ alive: false, owned: false });

/** Specific PIDs owned, rest dead */
function ownedPids(...pids: number[]): PidOwnershipChecker {
  const set = new Set(pids);
  return (pid) => set.has(pid)
    ? { alive: true, owned: true }
    : { alive: false, owned: false };
}

/** Specific PIDs alive-but-not-owned */
function aliveNotOwnedPids(...pids: number[]): PidOwnershipChecker {
  return (pid) => pids.includes(pid)
    ? { alive: true, owned: false }
    : { alive: false, owned: false };
}

describe('classifyActiveSessions', () => {
  beforeEach(setup);

  // ── Basic classification ──

  it('returns empty array when no active sessions', () => {
    expect(classifyActiveSessions(db, durability, allOwned)).toEqual([]);
  });

  it('classifies single session matching active checkpoint as authoritative_live', () => {
    insertSession({ claudePid: 1000, sessionId: 'ses-1', chatJid: '12345@s.whatsapp.net' });
    durability.upsertSessionCheckpoint('12345', {
      claudePid: 1000, sessionId: 'ses-1', sessionStatus: 'active',
    });

    const results = classifyActiveSessions(db, durability, allOwned);
    expect(results).toHaveLength(1);
    expect(results[0].classification).toBe('authoritative_live');
    expect(results[0].conversationKey).toBe('12345');
  });

  it('classifies stale session with owned PID as stale_live', () => {
    insertSession({ claudePid: 1000, sessionId: 'old', chatJid: '12345@s.whatsapp.net' });
    insertSession({ claudePid: 2000, sessionId: 'new', chatJid: '12345@s.whatsapp.net' });
    durability.upsertSessionCheckpoint('12345', {
      claudePid: 2000, sessionId: 'new', sessionStatus: 'active',
    });

    const results = classifyActiveSessions(db, durability, allOwned);
    const stale = results.find(r => r.claudePid === 1000);
    const auth = results.find(r => r.claudePid === 2000);
    expect(auth?.classification).toBe('authoritative_live');
    expect(stale?.classification).toBe('stale_live');
  });

  it('classifies stale session with dead PID as stale_dead', () => {
    insertSession({ claudePid: 1000, sessionId: 'old', chatJid: '12345@s.whatsapp.net' });
    insertSession({ claudePid: 2000, sessionId: 'new', chatJid: '12345@s.whatsapp.net' });
    durability.upsertSessionCheckpoint('12345', {
      claudePid: 2000, sessionId: 'new', sessionStatus: 'active',
    });

    const results = classifyActiveSessions(db, durability, ownedPids(2000));
    const stale = results.find(r => r.claudePid === 1000);
    expect(stale?.classification).toBe('stale_dead');
  });

  // ── PID ownership verification ──

  it('classifies alive-but-unowned PID as ambiguous (not stale_live)', () => {
    insertSession({ claudePid: 1000, sessionId: 'old', chatJid: '12345@s.whatsapp.net' });
    insertSession({ claudePid: 2000, sessionId: 'new', chatJid: '12345@s.whatsapp.net' });
    durability.upsertSessionCheckpoint('12345', {
      claudePid: 2000, sessionId: 'new', sessionStatus: 'active',
    });

    // PID 1000 is alive but not owned by this service (PID reuse or different parent)
    const checker: PidOwnershipChecker = (pid) =>
      pid === 2000
        ? { alive: true, owned: true }
        : { alive: true, owned: false };

    const results = classifyActiveSessions(db, durability, checker);
    const stale = results.find(r => r.claudePid === 1000);
    // Must be ambiguous, NOT stale_live — we can't safely kill an unowned PID
    expect(stale?.classification).toBe('ambiguous');
    expect(stale?.reason).toContain('ownership unverified');
  });

  // ── Checkpoint status handling ──

  it('does not label any session authoritative when checkpoint is suspended', () => {
    insertSession({ claudePid: 1000, sessionId: 'ses-1', chatJid: '12345@s.whatsapp.net' });
    durability.upsertSessionCheckpoint('12345', {
      claudePid: 1000, sessionId: 'ses-1', sessionStatus: 'suspended',
    });

    const results = classifyActiveSessions(db, durability, allOwned);
    expect(results).toHaveLength(1);
    // Even though PID and session_id match, checkpoint is suspended → stale
    expect(results[0].classification).toBe('stale_live');
    expect(results[0].reason).toContain("checkpoint status is 'suspended'");
  });

  it('does not label any session authoritative when checkpoint is orphaned', () => {
    insertSession({ claudePid: 1000, sessionId: 'ses-1', chatJid: '12345@s.whatsapp.net' });
    durability.upsertSessionCheckpoint('12345', {
      claudePid: 1000, sessionId: 'ses-1', sessionStatus: 'orphaned',
    });

    const results = classifyActiveSessions(db, durability, allOwned);
    expect(results[0].classification).toBe('stale_live');
    expect(results[0].reason).toContain("checkpoint status is 'orphaned'");
  });

  // ── Ambiguous cases ──

  it('classifies sessions without checkpoint as ambiguous', () => {
    insertSession({ claudePid: 1000, sessionId: 'ses-1', chatJid: '12345@s.whatsapp.net' });

    const results = classifyActiveSessions(db, durability, allOwned);
    expect(results[0].classification).toBe('ambiguous');
    expect(results[0].reason).toContain('no session_checkpoint');
  });

  it('classifies sessions without chat_jid as ambiguous', () => {
    insertSession({ claudePid: 1000, sessionId: 'ses-1' });

    const results = classifyActiveSessions(db, durability, allOwned);
    expect(results[0].classification).toBe('ambiguous');
    expect(results[0].reason).toContain('no chat_jid');
  });

  it('marks PID-match as ambiguous when multiple sessions exist for same conversation', () => {
    insertSession({ claudePid: 1000, sessionId: 'ses-a', chatJid: '12345@s.whatsapp.net' });
    insertSession({ claudePid: 3000, sessionId: 'ses-b', chatJid: '12345@s.whatsapp.net' });
    durability.upsertSessionCheckpoint('12345', {
      claudePid: 1000, sessionId: 'old-ses', sessionStatus: 'active',
    });

    const results = classifyActiveSessions(db, durability, allOwned);
    const s1000 = results.find(r => r.claudePid === 1000);
    const s3000 = results.find(r => r.claudePid === 3000);
    expect(s1000?.classification).toBe('ambiguous');
    expect(s3000?.classification).toBe('stale_live'); // no match at all, owned → stale
  });

  // ── Edge cases ──

  it('handles PID match with different session_id (single session, respawn)', () => {
    insertSession({ claudePid: 1000, sessionId: 'new-ses', chatJid: '12345@s.whatsapp.net' });
    durability.upsertSessionCheckpoint('12345', {
      claudePid: 1000, sessionId: 'old-ses', sessionStatus: 'active',
    });

    const results = classifyActiveSessions(db, durability, allOwned);
    expect(results[0].classification).toBe('authoritative_live');
  });

  it('classifies multiple conversations independently', () => {
    insertSession({ claudePid: 1000, sessionId: 'a-ses', chatJid: 'alice@s.whatsapp.net' });
    durability.upsertSessionCheckpoint('alice', {
      claudePid: 1000, sessionId: 'a-ses', sessionStatus: 'active',
    });

    insertSession({ claudePid: 2000, sessionId: 'b-old', chatJid: 'bob@s.whatsapp.net' });
    insertSession({ claudePid: 3000, sessionId: 'b-new', chatJid: 'bob@s.whatsapp.net' });
    durability.upsertSessionCheckpoint('bob', {
      claudePid: 3000, sessionId: 'b-new', sessionStatus: 'active',
    });

    const results = classifyActiveSessions(db, durability, allOwned);
    expect(results.find(r => r.claudePid === 1000)?.classification).toBe('authoritative_live');
    expect(results.find(r => r.claudePid === 2000)?.classification).toBe('stale_live');
    expect(results.find(r => r.claudePid === 3000)?.classification).toBe('authoritative_live');
  });

  it('ignores non-active sessions', () => {
    insertSession({ claudePid: 1000, sessionId: 'ses-1', chatJid: '12345@s.whatsapp.net', status: 'crashed' });
    insertSession({ claudePid: 2000, sessionId: 'ses-2', chatJid: '12345@s.whatsapp.net', status: 'suspended' });

    expect(classifyActiveSessions(db, durability, allOwned)).toEqual([]);
  });

  it('handles @lid JIDs via toConversationKey normalization', () => {
    insertSession({ claudePid: 1000, sessionId: 'ses-1', chatJid: '12345@lid' });
    durability.upsertSessionCheckpoint('12345', {
      claudePid: 1000, sessionId: 'ses-1', sessionStatus: 'active',
    });

    const results = classifyActiveSessions(db, durability, allOwned);
    expect(results[0].classification).toBe('authoritative_live');
    expect(results[0].conversationKey).toBe('12345');
  });

  // ── Integration scenario ──

  it('reproduces the Q zombie scenario: 4 sessions, 1 authoritative, 3 stale', () => {
    insertSession({ claudePid: 2880080, sessionId: 'ses-96', chatJid: '15550100002@lid' });
    insertSession({ claudePid: 3180200, sessionId: 'ses-97', chatJid: '15550100002@lid' });
    insertSession({ claudePid: 3331484, sessionId: 'ses-98', chatJid: '15550100002@lid' });
    insertSession({ claudePid: 3521309, sessionId: 'ses-99', chatJid: '15550100002@lid' });

    durability.upsertSessionCheckpoint('15550100002', {
      claudePid: 3521309, sessionId: 'ses-99', sessionStatus: 'active',
    });

    // All 4 PIDs alive and owned
    const results = classifyActiveSessions(db, durability, allOwned);
    expect(results).toHaveLength(4);

    const auth = results.filter(r => r.classification === 'authoritative_live');
    const stale = results.filter(r => r.classification === 'stale_live');

    expect(auth).toHaveLength(1);
    expect(auth[0].claudePid).toBe(3521309);
    expect(stale).toHaveLength(3);
    expect(stale.map(s => s.claudePid).sort()).toEqual([2880080, 3180200, 3331484]);
  });

  it('Q zombie scenario with unowned PIDs falls to ambiguous', () => {
    insertSession({ claudePid: 2880080, sessionId: 'ses-96', chatJid: '15550100002@lid' });
    insertSession({ claudePid: 3521309, sessionId: 'ses-99', chatJid: '15550100002@lid' });

    durability.upsertSessionCheckpoint('15550100002', {
      claudePid: 3521309, sessionId: 'ses-99', sessionStatus: 'active',
    });

    // PID 2880080 alive but NOT owned (e.g., PID reuse by unrelated process)
    const checker: PidOwnershipChecker = (pid) =>
      pid === 3521309
        ? { alive: true, owned: true }
        : { alive: true, owned: false };

    const results = classifyActiveSessions(db, durability, checker);
    const stale = results.find(r => r.claudePid === 2880080);
    expect(stale?.classification).toBe('ambiguous');
    expect(stale?.reason).toContain('ownership unverified');
  });
});
