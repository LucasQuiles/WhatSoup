/**
 * Tool-call turn correlation must not depend on capability-obligation replay.
 *
 * Every tool_calls row carries the logical turn and inbound sequence that owned
 * the call when the registry wrote it. The registry gets those from a resolver
 * the runtime installs. When that resolver was installed only by replay
 * activation, a runtime without replay options wrote every row with no owner,
 * and tool failures could not be joined to the turns that caused them.
 *
 * Harness: a real AgentRuntime, a real migrated database and DurabilityEngine,
 * the runtime's own ToolRegistry and session-token registry, and the real
 * in-process provider bridge or a real socket server. The turn contexts are
 * placed in the runtime's live maps by the harness instead of by intake. Every
 * call goes through the bridge or a socket, so it carries caller attribution as
 * production calls do.
 *
 * Unowned stays unowned: a call with no single live head for its conversation,
 * a call from outside the turn, and every shared or single-scope call (not yet
 * correlated) keep NULL rather than a guessed turn.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createConnection } from 'node:net';
import { z } from 'zod';

import { config } from '../../../src/config.ts';
import { Database } from '../../../src/core/database.ts';
import { DurabilityEngine } from '../../../src/core/durability.ts';
import { SESSION_TOKEN_NOTIFICATION, type SessionTokenRegistry } from '../../../src/mcp/caller-attribution.ts';
import type { ToolRegistry } from '../../../src/mcp/registry.ts';
import { WhatSoupSocketServer } from '../../../src/mcp/socket-server.ts';
import {
  resolveSessionContext,
  type ExecutingSessionContext,
  type SessionContext,
} from '../../../src/mcp/types.ts';
import { createProviderMcpBridge } from '../../../src/runtimes/agent/providers/mcp-bridge.ts';
import type { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import type { SessionScope } from '../../../src/runtimes/agent/runtime-options.ts';
import type { RuntimeTurnContext } from '../../../src/runtimes/agent/runtime-turn-context.ts';
import { makeSocketPath } from '../../helpers/socket-rpc.ts';
import { waitForSocket } from '../../helpers/wait-for.ts';
import { context, makeRuntimeState, type RuntimeState } from './lib/runtime-terminal-coordinator-harness.ts';

// Fictional numbers only (555-01xx).
const KEY_A = '15550100201';
const JID_A = `${KEY_A}@s.whatsapp.net`;
// The resolver keys on the turn's conversation key, never on the map key, so an opaque alias key suffices.
const LID_A = 'alias-target-a@lid';
const KEY_B = '15550100202';
const JID_B = `${KEY_B}@s.whatsapp.net`;
const KEY_C = '15550100203';
const JID_C = `${KEY_C}@s.whatsapp.net`;
const SENDER_JID = '15550100299@s.whatsapp.net';
const PROBE_TOOL = 'turn_correlation_probe';

/** Private runtime surface this suite reads and seeds. */
interface CorrelationRuntimeState extends RuntimeState {
  registry: ToolRegistry;
  sessionTokens: SessionTokenRegistry;
  capabilityObligationRuntime: unknown;
}

interface CorrelationRow {
  tool_name: string;
  logical_turn_id: string | null;
  source_inbound_seq: number | null;
  caller_token_result: string | null;
  caller_turn_owned: number | null;
  caller_actor_source: string | null;
}

function rows(db: Database): CorrelationRow[] {
  return db.raw.prepare(
    `SELECT tool_name, logical_turn_id, source_inbound_seq, caller_token_result,
            caller_turn_owned, caller_actor_source
       FROM tool_calls ORDER BY id`,
  ).all() as unknown as CorrelationRow[];
}

/** The row an in-process call writes, with the given owner (or none). */
function inProcessRow(owner: { turn: string; seq: number } | null): CorrelationRow {
  return {
    tool_name: PROBE_TOOL,
    logical_turn_id: owner?.turn ?? null,
    source_inbound_seq: owner?.seq ?? null,
    caller_token_result: 'not_applicable',
    caller_turn_owned: 1,
    caller_actor_source: 'executing_turn',
  };
}

function registerProbe(registry: ToolRegistry): void {
  registry.register({
    name: PROBE_TOOL,
    description: 'Read-only probe for tool-call turn correlation',
    scope: 'chat',
    targetMode: 'caller-supplied',
    schema: z.object({}),
    externalEffect: { version: 1, kind: 'none' },
    handler: async () => ({ ok: true }),
  });
}

