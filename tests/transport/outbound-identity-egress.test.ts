import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConnectionManager } from '../../src/transport/connection.ts';
import { TwilioConnection } from '../../src/transport/twilio/connection-bridge.ts';
import { SignalConnection } from '../../src/transport/signal/connection-bridge.ts';
import { SignalAdapter } from '../../src/transport/signal/adapter.ts';
import { MockSignalPort, makeSignalConfig } from './signal/mock-port.ts';
import { ImessageConnection } from '../../src/transport/imessage/connection-bridge.ts';
import { ImessageAdapter } from '../../src/transport/imessage/adapter.ts';
import { MockImessagePort, makeImessageConfig } from './imessage/mock-port.ts';
import { SqliteIdentityStore } from '../../src/core/outbound-identity/store.ts';
import { Database } from '../../src/core/database.ts';
import { OutboundIdentityError } from '../../src/core/outbound-identity/guard.ts';
import {
  DurabilityEngine,
  drainPendingOutbound,
  sendTracked,
  sendTrackedOperatorReport,
} from '../../src/core/durability.ts';
import type { Messenger } from '../../src/core/types.ts';

const COLD = '11111110000402@lid';

function coldStore(): SqliteIdentityStore {
  const db = new Database(':memory:');
  db.open();
  // lid maps to a phone, but the phone is cold (no contact/access/inbound).
  db.raw.prepare('INSERT INTO lid_mappings (lid, phone_jid) VALUES (?, ?)')
    .run('11111110000402', '15550009999@s.whatsapp.net');
  return new SqliteIdentityStore(db.raw);
}

/** Build a ConnectionManager with a fake sock and an enforce-mode cold store. */
function enforcingCM(): { cm: ConnectionManager; sock: { sendMessage: ReturnType<typeof vi.fn> } } {
  const cm = new ConnectionManager();
  cm.setIdentityStore(coldStore(), 'enforce');
  const sock = { sendMessage: vi.fn(async () => ({ key: { id: 'x' } })), sendPresenceUpdate: vi.fn(async () => {}) };
  // @ts-expect-error -- inject a minimal fake socket for egress spying; expires 2099-12-31
  cm.sock = sock;
  return { cm, sock };
}

async function expectTrustedRetryParity(
  messenger: Messenger,
  providerSend: ReturnType<typeof vi.fn>,
  chatJid: string,
): Promise<void> {
  const db = new Database(':memory:');
  db.open();
  const durability = new DurabilityEngine(db, {
    resolveOperatorReportTargets: () => new Set([chatJid]),
  });
  try {
    providerSend.mockRejectedValueOnce(new Error('provider unavailable'));
    await expect(sendTrackedOperatorReport(
      messenger,
      chatJid,
      'operator notice',
      durability,
      { replayPolicy: 'safe' },
    )).rejects.toThrow();
    expect(providerSend).toHaveBeenCalledTimes(1);

    durability.postConnectRecovery();
    await expect(drainPendingOutbound(messenger, durability)).resolves.toEqual({ resent: 1, expired: 0 });
    expect(providerSend).toHaveBeenCalledTimes(2);

    await expect(sendTracked(
      messenger,
      chatJid,
      'ordinary cold send',
      durability,
      { replayPolicy: 'safe' },
    )).rejects.toBeInstanceOf(OutboundIdentityError);
    durability.postConnectRecovery();
    await expect(drainPendingOutbound(messenger, durability)).resolves.toEqual({ resent: 0, expired: 0 });
    expect(providerSend).toHaveBeenCalledTimes(2);
  } finally {
    db.close();
  }
}

