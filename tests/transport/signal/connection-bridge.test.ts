import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignalAdapter } from '../../../src/transport/signal/adapter.ts';
import { SignalConnection } from '../../../src/transport/signal/connection-bridge.ts';
import { MockSignalPort, makeSignalConfig } from './mock-port.ts';
import { Database } from '../../../src/core/database.ts';
import { storeMessageIfNew } from '../../../src/core/messages.ts';

describe('SignalConnection', () => {
  it('translates group inbound messages onto the RuntimeConnection surface', async () => {
    const port = new MockSignalPort();
    const adapter = new SignalAdapter(makeSignalConfig({ pollIntervalMs: 60_000 }), port);
    const connection = new SignalConnection(adapter);
    const onMessage = vi.fn();
    connection.onMessage = onMessage;
    await connection.connect();

    adapter.handleInboundRecord({
      timestamp: 12345,
      source: 'member-uuid',
      destination: 'Z3JvdXAtY29udmVyc2F0aW9u',
      groupId: 'Z3JvdXAtY29udmVyc2F0aW9u',
      body: 'hello group',
      fromMe: false,
      type: 'data',
    });

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      messageId: expect.stringMatching(/^signal:/),
      chatJid: 'Z3JvdXAtY29udmVyc2F0aW9u@signal',
      senderJid: 'member-uuid@signal',
      isGroup: true,
      content: 'hello group',
    }));
    expect(connection.botJid).toBe('+15551234567@signal');
    await connection.shutdown();
  });

  it('preserves a sent-message sync provider ID for outbound echo correlation', async () => {
    const adapter = new SignalAdapter(
      makeSignalConfig({ pollIntervalMs: 60_000 }),
      new MockSignalPort(),
    );
    const connection = new SignalConnection(adapter);
    const onMessage = vi.fn();
    connection.onMessage = onMessage;
    await connection.connect();

    adapter.handleInboundRecord({
      timestamp: 67890,
      source: '+15551234567',
      destination: '+15559990000',
      body: 'sent echo',
      fromMe: true,
      type: 'sync',
    });

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      messageId: '67890',
      isFromMe: true,
    }));
    await connection.shutdown();
  });

  it('persists same-timestamp messages from different Signal group members independently', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsoup-signal-bridge-db-'));
    const db = new Database(join(dir, 'bot.db'));
    db.open();
    const port = new MockSignalPort();
    const adapter = new SignalAdapter(makeSignalConfig({ pollIntervalMs: 60_000 }), port);
    const connection = new SignalConnection(adapter);
    connection.onMessage = (message) => {
      storeMessageIfNew(db, {
        chatJid: message.chatJid,
        conversationKey: message.chatJid,
        senderJid: message.senderJid,
        senderName: message.senderName,
        messageId: message.messageId,
        content: message.content,
        contentText: message.contentText,
        contentType: message.contentType,
        isFromMe: message.isFromMe,
        timestamp: message.timestamp,
        quotedMessageId: message.quotedMessageId,
      });
    };

    try {
      await connection.connect();
      for (const source of ['member-a', 'member-b']) {
        adapter.handleInboundRecord({
          timestamp: 12345,
          source,
          destination: 'Z3JvdXAtY29udmVyc2F0aW9u',
          groupId: 'Z3JvdXAtY29udmVyc2F0aW9u',
          body: `hello from ${source}`,
          fromMe: false,
          type: 'data',
        });
      }

      const rows = db.raw.prepare(
        'SELECT message_id, sender_jid FROM messages ORDER BY pk',
      ).all() as Array<{ message_id: string; sender_jid: string }>;
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.sender_jid)).toEqual([
        'member-a@signal',
        'member-b@signal',
      ]);
      expect(new Set(rows.map((row) => row.message_id)).size).toBe(2);
    } finally {
      await connection.shutdown();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('routes portable text sends through the adapter', async () => {
    const port = new MockSignalPort();
    const adapter = new SignalAdapter(makeSignalConfig({ pollIntervalMs: 60_000 }), port);
    const connection = new SignalConnection(adapter);

    await expect(connection.sendMessage('+15559990000@signal', 'hello')).resolves.toMatchObject({
      waMessageId: expect.stringMatching(/^\d+$/),
    });
    expect(port.sent[0]).toMatchObject({ recipient: '+15559990000', body: 'hello' });
  });

  it('disposes the provider connection during shutdown', async () => {
    const port = new MockSignalPort();
    const adapter = new SignalAdapter(makeSignalConfig({ pollIntervalMs: 60_000 }), port);
    const disposable = { dispose: vi.fn() };
    const connection = new SignalConnection(adapter, disposable);

    await connection.shutdown();

    expect(disposable.dispose).toHaveBeenCalledTimes(1);
  });

  it('emits the protected signal_cli_unregistered source on an auth failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsoup-signal-alert-'));
    const sink = join(dir, 'alerts.jsonl');
    vi.stubEnv('WHATSOUP_ALERT_SINK', sink);
    const port = new MockSignalPort({
      verifyError: Object.assign(new Error('unregistered'), {
        code: 'NotRegisteredException',
        status: 401,
      }),
    });
    const connection = new SignalConnection(
      new SignalAdapter(makeSignalConfig({ pollIntervalMs: 60_000 }), port),
      undefined,
      'test-signal-instance',
    );

    await expect(connection.connect()).rejects.toThrow(/Signal auth error/);

    const recoveredConnection = new SignalConnection(
      new SignalAdapter(makeSignalConfig({ pollIntervalMs: 60_000 }), new MockSignalPort()),
      undefined,
      'test-signal-instance',
    );
    await recoveredConnection.connect();
    await recoveredConnection.shutdown();

    const events = readFileSync(sink, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(events).toContainEqual(expect.objectContaining({
      eventType: 'alert',
      instance: 'test-signal-instance',
      source: 'signal_cli_unregistered',
      severity: 'critical',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      eventType: 'clear',
      instance: 'test-signal-instance',
      source: 'signal_cli_unregistered',
    }));
    expect(readFileSync(sink, 'utf8')).not.toContain('+15551234567');
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });
});
