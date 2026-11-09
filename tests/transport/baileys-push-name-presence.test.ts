// Exercises patches/@whiskeysockets+baileys+7.0.0-rc13+push-name-presence.patch against the
// real, patched Baileys socket. Why the patch exists: docs/configuration.md#passive--mcp-only.

import { describe, it, expect, vi } from 'vitest';
import { initAuthCreds, makeWASocket } from '@whiskeysockets/baileys';
import { asMockLogger, singletonLoggerMock } from '../helpers/logger-mock.ts';

function socketFor(markOnlineOnConnect: boolean) {
  const base = singletonLoggerMock();
  const logger = asMockLogger({ ...base, level: 'debug', fatal: vi.fn(), trace: vi.fn(), child: () => logger });
  const creds = initAuthCreds();
  creds.me = { id: '15555550123:1@s.whatsapp.net', name: 'Stored Name' };
  // A closed local port: the socket never reaches WhatsApp, but its creds.update
  // handler is registered at construction, which is all these tests need.
  const sock = makeWASocket({
    auth: { creds, keys: { get: async () => ({}), set: async () => {} } },
    logger,
    markOnlineOnConnect,
    waWebSocketUrl: 'ws://127.0.0.1:9',
    connectTimeoutMs: 1_000,
  } as unknown as Parameters<typeof makeWASocket>[0]);
  const newName = () => sock.ev.emit('creds.update', { me: { id: creds.me!.id, name: 'New Name' } });
  return { sock, debug: base.debug, newName };
}

describe('baileys push-name presence patch', () => {
  it('sends no presence on a partial creds.update', async () => {
    const { sock, debug } = socketFor(false);
    try {
      sock.ev.emit('creds.update', { nextPreKeyId: 2 });
      expect(debug).not.toHaveBeenCalledWith(expect.anything(), 'updated pushName');
    } finally {
      await sock.end(undefined);
    }
  });

  it('announces a new name as unavailable on a line that connects offline', async () => {
    const { sock, debug, newName } = socketFor(false);
    try {
      newName();
      expect(debug).toHaveBeenCalledWith({ name: 'New Name', type: 'unavailable' }, 'updated pushName');
    } finally {
      await sock.end(undefined);
    }
  });

  it('keeps the library announcement on a line that connects online', async () => {
    const { sock, debug, newName } = socketFor(true);
    try {
      newName();
      expect(debug).toHaveBeenCalledWith({ name: 'New Name' }, 'updated pushName');
    } finally {
      await sock.end(undefined);
    }
  });
});
