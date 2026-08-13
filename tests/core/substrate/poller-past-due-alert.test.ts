// Tests for #1765 — the TriggerPoller's past-due liveness watchdog. An `active`
// trigger whose next_fire_at is far in the past with zero runs (last_fire_at IS
// NULL) fires nothing and alerts nothing: any firing-path failure (paused
// poller, clock skew, a unit bug) is invisible until someone mines the DB. This
// wires a liveness alert through the EXISTING emitAlertChecked/bot-errors
// mechanism, state-transition guarded (fire once, clear once resolved) —
// mirroring checkOverdueProposalBacklog (#1773 rem-3).
//
// A healthy poller drains a due trigger within one tick (stamping last_fire_at),
// so a surviving past-due-zero-run row means the firing path did NOT run. We
// model that broken/wedged firing path with batchSize:0 (the due loop drains
// nothing) so the watchdog observes the un-drained row deterministically.

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
import { emitAlertChecked, clearAlertSourceChecked } from '../../../src/lib/emit-alert.ts';
import type { Messenger, SubmissionReceipt } from '../../../src/core/types.ts';

function tmpFile() { return join(tmpdir(), `poller-pastdue-${randomBytes(8).toString('hex')}.db`); }

function makeMessenger(): Messenger {
  return {
    async sendMessage(): Promise<SubmissionReceipt> { return { waMessageId: null }; },
    async sendMedia() { throw new Error('not used'); },
  };
}

const NOW = 1_000_000_000;
const GRACE = 100;

describe('TriggerPoller — past-due trigger liveness watchdog (#1765)', () => {
  let path: string;
  let db: Database;
  beforeEach(() => {
    path = tmpFile(); db = new Database(path); db.open();
    vi.mocked(emitAlertChecked).mockClear();
    vi.mocked(clearAlertSourceChecked).mockClear();
  });
  afterEach(() => { db.close(); if (existsSync(path)) unlinkSync(path); });

  // Active trigger with an ancient next_fire_at and last_fire_at IS NULL (never
  // fired) — the exact liveness violation #1765 describes.
  function createPastDueTrigger(nextFireAt = NOW - 1000) {
    const bead = createBead(db.raw, { kind: 'watch', title: 'w', ownerJid: 'mw', actor: 'u' });
    return createTrigger(db.raw, {
      beadId: bead.id, kind: 'schedule.cron', spec: { expr: '0 8 * * *' },
      reportChatJid: 'admin@s.whatsapp.net', nextFireAt, actor: 'u',
    });
  }

  function poller(opts: { instance?: string } = {}) {
    return new TriggerPoller(db.raw, makeMessenger(), {
      now: () => NOW, batchSize: 0, triggerPastDueGraceSeconds: GRACE,
      instance: opts.instance ?? 'test-bot',
    });
  }

  it('alerts once when an active trigger is past due with zero runs, then does not re-alert', async () => {
    createPastDueTrigger();
    const p = poller();

    await p.tickOnce();
    expect(emitAlertChecked).toHaveBeenCalledTimes(1);
    expect(emitAlertChecked).toHaveBeenCalledWith(
      'test-bot',
      'trigger_past_due',
      expect.stringContaining('1 active trigger'),
      expect.stringContaining('pastDueCount=1'),
      'warning',
    );

    // Still past due on the next tick — state-transition guard means no second
    // alert (mirrors checkOverdueProposalBacklog / loggedOutAlertEmitted).
    await p.tickOnce();
    expect(emitAlertChecked).toHaveBeenCalledTimes(1);
  });

  it('clears the alert once the past-due trigger fires (last_fire_at stamped)', async () => {
    const t = createPastDueTrigger();
    const p = poller();

    await p.tickOnce();
    expect(emitAlertChecked).toHaveBeenCalledTimes(1);

    // The firing path finally records a run — last_fire_at is no longer NULL, so
    // the trigger is no longer a liveness violation.
    db.raw.prepare(`UPDATE bead_triggers SET last_fire_at = ? WHERE id = ?`).run(NOW, t.id);
    await p.tickOnce();

    expect(clearAlertSourceChecked).toHaveBeenCalledTimes(1);
    expect(clearAlertSourceChecked).toHaveBeenCalledWith(
      'test-bot',
      'trigger_past_due',
      expect.stringContaining('pastDueCount=0'),
    );
  });

  it('clears the alert once the past-due trigger is removed', async () => {
    const t = createPastDueTrigger();
    const p = poller();

    await p.tickOnce();
    expect(emitAlertChecked).toHaveBeenCalledTimes(1);

    db.raw.prepare(`DELETE FROM bead_triggers WHERE id = ?`).run(t.id);
    await p.tickOnce();

    expect(clearAlertSourceChecked).toHaveBeenCalledTimes(1);
  });

  it('does not alert while a trigger sits exactly at the grace boundary (strict <)', async () => {
    // next_fire_at === now - grace is NOT past due (predicate is strict `<`).
    createPastDueTrigger(NOW - GRACE);
    const p = poller();

    await p.tickOnce();

    expect(emitAlertChecked).not.toHaveBeenCalled();
  });

  it('never emits when no instance name is configured (fail-safe no-op)', async () => {
    createPastDueTrigger();
    const p = new TriggerPoller(db.raw, makeMessenger(), {
      now: () => NOW, batchSize: 0, triggerPastDueGraceSeconds: GRACE, // no `instance`
    });

    await p.tickOnce();

    expect(emitAlertChecked).not.toHaveBeenCalled();
  });
});

