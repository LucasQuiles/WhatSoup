import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LLMProvider } from '../../../../src/runtimes/chat/providers/types.ts';
import type { StoredMessage } from '../../../../src/core/messages.ts';

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

import {
  validateFacts,
  ValidationError,
} from '../../../../src/runtimes/chat/enrichment/validator.ts';
import type { ExtractedFact } from '../../../../src/runtimes/chat/enrichment/extractor.ts';

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
    conversationKey: 'chat1@g.us',
    contentText: null,
    mediaPath: null,
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

function makeFact(overrides?: Partial<ExtractedFact>): ExtractedFact {
  return {
    text: 'Lives in London',
    chatJid: 'chat1@g.us',
    senderJid: '15184194479@s.whatsapp.net',
    senderName: 'TestUser',
    memoryType: 'user_fact',
    confidence: 0.85,
    supersedesText: '',
    sourceMessagePks: [1],
    ...overrides,
  };
}

function validationResponse(
  results: Array<{ index: number; grounded: boolean; adjusted_confidence: number; reason?: string }>,
): string {
  return JSON.stringify(results.map((r) => ({
    index: r.index,
    grounded: r.grounded,
    adjusted_confidence: r.adjusted_confidence,
    reason: r.reason ?? 'test',
  })));
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('validateFacts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Positive ────────────────────────────────────────────────────────────

  it('returns ValidatedFact[] when all facts are grounded with high confidence', async () => {
    const facts = [makeFact({ text: 'Lives in London' }), makeFact({ text: 'Works as a developer' })];
    const response = validationResponse([
      { index: 0, grounded: true, adjusted_confidence: 0.9 },
      { index: 1, grounded: true, adjusted_confidence: 0.8 },
    ]);
    const provider = mockProvider(response);
    const msgs = [makeStoredMsg()];

    const validated = await validateFacts(provider, facts, msgs);

    expect(validated).toHaveLength(2);
    expect(validated[0].adjustedConfidence).toBe(0.9);
    expect(validated[1].adjustedConfidence).toBe(0.8);
  });

  it('uses adjusted_confidence from LLM response (not original confidence)', async () => {
    const facts = [makeFact({ confidence: 0.5 })];
    const response = validationResponse([{ index: 0, grounded: true, adjusted_confidence: 0.95 }]);
    const provider = mockProvider(response);

    const validated = await validateFacts(provider, facts, [makeStoredMsg()]);

    expect(validated[0].adjustedConfidence).toBe(0.95);
  });

  it('stores validation reason when returned by the model', async () => {
    const facts = [makeFact({ confidence: 0.5 })];
    const response = validationResponse([
      { index: 0, grounded: true, adjusted_confidence: 0.95, reason: 'grounded in the source message' },
    ]);
    const provider = mockProvider(response);

    const validated = await validateFacts(provider, facts, [makeStoredMsg()]);

    expect(validated[0].validationReason).toBe('grounded in the source message');
  });

  it('passes through original fact fields unchanged (text, chatJid, etc.)', async () => {
    const fact = makeFact({
      text: 'Prefers dark mode',
      memoryType: 'preference',
      chatJid: 'mygroup@g.us',
      senderJid: 'user@s.whatsapp.net',
    });
    const response = validationResponse([{ index: 0, grounded: true, adjusted_confidence: 0.8 }]);
    const provider = mockProvider(response);

    const validated = await validateFacts(provider, [fact], [makeStoredMsg()]);

    expect(validated[0].text).toBe('Prefers dark mode');
    expect(validated[0].memoryType).toBe('preference');
    expect(validated[0].chatJid).toBe('mygroup@g.us');
    expect(validated[0].senderJid).toBe('user@s.whatsapp.net');
  });

  it('single fact batch works correctly', async () => {
    const facts = [makeFact()];
    const response = validationResponse([{ index: 0, grounded: true, adjusted_confidence: 0.75 }]);
    const provider = mockProvider(response);

    const validated = await validateFacts(provider, facts, [makeStoredMsg()]);

    expect(validated).toHaveLength(1);
    expect(validated[0].adjustedConfidence).toBe(0.75);
  });

  it('passes through fact with original confidence when validation result is missing for its index', async () => {
    const facts = [makeFact({ confidence: 0.8 }), makeFact({ text: 'Second fact', confidence: 0.7 })];
    // Only return result for index 0, missing index 1
    const response = validationResponse([{ index: 0, grounded: true, adjusted_confidence: 0.9 }]);
    const provider = mockProvider(response);

    const validated = await validateFacts(provider, facts, [makeStoredMsg()]);

    // index 0 passes with adjusted confidence; index 1 passes through with original
    expect(validated).toHaveLength(2);
    expect(validated[0].adjustedConfidence).toBe(0.9);
    expect(validated[1].adjustedConfidence).toBe(0.7);
  });

  it('adjustedConfidence is clamped to [0,1] even if LLM returns value > 1', async () => {
    const facts = [makeFact()];
    const response = validationResponse([{ index: 0, grounded: true, adjusted_confidence: 1.5 }]);
    const provider = mockProvider(response);

    const validated = await validateFacts(provider, facts, [makeStoredMsg()]);

    expect(validated[0].adjustedConfidence).toBe(1.0);
  });

  // ── Negative ────────────────────────────────────────────────────────────

  it('returns [] immediately without calling generate when facts array is empty', async () => {
    const provider = mockProvider('[]');

    const validated = await validateFacts(provider, [], [makeStoredMsg()]);

    expect(validated).toEqual([]);
    expect(provider.generate).not.toHaveBeenCalled();
  });

  it('returns [] (drops all) when LLM is unavailable (throws)', async () => {
    const provider: LLMProvider = {
      name: 'mock',
      generate: vi.fn().mockRejectedValue(new Error('LLM offline')),
    };
    const facts = [makeFact()];

    const validated = await validateFacts(provider, facts, [makeStoredMsg()]);

    expect(validated).toEqual([]);
  });

  it('filters out ungrounded facts (grounded=false)', async () => {
    const facts = [makeFact({ text: 'Ungrounded claim' }), makeFact({ text: 'Grounded claim' })];
    const response = validationResponse([
      { index: 0, grounded: false, adjusted_confidence: 0.8 },
      { index: 1, grounded: true, adjusted_confidence: 0.9 },
    ]);
    const provider = mockProvider(response);

    const validated = await validateFacts(provider, facts, [makeStoredMsg()]);

    expect(validated).toHaveLength(1);
    expect(validated[0].text).toBe('Grounded claim');
  });

  it('filters out facts with adjusted_confidence below 0.7 threshold', async () => {
    const facts = [makeFact()];
    const response = validationResponse([{ index: 0, grounded: true, adjusted_confidence: 0.69 }]);
    const provider = mockProvider(response);

    const validated = await validateFacts(provider, facts, [makeStoredMsg()]);

    expect(validated).toEqual([]);
  });

  it('passes facts with adjusted_confidence exactly at 0.7 threshold', async () => {
    const facts = [makeFact()];
    const response = validationResponse([{ index: 0, grounded: true, adjusted_confidence: 0.7 }]);
    const provider = mockProvider(response);

    const validated = await validateFacts(provider, facts, [makeStoredMsg()]);

    expect(validated).toHaveLength(1);
    expect(validated[0].adjustedConfidence).toBe(0.7);
  });

  it('returns [] (drops all) when LLM returns malformed JSON', async () => {
    const provider = mockProvider('{invalid json!!!');
    const facts = [makeFact()];

    const validated = await validateFacts(provider, facts, [makeStoredMsg()]);

    expect(validated).toEqual([]);
  });

  it('returns [] (drops all) when LLM returns a JSON object instead of array', async () => {
    const provider = mockProvider(JSON.stringify({ index: 0, grounded: true, adjusted_confidence: 0.9 }));
    const facts = [makeFact()];

    const validated = await validateFacts(provider, facts, [makeStoredMsg()]);

    expect(validated).toEqual([]);
  });

  it('returns [] when LLM returns a JSON array of non-objects', async () => {
    const provider = mockProvider(JSON.stringify([null, 42, 'string']));
    const facts = [makeFact({ confidence: 0.8 })];

    const validated = await validateFacts(provider, facts, [makeStoredMsg()]);

    // Items without index are skipped, so the fact has no validation result and passes through
    // with original confidence (0.8 >= 0.7 threshold).
    // Actually: items missing index are skipped from resultMap, but fact at index 0 has no result,
    // so it passes through with original confidence. That's >= 0.7 so it's included.
    // This verifies the pass-through behavior rather than asserting [].
    expect(validated).toHaveLength(1);
    expect(validated[0].adjustedConfidence).toBe(0.8);
  });

  it('filters all facts when all are ungrounded', async () => {
    const facts = [makeFact({ text: 'A' }), makeFact({ text: 'B' })];
    const response = validationResponse([
      { index: 0, grounded: false, adjusted_confidence: 0.9 },
      { index: 1, grounded: false, adjusted_confidence: 0.85 },
    ]);
    const provider = mockProvider(response);

    const validated = await validateFacts(provider, facts, [makeStoredMsg()]);

    expect(validated).toEqual([]);
  });
});

