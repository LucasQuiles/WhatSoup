// P3.6-H4 local-only pipeline proof: extract + validate against Ollama,
// with Anthropic/OpenAI keys explicitly scrubbed and HTTPS/HTTP outbound
// monkey-patched so any leak to api.openai.com / api.anthropic.com is caught.
//
// DO NOT COMMIT. Ephemeral evidence tooling.
//
// Usage:
//   env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY \
//     ANTHROPIC_API_KEY="" \
//     OPENAI_API_KEY="ollama-placeholder" \
//     OPENAI_BASE_URL="http://localhost:11434/v1" \
//     EXTRACTION_MODEL="gemma3:27b" \
//     VALIDATION_MODEL="gemma3:27b" \
//     timeout 600 npx tsx scripts/p36-h4-local-pipeline-proof.ts
//
// NOTE on "empty" keys: OpenAI SDK 5.23 throws in the ctor when apiKey is
// strictly empty/undefined. The no-key invariant this proof establishes is:
//   (a) ANTHROPIC_API_KEY is empty/unset,
//   (b) OPENAI_API_KEY is a non-secret placeholder (length < 20, not sk-),
//   (c) OPENAI_BASE_URL points at Ollama localhost,
//   (d) no outbound HTTPS to api.openai.com / api.anthropic.com during run.
// (a)+(b)+(c) are asserted at startup; (d) is proven by the monkey-patch log.

import { writeFileSync, mkdirSync } from 'node:fs';

// ---------- (d) Outbound witness — patch globalThis.fetch which is what
// OpenAI SDK 5.x uses (see node_modules/openai/src/internal/shims.ts).
// Node 25 ESM makes node:http/node:https module namespaces frozen, so we
// cannot rebind those module exports; the SDK's HTTP path runs through
// fetch anyway, so fetch is the right seam for this proof.

interface OutboundRecord {
  host: string;
  port: number | string | undefined;
  path: string;
  method: string;
  stack: string;
  when: string;
}

const outboundCalls: OutboundRecord[] = [];

function recordOutboundFromUrl(urlStr: string, method: string): void {
  try {
    const u = new URL(urlStr);
    const err = new Error('stack-capture');
    const stack = (err.stack ?? '').split('\n').slice(1, 6).join(' | ');
    outboundCalls.push({
      host: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      stack,
      when: new Date().toISOString(),
    });
  } catch {
    outboundCalls.push({
      host: urlStr,
      port: undefined,
      path: '',
      method,
      stack: '',
      when: new Date().toISOString(),
    });
  }
}

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  let urlStr: string;
  let method = 'GET';
  if (typeof input === 'string') {
    urlStr = input;
  } else if (input instanceof URL) {
    urlStr = input.toString();
  } else if (input && typeof (input as Request).url === 'string') {
    urlStr = (input as Request).url;
    method = (input as Request).method ?? 'GET';
  } else {
    urlStr = String(input);
  }
  if (init?.method) method = init.method;
  recordOutboundFromUrl(urlStr, method);
  return originalFetch(input as RequestInfo, init);
}) as typeof globalThis.fetch;

