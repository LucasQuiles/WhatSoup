// Exercises patches/@whiskeysockets+baileys+7.0.0-rc13+push-name-presence.patch against the
// real, patched Baileys socket. Why the patch exists: docs/configuration.md#passive--mcp-only.

import { describe, it, expect, vi } from 'vitest';
import { initAuthCreds, makeWASocket } from '@whiskeysockets/baileys';
import { asMockLogger, singletonLoggerMock } from '../helpers/logger-mock.ts';

function socketFor(markOnlineOnConnect: boolean) {
  const base = singletonLoggerMock();
  const trace = vi.fn();
  // At level 'trace', the socket's sendNode logs each outgoing stanza as XML before encoding it,
  // so these tests read exactly what would go to WhatsApp.
  const logger = asMockLogger({ ...base, level: 'trace', fatal: vi.fn(), trace, child: () => logger });
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
  const presenceSent = (): string[] => trace.mock.calls
    .map(([entry]) => (entry as { xml?: unknown }).xml)
    .filter((xml): xml is string => typeof xml === 'string' && xml.startsWith('<presence'));
  const newName = () => sock.ev.emit('creds.update', { me: { id: creds.me!.id, name: 'New Name' } });
  return { sock, presenceSent, newName };
}

describe('baileys push-name presence patch', () => {
  it('sends no presence on a partial creds.update', async () => {
    const { sock, presenceSent } = socketFor(false);
    try {
      sock.ev.emit('creds.update', { nextPreKeyId: 2 });
      expect(presenceSent()).toEqual([]);
    } finally {
      await sock.end(undefined);
    }
  });

  it('announces a new name as unavailable on a line that connects offline', async () => {
    const { sock, presenceSent, newName } = socketFor(false);
    try {
      newName();
      expect(presenceSent()).toEqual(["<presence name='New Name' type='unavailable'/>"]);
    } finally {
      await sock.end(undefined);
    }
  });

  it('keeps the library announcement on a line that connects online', async () => {
    const { sock, presenceSent, newName } = socketFor(true);
    try {
      newName();
      expect(presenceSent()).toEqual(["<presence name='New Name'/>"]);
    } finally {
      await sock.end(undefined);
    }
  });
});
