import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('../../../src/logger.ts', async () => {
  const { loggerMock } = await import('../../helpers/logger-mock.ts');
  return loggerMock();
});

import { Database } from '../../../src/core/database.ts';
import {
  memoryHitTier,
  memoryIdentityFold,
  resolveMemoryScope,
  type InstanceIdentities,
  type MemoryScopeDeps,
} from '../../../src/core/memory-scope.ts';
import { classifyMemoryOperationFailure } from '../../../src/lib/memory-operation-telemetry.ts';
import { ToolRegistry } from '../../../src/mcp/registry.ts';
import type { SessionContext } from '../../../src/mcp/types.ts';
import {
  buildMemoryGuidance,
  memoryGuidanceSystemBlock,
  memoryUsable,
  type MemoryReadinessSnapshot,
} from '../../../src/runtimes/agent/memory-guidance.ts';

const CHAT_SESSION: SessionContext = { tier: 'chat-scoped', conversationKey: '15550002', deliveryJid: '15550002@s.whatsapp.net' };
const SHARED_SESSION: SessionContext = { tier: 'global' };
const MEMORY_INDEX = 'memory';
const READY: MemoryReadinessSnapshot = { state: 'ready', failureCode: 'none', evidenceCoverage: 'provider_response' };
const REACH = "Memories are saved to this chat. The bot's admins, and contacts they allow, can recall them from other chats, and an admin can do so even in a group with other people.";

/** A registry holding stand-ins for the named memory tools; knowledge_search accepts `searchIndexes`. */
function registryWith(tools: { memoryWrite?: boolean; searchIndexes?: [string, ...string[]] }): ToolRegistry {
  const registry = new ToolRegistry();
  if (tools.memoryWrite !== false) {
    registry.register({
      name: 'memory_write', description: 'stand-in', scope: 'chat', targetMode: 'injected',
      schema: z.object({ chatJid: z.string() }), handler: async () => ({ ok: true }),
    });
  }
  if (tools.searchIndexes) {
    registry.register({
      name: 'knowledge_search', description: 'stand-in', scope: 'chat', targetMode: 'caller-supplied',
      schema: z.object({ index: z.enum(tools.searchIndexes), query: z.string() }), handler: async () => ({ ok: true }),
    });
  }
  return registry;
}

function gate(overrides: Partial<Parameters<typeof memoryGuidanceSystemBlock>[0]> = {}): string | undefined {
  return memoryGuidanceSystemBlock({
    readiness: READY,
    registry: registryWith({ searchIndexes: [MEMORY_INDEX] }),
    session: CHAT_SESSION,
    instanceName: 'bot',
    memoryIndex: MEMORY_INDEX,
    allowedMcpTools: undefined,
    ...overrides,
  })?.();
}

describe('buildMemoryGuidance', () => {
  const text = buildMemoryGuidance({ operatorInstance: false, searchesMemory: true });

  it('says to save only what matters later, using only memory types the tool accepts', () => {
    expect(text).toContain('Save only what will matter in a later conversation: a lasting fact, plan or arrangement');
    expect(text).toContain('or anything the person asks you to remember');
    expect(text).toContain('do not save the same thing twice');
    const named = [...text.matchAll(/\b(user_fact|group_context|preference|correction|self_fact|decision|commitment)\b/g)].map((m) => m[1]);
    expect(new Set(named)).toEqual(new Set(['user_fact', 'group_context', 'preference', 'correction']));
  });

  it('refuses secrets even when asked, and limits health and third-party details to requests', () => {
    expect(text).toContain("Never save passwords, keys, codes or payment details, even if asked; say you can't keep those.");
    expect(text).toContain('Save health details or details about other people only when the person asks you to remember them.');
  });

  it('states the reach of a saved memory, including the admin-in-group case', () => {
    expect(text).toContain(REACH);
  });

  it('drops "check first" but keeps the no-duplicate rule when search cannot reach memory', () => {
    const noSearch = buildMemoryGuidance({ operatorInstance: false, searchesMemory: false });
    expect(noSearch).not.toContain('knowledge_search');
    expect(noSearch).toContain('- Do not save the same thing twice.');
  });

  it('stays within eight lines', () => {
    expect(text.split('\n').length).toBeLessThanOrEqual(8);
  });

  it('tells the operator instance that every chat can recall its memories', () => {
    const operator = buildMemoryGuidance({ operatorInstance: true, searchesMemory: true });
    expect(operator).toContain('On this instance every chat can recall them.');
    expect(operator).not.toContain(REACH);
  });
});

