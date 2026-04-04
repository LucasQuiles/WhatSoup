import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';
import type { AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';

// ─── Mocks ────────────────────────────────────────────────────────────────────

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

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}));

vi.mock('../../../src/runtimes/agent/session-db.ts', () => ({
  createSession: vi.fn(() => 42),
  incrementMessageCount: vi.fn(),
  updateSessionId: vi.fn(),
  updateSessionStatus: vi.fn(),
  updateTranscriptPath: vi.fn(),
}));

const { spawn } = await import('node:child_process');
import { SessionManager } from '../../../src/runtimes/agent/session.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMockChild(pid = 12345) {
  const stdin = new EventEmitter() as EventEmitter & {
    write: ReturnType<typeof vi.fn>;
  };
  (stdin as unknown as { write: ReturnType<typeof vi.fn> }).write = vi.fn(
    (_data: unknown, _enc?: unknown, cb?: (err?: Error | null) => void) => {
      if (typeof _enc === 'function') (_enc as (err?: Error | null) => void)();
      else if (typeof cb === 'function') cb();
    },
  );

  const stdout = new EventEmitter();
  const stderr = new EventEmitter();

  const killFn = vi.fn();
  const onFn = vi.fn((event: string, cb: (...args: unknown[]) => void) => {
    if (event === 'exit') {
      (child as unknown as { _exitCb: (...args: unknown[]) => void })._exitCb = cb;
    }
  });

  const child = {
    pid,
    stdin,
    stdout,
    stderr,
    kill: killFn,
    on: onFn,
    _exitCb: null as ((...args: unknown[]) => void) | null,
  };

  return child;
}

function makeDb(): Database {
  return {
    raw: {
      prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn() })),
      exec: vi.fn(),
    },
  } as unknown as Database;
}

function makeMessenger(): Messenger {
  return {
    sendMessage: vi.fn(async () => ({ waMessageId: null })),
  };
}

const CHAT_JID = 'test@s.whatsapp.net';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SessionManager budget integration', () => {
  let mockChild: ReturnType<typeof makeMockChild>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChild = makeMockChild(12345);
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockChild);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('when budget is exceeded, sendTurn returns early with a throttle message', async () => {
    const events: AgentEvent[] = [];
    const sm = new SessionManager({
      db: makeDb(),
      messenger: makeMessenger(),
      chatJid: CHAT_JID,
      onEvent: (e) => events.push(e),
      providerConfig: {
        budget: { requestsPerMinute: 2 },
      },
    });

    await sm.spawnSession();

    // First two turns should go through (write to stdin)
    await sm.sendTurn('hello');
    await sm.sendTurn('world');

    // Simulate result events through stdout to trigger recordUsage
    const resultLine1 = JSON.stringify({
      type: 'result',
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    const resultLine2 = JSON.stringify({
      type: 'result',
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    mockChild.stdout.emit('data', Buffer.from(resultLine1 + '\n' + resultLine2 + '\n'));

    // Clear events from the result emissions
    events.length = 0;

    // Third turn should be throttled
    await sm.sendTurn('throttled');

    // Should have emitted a result event with throttle text
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('result');
    if (events[0].type === 'result') {
      expect(events[0].text).toContain('Throttled');
      expect(events[0].text).toContain('req/min');
    }
  });

  it('recordUsage is called on result events with token data', async () => {
    const events: AgentEvent[] = [];
    const sm = new SessionManager({
      db: makeDb(),
      messenger: makeMessenger(),
      chatJid: CHAT_JID,
      onEvent: (e) => events.push(e),
      providerConfig: {
        budget: { requestsPerMinute: 100, tokensPerMinute: 500 },
      },
    });

    await sm.spawnSession();

    // Emit a result event with token counts via stdout
    const resultLine = JSON.stringify({
      type: 'result',
      usage: { input_tokens: 300, output_tokens: 300 },
    });
    mockChild.stdout.emit('data', Buffer.from(resultLine + '\n'));

    // Now the budget should have recorded 600 tokens (300+300),
    // which exceeds the 500 tokensPerMinute limit.
    events.length = 0;

    await sm.sendTurn('should be throttled');

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('result');
    if (events[0].type === 'result') {
      expect(events[0].text).toContain('Throttled');
      expect(events[0].text).toContain('tokens/min');
    }
  });

  it('with no budget config, behavior is unchanged (backward compatible)', async () => {
    const events: AgentEvent[] = [];
    const sm = new SessionManager({
      db: makeDb(),
      messenger: makeMessenger(),
      chatJid: CHAT_JID,
      onEvent: (e) => events.push(e),
      // No providerConfig at all
    });

    await sm.spawnSession();

    // Should not throw or throttle
    await sm.sendTurn('hello');
    await sm.sendTurn('world');
    await sm.sendTurn('third');

    // stdin.write should have been called 3 times (once per turn)
    expect(mockChild.stdin.write).toHaveBeenCalledTimes(3);

    // No throttle events should have been emitted
    const throttleEvents = events.filter(
      (e) => e.type === 'result' && e.text?.includes('Throttled'),
    );
    expect(throttleEvents).toHaveLength(0);
  });

  it('with providerConfig but no budget key, behavior is unchanged', async () => {
    const events: AgentEvent[] = [];
    const sm = new SessionManager({
      db: makeDb(),
      messenger: makeMessenger(),
      chatJid: CHAT_JID,
      onEvent: (e) => events.push(e),
      providerConfig: { someOtherKey: 'value' },
    });

    await sm.spawnSession();

    await sm.sendTurn('hello');
    await sm.sendTurn('world');

    expect(mockChild.stdin.write).toHaveBeenCalledTimes(2);

    const throttleEvents = events.filter(
      (e) => e.type === 'result' && e.text?.includes('Throttled'),
    );
    expect(throttleEvents).toHaveLength(0);
  });
});
