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
