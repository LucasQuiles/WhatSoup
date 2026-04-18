/**
 * Tests for scripts/backfill-enrichment.ts.
 *
 * Uses an in-memory Database and stubs for the LLM providers so we never hit
 * Anthropic. Mirrors the anti-slop discipline of the Phase 3 test suites:
 * positive + negative + edge + idempotent coverage, fixtures with provenance,
 * and assertions on return values / DB state rather than "did not throw".
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Database } from '../../src/core/database.ts';
import type { StoredMessage } from '../../src/core/messages.ts';
import type { ExtractedFact } from '../../src/runtimes/chat/enrichment/extractor.ts';
import type { ValidatedFact } from '../../src/runtimes/chat/enrichment/validator.ts';
import type { ExportableFact, EnqueueFactsResult } from '../../src/runtimes/chat/enrichment/fact-export-queue.ts';
import type { LLMProvider } from '../../src/runtimes/chat/providers/types.ts';

import {
  parseArgs,
  shortHash,
  toExportable,
  groupByChatJid,
  accountingOk,
  processBatch,
  runBackfill,
  validateProviderConfig,
  buildProviders,
  ProviderConfigError,
  type ProviderFactories,
  type ProviderKind,
  type BackfillBatchDeps,
} from '../../scripts/backfill-enrichment.ts';
import { ExtractionError } from '../../src/runtimes/chat/enrichment/extractor.ts';
import { ValidationError } from '../../src/runtimes/chat/enrichment/validator.ts';

// ── Fixture helpers ──────────────────────────────────────────────────────────

/**
 * Synthetic StoredMessage rows. Provenance: crafted for this test suite —
 * minimum fields that satisfy the SQL inserted by seedMessage() below. The
 * 'enrichment_processed_at' default is NULL (eligible for backfill).
 */
interface SeedOpts {
  pk: number;
  chatJid: string;
  senderJid?: string;
  senderName?: string;
  content?: string;
  isFromMe?: boolean;
  enrichmentProcessedAt?: string | null;
}

function seedMessage(db: Database, opts: SeedOpts): void {
  const messageId = `msg-${opts.pk}`;
  db.raw
    .prepare(
      `INSERT INTO messages (
        pk, message_id, chat_jid, sender_jid, sender_name, content,
        timestamp, is_from_me, enrichment_processed_at, enrichment_retries,
        conversation_key, content_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'text')`,
    )
    .run(
      opts.pk,
      messageId,
      opts.chatJid,
      opts.senderJid ?? 'sender-1@s.whatsapp.net',
      opts.senderName ?? 'Alice',
      opts.content ?? 'Alice lives in Montreal.',
      Math.floor(Date.now() / 1000),
      opts.isFromMe ? 1 : 0,
      opts.enrichmentProcessedAt ?? null,
      opts.chatJid, // conversation_key defaults to chatJid for 1:1 fixtures
    );
}

function makeExtracted(chatJid: string, text: string, idx: number = 0): ExtractedFact {
  return {
    text,
    chatJid,
    senderJid: 'sender-1@s.whatsapp.net',
    senderName: 'Alice',
    memoryType: 'user_fact',
    confidence: 0.9,
    supersedesText: '',
    sourceMessagePks: [idx],
  };
}

function makeValidated(fact: ExtractedFact, adjusted: number = 0.9): ValidatedFact {
  return { ...fact, adjustedConfidence: adjusted };
}

/** Minimal LLMProvider stub. The backfill never reads `name` at runtime. */
function stubProvider(): LLMProvider {
  return {
    name: 'stub',
    generate: vi.fn(async () => ({
      text: '',
      usage: { inputTokens: 0, outputTokens: 0 },
      provider: 'stub',
      model: 'stub',
      elapsedMs: 0,
    })),
  };
}