// #2394 (trigger_past_due): checked-clear retry authority + restart-safe
// marker reconciliation. Real recovery-authority store under a per-test
// BOT_ERRORS_STATE_DIR temp dir; emit/clear stay mocked.
describe('TriggerPoller — past-due recovery authority (#2394)', () => {
  const MARKER = 'trigger_past_due:test-bot';
  let path: string;
  let db: Database;
  let stateDir: string;
  let priorStateDir: string | undefined;

  beforeEach(async () => {
    const { mkdtempSync } = await import('node:fs');
    path = tmpFile(); db = new Database(path); db.open();
    vi.mocked(emitAlertChecked).mockClear();
    vi.mocked(emitAlertChecked).mockReturnValue(true);
    vi.mocked(clearAlertSourceChecked).mockClear();
    vi.mocked(clearAlertSourceChecked).mockReturnValue(true);
    stateDir = mkdtempSync(join(tmpdir(), 'pastdue-recovery-'));
    priorStateDir = process.env['BOT_ERRORS_STATE_DIR'];
    process.env['BOT_ERRORS_STATE_DIR'] = stateDir;
  });

  afterEach(async () => {
    const { rmSync } = await import('node:fs');
    db.close(); if (existsSync(path)) unlinkSync(path);
    if (priorStateDir === undefined) delete process.env['BOT_ERRORS_STATE_DIR'];
    else process.env['BOT_ERRORS_STATE_DIR'] = priorStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  });

  async function markerPresent(): Promise<boolean> {
    const { loadRecoveryMarkers } = await import('../../../src/lib/recovery-authority-store.ts');
    return loadRecoveryMarkers().has(MARKER);
  }

  function createPastDueTrigger(nextFireAt = NOW - 1000) {
    const bead = createBead(db.raw, { kind: 'watch', title: 'w', ownerJid: 'mw', actor: 'u' });
    return createTrigger(db.raw, {
      beadId: bead.id, kind: 'schedule.cron', spec: { expr: '0 8 * * *' },
      reportChatJid: 'admin@s.whatsapp.net', nextFireAt, actor: 'u',
    });
  }

  function poller() {
    return new TriggerPoller(db.raw, makeMessenger(), {
      now: () => NOW, batchSize: 0, triggerPastDueGraceSeconds: GRACE,
      instance: 'test-bot',
    });
  }

  it('persists a marker on accepted emit and drops it on accepted clear', async () => {
    const trigger = createPastDueTrigger();
    const p = poller();

    await p.tickOnce();
    expect(await markerPresent()).toBe(true);

    db.raw.prepare('UPDATE bead_triggers SET last_fire_at = ? WHERE id = ?').run(NOW - 10, trigger.id);
    await p.tickOnce();
    expect(clearAlertSourceChecked).toHaveBeenCalledTimes(1);
    expect(await markerPresent()).toBe(false);
  });

  it('retains clear-retry authority until the checked clear is accepted', async () => {
    const trigger = createPastDueTrigger();
    const p = poller();
    await p.tickOnce();

    db.raw.prepare('UPDATE bead_triggers SET last_fire_at = ? WHERE id = ?').run(NOW - 10, trigger.id);
    vi.mocked(clearAlertSourceChecked).mockReturnValueOnce(false);
    await p.tickOnce();
    expect(clearAlertSourceChecked).toHaveBeenCalledTimes(1);
    // Rejected enqueue: ownership and marker retained for the next tick.
    expect(await markerPresent()).toBe(true);

    await p.tickOnce();
    expect(clearAlertSourceChecked).toHaveBeenCalledTimes(2);
    expect(await markerPresent()).toBe(false);
  });

  it('reconciles a prior-process marker from a fresh zero-count observation', async () => {
    const trigger = createPastDueTrigger();
    const alerting = poller();
    await alerting.tickOnce();
    expect(await markerPresent()).toBe(true);

    // Backlog resolves, then "restart": a NEW poller with fresh local latches.
    db.raw.prepare('UPDATE bead_triggers SET last_fire_at = ? WHERE id = ?').run(NOW - 10, trigger.id);
    vi.mocked(clearAlertSourceChecked).mockClear();
    const restarted = poller();
    await restarted.tickOnce();

    expect(clearAlertSourceChecked).toHaveBeenCalledWith(
      'test-bot',
      'trigger_past_due',
      expect.stringContaining('pastDueCount=0'),
    );
    expect(await markerPresent()).toBe(false);
  });

  it('emits no clear on clean startup with no prior incident', async () => {
    const p = poller();
    await p.tickOnce();
    expect(clearAlertSourceChecked).not.toHaveBeenCalled();
    expect(emitAlertChecked).not.toHaveBeenCalled();
  });

  it('a still-positive count never clears merely from absent local history', async () => {
    createPastDueTrigger();
    const alerting = poller();
    await alerting.tickOnce();

    // Restart while STILL past due: the new process re-observes the backlog.
    vi.mocked(emitAlertChecked).mockClear();
    const restarted = poller();
    await restarted.tickOnce();
    expect(clearAlertSourceChecked).not.toHaveBeenCalled();
    expect(await markerPresent()).toBe(true);
  });
});
