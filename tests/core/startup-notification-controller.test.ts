import { describe, expect, it, vi } from 'vitest';

import {
  StartupNotificationController,
  type StartupNotificationJournalPort,
} from '../../src/core/startup-notification-controller.ts';
import type { StartupNotificationSettlement } from '../../src/core/startup-notify.ts';

class FakeScheduler {
  private nowMs = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void | Promise<void> }>();

  setTimeout = (callback: () => void | Promise<void>, delayMs: number): number => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.nowMs + delayMs, callback });
    return id;
  };

  clearTimeout = (id: number): void => {
    this.timers.delete(id);
  };

  get pendingCount(): number {
    return this.timers.size;
  }

  async advanceBy(ms: number): Promise<void> {
    const target = this.nowMs + ms;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort(([, a], [, b]) => a.at - b.at)[0];
      if (!next) break;
      const [id, timer] = next;
      this.timers.delete(id);
      this.nowMs = timer.at;
      await timer.callback();
    }
    this.nowMs = target;
  }

  now = (): number => this.nowMs;
}

function settlement(
  overrides: Partial<StartupNotificationSettlement> = {},
): StartupNotificationSettlement {
  return {
    status: 'available',
    watermarkPersisted: true,
    state: { v: 1, boots: [0], lastNotifiedAt: 0 },
    notification: { text: '*Agent back online* ✓', bootsCovered: 1 },
    ...overrides,
  };
}

function makeJournal(
  nextSettlement: StartupNotificationSettlement = settlement(),
): StartupNotificationJournalPort {
  return {
    recordStartupBoot: vi.fn(() => ({
      status: 'available',
      state: { v: 1, boots: [0], lastNotifiedAt: null },
    })),
    settleStartupNotification: vi.fn(() => nextSettlement),
  };
}

function createHarness(options: {
  ready?: boolean;
  journal?: StartupNotificationJournalPort;
  send?: ReturnType<typeof vi.fn>;
} = {}) {
  const scheduler = new FakeScheduler();
  let ready = options.ready ?? true;
  const journal = options.journal ?? makeJournal();
  const send = options.send ?? vi.fn(async () => ({ accepted: true }));
  const controller = new StartupNotificationController({
    clock: { now: scheduler.now },
    scheduler,
    connection: { isFullyConnected: () => ready },
    journal,
    send: { send },
  });
  controller.recordStartupBoot();
  return {
    controller,
    scheduler,
    journal,
    send,
    setReady(value: boolean): void { ready = value; },
  };
}

