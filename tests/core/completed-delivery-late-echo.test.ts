/**
 * A completed per-chat turn whose answer was flushed but not yet echoed is
 * transferred to a recovery owner, so turn finalization leaves the checkpoint's
 * completed identity unset. When the echo arrives later, settlement must record
 * that identity, or the next resume treats the session as missing it.
 *
 * Promotion happens inside the echo transaction, only with a stored outgoing
 * message for the exact conversation and delivery chat, and never over newer
 * checkpoint state.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';
import {
  toTurnFinalizationPersistence,
  toTurnRecoveryJobPersistence,
  type TurnTerminalResult,
} from '../../src/runtimes/agent/turn-terminal.ts';

describe('completed checkpoint identity after a late delivery echo', () => {
  let db: Database;
  let engine: DurabilityEngine;
  const key = '15550109991';
  const jid = '15550109991@s.whatsapp.net';
  const outgoingId = 'outgoing-message';

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
    engine = new DurabilityEngine(db);
  });
  afterEach(() => db.close());

  /** A completed turn whose flushed answer still awaits its echo. */
  function pendingCompletion() {
    const rowId = engine.beginFreshSessionLifecycle({
      pid: 123, cwd: '/tmp/late-echo', chatJid: jid, workspaceKey: key, conversationKey: key, provider: 'claude-cli',
    });
    db.raw.prepare('UPDATE agent_sessions SET session_id = ? WHERE id = ?').run('provider-session', rowId);
    const seq = engine.journalInbound('inbound-message', key, jid, 'agent');
    const op = engine.createOutboundOp({
      conversationKey: key, chatJid: jid, opType: 'text', payload: '{"text":"synthetic reply"}',
      sourceInboundSeq: seq, replayPolicy: 'unsafe', isTerminal: true,
    });
    engine.markSending(op);
    engine.markSubmitted(op, outgoingId);
    const result: TurnTerminalResult = {
      identity: {
        scope: 'per_chat', conversationKey: key, deliveryJid: jid, inboundSeq: seq,
        logicalTurnId: 'source-turn', managerId: 'source-manager', generation: 3,
      },
      attemptOutcome: { kind: 'completed' },
      inboundDisposition: 'transferred_to_recovery_owner',
      deliveryEvidence: { kind: 'flushed', opId: op },
    };
    const owner = { logicalTurnId: 'recovery-turn', managerId: 'recovery-manager', generation: 4 };
    engine.finalizeTurnTerminal({
      ...toTurnFinalizationPersistence(result, owner),
      recoveryJob: toTurnRecoveryJobPersistence(result, owner, {
        sourceMessageId: 'inbound-message', receivedAtUnixSeconds: 1_780_000_000, replaySafe: true,
        senderJid: jid, senderName: null, text: 'synthetic inbound', isGroup: false, groupName: null,
      }),
      bookkeeping: { checkpoint: { conversationKey: key, fields: { sessionId: 'provider-session' } } },
    });
    return { seq, op };
  }

  /** The stored copy of the bot's own message, as ingest writes it. */
  function storeWitness({ conversation = key, chat = jid, fromMe = 1 } = {}) {
    db.raw.prepare(
      'INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, is_from_me, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(chat, conversation, chat, outgoingId, fromMe, 1_780_000_001);
  }

  function completedIdentity() {
    return engine.getSessionCheckpoint(key)?.completed_inbound_seq ?? null;
  }

  it('records the exact completed identity once the stored outgoing echo is matched', () => {
    const { seq, op } = pendingCompletion();
    expect(completedIdentity()).toBeNull();

    storeWitness();
    engine.markEchoed(op);

    expect(engine.getSessionCheckpoint(key)).toMatchObject({
      completed_inbound_seq: seq,
      completed_delivery_jid: jid,
      completed_delivery_namespace: 's.whatsapp.net',
      completed_scope: 'per_chat',
      completed_logical_turn_id: 'source-turn',
      completed_manager_id: 'source-manager',
      completed_generation: 3,
    });
    expect(engine.getInboundStatus(seq)).toBe('complete');
  });

  it('records the identity through matchEcho, as ingest does', () => {
    const { seq } = pendingCompletion();
    storeWitness();

    expect(engine.matchEcho(outgoingId)).toBe(true);

    expect(completedIdentity()).toBe(seq);
  });

  it('settles the echo wait and records the identity in the same transaction', () => {
    const { seq, op } = pendingCompletion();
    expect(engine.getTurnRecoveryAdmissionStateForScope('per_chat', key)).toBe('awaiting_delivery_echo');

    storeWitness();
    engine.markEchoed(op);

    expect(engine.getTurnRecoveryAdmissionStateForScope('per_chat', key)).toBe('clear');
    expect(completedIdentity()).toBe(seq);
  });

  it('rolls back the echo, settlement and wait state when the identity write fails', () => {
    const { seq, op } = pendingCompletion();
    storeWitness();
    db.raw.exec(
      "CREATE TRIGGER deny_identity BEFORE UPDATE OF completed_inbound_seq ON session_checkpoints BEGIN SELECT RAISE(ABORT, 'identity write denied'); END;",
    );

    expect(() => engine.markEchoed(op)).toThrow('identity write denied');

    expect(engine.getOutboundByStatus('submitted').map((row) => row.id)).toContain(op);
    expect(engine.getInboundStatus(seq)).toBe('processing');
    expect(engine.getTurnRecoveryAdmissionStateForScope('per_chat', key)).toBe('awaiting_delivery_echo');
  });

  it('does not record an identity without a stored outgoing message', () => {
    const { op } = pendingCompletion();

    engine.markEchoed(op);

    expect(engine.getTurnRecoveryAdmissionStateForScope('per_chat', key)).toBe('clear');
    expect(completedIdentity()).toBeNull();
  });

  it.each([
    ['another conversation', { conversation: '15550999999' }],
    ['another delivery chat', { chat: '15550999999@s.whatsapp.net' }],
    ['an incoming message', { fromMe: 0 }],
  ] as const)('does not accept %s as the witness', (_label, witness) => {
    const { op } = pendingCompletion();
    storeWitness(witness);

    engine.markEchoed(op);

    expect(completedIdentity()).toBeNull();
  });

  it('does not overwrite a newer inbound turn', () => {
    const { seq, op } = pendingCompletion();
    engine.upsertSessionCheckpoint(key, { lastInboundSeq: seq + 1 });
    storeWitness();

    engine.markEchoed(op);

    expect(engine.getSessionCheckpoint(key)).toMatchObject({ last_inbound_seq: seq + 1, completed_inbound_seq: null });
  });

  it('does not record an identity when the checkpoint ends at another delivery', () => {
    const { seq, op } = pendingCompletion();
    const later = engine.createOutboundOp({
      conversationKey: key, chatJid: jid, opType: 'text', payload: '{"text":"later synthetic reply"}',
      sourceInboundSeq: seq, replayPolicy: 'unsafe',
    });
    engine.upsertSessionCheckpoint(key, { lastFlushedOutboundId: later });
    storeWitness();

    engine.markEchoed(op);

    expect(completedIdentity()).toBeNull();
  });

  it('does not record an identity while another turn is active', () => {
    const { op } = pendingCompletion();
    engine.upsertSessionCheckpoint(key, { activeTurnId: 'next-turn' });
    storeWitness();

    engine.markEchoed(op);

    expect(completedIdentity()).toBeNull();
  });

  it('does not replace a newer completed identity', () => {
    const { seq, op } = pendingCompletion();
    db.raw.prepare(
      `UPDATE session_checkpoints
       SET completed_inbound_seq = ?, completed_delivery_jid = ?, completed_delivery_namespace = 's.whatsapp.net',
           completed_scope = 'per_chat', completed_logical_turn_id = 'newer-turn',
           completed_manager_id = 'newer-manager', completed_generation = 9
       WHERE conversation_key = ?`,
    ).run(seq + 5, jid, key);
    storeWitness();

    engine.markEchoed(op);

    expect(engine.getSessionCheckpoint(key)).toMatchObject({
      completed_inbound_seq: seq + 5, completed_logical_turn_id: 'newer-turn', completed_generation: 9,
    });
  });

  it('does not restore the old identity after a fresh session replaces the checkpoint', () => {
    const { op } = pendingCompletion();
    engine.beginFreshSessionLifecycle({
      pid: 124, cwd: '/tmp/new-session', chatJid: jid, workspaceKey: key, conversationKey: key, provider: 'claude-cli',
    });
    storeWitness();

    engine.markEchoed(op);

    expect(engine.getSessionCheckpoint(key)).toMatchObject({ session_id: null, completed_inbound_seq: null });
  });

  it('does not attach the identity to a different provider session', () => {
    const { op } = pendingCompletion();
    db.raw.prepare('UPDATE session_checkpoints SET session_id = ? WHERE conversation_key = ?')
      .run('other-provider-session', key);
    storeWitness();

    engine.markEchoed(op);

    expect(engine.getSessionCheckpoint(key)).toMatchObject({
      session_id: 'other-provider-session', completed_inbound_seq: null,
    });
  });

  it('does not record an identity when two outbound records claim the same message', () => {
    const { seq, op } = pendingCompletion();
    const other = engine.createOutboundOp({
      conversationKey: key, chatJid: jid, opType: 'text', payload: '{"text":"other synthetic reply"}',
      sourceInboundSeq: seq, replayPolicy: 'unsafe',
    });
    engine.markSending(other);
    engine.markSubmitted(other, outgoingId);
    storeWitness();

    engine.markEchoed(op);

    expect(completedIdentity()).toBeNull();
  });

  it('rejects a second terminal claim for the delivery and keeps the original owner', () => {
    const { op } = pendingCompletion();
    expect(() => db.raw.prepare(
      `INSERT INTO turn_terminal_records (
         scope, conversation_key, delivery_jid, inbound_seq, inbound_seq_key, logical_turn_id, manager_id,
         generation, attempt_kind, inbound_disposition, delivery_kind, delivery_op_id,
         recovery_owner_logical_turn_id, recovery_owner_manager_id, recovery_owner_generation, reply_guarantee_disarmed)
       SELECT scope, conversation_key, delivery_jid, inbound_seq, inbound_seq_key, 'foreign-turn', manager_id,
         generation, attempt_kind, inbound_disposition, delivery_kind, delivery_op_id,
         recovery_owner_logical_turn_id, recovery_owner_manager_id, recovery_owner_generation, reply_guarantee_disarmed
       FROM turn_terminal_records WHERE delivery_op_id = ?`,
    ).run(op)).toThrow('UNIQUE constraint');
    storeWitness();

    engine.markEchoed(op);

    expect(engine.getSessionCheckpoint(key)?.completed_logical_turn_id).toBe('source-turn');
  });

  it('keeps repeated echoes idempotent', () => {
    const { op } = pendingCompletion();
    storeWitness();
    engine.markEchoed(op);
    const first = engine.getSessionCheckpoint(key);

    engine.markEchoed(op);
    expect(engine.matchEcho(outgoingId)).toBe(false);

    expect(engine.getSessionCheckpoint(key)).toEqual(first);
  });
});