// Ties each clause of the reach sentence to the recall rule it describes, so
// the prompt text and src/core/memory-scope.ts cannot drift apart silently.
describe('reach sentence agrees with memory-scope.ts', () => {
  const OWNER = '15550000001';
  const MEMBER = '15550000002';
  const BOT_JID = '15550000099@s.whatsapp.net';
  const GROUP_JID = '111111100000123@g.us';
  const GROUP_KEY = '111111100000123_at_g.us';
  const OTHER_CHAT_RECORD = { chat_jid: '15550000003@s.whatsapp.net', sender_jid: '15550000003@s.whatsapp.net' };
  const identities: InstanceIdentities = {
    adminPhones: new Set([OWNER]), siblingPhones: new Set(), botJid: BOT_JID, botLid: null,
  };
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => {
    db.close();
  });

  function deps(overrides: Partial<MemoryScopeDeps> = {}): MemoryScopeDeps {
    const people = [{ id: `${OWNER}@s.whatsapp.net` }, { id: `${MEMBER}@s.whatsapp.net` }, { id: BOT_JID }];
    return { db, identities, membership: { participants: async () => people }, sharedWorkflowGroups: [], ...overrides };
  }

  async function otherChatTier(actor: string, inGroup: boolean, overrides: Partial<MemoryScopeDeps> = {}) {
    const where = inGroup
      ? { conversationKey: GROUP_KEY, deliveryJid: GROUP_JID }
      : { conversationKey: actor, deliveryJid: `${actor}@s.whatsapp.net` };
    const scope = await resolveMemoryScope(
      { tier: 'chat-scoped', operatorInstance: false, actorJid: `${actor}@s.whatsapp.net`, ...where },
      deps(overrides),
    );
    return { kind: scope.kind, tier: memoryHitTier(OTHER_CHAT_RECORD, scope, memoryIdentityFold(db)) };
  }

  it('"an admin can do so even in a group with other people": an admin in such a group recalls other chats', async () => {
    expect(buildMemoryGuidance({ operatorInstance: false, searchesMemory: true })).toContain('an admin can do so even in a group with other people');
    expect(await otherChatTier(OWNER, true)).toEqual({ kind: 'unrestricted', tier: 1 });
  });

  it('"contacts they allow": a contact set to instance recalls other chats; a default contact does not', async () => {
    expect(await otherChatTier(MEMBER, false, { contactRecallScopes: { [MEMBER]: 'instance' } })).toEqual({ kind: 'dm', tier: 1 });
    expect(await otherChatTier(MEMBER, false)).toEqual({ kind: 'dm_chat', tier: null });
  });

  it('a non-admin in a group with other people does not recall other chats', async () => {
    expect(await otherChatTier(MEMBER, true)).toEqual({ kind: 'configurable_group', tier: null });
  });
});

/** A startup provider error as getPineconeReadinessObservation records it: the code comes from the real classifier. */
function providerError(state: MemoryReadinessSnapshot['state'], err: unknown): MemoryReadinessSnapshot {
  return { state, failureCode: classifyMemoryOperationFailure(err).code, evidenceCoverage: 'provider_error' };
}

const TIMEOUT = providerError('network_error', new DOMException('Pinecone readiness deadline exceeded', 'AbortError'));
const AUTH_401 = providerError('auth_failed', { status: 401 });
const INDEX_MISSING: MemoryReadinessSnapshot = { state: 'index_missing', failureCode: 'none', evidenceCoverage: 'provider_response' };
const WRONG_PROJECT: MemoryReadinessSnapshot = { state: 'project_mismatch', failureCode: 'project_guard_failed', evidenceCoverage: 'provider_response' };

