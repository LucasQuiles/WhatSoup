import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

// Mock config before importing the runtime: fallback is SYMBOLIC, conversation
// stays a literal — the test asserts both behaviors on the same turn.
vi.mock('../../../src/config.ts', () => ({
  config: {
    botName: 'TestBot',
    systemPrompt: 'You are a test bot.',
    // T8-F1: chat/runtime.ts's redactInternalArtifacts ctx now reads
    // config.adminPhones (isOperatorDmPeer) — empty so this test's fixture
    // JIDs never resolve as operator DMs (unchanged pre-F1 behavior).
    adminPhones: new Set<string>(),
    models: {
      conversation: 'claude-opus-4-8',
      extraction: 'claude-sonnet-4-6',
      validation: 'claude-haiku-4-5',
      fallback: 'openai:gpt:latest-stable',
    },
    maxTokens: 500,
    tokenBudget: 100_000,
    rateLimitPerHour: 45,
    rateLimitWindowMs: 3_600_000,
    rateLimitNoticeWindowMs: 3_600_000,
    conversationWindow: 50,
    conversationWindowExtended: 200,
    windowExtensionThresholdMs: 600_000,
    apiRetryDelayMs: 1,
    pineconeSearchMode: 'memory',
    memory: { pinecone: { namespaces: { facts: 'facts', chunks: 'chunks' } } },
  },
}));

// The success path clears the llm_total_failure alert source — keep the alert
// pipeline out of the test.
vi.mock('../../../src/lib/emit-alert.ts', () => ({
  emitAlert: vi.fn(() => true),
  emitAlertChecked: vi.fn(() => true),
  clearAlertSource: vi.fn(() => true),
  clearAlertSourceChecked: vi.fn(() => true),
}));

import { Database } from '../../../src/core/database.ts';
import { ChatRuntime } from '../../../src/runtimes/chat/runtime.ts';
import { __resetModelAdvisorForTest } from '../../../src/lib/model-advisor.ts';
import { WhatSoupError } from '../../../src/errors.ts';
import type { IncomingMessage, Messenger } from '../../../src/core/types.ts';
import type { LLMProvider } from '../../../src/runtimes/chat/providers/types.ts';
import type { PineconeMemory } from '../../../src/runtimes/chat/providers/pinecone.ts';

const dbPath = join(tmpdir(), `whatsoup-fallback-model-${randomBytes(4).toString('hex')}.db`);
const db = new Database(dbPath);
db.open();

afterAll(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const fp = dbPath + suffix;
    if (existsSync(fp)) unlinkSync(fp);
  }
});

function incomingMessage(): IncomingMessage {
  return {
    messageId: `msg-${randomBytes(4).toString('hex')}`,
    chatJid: '15551230001@s.whatsapp.net',
    senderJid: '15551230001@s.whatsapp.net',
    senderName: 'Tester',
    content: 'hello there',
    contentText: null,
    contentType: 'text',
    isFromMe: false,
    isGroup: false,
    mentionedJids: [],
    timestamp: Math.floor(Date.now() / 1000),
    quotedMessageId: null,
    isResponseWorthy: true,
  };
}

function makeRuntime(primary: LLMProvider, fallback: LLMProvider): { runtime: ChatRuntime; messenger: Messenger } {
  const messenger: Messenger = {
    sendMessage: vi.fn().mockResolvedValue({ waMessageId: 'wa-1' }),
    sendMedia: vi.fn().mockResolvedValue({ waMessageId: 'wa-2' }),
  };
  // Broken-on-purpose Pinecone stub: loadContext failure is caught by the
  // runtime and the turn proceeds with no memory context.
  const pinecone = {} as unknown as PineconeMemory;
  const runtime = new ChatRuntime(db, messenger, pinecone, primary, fallback, {
    enableEnrichment: false,
    botName: 'TestBot',
  });
  return { runtime, messenger };
}

const badRequestPrimary = (): LLMProvider => ({
  name: 'mock-primary',
  generate: vi.fn().mockRejectedValue(new WhatSoupError('bad payload', 'LLM_BAD_REQUEST')),
});

const capturingFallback = (): LLMProvider => ({
  name: 'mock-fallback',
  generate: vi.fn().mockResolvedValue({
    content: 'fallback says hi',
    inputTokens: 10,
    outputTokens: 5,
    model: 'gpt-5.5',
    durationMs: 5,
  }),
});

beforeEach(() => {
  __resetModelAdvisorForTest();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('ChatRuntime fallback model resolution', () => {
  it('resolves a symbolic fallback model to the concrete live ID before the provider call', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', 'fake-openai-key');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: 'gpt-5.5' }, { id: 'gpt-5.5-codex' }, { id: 'gpt-5.4' }, { id: 'gpt-5.6-preview' }],
      }),
    }));

    const primary = badRequestPrimary();
    const fallback = capturingFallback();
    const { runtime, messenger } = makeRuntime(primary, fallback);
    await runtime.start();

    await runtime.handleMessage(incomingMessage());
    await vi.waitFor(() => expect(fallback.generate).toHaveBeenCalledTimes(1));

    // The provider received the RESOLVED concrete ID, not the symbolic string.
    const fallbackRequest = vi.mocked(fallback.generate).mock.calls[0][0];
    expect(fallbackRequest.model).toBe('gpt-5.5');

    // Literal conversation model passed through to the primary unchanged.
    const primaryRequest = vi.mocked(primary.generate).mock.calls[0][0];
    expect(primaryRequest.model).toBe('claude-opus-4-8');

    // The fallback reply was actually sent.
    await vi.waitFor(() => expect(messenger.sendMessage).toHaveBeenCalledWith(
      '15551230001@s.whatsapp.net', 'fallback says hi',
    ));
  });

  it('degrades to the static catalog current when live discovery is down — never the raw symbolic string', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', 'fake-openai-key');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    const fallback = capturingFallback();
    const { runtime } = makeRuntime(badRequestPrimary(), fallback);
    await runtime.start();

    await runtime.handleMessage(incomingMessage());
    await vi.waitFor(() => expect(fallback.generate).toHaveBeenCalledTimes(1));

    const fallbackRequest = vi.mocked(fallback.generate).mock.calls[0][0];
    expect(fallbackRequest.model).toBe('gpt-5.4'); // catalog `current` for openai/gpt
  });
});
