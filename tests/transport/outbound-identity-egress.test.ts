import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConnectionManager } from '../../src/transport/connection.ts';
import { TwilioConnection } from '../../src/transport/twilio/connection-bridge.ts';
import { TwilioSmsAdapter } from '../../src/transport/twilio/adapter.ts';
import { MockTwilioSmsPort } from '../../src/transport/twilio/testing/mock-port.ts';
import { SignalConnection } from '../../src/transport/signal/connection-bridge.ts';
import { SignalAdapter } from '../../src/transport/signal/adapter.ts';
import { MockSignalPort, makeSignalConfig } from './signal/mock-port.ts';
import { ImessageConnection } from '../../src/transport/imessage/connection-bridge.ts';
import { ImessageAdapter } from '../../src/transport/imessage/adapter.ts';
import { MockImessagePort, makeImessageConfig } from './imessage/mock-port.ts';
import { SqliteIdentityStore } from '../../src/core/outbound-identity/store.ts';
import { Database } from '../../src/core/database.ts';
import { OutboundIdentityError } from '../../src/core/outbound-identity/guard.ts';
import type { SendOptions, SubmissionReceipt } from '../../src/core/types.ts';
import { makeTwilioConfig } from './twilio/helpers.ts';

const COLD = '11111110000402@lid';

function coldStore(): SqliteIdentityStore {
  const db = new Database(':memory:');
  db.open();
  // lid maps to a phone, but the phone is cold (no contact/access/inbound).
  db.raw.prepare('INSERT INTO lid_mappings (lid, phone_jid) VALUES (?, ?)')
    .run('11111110000402', '15550009999@s.whatsapp.net');
  return new SqliteIdentityStore(db.raw);
}

interface GuardedBridge {
  setIdentityStore(store: SqliteIdentityStore, mode: 'enforce'): void;
  sendMessage(chatJid: string, text: string, opts?: SendOptions): Promise<SubmissionReceipt>;
}

function nonBaileysBridgeCases(): Array<{
  name: string;
  bridge: GuardedBridge;
  coldTarget: string;
  submissionCount(): number;
}> {
  const twilioPort = new MockTwilioSmsPort();
  const signalPort = new MockSignalPort();
  const imessagePort = new MockImessagePort();
  return [
    {
      name: 'Twilio',
      bridge: new TwilioConnection(new TwilioSmsAdapter(makeTwilioConfig(), twilioPort)),
      coldTarget: '+15550009999@sms',
      submissionCount: () => twilioPort.sent.length,
    },
    {
      name: 'Signal',
      bridge: new SignalConnection(new SignalAdapter(makeSignalConfig(), signalPort)),
      coldTarget: '+15550009999@signal',
      submissionCount: () => signalPort.sent.length,
    },
    {
      name: 'iMessage',
      bridge: new ImessageConnection(new ImessageAdapter(makeImessageConfig(), imessagePort)),
      coldTarget: 'cold@example.test@imessage',
      submissionCount: () => imessagePort.sent.length,
    },
  ];
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
});

describe('cross-transport — system caller provenance', () => {
  it.each(nonBaileysBridgeCases())(
    '$name preserves the health caller but keeps a default caller floored',
    async ({ bridge, coldTarget, submissionCount }) => {
      bridge.setIdentityStore(coldStore(), 'enforce');

      await expect(bridge.sendMessage(coldTarget, 'synthetic health text', { caller: 'health' }))
        .resolves.toEqual(expect.objectContaining({ waMessageId: expect.any(String) }));
      expect(submissionCount()).toBe(1);

      await expect(bridge.sendMessage(coldTarget, 'synthetic default text'))
        .rejects.toBeInstanceOf(OutboundIdentityError);
      expect(submissionCount()).toBe(1);
    },
  );
});
