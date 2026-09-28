// tests/runtimes/agent/session-resume-identity-retirement.test.ts
//
// #3658: a per-chat SessionManager stays resident after an intentional
// `ended` shutdown. The attempted resume identity must be retired with the
// rest of the closed generation, or the manager's next pre-spawn shutdown
// targets the ended checkpoint by that stale identity and refuses the turn.
// The intentional-kill exit branch must NOT retire it early: a retry after a
// failed lifecycle close still needs the identity it could not close.
//
// Harness mirrors session-residual-branches.test.ts: node:child_process,
// node:os, node:fs, the logger, session-db and process-tree are mocked at the
// module boundary and the child's exit is driven from its kill.
// Repo-hygiene reserved IDs only.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('../../../src/logger.ts', async () => (await import('../../helpers/logger-mock.ts')).loggerMock());

vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/home/testuser'),
  userInfo: vi.fn(() => ({ username: 'testuser' })),
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(() => ''),
}));

vi.mock('../../../src/runtimes/agent/process-tree.ts', () => ({
  killSessionTree: vi.fn(async (target: { kill(signal: NodeJS.Signals): boolean }, signal: NodeJS.Signals) => {
    target.kill(signal);
  }),
}));

vi.mock('../../../src/runtimes/agent/session-db.ts', () => ({
  createSession: vi.fn(() => 42),
  incrementMessageCount: vi.fn(),
  resolveResumableAgentSession: vi.fn((
    _db: unknown,
    input: { provider: string; agentSessionRowId?: number; workspaceKey?: string },
  ) => ({
    id: input.agentSessionRowId ?? 42,
    provider: input.provider,
    workspace_key: input.workspaceKey ?? null,
  })),
  updateResumedSessionStatus: vi.fn(),
  updateSessionId: vi.fn(),
  updateSessionStatus: vi.fn(),
  updateTranscriptPath: vi.fn(),
  backfillSessionProvider: vi.fn(),
}));

import { spawn } from 'node:child_process';
import { SessionManager } from '../../../src/runtimes/agent/session.ts';
import type { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';

const CHAT_JID = '1555000131@s.whatsapp.net';
const CONVERSATION_KEY = '1555000131';
const RESUME_ID = 'resume-provider-session';
const ROW_ID = 42;
const NOT_RESUMABLE = 'Exact resumable checkpoint does not match the conversation identity';

function makeDb(): Database {
  return {
    assertWritableCompatibility: vi.fn(),
    raw: {
      prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn() })),
      exec: vi.fn(),
    },
  } as unknown as Database;
}

function makeMessenger(): Messenger {
  return {
    sendMessage: vi.fn(async () => ({ waMessageId: null })),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
  };
}

/** Persistent (claude-cli) mock child that exits on the SIGTERM shutdown sends. */
function makeMockChild(pid = 9310) {
  const handlers: Record<string, (...a: unknown[]) => void> = {};
  const stdin = Object.assign(new EventEmitter(), {
    write: vi.fn((_d: unknown, _e?: unknown, cb?: (err?: Error | null) => void) => {
      if (typeof _e === 'function') (_e as (err?: Error | null) => void)();
      else if (typeof cb === 'function') cb();
      return true;
    }),
    end: vi.fn(),
  });
  const stdout = new EventEmitter();
  (stdout as unknown as { setEncoding: (enc: string) => void }).setEncoding = vi.fn();
  const stderr = new EventEmitter();
  const child = {
    pid,
    stdin,
    stdout,
    stderr,
    kill: vi.fn((signal: NodeJS.Signals) => {
      // Exit after shutdown arms its kill timer, as a real SIGTERM exit would.
      if (signal === 'SIGTERM') queueMicrotask(() => handlers['exit']?.(null, 'SIGTERM'));
      return true;
    }),
    on: vi.fn((event: string, cb: (...a: unknown[]) => void) => {
      handlers[event] = cb;
    }),
  };
  return child;
}

type ResumeIdentityState = { resumeAttemptId: string | null };

