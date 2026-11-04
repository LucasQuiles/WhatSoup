import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Database } from '../../../src/core/database.ts';
import { DurabilityEngine, drainPendingOutboundLocked } from '../../../src/core/durability.ts';
import { storeMessageIfNew } from '../../../src/core/messages.ts';
import { toConversationKey } from '../../../src/core/conversation-key.ts';
import { SignalAdapter } from '../../../src/transport/signal/adapter.ts';
import { SignalConnection } from '../../../src/transport/signal/connection-bridge.ts';
import { MockSignalPort, makeSignalConfig } from './mock-port.ts';

vi.mock('../../../src/logger.ts', async () => {
  const { loggerModuleMock } = await import('../../helpers/logger-mock.ts');
  return loggerModuleMock();
});

vi.mock('../../../src/lib/emit-alert.ts', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  emitAlertChecked: vi.fn(() => true),
  clearAlertSourceChecked: vi.fn(() => true),
}));

const destinationId = '00000000-0000-4000-8000-000000000001';
const peerId = '00000000-0000-4000-8000-000000000002';
const destination = `${destinationId}@signal`;
const receiptTimestamp = 1793772000000;

describe.each(['startup', 'live'] as const)('Signal %s stored recovery evidence', (phase) => {
  describe.each(['unsafe', 'safe', 'read_only'] as const)('%s replay policy', (replayPolicy) => {
    it.each(['absent', 'peer-only', 'peer-then-self', 'self-then-peer'] as const)(
      '%s evidence through the adapter and bridge',
      async (evidence) => {
        const directory = mkdtempSync(join(tmpdir(), 'signal-recovery-evidence-'));
        const databasePath = join(directory, 'store.db');
        let db = new Database(databasePath);
        const port = new MockSignalPort();
        vi.spyOn(port, 'send').mockImplementation(async (args) => {
          port.sent.push(args);
          return { timestamp: receiptTimestamp + port.sent.length - 1 };
        });
        const adapter = new SignalAdapter(makeSignalConfig({ pollIntervalMs: 60_000 }), port);
        const connection = new SignalConnection(adapter);
        const storedResults: boolean[] = [];
        connection.onMessage = (message) => {
          storedResults.push(storeMessageIfNew(db, {
            chatJid: message.chatJid, senderJid: message.senderJid,
            messageId: message.messageId, isFromMe: message.isFromMe,
            content: message.content, contentType: message.contentType,
            timestamp: message.timestamp,
            conversationKey: toConversationKey(message.chatJid),
          }));
        };

        try {
          db.open();
          await connection.connect();
          let engine = new DurabilityEngine(db);
          const conversationKey = toConversationKey(destination);
          const seq = engine.journalInbound('source-request', conversationKey, destination, 'agent');
          const op = engine.createOutboundOp({
            conversationKey, chatJid: destination, opType: 'text',
            payload: JSON.stringify({ text: 'answer' }), replayPolicy,
            sourceInboundSeq: seq, isTerminal: true,
          });
          expect(engine.markSending(op)).toBe(true);
          const receipt = await connection.sendMessage(destination, 'answer');
          expect(receipt.waMessageId).toBe(String(receiptTimestamp));
          if (receipt.waMessageId === null) throw new Error('Controlled send did not return its receipt');
          engine.markSubmitted(op, receipt.waMessageId);
          expect(engine.markMaybeSent(op, 'controlled echo uncertainty', receipt.waMessageId)).toBe(true);

          const arrivals = evidence === 'absent' ? []
            : evidence === 'peer-only' ? [false]
              : evidence === 'peer-then-self' ? [false, true] : [true, false];
          for (const fromMe of arrivals) {
            expect(adapter.handleInboundRecord({
              timestamp: receiptTimestamp,
              source: fromMe ? 'self-uuid' : peerId,
              destination: destinationId, body: 'provider record',
              fromMe, type: fromMe ? 'sync' : 'data',
            })).toBe(true);
          }
          expect(storedResults).toEqual(arrivals.map(() => true));
          const rows = db.raw.prepare('SELECT message_id, is_from_me FROM messages ORDER BY pk').all();
          expect(rows).toEqual(arrivals.map((fromMe) => ({
            message_id: fromMe ? String(receiptTimestamp)
              : `signal:${JSON.stringify([peerId, peerId, 'data', receiptTimestamp])}`,
            is_from_me: fromMe ? 1 : 0,
          })));

          if (phase === 'startup') {
            db.close();
            db = new Database(databasePath);
            db.open();
            engine = new DurabilityEngine(db);
          } else {
            // SQLite owns the ambiguity clock; advancing JS time cannot cross this gate.
            db.raw.prepare("UPDATE outbound_ops SET ambiguity_at = datetime('now', '-60 seconds') WHERE id = ?").run(op);
          }
          const recovery = phase === 'startup'
            ? engine.postConnectRecovery() : engine.reconcileLiveMaybeSent();
          const hasSelf = arrivals.includes(true);
          const replay = !hasSelf && replayPolicy !== 'unsafe';
          const status = hasSelf ? 'echoed' : replay ? 'pending' : 'quarantined';
          expect(db.raw.prepare('SELECT status FROM outbound_ops WHERE id = ?').get(op)).toEqual({ status });
          expect(engine.getInboundStatus(seq)).toBe(hasSelf ? 'complete' : 'processing');
          expect(recovery.outboundReplayed).toBe(replay ? 1 : 0);
          expect(recovery.outboundQuarantined).toBe(status === 'quarantined' ? 1 : 0);
          expect(await drainPendingOutboundLocked(connection, engine)).toEqual({ resent: replay ? 1 : 0, expired: 0 });
          expect(port.sent).toHaveLength(replay ? 2 : 1);
          expect(port.sent.every((send) => send.recipient === destinationId)).toBe(true);
          expect(db.raw.prepare('SELECT status, wa_message_id FROM outbound_ops WHERE id = ?').get(op)).toEqual({
            status: replay ? 'submitted' : status,
            wa_message_id: String(receiptTimestamp + (replay ? 1 : 0)),
          });
        } finally {
          await connection.shutdown();
          db.close();
          rmSync(directory, { recursive: true, force: true });
        }
      },
    );
  });
});
