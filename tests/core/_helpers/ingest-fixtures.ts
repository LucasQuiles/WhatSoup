import { randomBytes } from 'node:crypto';
import { vi } from 'vitest';
import type { IncomingMessage, Messenger } from '../../../src/core/types.ts';
import type { Runtime } from '../../../src/runtimes/types.ts';

export function makeMessenger(): Messenger {
  return {
    sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
    sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
  };
}

export function makeRuntime(): Runtime {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    handleMessage: vi.fn().mockResolvedValue(undefined),
    getHealthSnapshot: vi.fn().mockReturnValue({ status: 'healthy', details: {} }),
    shutdown: vi.fn().mockResolvedValue(undefined),
    setDurability: vi.fn(),
  };
}

export function makeIncomingMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: `msg-${randomBytes(3).toString('hex')}`,
    chatJid: '15551230008@s.whatsapp.net',
    senderJid: '15551230008@s.whatsapp.net',
    senderName: 'Alice',
    content: 'hello bot',
    contentType: 'text',
    isFromMe: false,
    isGroup: false,
    mentionedJids: [],
    timestamp: Math.floor(Date.now() / 1000),
    quotedMessageId: null,
    contentText: null,
    isResponseWorthy: true,
    ...overrides,
  };
}
