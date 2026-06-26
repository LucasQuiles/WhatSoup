import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConnectionManager } from '../../src/transport/connection.ts';
import { SqliteIdentityStore } from '../../src/core/outbound-identity/store.ts';
import { Database } from '../../src/core/database.ts';
import { OutboundIdentityError } from '../../src/core/outbound-identity/guard.ts';

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
});