/** What the per-chat socket's executing resolver hands every request during a turn. */
function executingFor(conversationKey: string | undefined): ExecutingSessionContext {
  return { actorJid: SENDER_JID, purpose: undefined, conversationKey };
}

function chatSession(conversationKey: string, deliveryJid: string): SessionContext {
  return { tier: 'chat-scoped', conversationKey, deliveryJid };
}

/** Exchange JSON-RPC lines on one connection; one response per request id. */
function exchange(socketPath: string, lines: unknown[]): Promise<Map<number, unknown>> {
  const expected = lines.filter((line) => (line as { id?: unknown }).id !== undefined).length;
  return new Promise((resolve, reject) => {
    const responses = new Map<number, unknown>();
    const client = createConnection(socketPath, () => {
      for (const line of lines) client.write(JSON.stringify(line) + '\n');
    });
    let buf = '';
    client.setEncoding('utf8');
    client.on('data', (chunk: string) => {
      buf += chunk;
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      for (const part of parts) {
        if (!part.trim()) continue;
        const parsed = JSON.parse(part) as { id: number };
        responses.set(parsed.id, parsed);
      }
      if (responses.size === expected) {
        client.end();
        resolve(responses);
      }
    });
    client.on('error', reject);
    setTimeout(() => reject(new Error('timeout')), 3000).unref();
  });
}

const callProbe = (id: number) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name: PROBE_TOOL, arguments: {} },
});

const presentToken = (token: string) => ({
  jsonrpc: '2.0',
  method: SESSION_TOKEN_NOTIFICATION,
  params: { token },
});

