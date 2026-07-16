import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';

describe('DurabilityEngine — session checkpoints', () => {
  let db: Database;
  let engine: DurabilityEngine;

  function insertAgentSession(
    sessionId: string,
    workspaceKey: string,
    provider = 'claude-cli',
  ): number {
    const result = db.raw.prepare(`
      INSERT INTO agent_sessions (
        session_id, claude_pid, started_in_directory, chat_jid,
        workspace_key, started_at, status, provider
      ) VALUES (?, 1234, '/tmp', ?, ?, datetime('now'), 'active', ?)
    `).run(sessionId, `${workspaceKey}@s.whatsapp.net`, workspaceKey, provider);
    return Number(result.lastInsertRowid);
  }

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
    engine = new DurabilityEngine(db);
  });

  afterEach(() => { db.close(); });

  describe('upsertSessionCheckpoint', () => {
    it('inserts a new checkpoint row with sessionStatus=active by default', () => {
      engine.upsertSessionCheckpoint('conv-1', { claudePid: 1234 });
      const row = engine.getSessionCheckpoint('conv-1');
      expect(row).toBeDefined();
      expect(row!.session_status).toBe('active');
      expect(row!.claude_pid).toBe(1234);
      expect(row!.checkpoint_version).toBe(1);
    });

    it('stores sessionId and workspacePath', () => {
      engine.upsertSessionCheckpoint('conv-1', {
        sessionId: 'sess-abc',
        workspacePath: '/workspaces/conv-1',
      });
      const row = engine.getSessionCheckpoint('conv-1');
      expect(row!.session_id).toBe('sess-abc');
    });

    it('upserts on conflict — preserves existing fields not provided in update', () => {
      engine.upsertSessionCheckpoint('conv-1', { sessionId: 'sess-abc', claudePid: 1234 });
      // Update only status — sessionId and claudePid should be preserved via COALESCE
      engine.upsertSessionCheckpoint('conv-1', { sessionStatus: 'suspended' });
      const row = engine.getSessionCheckpoint('conv-1');
      expect(row!.session_status).toBe('suspended');
      expect(row!.session_id).toBe('sess-abc');
      expect(row!.claude_pid).toBe(1234);
    });

    it('increments checkpoint_version on each upsert', () => {
      engine.upsertSessionCheckpoint('conv-1', { claudePid: 1 });
      engine.upsertSessionCheckpoint('conv-1', { claudePid: 2 });
      engine.upsertSessionCheckpoint('conv-1', { sessionStatus: 'suspended' });
      const row = engine.getSessionCheckpoint('conv-1');
      expect(row!.checkpoint_version).toBe(3);
    });

    it('clears activeTurnId when set to null', () => {
      engine.upsertSessionCheckpoint('conv-1', { activeTurnId: 'turn-xyz' });
      let row = engine.getSessionCheckpoint('conv-1');
      expect((row as any).active_turn_id).toBe('turn-xyz');

      engine.upsertSessionCheckpoint('conv-1', { activeTurnId: null });
      row = engine.getSessionCheckpoint('conv-1');
      expect((row as any).active_turn_id).toBeNull();
    });

    it('handles multiple independent conversations', () => {
      engine.upsertSessionCheckpoint('conv-1', { claudePid: 100 });
      engine.upsertSessionCheckpoint('conv-2', { claudePid: 200 });
      const r1 = engine.getSessionCheckpoint('conv-1');
      const r2 = engine.getSessionCheckpoint('conv-2');
      expect(r1!.claude_pid).toBe(100);
      expect(r2!.claude_pid).toBe(200);
    });
  });

  describe('getSessionCheckpoint', () => {
    it('returns undefined for unknown conversation', () => {
      const row = engine.getSessionCheckpoint('nonexistent');
      const checkpoints = db.raw.prepare(
        'SELECT conversation_key FROM session_checkpoints WHERE conversation_key = ?',
      ).all('nonexistent');
      expect(row).toBeUndefined();
      expect(checkpoints).toEqual([]);
    });
  });

  describe('getLatestCompletedCheckpointForSession', () => {
    function completedFields(
      conversationKey: string,
      inboundSeq: number,
      logicalTurnId: string,
    ) {
      return {
        lastInboundSeq: inboundSeq,
        completedInboundSeq: inboundSeq,
        completedDeliveryJid: `${conversationKey}@s.whatsapp.net`,
        completedDeliveryNamespace: 's.whatsapp.net',
        completedScope: 'shared',
        completedLogicalTurnId: logicalTurnId,
        completedManagerId: 'shared-manager',
        completedGeneration: 2,
      } as const;
    }

    it.each([
      ['unsupported namespace', 'status@broadcast', 'broadcast'],
      ['multiple separators', 'a@b@lid', 'b@lid'],
    ])('rejects completed identity with %s', (_name, completedDeliveryJid, completedDeliveryNamespace) => {
      expect(() => engine.upsertSessionCheckpoint('invalid-completed-identity', {
        sessionId: 'invalid-completed-session',
        ...completedFields('invalid-completed-identity', 1, 'invalid-turn'),
        completedDeliveryJid,
        completedDeliveryNamespace,
      })).toThrow(/delivery|namespace/i);

      expect(engine.getSessionCheckpoint('invalid-completed-identity')).toBeUndefined();
    });

    it('returns the highest completed inbound sequence for a session', () => {
      engine.upsertSessionCheckpoint('15550108', {
        sessionId: 'shared-session',
        ...completedFields('15550108', 8, 'turn-8'),
      });
      engine.upsertSessionCheckpoint('15550103', {
        sessionId: 'shared-session',
        ...completedFields('15550103', 3, 'turn-3'),
      });
      engine.upsertSessionCheckpoint('legacy', {
        sessionId: 'shared-session',
        lastInboundSeq: 99,
      });

      expect(engine.getLatestCompletedCheckpointForSession('shared-session'))
        .toMatchObject({
          conversation_key: '15550108',
          last_inbound_seq: 8,
          completed_inbound_seq: 8,
          completed_logical_turn_id: 'turn-8',
        });
    });

    it('ignores completed proof from non-resumable checkpoints', () => {
      engine.upsertSessionCheckpoint('15550109', {
        sessionId: 'filtered-session',
        sessionStatus: 'active',
        ...completedFields('15550109', 9, 'active-turn-9'),
      });
      engine.upsertSessionCheckpoint('15550110', {
        sessionId: 'filtered-session',
        sessionStatus: 'ended',
        ...completedFields('15550110', 10, 'ended-turn-10'),
      });

      expect(engine.getLatestCompletedCheckpointForSession('filtered-session'))
        .toMatchObject({
          conversation_key: '15550109',
          completed_logical_turn_id: 'active-turn-9',
        });

      engine.upsertSessionCheckpoint('15550109', { sessionStatus: 'ended' });
      expect(engine.getLatestCompletedCheckpointForSession('filtered-session')).toBeUndefined();
    });

    it('breaks equal-sequence ties by the newest checkpoint row ID', () => {
      engine.upsertSessionCheckpoint('15550101', {
        sessionId: 'tie-session',
        ...completedFields('15550101', 4, 'turn-older'),
      });
      engine.upsertSessionCheckpoint('15550102', {
        sessionId: 'tie-session',
        ...completedFields('15550102', 4, 'turn-newer'),
      });

      expect(engine.getLatestCompletedCheckpointForSession('tie-session'))
        .toMatchObject({
          conversation_key: '15550102',
          completed_logical_turn_id: 'turn-newer',
        });
      expect(engine.getLatestCompletedCheckpointForSession('missing-session')).toBeUndefined();
    });

    it('clears completed-turn proof when the provider session ID rotates', () => {
      engine.upsertSessionCheckpoint('15550121', {
        sessionId: 'old-provider-session',
        ...completedFields('15550121', 21, 'old-turn-21'),
      });

      engine.upsertSessionCheckpoint('15550121', {
        sessionId: 'new-provider-session',
        sessionStatus: 'active',
      });

      expect(engine.getSessionCheckpoint('15550121')).toMatchObject({
        session_id: 'new-provider-session',
        last_inbound_seq: null,
        completed_delivery_jid: null,
        completed_inbound_seq: null,
        completed_delivery_namespace: null,
        completed_scope: null,
        completed_logical_turn_id: null,
        completed_manager_id: null,
        completed_generation: null,
      });
      expect(engine.getLatestCompletedCheckpointForSession('old-provider-session')).toBeUndefined();
      expect(engine.getLatestCompletedCheckpointForSession('new-provider-session')).toBeUndefined();
    });

    it('keeps replacement completed-turn proof when session rotation and completion are atomic', () => {
      engine.upsertSessionCheckpoint('15550123', {
        sessionId: 'old-provider-session',
        ...completedFields('15550123', 23, 'old-turn-23'),
      });
      const replacement = completedFields('15550123', 24, 'new-turn-24');

      engine.upsertSessionCheckpoint('15550123', {
        sessionId: 'new-provider-session',
        sessionStatus: 'active',
        ...replacement,
      });

      expect(engine.getSessionCheckpoint('15550123')).toMatchObject({
        session_id: 'new-provider-session',
        last_inbound_seq: replacement.lastInboundSeq,
        completed_inbound_seq: replacement.completedInboundSeq,
        completed_delivery_jid: replacement.completedDeliveryJid,
        completed_delivery_namespace: replacement.completedDeliveryNamespace,
        completed_scope: replacement.completedScope,
        completed_logical_turn_id: replacement.completedLogicalTurnId,
        completed_manager_id: replacement.completedManagerId,
        completed_generation: replacement.completedGeneration,
      });
      expect(engine.getLatestCompletedCheckpointForSession('new-provider-session'))
        .toMatchObject({
          conversation_key: '15550123',
          completed_logical_turn_id: 'new-turn-24',
        });
    });

    it('preserves completed-turn proof across idempotent same-session updates', () => {
      const completed = completedFields('15550122', 22, 'same-turn-22');
      engine.upsertSessionCheckpoint('15550122', {
        sessionId: 'same-provider-session',
        ...completed,
      });

      engine.upsertSessionCheckpoint('15550122', {
        sessionId: 'same-provider-session',
        sessionStatus: 'suspended',
      });
      engine.upsertSessionCheckpoint('15550122', { sessionStatus: 'active' });

      expect(engine.getSessionCheckpoint('15550122')).toMatchObject({
        session_id: 'same-provider-session',
        last_inbound_seq: completed.lastInboundSeq,
        completed_inbound_seq: completed.completedInboundSeq,
        completed_delivery_jid: completed.completedDeliveryJid,
        completed_delivery_namespace: completed.completedDeliveryNamespace,
        completed_scope: completed.completedScope,
        completed_logical_turn_id: completed.completedLogicalTurnId,
        completed_manager_id: completed.completedManagerId,
        completed_generation: completed.completedGeneration,
      });
      expect(engine.getLatestCompletedCheckpointForSession('same-provider-session'))
        .toMatchObject({
          conversation_key: '15550122',
          completed_logical_turn_id: 'same-turn-22',
        });
    });
  });

  describe('retireSessionLifecycle', () => {
    it('ends the exact agent row and every sibling checkpoint without touching unrelated state', () => {
      const targetRowId = insertAgentSession('shared-provider-session', '15550201');
      const unrelatedRowId = insertAgentSession('unrelated-provider-session', '15550299');
      engine.upsertSessionCheckpoint('15550201', {
        sessionId: 'shared-provider-session',
        sessionStatus: 'active',
      });
      engine.upsertSessionCheckpoint('15550202', {
        sessionId: 'shared-provider-session',
        sessionStatus: 'suspended',
      });
      engine.upsertSessionCheckpoint('15550299', {
        sessionId: 'unrelated-provider-session',
        sessionStatus: 'active',
      });

      engine.retireSessionLifecycle({
        agentSessionRowId: targetRowId,
        providerSessionId: 'shared-provider-session',
        provider: 'claude-cli',
      });

      expect(db.raw.prepare(
        'SELECT status, ended_at FROM agent_sessions WHERE id = ?',
      ).get(targetRowId)).toMatchObject({ status: 'ended', ended_at: expect.any(String) });
      expect(db.raw.prepare(
        'SELECT status, ended_at FROM agent_sessions WHERE id = ?',
      ).get(unrelatedRowId)).toMatchObject({ status: 'active', ended_at: null });
      expect(engine.getSessionCheckpoint('15550201')?.session_status).toBe('ended');
      expect(engine.getSessionCheckpoint('15550202')?.session_status).toBe('ended');
      expect(engine.getSessionCheckpoint('15550299')?.session_status).toBe('active');
    });

    it('rolls back the agent-row retirement when no exact checkpoint exists', () => {
      const targetRowId = insertAgentSession('missing-checkpoint-session', '15550301');
      engine.upsertSessionCheckpoint('15550399', {
        sessionId: 'unrelated-provider-session',
        sessionStatus: 'active',
      });

      expect(() => engine.retireSessionLifecycle({
        agentSessionRowId: targetRowId,
        providerSessionId: 'missing-checkpoint-session',
        provider: 'claude-cli',
      })).toThrow(/checkpoint/i);

      expect(db.raw.prepare(
        'SELECT status, ended_at FROM agent_sessions WHERE id = ?',
      ).get(targetRowId)).toMatchObject({ status: 'active', ended_at: null });
      expect(engine.getSessionCheckpoint('15550399')?.session_status).toBe('active');
    });

    it('fails closed without changing checkpoints when the row does not match the session ID', () => {
      const mismatchedRowId = insertAgentSession('other-agent-session', '15550401');
      engine.upsertSessionCheckpoint('15550402', {
        sessionId: 'checkpoint-session',
        sessionStatus: 'active',
      });

      expect(() => engine.retireSessionLifecycle({
        agentSessionRowId: mismatchedRowId,
        providerSessionId: 'checkpoint-session',
        provider: 'claude-cli',
      })).toThrow(/agent session/i);

      expect(db.raw.prepare(
        'SELECT status, ended_at FROM agent_sessions WHERE id = ?',
      ).get(mismatchedRowId)).toMatchObject({ status: 'active', ended_at: null });
      expect(engine.getSessionCheckpoint('15550402')?.session_status).toBe('active');
    });

    it('rejects a lifecycle that was already terminal without repainting checkpoints', () => {
      const endedRowId = insertAgentSession('already-ended-session', '15550501');
      db.raw.prepare(
        `UPDATE agent_sessions SET status = 'ended', ended_at = datetime('now') WHERE id = ?`,
      ).run(endedRowId);
      engine.upsertSessionCheckpoint('15550501', {
        sessionId: 'already-ended-session',
        sessionStatus: 'active',
      });

      expect(() => engine.retireSessionLifecycle({
        agentSessionRowId: endedRowId,
        providerSessionId: 'already-ended-session',
        provider: 'claude-cli',
      })).toThrow(/agent session/i);
      expect(engine.getSessionCheckpoint('15550501')?.session_status).toBe('active');
    });

    it('rejects a foreign-provider retirement without repainting checkpoints', () => {
      const targetRowId = insertAgentSession('foreign-retire-session', '15550601');
      engine.upsertSessionCheckpoint('15550601', {
        sessionId: 'foreign-retire-session',
        sessionStatus: 'active',
      });
      const beforeRow = db.raw.prepare(
        'SELECT status, ended_at FROM agent_sessions WHERE id = ?',
      ).get(targetRowId);
      const beforeCheckpoint = engine.getSessionCheckpoint('15550601');

      expect(() => engine.retireSessionLifecycle({
        agentSessionRowId: targetRowId,
        providerSessionId: 'foreign-retire-session',
        provider: 'opencode-cli',
      })).toThrow(/agent session|provider|resumable/i);

      expect(db.raw.prepare(
        'SELECT status, ended_at FROM agent_sessions WHERE id = ?',
      ).get(targetRowId)).toEqual(beforeRow);
      expect(engine.getSessionCheckpoint('15550601')).toEqual(beforeCheckpoint);
    });
  });

  describe('updateSessionCheckpointsStatusBySessionId', () => {
    it('updates every checkpoint for the exact session ID and no others', () => {
      engine.upsertSessionCheckpoint('15550111', {
        sessionId: 'shared-session-status',
        sessionStatus: 'active',
      });
      engine.upsertSessionCheckpoint('15550112', {
        sessionId: 'shared-session-status',
        sessionStatus: 'active',
      });
      engine.upsertSessionCheckpoint('15550113', {
        sessionId: 'different-session',
        sessionStatus: 'active',
      });

      expect(engine.updateSessionCheckpointsStatusBySessionId(
        'shared-session-status',
        'orphaned',
      )).toBe(2);
      expect(engine.getSessionCheckpoint('15550111')?.session_status).toBe('orphaned');
      expect(engine.getSessionCheckpoint('15550112')?.session_status).toBe('orphaned');
      expect(engine.getSessionCheckpoint('15550113')?.session_status).toBe('active');
    });
  });

  describe('getAllActiveCheckpoints', () => {
    it('returns only active checkpoints', () => {
      engine.upsertSessionCheckpoint('conv-1', { sessionStatus: 'active' });
      engine.upsertSessionCheckpoint('conv-2', { sessionStatus: 'suspended' });
      engine.upsertSessionCheckpoint('conv-3', { sessionStatus: 'active' });

      const active = engine.getAllActiveCheckpoints();
      const keys = active.map(r => r.conversation_key);
      expect(keys).toContain('conv-1');
      expect(keys).toContain('conv-3');
      expect(keys).not.toContain('conv-2');
    });

    it('returns empty array when no active checkpoints', () => {
      engine.upsertSessionCheckpoint('conv-1', { sessionStatus: 'orphaned' });
      const active = engine.getAllActiveCheckpoints();
      expect(active).toHaveLength(0);
    });
  });

  describe('getResumableCheckpoints', () => {
    it('returns the exact persisted session ID needed for completed-checkpoint lookup', () => {
      engine.upsertSessionCheckpoint('conv-resume', {
        sessionId: 'session-resume',
        sessionStatus: 'suspended',
      });

      expect(engine.getResumableCheckpoints()).toEqual([
        expect.objectContaining({
          conversation_key: 'conv-resume',
          session_id: 'session-resume',
        }),
      ]);
    });
  });

  describe('markSessionOrphaned', () => {
    it('transitions session_status to orphaned', () => {
      engine.upsertSessionCheckpoint('conv-1', { sessionStatus: 'active' });
      engine.markSessionOrphaned('conv-1');
      const row = engine.getSessionCheckpoint('conv-1');
      expect(row!.session_status).toBe('orphaned');
    });

    it('is a no-op for unknown conversation', () => {
      // Should not throw
      expect(() => engine.markSessionOrphaned('nonexistent')).not.toThrow();
    });
  });
});
