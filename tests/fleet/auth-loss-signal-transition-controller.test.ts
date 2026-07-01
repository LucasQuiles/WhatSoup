import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { AuthLossSignalStore } from '../../src/fleet/auth-loss-signal-store.ts';
import { AuthLossSignalTransitionController } from '../../src/fleet/auth-loss-signal-transition-controller.ts';

const startedAt = Date.parse('2026-06-30T06:00:00.000Z');

function sampleAt(offsetSeconds: number, overrides: Record<string, unknown> = {}) {
  return {
    sampledAt: new Date(startedAt + offsetSeconds * 1000).toISOString(),
    connected: true,
    accountStatus: 'present',
    connectionState: 'connected',
    reconnectPhase: null,
    reconnectAttempts: 0,
    recentDisconnectCount: 0,
    ...overrides,
  };
}

describe('AuthLossSignalTransitionController', () => {
  let db: Database;
  let controller: AuthLossSignalTransitionController;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
    const store = new AuthLossSignalStore(db.raw);
    controller = new AuthLossSignalTransitionController(store, {
      quietDwellSeconds: 4137,
      pollIntervalSeconds: 600,
      sampleTolerance: 1,
    });
  });

  afterEach(() => {
    db.close();
  });

  it('resolves an open auth-loss row only after a continuous quiet health window', () => {
    const open = controller.recordAuthLoss({
      instance: 'ad-bot',
      host: 'mini10',
      classifier: 'logged_out',
      reason: 'explicit_auth_loss',
      confidence: 'confirmed',
      observedAt: '2026-06-30T06:00:00.000Z',
    });

    expect(open.inserted).toBe(true);

    for (const offset of [0, 600, 1200, 1800, 2400, 3000, 3600]) {
      expect(controller.observeHealthSample({
        instance: 'ad-bot',
        classifier: 'logged_out',
        sample: sampleAt(offset),
      }).resolved).toBe(false);
    }

    const resolved = controller.observeHealthSample({
      instance: 'ad-bot',
      classifier: 'logged_out',
      sample: sampleAt(4200),
    });

    expect(resolved).toMatchObject({
      resolved: true,
      reason: 'stable_authenticated_open',
    });

    const row = db.raw
      .prepare('SELECT resolved_at, resolved_reason FROM auth_loss_signal')
      .get() as { resolved_at: string | null; resolved_reason: string | null };
    expect(row).toEqual({
      resolved_at: '2026-06-30T07:10:00.000Z',
      resolved_reason: 'stable_authenticated_open',
    });
  });

  it('keeps a flapping auth-loss row open and suppresses duplicate auth-loss records', () => {
    controller.recordAuthLoss({
      instance: 'ad-bot',
      host: 'mini10',
      classifier: 'logged_out',
      reason: 'explicit_auth_loss',
      confidence: 'confirmed',
      observedAt: '2026-06-30T06:00:00.000Z',
    });

    controller.observeHealthSample({
      instance: 'ad-bot',
      classifier: 'logged_out',
      sample: sampleAt(600, { recentDisconnectCount: 1 }),
    });

    const duplicate = controller.recordAuthLoss({
      instance: 'ad-bot',
      host: 'mini10',
      classifier: 'logged_out',
      reason: 'explicit_auth_loss',
      confidence: 'confirmed',
      observedAt: '2026-06-30T06:20:00.000Z',
    });

    expect(duplicate).toMatchObject({
      inserted: false,
      reason: 'duplicate_active_signal',
    });

    const rows = db.raw
      .prepare('SELECT COUNT(*) AS count, SUM(resolved_at IS NULL) AS unresolved FROM auth_loss_signal')
      .get() as { count: number; unresolved: number };
    expect(rows).toEqual({ count: 1, unresolved: 1 });
  });

  it('records a later recurrence after the quiet window resolved the previous signal', () => {
    controller.recordAuthLoss({
      instance: 'ad-bot',
      host: 'mini10',
      classifier: 'logged_out',
      reason: 'explicit_auth_loss',
      confidence: 'confirmed',
      observedAt: '2026-06-30T06:00:00.000Z',
    });

    for (const offset of [0, 600, 1200, 1800, 2400, 3000, 3600, 4200]) {
      controller.observeHealthSample({
        instance: 'ad-bot',
        classifier: 'logged_out',
        sample: sampleAt(offset),
      });
    }

    const recurrence = controller.recordAuthLoss({
      instance: 'ad-bot',
      host: 'mini10',
      classifier: 'logged_out',
      reason: 'explicit_auth_loss',
      confidence: 'confirmed',
      observedAt: '2026-06-30T08:00:00.000Z',
    });

    expect(recurrence.inserted).toBe(true);

    const rows = db.raw
      .prepare('SELECT id, resolved_reason FROM auth_loss_signal ORDER BY id')
      .all();
    expect(rows).toEqual([
      { id: 1, resolved_reason: 'stable_authenticated_open' },
      { id: 2, resolved_reason: null },
    ]);
  });
});
