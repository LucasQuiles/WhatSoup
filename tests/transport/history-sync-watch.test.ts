import { describe, it, expect, vi } from 'vitest';

import { proto } from '../../node_modules/@whiskeysockets/baileys/WAProto/index.js';
import {
  HistorySyncWatch,
  HISTORY_SYNC_NOTIFICATION_TYPE,
  HISTORY_SYNC_TYPE_FULL,
} from '../../src/transport/history-sync-watch.ts';

const RECENT = proto.HistorySync.HistorySyncType.RECENT;
const ON_DEMAND = proto.HistorySync.HistorySyncType.ON_DEMAND;

function notification(syncType: number, fromMe: boolean | undefined) {
  return {
    key: { fromMe },
    message: {
      protocolMessage: {
        type: HISTORY_SYNC_NOTIFICATION_TYPE,
        historySyncNotification: { syncType },
      },
    },
  };
}

/** Manual timer so expiry is driven by the test, not wall-clock sleeps. */
function manualTimers() {
  let pending: (() => void) | null = null;
  return {
    timers: {
      set: vi.fn((fn: () => void) => {
        pending = fn;
        return 'handle';
      }),
      clear: vi.fn(() => {
        pending = null;
      }),
    },
    fire() {
      const fn = pending;
      pending = null;
      fn?.();
    },
    armed: () => pending !== null,
  };
}

function makeWatch() {
  const log = { warn: vi.fn(), debug: vi.fn() };
  const clock = manualTimers();
  const watch = new HistorySyncWatch(log, 300_000, clock.timers);
  return { log, clock, watch };
}

describe('HistorySyncWatch constants', () => {
  it('match the vendored WhatsApp protocol enums', () => {
    expect(HISTORY_SYNC_NOTIFICATION_TYPE).toBe(proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION);
    expect(HISTORY_SYNC_TYPE_FULL).toBe(proto.HistorySync.HistorySyncType.FULL);
  });
});

describe('HistorySyncWatch', () => {
  it('warns when a history notification is not marked as ours', () => {
    const { log, clock, watch } = makeWatch();
    watch.observeUpsert(notification(RECENT, false));

    expect(log.warn).toHaveBeenCalledWith(
      { syncType: RECENT },
      'history sync notification is not marked as ours; the self-only guard drops it',
    );
    expect(clock.armed()).toBe(false);
  });

  it('warns when eligible notifications produce no batch before the timeout', () => {
    const { log, clock, watch } = makeWatch();
    watch.observeUpsert(notification(RECENT, true));
    watch.observeUpsert(notification(ON_DEMAND, true));
    clock.fire();

    expect(log.warn).toHaveBeenCalledWith(
      { pending: 2, syncTypes: [RECENT, ON_DEMAND], timeoutMs: 300_000 },
      'history sync notifications received but no history batch arrived',
    );
  });

  it('stays quiet when every eligible notification is followed by a batch', () => {
    const { log, clock, watch } = makeWatch();
    watch.observeUpsert(notification(RECENT, true));
    watch.observeUpsert(notification(RECENT, true));
    watch.observeBatch();
    expect(clock.armed()).toBe(true);
    watch.observeBatch();

    expect(clock.armed()).toBe(false);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('counts FULL notifications as intentionally skipped, never as a loss', () => {
    const { log, clock, watch } = makeWatch();
    watch.observeUpsert(notification(HISTORY_SYNC_TYPE_FULL, true));

    expect(clock.armed()).toBe(false);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith(
      { syncType: HISTORY_SYNC_TYPE_FULL },
      'history sync notification skipped by policy (FULL)',
    );
  });

  it('ignores ordinary messages and forgets pending notifications on reset', () => {
    const { log, clock, watch } = makeWatch();
    watch.observeUpsert({ key: { fromMe: false }, message: {} });
    watch.observeUpsert(notification(RECENT, true));
    watch.reset();
    clock.fire();

    expect(clock.timers.clear).toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('does not let a batch with nothing pending mask a later loss', () => {
    const { log, clock, watch } = makeWatch();
    watch.observeBatch();
    watch.observeUpsert(notification(RECENT, true));
    clock.fire();

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ pending: 1 }),
      'history sync notifications received but no history batch arrived',
    );
  });
});
