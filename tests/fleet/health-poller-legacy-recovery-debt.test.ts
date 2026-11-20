import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HealthPoller,
  parseRecoveryDebtHealth,
  type InstanceHealth,
} from '../../src/fleet/health-poller.ts';
import {
  loadRecoveryMarkers,
  setRecoveryMarker,
} from '../../src/lib/recovery-authority-store.ts';
import type { AlertEmissionResult } from '../../src/lib/emit-alert.ts';

const personalContinuityOnlyHealth = JSON.parse(readFileSync(
  new URL('../fixtures/personal-health-continuity-only.json', import.meta.url),
  'utf8',
)) as Record<string, unknown>;

const alertFns = vi.hoisted(() => ({
  emitAlert: vi.fn((): AlertEmissionResult => ({
    ok: true,
    channel: 'outbox',
    status: 'durably_queued',
  })),
  clearAlertSource: vi.fn(() => true),
}));
const logger = vi.hoisted(() => ({} as Record<string, ReturnType<typeof vi.fn>>));

vi.mock('../../src/lib/emit-alert.ts', () => ({
  ...alertFns,
  emitAlertChecked: alertFns.emitAlert,
  emitObservationChecked: vi.fn(() => true),
  clearAlertSourceChecked: alertFns.clearAlertSource,
}));
vi.mock('../../src/fleet/alert-throttle-store.ts', () => ({
  ALERT_THROTTLE_INTERVAL_MS: 15 * 60 * 1_000,
  loadAlertThrottleDetailed: vi.fn(() => ({ entries: new Map(), loadError: null })),
  recordAlertThrottle: vi.fn(),
}));
vi.mock('../../src/fleet/silence-manager.ts', () => ({
  isInstanceSilenced: vi.fn(() => false),
}));
vi.mock('../../src/logger.ts', async () => {
  const { hoistedLoggerMock } = await import('../helpers/logger-mock.ts');
  const { createChildLogger } = hoistedLoggerMock(logger);
  return { createChildLogger };
});

function makeInstance(overrides: Partial<InstanceHealth> = {}): InstanceHealth {
  return {
    name: 'personal',
    type: 'chat',
    accessMode: 'open',
    healthPort: 9100,
    dbPath: '/tmp/whatsoup-legacy-recovery-debt.db',
    healthToken: null,
    ...overrides,
  };
}

