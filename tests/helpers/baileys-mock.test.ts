import { describe, expect, it, vi } from 'vitest';

import { baileysMock, makeMockSocket } from './baileys-mock.ts';

describe('baileys test helpers', () => {
  it('creates the common Baileys module mock shape', async () => {
    const mock = baileysMock();

    await expect(mock.useMultiFileAuthState('/tmp/auth')).resolves.toEqual({
      state: { creds: {}, keys: {} },
      saveCreds: expect.any(Function),
    });
    await expect(mock.fetchLatestBaileysVersion()).resolves.toEqual({ version: [2, 2413, 1] });
    expect(mock.makeCacheableSignalKeyStore()).toEqual({});
    expect(mock.DisconnectReason).toMatchObject({ loggedOut: 401, restartRequired: 515, connectionClosed: 428 });
    expect(mock.isJidGroup('chat@g.us')).toBe(true);
    expect(mock.jidNormalizedUser('15551234567:1@s.whatsapp.net')).toBe('15551234567@s.whatsapp.net');
  });

  it('creates a socket mock that captures and emits ev.process events', () => {
    const { mockSock, emit } = makeMockSocket();
    const handler = vi.fn();

    mockSock.ev.process(handler);
    emit({ 'connection.update': { connection: 'open' } });

    expect(handler).toHaveBeenCalledWith({ 'connection.update': { connection: 'open' } });
    expect(mockSock.ws.isOpen).toBe(true);
    expect(mockSock.user.id).toContain('@s.whatsapp.net');
  });
});
