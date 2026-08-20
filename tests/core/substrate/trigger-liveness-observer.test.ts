// #2566 slice 2 — the independent trigger-liveness observer. The gauges must
// run on their own timer (F3: still firing while a tick hangs) and the new
// recurring-overdue gauge must alert on previously-fired triggers with a
// stale next_fire_at, then clear on recovery (F4).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { unlinkSync, existsSync } from 'node:fs';

vi.mock('../../../src/lib/emit-alert.ts', () => {
  const emitAlertChecked = vi.fn(() => true);
  const clearAlertSourceChecked = vi.fn(() => true);
  return { emitAlertChecked, clearAlertSourceChecked };
});

import { Database } from '../../../src/core/database.ts';
import { createBead } from '../../../src/core/substrate/beads.ts';
import { createTrigger } from '../../../src/core/substrate/triggers.ts';
import { TriggerPoller } from '../../../src/core/substrate/poller.ts';
import { TriggerLivenessObserver } from '../../../src/core/substrate/trigger-liveness-observer.ts';
import { emitAlertChecked, clearAlertSourceChecked } from '../../../src/lib/emit-alert.ts';
import { fakeClock } from '../../../src/lib/clock.ts';
import type { Messenger, SubmissionReceipt } from '../../../src/core/types.ts';

function tmpFile() { return join(tmpdir(), `observer-${randomBytes(8).toString('hex')}.db`); }

function makeMessenger(): Messenger {
  return {
    async sendMessage(): Promise<SubmissionReceipt> { return { waMessageId: null }; },
    async sendMedia() { throw new Error('not used'); },
  };
}

const NOW = 1_000_000_000;

describe('TriggerLivenessObserver (#2566 slice 2)', () => {
  let path: string;
  let db: Database;
  beforeEach(() => {
    path = tmpFile(); db = new Database(path); db.open();
    vi.mocked(emitAlertChecked).mockClear();
    vi.mocked(clearAlertSourceChecked).mockClear();
  });
  afterEach(() => { db.close(); if (existsSync(path)) unlinkSync(path); });

  it('F3: the past-due gauge still fires on the observer timer while a tick hangs', async () => {
    // One due probe whose executor hangs forever. Its bead_triggers row keeps
    // last_fire_at IS NULL and an ancient next_fire_at, so it IS the past-due
    // liveness violation — and the hung tick can never report it.
    const bead = createBead(db.raw, { kind: 'watch', title: 'w', ownerJid: 'mw', actor: 'u' });
    db.raw.exec(`CREATE TABLE IF NOT EXISTS probes (id INTEGER PRIMARY KEY)`);
    createTrigger(db.raw, {
      beadId: bead.id, kind: 'poll.sqlite',
      spec: { sql: `SELECT id FROM probes`, fire_when: 'rows_returned' },
      reportChatJid: 'admin@s.whatsapp.net',
      intervalSeconds: 60, nextFireAt: NOW - 1000,
      actor: 'u',
    });

    const scheduled: Array<{ ms: number; fn: () => void }> = [];
    const fakeSetTimeout = ((fn: () => void, ms: number) => {
      scheduled.push({ ms, fn });
      return scheduled.length as unknown as NodeJS.Timeout;
    }) as typeof setTimeout;

    const poller = new TriggerPoller(db.raw, makeMessenger(), {
      instance: 'obs-test',
      intervalMs: 5_000,
      observerIntervalMs: 1_000,
      triggerPastDueGraceSeconds: 100,
      now: () => NOW + 1,
      setTimeoutImpl: fakeSetTimeout,
      clearTimeoutImpl: (() => {}) as typeof clearTimeout,
    });
    vi.spyOn(
      poller as unknown as { executeTrigger(t: unknown): Promise<unknown> },
      'executeTrigger',
    ).mockImplementation(() => new Promise(() => {}));

    poller.start();
    // Fire the poller tick (5000ms arm): it claims the trigger and hangs
    // before its own in-tick watchdog step can ever run.
    const tickArm = scheduled.find((s) => s.ms === 5_000);
    expect(tickArm).toBeDefined();
    tickArm!.fn();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(vi.mocked(emitAlertChecked)).not.toHaveBeenCalled();

    // Fire the observer timer (1000ms arm): the past-due gauge must run and
    // alert even though the tick is still hung.
    const observerArm = scheduled.find((s) => s.ms === 1_000);
    expect(observerArm).toBeDefined();
    observerArm!.fn();
    const kinds = vi.mocked(emitAlertChecked).mock.calls.map((c) => c[1]);
    expect(kinds).toContain('trigger_past_due');
    poller.stop();
  });

  it('F4: the recurring-overdue gauge alerts on a previously-fired stale trigger and clears on recovery', () => {
    const bead = createBead(db.raw, { kind: 'task', title: 'cron', ownerJid: 'mw', actor: 'u' });
    const t = createTrigger(db.raw, {
      beadId: bead.id, kind: 'schedule.cron', spec: { expr: '0 8 * * *' },
      reportChatJid: 'admin@s.whatsapp.net',
      nextFireAt: NOW - 1000,
      actor: 'u',
    });
    // Mark a prior fire: this row is recurring-overdue, NOT past-due.
    db.raw.prepare(`UPDATE bead_triggers SET last_fire_at = ? WHERE id = ?`).run(NOW - 2000, t.id);

    const observer = new TriggerLivenessObserver(db.raw, {
      instance: 'obs-test',
      recurringOverdueGraceSeconds: 100,
      now: () => NOW,
    });

    observer.runOnce(NOW);
    const calls = vi.mocked(emitAlertChecked).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toBe('trigger_recurring_overdue');
    expect(String(calls[0][3])).toContain('recurringOverdueCount=1');

    // Latched: a second observation of the same incident does not re-alert.
    observer.runOnce(NOW);
    expect(vi.mocked(emitAlertChecked)).toHaveBeenCalledTimes(1);

    // Recovery: the trigger drains (next_fire_at moves ahead of now) — the
    // observer sends exactly one checked clear.
    db.raw.prepare(`UPDATE bead_triggers SET next_fire_at = ? WHERE id = ?`).run(NOW + 500, t.id);
    observer.runOnce(NOW);
    const clears = vi.mocked(clearAlertSourceChecked).mock.calls;
    expect(clears).toHaveLength(1);
    expect(clears[0][1]).toBe('trigger_recurring_overdue');
  });

  it('falsifier: injected fakeClock drives runOnce() default now (fails if nowFn falls back to systemClock)', () => {
    const t0ms = 4_100_000_000_000; // distinctive future epoch (~2099)
    const clock = fakeClock(t0ms);
    const pastDueCheck = vi.fn<(now: number) => void>();
    const observer = new TriggerLivenessObserver(db.raw, {
      now: () => clock.nowUnixSec(),
      pastDueCheck,
    });

    // No argument -> runOnce() must take its `now` from this.nowFn(), which
    // must be the injected clock. The observable `now` handed to the past-due
    // hook must equal floor(t0ms/1000); a revert to systemClock.nowUnixSec
    // would hand the hook ~1.7e9 (2026 wall clock) instead.
    observer.runOnce();

    expect(pastDueCheck).toHaveBeenCalledTimes(1);
    expect(pastDueCheck).toHaveBeenCalledWith(clock.nowUnixSec());
  });
});