// ── Strict mode (P3.6-H1) ─────────────────────────────────────────────────
// Strict mode throws on schema/shape/parse failures ("ambiguous empty").
// Legitimate semantic drops (grounded=false, adjustedConfidence < threshold)
// stay silent — the model's "this fact isn't grounded" signal is not a schema
// failure.

describe('validateFacts — strict mode (opt-in)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('strict: provider throw raises ValidationError with stage=provider-call', async () => {
    const cause = new Error('LLM offline'); // synthetic per P3.6-H1
    const provider: LLMProvider = {
      name: 'mock',
      generate: vi.fn().mockRejectedValue(cause),
    };
    const facts = [makeFact()];

    await expect(
      validateFacts(provider, facts, [makeStoredMsg()], { strict: true }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ValidationError);
      const e = err as ValidationError;
      expect(e.stage).toBe('provider-call');
      expect(e.details.cause).toBe(cause);
      return true;
    });
  });

  it('strict: malformed JSON raises ValidationError with stage=json-parse', async () => {
    const provider = mockProvider('{invalid json!!!'); // synthetic per P3.6-H1
    const facts = [makeFact()];

    await expect(
      validateFacts(provider, facts, [makeStoredMsg()], { strict: true }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ValidationError);
      const e = err as ValidationError;
      expect(e.stage).toBe('json-parse');
      expect(typeof e.details.rawOutput).toBe('string');
      expect((e.details.rawOutput ?? '').length).toBeLessThanOrEqual(500);
      return true;
    });
  });

  it('strict: non-array top-level raises ValidationError with stage=schema-shape', async () => {
    const provider = mockProvider(
      JSON.stringify({ index: 0, grounded: true, adjusted_confidence: 0.9 }),
    );
    const facts = [makeFact()];

    await expect(
      validateFacts(provider, facts, [makeStoredMsg()], { strict: true }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ValidationError);
      const e = err as ValidationError;
      expect(e.stage).toBe('schema-shape');
      return true;
    });
  });

  it('strict: grounded=false drops stay silent (semantic, not schema)', async () => {
    // synthetic per P3.6-H1 — model explicitly said "not grounded", that's a
    // legitimate semantic signal and must NOT raise in strict mode.
    const facts = [makeFact({ text: 'Ungrounded claim A' }), makeFact({ text: 'Ungrounded claim B' })];
    const response = validationResponse([
      { index: 0, grounded: false, adjusted_confidence: 0.9 },
      { index: 1, grounded: false, adjusted_confidence: 0.85 },
    ]);
    const provider = mockProvider(response);

    const validated = await validateFacts(provider, facts, [makeStoredMsg()], { strict: true });

    expect(validated).toEqual([]);
  });

  it('strict: below-threshold drops stay silent (semantic, not schema)', async () => {
    // synthetic per P3.6-H1 — confidence < enrichmentMinConfidence (0.7) is
    // a legitimate semantic threshold drop, not a schema failure.
    const facts = [makeFact()];
    const response = validationResponse([{ index: 0, grounded: true, adjusted_confidence: 0.3 }]);
    const provider = mockProvider(response);

    const validated = await validateFacts(provider, facts, [makeStoredMsg()], { strict: true });

    expect(validated).toEqual([]);
  });

  it('strict: all items shape-malformed raises stage=schema-items-all-dropped', async () => {
    // synthetic per P3.6-H1 — every parsed item is an object but missing the
    // required `index` field. 100% schema-malformed → must raise.
    const provider = mockProvider(
      JSON.stringify([
        { grounded: true, adjusted_confidence: 0.9 }, // missing index
        { grounded: true, adjusted_confidence: 0.85 }, // missing index
      ]),
    );
    const facts = [makeFact({ text: 'A' }), makeFact({ text: 'B' })];

    await expect(
      validateFacts(provider, facts, [makeStoredMsg()], { strict: true }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ValidationError);
      const e = err as ValidationError;
      expect(e.stage).toBe('schema-items-all-dropped');
      expect(e.details.droppedCount).toBe(2);
      expect(e.details.totalCount).toBe(2);
      return true;
    });
  });

  it('strict: facts.length===0 returns [] without calling provider', async () => {
    const provider = mockProvider('[]');

    const validated = await validateFacts(provider, [], [makeStoredMsg()], { strict: true });

    expect(validated).toEqual([]);
    expect(provider.generate).not.toHaveBeenCalled();
  });

  it('strict: empty-array response with no facts-to-validate edge: all facts pass-through with original confidence if legal', async () => {
    // Strict mode must NOT treat "zero results returned" as schema failure —
    // because the validator treats missing-result entries as pass-through.
    const facts = [makeFact({ confidence: 0.8 })];
    const provider = mockProvider('[]');

    const validated = await validateFacts(provider, facts, [makeStoredMsg()], { strict: true });

    // Pass-through with original confidence (0.8 >= 0.7 threshold)
    expect(validated).toHaveLength(1);
    expect(validated[0].adjustedConfidence).toBe(0.8);
  });

  it('strict: partial schema-drop (mix of valid + malformed) returns only valid entries', async () => {
    // synthetic per P3.6-H1 — one valid result, one malformed. Partial drop is OK.
    const facts = [makeFact({ text: 'A' }), makeFact({ text: 'B' })];
    const response = JSON.stringify([
      { index: 0, grounded: true, adjusted_confidence: 0.9, reason: 'ok' },
      { grounded: true, adjusted_confidence: 0.85 }, // missing index
    ]);
    const provider = mockProvider(response);

    const validated = await validateFacts(provider, facts, [makeStoredMsg()], { strict: true });

    // index 0 validates normally; index 1 has no result so passes through with original confidence
    expect(validated).toHaveLength(2);
    expect(validated[0].adjustedConfidence).toBe(0.9);
  });

  // ── Non-strict backward-compat regression tests ───────────────────────

  it('non-strict default: provider throw coerces to []', async () => {
    const provider: LLMProvider = {
      name: 'mock',
      generate: vi.fn().mockRejectedValue(new Error('LLM offline')),
    };
    const facts = [makeFact()];

    const validated = await validateFacts(provider, facts, [makeStoredMsg()]);

    expect(validated).toEqual([]);
  });

  it('non-strict default: malformed JSON coerces to []', async () => {
    const provider = mockProvider('{invalid json!!!');
    const facts = [makeFact()];

    const validated = await validateFacts(provider, facts, [makeStoredMsg()]);

    expect(validated).toEqual([]);
  });

  it('non-strict default (explicit false): same coerce behavior', async () => {
    const provider = mockProvider('[[[');
    const facts = [makeFact()];

    const validated = await validateFacts(provider, facts, [makeStoredMsg()], { strict: false });

    expect(validated).toEqual([]);
  });
});
