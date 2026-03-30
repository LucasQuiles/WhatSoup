import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';

describe('DurabilityEngine — session checkpoints', () => {
  let db: Database;
  let engine: DurabilityEngine;

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
      expect(row).toBeUndefined();
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