describe('memoryUsable', () => {
  it('is usable when ready or after a transient provider failure only', () => {
    const cases: Array<[string, MemoryReadinessSnapshot | undefined, boolean]> = [
      ['ready', READY, true],
      ['timeout', TIMEOUT, true],
      ['network error', providerError('network_error', { cause: { code: 'ECONNREFUSED' } }), true],
      ['5xx', providerError('unknown', { status: 503 }), true],
      ['429', providerError('unknown', { status: 429 }), true],
      ['401', AUTH_401, false],
      ['403', providerError('auth_failed', { status: 403 }), false],
      ['unclassified error', providerError('unknown', new Error('boom')), false],
      ['index_missing', INDEX_MISSING, false],
      ['project_mismatch from the provider', WRONG_PROJECT, false],
      ['disabled locally', { state: 'disabled', failureCode: 'none', evidenceCoverage: 'local_guard' }, false],
      ['no project guard', { state: 'project_mismatch', failureCode: 'project_guard_failed', evidenceCoverage: 'local_guard' }, false],
      ['no observation', undefined, false],
    ];
    expect(cases.map(([label, readiness]) => [label, memoryUsable(readiness)]))
      .toEqual(cases.map(([label, , usable]) => [label, usable]));
  });
});

describe('memoryGuidanceSystemBlock', () => {
  it('returns the full block when memory is ready and memory_write is listed', () => {
    for (const session of [CHAT_SESSION, SHARED_SESSION]) {
      expect(gate({ session })).toBe(buildMemoryGuidance({ operatorInstance: false, searchesMemory: true }));
    }
  });

  it('keeps the block after a startup timeout', () => {
    expect(gate({ readiness: TIMEOUT })).toBe(buildMemoryGuidance({ operatorInstance: false, searchesMemory: true }));
  });

  it('returns undefined after a definitive startup answer: index_missing, project_mismatch, 401', () => {
    expect([INDEX_MISSING, WRONG_PROJECT, AUTH_401].map((readiness) => gate({ readiness }) ?? 'absent'))
      .toEqual(['absent', 'absent', 'absent']);
  });

  it('returns undefined when memory is locally disabled (no key, or no project guard)', () => {
    expect(gate({ readiness: { state: 'disabled', failureCode: 'none', evidenceCoverage: 'local_guard' } })).toBeUndefined();
    expect(gate({ readiness: { state: 'project_mismatch', failureCode: 'project_guard_failed', evidenceCoverage: 'local_guard' } }))
      .toBeUndefined();
  });

  it('returns undefined when memory_write is not registered', () => {
    expect(gate({ registry: registryWith({ memoryWrite: false, searchIndexes: [MEMORY_INDEX] }) })).toBeUndefined();
  });

  it('drops the knowledge_search line when search exposes only another index', () => {
    const block = gate({ registry: registryWith({ searchIndexes: ['docs'] }) });
    expect(block).toBe(buildMemoryGuidance({ operatorInstance: false, searchesMemory: false }));
    expect(block).toContain('memory_write');
  });

  it('returns undefined when an explicit sandbox allowlist omits memory_write', () => {
    expect(gate({ allowedMcpTools: ['mcp__whatsoup__knowledge_search', 'mcp__whatsoup__send_message'] })).toBeUndefined();
  });

  it('drops the knowledge_search line when an explicit sandbox allowlist omits it', () => {
    expect(gate({ allowedMcpTools: ['mcp__whatsoup__memory_write'] }))
      .toBe(buildMemoryGuidance({ operatorInstance: false, searchesMemory: false }));
  });

  it('treats an empty sandbox allowlist as allow-all, like agent-sandbox.sh', () => {
    expect(gate({ allowedMcpTools: [] })).toBe(buildMemoryGuidance({ operatorInstance: false, searchesMemory: true }));
  });

  it('uses the operator reach sentence for the operator instance', () => {
    expect(gate({ instanceName: 'q' })).toBe(buildMemoryGuidance({ operatorInstance: true, searchesMemory: true }));
  });
});
