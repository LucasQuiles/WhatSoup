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

  advanceByWithoutAwaiting(ms: number): void {
    const target = this.nowMs + ms;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort(([, a], [, b]) => a.at - b.at)[0];
      if (!next) break;
      const [id, timer] = next;
      this.timers.delete(id);
      this.nowMs = timer.at;
      void timer.callback();
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
  genericNotificationsEnabled?: boolean;
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
    genericNotificationsEnabled: options.genericNotificationsEnabled,
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

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
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

  it('projects a bounded generic stability wait without notification content or recipient data', () => {
    const h = createHarness();

    h.controller.onConnected({
      generic: { recipient: 'admin', stabilityWindowMs: 5_000 },
      event: null,
      intentionalRestartReceipt: null,
    });

    expect(h.controller.getStartupNotificationHealth()).toEqual({
      state: 'waiting_stability',
      policy: 'generic',
      stabilitySeconds: 5,
      bootCountSinceNotification: 1,
      lastBootAt: 0,
      lastNotifiedAt: null,
      nextEligibleAt: 5_000,
      lastSendAt: null,
    });
  });

  it('projects a transport wait when the stability timer expires before strict readiness', async () => {
    const h = createHarness({ ready: false });

    h.controller.onConnected({
      generic: { recipient: 'admin', stabilityWindowMs: 5_000 },
      event: null,
      intentionalRestartReceipt: null,
    });
    await h.scheduler.advanceBy(5_000);

    expect(h.controller.getStartupNotificationHealth()).toMatchObject({
      state: 'waiting_transport',
      policy: 'generic',
      stabilitySeconds: 5,
      nextEligibleAt: 10_000,
      lastSendAt: null,
    });
  });

  it('reports generic policy disabled without suppressing a named restart receipt', async () => {
    const disabled = createHarness({ genericNotificationsEnabled: false });
    expect(disabled.controller.getStartupNotificationHealth()).toMatchObject({
      state: 'disabled',
      policy: 'disabled',
    });
    disabled.controller.onConnected({ generic: null, event: null, intentionalRestartReceipt: null });
    expect(disabled.controller.getStartupNotificationHealth()).toMatchObject({
      state: 'disabled',
      policy: 'disabled',
    });

    const receipt = createHarness({ genericNotificationsEnabled: false });
    receipt.controller.onConnected({
      generic: null,
      event: null,
      intentionalRestartReceipt: { chatJid: 'restart-requester', text: 'back online' },
    });
    expect(receipt.controller.getStartupNotificationHealth()).toMatchObject({
      state: 'waiting_stability',
      policy: 'intentional_restart',
    });

    await receipt.scheduler.advanceBy(3_000);
    expect(receipt.controller.getStartupNotificationHealth()).toMatchObject({
      state: 'sent',
      policy: 'intentional_restart',
    });
  });

  it('gives an unreadable journal precedence over disabled generic policy', () => {
    const journal = makeJournal();
    journal.recordStartupBoot = vi.fn(() => ({
      status: 'journal_unreadable',
      state: { v: 1, boots: [1_000], lastNotifiedAt: null },
    }));
    const h = createHarness({ journal, genericNotificationsEnabled: false });

    expect(h.controller.getStartupNotificationHealth()).toMatchObject({
      state: 'journal_unreadable',
      policy: 'disabled',
    });
  });

  it('does not arm a generic aggregate beside a typed event when generic policy is disabled', async () => {
    const h = createHarness({ genericNotificationsEnabled: false });

    h.controller.onConnected({
      generic: { recipient: 'admin', stabilityWindowMs: 30_000 },
      event: { kind: 'restart_loop_guard_alert', chatJid: 'admin', text: 'guard tripped' },
      intentionalRestartReceipt: null,
    });

    expect(h.scheduler.pendingCount).toBe(1);
    expect(h.controller.getStartupNotificationHealth()).toMatchObject({
      state: 'waiting_stability',
      policy: 'restart_loop_guard_alert',
    });
    await h.scheduler.advanceBy(3_000);
    expect(h.send).toHaveBeenCalledOnce();
  });

  it('returns to the pending generic projection after a prompt guard alert submits', async () => {
    const h = createHarness();

    h.controller.onConnected({
      generic: { recipient: 'admin', stabilityWindowMs: 30_000 },
      event: { kind: 'restart_loop_guard_alert', chatJid: 'admin', text: 'guard tripped' },
      intentionalRestartReceipt: null,
    });
    await h.scheduler.advanceBy(3_000);

    expect(h.controller.getStartupNotificationHealth()).toMatchObject({
      state: 'waiting_stability',
      policy: 'generic',
      stabilitySeconds: 30,
      nextEligibleAt: 30_000,
      lastSendAt: 3_000,
    });
  });

  it('keeps an in-flight typed guard dispatch visible until the pending generic timer begins', async () => {
    const pendingSend = deferred<unknown>();
    const h = createHarness({ send: vi.fn(() => pendingSend.promise) });

    h.controller.onConnected({
      generic: { recipient: 'admin', stabilityWindowMs: 30_000 },
      event: { kind: 'restart_loop_guard_alert', chatJid: 'admin', text: 'guard tripped' },
      intentionalRestartReceipt: null,
    });
    h.scheduler.advanceByWithoutAwaiting(3_000);

    expect(h.controller.getStartupNotificationHealth()).toMatchObject({
      state: 'dispatching',
      policy: 'restart_loop_guard_alert',
      nextEligibleAt: 30_000,
    });

    pendingSend.resolve({ accepted: true });
    await flushMicrotasks();
    expect(h.controller.getStartupNotificationHealth()).toMatchObject({
      state: 'waiting_stability',
      policy: 'generic',
    });
  });

  it('keeps a typed send failure visible until the pending generic timer begins', async () => {
    const pendingSend = deferred<unknown>();
    const h = createHarness({ send: vi.fn(() => pendingSend.promise) });

    h.controller.onConnected({
      generic: { recipient: 'admin', stabilityWindowMs: 30_000 },
      event: { kind: 'expired_session_notice', chatJid: 'admin', text: 'session expired' },
      intentionalRestartReceipt: null,
    });
    h.scheduler.advanceByWithoutAwaiting(3_000);
    pendingSend.reject(new Error('submission failed'));
    await flushMicrotasks();

    expect(h.controller.getStartupNotificationHealth()).toMatchObject({
      state: 'send_failed',
      policy: 'expired_session_notice',
      nextEligibleAt: 30_000,
    });
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

  it('reports waiting while a prompt-only resume timer is armed, then stops cleanly', () => {
    const h = createHarness();

    h.controller.onConnected({
      generic: null,
      event: { kind: 'resume', chatJid: 'resume-chat', text: 'resuming' },
      intentionalRestartReceipt: null,
    });

    expect(h.controller.getHealthSnapshot()).toEqual({
      state: 'waiting',
      timerArmed: true,
      journalStatus: 'available',
      settlement: 'not_attempted',
    });
    expect(h.scheduler.pendingCount).toBe(1);

    h.controller.stop();
    expect(h.controller.getHealthSnapshot()).toMatchObject({ state: 'stopped', timerArmed: false });
  });

  it('sends a restart-loop alert promptly without settling, then sends the configured generic aggregate', async () => {
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
    expect(h.scheduler.pendingCount).toBe(1);

    await h.scheduler.advanceBy(27_000);
    expect(h.journal.settleStartupNotification).toHaveBeenCalledOnce();
    expect(h.send).toHaveBeenCalledWith('admin', '*Agent back online* ✓', {
      replayPolicy: 'unsafe', opType: 'status_ping',
    });
  });

  it('keeps an expired-session notice distinct, then sends the configured generic aggregate', async () => {
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

    await h.scheduler.advanceBy(27_000);
    expect(h.journal.settleStartupNotification).toHaveBeenCalledOnce();
    expect(h.send).toHaveBeenCalledWith('admin', '*Agent back online* ✓', {
      replayPolicy: 'unsafe', opType: 'status_ping',
    });
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

  it('delivers a resume and receipt together after one settlement, without a later generic aggregate', async () => {
    const h = createHarness();

    h.controller.onConnected({
      generic: { recipient: 'configured-admin', stabilityWindowMs: 30_000 },
      event: { kind: 'resume', chatJid: 'resume-chat', text: 'resuming' },
      intentionalRestartReceipt: { chatJid: 'receipt-chat', text: 'back online' },
    });
    await h.scheduler.advanceBy(3_000);

    expect(h.journal.settleStartupNotification).toHaveBeenCalledOnce();
    expect(h.send.mock.invocationCallOrder[0]).toBeGreaterThan(
      h.journal.settleStartupNotification.mock.invocationCallOrder[0]!,
    );
    expect(h.send).toHaveBeenNthCalledWith(1, 'resume-chat', 'resuming', { replayPolicy: 'safe' });
    expect(h.send).toHaveBeenNthCalledWith(2, 'receipt-chat', 'back online', {
      replayPolicy: 'unsafe', opType: 'status_ping',
    });
    await h.scheduler.advanceBy(60_000);
    expect(h.send).toHaveBeenCalledTimes(2);
  });

  it('delivers a guard alert and receipt together after the receipt settles the batch', async () => {
    const h = createHarness();

    h.controller.onConnected({
      generic: { recipient: 'configured-admin', stabilityWindowMs: 30_000 },
      event: { kind: 'restart_loop_guard_alert', chatJid: 'guard-chat', text: 'guard tripped' },
      intentionalRestartReceipt: { chatJid: 'receipt-chat', text: 'back online' },
    });
    await h.scheduler.advanceBy(3_000);

    expect(h.journal.settleStartupNotification).toHaveBeenCalledOnce();
    expect(h.send.mock.invocationCallOrder[1]).toBeGreaterThan(
      h.journal.settleStartupNotification.mock.invocationCallOrder[0]!,
    );
    expect(h.send).toHaveBeenNthCalledWith(1, 'guard-chat', 'guard tripped', {
      replayPolicy: 'unsafe', opType: 'status_ping',
    });
    expect(h.send).toHaveBeenNthCalledWith(2, 'receipt-chat', 'back online', {
      replayPolicy: 'unsafe', opType: 'status_ping',
    });
    await h.scheduler.advanceBy(60_000);
    expect(h.send).toHaveBeenCalledTimes(2);
  });

  it('delivers an expired-session notice and receipt together after the receipt settles the batch', async () => {
    const h = createHarness();

    h.controller.onConnected({
      generic: { recipient: 'configured-admin', stabilityWindowMs: 30_000 },
      event: { kind: 'expired_session_notice', chatJid: 'expired-chat', text: 'session expired' },
      intentionalRestartReceipt: { chatJid: 'receipt-chat', text: 'back online' },
    });
    await h.scheduler.advanceBy(3_000);

    expect(h.journal.settleStartupNotification).toHaveBeenCalledOnce();
    expect(h.send.mock.invocationCallOrder[1]).toBeGreaterThan(
      h.journal.settleStartupNotification.mock.invocationCallOrder[0]!,
    );
    expect(h.send).toHaveBeenNthCalledWith(1, 'expired-chat', 'session expired', { replayPolicy: 'safe' });
    expect(h.send).toHaveBeenNthCalledWith(2, 'receipt-chat', 'back online', {
      replayPolicy: 'unsafe', opType: 'status_ping',
    });
    await h.scheduler.advanceBy(60_000);
    expect(h.send).toHaveBeenCalledTimes(2);
  });

  it('cancels both prompt and generic timers on stop', async () => {
    const h = createHarness();

    h.controller.onConnected({
      generic: { recipient: 'admin', stabilityWindowMs: 30_000 },
      event: { kind: 'restart_loop_guard_alert', chatJid: 'admin', text: 'guard tripped' },
      intentionalRestartReceipt: null,
    });
    expect(h.scheduler.pendingCount).toBe(2);

    h.controller.stop();
    expect(h.scheduler.pendingCount).toBe(0);
    await h.scheduler.advanceBy(60_000);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.controller.getHealthSnapshot()).toMatchObject({ state: 'stopped', timerArmed: false });
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
