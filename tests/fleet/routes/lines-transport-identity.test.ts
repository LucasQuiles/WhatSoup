/**
 * Transport-specific identity projection for the fleet line response.
 */
vi.mock('../../../src/lib/keyring.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/keyring.ts')>();
  return { ...actual, lookupCredential: vi.fn() };
});

import { describe, expect, it, vi } from 'vitest';
import { enrichInstance } from '../../../src/fleet/routes/lines.ts';
import type { DiscoveredInstance } from '../../../src/fleet/discovery.ts';
import type { InstanceStatus } from '../../../src/fleet/health-poller.ts';

function fakeInstance(overrides: Partial<DiscoveredInstance> = {}): DiscoveredInstance {
  return {
    name: 'test-line',
    type: 'chat',
    accessMode: 'self_only',
    healthPort: 3010,
    dbPath: '/data/test-line/bot.db',
    stateRoot: '/state/test-line',
    logDir: '/data/test-line/logs',
    healthToken: null,
    configPath: '/config/test-line/config.json',
    socketPath: null,
    ...overrides,
  };
}

function fakeStatus(overrides: Partial<InstanceStatus> = {}): InstanceStatus {
  return {
    name: 'test-line',
    health: { uptime: 1234 },
    lastPollAt: '2026-04-01T00:00:00.000Z',
    consecutiveFailures: 0,
    everReachable: true,
    status: 'online',
    statusConfidence: 'confirmed',
    statusReason: 'health_body_ok',
    statusEvidence: ['health_status=healthy'],
    error: null,
    lastAlertAt: null,
    silencedUntil: null,
    activeAlertSources: [],
    ...overrides,
  };
}

describe('enrichInstance transport identity', () => {
  it.each([
    ['signal', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee@signal', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'],
    ['signal', '+15550001111@signal', '+15550001111'],
    ['imessage', 'Owner@Example.COM@imessage', 'owner@example.com'],
    ['imessage', '+15550002222@imessage', '+15550002222'],
    ['twilio', '+15550003333@sms', '+15550003333'],
  ])('preserves the %s self identity instead of coercing it through WhatsApp phone parsing', (
    transport,
    healthSelfId,
    expected,
  ) => {
    const enriched = enrichInstance(
      fakeInstance({ transport }),
      fakeStatus({ health: { status: 'healthy', transport: { kind: transport, selfId: healthSelfId } } }),
    );
    expect(enriched).toMatchObject({ transport, selfId: expected, phone: expected });
  });

  it('keeps the legacy WhatsApp phone projection when generic transport health is absent', () => {
    const enriched = enrichInstance(
      fakeInstance(),
      fakeStatus({ health: { status: 'healthy', whatsapp: { account_jid: '15550004444@s.whatsapp.net' } } }),
    );
    expect(enriched).toMatchObject({
      transport: 'baileys',
      selfId: '15550004444',
      phone: '15550004444',
    });
  });

  it('fails closed without throwing when health identity fields have malformed runtime types', () => {
    expect(() => enrichInstance(
      fakeInstance({ transport: 'signal' }),
      fakeStatus({
        health: {
          status: 'healthy',
          transport: { kind: 'signal', selfId: 42 },
          whatsapp: { account_jid: { unexpected: true } },
        },
      }),
    )).not.toThrow();
    expect(enrichInstance(
      fakeInstance({ transport: 'signal' }),
      fakeStatus({ health: { status: 'healthy', transport: { kind: 'signal', selfId: 42 } } }),
    )).toMatchObject({ transport: 'signal', selfId: 'unknown', phone: 'unknown' });
  });

  it.each([
    ['signal', '  +15550001111@signal  ', '+15550009999@signal', '+15550001111'],
    ['signal', '+15550001111evil', '+15550009999@signal', '+15550009999'],
    ['signal', 'unknown@signal', '+15550009999@signal', '+15550009999'],
    ['signal', '@signal', '+15550009999@signal', '+15550009999'],
    ['signal', '__proto__', '+15550009999@signal', '+15550009999'],
    ['twilio', '+15550001111evil@sms', '+15550009999@sms', '+15550009999'],
    ['imessage', 'not connected@imessage', 'Owner@Example.COM@imessage', 'owner@example.com'],
    ['imessage', '\u00A0Owner@Example.COM@imessage', 'fallback@example.com@imessage', 'fallback@example.com'],
    ['imessage', 'Owner@Example.COM@imessage\u3000', 'fallback@example.com@imessage', 'fallback@example.com'],
    ['baileys', 'not-a-whatsapp-id', '15550009999@s.whatsapp.net', '15550009999'],
  ])('validates each %s identity candidate before accepting it', (
    transport,
    healthSelfId,
    fallbackJid,
    expected,
  ) => {
    const enriched = enrichInstance(
      fakeInstance({ transport }),
      fakeStatus({
        health: {
          status: 'healthy',
          transport: { kind: transport, selfId: healthSelfId },
          whatsapp: { account_jid: fallbackJid },
        },
      }),
    );
    expect(enriched).toMatchObject({ transport, selfId: expected, phone: expected });
  });
});
