// tests/runtimes/agent/session-residual-branches.test.ts
//
// Coverage-ratchet (big-module pass): targets residual UNCOVERED branches in
// src/runtimes/agent/session.ts that the existing suites
// (session.test.ts, session-turn-error-branches.test.ts,
// session-provider-switches.test.ts, session-checkpoints.test.ts, …) leave
// behind. Every branch here is REACHABLE; genuinely-dead defensive branches are
// NOT faked (see the residual notes at the bottom of this file).
//
// Branch groups covered:
//   * buildSystemPrompt display-name fallback `?? this.provider`  — src ~625.
//     PROVIDER_DISPLAY_NAMES has all 6 known providers, but buildSystemPrompt
//     does NOT route through assertKnownProvider, so an off-catalog provider id
//     (bypassing the config validator, as direct instantiation can) hits the
//     nullish fallback.
//   * managed-provider turn `model` true branch `{ model: this.model }` — ~1617.
//     Existing managed tests omit the `model` constructor opt (false branch);
//     this drives a managed turn WITH a model set.
//   * crashManagedProviderSession durability + non-Error/undefined err branches
//     — ~1559 (durability true) and ~1564 (`err === undefined` middle branch).
//   * persistent claude-cli stderr 'data' no-change short-circuit `nextPreview
//     === this.crashStderrPreview` — ~1289 (whitespace-only chunk sanitizes to
//     empty, leaving the preview unchanged).
//   * persistent exit superseded-child race guard `this.child !== child` — ~1308.
//   * persistent exit buffered-stdout drain `bufferedLines.length > 0` — ~1320.
//   * spawnSession already-active short-circuit `active && (child||managed)` — ~935.
//
// Harness mirrors session.test.ts / session-turn-error-branches.test.ts: the
// SessionManager is a long-running subprocess supervisor, so node:child_process,
// node:os, node:fs, the logger, and session-db are mocked at the module boundary
// and the child's exit/stderr handlers are driven directly. Real provider classes
// (OpenAIApiProvider) are used with a stubbed global fetch, matching the canonical
// managed-provider tests.
// Repo-hygiene reserved IDs only.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('../../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

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

vi.mock('../../../src/runtimes/agent/session-db.ts', () => ({
  createSession: vi.fn(() => 42),
  incrementMessageCount: vi.fn(),
  updateSessionId: vi.fn(),
  updateSessionStatus: vi.fn(),
  updateTranscriptPath: vi.fn(),
  backfillSessionProvider: vi.fn(),
}));

import { spawn } from 'node:child_process';
import { SessionManager } from '../../../src/runtimes/agent/session.ts';
import { OpenAIApiProvider } from '../../../src/runtimes/agent/providers/openai-api.ts';
import { incrementMessageCount } from '../../../src/runtimes/agent/session-db.ts';
import type { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';
import type { AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';

const CHAT_JID = '1555000099@s.whatsapp.net';

function makeDb(): Database {
  return {
    raw: {
      prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn() })),
      exec: vi.fn(),
    },
  } as unknown as Database;
}

function makeMessenger(): { messenger: Messenger; sent: Array<{ jid: string; text: string }> } {
  const sent: Array<{ jid: string; text: string }> = [];
  const messenger: Messenger = {
    sendMessage: vi.fn(async (jid: string, text: string) => {
      sent.push({ jid, text });
      return { waMessageId: null };
    }),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
  };
  return { messenger, sent };
}

