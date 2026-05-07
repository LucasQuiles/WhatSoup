import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LLMProvider } from '../../../../src/runtimes/chat/providers/types.ts';
import type { StoredMessage } from '../../../../src/core/messages.ts';

vi.mock('../../../../src/config.ts', () => ({
  config: {
    models: {
      extraction: 'test-extraction-model',
      validation: 'test-validation-model',
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
    chatJid: 'chat@g.us',
    senderJid: '123@s.whatsapp.net',
    senderName: 'Alice',
    messageId: 'msg-1',
    content: 'I just moved to London',
    contentType: 'text',
    isFromMe: false,
    timestamp: Math.floor(Date.now() / 1000),
    quotedMessageId: null,
    enrichmentProcessedAt: null,
    enrichmentRetries: 0,
    createdAt: new Date().toISOString(),
    conversationKey: 'chat_at_g.us',
    mediaPath: null,
    contentText: null,
    ...overrides,
  };
}

describe('extractFacts with Toulmin fields', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('extracts claim, evidence, and warrant from LLM response', async () => {
    const provider = mockProvider(
      JSON.stringify([
        {
          text: 'Lives in London',
          claim: 'User lives in London',
          evidence: 'User said "I just moved to London"',
          warrant: 'Direct statement of current residence',
          confidence_qualifier: 'stated once',
          sender_jid: '123@s.whatsapp.net',
          sender_name: 'Alice',
          memory_type: 'user_fact',
          confidence: 0.95,
          supersedes_text: '',
        },
      ]),
    );

    const facts = await extractFacts(provider, [makeStoredMsg()]);

    expect(facts).toHaveLength(1);
    expect(facts[0].claim).toBe('User lives in London');
    expect(facts[0].evidence).toBe('User said "I just moved to London"');
    expect(facts[0].warrant).toBe('Direct statement of current residence');
    expect(facts[0].confidenceQualifier).toBe('stated once');
  });

  it('defaults Toulmin fields to empty string when missing', async () => {
    const provider = mockProvider(
      JSON.stringify([
        {
          text: 'Lives in London',
          sender_jid: '123@s.whatsapp.net',
          sender_name: 'Alice',
          memory_type: 'user_fact',
          confidence: 0.9,
        },
      ]),
    );

    const facts = await extractFacts(provider, [makeStoredMsg()]);

    expect(facts).toHaveLength(1);
    expect(facts[0].claim).toBe('');
    expect(facts[0].evidence).toBe('');
    expect(facts[0].warrant).toBe('');
    expect(facts[0].confidenceQualifier).toBe('');
  });

  it('handles non-string Toulmin field values by defaulting to empty string', async () => {
    const provider = mockProvider(
      JSON.stringify([
        {
          text: 'Lives in London',
          claim: 123,
          evidence: null,
          warrant: true,
          confidence_qualifier: ['array'],
          sender_jid: '123@s.whatsapp.net',
          sender_name: 'Alice',
          memory_type: 'user_fact',
          confidence: 0.8,
        },
      ]),
    );

    const facts = await extractFacts(provider, [makeStoredMsg()]);

    expect(facts).toHaveLength(1);
    expect(facts[0].claim).toBe('');
    expect(facts[0].evidence).toBe('');
    expect(facts[0].warrant).toBe('');
    expect(facts[0].confidenceQualifier).toBe('');
  });
});
