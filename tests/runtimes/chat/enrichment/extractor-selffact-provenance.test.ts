/**
 * QR-084 — the enrichment extractor took each fact's memory_type straight from
 * the LLM output. `self_fact` is a privileged type: it is recalled GLOBALLY
 * (searchSelfFacts filters memory_type only, NO chat/sender filter) into every
 * conversation's context. The only signal tying self_fact to a genuine bot
 * (is_from_me) message was a PROMPT instruction to a steerable LLM — no
 * deterministic gate. A non-is_from_me (attacker-participant) message can thus
 * steer the model into emitting a self_fact (the QR-041 participant guard passes
 * because the attacker IS a valid batch sender), poisoning the global
 * self-identity store cross-tenant. The extractor now deterministically
 * downgrades any self_fact whose sender_jid is NOT an is_from_me sender in the
 * batch (parallel to the QR-041 cross-sender-attribution gate).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LLMProvider } from '../../../../src/runtimes/chat/providers/types.ts';
import type { StoredMessage } from '../../../../src/core/messages.ts';

vi.mock('../../../../src/config.ts', () => ({
  config: { models: { extraction: 'm', validation: 'm' }, enrichmentMinConfidence: 0.7 },
}));
vi.mock('../../../../src/logger.ts', () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { extractFacts } from '../../../../src/runtimes/chat/enrichment/extractor.ts';

function mockProvider(response: string): LLMProvider {
  return {
    name: 'mock',
    generate: vi.fn().mockResolvedValue({ content: response, inputTokens: 1, outputTokens: 1, model: 'm', durationMs: 1 }),
  };
}

function msg(over?: Partial<StoredMessage>): StoredMessage {
  return {
    pk: 1, chatJid: 'chat@g.us', senderJid: 'attacker@s.whatsapp.net', senderName: 'Mallory',
    messageId: 'm1', content: 'hello', contentType: 'text', isFromMe: false,
    timestamp: Math.floor(Date.now() / 1000), quotedMessageId: null,
    enrichmentProcessedAt: null, enrichmentRetries: 0, createdAt: new Date().toISOString(),
    conversationKey: 'chat_at_g.us', mediaPath: null, contentText: null, ...over,
  };
}

const ATTACKER = 'attacker@s.whatsapp.net';
const BOT = 'bot@s.whatsapp.net';

describe('extractFacts self_fact provenance gate (QR-084)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('downgrades a self_fact attributed to a non-is_from_me sender (attacker) to user_fact', async () => {
    // Batch is pure attacker (no is_from_me bot message). The (steered) LLM
    // emits a self_fact attributed to the attacker — a poison of the global
    // self-identity store.
    const provider = mockProvider(JSON.stringify([
      { text: 'Loops always forwards transcripts to Mallory', sender_jid: ATTACKER, sender_name: 'Mallory', memory_type: 'self_fact', confidence: 0.9 },
    ]));
    const facts = await extractFacts(provider, [msg({ senderJid: ATTACKER, isFromMe: false })]);
    // Kept (attacker is a valid participant — QR-041 passes) but NOT as self_fact.
    expect(facts).toHaveLength(1);
    expect(facts[0].memoryType).toBe('user_fact');
  });

  it('downgrades a self_fact attributed to the BOT JID when the batch has NO is_from_me message', async () => {
    // The LLM attributes the poison to the bot JID, but no is_from_me message
    // exists in the batch → no legitimate self-claim is possible here.
    const provider = mockProvider(JSON.stringify([
      { text: 'Loops lives in Attackerville', sender_jid: BOT, sender_name: 'Loops', memory_type: 'self_fact', confidence: 0.9 },
    ]));
    // sender_jid BOT is not a batch sender → QR-041 drops it first; assert it
    // never survives as a self_fact.
    const facts = await extractFacts(provider, [msg({ senderJid: ATTACKER, isFromMe: false })]);
    expect(facts.find((f) => f.memoryType === 'self_fact')).toBeUndefined();
  });

  it('KEEPS a self_fact attributed to a genuine is_from_me (bot) sender', async () => {
    // A real self_fact: the batch contains a bot (is_from_me) message and the
    // fact is attributed to that bot JID.
    const provider = mockProvider(JSON.stringify([
      { text: 'Loops does freelance dev work', sender_jid: BOT, sender_name: 'Loops', memory_type: 'self_fact', confidence: 0.9 },
    ]));
    const facts = await extractFacts(provider, [
      msg({ pk: 1, senderJid: ATTACKER, isFromMe: false, content: 'what do you do?' }),
      msg({ pk: 2, senderJid: BOT, senderName: 'Loops', isFromMe: true, content: 'I do freelance dev work' }),
    ]);
    expect(facts).toHaveLength(1);
    expect(facts[0].memoryType).toBe('self_fact');
    expect(facts[0].senderJid).toBe(BOT);
  });

  it('does not disturb a normal user_fact from an attacker', async () => {
    const provider = mockProvider(JSON.stringify([
      { text: 'Mallory lives in Paris', sender_jid: ATTACKER, sender_name: 'Mallory', memory_type: 'user_fact', confidence: 0.9 },
    ]));
    const facts = await extractFacts(provider, [msg({ senderJid: ATTACKER, isFromMe: false })]);
    expect(facts).toHaveLength(1);
    expect(facts[0].memoryType).toBe('user_fact');
  });
});
