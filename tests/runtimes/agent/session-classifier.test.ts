import { describe, it, expect, beforeEach } from 'vitest';
import { Database } from '../../../src/core/database.ts';
import { DurabilityEngine } from '../../../src/core/durability.ts';
import { ensureAgentSchema } from '../../../src/runtimes/agent/session-db.ts';
import { classifyActiveSessions } from '../../../src/runtimes/agent/session-classifier.ts';

let db: Database;
let durability: DurabilityEngine;

function setup() {
  db = new Database(':memory:');
  db.open();
  ensureAgentSchema(db);
  durability = new DurabilityEngine(db);
}

function insertSession(fields: {
  id?: number;
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

describe('classifyActiveSessions', () => {
  beforeEach(setup);

  it('returns empty array when no active sessions', () => {
    const results = classifyActiveSessions(db, durability);
    expect(results).toEqual([]);
  });

  it('classifies single session matching checkpoint as authoritative_live', () => {
    insertSession({ claudePid: 1000, sessionId: 'ses-1', chatJid: '12345@s.whatsapp.net' });
    durability.upsertSessionCheckpoint('12345', {
      claudePid: 1000,
      sessionId: 'ses-1',
      sessionStatus: 'active',
    });

    const results = classifyActiveSessions(db, durability, () => true);
    expect(results).toHaveLength(1);
    expect(results[0].classification).toBe('authoritative_live');
    expect(results[0].conversationKey).toBe('12345');
  });

  it('classifies stale session with live PID as stale_live', () => {
    // Two sessions for same conversation — newer one matches checkpoint
    insertSession({ claudePid: 1000, sessionId: 'old-ses', chatJid: '12345@s.whatsapp.net' });
    insertSession({ claudePid: 2000, sessionId: 'new-ses', chatJid: '12345@s.whatsapp.net' });
    durability.upsertSessionCheckpoint('12345', {
      claudePid: 2000,
      sessionId: 'new-ses',
      sessionStatus: 'active',
    });

    const results = classifyActiveSessions(db, durability, () => true); // all PIDs "alive"
    expect(results).toHaveLength(2);

    const authoritative = results.find(r => r.claudePid === 2000);
    const stale = results.find(r => r.claudePid === 1000);
    expect(authoritative?.classification).toBe('authoritative_live');
    expect(stale?.classification).toBe('stale_live');
  });

  it('classifies stale session with dead PID as stale_dead', () => {
    insertSession({ claudePid: 1000, sessionId: 'old-ses', chatJid: '12345@s.whatsapp.net' });
    insertSession({ claudePid: 2000, sessionId: 'new-ses', chatJid: '12345@s.whatsapp.net' });
    durability.upsertSessionCheckpoint('12345', {
      claudePid: 2000,
      sessionId: 'new-ses',
      sessionStatus: 'active',
    });

    // PID 1000 is dead, PID 2000 is alive
    const pidChecker = (pid: number) => pid === 2000;
    const results = classifyActiveSessions(db, durability, pidChecker);

    const stale = results.find(r => r.claudePid === 1000);
    expect(stale?.classification).toBe('stale_dead');
  });

  it('classifies sessions without checkpoint as ambiguous', () => {
    insertSession({ claudePid: 1000, sessionId: 'ses-1', chatJid: '12345@s.whatsapp.net' });
    // No checkpoint for conversation '12345'

    const results = classifyActiveSessions(db, durability, () => true);
    expect(results).toHaveLength(1);
    expect(results[0].classification).toBe('ambiguous');
    expect(results[0].reason).toContain('no session_checkpoint');
  });

  it('classifies sessions without chat_jid as ambiguous', () => {
    insertSession({ claudePid: 1000, sessionId: 'ses-1' }); // no chatJid

    const results = classifyActiveSessions(db, durability, () => true);
    expect(results).toHaveLength(1);
    expect(results[0].classification).toBe('ambiguous');
    expect(results[0].reason).toContain('no chat_jid');
  });

  it('handles PID match with different session_id (respawn without resume)', () => {
    // Single session, PID matches checkpoint but session_id differs
    insertSession({ claudePid: 1000, sessionId: 'new-ses', chatJid: '12345@s.whatsapp.net' });
    durability.upsertSessionCheckpoint('12345', {
      claudePid: 1000,
      sessionId: 'old-ses', // different session_id
      sessionStatus: 'active',
    });

    const results = classifyActiveSessions(db, durability, () => true);
    expect(results).toHaveLength(1);
    // Single session with matching PID -> authoritative (respawned)
    expect(results[0].classification).toBe('authoritative_live');
  });

  it('marks PID-match as ambiguous when multiple sessions exist', () => {
    insertSession({ claudePid: 1000, sessionId: 'ses-a', chatJid: '12345@s.whatsapp.net' });
    insertSession({ claudePid: 3000, sessionId: 'ses-b', chatJid: '12345@s.whatsapp.net' });
    durability.upsertSessionCheckpoint('12345', {
      claudePid: 1000,
      sessionId: 'old-ses', // matches PID 1000 but not session_id
      sessionStatus: 'active',
    });

    const results = classifyActiveSessions(db, durability, () => true);
    // Neither session fully matches checkpoint -> ambiguous situations
    const s1000 = results.find(r => r.claudePid === 1000);
    const s3000 = results.find(r => r.claudePid === 3000);
    expect(s1000?.classification).toBe('ambiguous');
    expect(s3000?.classification).toBe('ambiguous');
  });

  it('classifies multiple conversations independently', () => {
    // Conversation A: one session matching checkpoint
    insertSession({ claudePid: 1000, sessionId: 'a-ses', chatJid: 'alice@s.whatsapp.net' });
    durability.upsertSessionCheckpoint('alice', {
      claudePid: 1000,
      sessionId: 'a-ses',
      sessionStatus: 'active',
    });

    // Conversation B: two sessions, stale one
    insertSession({ claudePid: 2000, sessionId: 'b-old', chatJid: 'bob@s.whatsapp.net' });
    insertSession({ claudePid: 3000, sessionId: 'b-new', chatJid: 'bob@s.whatsapp.net' });
    durability.upsertSessionCheckpoint('bob', {
      claudePid: 3000,
      sessionId: 'b-new',
      sessionStatus: 'active',
    });

    const results = classifyActiveSessions(db, durability, () => true);
    expect(results).toHaveLength(3);

    const alice = results.find(r => r.claudePid === 1000);
    const bobStale = results.find(r => r.claudePid === 2000);
    const bobAuth = results.find(r => r.claudePid === 3000);

    expect(alice?.classification).toBe('authoritative_live');
    expect(bobStale?.classification).toBe('stale_live');
    expect(bobAuth?.classification).toBe('authoritative_live');
  });

  it('ignores non-active sessions', () => {
    insertSession({ claudePid: 1000, sessionId: 'ses-1', chatJid: '12345@s.whatsapp.net', status: 'crashed' });
    insertSession({ claudePid: 2000, sessionId: 'ses-2', chatJid: '12345@s.whatsapp.net', status: 'suspended' });

    const results = classifyActiveSessions(db, durability, () => true);
    expect(results).toEqual([]); // only classifies 'active' sessions
  });

  it('handles @lid JIDs via toConversationKey normalization', () => {
    insertSession({ claudePid: 1000, sessionId: 'ses-1', chatJid: '12345@lid' });
    durability.upsertSessionCheckpoint('12345', {
      claudePid: 1000,
      sessionId: 'ses-1',
      sessionStatus: 'active',
    });

    const results = classifyActiveSessions(db, durability, () => true);
    expect(results).toHaveLength(1);
    expect(results[0].classification).toBe('authoritative_live');
    expect(results[0].conversationKey).toBe('12345');
  });

  it('reproduces the Q zombie scenario: 4 sessions, 1 authoritative', () => {
    // Simulates the exact scenario from the 2026-04-01 investigation:
    // PIDs 2880080, 3180200, 3331484, 3521309 -- only 3521309 matches checkpoint
    insertSession({ claudePid: 2880080, sessionId: 'ses-96', chatJid: '16566225768547@lid' });
    insertSession({ claudePid: 3180200, sessionId: 'ses-97', chatJid: '16566225768547@lid' });
    insertSession({ claudePid: 3331484, sessionId: 'ses-98', chatJid: '16566225768547@lid' });
    insertSession({ claudePid: 3521309, sessionId: 'ses-99', chatJid: '16566225768547@lid' });

    durability.upsertSessionCheckpoint('16566225768547', {
      claudePid: 3521309,
      sessionId: 'ses-99',
      sessionStatus: 'active',
    });

    // All 4 PIDs are alive
    const results = classifyActiveSessions(db, durability, () => true);
    expect(results).toHaveLength(4);

    const authoritative = results.filter(r => r.classification === 'authoritative_live');
    const staleLive = results.filter(r => r.classification === 'stale_live');

    expect(authoritative).toHaveLength(1);
    expect(authoritative[0].claudePid).toBe(3521309);
    expect(staleLive).toHaveLength(3);
    expect(staleLive.map(s => s.claudePid).sort()).toEqual([2880080, 3180200, 3331484]);
  });
});
