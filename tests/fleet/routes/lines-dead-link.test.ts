/**
 * Fleet health must report a linkless line as down.
 *
 * A bot parked after a 401 loggedOut still answers its health probe, so the
 * poller records zero probe failures. The heartbeat was built from probe
 * failures alone and showed all 'up' for a line with no WhatsApp link
 * (ad-bot, ew-bot, eh-bot, ari-personal, 2026-10/11).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/lib/keyring.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/keyring.ts')>();
  return { ...actual, lookupCredential: vi.fn() };
});

import { enrichInstance } from '../../../src/fleet/routes/lines.ts';
import type { DiscoveredInstance } from '../../../src/fleet/discovery.ts';
import type { InstanceStatus } from '../../../src/fleet/health-poller.ts';

function fakeInstance(): DiscoveredInstance {
  return {
    name: 'parked-line',
    type: 'chat',
    accessMode: 'self_only',
    healthPort: 3010,
    dbPath: '/data/parked-line/bot.db',
    stateRoot: '/state/parked-line',
    logDir: '/data/parked-line/logs',
    healthToken: null,
    configPath: '/config/parked-line/config.json',
    socketPath: null,
  };
}

/** The poller's record for a line parked by an uninspected 401 exit. */
function parkedStatus(): InstanceStatus {
  return {
    name: 'parked-line',
    health: {
      status: 'unhealthy',
      whatsapp: {
        connected: false,
        account_jid: 'not connected',
        connection: {
          state: 'disconnected',
          last_status_code: 401,
          last_disconnect_reason: 'loggedOut',
          auth_failure_class: 'auth_401_uninspected_exit',
          reconnect_phase: 'backoff',
          reconnect_attempts: 0,
        },
      },
    },
    lastPollAt: '2026-11-09T05:30:00.000Z',
    healthObservedAt: '2026-11-09T05:30:00.000Z',
    // The process answers its probe: no probe failures.
    consecutiveFailures: 0,
    everReachable: true,
    status: 'logged_out',
    statusConfidence: 'inferred',
    statusReason: 'instance_logged_out',
    statusEvidence: ['auth_failure_class=auth_401_uninspected_exit'],
    error: null,
    lastAlertAt: null,
    silencedUntil: null,
    activeAlertSources: ['instance_logged_out'],
    recoveryDebt: null,
  };
}

describe('enrichInstance — linkless line', () => {
  it('reports a logged-out line as down, not up', () => {
    const enriched = enrichInstance(fakeInstance(), parkedStatus());

    expect(enriched.status).toBe('logged_out');
    expect(enriched.linkedStatus).toBe('unlinked');
    const heartbeat = enriched.heartbeat as string[];
    expect(heartbeat).toHaveLength(20);
    expect(heartbeat.every(beat => beat === 'down')).toBe(true);
  });

  it('a connected line with no probe failures stays up', () => {
    const connected: InstanceStatus = {
      ...parkedStatus(),
      health: {
        status: 'healthy',
        whatsapp: { connected: true, account_jid: '15550001111@s.whatsapp.net', connection: { state: 'connected' } },
      },
      status: 'online',
      statusConfidence: 'confirmed',
      statusReason: 'health_body_ok',
      activeAlertSources: [],
    };
    const heartbeat = enrichInstance(fakeInstance(), connected).heartbeat as string[];
    expect(heartbeat.every(beat => beat === 'up')).toBe(true);
  });
});
