import { describe, it, expect, beforeEach } from 'vitest';
import { Database } from '../../../src/core/database.ts';
import { DurabilityEngine } from '../../../src/core/durability.ts';
import { ensureAgentSchema } from '../../../src/runtimes/agent/session-db.ts';
import {
  classifyActiveSessions,
  resolveAmbiguousAgeFallback,
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
  provider?: string;
}): number {
  const result = db.raw.prepare(`
    INSERT INTO agent_sessions (
      session_id, claude_pid, started_in_directory, chat_jid, status, provider, started_at
    )
    VALUES (?, ?, '/tmp', ?, ?, ?, datetime('now'))
  `).run(
    fields.sessionId ?? null,
    fields.claudePid,
    fields.chatJid ?? null,
    fields.status ?? 'active',
    fields.provider ?? 'claude-cli',
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

  // ── QR-101: authoritative_live must be gated on PID liveness ──

  it('QR-101: session matching active checkpoint but with DEAD pid is stale_dead, not authoritative_live', () => {
    insertSession({ claudePid: 1000, sessionId: 'ses-1', chatJid: '12345@s.whatsapp.net' });
    durability.upsertSessionCheckpoint('12345', {
      claudePid: 1000, sessionId: 'ses-1', sessionStatus: 'active',
    });
    // PID 1000 is DEAD (crashed; checkpoint row not yet reconciled). A checkpoint
    // match must NOT classify a dead process 'authoritative_live' — that leaves the
    // chat silently dead (the runtime "leaves authoritative_live alone"). It must be
    // stale_dead so the runtime reclaims/respawns it.
    const results = classifyActiveSessions(db, durability, allDead);
    expect(results).toHaveLength(1);
    expect(results[0].classification).toBe('stale_dead');
  });

  it('QR-101: PID-only-match (respawn) with DEAD pid is stale_dead, not authoritative_live', () => {
    // Same pid as checkpoint, different session_id (respawn without resume), single
    // session for the conversation — the PID-only-match branch. Dead PID must not be live.
    insertSession({ claudePid: 1000, sessionId: 'respawned', chatJid: '12345@s.whatsapp.net' });
    durability.upsertSessionCheckpoint('12345', {
      claudePid: 1000, sessionId: 'checkpoint-sid', sessionStatus: 'active',
    });
    const results = classifyActiveSessions(db, durability, allDead);
    expect(results).toHaveLength(1);
    expect(results[0].classification).toBe('stale_dead');
  });

  it('QR-101: matching checkpoint with ALIVE-but-unowned pid stays authoritative_live (non-claude provider not regressed)', () => {
    // A live codex/opencode session reports alive:true, owned:false (the ownership
    // check is claude-substring-only — QR-101 axis 2). The liveness gate keys on
    // `alive` ONLY, so a live session of any provider stays authoritative_live.
    insertSession({ claudePid: 1000, sessionId: 'ses-1', chatJid: '12345@s.whatsapp.net' });
    durability.upsertSessionCheckpoint('12345', {
      claudePid: 1000, sessionId: 'ses-1', sessionStatus: 'active',
    });
    const results = classifyActiveSessions(db, durability, allAliveNotOwned);
    expect(results).toHaveLength(1);
    expect(results[0].classification).toBe('authoritative_live');
  });

  it('keeps a spawn-per-turn logical session authoritative when its durable PID is zero', () => {
    insertSession({
      claudePid: 0,
      sessionId: 'managed-session',
      chatJid: '12345@s.whatsapp.net',
      provider: 'opencode-cli',
    });
    durability.upsertSessionCheckpoint('12345', {
      // Spawn-per-turn providers retain the most recent transient child PID in
      // the checkpoint while the durable agent row legitimately has no resident
      // child. Logical session identity, not PID equality, owns the session.
      claudePid: 9911,
      sessionId: 'managed-session',
      sessionStatus: 'active',
    });

    const results = classifyActiveSessions(db, durability, allDead);

    expect(results).toHaveLength(1);
    expect(results[0].classification).toBe('authoritative_live');
    expect(results[0].reason).toContain('logical session');
  });

  it('still reclaims a resident provider when the matching checkpoint PID is dead', () => {
    insertSession({
      claudePid: 1000,
      sessionId: 'resident-session',
      chatJid: '12345@s.whatsapp.net',
      provider: 'claude-cli',
    });
    durability.upsertSessionCheckpoint('12345', {
      claudePid: 1000,
      sessionId: 'resident-session',
      sessionStatus: 'active',
    });

    const results = classifyActiveSessions(db, durability, allDead);

    expect(results).toHaveLength(1);
    expect(results[0].classification).toBe('stale_dead');
  });

  it('fails closed for an unknown provider even when its logical session ID matches', () => {
    insertSession({
      claudePid: 0,
      sessionId: 'unknown-session',
      chatJid: '12345@s.whatsapp.net',
      provider: 'future-provider',
    });
    durability.upsertSessionCheckpoint('12345', {
      claudePid: 9911,
      sessionId: 'unknown-session',
      sessionStatus: 'active',
    });

    const results = classifyActiveSessions(db, durability, allAliveNotOwned);

    expect(results).toHaveLength(1);
    expect(results[0].classification).not.toBe('authoritative_live');
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

  it('falls back to the raw chat_jid when conversation-key parsing rejects legacy data', () => {
    insertSession({ claudePid: 1000, sessionId: 'ses-1', chatJid: 'legacy-session-key' });
    durability.upsertSessionCheckpoint('legacy-session-key', {
      claudePid: 1000, sessionId: 'ses-1', sessionStatus: 'active',
    });

    const results = classifyActiveSessions(db, durability, allOwned);
    expect(results[0].classification).toBe('authoritative_live');
    expect(results[0].conversationKey).toBe('legacy-session-key');
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

// #1756: the DB classifier only ran at startup, and its 'ambiguous' bucket was a
// permanent no-op — an init-failure session that never checkpointed (and so never
// even ran a PID ownership check) stayed 'active' forever. resolveAmbiguousAgeFallback
// is the fallback disposition consulted for the interval sweep: it independently
// re-verifies PID liveness/ownership (defense in depth — some 'ambiguous' sub-cases
// never ran a pidChecker at all) and requires zero turns processed, so it can only
// ever act on a session that never did anything, never on live work in progress.
describe('resolveAmbiguousAgeFallback', () => {
  const HOUR = 60 * 60 * 1000;
  const oldEnough = new Date(Date.now() - 25 * HOUR).toISOString();
  const tooRecent = new Date(Date.now() - 1 * HOUR).toISOString();

  it('orphans a zero-message session past the age threshold whose PID is dead', () => {
    const verdict = resolveAmbiguousAgeFallback(
      { id: 1, claudePid: 99999999, startedAt: oldEnough, messageCount: 0 },
      Date.now(),
      24 * HOUR,
      allDead,
    );
    expect(verdict).toBe('orphan');
  });

  it('orphans a zero-message session past the age threshold whose PID is alive but unowned', () => {
    const verdict = resolveAmbiguousAgeFallback(
      { id: 2, claudePid: 12345, startedAt: oldEnough, messageCount: 0 },
      Date.now(),
      24 * HOUR,
      allAliveNotOwned,
    );
    expect(verdict).toBe('orphan');
  });

  it('DESIGN CARE: never touches a session whose PID is alive AND owned, at any age', () => {
    const veryOld = new Date(Date.now() - 365 * 24 * HOUR).toISOString();
    const verdict = resolveAmbiguousAgeFallback(
      { id: 3, claudePid: 4321, startedAt: veryOld, messageCount: 0 },
      Date.now(),
      24 * HOUR,
      allOwned,
    );
    expect(verdict).toBe('leave');
  });

  it('leaves a session alone that has processed messages, regardless of age', () => {
    const verdict = resolveAmbiguousAgeFallback(
      { id: 4, claudePid: 99999999, startedAt: oldEnough, messageCount: 3 },
      Date.now(),
      24 * HOUR,
      allDead,
    );
    expect(verdict).toBe('leave');
  });

  it('leaves a session alone that has not yet crossed the age threshold', () => {
    const verdict = resolveAmbiguousAgeFallback(
      { id: 5, claudePid: 99999999, startedAt: tooRecent, messageCount: 0 },
      Date.now(),
      24 * HOUR,
      allDead,
    );
    expect(verdict).toBe('leave');
  });

  it('fails closed when startedAt is missing (mocked/legacy caller with no age evidence)', () => {
    const verdict = resolveAmbiguousAgeFallback(
      { id: 6, claudePid: 99999999, startedAt: null, messageCount: 0 },
      Date.now(),
      24 * HOUR,
      allDead,
    );
    expect(verdict).toBe('leave');
  });

  it('fails closed when messageCount is missing (mocked/legacy caller with no activity evidence)', () => {
    const verdict = resolveAmbiguousAgeFallback(
      { id: 7, claudePid: 99999999, startedAt: oldEnough, messageCount: null },
      Date.now(),
      24 * HOUR,
      allDead,
    );
    expect(verdict).toBe('leave');
  });

  it('fails closed when startedAt does not parse as a date', () => {
    const verdict = resolveAmbiguousAgeFallback(
      { id: 8, claudePid: 99999999, startedAt: 'not-a-date', messageCount: 0 },
      Date.now(),
      24 * HOUR,
      allDead,
    );
    expect(verdict).toBe('leave');
  });
});
