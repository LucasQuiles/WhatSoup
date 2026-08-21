// tests/mcp/per-tier-surface-ratchet.test.ts
// #1976 remainder: per-tier advertised-count budgets — the per-tier mirror of
// the global BASELINE_TOOL_COUNT ratchet in tests/mcp/register-all.test.ts.
//
// The per-tier advertised surface is GATE-CONDITIONAL: registerAllTools
// registers memory_write only when config.pineconeIndex AND the key env
// (memory.pinecone.apiKeyEnv ?? PINECONE_API_KEY) are both set. Live-registry
// counts verified on base 6de45f106 (2026-08-21, scripts/probe-1976-live-counts.ts):
//
//   gate OFF (CI default):  chat-scoped 29   conversation-bound 30
//   gate ON  (memory_write): chat-scoped 30   conversation-bound 31   ← triage's 30/31
//   conversation-bound extra vs chat-scoped (gate ON): exactly ["transcribe_audio"]
//
// Exact counts, not lower bounds — a silently-dropped module, a scope leak, or
// an accidental new registration must surface here. Both gate states are
// pinned so the budget is deterministic on key-less CI and memory-configured
// dev hosts alike.

import { describe, it, expect, afterEach } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { ToolRegistry } from '../../src/mcp/registry.ts';
import { PresenceCache } from '../../src/transport/presence-cache.ts';
import { registerAllTools } from '../../src/mcp/register-all.ts';
import { makeConversationBinding } from '../../src/mcp/types.ts';
import type { ConnectionManager } from '../../src/transport/connection.ts';
import type { SessionContext, ToolDeclaration } from '../../src/mcp/types.ts';
import { config } from '../../src/config.ts';

// Per-tier advertised-count budgets (see header table).
const CHAT_SCOPED_GATE_OFF = 29;
const CHAT_SCOPED_GATE_ON = 30;
const BOUND_GATE_OFF = 30;
const BOUND_GATE_ON = 31;

const DEFAULT_KEY_ENV = 'PINECONE_API_KEY';
const originalKey = process.env[DEFAULT_KEY_ENV];
const originalIndex = (config as { pineconeIndex?: string }).pineconeIndex;
const originalMemory = (config as { memory?: unknown }).memory;

function makeConnection(): ConnectionManager {
  return {
    contactsDir: { contacts: new Map(), getLidMappings: () => undefined },
    presenceCache: new PresenceCache(),
    getSocket: () => null,
    sendRaw: async () => ({ waMessageId: null }),
    sendMedia: async () => ({ waMessageId: null }),
  } as unknown as ConnectionManager;
}

// One shared database for the whole file: registerAllTools only registers
// tools here (no handler is invoked), so per-case isolation comes from the
// fresh ToolRegistry, not the DB.
const sharedDb = new Database(':memory:');
sharedDb.open();

function advertised(session: SessionContext): ReturnType<ToolRegistry['listTools']> {
  const registry = new ToolRegistry();
  registerAllTools(registry, makeConnection(), sharedDb);
  return registry.listTools(session);
}

const chatScoped: SessionContext = { tier: 'chat-scoped' };
const conversationBound: SessionContext = {
  tier: 'global',
  binding: makeConversationBinding('ratchet@s.whatsapp.net', 'ratchet@s.whatsapp.net'),
};

/** Explicitly drive the memory_write registration gate open or closed. */
function setGate(open: boolean): void {
  if (open) {
    (config as { pineconeIndex?: string }).pineconeIndex = 'ratchet-probe-index';
    process.env[DEFAULT_KEY_ENV] = 'ratchet-probe-dummy-not-a-secret';
  } else {
    (config as { pineconeIndex?: string }).pineconeIndex = undefined;
    delete process.env[DEFAULT_KEY_ENV];
  }
}

afterEach(() => {
  if (originalKey === undefined) delete process.env[DEFAULT_KEY_ENV];
  else process.env[DEFAULT_KEY_ENV] = originalKey;
  (config as { pineconeIndex?: string }).pineconeIndex = originalIndex;
  (config as { memory?: unknown }).memory = originalMemory;
});

describe('per-tier advertised-surface ratchet (#1976)', () => {
  it('gate OFF (CI default): chat-scoped 29 / conversation-bound 30, memory_write not advertised', () => {
    setGate(false);
    const chat = advertised(chatScoped);
    const bound = advertised(conversationBound);
    expect(chat.length).toBe(CHAT_SCOPED_GATE_OFF);
    expect(bound.length).toBe(BOUND_GATE_OFF);
    expect(chat.some((t) => t.name === 'memory_write')).toBe(false);
    expect(bound.some((t) => t.name === 'memory_write')).toBe(false);
  });

  it('gate ON: chat-scoped 30 / conversation-bound 31 (the triage budgets), memory_write advertised to both tiers', () => {
    setGate(true);
    const chat = advertised(chatScoped);
    const bound = advertised(conversationBound);
    expect(chat.length).toBe(CHAT_SCOPED_GATE_ON);
    expect(bound.length).toBe(BOUND_GATE_ON);
    expect(chat.some((t) => t.name === 'memory_write')).toBe(true);
    expect(bound.some((t) => t.name === 'memory_write')).toBe(true);
  });

  it('gate ON: transcribe_audio is the ONLY tool conversation-bound sessions see beyond chat-scoped', () => {
    setGate(true);
    const chat = advertised(chatScoped);
    const bound = advertised(conversationBound);
    const chatNames = new Set(chat.map((t) => t.name));
    const extra = bound.map((t) => t.name).filter((n) => !chatNames.has(n));
    expect(extra).toEqual(['transcribe_audio']);
  });

  it('the gate is the ONLY per-tier surface delta: opening it adds exactly memory_write to chat-scoped', () => {
    setGate(false);
    const closed = advertised(chatScoped).map((t) => t.name);
    setGate(true);
    const open = advertised(chatScoped).map((t) => t.name);
    const closedSet = new Set(closed);
    const added = open.filter((n) => !closedSet.has(n));
    const openSet = new Set(open);
    const removed = closed.filter((n) => !openSet.has(n));
    expect(added).toEqual(['memory_write']);
    expect(removed).toEqual([]);
  });
});
