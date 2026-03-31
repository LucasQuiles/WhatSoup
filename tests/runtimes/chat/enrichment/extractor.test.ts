import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LLMProvider } from '../../../../src/runtimes/chat/providers/types.ts';
import type { StoredMessage } from '../../../../src/core/messages.ts';

// Mock config before importing extractor
vi.mock('../../../../src/config.ts', () => ({
  config: {
    models: {
      extraction: 'claude-sonnet-4-6',
      validation: 'claude-haiku-4-5-20251001',
    },
    enrichmentMinConfidence: 0.7,
  },
}));

vi.mock('../../../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { extractFacts } from '../../../../src/runtimes/chat/enrichment/extractor.ts';

// ── Helpers ────────────────────────────────────────────────────────────────

function mockProvider(response: string): LLMProvider {
  return {
    name: 'mock',
    generate: vi.fn().mockResolvedValue({
      content: response,
      inputTokens: 100,
      outputTokens: 50,
      model: 'mock-model',
      durationMs: 100,
    }),
  };
}

function makeStoredMsg(overrides?: Partial<StoredMessage>): StoredMessage {
  return {
    pk: 1,
    chatJid: 'chat1@g.us',
    senderJid: '15184194479@s.whatsapp.net',
    senderName: 'TestUser',
    messageId: 'msg-1',
    content: 'I just moved to London',
    contentType: 'text',
    isFromMe: false,
    timestamp: Math.floor(Date.now() / 1000),
    quotedMessageId: null,
    enrichmentProcessedAt: null,
    enrichmentRetries: 0,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function validFactJson(overrides?: Record<string, unknown>): object {
  return {
    text: 'Lives in London',
    sender_jid: '15184194479@s.whatsapp.net',
    sender_name: 'TestUser',
    memory_type: 'user_fact',
    confidence: 0.9,
    supersedes_text: '',
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('extractFacts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Positive ────────────────────────────────────────────────────────────

  it('returns ExtractedFact[] with correct fields from valid JSON array', async () => {
    const factJson = validFactJson();
    const provider = mockProvider(JSON.stringify([factJson]));
    const msgs = [makeStoredMsg()];

    const facts = await extractFacts(provider, msgs);

    expect(facts).toHaveLength(1);
    expect(facts[0].text).toBe('Lives in London');
    expect(facts[0].senderJid).toBe('15184194479@s.whatsapp.net');
    expect(facts[0].senderName).toBe('TestUser');
    expect(facts[0].memoryType).toBe('user_fact');
    expect(facts[0].confidence).toBe(0.9);
    expect(facts[0].supersedesText).toBe('');
  });

  it('chatJid comes from input messages, not LLM response', async () => {
    const factJson = validFactJson();
    const provider = mockProvider(JSON.stringify([factJson]));
    const msgs = [makeStoredMsg({ chatJid: 'groupchat@g.us' })];

    const facts = await extractFacts(provider, msgs);

    expect(facts[0].chatJid).toBe('groupchat@g.us');
  });

  it('sourceMessagePks collected from the entire input batch', async () => {
    const factJson = validFactJson();
    const provider = mockProvider(JSON.stringify([factJson]));
    const msgs = [
      makeStoredMsg({ pk: 10, messageId: 'msg-10' }),
      makeStoredMsg({ pk: 11, messageId: 'msg-11' }),
      makeStoredMsg({ pk: 12, messageId: 'msg-12' }),
    ];

    const facts = await extractFacts(provider, msgs);

    expect(facts[0].sourceMessagePks).toEqual([10, 11, 12]);
  });

  it('confidence clamped to 1.0 when LLM returns 1.5', async () => {
    const factJson = validFactJson({ confidence: 1.5 });
    const provider = mockProvider(JSON.stringify([factJson]));
    const msgs = [makeStoredMsg()];

    const facts = await extractFacts(provider, msgs);

    expect(facts[0].confidence).toBe(1.0);
  });

  it('confidence clamped to 0.0 when LLM returns negative value', async () => {
    const factJson = validFactJson({ confidence: -0.5 });
    const provider = mockProvider(JSON.stringify([factJson]));
    const msgs = [makeStoredMsg()];

    const facts = await extractFacts(provider, msgs);

    expect(facts[0].confidence).toBe(0.0);
  });

  it('returns multiple facts when LLM returns multiple items', async () => {
    const factA = validFactJson({ text: 'Fact A', sender_jid: 'a@s.whatsapp.net' });
    const factB = validFactJson({ text: 'Fact B', sender_jid: 'b@s.whatsapp.net' });
    const provider = mockProvider(JSON.stringify([factA, factB]));
    const msgs = [makeStoredMsg()];

    const facts = await extractFacts(provider, msgs);

    expect(facts).toHaveLength(2);
    expect(facts[0].text).toBe('Fact A');
    expect(facts[1].text).toBe('Fact B');
  });

  it('defaults senderName to senderJid when sender_name is absent', async () => {
    const factJson = validFactJson({ sender_name: undefined });
    const provider = mockProvider(JSON.stringify([factJson]));
    const msgs = [makeStoredMsg()];

    const facts = await extractFacts(provider, msgs);

    expect(facts[0].senderName).toBe(facts[0].senderJid);
  });

  it('defaults confidence to 0.5 when confidence field is absent', async () => {
    const factJson = validFactJson({ confidence: undefined });
    const provider = mockProvider(JSON.stringify([factJson]));
    const msgs = [makeStoredMsg()];

    const facts = await extractFacts(provider, msgs);

    expect(facts[0].confidence).toBe(0.5);
  });

  // ── Negative ────────────────────────────────────────────────────────────

  it('returns [] and does NOT call generate on empty batch', async () => {
    const provider = mockProvider('[]');

    const facts = await extractFacts(provider, []);

    expect(facts).toEqual([]);
    expect(provider.generate).not.toHaveBeenCalled();
  });

  it('returns [] on malformed JSON without throwing', async () => {
    const provider = mockProvider('not json at all {{{');
    const msgs = [makeStoredMsg()];

    const facts = await extractFacts(provider, msgs);

    expect(facts).toEqual([]);
  });

  it('returns [] when LLM returns a JSON object (not an array)', async () => {
    const provider = mockProvider(JSON.stringify({ text: 'foo', memory_type: 'user_fact' }));
    const msgs = [makeStoredMsg()];

    const facts = await extractFacts(provider, msgs);

    expect(facts).toEqual([]);
  });

  it('skips items missing the text field', async () => {
    const factJson = validFactJson({ text: undefined });
    const provider = mockProvider(JSON.stringify([factJson]));
    const msgs = [makeStoredMsg()];

    const facts = await extractFacts(provider, msgs);

    expect(facts).toEqual([]);
  });

  it('skips items where text is null', async () => {
    const factJson = validFactJson({ text: null });
    const provider = mockProvider(JSON.stringify([factJson]));
    const msgs = [makeStoredMsg()];

    const facts = await extractFacts(provider, msgs);

    expect(facts).toEqual([]);
  });

  it('skips items where text is an empty string', async () => {
    const factJson = validFactJson({ text: '' });
    const provider = mockProvider(JSON.stringify([factJson]));
    const msgs = [makeStoredMsg()];

    const facts = await extractFacts(provider, msgs);

    expect(facts).toEqual([]);
  });

  it('does NOT skip items with an unknown memory_type (falls back to user_fact)', async () => {
    // The implementation falls back to 'user_fact' for unknown types rather than skipping.
    const factJson = validFactJson({ memory_type: 'totally_invalid_type' });
    const provider = mockProvider(JSON.stringify([factJson]));
    const msgs = [makeStoredMsg()];

    const facts = await extractFacts(provider, msgs);

    // Item is kept, memoryType coerced to 'user_fact'
    expect(facts).toHaveLength(1);
    expect(facts[0].memoryType).toBe('user_fact');
  });

  it('returns [] and does NOT throw when LLM call throws', async () => {
    const provider: LLMProvider = {
      name: 'mock',
      generate: vi.fn().mockRejectedValue(new Error('Network failure')),
    };
    const msgs = [makeStoredMsg()];

    const facts = await extractFacts(provider, msgs);

    expect(facts).toEqual([]);
  });

  it('skips non-object items in the parsed array', async () => {
    const provider = mockProvider(JSON.stringify([null, 42, 'string', validFactJson()]));
    const msgs = [makeStoredMsg()];

    const facts = await extractFacts(provider, msgs);

    // Only the valid object should yield a fact
    expect(facts).toHaveLength(1);
    expect(facts[0].text).toBe('Lives in London');
  });

  it('strips markdown fences and parses JSON successfully', async () => {
    const inner = JSON.stringify([validFactJson()]);
    const provider = mockProvider(`\`\`\`json\n${inner}\n\`\`\``);
    const msgs = [makeStoredMsg()];

    const facts = await extractFacts(provider, msgs);
    expect(facts).toHaveLength(1);
    expect(facts[0].text).toBe('Lives in London');
  });

  it('returns [] when LLM returns a JSON null', async () => {
    const provider = mockProvider('null');
    const msgs = [makeStoredMsg()];

    const facts = await extractFacts(provider, msgs);

    expect(facts).toEqual([]);
  });
});