// ---------- (a,b,c) Env invariants ----------
{
  const anthro = process.env.ANTHROPIC_API_KEY;
  if (anthro && anthro.length > 0) {
    throw new Error(
      `P3.6-H4 invariant violation: ANTHROPIC_API_KEY is non-empty (len=${anthro.length}). ` +
        'This proof requires ANTHROPIC_API_KEY to be unset or empty.',
    );
  }

  const oai = process.env.OPENAI_API_KEY ?? '';
  // Accept only short placeholder values. Real OpenAI keys start with 'sk-' and are >40 chars.
  if (oai.length > 20 || oai.startsWith('sk-')) {
    throw new Error(
      `P3.6-H4 invariant violation: OPENAI_API_KEY looks like a real key ` +
        `(len=${oai.length}, prefix=${JSON.stringify(oai.slice(0, 3))}). ` +
        'Use a short placeholder like "ollama-placeholder" to satisfy SDK ctor while proving no-real-key.',
    );
  }
  if (oai.length === 0) {
    throw new Error(
      'P3.6-H4: OPENAI_API_KEY is strictly empty. OpenAI SDK ctor will reject. ' +
        'Set a placeholder like OPENAI_API_KEY=ollama-placeholder (length<20, not sk-) to proceed.',
    );
  }

  const base = process.env.OPENAI_BASE_URL ?? '';
  if (!base.includes('11434')) {
    throw new Error(
      `P3.6-H4 invariant violation: OPENAI_BASE_URL does not contain "11434" (got ${JSON.stringify(base)}). ` +
        'Must point at Ollama localhost:11434.',
    );
  }
  if (!base.startsWith('http://localhost') && !base.startsWith('http://127.0.0.1')) {
    throw new Error(
      `P3.6-H4 invariant violation: OPENAI_BASE_URL must be http://localhost or http://127.0.0.1 (got ${JSON.stringify(base)}).`,
    );
  }

  const extModel = process.env.EXTRACTION_MODEL ?? '';
  const valModel = process.env.VALIDATION_MODEL ?? '';
  if (!extModel || !valModel) {
    throw new Error(
      `P3.6-H4 invariant violation: EXTRACTION_MODEL and VALIDATION_MODEL must be set ` +
        `(got ext=${JSON.stringify(extModel)}, val=${JSON.stringify(valModel)}).`,
    );
  }
}

// ---------- Imports from the app. Order matters: env must be set first
// because config.ts reads env at module-init time.
import { config } from '../src/config.ts';
import { createOpenAIProvider } from '../src/runtimes/chat/providers/openai.ts';
import {
  extractFacts,
  ExtractionError,
  type ExtractedFact,
} from '../src/runtimes/chat/enrichment/extractor.ts';
import {
  validateFacts,
  ValidationError,
  type ValidatedFact,
} from '../src/runtimes/chat/enrichment/validator.ts';
import type { StoredMessage } from '../src/core/messages.ts';

// Gemma3:27b ~24s/call in H3; validator adds second call. Bump apiTimeoutMs
// from the 30s default to 300s so we get a clean strict-mode result rather
// than a provider-call timeout masking whether validation works.
(config as unknown as { apiTimeoutMs: number }).apiTimeoutMs = 300_000;

