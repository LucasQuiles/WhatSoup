/**
 * Tests for DurabilityEngine wiring in SessionManager.
 * Verifies that upsertSessionCheckpoint is called at the right lifecycle points.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { SessionManager } from '../../../src/runtimes/agent/session.ts';
import type { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';
import type { DurabilityEngine } from '../../../src/core/durability.ts';

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/mock/home'),
  userInfo: vi.fn(() => ({ username: 'testuser' })),
}));

vi.mock('node:child_process', async () => {
  const { childProcessMock } = await import('../../helpers/child-process.ts');
  return childProcessMock();
});
vi.mock('../../../src/runtimes/agent/process-tree.ts', () => ({
  killSessionTree: vi.fn(async (target: { kill(signal: NodeJS.Signals): boolean }, signal: NodeJS.Signals) => {
    target.kill(signal);
  }),
}));
vi.mock('node:fs', () => ({ readFileSync: vi.fn() }));

vi.mock('../../../src/runtimes/agent/session-db.ts', () => ({
  createSession: vi.fn(() => 42),
  incrementMessageCount: vi.fn(),
  updateSessionId: vi.fn(),
  updateSessionStatus: vi.fn(),
  updateTranscriptPath: vi.fn(),
  backfillSessionProvider: vi.fn(),
}));

import { spawn } from 'node:child_process';

// ─── Helpers ─────────────────────────────────────────────────────────────────

type UpsertSessionCheckpointCall = Parameters<DurabilityEngine['upsertSessionCheckpoint']>;
type BeginFreshSessionCheckpointCall = Parameters<DurabilityEngine['beginFreshSessionCheckpoint']>;

function makeDb(): Database {
  return {
    assertWritableCompatibility: vi.fn(),
    raw: { prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn() })), exec: vi.fn() },
  } as unknown as Database;
}

function makeMessenger(): Messenger {
  return {
    sendMessage: vi.fn(async () => ({ waMessageId: null })),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
  };
}

function makeDurability(): {
  durability: DurabilityEngine;
  upsertCalls: UpsertSessionCheckpointCall[];
  beginFreshCalls: BeginFreshSessionCheckpointCall[];
} {
  const upsertCalls: UpsertSessionCheckpointCall[] = [];
  const beginFreshCalls: BeginFreshSessionCheckpointCall[] = [];
  const durability: DurabilityEngine = {
    beginFreshSessionCheckpoint: vi.fn((...call: BeginFreshSessionCheckpointCall) => {
      beginFreshCalls.push(call);
    }),
    upsertSessionCheckpoint: vi.fn((...call: UpsertSessionCheckpointCall) => {
      upsertCalls.push(call);
    }),
    markSessionOrphaned: vi.fn(),
    getSessionCheckpoint: vi.fn(),
    getAllActiveCheckpoints: vi.fn(() => []),
  } as unknown as DurabilityEngine;
  return { durability, upsertCalls, beginFreshCalls };
}

function makeMockChild(pid = 12345) {
  const stdin = Object.assign(new EventEmitter(), {
    write: vi.fn((_d: unknown, _e: unknown, cb: (err?: Error | null) => void) => cb()),
  });
  const stdout = new EventEmitter();
  (stdout as unknown as { setEncoding: (enc: string) => void }).setEncoding = vi.fn();
  const stderr = new EventEmitter();
  const child = {
    pid,
    stdin,
    stdout,
    stderr,
    kill: vi.fn(),
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'exit') (child as any)._exitCb = cb;
    }),
    _exitCb: null as ((...args: unknown[]) => void) | null,
  };
  return child;
}

const CHAT_JID = 'test@s.whatsapp.net';
const CONVERSATION_KEY = 'test';

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('SessionManager — durability checkpoints', () => {
  let mockChild: ReturnType<typeof makeMockChild>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChild = makeMockChild(12345);
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockChild);
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('setDurability can be called without error', () => {
    const db = makeDb();
    const { durability } = makeDurability();
    const sm = new SessionManager({ db, messenger: makeMessenger(), chatJid: CHAT_JID, onEvent: vi.fn() });
    expect(() => sm.setDurability(durability)).not.toThrow();
  });

  it('spawnSession atomically begins a fresh active checkpoint', async () => {
    const db = makeDb();
    const { durability, upsertCalls, beginFreshCalls } = makeDurability();
    const sm = new SessionManager({ db, messenger: makeMessenger(), chatJid: CHAT_JID, onEvent: vi.fn() });
    sm.setDurability(durability);

    await sm.spawnSession();

    expect(beginFreshCalls).toStrictEqual([[CONVERSATION_KEY, 12345]]);
    expect(upsertCalls).toStrictEqual([]);
  });

  it('works fine without durability set (no crash)', async () => {
    const db = makeDb();
    const sm = new SessionManager({ db, messenger: makeMessenger(), chatJid: CHAT_JID, onEvent: vi.fn() });
    // No setDurability call — should not throw
    await expect(sm.spawnSession()).resolves.not.toThrow();
  });

  it('shutdown(true) calls upsertSessionCheckpoint with suspended', async () => {
    const db = makeDb();
    const { durability, upsertCalls } = makeDurability();
    const sm = new SessionManager({ db, messenger: makeMessenger(), chatJid: CHAT_JID, onEvent: vi.fn() });
    sm.setDurability(durability);

    await sm.spawnSession();
    upsertCalls.length = 0; // reset after spawn

    await sm.shutdown(true);

    expect(upsertCalls).toStrictEqual([
      [CONVERSATION_KEY, { sessionStatus: 'suspended' }],
    ]);
  });

  it('shutdown(false) calls upsertSessionCheckpoint with ended', async () => {
    const db = makeDb();
    const { durability, upsertCalls } = makeDurability();
    const sm = new SessionManager({ db, messenger: makeMessenger(), chatJid: CHAT_JID, onEvent: vi.fn() });
    sm.setDurability(durability);

    await sm.spawnSession();
    upsertCalls.length = 0; // reset after spawn

    await sm.shutdown(false);

    expect(upsertCalls).toStrictEqual([
      [CONVERSATION_KEY, { sessionStatus: 'ended' }],
    ]);
  });

  it('crash triggers checkpoint with orphaned status', async () => {
    const db = makeDb();
    const { durability, upsertCalls } = makeDurability();
    const onCrash = vi.fn();
    const sm = new SessionManager({
      db,
      messenger: makeMessenger(),
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      onCrash,
    });
    sm.setDurability(durability);

    await sm.spawnSession();
    upsertCalls.length = 0; // reset after spawn

    // Simulate unexpected exit
    const exitCallback = mockChild._exitCb;
    if (exitCallback === null) throw new Error('spawnSession did not register an exit handler');
    exitCallback(1, null);

    expect(upsertCalls).toStrictEqual([
      [CONVERSATION_KEY, { sessionStatus: 'orphaned' }],
    ]);
    expect(onCrash).toHaveBeenCalledWith(expect.objectContaining({
      exitCode: 1,
      signal: null,
      sessionId: null,
      dbRowId: 42,
      provider: 'claude-cli',
    }));
  });
});
