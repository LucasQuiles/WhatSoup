/**
 * additionalMcpServers threading into the per-chat actor cfg (instance-declared
 * MCP servers). Separate from per-chat-actor-binding.test.ts on purpose: that
 * file mocks node:fs, and the surface assertion re-reads the file it just
 * wrote — these tests want REAL bytes on disk (tmp cwd).
 */
import { describe, it, expect, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../../src/config.ts', () => ({
  config: {
    adminPhones: new Set<string>(),
    controlPeers: new Map<string, string>(),
    toolUpdateMode: 'full',
    toolUpdateRedirectJid: null,
    textAggregateDelayMs: 2_000,
    agentProvider: 'claude-cli',
    agentProviderConfig: undefined,
    agentFallbacks: [],
    agentFallbackProvider: undefined,
    agentFallbackModel: undefined,
  },
}));

vi.mock('../../../src/mcp/socket-server.ts', () => ({
  WhatSoupSocketServer: vi.fn().mockImplementation(function () {
    return { start: vi.fn(), stop: vi.fn(), updateDeliveryJid: vi.fn(), updateActorJid: vi.fn(), updateConversationKey: vi.fn() };
  }),
}));

// Tool registration is irrelevant to the MCP-config threading seam and drags
// in config fields (mediaDir, …) this minimal preamble does not fake.
vi.mock('../../../src/mcp/register-all.ts', () => ({
  registerAllTools: vi.fn(),
}));

import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import type { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';

function makeDb(): Database {
  return {
    raw: {
      exec: vi.fn(),
      prepare: vi.fn().mockReturnValue({ run: vi.fn(), get: vi.fn(), all: vi.fn() }),
    },
  } as unknown as Database;
}

function makeMessenger(): Messenger {
  return {
    sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
    sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
  } as unknown as Messenger;
}

interface ThreadPriv {
  wirePerChatActorSocket(chatJid: string, provider: string):
    | { mcpSocketPath: string; providerConfigOverride: { mcpConfig: string[]; strictMcpConfig: true } }
    | undefined;
  teardownPerChatActorSocket(mapKey: string): void;
  resolvePerChatMapKey(chatJid: string): string;
  resolvedAdditionalMcpServers: unknown;
  requiredMcpNames: unknown;
  additionalMcpServerSpecs: unknown;
}
const tpriv = (r: AgentRuntime): ThreadPriv => r as unknown as ThreadPriv;
const CHAT = 'threading-test@s.whatsapp.net';

describe('additionalMcpServers threading into the per-chat actor cfg (P1-22/P1-23)', () => {
  it('stores declared specs from AgentRuntimeOptions', () => {
    const specs = [{ name: 'microsoft_365', command: 'node' as const, args: ['~/x/index.js'] }];
    const r = new AgentRuntime(makeDb(), makeMessenger(), 'test', {
      sessionScope: 'per_chat',
      additionalMcpServers: specs,
    });
    expect(tpriv(r).additionalMcpServerSpecs).toEqual(specs);
  });

  it('writes resolved additional servers into the strict per-chat cfg (whatsoup stays first)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'amcp-cwd-'));
    const r = new AgentRuntime(makeDb(), makeMessenger(), 'test', { sessionScope: 'per_chat', cwd });
    tpriv(r).resolvedAdditionalMcpServers = [
      { name: 'microsoft_365', command: '/pinned/node', args: ['/x/index.js'], env: { A_B: 'x' } },
    ];
    tpriv(r).requiredMcpNames = ['whatsoup', 'microsoft_365'];
    const override = tpriv(r).wirePerChatActorSocket(CHAT, 'claude-cli');
    expect(override).toBeDefined();
    const cfgPath = override!.providerConfigOverride.mcpConfig[0];
    try {
      const parsed = JSON.parse(readFileSync(cfgPath, 'utf8')) as {
        mcpServers: Record<string, { command: string }>;
      };
      expect(Object.keys(parsed.mcpServers)).toEqual(['whatsoup', 'microsoft_365']);
      expect(parsed.mcpServers.microsoft_365.command).toBe('/pinned/node');
    } finally {
      tpriv(r).teardownPerChatActorSocket(tpriv(r).resolvePerChatMapKey(CHAT));
      expect(existsSync(cfgPath)).toBe(false);
    }
  });

  it('fails the per-chat wiring closed when a required server is missing from the resolved set', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'amcp-cwd-'));
    const r = new AgentRuntime(makeDb(), makeMessenger(), 'test', { sessionScope: 'per_chat', cwd });
    tpriv(r).resolvedAdditionalMcpServers = [];
    tpriv(r).requiredMcpNames = ['whatsoup', 'microsoft_365'];
    expect(() => tpriv(r).wirePerChatActorSocket(CHAT, 'claude-cli')).toThrow(/microsoft_365/);
  });
});
