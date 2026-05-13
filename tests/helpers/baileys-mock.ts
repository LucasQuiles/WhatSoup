import { vi } from 'vitest';

export interface MockSocket {
  ev: {
    process: ReturnType<typeof vi.fn>;
  };
  sendMessage: ReturnType<typeof vi.fn>;
  sendPresenceUpdate: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  ws: { isOpen: boolean };
  user: {
    id: string;
    lid: string;
    name: string;
  };
}

export function baileysMock() {
  return {
    makeWASocket: vi.fn(),
    useMultiFileAuthState: vi.fn().mockResolvedValue({
      state: { creds: {}, keys: {} },
      saveCreds: vi.fn(),
    }),
    fetchLatestBaileysVersion: vi.fn().mockResolvedValue({ version: [2, 2413, 1] }),
    makeCacheableSignalKeyStore: vi.fn().mockReturnValue({}),
    downloadMediaMessage: vi.fn(),
    DisconnectReason: { loggedOut: 401, restartRequired: 515, connectionClosed: 428 },
    isJidGroup: vi.fn((jid: string) => jid?.endsWith('@g.us')),
    jidNormalizedUser: vi.fn((jid: string) => jid?.replace(/:.*@/, '@')),
  };
}

/**
 * Partial mock for tests that only need `downloadMediaMessage` from baileys.
 * Smaller surface than baileysMock() — keeps the partial-shape contract explicit
 * so consumers can intercept only the API they actually exercise.
 */
export function baileysMediaMock() {
  return {
    downloadMediaMessage: vi.fn(),
  };
}

export function makeMockSocket() {
  let evProcessCallback: ((events: Record<string, unknown>) => void) | undefined;

  const mockSock: MockSocket = {
    ev: {
      process: vi.fn((cb: (events: Record<string, unknown>) => void) => {
        evProcessCallback = cb;
      }),
    },
    sendMessage: vi.fn(),
    sendPresenceUpdate: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue({}),
    end: vi.fn(),
    ws: { isOpen: true },
    user: {
      id: '18455943112:1@s.whatsapp.net',
      lid: '81536414179557:2@lid',
      name: 'WhatSoup',
    },
  };

  function emit(events: Record<string, unknown>) {
    if (!evProcessCallback) throw new Error('ev.process callback not yet registered');
    evProcessCallback(events);
  }

  return { mockSock, emit };
}
