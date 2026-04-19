// P3.6-H3 evidence-only probe: end-to-end strict-mode extractFacts against
// three Ollama models. DO NOT COMMIT. Ephemeral tooling.
//
// Usage (invoked per-model by the orchestrator because config.models.extraction
// is resolved at import-time from EXTRACTION_MODEL):
//
//   EXTRACTION_MODEL=<candidate> \
//   OPENAI_BASE_URL=http://localhost:11434/v1 \
//   OPENAI_API_KEY=ollama-placeholder \
//   npx tsx scripts/p36-h3-ollama-probe.ts <candidate-label>
//
// The script runs one model, writes a per-model JSON record to stdout, and
// exits 0 on extracted/error/timeout (all loud). The orchestrator aggregates.

import { createOpenAIProvider } from '../src/runtimes/chat/providers/openai.ts';
import {
  extractFacts,
  ExtractionError,
} from '../src/runtimes/chat/enrichment/extractor.ts';
import type { StoredMessage } from '../src/core/messages.ts';

const candidate = process.argv[2] ?? process.env.EXTRACTION_MODEL ?? 'unknown';

// synthetic per P3.6-H3 — no PII. Fictional actors, fabricated facts.
const syntheticBatch: StoredMessage[] = [
  {
    pk: 1001,
    chatJid: 'test-p36h3@s.whatsapp.net',
    conversationKey: 'test-p36h3',
    senderJid: 'alice-fictional@s.whatsapp.net',
    senderName: 'Alice Fictional',
    messageId: 'p36h3-msg-1',
    content: 'I use Asana for project tracking at the new job.',
    contentType: 'text',
    isFromMe: false,
    timestamp: 1744800000,
    quotedMessageId: null,
    enrichmentProcessedAt: null,
    enrichmentRetries: 0,
    createdAt: '2026-04-16T00:00:00Z',
    mediaPath: null,
    contentText: null,
  },
  {
    pk: 1002,
    chatJid: 'test-p36h3@s.whatsapp.net',
    conversationKey: 'test-p36h3',
    senderJid: 'bob-fictional@s.whatsapp.net',
    senderName: 'Bob Fictional',
    messageId: 'p36h3-msg-2',
    content: 'Alice prefers morning meetings before 10am.',
    contentType: 'text',
    isFromMe: false,
    timestamp: 1744800060,
    quotedMessageId: null,
    enrichmentProcessedAt: null,
    enrichmentRetries: 0,
    createdAt: '2026-04-16T00:01:00Z',
    mediaPath: null,
    contentText: null,
  },
  {
    pk: 1003,
    chatJid: 'test-p36h3@s.whatsapp.net',
    conversationKey: 'test-p36h3',
    senderJid: 'carol-fictional@s.whatsapp.net',
    senderName: 'Carol Fictional',
    messageId: 'p36h3-msg-3',
    content: 'Our Q2 release is scheduled for 2026-06-15.',
    contentType: 'text',
    isFromMe: false,
    timestamp: 1744800120,
    quotedMessageId: null,
    enrichmentProcessedAt: null,
    enrichmentRetries: 0,
    createdAt: '2026-04-16T00:02:00Z',
    mediaPath: null,
    contentText: null,
  },
  {
    pk: 1004,
    chatJid: 'test-p36h3@s.whatsapp.net',
    conversationKey: 'test-p36h3',
    senderJid: 'dave-fictional@s.whatsapp.net',
    senderName: 'Dave Fictional',
    messageId: 'p36h3-msg-4',
    content: 'Our Series A closed at $12M in March.',
    contentType: 'text',
    isFromMe: false,
    timestamp: 1744800180,
    quotedMessageId: null,
    enrichmentProcessedAt: null,
    enrichmentRetries: 0,
    createdAt: '2026-04-16T00:03:00Z',
    mediaPath: null,
    contentText: null,
  },
  {
    pk: 1005,
    chatJid: 'test-p36h3@s.whatsapp.net',
    conversationKey: 'test-p36h3',
    senderJid: 'eve-fictional@s.whatsapp.net',
    senderName: 'Eve Fictional',
    messageId: 'p36h3-msg-5',
    content: 'Remember Bob likes his coffee black, no sugar.',
    contentType: 'text',
    isFromMe: false,
    timestamp: 1744800240,
    quotedMessageId: null,
    enrichmentProcessedAt: null,
    enrichmentRetries: 0,
    createdAt: '2026-04-16T00:04:00Z',
    mediaPath: null,
    contentText: null,
  },
];

// Per-call watchdog; 5 min budget per spec.
const PER_MODEL_TIMEOUT_MS = 5 * 60 * 1000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('PROBE_TIMEOUT')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

interface ProbeResult {
  model: string;
  outcome: 'extracted' | 'error' | 'timeout';
  facts?: unknown[];
  factCount?: number;
  error?: {
    type: string;
    stage?: string;
    message: string;
    details?: Record<string, unknown>;
  };
  elapsed_ms: number;
}

async function run(): Promise<number> {
  const start = Date.now();
  let result: ProbeResult;
  try {
    const provider = createOpenAIProvider();
    const facts = await withTimeout(
      extractFacts(provider, syntheticBatch, { strict: true }),
      PER_MODEL_TIMEOUT_MS,
    );
    const elapsed = Date.now() - start;
    result = {
      model: candidate,
      outcome: 'extracted',
      facts,
      factCount: facts.length,
      elapsed_ms: elapsed,
    };
  } catch (err) {
    const elapsed = Date.now() - start;
    if (err instanceof Error && err.message === 'PROBE_TIMEOUT') {
      result = {
        model: candidate,
        outcome: 'timeout',
        error: { type: 'Timeout', message: `exceeded ${PER_MODEL_TIMEOUT_MS}ms` },
        elapsed_ms: elapsed,
      };
    } else if (err instanceof ExtractionError) {
      result = {
        model: candidate,
        outcome: 'error',
        error: {
          type: 'ExtractionError',
          stage: err.stage,
          message: err.message,
          details: {
            droppedCount: err.details.droppedCount,
            totalCount: err.details.totalCount,
            rawOutput: err.details.rawOutput,
            sampleItem: err.details.sampleItem,
            causeMessage:
              err.details.cause instanceof Error ? err.details.cause.message : undefined,
          },
        },
        elapsed_ms: elapsed,
      };
    } else {
      // Any other error is still "loud" — record it as error (not a silent []).
      const e = err instanceof Error ? err : new Error(String(err));
      result = {
        model: candidate,
        outcome: 'error',
        error: { type: e.name ?? 'Error', message: e.message },
        elapsed_ms: elapsed,
      };
    }
  }

  // One-line machine-readable record; orchestrator aggregates.
  process.stdout.write('P36H3_RESULT ' + JSON.stringify(result) + '\n');

  // Exit 0 if loud (extracted / error / timeout). Exit 1 only on silent [].
  if (result.outcome === 'extracted' && result.factCount === 0) {
    // This would indicate strict mode leaked — a legitimate "[]" came back.
    // The spec treats this as the single failure mode.
    process.stdout.write('P36H3_VERDICT SILENT_EMPTY\n');
    return 1;
  }
  return 0;
}

run().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write('probe crashed: ' + String(err) + '\n');
    process.exit(2);
  },
);