describe('StartupNotificationController', () => {
  it('settles and submits exactly one generic notification after a connected stability window', async () => {
    const h = createHarness();

    h.controller.onConnected({
      generic: { recipient: 'admin', stabilityWindowMs: 5_000 },
      event: null,
      intentionalRestartReceipt: null,
    });
    await h.scheduler.advanceBy(4_999);
    expect(h.journal.settleStartupNotification).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();

    await h.scheduler.advanceBy(1);
    expect(h.journal.settleStartupNotification).toHaveBeenCalledOnce();
    expect(h.send).toHaveBeenCalledOnce();
    expect(h.send).toHaveBeenCalledWith(
      'admin',
      '*Agent back online* ✓',
      { replayPolicy: 'unsafe', opType: 'status_ping' },
    );
  });

  it('submits one aggregate returned for every unnotified v1 boot', async () => {
    const journal = makeJournal(settlement({
      state: { v: 1, boots: [1, 2, 3], lastNotifiedAt: 3 },
      notification: { text: 'three boot aggregate', bootsCovered: 3 },
    }));
    const h = createHarness({ journal });

    h.controller.onConnected({
      generic: { recipient: 'admin', stabilityWindowMs: 3_000 },
      event: null,
      intentionalRestartReceipt: null,
    });
    await h.scheduler.advanceBy(3_000);

    expect(h.journal.settleStartupNotification).toHaveBeenCalledOnce();
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledWith('admin', 'three boot aggregate', {
      replayPolicy: 'unsafe', opType: 'status_ping',
    });
  });

  it('waits for strict readiness and re-arms one timer after a disconnect', async () => {
    const h = createHarness({ ready: false });

    h.controller.onConnected({
      generic: { recipient: 'admin', stabilityWindowMs: 4_000 },
      event: null,
      intentionalRestartReceipt: null,
    });
    await h.scheduler.advanceBy(4_000);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.journal.settleStartupNotification).not.toHaveBeenCalled();
    expect(h.scheduler.pendingCount).toBe(1);

    h.setReady(true);
    await h.scheduler.advanceBy(4_000);
    expect(h.journal.settleStartupNotification).toHaveBeenCalledOnce();
    expect(h.send).toHaveBeenCalledOnce();
    expect(h.scheduler.pendingCount).toBe(0);
  });

  it('applies the three-second floor to a zero generic window without synchronous submission', async () => {
    const h = createHarness();

    h.controller.onConnected({
      generic: { recipient: 'admin', stabilityWindowMs: 0 },
      event: null,
      intentionalRestartReceipt: null,
    });
    expect(h.send).not.toHaveBeenCalled();
    await h.scheduler.advanceBy(2_999);
    expect(h.send).not.toHaveBeenCalled();
    await h.scheduler.advanceBy(1);
    expect(h.send).toHaveBeenCalledOnce();
  });

  it('sends a resume safely after settling the generic boot batch', async () => {
    const h = createHarness();

    h.controller.onConnected({
      generic: { recipient: 'admin', stabilityWindowMs: 30_000 },
      event: {
        kind: 'resume',
        chatJid: 'resume-chat',
        text: 'resuming',
      },
      intentionalRestartReceipt: null,
    });
    await h.scheduler.advanceBy(3_000);

    expect(h.journal.settleStartupNotification).toHaveBeenCalledOnce();
    expect(h.send).toHaveBeenCalledWith('resume-chat', 'resuming', { replayPolicy: 'safe' });
    expect(h.send.mock.invocationCallOrder[0]).toBeGreaterThan(
      h.journal.settleStartupNotification.mock.invocationCallOrder[0]!,
    );
  });

  it('sends a restart-loop alert without settling the generic watermark', async () => {
    const h = createHarness();

    h.controller.onConnected({
      generic: { recipient: 'admin', stabilityWindowMs: 30_000 },
      event: {
        kind: 'restart_loop_guard_alert',
        chatJid: 'admin',
        text: 'guard tripped',
      },
      intentionalRestartReceipt: null,
    });
    await h.scheduler.advanceBy(3_000);

    expect(h.journal.settleStartupNotification).not.toHaveBeenCalled();
    expect(h.send).toHaveBeenCalledWith('admin', 'guard tripped', {
      replayPolicy: 'unsafe', opType: 'status_ping',
    });
  });

  it('keeps an expired-session notice distinct without a silent generic settlement', async () => {
    const h = createHarness();

    h.controller.onConnected({
      generic: { recipient: 'admin', stabilityWindowMs: 30_000 },
      event: {
        kind: 'expired_session_notice',
        chatJid: 'resume-chat',
        text: 'session expired',
      },
      intentionalRestartReceipt: null,
    });
    await h.scheduler.advanceBy(3_000);

    expect(h.journal.settleStartupNotification).not.toHaveBeenCalled();
    expect(h.send).toHaveBeenCalledWith('resume-chat', 'session expired', { replayPolicy: 'safe' });
  });

  it('settles the whole batch before an intentional restart receipt and never sends a generic aggregate later', async () => {
    const h = createHarness();

    h.controller.onConnected({
      generic: { recipient: 'configured-admin', stabilityWindowMs: 30_000 },
      event: null,
      intentionalRestartReceipt: { chatJid: 'restart-requester', text: 'back online' },
    });
    await h.scheduler.advanceBy(3_000);

    expect(h.journal.settleStartupNotification).toHaveBeenCalledOnce();
    expect(h.send).toHaveBeenCalledWith('restart-requester', 'back online', {
      replayPolicy: 'unsafe', opType: 'status_ping',
    });
    expect(h.send.mock.invocationCallOrder[0]).toBeGreaterThan(
      h.journal.settleStartupNotification.mock.invocationCallOrder[0]!,
    );
    await h.scheduler.advanceBy(60_000);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it('waits through receipt flaps, then settles the entire batch without aggregating to another admin', async () => {
    const journal = makeJournal(settlement({
      notification: { text: 'two boot aggregate', bootsCovered: 2 },
    }));
    const h = createHarness({ journal, ready: false });

    h.controller.onConnected({
      generic: { recipient: 'configured-admin', stabilityWindowMs: 5_000 },
      event: null,
      intentionalRestartReceipt: { chatJid: 'restart-requester', text: 'back online' },
    });
    await h.scheduler.advanceBy(3_000);
    expect(h.journal.settleStartupNotification).not.toHaveBeenCalled();
    h.setReady(true);
    await h.scheduler.advanceBy(3_000);

    expect(h.journal.settleStartupNotification).toHaveBeenCalledOnce();
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledWith('restart-requester', 'back online', {
      replayPolicy: 'unsafe', opType: 'status_ping',
    });
  });

  it('cancels its timer on stop and records send and journal failures without claiming durable settlement', async () => {
    const send = vi.fn(async () => { throw new Error('submission failed'); });
    const journal = makeJournal(settlement({
      status: 'journal_unreadable',
      watermarkPersisted: false,
    }));
    const h = createHarness({ journal, send });

    h.controller.onConnected({
      generic: { recipient: 'admin', stabilityWindowMs: 3_000 },
      event: null,
      intentionalRestartReceipt: null,
    });
    h.controller.stop();
    await h.scheduler.advanceBy(3_000);
    expect(h.journal.settleStartupNotification).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();

    h.controller.onConnected({
      generic: { recipient: 'admin', stabilityWindowMs: 3_000 },
      event: null,
      intentionalRestartReceipt: null,
    });
    await h.scheduler.advanceBy(3_000);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.controller.getHealthSnapshot()).toEqual({
      state: 'stopped',
      timerArmed: false,
      journalStatus: 'available',
      settlement: 'not_attempted',
    });
  });

  it('bounds journal and send failure health after a non-stopped attempt', async () => {
    const send = vi.fn(async () => { throw new Error('submission failed'); });
    const journal = makeJournal(settlement({
      status: 'journal_unreadable',
      watermarkPersisted: false,
    }));
    const h = createHarness({ journal, send });

    h.controller.onConnected({
      generic: { recipient: 'admin', stabilityWindowMs: 3_000 },
      event: null,
      intentionalRestartReceipt: null,
    });
    await h.scheduler.advanceBy(3_000);

    expect(h.send).toHaveBeenCalledOnce();
    expect(h.controller.getHealthSnapshot()).toEqual({
      state: 'send_failed',
      timerArmed: false,
      journalStatus: 'journal_unreadable',
      settlement: 'not_durable',
    });
  });
});