describe('SessionManager resume identity retirement (#3658)', () => {
  let mockChild: ReturnType<typeof makeMockChild>;
  let endedIdentities: Set<string>;
  let closeSessionLifecycle: ReturnType<typeof vi.fn>;
  let closeSessionLifecycleFailure: ReturnType<typeof vi.fn>;
  let updateExactSessionCheckpointStatus: ReturnType<typeof vi.fn>;
  let onCrash: ReturnType<typeof vi.fn>;
  let sm: SessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChild = makeMockChild();
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockChild);
    endedIdentities = new Set();
    closeSessionLifecycle = vi.fn((params: { providerSessionId: string | null; status: string }) => {
      if (params.status === 'ended' && params.providerSessionId !== null) {
        endedIdentities.add(params.providerSessionId);
      }
    });
    closeSessionLifecycleFailure = vi.fn();
    // Mirrors the lifecycle store: an ended checkpoint is no longer resumable.
    updateExactSessionCheckpointStatus = vi.fn((params: { providerSessionId: string }) => {
      if (endedIdentities.has(params.providerSessionId)) throw new Error(NOT_RESUMABLE);
      return 1;
    });
    onCrash = vi.fn();
    sm = new SessionManager({
      db: makeDb(),
      messenger: makeMessenger(),
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      onCrash,
    });
    let nextFreshRowId = 50;
    sm.setDurability({
      upsertSessionCheckpoint: vi.fn(),
      beginFreshSessionLifecycle: vi.fn(() => nextFreshRowId++),
      reactivateSessionLifecycle: vi.fn(() => ROW_ID),
      closeSessionLifecycle,
      closeSessionLifecycleFailure,
      updateExactSessionCheckpointStatus,
    } as unknown as Parameters<typeof sm.setDurability>[0]);
  });

  afterEach(() => vi.restoreAllMocks());

  it('an intentional end through the child-exit branch leaves no stale identity for the next shutdown', async () => {
    await sm.spawnSession(RESUME_ID, ROW_ID);

    await sm.shutdown(false);

    // The exit landed on the intentional-kill branch, not the crash path.
    expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');
    expect(closeSessionLifecycle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      agentSessionRowId: ROW_ID,
      providerSessionId: RESUME_ID,
      conversationKey: CONVERSATION_KEY,
      status: 'ended',
    }));
    expect(closeSessionLifecycleFailure).not.toHaveBeenCalled();
    expect(onCrash).not.toHaveBeenCalled();
    expect((sm as unknown as ResumeIdentityState).resumeAttemptId).toBeNull();

    // The resident manager's next pre-spawn shutdown.
    await expect(sm.shutdown()).resolves.toBeUndefined();
    expect(updateExactSessionCheckpointStatus).not.toHaveBeenCalled();
  });

  it('keeps the attempted identity across the intentional exit so a failed close can be retried', async () => {
    await sm.spawnSession(RESUME_ID, ROW_ID);
    closeSessionLifecycle.mockImplementationOnce(() => {
      throw new Error('fixture lifecycle close failed');
    });

    await expect(sm.shutdown(false)).rejects.toThrow('fixture lifecycle close failed');
    expect(closeSessionLifecycleFailure).not.toHaveBeenCalled();
    expect(onCrash).not.toHaveBeenCalled();

    // No init arrived, so only the attempted resume identity names the session.
    await sm.shutdown(false);
    expect(closeSessionLifecycle).toHaveBeenCalledTimes(2);
    expect(closeSessionLifecycle).toHaveBeenLastCalledWith(expect.objectContaining({
      agentSessionRowId: ROW_ID,
      providerSessionId: RESUME_ID,
      status: 'ended',
    }));
    expect((sm as unknown as ResumeIdentityState).resumeAttemptId).toBeNull();
  });

  it('retiring an unclosed resumed generation clears its attempted resume identity', async () => {
    await sm.spawnSession(RESUME_ID, ROW_ID);
    closeSessionLifecycle.mockImplementationOnce(() => {
      throw new Error('fixture lifecycle close failed');
    });
    await expect(sm.shutdown(false)).rejects.toThrow('fixture lifecycle close failed');
    expect((sm as unknown as ResumeIdentityState).resumeAttemptId).toBe(RESUME_ID);

    sm.retireUnclosedGeneration();

    expect((sm as unknown as ResumeIdentityState).resumeAttemptId).toBeNull();
    expect(sm.getDbRowId()).toBeNull();
    // A later shutdown owns nothing, so it cannot reach the exact-status update.
    await expect(sm.shutdown()).resolves.toBeUndefined();
    expect(updateExactSessionCheckpointStatus).not.toHaveBeenCalled();
  });

  it('retiring an unclosed generation leaves the provider turn lane as it was', async () => {
    await sm.spawnSession();
    (sm as unknown as { providerTurnInFlight: boolean }).providerTurnInFlight = true;

    sm.retireUnclosedGeneration();

    // Only a fully successful teardown may reopen a lane.
    expect(sm.getStatus().turnInFlight).toBe(true);
  });

  it('a fresh spawn after a failed close never attributes a pre-init crash to the old provider session', async () => {
    await sm.spawnSession();
    // The old generation's init named its provider session.
    (sm as unknown as { sessionId: string | null }).sessionId = 'old-provider-session';
    closeSessionLifecycle.mockImplementationOnce(() => {
      throw new Error('fixture lifecycle close failed');
    });
    await expect(sm.shutdown()).rejects.toThrow('fixture lifecycle close failed');

    // The failed close skipped the shutdown tail; the fallback spawns fresh.
    const freshChild = makeMockChild(9320);
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(freshChild);
    await sm.spawnSession();
    freshChild.on.mock.calls.find(([event]) => event === 'exit')?.[1](1, null);

    expect(closeSessionLifecycleFailure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      agentSessionRowId: 51,
      providerSessionId: null,
    }));
  });
});