describe('ConnectionManager egress is guarded', () => {
  let cm: ConnectionManager;
  let sock: { sendMessage: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    ({ cm, sock } = enforcingCM());
  });

  it('sendMessage to a cold target throws and never reaches sock.sendMessage', async () => {
    await expect(cm.sendMessage(COLD, 'hi')).rejects.toBeInstanceOf(OutboundIdentityError);
    expect(sock.sendMessage).not.toHaveBeenCalled();
  });

  it('sendRaw to a cold target throws and never reaches sock.sendMessage', async () => {
    await expect(cm.sendRaw(COLD, { text: 'hi' })).rejects.toBeInstanceOf(OutboundIdentityError);
    expect(sock.sendMessage).not.toHaveBeenCalled();
  });

  it('sendPollMessage to a cold target throws and never reaches sock.sendMessage', async () => {
    await expect(cm.sendPollMessage(COLD, 'q', ['a', 'b'], 1)).rejects.toBeInstanceOf(OutboundIdentityError);
    expect(sock.sendMessage).not.toHaveBeenCalled();
  });

  it('sendMedia to a cold target throws and never reaches sock.sendMessage', async () => {
    await expect(
      cm.sendMedia(COLD, { type: 'image', buffer: Buffer.from('x'), mimetype: 'image/png' }),
    ).rejects.toBeInstanceOf(OutboundIdentityError);
    expect(sock.sendMessage).not.toHaveBeenCalled();
  });

  it('warm target passes the guard and reaches sock.sendMessage', async () => {
    const db = new Database(':memory:');
    db.open();
    db.raw.prepare('INSERT INTO contacts (jid, canonical_phone) VALUES (?, ?)')
      .run('15550001111@s.whatsapp.net', '15550001111');
    cm.setIdentityStore(new SqliteIdentityStore(db.raw), 'enforce');
    await cm.sendMessage('15550001111@s.whatsapp.net', 'hi');
    expect(sock.sendMessage).toHaveBeenCalledTimes(1);
  });

  // QR-086: the guard's SYSTEM_CALLERS exemption (spec §4.2 step B — "infra
  // callers must never be floored") was unreachable because sendMessage
  // hardcoded caller:'agent'. The health-server admin /send (sendTracked →
  // connectionManager.sendMessage) thus hit the cold floor and a deliberate
  // admin send to a cold target was wrongly BLOCKED under enforce. An infra
  // caller token threaded via SendOptions makes the exemption reachable.
  it('sendMessage with caller=health bypasses the cold floor (spec §4.2 step B, QR-086)', async () => {
    await cm.sendMessage(COLD, 'admin broadcast', { caller: 'health' });
    expect(sock.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('sendMessage with no caller still floors a cold target under enforce (default agent)', async () => {
    await expect(cm.sendMessage(COLD, 'hi')).rejects.toBeInstanceOf(OutboundIdentityError);
    expect(sock.sendMessage).not.toHaveBeenCalled();
  });
});

describe('outbound identity guard — construction defaults fail closed', () => {
  it('Baileys blocks ordinary sends before store injection but permits a trusted report', async () => {
    const connection = new ConnectionManager();
    const sock = {
      sendMessage: vi.fn(async () => ({ key: { id: 'x' } })),
      sendPresenceUpdate: vi.fn(async () => {}),
    };
    // @ts-expect-error -- minimal fake socket for the pre-injection seam; expires 2099-12-31
    connection.sock = sock;

    await expect(connection.sendMessage(COLD, 'ordinary')).rejects.toMatchObject({
      guardCode: 'STORE_UNAVAILABLE',
    });
    expect(sock.sendMessage).not.toHaveBeenCalled();
    await connection.sendMessage(COLD, 'operator notice', { caller: 'report-channel' });
    expect(sock.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('Twilio blocks ordinary sends before store injection but permits a trusted report', async () => {
    const sendText = vi.fn(async () => ({ id: 'sms1' }));
    const adapter = {
      capabilities: { channel: 'sms' }, sendText,
      connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}),
      selfRef: () => ({ id: '+15550000000' }), on: vi.fn(() => ({ dispose: vi.fn() })),
    };
    // @ts-expect-error -- minimal adapter fake for the pre-injection seam; expires 2099-12-31
    const connection = new TwilioConnection(adapter);

    await expect(connection.sendMessage('+15550009999@sms', 'ordinary')).rejects.toMatchObject({
      guardCode: 'STORE_UNAVAILABLE',
    });
    expect(sendText).not.toHaveBeenCalled();
    await connection.sendMessage('+15550009999@sms', 'operator notice', { caller: 'report-channel' });
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it('Signal blocks ordinary sends before store injection but permits a trusted report', async () => {
    const port = new MockSignalPort();
    const connection = new SignalConnection(new SignalAdapter(makeSignalConfig(), port));

    await expect(connection.sendMessage('+15550009999@signal', 'ordinary')).rejects.toMatchObject({
      guardCode: 'STORE_UNAVAILABLE',
    });
    expect(port.sent).toHaveLength(0);
    await connection.sendMessage('+15550009999@signal', 'operator notice', { caller: 'report-channel' });
    expect(port.sent).toHaveLength(1);
  });

  it('iMessage blocks ordinary sends before store injection but permits a trusted report', async () => {
    const port = new MockImessagePort();
    const connection = new ImessageConnection(new ImessageAdapter(makeImessageConfig(), port));

    await expect(connection.sendMessage('owner@example.com@imessage', 'ordinary')).rejects.toMatchObject({
      guardCode: 'STORE_UNAVAILABLE',
    });
    expect(port.sent).toHaveLength(0);
    await connection.sendMessage('owner@example.com@imessage', 'operator notice', { caller: 'report-channel' });
    expect(port.sent).toHaveLength(1);
  });
});

describe('outbound identity guard — incident regression', () => {
  it('enforce mode blocks the original cold-LID mis-send state', async () => {
    // Reconstruct the incident's structural state: lid_mapping present, but no
    // contact, no access, no inbound — a cold LID that must be floored.
    const db = new Database(':memory:');
    db.open();
    db.raw.prepare('INSERT INTO lid_mappings (lid, phone_jid) VALUES (?, ?)')
      .run('11111110000402', '15550009999@s.whatsapp.net');

    const cm = new ConnectionManager();
    cm.setIdentityStore(new SqliteIdentityStore(db.raw), 'enforce');
    const sock = { sendMessage: vi.fn(async () => ({ key: { id: 'x' } })), sendPresenceUpdate: vi.fn(async () => {}) };
    // @ts-expect-error -- minimal fake socket for egress spying; expires 2099-12-31
    cm.sock = sock;

    await expect(cm.sendMessage('11111110000402@lid', 'status update…'))
      .rejects.toMatchObject({ guardCode: 'COLD_TARGET' });
    expect(sock.sendMessage).not.toHaveBeenCalled();
  });

  it('log-only mode would NOT block the same state (audit only)', async () => {
    const db = new Database(':memory:');
    db.open();
    db.raw.prepare('INSERT INTO lid_mappings (lid, phone_jid) VALUES (?, ?)')
      .run('11111110000402', '15550009999@s.whatsapp.net');

    const cm = new ConnectionManager();
    cm.setIdentityStore(new SqliteIdentityStore(db.raw), 'log-only');
    const sock = { sendMessage: vi.fn(async () => ({ key: { id: 'x' } })), sendPresenceUpdate: vi.fn(async () => {}) };
    // @ts-expect-error -- minimal fake socket for egress spying; expires 2099-12-31
    cm.sock = sock;

    await cm.sendMessage('11111110000402@lid', 'status update…');
    expect(sock.sendMessage).toHaveBeenCalledTimes(1); // sent, but the warn audit fired
  });
});

describe('cross-transport — TwilioConnection egress is guarded', () => {
  it('TwilioConnection.sendMessage to a cold target throws before adapter.sendText', async () => {
    const sendText = vi.fn(async () => ({ id: 'sms1' }));
    const adapter = {
      capabilities: { channel: 'sms' },
      sendText,
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
      selfRef: () => ({ id: '+15550000000' }),
      on: vi.fn(() => ({ dispose: vi.fn() })),
    };
    // @ts-expect-error -- minimal adapter fake for egress spying; expires 2099-12-31
    const tc = new TwilioConnection(adapter);
    tc.setIdentityStore(coldStore(), 'enforce');

    await expect(tc.sendMessage('11111110000402@lid', 'hi')).rejects.toBeInstanceOf(
      OutboundIdentityError,
    );
    expect(sendText).not.toHaveBeenCalled();
  });

  it('honours a trusted report-channel caller for a cold notification target', async () => {
    const sendText = vi.fn(async () => ({ id: 'sms1' }));
    const adapter = {
      capabilities: { channel: 'sms' },
      sendText,
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
      selfRef: () => ({ id: '+15550000000' }),
      on: vi.fn(() => ({ dispose: vi.fn() })),
    };
    // @ts-expect-error -- minimal adapter fake for egress spying; expires 2099-12-31
    const connection = new TwilioConnection(adapter);
    connection.setIdentityStore(coldStore(), 'enforce');

    await connection.sendMessage('+15550009999@sms', 'operator notice', { caller: 'report-channel' });
    expect(sendText).toHaveBeenCalledTimes(1);
  });
});

describe('cross-transport — portable bridges honour trusted infra callers', () => {
  it('Signal reaches the provider for a cold report-channel target in enforce mode', async () => {
    const port = new MockSignalPort();
    const connection = new SignalConnection(new SignalAdapter(makeSignalConfig(), port));
    connection.setIdentityStore(coldStore(), 'enforce');

    await expect(connection.sendMessage('+15550009999@signal', 'agent send'))
      .rejects.toBeInstanceOf(OutboundIdentityError);
    expect(port.sent).toHaveLength(0);
    await connection.sendMessage('+15550009999@signal', 'operator notice', { caller: 'report-channel' });
    expect(port.sent).toHaveLength(1);
  });

  it('iMessage reaches the provider for a cold report-channel target in enforce mode', async () => {
    const port = new MockImessagePort();
    const connection = new ImessageConnection(new ImessageAdapter(makeImessageConfig(), port));
    connection.setIdentityStore(coldStore(), 'enforce');

    await expect(connection.sendMessage('owner@example.com@imessage', 'agent send'))
      .rejects.toBeInstanceOf(OutboundIdentityError);
    expect(port.sent).toHaveLength(0);
    await connection.sendMessage('owner@example.com@imessage', 'operator notice', { caller: 'report-channel' });
    expect(port.sent).toHaveLength(1);
  });
});

describe('cross-transport — durable retry preserves trusted provenance', () => {
  it('Baileys retries a trusted cold notice and continues flooring an ordinary send', async () => {
    const { cm, sock } = enforcingCM();
    await expectTrustedRetryParity(cm, sock.sendMessage, COLD);
  });

  it('Twilio retries a trusted cold notice and continues flooring an ordinary send', async () => {
    const sendText = vi.fn(async () => ({ id: 'sms1' }));
    const adapter = {
      capabilities: { channel: 'sms' },
      sendText,
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
      selfRef: () => ({ id: '+15550000000' }),
      on: vi.fn(() => ({ dispose: vi.fn() })),
    };
    // @ts-expect-error -- minimal adapter fake for egress spying; expires 2099-12-31
    const connection = new TwilioConnection(adapter);
    connection.setIdentityStore(coldStore(), 'enforce');
    await expectTrustedRetryParity(connection, sendText, '+15550009999@sms');
  });

  it('Signal retries a trusted cold notice and continues flooring an ordinary send', async () => {
    const port = new MockSignalPort();
    const send = vi.spyOn(port, 'send');
    const connection = new SignalConnection(new SignalAdapter(makeSignalConfig(), port));
    connection.setIdentityStore(coldStore(), 'enforce');
    await expectTrustedRetryParity(connection, send, '+15550009999@signal');
  });

  it('iMessage retries a trusted cold notice and continues flooring an ordinary send', async () => {
    const port = new MockImessagePort();
    const send = vi.spyOn(port, 'send');
    const connection = new ImessageConnection(new ImessageAdapter(makeImessageConfig(), port));
    connection.setIdentityStore(coldStore(), 'enforce');
    await expectTrustedRetryParity(connection, send, 'owner@example.com@imessage');
  });
});
