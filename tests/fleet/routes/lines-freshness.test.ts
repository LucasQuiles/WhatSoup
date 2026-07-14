/**
 * enrichInstance freshness seam — WhatSoup #1762 remediation 1.
 *
 * enrichInstance (src/fleet/routes/lines.ts) is the single accessor every
 * console-facing line body flows through. These tests pin its freshness
 * contract directly, independent of the full handleGetLines/handleGetLine
 * route plumbing (already covered in tests/fleet/routes/lines.test.ts):
 *
 *   - a fresh poll tags `stale: false` and leaves linkedStatusConfidence alone
 *   - a stale poll (consecutiveFailures > 0) tags `stale: true` and degrades
 *     a 'confirmed' linkedStatusConfidence to 'inferred' — never 'confirmed'
 *     while the poller isn't currently confirming liveness
 *   - the anti-blanket-gate regression guard: staleness never hides link/
 *     pairing state or the health body itself — only its confidence marker
 *     changes. Body fields persist through outages by design; the defect
 *     being closed is unlabeled staleness, not persistence.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/lib/keyring.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/keyring.ts')>();
  return { ...actual, lookupCredential: vi.fn() };
});

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
    health: {
      status: 'healthy',
      whatsapp: {
        connected: true,
        account_jid: '15550001111@s.whatsapp.net',
        connection: { state: 'connected' },
      },
    },
    lastPollAt: '2026-07-13T12:00:00.000Z',
    healthObservedAt: '2026-07-13T12:00:00.000Z',
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

describe('enrichInstance — freshness tag', () => {
  it('fresh poll: stale is false, healthObservedAt passes through, confidence untouched', () => {
    const enriched = enrichInstance(fakeInstance(), fakeStatus());

    expect(enriched.stale).toBe(false);
    expect(enriched.healthObservedAt).toBe('2026-07-13T12:00:00.000Z');
    expect(enriched.linkedStatus).toBe('linked');
    expect(enriched.linkedStatusConfidence).toBe('confirmed');
  });

  it('never polled: stale is false (no failing poller to distrust) and healthObservedAt is null', () => {
    const enriched = enrichInstance(fakeInstance(), undefined);

    expect(enriched.stale).toBe(false);
    expect(enriched.healthObservedAt).toBeNull();
    expect(enriched.status).toBe('unknown');
  });
});

describe('enrichInstance — staleness degrades linkedStatusConfidence', () => {
  it('stale poll (consecutiveFailures > 0): tags stale AND degrades confirmed to inferred', () => {
    // health carried forward verbatim by the poller across 3 failing polls
    // (updateFailure retains existing.health ?? null) — still a "connected"
    // snapshot from before the outage.
    const status = fakeStatus({
      consecutiveFailures: 3,
      healthObservedAt: '2026-07-13T11:50:00.000Z', // carried forward, NOT advanced
      lastPollAt: '2026-07-13T12:00:00.000Z', // advanced on every attempt
    });

    const enriched = enrichInstance(fakeInstance(), status);

    expect(enriched.stale).toBe(true);
    expect(enriched.healthObservedAt).toBe('2026-07-13T11:50:00.000Z');
    // The sharpest defect #1762 named: never 'confirmed' while stale.
    expect(enriched.linkedStatus).toBe('linked'); // status itself unaffected
    expect(enriched.linkedStatusConfidence).toBe('inferred');
    expect(enriched.linkedStatusEvidence).toContain('stale_confidence_degraded=true');
  });

  it('stale poll with an already-non-confirmed confidence is left alone (no double-degrade marker)', () => {
    const status = fakeStatus({
      consecutiveFailures: 2,
      health: {
        status: 'unhealthy',
        whatsapp: {
          connected: false,
          account_jid: 'not connected',
          connection: { state: 'disconnected' },
        },
      },
    });

    const enriched = enrichInstance(fakeInstance(), status);

    expect(enriched.stale).toBe(true);
    // Already ambiguous/inferred pre-staleness — untouched, no evidence noise added.
    expect(enriched.linkedStatusConfidence).not.toBe('confirmed');
    expect(enriched.linkedStatusEvidence as string[]).not.toContain('stale_confidence_degraded=true');
  });
});

describe('enrichInstance — anti-blanket-gate regression guard', () => {
  it('outage (consecutiveFailures > 0): link/pairing state and the health body stay visible, only confidence degrades', () => {
    const status = fakeStatus({ consecutiveFailures: 5, status: 'unreachable', statusConfidence: 'confirmed' });

    const enriched = enrichInstance(fakeInstance(), status);

    expect(enriched.stale).toBe(true);
    // Body fields persist through the outage — NOT blanket-gated on poll.status.
    expect(enriched.health).not.toBeNull();
    expect(enriched.linkedStatus).toBe('linked');
    expect((enriched.health as { whatsapp?: { connected?: boolean } }).whatsapp?.connected).toBe(true);
    // Only the reported confidence is degraded.
    expect(enriched.linkedStatusConfidence).toBe('inferred');
  });
});