describe('legacy continuity-only recovery debt', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    alertFns.emitAlert.mockReset();
    alertFns.emitAlert.mockReturnValue({ ok: true, channel: 'outbox', status: 'durably_queued' });
    alertFns.clearAlertSource.mockReset();
    alertFns.clearAlertSource.mockReturnValue(true);
    vi.stubGlobal('fetch', mockFetch);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-29T03:16:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('accepts the redacted personal continuity-only healthy projection', () => {
    expect(parseRecoveryDebtHealth(personalContinuityOnlyHealth)).toEqual({
      kind: 'valid',
      summary: {
        open: false,
        serviceBlocking: false,
        attention: 'none',
        reasons: [],
        gaugeTotal: 0,
      },
    });
  });

  it('maps a readable legacy continuity gap to routine debt', () => {
    expect(parseRecoveryDebtHealth({
      status: 'healthy',
      recovery_debt: {
        open: true,
        reason: 'continuity_gap_open',
        continuity: { readable: true, open: 3, unresolved: 2, ambiguous: 1 },
      },
    })).toEqual({
      kind: 'valid',
      summary: {
        open: true,
        serviceBlocking: false,
        attention: 'routine',
        reasons: ['continuity_gap_open'],
        gaugeTotal: 3,
      },
    });
  });

  it('maps unreadable legacy continuity to blocking debt', () => {
    expect(parseRecoveryDebtHealth({
      status: 'degraded',
      recovery_debt: {
        open: true,
        reason: 'continuity_gap_unreadable',
        continuity: { readable: false, open: 0, unresolved: 0, ambiguous: 0 },
      },
    })).toEqual({
      kind: 'valid',
      summary: {
        open: true,
        serviceBlocking: true,
        attention: 'urgent',
        reasons: ['continuity_gap_unreadable'],
        gaugeTotal: 0,
      },
    });
  });

  it.each([
    [
      'a non-boolean compact open flag',
      { open: 'false', reason: null, continuity: { readable: true, open: 0, unresolved: 0, ambiguous: 0 } },
      'recovery_debt.open',
    ],
    [
      'a negative compact continuity count',
      { open: false, reason: null, continuity: { readable: true, open: -1, unresolved: 0, ambiguous: 0 } },
      'recovery_debt.continuity.open',
    ],
    [
      'unreadable compact continuity on a healthy body',
      {
        open: true,
        reason: 'continuity_gap_unreadable',
        continuity: { readable: false, open: 0, unresolved: 0, ambiguous: 0 },
      },
      'recovery_debt_status_contradiction',
    ],
    [
      'a partial extended projection',
      {
        open: false,
        reason: null,
        service_blocking: false,
        continuity: { readable: true, open: 0, unresolved: 0, ambiguous: 0 },
      },
      'recovery_debt.attention',
    ],
  ])('continues to reject %s', (_label, debt, expectedError) => {
    const status = expectedError === 'recovery_debt_status_contradiction' ? 'healthy' : undefined;
    expect(parseRecoveryDebtHealth({ status, recovery_debt: debt })).toMatchObject({
      kind: 'invalid',
      errors: expect.arrayContaining([expectedError]),
    });
  });

  // continuity.open counts unresolved + ambiguous gaps (the producer's
  // definition), so counts that disagree are a contradiction in either
  // direction. Without the check the first projection reads as zero debt.
  it.each([
    [
      'an open count below unresolved + ambiguous',
      { open: false, reason: null, continuity: { readable: true, open: 0, unresolved: 1, ambiguous: 0 } },
    ],
    [
      'an open count above unresolved + ambiguous',
      {
        open: true,
        reason: 'continuity_gap_open',
        continuity: { readable: true, open: 3, unresolved: 1, ambiguous: 1 },
      },
    ],
  ])('rejects %s', (_label, debt) => {
    expect(parseRecoveryDebtHealth({ status: 'healthy', recovery_debt: debt })).toEqual({
      kind: 'invalid',
      errors: ['recovery_debt.continuity.open_contradiction'],
    });
  });

  it('clears instance_degraded after the compact personal health body becomes healthy', async () => {
    const unhealthy = structuredClone(personalContinuityOnlyHealth);
    unhealthy['status'] = 'unhealthy';
    let health = unhealthy;
    mockFetch.mockImplementation(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(health),
    }));

    const instances = new Map([['personal', makeInstance()]]);
    const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), 1_000);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.getStatus('personal')).toMatchObject({
      status: 'degraded',
      activeAlertSources: ['instance_degraded'],
    });

    health = structuredClone(personalContinuityOnlyHealth);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(poller.getStatus('personal')).toMatchObject({
      status: 'online',
      statusReason: 'health_body_ok',
      activeAlertSources: [],
    });
    expect(alertFns.clearAlertSource).toHaveBeenCalledWith(
      'personal',
      'instance_degraded',
      'repair_lane:personal',
      undefined,
    );
    poller.stop();
  });

  it('clears a prior-process instance_degraded marker from the compact healthy body', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'legacy-recovery-marker-'));
    const previousStateDir = process.env['BOT_ERRORS_STATE_DIR'];
    process.env['BOT_ERRORS_STATE_DIR'] = stateDir;

    try {
      setRecoveryMarker('personal:instance_degraded');
      expect(loadRecoveryMarkers().has('personal:instance_degraded')).toBe(true);
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(structuredClone(personalContinuityOnlyHealth)),
      });

      const instances = new Map([['personal', makeInstance()]]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), 1_000);
      poller.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(poller.getStatus('personal')).toMatchObject({
        status: 'online',
        statusReason: 'health_body_ok',
      });
      expect(alertFns.clearAlertSource).toHaveBeenCalledWith(
        'personal',
        'instance_degraded',
        'startup recovery scan (#3057)',
      );
      expect(loadRecoveryMarkers().has('personal:instance_degraded')).toBe(false);
      poller.stop();
    } finally {
      process.env['BOT_ERRORS_STATE_DIR'] = previousStateDir;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
