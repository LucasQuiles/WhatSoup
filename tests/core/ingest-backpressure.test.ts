/**
 * Tests for SP1: Ingest backpressure — counting semaphore + bounded overflow queue.
 *
 * Module-level state in ingest.ts (_activeSlots, waitQueue, ingestActive,
 * ingestQueued, ingestDropped) persists for the lifetime of the module, so
 * each test must account for a fresh module state. Because vitest is run with
 * --pool=forks each test FILE runs in a separate worker process; the module is
 * therefore fresh for this entire file. Individual tests that mutate state must
 * be ordered carefully or the suite must be run sequentially.
 *
 * Strategy: run each backpressure test in a dedicated describe block that
 * awaits full drain before proceeding. The `runIngest` helper adds a micro-
 * task flush; for slow-path tests we use deferred promises to control timing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, Messenger } from '../../src/core/types.ts';
import type { Runtime } from '../../src/runtimes/types.ts';

// ---------------------------------------------------------------------------
// Module mocks — registered before any imports of the mocked modules
// ---------------------------------------------------------------------------

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../src/lib/emit-alert.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitAlert: vi.fn(() => ({ ok: true, channel: 'sink', status: 'durably_queued' })),
}));

vi.mock('../../src/core/command-router.ts', () => ({
  isAdminMessage: vi.fn().mockReturnValue(false),
  parseAdminCommand: vi.fn().mockReturnValue(null),
}));

vi.mock('../../src/core/admin.ts', () => ({
  handleAdminCommand: vi.fn().mockResolvedValue(undefined),
  sendApprovalRequest: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/core/access-policy.ts', () => ({
  shouldRespond: vi.fn().mockReturnValue({ respond: true, reason: 'dm_allowed', accessStatus: 'allowed' }),
}));

vi.mock('../../src/core/access-list.ts', () => ({
  extractLocal: vi.fn((jid: string) => jid.split('@')[0]),
  resolvePhoneFromJid: vi.fn((jid: string) => jid.split('@')[0]),
  lookupAccess: vi.fn(),
  insertPending: vi.fn(),
  updateAccess: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { Database } from '../../src/core/database.ts';
import { createIngestHandler, getIngestStats } from '../../src/core/ingest.ts';
import { config } from '../../src/config.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

function makeMessenger(): Messenger {
  return {
    sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
    sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
  };
}

function makeMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: `msg-${randomBytes(4).toString('hex')}`,
    chatJid: '15551230008@s.whatsapp.net',
    senderJid: '15551230008@s.whatsapp.net',
    senderName: 'Alice',
    content: 'hello',
    contentType: 'text',
    isFromMe: false,
    isGroup: false,
    mentionedJids: [],
    timestamp: Math.floor(Date.now() / 1000),
    quotedMessageId: null,
    contentText: null,
    isResponseWorthy: true,
    ...overrides,
  };
}

const BOT_JID = '15551230004@s.whatsapp.net';

/**
 * Build an ingest handler with the standard mock deps.
 * Returns the handler and the underlying runtime mock so callers can spy on dispatch.
 */
function makeIngest(runtimeOverrides?: Partial<Runtime>) {
  const db = makeDb();
  const messenger = makeMessenger();
  const runtime: Runtime = {
    start: vi.fn().mockResolvedValue(undefined),
    handleMessage: vi.fn().mockResolvedValue(undefined),
    getHealthSnapshot: vi.fn().mockReturnValue({ status: 'healthy', details: {} }),
    shutdown: vi.fn().mockResolvedValue(undefined),
    setDurability: vi.fn(),
    ...runtimeOverrides,
  };
  const handler = createIngestHandler(db, messenger, runtime, () => BOT_JID, () => null);
  return { db, messenger, runtime, handler };
}

/** Fire the handler and wait until the ingest pipeline drains. */
async function runIngest(handler: (msg: IncomingMessage) => void, msg: IncomingMessage): Promise<void> {
  handler(msg);
  await waitForStats((stats) => {
    expect(stats.active).toBe(0);
    expect(stats.queued).toBe(0);
  });
}

/**
 * Temporarily override config.ingest for the duration of fn().
 * Restores the original descriptor on exit.
 */
async function withIngestConfig(
  overrides: { maxConcurrent?: number; maxQueueDepth?: number },
  fn: () => Promise<void>,
): Promise<void> {
  const original = Object.getOwnPropertyDescriptor(config, 'ingest');
  Object.defineProperty(config, 'ingest', {
    configurable: true,
    value: { ...(config.ingest ?? {}), ...overrides },
  });
  try {
    await fn();
  } finally {
    if (original) {
      Object.defineProperty(config, 'ingest', original);
    }
  }
}