/** Persistent (claude-cli) mock child whose exit/stderr handlers tests can drive. */
function makeMockChild(pid = 9100) {
  const handlers: Record<string, (...a: unknown[]) => void> = {};
  const stdin = new EventEmitter() as EventEmitter & {
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  (stdin as unknown as { write: ReturnType<typeof vi.fn> }).write = vi.fn(
    (_d: unknown, _e?: unknown, cb?: (err?: Error | null) => void) => {
      if (typeof _e === 'function') (_e as (err?: Error | null) => void)();
      else if (typeof cb === 'function') cb();
      return true;
    },
  );
  (stdin as unknown as { end: ReturnType<typeof vi.fn> }).end = vi.fn();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = {
    pid,
    stdin,
    stdout,
    stderr,
    kill: vi.fn(),
    on: vi.fn((event: string, cb: (...a: unknown[]) => void) => {
      handlers[event] = cb;
    }),
    emitExit(code: number | null, signal: NodeJS.Signals | null = null) {
      handlers['exit']?.(code, signal);
    },
  };
  return child;
}
type MockChild = ReturnType<typeof makeMockChild>;

// NOTE: buildSystemPrompt's `PROVIDER_DISPLAY_NAMES[this.provider] ?? this.provider`
// fallback (~625) is DEAD: the SessionManager constructor fail-fasts on any
// provider id that is not a valid ProviderId (#447), and every ProviderId is a
// key in PROVIDER_DISPLAY_NAMES, so the lookup can never miss. Documented as a
// dead residual; not faked.

// ════════════════════════════════════════════════════════════════════════════
// managed-provider turn — `model` present branch `{ model: this.model }`
// ════════════════════════════════════════════════════════════════════════════

function makeSseResponse(events: Array<Record<string, unknown> | string>): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const ev of events) {
        const payload = typeof ev === 'string' ? ev : JSON.stringify(ev);
        controller.enqueue(enc.encode(`data: ${payload}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('managed-provider turn — model option threading', () => {
  afterEach(() => vi.restoreAllMocks());

  it('includes { model } in the managed sendTurn payload when a model is configured', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const events: AgentEvent[] = [];
    const fetchMock = vi.fn().mockResolvedValue(
      makeSseResponse([
        { choices: [{ delta: { content: 'ok' } }] },
        { usage: { prompt_tokens: 3, completion_tokens: 1 } },
        '[DONE]',
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);
    const sendTurnSpy = vi.spyOn(OpenAIApiProvider.prototype, 'sendTurn');

    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: (e) => events.push(e),
      provider: 'openai-api',
      // The constructor `model` opt (distinct from providerConfig.model) is what
      // feeds `this.model` and therefore the `... (this.model ? { model } : {})`
      // spread inside the managed turn.
      model: 'gpt-residual-model',
      providerConfig: { baseUrl: 'https://api.test.invalid/v1', model: 'cfg-model' },
    });

    await sm.spawnSession();
    await sm.sendTurn('drive a managed turn with a model');

    expect(sendTurnSpy).toHaveBeenCalledTimes(1);
    expect(sendTurnSpy.mock.calls[0]?.[0]).toMatchObject({
      role: 'user',
      model: 'gpt-residual-model',
      parts: [{ kind: 'text', text: 'drive a managed turn with a model' }],
    });
    expect(incrementMessageCount).toHaveBeenCalledWith(db, 42);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// crashManagedProviderSession — durability set + non-Error err branches
// ════════════════════════════════════════════════════════════════════════════

describe('crashManagedProviderSession error/durability branches', () => {
  afterEach(() => vi.restoreAllMocks());

  it('orphans the exact managed-provider checkpoint and stringifies a non-Error rejection', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const upsertSessionCheckpoint = vi.fn();
    const updateSessionCheckpointsStatusBySessionId = vi.fn(() => 1);
    const onCrash = vi.fn();
    // Reject with a NON-Error value so `err instanceof Error` is false and the
    // `err === undefined ? undefined : String(err)` else-branch runs (String).
    vi.spyOn(OpenAIApiProvider.prototype, 'sendTurn').mockRejectedValue('string-failure');
    vi.stubGlobal('fetch', vi.fn());

    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      provider: 'openai-api',
      onCrash,
    });
    sm.setDurability({
      beginFreshSessionCheckpoint: vi.fn(),
      upsertSessionCheckpoint,
      updateSessionCheckpointsStatusBySessionId,
    } as unknown as Parameters<typeof sm.setDurability>[0]);

    await sm.spawnSession();
    updateSessionCheckpointsStatusBySessionId.mockClear();
    await expect(sm.sendTurn('boom')).rejects.toBe('string-failure');

    expect(updateSessionCheckpointsStatusBySessionId).toHaveBeenCalledWith(
      expect.stringMatching(/^openai-api-/),
      'orphaned',
    );
    expect(onCrash).toHaveBeenCalledWith(
      expect.objectContaining({ exitCode: null, signal: null, dbRowId: 42 }),
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// persistent (claude-cli) exit + stderr handler branches
// ════════════════════════════════════════════════════════════════════════════

describe('persistent claude-cli exit/stderr residual branches', () => {
  let mockChild: MockChild;
  beforeEach(() => {
    vi.clearAllMocks();
    mockChild = makeMockChild();
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockChild);
  });
  afterEach(() => vi.restoreAllMocks());

  it('stderr chunk that sanitizes to empty leaves the preview unchanged (no-change short-circuit)', async () => {
    const sm = new SessionManager({
      db: makeDb(),
      messenger: makeMessenger().messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
    });
    await sm.spawnSession();
    // Whitespace-only stderr → appendProviderCrashPreview returns the existing
    // (empty) preview unchanged → `nextPreview === this.crashStderrPreview` true.
    mockChild.stderr.emit('data', Buffer.from('   \n\t  '));
    expect((sm as unknown as { crashStderrPreview: string }).crashStderrPreview).toBe('');
  });

  it('ignores an exit event from a superseded child (this.child !== child guard)', async () => {
    const upsertSessionCheckpoint = vi.fn();
    const sm = new SessionManager({
      db: makeDb(),
      messenger: makeMessenger().messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
    });
    sm.setDurability({
      beginFreshSessionCheckpoint: vi.fn(),
      upsertSessionCheckpoint,
    } as unknown as Parameters<typeof sm.setDurability>[0]);
    await sm.spawnSession();
    const firstChild = mockChild;

    // Supersede the first child with a second spawn (simulates /new spawning P2).
    const secondChild = makeMockChild(9200);
    (sm as unknown as { child: MockChild }).child = secondChild;

    // Ignore the spawn-time 'active' checkpoint; we only assert about the exit path.
    upsertSessionCheckpoint.mockClear();

    // P1's delayed exit now fires against P2's active state — must be ignored:
    // no crash checkpoint, P2 stays the active child.
    firstChild.emitExit(1, null);
    expect(upsertSessionCheckpoint).not.toHaveBeenCalled();
    expect((sm as unknown as { child: MockChild }).child).toBe(secondChild);
    expect((sm as unknown as { active: boolean }).active).toBe(true);
  });

  it('orphans the exact attempted checkpoint on a resume-failure exit', async () => {
    // --resume + exit code 1 + no init event = resume failure; with durability
    // set this drives the `if (this.durability)` branch inside the isResumeFail
    // arm (distinct from the non-resume crash arm covered by the drain test).
    const upsertSessionCheckpoint = vi.fn();
    const updateSessionCheckpointsStatusBySessionId = vi.fn(() => 1);
    const onResumeFailed = vi.fn();
    const sm = new SessionManager({
      db: makeDb(),
      messenger: makeMessenger().messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      onResumeFailed,
    });
    sm.setDurability({
      upsertSessionCheckpoint,
      updateSessionCheckpointsStatusBySessionId,
    } as unknown as Parameters<typeof sm.setDurability>[0]);
    await sm.spawnSession('expired-session-id');
    upsertSessionCheckpoint.mockClear(); // drop the spawn-time 'active' checkpoint
    updateSessionCheckpointsStatusBySessionId.mockClear();

    mockChild.emitExit(1, null); // resume attempt, code 1, init never received
    expect(onResumeFailed).toHaveBeenCalledTimes(1);
    expect(updateSessionCheckpointsStatusBySessionId).toHaveBeenCalledWith(
      'expired-session-id',
      'orphaned',
    );
  });

  it('drains buffered (non-newline-terminated) stdout before crash processing on exit', async () => {
    const events: AgentEvent[] = [];
    const sm = new SessionManager({
      db: makeDb(),
      messenger: makeMessenger().messenger,
      chatJid: CHAT_JID,
      onEvent: (e) => events.push(e),
    });
    await sm.spawnSession();

    // A complete Claude stream-json result line WITHOUT a trailing newline, so it
    // stays buffered and is only drained by the exit handler (bufferedLines > 0).
    const resultLine = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'final buffered output',
      session_id: 'sess-buffered',
    });
    mockChild.stdout.emit('data', Buffer.from(resultLine)); // no '\n'
    mockChild.emitExit(1, null);

    expect(events.some((e) => e.type === 'result')).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// spawnSession — already-active short-circuit
// ════════════════════════════════════════════════════════════════════════════

describe('spawnSession already-active short-circuit', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('returns early without re-spawning when a child is already active', async () => {
    const child = makeMockChild();
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(child);
    const sm = new SessionManager({
      db: makeDb(),
      messenger: makeMessenger().messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
    });
    await sm.spawnSession();
    expect(spawn).toHaveBeenCalledTimes(1);

    // Second call short-circuits on `active && this.child !== null`.
    await sm.spawnSession();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('returns early without re-initializing when a managed provider session is already active', async () => {
    // Exercises the second operand of `child !== null || managedProviderSession
    // !== null`: a managed-loop provider has no child, so the short-circuit must
    // fall through to the managedProviderSession check.
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const ctor = vi.spyOn(OpenAIApiProvider.prototype, 'sendTurn');
    const sm = new SessionManager({
      db: makeDb(),
      messenger: makeMessenger().messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      provider: 'openai-api',
      providerConfig: { baseUrl: 'https://api.test.invalid/v1', model: 'm' },
    });
    await sm.spawnSession();
    const firstSessionId = sm.getStatus().sessionId;
    expect(firstSessionId).toMatch(/^openai-api-[0-9a-f-]{36}$/);

    // Second spawn must short-circuit (active && managedProviderSession !== null):
    // the session id is unchanged and no spawn/turn happened.
    await sm.spawnSession();
    expect(sm.getStatus().sessionId).toBe(firstSessionId);
    expect(spawn).not.toHaveBeenCalled();
    expect(ctor).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

// ─── Residual branches intentionally left UNCOVERED (dead/defensive) ──────────
// These were inspected and are unreachable without forging impossible inputs:
//   * default: assertNeverProvider(...) arms in resolveProviderBinary/Args/Parser
//     and createManagedProviderSession (src ~217,251,381,401,608) — TS-exhaustive
//     guards on ProviderId; the test handle + assertKnownProvider validate with
//     isProviderId first, so no real call reaches the default.
//   * assertKnownProvider `!isProviderId` throw (~677) — defense-in-depth; the
//     config validator blocks unknown ids at load time.
//   * stderr-preview empty guard `if (!this.crashStderrPreview) return` (~1291,
//     ~1729) — appendProviderCrashPreview only returns the (possibly empty)
//     `existing` unchanged OR a non-empty trimmed string, so the
//     `nextPreview !== existing && !nextPreview` combination is impossible.
//   * empty-system-prompt throw (~659) — the transport prelude always contributes
//     non-empty content, so composeWithExactLineDedup can never return ''.
//   * SIGKILL escalation + its catch (~1963/1965) and the various 15s capture
//     timeouts / codex thread-resume retry params (~1167,1260,1804,1837) require
//     persistent codex/gemini timer harnesses; deferred (harness cost) — they are
//     reachable in principle but out of scope for this pure/handler-branch pass.