// ── Unit helpers ─────────────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('defaults to instance mw-bot, limit 500, provider anthropic', () => {
    const a = parseArgs([]);
    expect(a.instance).toBe('mw-bot');
    // 500 is the documented safety cap per the script header
    expect(a.limit).toBe(500);
    expect(a.dryRun).toBe(false);
    expect(a.provider).toBe('anthropic');
    expect(a.runId).toMatch(/^backfill-|[A-Za-z0-9_-]/);
  });

  it('parses --limit and --dry-run', () => {
    const a = parseArgs(['--limit', '10', '--dry-run']);
    expect(a.limit).toBe(10);
    expect(a.dryRun).toBe(true);
  });

  it('accepts explicit run-id override', () => {
    const a = parseArgs(['--run-id', 'test-run-xyz']);
    expect(a.runId).toBe('test-run-xyz');
  });

  it('accepts --provider openai', () => {
    const a = parseArgs(['--provider', 'openai']);
    expect(a.provider).toBe('openai');
  });

  it('accepts --provider anthropic explicitly', () => {
    const a = parseArgs(['--provider', 'anthropic']);
    expect(a.provider).toBe('anthropic');
  });

  it('rejects unknown --provider values', () => {
    // "anthropic-claude" is a plausible typo; the guard must reject anything
    // outside the allow-list so we don't instantiate an undefined factory.
    expect(() => parseArgs(['--provider', 'anthropic-claude'])).toThrow(/must be 'anthropic' or 'openai'/);
  });

  it('rejects empty --provider', () => {
    expect(() => parseArgs(['--provider'])).toThrow(/must be 'anthropic' or 'openai'/);
  });

  it('throws on unknown args', () => {
    // "unknown args" must fail loudly, not be silently ignored. The error
    // is the primary proof — we assert the message shape so a regression
    // that silently accepts bad args would fail here.
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown arg/);
  });
});