// ---------------------------------------------------------------------------
// Deferred promise utility for controlling when async processing completes
// ---------------------------------------------------------------------------

import { deferred } from '../helpers/deferred.ts';

async function waitForStats(assertStats: (stats: ReturnType<typeof getIngestStats>) => void): Promise<void> {
  await vi.waitFor(() => {
    assertStats(getIngestStats());
  });
}

async function waitForIdle(): Promise<void> {
  await waitForStats((stats) => {
    expect(stats.active).toBe(0);
    expect(stats.queued).toBe(0);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ===========================================================================
// SP1-01: Normal flow — messages below concurrency limit process without queuing
// ===========================================================================

describe('SP1-01: normal flow below concurrency limit', () => {
  it('single message processes immediately without going through the queue', async () => {
    await withIngestConfig({ maxConcurrent: 5, maxQueueDepth: 10 }, async () => {
      const { handler, runtime } = makeIngest();
      const msg = makeMsg();

      await runIngest(handler, msg);

      // Was dispatched to runtime
      expect(vi.mocked(runtime.handleMessage)).toHaveBeenCalledOnce();
      expect(vi.mocked(runtime.handleMessage)).toHaveBeenCalledWith(msg);

      // Counters should be back to zero after drain
      const stats = getIngestStats();
      expect(stats.active).toBe(0);
      expect(stats.queued).toBe(0);
    });
  });

  it('N messages where N < maxConcurrent all acquire slots immediately', async () => {
    await withIngestConfig({ maxConcurrent: 5, maxQueueDepth: 100 }, async () => {
      // Use deferred promises to hold slots open simultaneously
      const deferreds = [deferred(), deferred(), deferred()]; // 3 messages, limit=5
      let callCount = 0;

      const { handler, runtime } = makeIngest({
        handleMessage: vi.fn().mockImplementation(async () => {
          return deferreds[callCount++].promise;
        }),
      });

      // Fire 3 messages — all should acquire slots (< maxConcurrent=5)
      const msgs = Array.from({ length: 3 }, () => makeMsg());
      for (const msg of msgs) handler(msg);

      // All three are active, none queued
      await waitForStats((stats) => {
        expect(stats.active).toBeGreaterThanOrEqual(3);
        expect(stats.queued).toBe(0);
      });

      // Resolve all
      for (const d of deferreds) d.resolve();
      await waitForIdle();
    });
  });
});

// ===========================================================================
// SP1-02: Backpressure — messages beyond maxConcurrent go to overflow queue
// ===========================================================================

describe('SP1-02: backpressure — overflow queue', () => {
  it('messages beyond maxConcurrent are placed in the overflow queue', async () => {
    await withIngestConfig({ maxConcurrent: 2, maxQueueDepth: 10 }, async () => {
      // Two deferreds to hold the two concurrent slots
      const slot1 = deferred();
      const slot2 = deferred();
      let callIndex = 0;
      const deferreds = [slot1, slot2];

      const { handler, runtime } = makeIngest({
        handleMessage: vi.fn().mockImplementation(async () => {
          const d = deferreds[callIndex];
          callIndex++;
          if (d) return d.promise;
        }),
      });

      // Fire 2 messages to fill the slots
      handler(makeMsg({ messageId: 'slot-1' }));
      handler(makeMsg({ messageId: 'slot-2' }));

      // Both slots should be active
      await waitForStats((stats) => {
        expect(stats.active).toBeGreaterThanOrEqual(2);
      });

      // Now fire one more — should go to queue (maxConcurrent=2 already reached)
      handler(makeMsg({ messageId: 'queued-1' }));

      await waitForStats((stats) => {
        expect(stats.queued).toBeGreaterThanOrEqual(1);
      });
      expect(vi.mocked(runtime.handleMessage)).toHaveBeenCalledTimes(2); // third not yet dispatched

      // Release slots — third message should now process
      slot1.resolve();
      slot2.resolve();

      await vi.waitFor(() => {
        expect(vi.mocked(runtime.handleMessage)).toHaveBeenCalledTimes(3);
      });
    });
  });
});

// ===========================================================================
// SP1-03: Overflow drop — when queue is full, oldest is dropped (FIFO eviction)
// ===========================================================================

describe('SP1-03: overflow drop — oldest message dropped when queue is full', () => {
  it('drops the oldest message when the overflow queue is at capacity', async () => {
    // maxConcurrent=1, maxQueueDepth=1 means:
    //   - message A gets the slot
    //   - message B goes to queue (depth now 1 = max)
    //   - message C triggers drop of oldest queued (B is dropped, C enqueues)
    await withIngestConfig({ maxConcurrent: 1, maxQueueDepth: 1 }, async () => {
      const slotA = deferred();
      let dispatched: string[] = [];

      const { handler, runtime } = makeIngest({
        handleMessage: vi.fn().mockImplementation(async (msg: IncomingMessage) => {
          dispatched.push(msg.messageId);
          if (msg.messageId === 'msg-A') return slotA.promise;
        }),
      });

      // Message A: takes the slot
      handler(makeMsg({ messageId: 'msg-A' }));
      await waitForStats((stats) => {
        expect(stats.active).toBe(1);
      });

      // Message B: goes to queue (queue depth = 1 = max)
      handler(makeMsg({ messageId: 'msg-B', isGroup: false }));
      await waitForStats((stats) => {
        expect(stats.queued).toBe(1);
      });

      const statsBefore = getIngestStats();

      // Message C: queue is full — B gets dropped, C enqueues
      handler(makeMsg({ messageId: 'msg-C', isGroup: false }));

      // Queue is still at 1 (C replaced B), dropped counter went up
      await waitForStats((statsAfter) => {
        expect(statsAfter.dropped).toBe(statsBefore.dropped + 1);
        expect(statsAfter.queued).toBe(1); // still 1 queued (msg-C)
      });

      // Release slot A — msg-C should now run, msg-B was dropped and never runs
      slotA.resolve();
      await vi.waitFor(() => {
        expect(dispatched).toContain('msg-C');
      });

      expect(dispatched).toContain('msg-A');
      expect(dispatched).toContain('msg-C');
      expect(dispatched).not.toContain('msg-B');
    });
  });

  it('prefers to drop group messages over DMs when evicting', async () => {
    await withIngestConfig({ maxConcurrent: 1, maxQueueDepth: 2 }, async () => {
      const slotA = deferred();
      let dispatched: string[] = [];

      const { handler, runtime } = makeIngest({
        handleMessage: vi.fn().mockImplementation(async (msg: IncomingMessage) => {
          dispatched.push(msg.messageId);
          if (msg.messageId === 'msg-A') return slotA.promise;
        }),
      });

      // Fill slot A
      handler(makeMsg({ messageId: 'msg-A' }));
      await waitForStats((stats) => {
        expect(stats.active).toBe(1);
      });

      // Queue: [DM-1, GROUP-1] (depth = 2 = max)
      handler(makeMsg({ messageId: 'dm-1', isGroup: false }));
      handler(makeMsg({ messageId: 'group-1', isGroup: true }));
      await waitForStats((stats) => {
        expect(stats.queued).toBe(2);
      });

      // Next message triggers eviction — group-1 should be preferred for drop
      const droppedBefore = getIngestStats().dropped;
      handler(makeMsg({ messageId: 'dm-2', isGroup: false }));

      await waitForStats((stats) => {
        expect(stats.dropped).toBe(droppedBefore + 1);
        expect(stats.queued).toBe(2); // still 2 (group-1 replaced by dm-2)
      });

      // Drain
      slotA.resolve();
      await vi.waitFor(() => {
        expect(dispatched).toContain('dm-2');
      });

      // Group message was dropped, DMs went through
      expect(dispatched).toContain('dm-1');
      expect(dispatched).toContain('dm-2');
      expect(dispatched).not.toContain('group-1');
    });
  });
});

// ===========================================================================
// SP1-04: Stats — getIngestStats() reports correct active/queued/dropped counts
// ===========================================================================

describe('SP1-04: getIngestStats() counters', () => {
  it('returns zero stats when no messages are in flight', async () => {
    await withIngestConfig({ maxConcurrent: 5, maxQueueDepth: 10 }, async () => {
      const { handler } = makeIngest();

      // Run one message and let it fully complete
      await runIngest(handler, makeMsg());

      const stats = getIngestStats();
      expect(stats.active).toBe(0);
      expect(stats.queued).toBe(0);
      // dropped may be non-zero from other tests but active/queued should be clean
    });
  });

  it('reports increasing active count while slots are held', async () => {
    await withIngestConfig({ maxConcurrent: 3, maxQueueDepth: 10 }, async () => {
      const d1 = deferred();
      const d2 = deferred();
      let callIdx = 0;
      const deferreds = [d1, d2];

      const { handler } = makeIngest({
        handleMessage: vi.fn().mockImplementation(async () => {
          const d = deferreds[callIdx];
          callIdx++;
          if (d) return d.promise;
        }),
      });

      handler(makeMsg({ messageId: 'active-1' }));
      handler(makeMsg({ messageId: 'active-2' }));

      // Both active (limit=3 not reached yet)
      await waitForStats((stats) => {
        expect(stats.active).toBeGreaterThanOrEqual(2);
        expect(stats.queued).toBe(0);
      });

      // Release
      d1.resolve();
      d2.resolve();

      await waitForIdle();
    });
  });

  it('dropped counter accumulates across multiple drops', async () => {
    await withIngestConfig({ maxConcurrent: 1, maxQueueDepth: 1 }, async () => {
      const hold = deferred();
      let isFirst = true;

      const { handler } = makeIngest({
        handleMessage: vi.fn().mockImplementation(async () => {
          if (isFirst) {
            isFirst = false;
            return hold.promise;
          }
        }),
      });

      const droppedBefore = getIngestStats().dropped;

      // msg-A takes the slot
      handler(makeMsg({ messageId: 'drop-A' }));
      await waitForStats((stats) => {
        expect(stats.active).toBe(1);
      });

      // msg-B fills queue (depth=1)
      handler(makeMsg({ messageId: 'drop-B' }));
      await waitForStats((stats) => {
        expect(stats.queued).toBe(1);
      });

      // msg-C drops msg-B
      handler(makeMsg({ messageId: 'drop-C' }));
      await waitForStats((stats) => {
        expect(stats.dropped).toBe(droppedBefore + 1);
      });

      // msg-D drops msg-C
      handler(makeMsg({ messageId: 'drop-D' }));

      // Should have dropped 2 messages (B and C)
      await waitForStats((stats) => {
        expect(stats.dropped).toBe(droppedBefore + 2);
      });

      hold.resolve();
      await waitForIdle();
    });
  });
});

// ===========================================================================
// SP1-05: Drain — after active slots free up, queued messages are processed
// ===========================================================================

describe('SP1-05: drain — queued messages process when slots free', () => {
  it('queued message is dispatched when a slot becomes available', async () => {
    await withIngestConfig({ maxConcurrent: 1, maxQueueDepth: 5 }, async () => {
      const hold = deferred();
      let dispatchOrder: string[] = [];

      const { handler, runtime } = makeIngest({
        handleMessage: vi.fn().mockImplementation(async (msg: IncomingMessage) => {
          dispatchOrder.push(msg.messageId);
          if (msg.messageId === 'first') return hold.promise;
        }),
      });

      // Fill the single slot
      handler(makeMsg({ messageId: 'first' }));
      await waitForStats((stats) => {
        expect(stats.active).toBe(1);
      });

      // Queue a second message
      handler(makeMsg({ messageId: 'second' }));
      await waitForStats((stats) => {
        expect(stats.queued).toBe(1);
      });

      // Second message should NOT have been dispatched yet
      expect(vi.mocked(runtime.handleMessage)).toHaveBeenCalledTimes(1);

      // Release the slot — second should drain
      hold.resolve();

      await vi.waitFor(() => {
        expect(vi.mocked(runtime.handleMessage)).toHaveBeenCalledTimes(2);
        expect(dispatchOrder).toEqual(['first', 'second']);
      });

      // All counters clean
      await waitForIdle();
    });
  });

  it('queued messages drain in FIFO order', async () => {
    await withIngestConfig({ maxConcurrent: 1, maxQueueDepth: 10 }, async () => {
      const hold = deferred();
      let dispatchOrder: string[] = [];

      const { handler } = makeIngest({
        handleMessage: vi.fn().mockImplementation(async (msg: IncomingMessage) => {
          dispatchOrder.push(msg.messageId);
          if (msg.messageId === 'anchor') return hold.promise;
        }),
      });

      // Anchor fills the slot
      handler(makeMsg({ messageId: 'anchor' }));
      await waitForStats((stats) => {
        expect(stats.active).toBe(1);
      });

      // Enqueue in order
      handler(makeMsg({ messageId: 'q1' }));
      handler(makeMsg({ messageId: 'q2' }));
      handler(makeMsg({ messageId: 'q3' }));

      await waitForStats((stats) => {
        expect(stats.queued).toBe(3);
      });

      // Release anchor — remaining three should drain in order
      hold.resolve();

      await vi.waitFor(() => {
        expect(dispatchOrder).toEqual(['anchor', 'q1', 'q2', 'q3']);
      });
    });
  });
});
