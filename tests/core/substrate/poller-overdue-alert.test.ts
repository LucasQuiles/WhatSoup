// Tests for #1773 rem-3 — the TriggerPoller's overdue-proposal backlog alert.
// review_by_at was written by the proposal sweep but never read anywhere: no
// SELECT, scheduler, sweep, or alert consumed it, so proposals accumulated
// silently forever (683 on one live instance). This wires a threshold alert
// through the EXISTING emitAlertChecked/bot-errors mechanism, state-transition
// guarded (fire once, clear once resolved) — never re-alerting every tick.

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
import { createBead, approveProposal } from '../../../src/core/substrate/beads.ts';
import { TriggerPoller } from '../../../src/core/substrate/poller.ts';
import { emitAlertChecked, clearAlertSourceChecked } from '../../../src/lib/emit-alert.ts';
import type { Messenger, SubmissionReceipt } from '../../../src/core/types.ts';

function tmpFile() { return join(tmpdir(), `poller-overdue-${randomBytes(8).toString('hex')}.db`); }

function makeMessenger(): Messenger {
  return {
    async sendMessage(): Promise<SubmissionReceipt> { return { waMessageId: null }; },
    async sendMedia() { throw new Error('not used'); },
  };
}

const NOW = 1_000_000_000;

describe('TriggerPoller — overdue proposal backlog alert (#1773 rem-3)', () => {
  let path: string;
  let db: Database;
  beforeEach(() => {
    path = tmpFile(); db = new Database(path); db.open();
    vi.mocked(emitAlertChecked).mockClear();
    vi.mocked(clearAlertSourceChecked).mockClear();
  });
  afterEach(() => { db.close(); if (existsSync(path)) unlinkSync(path); });

  function createOverdueProposal(title: string, ago = 1000) {
    return createBead(db.raw, {
      kind: 'task', title, ownerJid: 'mw', actor: 'user',
      status: 'proposed', reviewByAt: NOW - ago, confidence: 0.6, proposalReason: 'inline',
    });
  }

  it('does not alert while the overdue count is at/under the threshold', async () => {
    createOverdueProposal('p1');
    createOverdueProposal('p2');
    const poller = new TriggerPoller(db.raw, makeMessenger(), {
      now: () => NOW, instance: 'test-bot', overdueProposalAlertThreshold: 2,
    });

    await poller.tickOnce();

    expect(emitAlertChecked).not.toHaveBeenCalled();
  });

  it('alerts once when the overdue count exceeds the threshold, then does not re-alert on subsequent ticks', async () => {
    createOverdueProposal('p1');
    createOverdueProposal('p2');
    createOverdueProposal('p3');
    const poller = new TriggerPoller(db.raw, makeMessenger(), {
      now: () => NOW, instance: 'test-bot', overdueProposalAlertThreshold: 2,
    });

    await poller.tickOnce();
    expect(emitAlertChecked).toHaveBeenCalledTimes(1);
    expect(emitAlertChecked).toHaveBeenCalledWith(
      'test-bot',
      'bead_proposal_backlog',
      expect.stringContaining('3 bead proposals'),
      expect.stringContaining('overdueCount=3'),
      'warning',
    );

    // Still over threshold on the next tick — state-transition guard means no
    // second alert (mirrors ConnectionManager.loggedOutAlertEmitted).
    await poller.tickOnce();
    expect(emitAlertChecked).toHaveBeenCalledTimes(1);
  });

  it('clears the alert once the backlog drains back at/under the threshold', async () => {
    const overdue = [createOverdueProposal('p1'), createOverdueProposal('p2'), createOverdueProposal('p3')];
    const poller = new TriggerPoller(db.raw, makeMessenger(), {
      now: () => NOW, instance: 'test-bot', overdueProposalAlertThreshold: 2,
    });

    await poller.tickOnce();
    expect(emitAlertChecked).toHaveBeenCalledTimes(1);

    // Dispose one proposal — backlog drops from 3 to 2, at the threshold.
    approveProposal(db.raw, overdue[0].id, { actor: 'user' });
    await poller.tickOnce();

    expect(clearAlertSourceChecked).toHaveBeenCalledTimes(1);
    expect(clearAlertSourceChecked).toHaveBeenCalledWith(
      'test-bot',
      'bead_proposal_backlog',
      expect.stringContaining('overdueCount=2'),
    );
  });

  it('never emits when no instance name is configured (fail-safe no-op)', async () => {
    createOverdueProposal('p1');
    createOverdueProposal('p2');
    createOverdueProposal('p3');
    const poller = new TriggerPoller(db.raw, makeMessenger(), {
      now: () => NOW, overdueProposalAlertThreshold: 2, // no `instance`
    });

    await poller.tickOnce();

    expect(emitAlertChecked).not.toHaveBeenCalled();
  });
});
