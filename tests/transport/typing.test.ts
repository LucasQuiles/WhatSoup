import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    adminPhones: new Set<string>(),
    authDir: '/tmp/wa-test-auth',
    dbPath: ':memory:',
    mediaDir: '/tmp',
    botName: 'WhatSoup',
    accessMode: 'allowlist',
    healthPort: 9090,
    autoTyping: 'off' as 'off' | 'composing' | 'recording',
    models: {
      conversation: 'claude-opus-4-5',
      extraction: 'claude-haiku-4-5',
      validation: 'claude-haiku-4-5',
      fallback: 'claude-sonnet-4-5',
    },
  },
}));

vi.mock('@whiskeysockets/baileys', async () => {
  const { baileysMock } = await import('../helpers/baileys-mock.ts');
  return baileysMock();
});

vi.mock('../../src/config.ts', () => ({ config: mockConfig }));

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      level: 'error',
    }),
  }),
}));

import { makeWASocket } from '@whiskeysockets/baileys';
import { ConnectionManager } from '../../src/transport/connection.ts';
import { withWarmIdentity } from '../helpers/outbound-identity.ts';

function makeMockSocket() {
  return {
    ev: {
      process: vi.fn(),
    },
    sendMessage: vi.fn().mockResolvedValue({ key: { id: 'wamid.123' } }),
    sendPresenceUpdate: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue({}),
    end: vi.fn(),
    ws: { isOpen: true },
    user: {
      id: '15551230004:1@s.whatsapp.net',
      lid: '81536414179557:2@lid',
      name: 'WhatSoup',
    },
  };
}

describe('ConnectionManager typing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.autoTyping = 'off';
  });

  it('setTyping accepts recording state', async () => {
    const mockSock = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);
    const manager = withWarmIdentity(new ConnectionManager());
    await manager.connect();

    await manager.setTyping('111@s.whatsapp.net', 'recording');

    expect(mockSock.sendPresenceUpdate).toHaveBeenCalledWith('recording', '111@s.whatsapp.net');
  });

  it('sendMessage emits configured auto-typing before and paused after send', async () => {
    mockConfig.autoTyping = 'recording';
    const mockSock = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);
    const manager = withWarmIdentity(new ConnectionManager());
    await manager.connect();

    await manager.sendMessage('111@s.whatsapp.net', 'hello');

    expect(mockSock.sendPresenceUpdate).toHaveBeenNthCalledWith(1, 'recording', '111@s.whatsapp.net');
    expect(mockSock.sendMessage).toHaveBeenCalledWith('111@s.whatsapp.net', { text: 'hello' });
    expect(mockSock.sendPresenceUpdate).toHaveBeenNthCalledWith(2, 'paused', '111@s.whatsapp.net');
  });

  it('sendRaw emits auto-typing for text payloads only', async () => {
    mockConfig.autoTyping = 'composing';
    const mockSock = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);
    const manager = withWarmIdentity(new ConnectionManager());
    await manager.connect();

    await manager.sendRaw('111@s.whatsapp.net', { text: 'hello' });
    await manager.sendRaw('111@s.whatsapp.net', { react: { text: '👍', key: { id: '1', remoteJid: '111@s.whatsapp.net' } } });

    expect(mockSock.sendPresenceUpdate).toHaveBeenNthCalledWith(1, 'composing', '111@s.whatsapp.net');
    expect(mockSock.sendPresenceUpdate).toHaveBeenNthCalledWith(2, 'paused', '111@s.whatsapp.net');
    expect(mockSock.sendPresenceUpdate).toHaveBeenCalledTimes(2);
  });
});