describe('tool-call turn correlation without capability replay', () => {
  let db: Database;
  let durability: DurabilityEngine;
  let runtime: AgentRuntime | undefined;
  let state: CorrelationRuntimeState | undefined;
  let server: WhatSoupSocketServer | undefined;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
    durability = new DurabilityEngine(db);
  });

  afterEach(async () => {
    server?.stop();
    server = undefined;
    if (state) {
      state.perChatRuntimeTurnContexts.clear();
      state.currentRuntimeTurnContext = null;
    }
    await runtime?.shutdown().catch(() => {});
    runtime = undefined;
    state = undefined;
    db.close();
  });

  /**
   * A runtime of the given scope with the probe registered. `durabilityVia`
   * 'registry' gives the registry its engine directly, so no supervisor starts;
   * 'runtime' takes the production order (main calls runtime.setDurability).
   */
  function buildRuntime(sessionScope: SessionScope, durabilityVia: 'registry' | 'runtime' = 'registry'): CorrelationRuntimeState {
    const built = makeRuntimeState<CorrelationRuntimeState>(db, { sessionScope });
    runtime = built.runtime;
    state = built.state;
    registerProbe(state.registry);
    if (durabilityVia === 'runtime') built.runtime.setDurability(durability);
    else state.registry.setDurability(durability);
    return state;
  }

  /** Journal an inbound and build its live per-chat turn context. */
  function perChatTurn(conversationKey: string, logicalTurnId: string): { ctx: RuntimeTurnContext; seq: number } {
    const seq = durability.journalInbound(`wamid-${logicalTurnId}`, conversationKey, `${conversationKey}@s.whatsapp.net`, 'agent');
    return { ctx: context('per_chat', conversationKey, seq, logicalTurnId), seq };
  }

  async function callInProcess(
    target: CorrelationRuntimeState,
    session: SessionContext,
    executing: ExecutingSessionContext,
  ): Promise<void> {
    const bridge = createProviderMcpBridge(target.registry, session, () => executing);
    const result = await bridge.executeTool(PROBE_TOOL, {});
    expect(result.isError).toBe(false);
  }

  async function startPerChatSocket(target: CorrelationRuntimeState, conversationKey: string): Promise<string> {
    const socketPath = makeSocketPath();
    server = new WhatSoupSocketServer(
      socketPath,
      target.registry,
      { tier: 'global', conversationKey },
      () => executingFor(conversationKey),
      undefined,
      { sessionTokens: target.sessionTokens },
    );
    server.start();
    await waitForSocket(socketPath);
    return socketPath;
  }

  it('stamps an in-process turn-owned call with the owning turn and its inbound seq', async () => {
    const live = buildRuntime('per_chat');
    const { ctx, seq } = perChatTurn(KEY_A, 'lt-owned');
    live.perChatRuntimeTurnContexts.set(JID_A, [ctx]);

    await callInProcess(live, chatSession(KEY_A, JID_A), executingFor(KEY_A));

    expect(rows(db)).toEqual([inProcessRow({ turn: 'lt-owned', seq })]);
  });

  it('stamps a per-chat socket call that presented its session token with the owning turn', async () => {
    const live = buildRuntime('per_chat');
    const { ctx, seq } = perChatTurn(KEY_A, 'lt-socket');
    live.perChatRuntimeTurnContexts.set(JID_A, [ctx]);
    const socketPath = await startPerChatSocket(live, KEY_A);

    const responses = await exchange(socketPath, [presentToken(live.sessionTokens.mint()), callProbe(1)]);

    expect(responses.get(1)).toMatchObject({ id: 1, result: { content: [{ type: 'text' }] } });
    expect(rows(db)).toEqual([{
      tool_name: PROBE_TOOL,
      logical_turn_id: 'lt-socket',
      source_inbound_seq: seq,
      caller_token_result: 'match',
      caller_turn_owned: 1,
      caller_actor_source: 'executing_turn',
    }]);
  });

  it('stamps the call after the production setDurability order', async () => {
    const live = buildRuntime('per_chat', 'runtime');
    const { ctx, seq } = perChatTurn(KEY_A, 'lt-production-order');
    live.perChatRuntimeTurnContexts.set(JID_A, [ctx]);

    await callInProcess(live, chatSession(KEY_A, JID_A), executingFor(KEY_A));

    expect(rows(db)).toEqual([inProcessRow({ turn: 'lt-production-order', seq })]);
  });

  it('setDurability without replay options activates no obligation runtime and registers no execute_capability', () => {
    const live = buildRuntime('per_chat', 'runtime');

    // The environment this suite runs in has no replay options, which is the case under test.
    expect({ options: config.capabilityObligations ?? null, obligationRuntime: live.capabilityObligationRuntime })
      .toEqual({ options: null, obligationRuntime: null });
    const listed = live.registry
      .listTools(resolveSessionContext(chatSession(KEY_A, JID_A), executingFor(KEY_A)))
      .map((tool) => tool.name)
      .filter((name) => name === PROBE_TOOL || name === 'execute_capability');
    expect(listed).toEqual([PROBE_TOOL]);
  });

  it('concurrent owners: each conversation\'s call carries its own live head', async () => {
    const live = buildRuntime('per_chat');
    const a = perChatTurn(KEY_A, 'lt-a');
    const b = perChatTurn(KEY_B, 'lt-b');
    live.perChatRuntimeTurnContexts.set(JID_A, [a.ctx]);
    live.perChatRuntimeTurnContexts.set(JID_B, [b.ctx]);

    await callInProcess(live, chatSession(KEY_A, JID_A), executingFor(KEY_A));
    await callInProcess(live, chatSession(KEY_B, JID_B), executingFor(KEY_B));
    await callInProcess(live, chatSession(KEY_A, JID_A), executingFor(KEY_A));

    expect(rows(db)).toEqual([
      inProcessRow({ turn: 'lt-a', seq: a.seq }),
      inProcessRow({ turn: 'lt-b', seq: b.seq }),
      inProcessRow({ turn: 'lt-a', seq: a.seq }),
    ]);
  });

  it('a queued second turn does not own calls until it becomes the head', async () => {
    const live = buildRuntime('per_chat');
    const first = perChatTurn(KEY_A, 'lt-a1');
    const queued = perChatTurn(KEY_A, 'lt-a2');
    live.perChatRuntimeTurnContexts.set(JID_A, [first.ctx, queued.ctx]);

    await callInProcess(live, chatSession(KEY_A, JID_A), executingFor(KEY_A));
    // The first turn retires; the queued one is now the head.
    live.perChatRuntimeTurnContexts.set(JID_A, [queued.ctx]);
    await callInProcess(live, chatSession(KEY_A, JID_A), executingFor(KEY_A));

    expect(rows(db)).toEqual([
      inProcessRow({ turn: 'lt-a1', seq: first.seq }),
      inProcessRow({ turn: 'lt-a2', seq: queued.seq }),
    ]);
  });

  it('two heads with one conversation key (alias transition) leave the call unowned', async () => {
    const live = buildRuntime('per_chat');
    const stale = perChatTurn(KEY_A, 'lt-alias-stale');
    const current = perChatTurn(KEY_A, 'lt-alias-current');
    live.perChatRuntimeTurnContexts.set(LID_A, [stale.ctx]);
    live.perChatRuntimeTurnContexts.set(JID_A, [current.ctx]);

    await callInProcess(live, chatSession(KEY_A, JID_A), executingFor(KEY_A));

    expect(rows(db)).toEqual([inProcessRow(null)]);
  });

  it('after the alias rekey leaves one head, the call carries that head', async () => {
    const live = buildRuntime('per_chat');
    const turn = perChatTurn(KEY_A, 'lt-alias');
    live.perChatRuntimeTurnContexts.set(LID_A, [turn.ctx]);

    await callInProcess(live, chatSession(KEY_A, JID_A), executingFor(KEY_A));
    // The runtime's LID-to-phone rekey moves the list to the canonical map key.
    const moved = live.perChatRuntimeTurnContexts.get(LID_A)!;
    live.perChatRuntimeTurnContexts.delete(LID_A);
    live.perChatRuntimeTurnContexts.set(JID_A, moved);
    await callInProcess(live, chatSession(KEY_A, JID_A), executingFor(KEY_A));

    expect(rows(db)).toEqual([
      inProcessRow({ turn: 'lt-alias', seq: turn.seq }),
      inProcessRow({ turn: 'lt-alias', seq: turn.seq }),
    ]);
  });

  it('an outside socket caller without a session token is never stamped with the customer turn', async () => {
    const live = buildRuntime('per_chat');
    const { ctx } = perChatTurn(KEY_A, 'lt-customer');
    live.perChatRuntimeTurnContexts.set(JID_A, [ctx]);
    const socketPath = await startPerChatSocket(live, KEY_A);

    const responses = await exchange(socketPath, [callProbe(1)]);

    expect(responses.get(1)).toMatchObject({ id: 1, result: { content: [{ type: 'text' }] } });
    expect(rows(db)).toEqual([{
      tool_name: PROBE_TOOL,
      logical_turn_id: null,
      source_inbound_seq: null,
      caller_token_result: 'absent',
      caller_turn_owned: 0,
      caller_actor_source: 'executing_turn',
    }]);
  });

  it('a call with no chat key stays unowned while a chat turn is live', async () => {
    const live = buildRuntime('per_chat');
    const { ctx } = perChatTurn(KEY_A, 'lt-other-chat');
    live.perChatRuntimeTurnContexts.set(JID_A, [ctx]);

    // A global session with no executing conversation key records under the global key.
    await callInProcess(live, { tier: 'global' }, executingFor(undefined));

    expect(rows(db)).toEqual([inProcessRow(null)]);
  });

  it('a call keyed to a conversation with no live head stays unowned', async () => {
    const live = buildRuntime('per_chat');
    const { ctx } = perChatTurn(KEY_A, 'lt-only-head');
    live.perChatRuntimeTurnContexts.set(JID_A, [ctx]);

    await callInProcess(live, chatSession(KEY_C, JID_C), executingFor(KEY_C));

    expect(rows(db)).toEqual([inProcessRow(null)]);
  });

  it('a call after the live contexts are cleared stays unowned', async () => {
    const live = buildRuntime('per_chat');
    const { ctx } = perChatTurn(KEY_A, 'lt-cleared');
    live.perChatRuntimeTurnContexts.set(JID_A, [ctx]);
    live.perChatRuntimeTurnContexts.clear();

    await callInProcess(live, chatSession(KEY_A, JID_A), executingFor(KEY_A));

    expect(rows(db)).toEqual([inProcessRow(null)]);
  });

  it.each([
    ['shared', 'shared'],
    ['single', 'singleton'],
  ] as const)('a live %s-scope turn does not stamp a call keyed to its conversation (scope not yet correlated)', async (scope, contextScope) => {
    const live = buildRuntime(scope);
    const seq = durability.journalInbound(`wamid-lt-${scope}`, KEY_A, JID_A, 'agent');
    live.currentRuntimeTurnContext = context(contextScope, KEY_A, seq, `lt-${scope}`);

    // The global tool session takes the executing turn's key, as bindActiveGlobalMcpConversation pins it.
    await callInProcess(live, { tier: 'global' }, executingFor(KEY_A));

    expect(rows(db)).toEqual([inProcessRow(null)]);
  });
});