// ---------- Synthetic fact-bearing batch. No PII. Fictional actors. ----------
const batch: StoredMessage[] = [
  {
    pk: 2001,
    chatJid: 'test-p36h4@s.whatsapp.net',
    conversationKey: 'test-p36h4',
    senderJid: 'alpha-fictional@s.whatsapp.net',
    senderName: 'Alpha Fictional',
    messageId: 'p36h4-msg-1',
    content: 'I use Notion for all my note-taking now.',
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
    pk: 2002,
    chatJid: 'test-p36h4@s.whatsapp.net',
    conversationKey: 'test-p36h4',
    senderJid: 'bravo-fictional@s.whatsapp.net',
    senderName: 'Bravo Fictional',
    messageId: 'p36h4-msg-2',
    content: 'Alpha always schedules standups at 9am sharp.',
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
    pk: 2003,
    chatJid: 'test-p36h4@s.whatsapp.net',
    conversationKey: 'test-p36h4',
    senderJid: 'charlie-fictional@s.whatsapp.net',
    senderName: 'Charlie Fictional',
    messageId: 'p36h4-msg-3',
    content: 'Our beta launch is locked in for 2026-07-01.',
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
    pk: 2004,
    chatJid: 'test-p36h4@s.whatsapp.net',
    conversationKey: 'test-p36h4',
    senderJid: 'delta-fictional@s.whatsapp.net',
    senderName: 'Delta Fictional',
    messageId: 'p36h4-msg-4',
    content: 'We raised our seed round at $4M valuation last quarter.',
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
    pk: 2005,
    chatJid: 'test-p36h4@s.whatsapp.net',
    conversationKey: 'test-p36h4',
    senderJid: 'echo-fictional@s.whatsapp.net',
    senderName: 'Echo Fictional',
    messageId: 'p36h4-msg-5',
    content: 'Bravo prefers tea over coffee in the afternoon.',
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

interface StageOutcome {
  ok: boolean;
  elapsed_ms: number;
  count?: number;
  facts?: unknown[];
  error?: {
    type: string;
    stage?: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

async function runStage<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<{ result?: T; outcome: StageOutcome }> {
  const start = Date.now();
  try {
    const result = await fn();
    const elapsed = Date.now() - start;
    const arr = Array.isArray(result) ? (result as unknown as unknown[]) : [];
    const count = Array.isArray(result) ? arr.length : undefined;
    process.stderr.write(`[p36-h4] ${label} finished ok in ${elapsed}ms (count=${count ?? 'n/a'})\n`);
    return {
      result,
      outcome: {
        ok: true,
        elapsed_ms: elapsed,
        count,
        facts: Array.isArray(result) ? arr : undefined,
      },
    };
  } catch (err) {
    const elapsed = Date.now() - start;
    process.stderr.write(`[p36-h4] ${label} failed after ${elapsed}ms: ${String(err)}\n`);
    if (err instanceof ExtractionError || err instanceof ValidationError) {
      return {
        outcome: {
          ok: false,
          elapsed_ms: elapsed,
          error: {
            type: err.name,
            stage: err.stage,
            message: err.message,
            details: {
              droppedCount: err.details.droppedCount,
              totalCount: err.details.totalCount,
              sampleItem: err.details.sampleItem,
              rawOutput:
                typeof err.details.rawOutput === 'string'
                  ? err.details.rawOutput.slice(0, 600)
                  : undefined,
              causeMessage:
                err.details.cause instanceof Error ? err.details.cause.message : undefined,
            },
          },
        },
      };
    }
    const e = err instanceof Error ? err : new Error(String(err));
    return {
      outcome: {
        ok: false,
        elapsed_ms: elapsed,
        error: { type: e.name ?? 'Error', message: e.message },
      },
    };
  }
}

async function main(): Promise<number> {
  process.stderr.write(
    `[p36-h4] env scrubbed. ANTHROPIC=${(process.env.ANTHROPIC_API_KEY ?? '').length}-char, ` +
      `OPENAI_API_KEY="${process.env.OPENAI_API_KEY}", BASE=${process.env.OPENAI_BASE_URL}, ` +
      `EXT_MODEL=${config.models.extraction}, VAL_MODEL=${config.models.validation}, ` +
      `apiTimeoutMs=${config.apiTimeoutMs}\n`,
  );

  const provider = createOpenAIProvider();

  const extract = await runStage('extract', () =>
    extractFacts(provider, batch, { strict: true }),
  );
  const extracted = (extract.result ?? []) as ExtractedFact[];

  // Validate only runs if extract produced at least one fact.
  let validate: { result?: ValidatedFact[]; outcome: StageOutcome };
  if (extracted.length > 0) {
    validate = await runStage('validate', () =>
      validateFacts(provider, extracted, batch, { strict: true }),
    );
  } else {
    validate = {
      outcome: {
        ok: false,
        elapsed_ms: 0,
        error: {
          type: 'SkipValidate',
          message: 'skipped — extract returned 0 facts (no inputs to validate)',
        },
      },
    };
  }

  // ---------- Verdict ----------
  const externalHosts = new Set(['api.openai.com', 'api.anthropic.com', 'api.openrouter.ai']);
  const externalLeaks = outboundCalls.filter((c) => {
    const h = c.host.toLowerCase();
    if (externalHosts.has(h)) return true;
    if (h.endsWith('.openai.com') || h.endsWith('.anthropic.com') || h.endsWith('.openrouter.ai')) return true;
    return false;
  });

  const nonLocalNonExternal = outboundCalls.filter(
    (c) =>
      c.host &&
      c.host !== 'localhost' &&
      c.host !== '127.0.0.1' &&
      c.host !== '::1' &&
      !externalHosts.has(c.host.toLowerCase()) &&
      !c.host.toLowerCase().endsWith('.openai.com') &&
      !c.host.toLowerCase().endsWith('.anthropic.com') &&
      !c.host.toLowerCase().endsWith('.openrouter.ai'),
  );

  const extractWorked = extract.outcome.ok && (extract.outcome.count ?? 0) > 0;
  const extractSilentEmpty = extract.outcome.ok && (extract.outcome.count ?? 0) === 0;

  const validateWorked = validate.outcome.ok;
  const validateFailedLoudly =
    !validate.outcome.ok &&
    validate.outcome.error &&
    (validate.outcome.error.type === 'ValidationError' ||
      validate.outcome.error.type === 'SkipValidate');

  let verdict: 'PASS' | 'PASS-ACCEPTABLE' | 'FAIL';
  let verdictReason: string;
  let exitCode: number;

  if (externalLeaks.length > 0) {
    verdict = 'FAIL';
    verdictReason = `network witness caught ${externalLeaks.length} outbound call(s) to external LLM endpoints`;
    exitCode = 1;
  } else if (extractSilentEmpty) {
    verdict = 'FAIL';
    verdictReason = 'extract returned [] silently — strict mode leaked';
    exitCode = 1;
  } else if (!extractWorked && !extract.outcome.ok) {
    verdict = 'FAIL';
    verdictReason = `extract stage failed: ${extract.outcome.error?.type}/${extract.outcome.error?.stage ?? '?'}`;
    exitCode = 1;
  } else if (extractWorked && validateWorked) {
    verdict = 'PASS';
    verdictReason = `extract=${extract.outcome.count} facts, validate=${validate.outcome.count} results, no network leak`;
    exitCode = 0;
  } else if (extractWorked && validateFailedLoudly) {
    verdict = 'PASS-ACCEPTABLE';
    verdictReason =
      `extract=${extract.outcome.count} facts OK; validator failed loudly ` +
      `(${validate.outcome.error?.type}/${validate.outcome.error?.stage ?? '?'}): ` +
      `${validate.outcome.error?.message}. Strict mode caught it — ` +
      `gemma3:27b is not viable for validation stage (output shape mismatch), but strict mode prevents silent pass.`;
    exitCode = 2;
  } else {
    verdict = 'FAIL';
    verdictReason = 'unclassified failure shape';
    exitCode = 1;
  }

  const record = {
    phase: 'P3.6-H4',
    when: new Date().toISOString(),
    env_scrubbed: {
      anthropic_key_empty: !(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.length > 0),
      openai_key_placeholder: (process.env.OPENAI_API_KEY ?? '').length < 20,
      openai_base_url: process.env.OPENAI_BASE_URL,
      extraction_model: config.models.extraction,
      validation_model: config.models.validation,
      api_timeout_ms: config.apiTimeoutMs,
    },
    extract: {
      elapsed_ms: extract.outcome.elapsed_ms,
      outcome: extract.outcome.ok ? 'extracted' : 'error',
      fact_count: extract.outcome.count ?? 0,
      facts: extracted,
      error: extract.outcome.error,
    },
    validate: {
      elapsed_ms: validate.outcome.elapsed_ms,
      outcome: validate.outcome.ok
        ? 'validated'
        : validate.outcome.error?.type === 'SkipValidate'
          ? 'skipped'
          : 'error',
      result_count: validate.outcome.count ?? 0,
      results: validate.result ?? [],
      error: validate.outcome.error,
    },
    network_witness: {
      total_calls: outboundCalls.length,
      external_leaks: externalLeaks,
      non_local_non_external: nonLocalNonExternal,
      all_calls_sample: outboundCalls.slice(0, 50).map((c) => ({
        host: c.host,
        port: c.port,
        path: c.path.slice(0, 200),
        method: c.method,
      })),
    },
    verdict,
    verdictReason,
  };

  // Write artifacts
  const outDir =
    process.env.P36H4_OUT_DIR ??
    '/Users/mw/LAB/mw-mind/artifacts/phase-3-whatsapp-hybrid/closeout-20260418-0259/p36';
  try {
    mkdirSync(outDir, { recursive: true });
    const jsonPath = `${outDir}/p36-h4-local-pipeline-proof.json`;
    writeFileSync(jsonPath, JSON.stringify(record, null, 2));

    const md: string[] = [];
    md.push(`# P3.6-H4 local-only pipeline proof`);
    md.push('');
    md.push(`- when: ${record.when}`);
    md.push(`- verdict: **${verdict}**`);
    md.push(`- reason: ${verdictReason}`);
    md.push(`- exit code: ${exitCode}`);
    md.push('');
    md.push(`## env scrubbed`);
    md.push('```json');
    md.push(JSON.stringify(record.env_scrubbed, null, 2));
    md.push('```');
    md.push('');
    md.push(`## extract`);
    md.push(`- elapsed: ${record.extract.elapsed_ms}ms`);
    md.push(`- outcome: ${record.extract.outcome}`);
    md.push(`- fact_count: ${record.extract.fact_count}`);
    if (record.extract.error) {
      md.push('- error:');
      md.push('```json');
      md.push(JSON.stringify(record.extract.error, null, 2));
      md.push('```');
    }
    md.push('');
    md.push(`## validate`);
    md.push(`- elapsed: ${record.validate.elapsed_ms}ms`);
    md.push(`- outcome: ${record.validate.outcome}`);
    md.push(`- result_count: ${record.validate.result_count}`);
    if (record.validate.error) {
      md.push('- error:');
      md.push('```json');
      md.push(JSON.stringify(record.validate.error, null, 2));
      md.push('```');
    }
    md.push('');
    md.push(`## network witness`);
    md.push(`- total outbound calls intercepted: ${record.network_witness.total_calls}`);
    md.push(`- external-LLM leaks: ${record.network_witness.external_leaks.length}`);
    md.push(`- non-local/non-external calls: ${record.network_witness.non_local_non_external.length}`);
    if (record.network_witness.external_leaks.length > 0) {
      md.push('- leak detail:');
      md.push('```json');
      md.push(JSON.stringify(record.network_witness.external_leaks, null, 2));
      md.push('```');
    }
    md.push('');
    md.push('## all intercepted calls (sample up to 50)');
    md.push('```json');
    md.push(JSON.stringify(record.network_witness.all_calls_sample, null, 2));
    md.push('```');

    writeFileSync(`${outDir}/p36-h4-local-pipeline-proof.md`, md.join('\n'));
    process.stderr.write(`[p36-h4] artifacts written under ${outDir}\n`);
  } catch (ioErr) {
    process.stderr.write(`[p36-h4] WARN: failed to write artifacts: ${String(ioErr)}\n`);
  }

  // One-line machine-readable verdict line.
  process.stdout.write('P36H4_VERDICT ' + JSON.stringify({ verdict, exitCode, verdictReason }) + '\n');
  process.stdout.write('P36H4_RECORD ' + JSON.stringify(record) + '\n');

  return exitCode;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write('[p36-h4] crashed: ' + String(err) + '\n');
    if (err instanceof Error && err.stack) process.stderr.write(err.stack + '\n');
    process.stderr.write(
      'P36H4_CRASH ' + JSON.stringify({ outboundCallsCount: outboundCalls.length }) + '\n',
    );
    process.exit(3);
  },
);
