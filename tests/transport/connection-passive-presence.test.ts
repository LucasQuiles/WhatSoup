import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// A passive line is a person's own number. Baileys marks the account online on
// every connect unless told otherwise, and while the account is online the phone
// app stops showing notifications. These tests pin the presence the runtime
// connection asks for, per instance type, and that the receipt records it.

const mockConfig = vi.hoisted(() => ({
  adminPhones: new Set(['15550100001']),
  authDir: '/tmp/wa-test-auth-connection-passive-presence',
  dbPath: ':memory:',
  mediaDir: '/tmp/whatsoup-test-media-connection-passive-presence/tmp',
  botName: 'WhatSoup',
  accessMode: 'allowlist',
  healthPort: 9090,
  autoTyping: 'off',
  generateHighQualityLinkPreview: false,
  instanceType: 'chat' as 'passive' | 'chat' | 'agent',
  models: {
    conversation: 'claude-opus-4-5',
    extraction: 'claude-haiku-4-5',
    validation: 'claude-haiku-4-5',
    fallback: 'claude-sonnet-4-5',
  },
}));

vi.mock('@whiskeysockets/baileys', async () => {
  const { baileysMock } = await import('../helpers/baileys-mock.ts');
  return baileysMock();
});

vi.mock('../../src/config.ts', () => ({ config: mockConfig }));

vi.mock('../../src/logger.ts', async () => {
  const { loggerMock } = await import('../helpers/logger-mock.ts');
  return loggerMock();
});

import { makeWASocket } from '@whiskeysockets/baileys';
import { ConnectionManager } from '../../src/transport/connection.ts';
import {
  effectiveClientRegistry,
  resolveEffectiveClientEvidence,
} from '../../src/transport/effective-client-receipt.ts';
import { makeMockSocket } from '../helpers/baileys-mock.ts';

async function connectAs(instanceType: 'passive' | 'chat' | 'agent') {
  mockConfig.instanceType = instanceType;
  vi.mocked(makeWASocket).mockReturnValue(makeMockSocket().mockSock as any);
  await new ConnectionManager().connect();
  expect(makeWASocket).toHaveBeenCalledTimes(1);
  const socketConfig = vi.mocked(makeWASocket).mock.calls[0]![0] as Record<string, unknown>;
  const evidence = resolveEffectiveClientEvidence();
  if (evidence.status !== 'recorded') throw new Error(`expected a recorded receipt, got ${evidence.reason}`);
  return { socketConfig, receipt: evidence.receipt };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  effectiveClientRegistry.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ConnectionManager — presence on connect', () => {
  it('connects a passive line as unavailable so the phone keeps its notifications', async () => {
    const { socketConfig, receipt } = await connectAs('passive');
    expect(socketConfig['markOnlineOnConnect']).toBe(false);
    expect(receipt.markOnlineOnConnect).toEqual({ value: false, provenance: 'explicit' });
  });

  it.each(['chat', 'agent'] as const)('keeps a %s line online on connect', async (instanceType) => {
    const { socketConfig, receipt } = await connectAs(instanceType);
    expect(socketConfig['markOnlineOnConnect']).toBe(true);
    expect(receipt.markOnlineOnConnect).toEqual({ value: true, provenance: 'explicit' });
  });
});