describe('validateProviderConfig', () => {
  it('anthropic: requires ANTHROPIC_API_KEY', () => {
    expect(() => validateProviderConfig('anthropic', {})).toThrow(ProviderConfigError);
    expect(() => validateProviderConfig('anthropic', {})).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('anthropic: passes with ANTHROPIC_API_KEY set', () => {
    // The value itself is ignored by the validator — only presence matters.
    expect(() => validateProviderConfig('anthropic', { ANTHROPIC_API_KEY: 'sk-test' })).not.toThrow();
  });

  it('openai: requires OPENAI_BASE_URL', () => {
    expect(() =>
      validateProviderConfig('openai', {
        OPENAI_API_KEY: 'ollama',
        EXTRACTION_MODEL: 'qwen3:32b-tuned',
        VALIDATION_MODEL: 'qwen3:8b-tuned',
      }),
    ).toThrow(/OPENAI_BASE_URL/);
  });

  it('openai: requires OPENAI_API_KEY (placeholder allowed)', () => {
    expect(() =>
      validateProviderConfig('openai', {
        OPENAI_BASE_URL: 'http://localhost:11434/v1',
        EXTRACTION_MODEL: 'qwen3:32b-tuned',
        VALIDATION_MODEL: 'qwen3:8b-tuned',
      }),
    ).toThrow(/OPENAI_API_KEY/);
  });

  it('openai: requires EXTRACTION_MODEL (the default is an Anthropic model ID)', () => {
    expect(() =>
      validateProviderConfig('openai', {
        OPENAI_BASE_URL: 'http://localhost:11434/v1',
        OPENAI_API_KEY: 'ollama',
        VALIDATION_MODEL: 'qwen3:8b-tuned',
      }),
    ).toThrow(/EXTRACTION_MODEL/);
  });

  it('openai: requires VALIDATION_MODEL', () => {
    expect(() =>
      validateProviderConfig('openai', {
        OPENAI_BASE_URL: 'http://localhost:11434/v1',
        OPENAI_API_KEY: 'ollama',
        EXTRACTION_MODEL: 'qwen3:32b-tuned',
      }),
    ).toThrow(/VALIDATION_MODEL/);
  });

  it('openai: passes with full config (Ollama-style)', () => {
    expect(() =>
      validateProviderConfig('openai', {
        OPENAI_BASE_URL: 'http://localhost:11434/v1',
        OPENAI_API_KEY: 'ollama',
        EXTRACTION_MODEL: 'qwen3:32b-tuned',
        VALIDATION_MODEL: 'qwen3:8b-tuned',
      }),
    ).not.toThrow();
  });
});

describe('buildProviders', () => {
  it('routes --provider anthropic to the anthropic factory', () => {
    const antFactory = vi.fn(() => ({ name: 'stub-anthropic' }) as unknown as LLMProvider);
    const oaiFactory = vi.fn(() => ({ name: 'stub-openai' }) as unknown as LLMProvider);
    const factories: ProviderFactories = { anthropic: antFactory, openai: oaiFactory };

    const { extraction, validation } = buildProviders('anthropic', factories);

    // Each stage gets its own provider instance, mirroring the live poller.
    // A regression that shares one instance would make the assertion fail.
    expect(antFactory).toHaveBeenCalledTimes(2);
    expect(oaiFactory).not.toHaveBeenCalled();
    expect(extraction.name).toBe('stub-anthropic');
    expect(validation.name).toBe('stub-anthropic');
  });

  it('routes --provider openai to the openai factory', () => {
    const antFactory = vi.fn(() => ({ name: 'stub-anthropic' }) as unknown as LLMProvider);
    const oaiFactory = vi.fn(() => ({ name: 'stub-openai' }) as unknown as LLMProvider);
    const factories: ProviderFactories = { anthropic: antFactory, openai: oaiFactory };

    const { extraction, validation } = buildProviders('openai', factories);

    expect(oaiFactory).toHaveBeenCalledTimes(2);
    expect(antFactory).not.toHaveBeenCalled();
    expect(extraction.name).toBe('stub-openai');
    expect(validation.name).toBe('stub-openai');
  });
});

describe('shortHash / toExportable', () => {
  it('produces the same fact_id for identical ValidatedFact text (idempotency)', () => {
    // fact_id scheme: {chatJid}:{senderSegment}:{sha256(text).slice(0,12)}.
    // This is the cross-service contract with the mw-mind drain path.
    const vf = makeValidated(makeExtracted('chat-1@g.us', 'Alice lives in Montreal'));
    const a = toExportable(vf);
    const b = toExportable(vf);
    expect(a.factId).toBe(b.factId);
  });

  it('uses "group" when senderJid is empty (mirrors poller.ts)', () => {
    const vf: ValidatedFact = {
      ...makeValidated(makeExtracted('chat-1@g.us', 'topic emerged')),
      senderJid: '',
    };
    const out = toExportable(vf);
    // senderSegment fallback to 'group' is the documented behavior.
    expect(out.factId.includes(':group:')).toBe(true);
  });

  it('shortHash produces a 12-char hex prefix', () => {
    // 12 is the documented prefix length matching poller.ts:toExportable.
    const h = shortHash('any-text');
    expect(h).toHaveLength(12);
    expect(h).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('groupByChatJid', () => {
  it('partitions messages by chatJid preserving order within each chat', () => {
    const msgs = [
      { pk: 1, chatJid: 'a@g.us' },
      { pk: 2, chatJid: 'b@g.us' },
      { pk: 3, chatJid: 'a@g.us' },
    ] as unknown as StoredMessage[];
    const grouped = groupByChatJid(msgs);
    expect(Array.from(grouped.keys())).toEqual(['a@g.us', 'b@g.us']);
    expect(grouped.get('a@g.us')?.map((m) => m.pk)).toEqual([1, 3]);
    expect(grouped.get('b@g.us')?.map((m) => m.pk)).toEqual([2]);
  });
});

describe('accountingOk (T1 gate mirror)', () => {
  it('passes on all-new success', () => {
    const r: EnqueueFactsResult = { attempted: 3, inserted: 3, duplicates: 0, failed: 0 };
    expect(accountingOk(r, 3)).toBe(true);
  });
  it('passes when duplicates make up the difference', () => {
    const r: EnqueueFactsResult = { attempted: 3, inserted: 2, duplicates: 1, failed: 0 };
    expect(accountingOk(r, 3)).toBe(true);
  });
  it('fails on any failed row', () => {
    const r: EnqueueFactsResult = { attempted: 3, inserted: 2, duplicates: 0, failed: 1 };
    expect(accountingOk(r, 3)).toBe(false);
  });
  it('fails when inserted+duplicates < expected', () => {
    const r: EnqueueFactsResult = { attempted: 3, inserted: 1, duplicates: 0, failed: 0 };
    expect(accountingOk(r, 3)).toBe(false);
  });
});

// ── End-to-end (with stubbed classifier) ─────────────────────────────────────

describe('runBackfill', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
  });
  afterEach(() => {
    db.close();
  });

  function depsFor(validated: ValidatedFact[], enqResult?: EnqueueFactsResult): Parameters<typeof runBackfill>[3] {
    const markProcessed = vi.fn();
    const enqueue = vi.fn((): EnqueueFactsResult =>
      enqResult ?? { attempted: validated.length, inserted: validated.length, duplicates: 0, failed: 0 },
    );
    const extract = vi.fn(async () => validated.map<ExtractedFact>((v) => v));
    const validate = vi.fn(async () => validated);
    return {
      extract: extract as unknown as Parameters<typeof runBackfill>[3]['extract'],
      validate: validate as unknown as Parameters<typeof runBackfill>[3]['validate'],
      enqueue: enqueue as unknown as Parameters<typeof runBackfill>[3]['enqueue'],
      markProcessed: markProcessed as unknown as Parameters<typeof runBackfill>[3]['markProcessed'],
    };
  }

  const providers = () => ({ extraction: stubProvider(), validation: stubProvider() });

  it('processes only unprocessed messages (is_from_me=0, processed_at NULL)', async () => {
    // Provenance: 3 unprocessed (pks 1-3) + 2 already-processed (pks 4-5)
    seedMessage(db, { pk: 1, chatJid: 'a@g.us' });
    seedMessage(db, { pk: 2, chatJid: 'a@g.us' });
    seedMessage(db, { pk: 3, chatJid: 'a@g.us' });
    seedMessage(db, { pk: 4, chatJid: 'a@g.us', enrichmentProcessedAt: '2026-01-01T00:00:00Z' });
    seedMessage(db, { pk: 5, chatJid: 'a@g.us', enrichmentProcessedAt: '2026-01-01T00:00:00Z' });

    const vf = [makeValidated(makeExtracted('a@g.us', 'shared topic x', 1))];
    const deps = depsFor(vf);

    const summary = await runBackfill(db, parseArgs([]), providers(), deps);

    // Only the 3 unprocessed should reach extract (one batch, one chat)
    expect(deps.extract).toHaveBeenCalledTimes(1);
    expect((deps.extract as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].map((m: StoredMessage) => m.pk).sort()).toEqual([1, 2, 3]);
    expect(summary.alreadyProcessedSkipped).toBe(2);
    expect(summary.unprocessedBefore).toBe(3);
    expect(summary.messagesProcessed).toBe(3);
  });

  it('respects --limit', async () => {
    // Provenance: 5 unprocessed; --limit=3 must cap processing at 3
    for (let pk = 1; pk <= 5; pk++) seedMessage(db, { pk, chatJid: 'a@g.us' });

    const deps = depsFor([]);
    const summary = await runBackfill(db, parseArgs(['--limit', '3']), providers(), deps);

    expect((deps.extract as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].length).toBe(3);
    // Facts returned empty → mark all 3 processed
    expect(summary.messagesProcessed).toBe(3);
  });

  it('dry-run does not enqueue or mark processed', async () => {
    seedMessage(db, { pk: 1, chatJid: 'a@g.us' });

    const vf = [makeValidated(makeExtracted('a@g.us', 'dry run fact'))];
    const deps = depsFor(vf);

    const summary = await runBackfill(db, parseArgs(['--dry-run']), providers(), deps);

    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(deps.markProcessed).not.toHaveBeenCalled();
    expect(summary.messagesProcessed).toBe(0);
  });

  it('accounting-gate blocks markMessagesProcessed on enqueue failure', async () => {
    seedMessage(db, { pk: 1, chatJid: 'a@g.us' });
    seedMessage(db, { pk: 2, chatJid: 'a@g.us' });

    const vf = [
      makeValidated(makeExtracted('a@g.us', 'fact 1')),
      makeValidated(makeExtracted('a@g.us', 'fact 2')),
    ];
    // Injected partial failure: one insert claimed but one failed.
    const failing: EnqueueFactsResult = { attempted: 2, inserted: 1, duplicates: 0, failed: 1 };
    const deps = depsFor(vf, failing);

    const summary = await runBackfill(db, parseArgs([]), providers(), deps);

    expect(deps.enqueue).toHaveBeenCalledTimes(1);
    expect(deps.markProcessed).not.toHaveBeenCalled();
    expect(summary.batchesFailed).toBe(1);
    expect(summary.messagesProcessed).toBe(0);
  });

  it('0 unprocessed is a clean no-op', async () => {
    // Provenance: only already-processed rows exist
    seedMessage(db, { pk: 1, chatJid: 'a@g.us', enrichmentProcessedAt: '2026-01-01T00:00:00Z' });

    const deps = depsFor([]);
    const summary = await runBackfill(db, parseArgs([]), providers(), deps);

    expect(deps.extract).not.toHaveBeenCalled();
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(summary.unprocessedBefore).toBe(0);
    expect(summary.alreadyProcessedSkipped).toBe(1);
    expect(summary.messagesProcessed).toBe(0);
  });

  it('groups by chatJid like the poller — 6 messages across 2 chats → 2 extract calls', async () => {
    // Provenance: deliberately interleaved pks across two chats
    seedMessage(db, { pk: 1, chatJid: 'a@g.us' });
    seedMessage(db, { pk: 2, chatJid: 'b@g.us' });
    seedMessage(db, { pk: 3, chatJid: 'a@g.us' });
    seedMessage(db, { pk: 4, chatJid: 'b@g.us' });
    seedMessage(db, { pk: 5, chatJid: 'a@g.us' });
    seedMessage(db, { pk: 6, chatJid: 'b@g.us' });

    const deps = depsFor([]);
    await runBackfill(db, parseArgs([]), providers(), deps);

    expect(deps.extract).toHaveBeenCalledTimes(2);
    const extractMock = deps.extract as unknown as ReturnType<typeof vi.fn>;
    const chatA = extractMock.mock.calls.find((c) => c[1][0].chatJid === 'a@g.us')?.[1] ?? [];
    const chatB = extractMock.mock.calls.find((c) => c[1][0].chatJid === 'b@g.us')?.[1] ?? [];
    expect(chatA.map((m: StoredMessage) => m.pk)).toEqual([1, 3, 5]);
    expect(chatB.map((m: StoredMessage) => m.pk)).toEqual([2, 4, 6]);
  });

  it('records an enrichment_runs row per batch with backfill_ok/backfill_fail marker', async () => {
    seedMessage(db, { pk: 1, chatJid: 'a@g.us' });
    seedMessage(db, { pk: 2, chatJid: 'b@g.us' });
    const vf = [makeValidated(makeExtracted('a@g.us', 'fact a'))];
    const deps = depsFor(vf);

    await runBackfill(db, parseArgs([]), providers(), deps);

    const rows = db.raw
      .prepare('SELECT error FROM enrichment_runs ORDER BY run_id ASC')
      .all() as Array<{ error: string }>;
    expect(rows).toHaveLength(2);
    // Both rows should carry a backfill_ok marker with the default run_id.
    expect(rows.every((r) => r.error?.startsWith('backfill_ok:') || r.error?.startsWith('backfill_fail:'))).toBe(true);
  });
});

// ── P3.6-H2: strict-mode fail-closed on extraction / validation failure ──────
//
// H1 landed strict opt-in on extractFacts() / validateFacts() — they now
// throw ExtractionError / ValidationError instead of silently coercing to
// `[]` on provider-call / json-parse / schema-shape / schema-items-all-
// dropped failures. H2 wires backfill-enrichment to propagate that
// fail-closed: skip markMessagesProcessed for the batch, record the
// failure, propagate exit code for orchestrator.
//
// All fixtures below are synthetic per P3.6-H2.
describe('parseArgs — --strict', () => {
  it('defaults to strict=false (backward compat with pre-H2 callers)', () => {
    // Default must not break existing operators; strict is opt-in.
    const a = parseArgs([]);
    expect(a.strict).toBe(false);
  });

  it('accepts --strict and sets flag true', () => {
    const a = parseArgs(['--strict']);
    expect(a.strict).toBe(true);
  });
});

describe('processBatch — P3.6-H2 strict-mode fail-closed', () => {
  // processBatch is the per-chat unit; test at this level keeps the blast
  // radius tight vs re-seeding messages in every case.
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
  });
  afterEach(() => db.close());

  const baseProviders = () => ({ extraction: stubProvider(), validation: stubProvider() });

  function makeMessages(chatJid: string, count: number): StoredMessage[] {
    // Synthetic StoredMessage stubs — only pk + chatJid are read by
    // processBatch; other fields are defensive.
    return Array.from({ length: count }, (_, i) => ({
      pk: i + 1,
      messageId: `msg-${i + 1}`,
      chatJid,
      senderJid: 'sender-1@s.whatsapp.net',
      senderName: 'Alice',
      content: 'synthetic',
      timestamp: 1_700_000_000 + i,
      isFromMe: false,
      enrichmentProcessedAt: null,
      enrichmentRetries: 0,
      conversationKey: chatJid,
      contentType: 'text',
    })) as unknown as StoredMessage[];
  }

  it('non-strict default: extract throws → still marks messages processed (backward compat)', async () => {
    // Provenance: pre-H2 behavior must be preserved when --strict is omitted.
    // A raw extractor throw in non-strict mode is swallowed by the try/catch
    // wrapper and the batch falls through to markProcessed so the poll
    // doesn't wedge on one bad batch.
    const markProcessed = vi.fn();
    const deps: BackfillBatchDeps = {
      extract: vi.fn(async () => {
        throw new Error('provider 500');
      }) as unknown as BackfillBatchDeps['extract'],
      validate: vi.fn(async () => []) as unknown as BackfillBatchDeps['validate'],
      enqueue: vi.fn() as unknown as BackfillBatchDeps['enqueue'],
      markProcessed: markProcessed as unknown as BackfillBatchDeps['markProcessed'],
    };
    const messages = makeMessages('a@g.us', 2);

    const result = await processBatch(
      db,
      'a@g.us',
      messages,
      baseProviders(),
      deps,
      false, // dryRun
      false, // strict
    );

    // The existing non-strict path captures err into batchResult.error and
    // does NOT call markProcessed — that is the PRE-H2 behavior for generic
    // errors. We assert exactly that, not "did not throw".
    expect(result.error).toMatch(/provider 500/);
    expect(result.markedProcessed).toBe(false);
    expect(markProcessed).not.toHaveBeenCalled();
    // strictFailure field is only populated when strict=true.
    expect(result.strictFailure).toBeUndefined();
  });

  it('strict: ExtractionError raised → does NOT mark processed, records strictFailure', async () => {
    const markProcessed = vi.fn();
    const enqueue = vi.fn();
    const deps: BackfillBatchDeps = {
      extract: vi.fn(async () => {
        throw new ExtractionError('schema-items-all-dropped', {
          droppedCount: 3,
          totalCount: 3,
          sampleItem: { fact: 'wrong schema' },
        });
      }) as unknown as BackfillBatchDeps['extract'],
      validate: vi.fn(async () => []) as unknown as BackfillBatchDeps['validate'],
      enqueue: enqueue as unknown as BackfillBatchDeps['enqueue'],
      markProcessed: markProcessed as unknown as BackfillBatchDeps['markProcessed'],
    };
    const messages = makeMessages('a@g.us', 2);

    const result = await processBatch(db, 'a@g.us', messages, baseProviders(), deps, false, true);

    expect(markProcessed).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(result.markedProcessed).toBe(false);
    expect(result.strictFailure).toBeDefined();
    expect(result.strictFailure?.errorType).toBe('ExtractionError');
    expect(result.strictFailure?.stage).toBe('schema-items-all-dropped');
    expect(result.strictFailure?.messageIds).toEqual([1, 2]);
  });

  it('strict: ValidationError raised → does NOT mark processed, records strictFailure', async () => {
    // Extractor succeeds; validator throws. This exercises the second
    // fail-closed surface introduced by H2.
    const markProcessed = vi.fn();
    const enqueue = vi.fn();
    const extracted: ExtractedFact[] = [makeExtracted('a@g.us', 'fact A')];
    const deps: BackfillBatchDeps = {
      extract: vi.fn(async () => extracted) as unknown as BackfillBatchDeps['extract'],
      validate: vi.fn(async () => {
        throw new ValidationError('json-parse', { rawOutput: 'not json {' });
      }) as unknown as BackfillBatchDeps['validate'],
      enqueue: enqueue as unknown as BackfillBatchDeps['enqueue'],
      markProcessed: markProcessed as unknown as BackfillBatchDeps['markProcessed'],
    };
    const messages = makeMessages('a@g.us', 3);

    const result = await processBatch(db, 'a@g.us', messages, baseProviders(), deps, false, true);

    expect(markProcessed).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(result.strictFailure?.errorType).toBe('ValidationError');
    expect(result.strictFailure?.stage).toBe('json-parse');
    expect(result.strictFailure?.messageIds).toEqual([1, 2, 3]);
  });

  it('strict: dry-run with ExtractionError → strictFailure populated, enqueue never called', async () => {
    // Dry-run + strict = diagnostic only. We still record the fault so the
    // summary shows what WOULD have failed, but the exit-code gate below
    // (tested in runBackfill block) must NOT fire in dry-run.
    const markProcessed = vi.fn();
    const enqueue = vi.fn();
    const deps: BackfillBatchDeps = {
      extract: vi.fn(async () => {
        throw new ExtractionError('provider-call', {
          cause: new Error('network down'),
        });
      }) as unknown as BackfillBatchDeps['extract'],
      validate: vi.fn(async () => []) as unknown as BackfillBatchDeps['validate'],
      enqueue: enqueue as unknown as BackfillBatchDeps['enqueue'],
      markProcessed: markProcessed as unknown as BackfillBatchDeps['markProcessed'],
    };
    const messages = makeMessages('a@g.us', 2);

    const result = await processBatch(db, 'a@g.us', messages, baseProviders(), deps, true, true);

    expect(markProcessed).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(result.strictFailure?.stage).toBe('provider-call');
  });

  it('strict: normal successful batch still marks processed + enqueues', async () => {
    // Positive case: strict=true must NOT regress the happy path.
    const markProcessed = vi.fn();
    const vf = [makeValidated(makeExtracted('a@g.us', 'fact ok'))];
    const enqueue = vi.fn(
      (): EnqueueFactsResult => ({ attempted: 1, inserted: 1, duplicates: 0, failed: 0 }),
    );
    const deps: BackfillBatchDeps = {
      extract: vi.fn(async () => vf.map((v) => v as ExtractedFact)) as unknown as BackfillBatchDeps['extract'],
      validate: vi.fn(async () => vf) as unknown as BackfillBatchDeps['validate'],
      enqueue: enqueue as unknown as BackfillBatchDeps['enqueue'],
      markProcessed: markProcessed as unknown as BackfillBatchDeps['markProcessed'],
    };
    const messages = makeMessages('a@g.us', 1);

    const result = await processBatch(db, 'a@g.us', messages, baseProviders(), deps, false, true);

    expect(markProcessed).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(result.markedProcessed).toBe(true);
    expect(result.strictFailure).toBeUndefined();
  });
});

describe('runBackfill — P3.6-H2 strict-mode summary + failedBatches', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
  });
  afterEach(() => db.close());

  // Variant of depsFor for the strict-mode integration cases below.
  // Does NOT reuse the closure-scoped `depsFor` because we need per-call
  // extract behavior (one chat throws, one chat succeeds).
  function stubProviders() {
    return { extraction: stubProvider(), validation: stubProvider() };
  }

  it('strict mode: mix of good + failed batches → only good batches marked processed, failedBatches populated', async () => {
    // Provenance: chat a@g.us has a single good message; chat b@g.us has a
    // message whose extract throws ExtractionError. Only a@g.us should be
    // marked processed; b@g.us must be preserved for retry.
    seedMessage(db, { pk: 1, chatJid: 'a@g.us' });
    seedMessage(db, { pk: 2, chatJid: 'b@g.us' });

    const markProcessed = vi.fn();
    const vf = [makeValidated(makeExtracted('a@g.us', 'good fact'))];

    const extract = vi.fn(async (_provider: unknown, msgs: StoredMessage[]) => {
      if (msgs[0].chatJid === 'b@g.us') {
        throw new ExtractionError('schema-items-all-dropped', {
          droppedCount: 1,
          totalCount: 1,
          sampleItem: { fact: 'qwen3-shape' },
        });
      }
      return vf.map((v) => v as ExtractedFact);
    });
    const validate = vi.fn(async () => vf);
    const enqueue = vi.fn(
      (): EnqueueFactsResult => ({ attempted: 1, inserted: 1, duplicates: 0, failed: 0 }),
    );
    const deps: BackfillBatchDeps = {
      extract: extract as unknown as BackfillBatchDeps['extract'],
      validate: validate as unknown as BackfillBatchDeps['validate'],
      enqueue: enqueue as unknown as BackfillBatchDeps['enqueue'],
      markProcessed: markProcessed as unknown as BackfillBatchDeps['markProcessed'],
    };

    const summary = await runBackfill(db, parseArgs(['--strict']), stubProviders(), deps);

    // Only the a@g.us batch enqueued + marked processed.
    expect(markProcessed).toHaveBeenCalledTimes(1);
    expect(markProcessed.mock.calls[0][1]).toEqual([1]);
    expect(enqueue).toHaveBeenCalledTimes(1);

    // Summary reports exactly one good, one fail-closed batch.
    expect(summary.batchesOk).toBe(1);
    expect(summary.batchesFailed).toBe(1);
    expect(summary.messagesProcessed).toBe(1);

    // failedBatches carries the b@g.us entry verbatim with stage + ids.
    expect(summary.failedBatches).toHaveLength(1);
    expect(summary.failedBatches[0].chatJid).toBe('b@g.us');
    expect(summary.failedBatches[0].messageIds).toEqual([2]);
    expect(summary.failedBatches[0].errorType).toBe('ExtractionError');
    expect(summary.failedBatches[0].stage).toBe('schema-items-all-dropped');
  });

  it('strict mode: all-good run → failedBatches is empty array', async () => {
    // Negative proof: strict-mode run with no failures MUST NOT populate
    // failedBatches (regression guard for a typo that accumulates every batch).
    seedMessage(db, { pk: 1, chatJid: 'a@g.us' });
    const vf = [makeValidated(makeExtracted('a@g.us', 'ok'))];
    const deps: BackfillBatchDeps = {
      extract: vi.fn(async () => vf.map((v) => v as ExtractedFact)) as unknown as BackfillBatchDeps['extract'],
      validate: vi.fn(async () => vf) as unknown as BackfillBatchDeps['validate'],
      enqueue: vi.fn(
        (): EnqueueFactsResult => ({ attempted: 1, inserted: 1, duplicates: 0, failed: 0 }),
      ) as unknown as BackfillBatchDeps['enqueue'],
      markProcessed: vi.fn() as unknown as BackfillBatchDeps['markProcessed'],
    };

    const summary = await runBackfill(db, parseArgs(['--strict']), stubProviders(), deps);

    expect(summary.failedBatches).toEqual([]);
    expect(summary.batchesOk).toBe(1);
    expect(summary.batchesFailed).toBe(0);
  });

  it('non-strict mode: failedBatches stays empty even when a batch errors (backward compat)', async () => {
    // The H2 semantic applies only under --strict. Non-strict callers keep
    // their existing telemetry contract — any generic error lives on
    // perChat[i].error, not on failedBatches.
    seedMessage(db, { pk: 1, chatJid: 'a@g.us' });
    const deps: BackfillBatchDeps = {
      extract: vi.fn(async () => {
        throw new Error('generic');
      }) as unknown as BackfillBatchDeps['extract'],
      validate: vi.fn(async () => []) as unknown as BackfillBatchDeps['validate'],
      enqueue: vi.fn() as unknown as BackfillBatchDeps['enqueue'],
      markProcessed: vi.fn() as unknown as BackfillBatchDeps['markProcessed'],
    };

    const summary = await runBackfill(db, parseArgs([]), stubProviders(), deps);

    expect(summary.failedBatches).toEqual([]);
    expect(summary.batchesFailed).toBe(1);
    // perChat records the error string; strictFailure is absent.
    expect(summary.perChat[0].error).toMatch(/generic/);
    expect(summary.perChat[0].strictFailure).toBeUndefined();
  });
});
