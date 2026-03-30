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

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('node:fs', () => ({ readFileSync: vi.fn() }));

vi.mock('../../../src/runtimes/agent/session-db.ts', () => ({
  createSession: vi.fn(() => 42),
  incrementMessageCount: vi.fn(),
  updateSessionId: vi.fn(),
  updateSessionStatus: vi.fn(),
  updateTranscriptPath: vi.fn(),
}));

import { spawn } from 'node:child_process';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeDb(): Database {
  return {
    raw: { prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn() })), exec: vi.fn() },
  } as unknown as Database;
}

function makeMessenger(): Messenger {
  return {
    sendMessage: vi.fn(async () => ({ waMessageId: null })),
  };
}

function makeDurability(): { durability: DurabilityEngine; upsertCalls: Array<[string, object]> } {
  const upsertCalls: Array<[string, object]> = [];
  const durability: DurabilityEngine = {
    upsertSessionCheckpoint: vi.fn((key: string, fields: object) => {
      upsertCalls.push([key, fields]);
    }),
    markSessionOrphaned: vi.fn(),
    getSessionCheckpoint: vi.fn(),
    getAllActiveCheckpoints: vi.fn(() => []),
  } as unknown as DurabilityEngine;
  return { durability, upsertCalls };
}

function makeMockChild(pid = 12345) {
  const stdin = Object.assign(new EventEmitter(), {
    write: vi.fn((_d: unknown, _e: unknown, cb: (err?: Error | null) => void) => cb()),
  });
  const stdout = new EventEmitter();
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

  it('spawnSession calls upsertSessionCheckpoint with active status', async () => {
    const db = makeDb();
    const { durability, upsertCalls } = makeDurability();
    const sm = new SessionManager({ db, messenger: makeMessenger(), chatJid: CHAT_JID, onEvent: vi.fn() });
    sm.setDurability(durability);

    await sm.spawnSession();

    expect(upsertCalls.length).toBeGreaterThan(0);
    const spawnCall = upsertCalls.find(([, fields]) => (fields as any).sessionStatus === 'active');
    expect(spawnCall).toBeDefined();
    // conversationKey should be derived from chatJid
    expect(spawnCall![0]).toBeTruthy();
    // claudePid should be set
    expect((spawnCall![1] as any).claudePid).toBe(12345);
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

    const suspendCall = upsertCalls.find(([, fields]) => (fields as any).sessionStatus === 'suspended');
    expect(suspendCall).toBeDefined();
  });

  it('shutdown(false) calls upsertSessionCheckpoint with ended', async () => {
    const db = makeDb();
    const { durability, upsertCalls } = makeDurability();
    const sm = new SessionManager({ db, messenger: makeMessenger(), chatJid: CHAT_JID, onEvent: vi.fn() });
    sm.setDurability(durability);

    await sm.spawnSession();
    upsertCalls.length = 0; // reset after spawn

    await sm.shutdown(false);

    const endedCall = upsertCalls.find(([, fields]) => (fields as any).sessionStatus === 'ended');
    expect(endedCall).toBeDefined();
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
    mockChild._exitCb?.(1, null);

    const orphanedCall = upsertCalls.find(([, fields]) => (fields as any).sessionStatus === 'orphaned');
    expect(orphanedCall).toBeDefined();
  });
});
