// tests/transport/outbound-governor-wiring.test.ts
// PR-F Task 3 — the socket-seam wrap installed at connection.ts:681 governs
// EVERY tier through the ONE override: Tier A (ConnectionManager.sendMessage),
// Tier B (sendRaw/sendMedia), Tier C (raw getSocket().sendMessage). Also proves
// SS1: the wrapped socket stays `=== this.sock` so inbound events + keepalive
// survive the wrap (the bot does not go deaf).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@whiskeysockets/baileys', async () => {
  const { baileysMock } = await import('../helpers/baileys-mock.ts');
  return baileysMock();
});

// cap 1 per 100s with a 5s bounded wait → the SECOND text to a destination
// would wait ~100s (>> 5s) and sheds, making governance directly observable.
vi.mock('../../src/config.ts', () => ({
  config: {
    adminPhones: new Set(['15550100001']),
    authDir: '/tmp/wa-test-auth-gov',
    stateRoot: '/tmp/wa-test-state-gov',
    dbPath: ':memory:',
    mediaDir: '/tmp',
    botName: 'WhatSoup',
    accessMode: 'allowlist',
    healthPort: 9090,
    autoTyping: 'off',
    generateHighQualityLinkPreview: false,
    models: {
      conversation: 'claude-opus-4-5',
      extraction: 'claude-haiku-4-5',
      validation: 'claude-haiku-4-5',
      fallback: 'claude-sonnet-4-5',
    },
    outboundGovernor: {
      enabled: true,
      windowMs: 100_000,
      maxPerWindow: 1,
      maxWaitMs: 5_000,
      hardCeiling: 1_000,
      hardCeilingWindowMs: 3_600_000,
      globalMaxPerWindow: 1_000,
      globalWindowMs: 100_000,
    },
  },
}));

vi.mock('../../src/core/retry.ts', () => ({
  jitteredDelay: (baseMs: number, attempt: number, maxMs: number = 30_000) =>
    Math.min(baseMs * Math.pow(2, attempt), maxMs),
}));

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), level: 'error' }),
  }),
}));

import { makeWASocket } from '@whiskeysockets/baileys';
import { makeMockSocket } from '../helpers/baileys-mock.ts';
import { ConnectionManager } from '../../src/transport/connection.ts';
import { withWarmIdentity } from '../helpers/outbound-identity.ts';

const JID = '15551230009@s.whatsapp.net';

function openEvent() {
  return { 'connection.update': { connection: 'open' } };
}

async function connected() {
  const { mockSock, emit } = makeMockSocket();
  mockSock.sendMessage.mockResolvedValue({ key: { id: 'wa-ok' } });
  vi.mocked(makeWASocket).mockReturnValue(mockSock as any);
  const manager = withWarmIdentity(new ConnectionManager());
  await manager.connect();
  emit(openEvent());
  return { manager, mockSock, emit };
}

describe('PR-F wiring — the socket-seam wrap governs every send tier', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => vi.useRealTimers());

  it('SS1: getSocket() is the SAME object the wrap received (reference identity intact)', async () => {
    const { manager, mockSock } = await connected();
    expect(manager.getSocket()).toBe(mockSock);
  });

  it('SS1: keepalive still fires after the wrap (this.sock === sock guard survives)', async () => {
    const { mockSock } = await connected();
    expect(mockSock.query).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockSock.query).toHaveBeenCalledTimes(1); // keepalive ping reached the socket
  });

  it('SS1: the in-place override is transparent to a socket send spy (mock API survives the wrap)', async () => {
    const { manager, mockSock } = await connected();
    // Configure + assert on mockSock.sendMessage AFTER connect (i.e. after the
    // override replaced the property). The transparent wrapper carries the spy's
    // mock API forward, so this post-wrap pattern still drives the real send.
    mockSock.sendMessage.mockResolvedValueOnce({ key: { id: 'via-seam' } });
    const receipt = await manager.sendMessage(JID, 'hello');
    expect(receipt.waMessageId).toBe('via-seam');
    const lastCall = mockSock.sendMessage.mock.calls.at(-1);
    expect(lastCall?.[0]).toBe(JID);
    expect(lastCall?.[1]).toMatchObject({ text: 'hello' });
  });

  it('Tier A: ConnectionManager.sendMessage is governed (2nd text to one dest sheds)', async () => {
    const { manager } = await connected();
    await manager.sendMessage(JID, 'first'); // reserves the single per-dest slot
    await expect(manager.sendMessage(JID, 'second'))
      .rejects.toThrow(/outbound governor ceiling exceeded/);
  });

  it('Tier B: sendRaw text is governed by the same wrap', async () => {
    const { manager } = await connected();
    await manager.sendRaw(JID, { text: 'first' });
    await expect(manager.sendRaw(JID, { text: 'second' }))
      .rejects.toThrow(/outbound governor ceiling exceeded/);
  });

  it('Tier B: sendMedia bypasses the governor (SS4) even when the text window is saturated', async () => {
    const { manager } = await connected();
    await manager.sendMessage(JID, 'first'); // saturate the per-dest text window
    // Media must still go through — pacing it past the 30s send timeout would
    // turn a deliverable into a hard failure.
    await expect(
      manager.sendMedia(JID, { type: 'image', buffer: Buffer.from('img'), mimetype: 'image/png' } as any),
    ).resolves.toBeDefined();
  });

  it('Tier C: a raw getSocket().sendMessage (chat-management style) hits the same governor', async () => {
    const { manager } = await connected();
    const sock = manager.getSocket()!;
    await sock.sendMessage(JID, { text: 'first' } as any); // Tier-C raw send reserves the slot
    await expect(sock.sendMessage(JID, { text: 'second' } as any))
      .rejects.toThrow(/outbound governor ceiling exceeded/);
  });

  it('a fresh, independent destination is NOT throttled by another dest’s window', async () => {
    const { manager } = await connected();
    await manager.sendMessage(JID, 'first');
    // A different conversation has its own per-dest window (global cap is high).
    await expect(manager.sendMessage('15551230010@s.whatsapp.net', 'hello')).resolves.toBeDefined();
  });
});
