import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Integration coverage for PR-G's in-bot seam counter (Task 2 T2.1 + Task 3
// T3.2). Drives the REAL ConnectionManager send methods — text, MCP-raw, poll,
// media — through a mocked Baileys socket, proving every tier increments one
// per-destination counter (not just the text "Sending message" line the fleet
// feed sees) and that a flood surfaces in getConnectionState() + raises exactly
// one alert. Exercising the real send path also proves the lid-resolving
// resolver is wired at the seam (the gap a pure detector unit test can't close).

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    adminPhones: new Set<string>(),
    authDir: '/tmp/wa-test-auth-flood',
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
import { resetEmitAlertThrottle } from '../../src/lib/emit-alert.ts';

function makeMockSocket() {
  return {
    ev: { process: vi.fn() },
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

const FLOOD_DEST = '15551239999@s.whatsapp.net';
const MEDIA_DEST = '15551238888@s.whatsapp.net';

/** Alerts captured on the WHATSOUP_ALERT_SINK file, filtered by source. */
function readAlerts(sink: string, source: string): Array<Record<string, unknown>> {
  if (!existsSync(sink)) return [];
  return readFileSync(sink, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => e['source'] === source);
}

describe('ConnectionManager outbound-flood seam (T2.1 + T3.2)', () => {
  let sinkDir: string;
  let sink: string;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.autoTyping = 'off';
    sinkDir = mkdtempSync(join(tmpdir(), 'flood-sink-'));
    sink = join(sinkDir, 'alerts.jsonl');
    process.env['WHATSOUP_ALERT_SINK'] = sink; // capture alerts instead of paging
    process.env['EMIT_ALERT_THROTTLE_MS'] = '0'; // isolate: no real-clock throttle masking dedup
    resetEmitAlertThrottle();
  });

  afterEach(() => {
    delete process.env['WHATSOUP_ALERT_SINK'];
    delete process.env['EMIT_ALERT_THROTTLE_MS'];
    rmSync(sinkDir, { recursive: true, force: true });
  });

  it('counts text, MCP-raw, poll AND media sends toward one dest and trips once', async () => {
    const mockSock = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);
    const manager = withWarmIdentity(new ConnectionManager());
    await manager.connect();

    // 20 sends to FLOOD_DEST across three tiers (default threshold = 20). If any
    // tier were uncounted, the total would fall short and never trip.
    for (let i = 0; i < 8; i += 1) await manager.sendMessage(FLOOD_DEST, `text ${i}`);
    for (let i = 0; i < 6; i += 1) await manager.sendRaw(FLOOD_DEST, { text: `raw ${i}` });
    for (let i = 0; i < 6; i += 1) await manager.sendPollMessage(FLOOD_DEST, `q${i}`, ['a', 'b'], 1);

    // A separate dest gets media sends — proves the media tier is counted too
    // (distinct destination tracked), without needing 20 media sends.
    await manager.sendMedia(MEDIA_DEST, { type: 'image', url: 'https://example.com/x.jpg', mimetype: 'image/jpeg' });
    await manager.sendMedia(MEDIA_DEST, { type: 'image', url: 'https://example.com/y.jpg', mimetype: 'image/jpeg' });

    const flood = manager.getConnectionState().outboundFlood;
    expect(flood).toBeDefined();
    expect(flood!.flooding).toBe(true);
    expect(flood!.worstCount).toBe(20); // all 20 tiers counted to FLOOD_DEST
    expect(flood!.threshold).toBe(20);
    expect(flood!.windowMs).toBe(300_000);
    expect(flood!.destCount).toBe(2); // FLOOD_DEST + MEDIA_DEST both tracked (media counted)

    // Redaction: the surfaced dest is a short hash, never the raw JID/number.
    expect(flood!.worstDestHash).toBeTruthy();
    expect(flood!.worstDestHash).not.toContain('15551239999');
    expect(flood!.worstDestHash).not.toContain('@');

    // Exactly one alert for the sustained flood (de-duped rising edge).
    const alerts = readAlerts(sink, 'outbound_flood');
    expect(alerts).toHaveLength(1);
  });

  it('does not trip or alert below the threshold', async () => {
    const mockSock = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);
    const manager = withWarmIdentity(new ConnectionManager());
    await manager.connect();

    for (let i = 0; i < 19; i += 1) await manager.sendMessage(FLOOD_DEST, `text ${i}`);

    const flood = manager.getConnectionState().outboundFlood;
    expect(flood!.flooding).toBe(false);
    expect(flood!.worstCount).toBe(19);
    expect(readAlerts(sink, 'outbound_flood')).toHaveLength(0);
  });
});
