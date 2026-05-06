/**
 * One-shot retroactive backfill for Phase 3 closure.
 *
 * Reads messages from bot.db where `enrichment_processed_at IS NULL AND
 * is_from_me = 0`, runs them through the same extract/validate/enqueue
 * pipeline the real-time EnrichmentPoller uses, and writes validated facts
 * into `fact_export_queue`. The configured memory bridge drains the queue
 * and upserts into the configured facts namespace.
 *
 * Constraints:
 *   - Does NOT widen the `is_from_me = 0` filter; skips messages where
 *     `enrichment_processed_at IS NOT NULL` (those were processed under the
 *     pre-Phase-3 architecture; their facts live in the frozen `whatsapp`
 *     namespace and are out of scope per plan §21).
 *   - Does NOT instantiate PineconeMemory (queue-only path).
 *   - Emits no outbound WhatsApp traffic.
 *   - Preserves the T1 accounting gate: source messages are marked
 *     processed only when `failed === 0 && inserted + duplicates === facts.length`.
 *   - Tags `enrichment_runs.error` with `backfill_ok:<run_id>` or
 *     `backfill_fail:<run_id>` so operators can distinguish backfill runs
 *     from real-time runs without a schema change.
 *
 * Run this with the target WhatSoup instance stopped.
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { config } from '../src/config.ts';
import { Database } from '../src/core/database.ts';
import {
  getUnprocessedMessages,
  markMessagesProcessed,
  getUnprocessedCount,
  getMessageCount,
  type StoredMessage,
} from '../src/core/messages.ts';
import { createAnthropicProvider } from '../src/runtimes/chat/providers/anthropic.ts';
import { createOpenAIProvider } from '../src/runtimes/chat/providers/openai.ts';
import type { LLMProvider } from '../src/runtimes/chat/providers/types.ts';
import { extractFacts, ExtractionError } from '../src/runtimes/chat/enrichment/extractor.ts';
import { validateFacts, ValidationError } from '../src/runtimes/chat/enrichment/validator.ts';
import { createChildLogger } from '../src/logger.ts';
import {
  enqueueFacts,
  shortHash,
  toExportable,
  type EnqueueFactsResult,
} from '../src/runtimes/chat/enrichment/fact-export-queue.ts';

// Re-export so the existing test imports keep working.
export { shortHash, toExportable };

/**
 * P3.6 review S-1a: shared stage vocabulary for ExtractionError and
 * ValidationError. Both error classes use the exact same four-value union,
 * so promoting it to a named type keeps the backfill summary / failedBatches
 * surface in sync with the error sources. If a future stage is added in
 * extractor.ts / validator.ts without updating this alias, tsc flags the
 * gap here and in StrictFailure.stage below.
 */
export type StrictStage =
  | 'provider-call'
  | 'json-parse'
  | 'schema-shape'
  | 'schema-items-all-dropped';

const log = createChildLogger('backfill-enrichment');

export function groupByChatJid(messages: StoredMessage[]): Map<string, StoredMessage[]> {
  const byChat = new Map<string, StoredMessage[]>();
  for (const msg of messages) {
    const existing = byChat.get(msg.chatJid);
    if (existing) existing.push(msg);
    else byChat.set(msg.chatJid, [msg]);
  }
  return byChat;
}

/** Mirrors the poller's T1 accounting rule. */
export function accountingOk(result: EnqueueFactsResult, expected: number): boolean {
  return result.failed === 0 && result.inserted + result.duplicates === expected;
}

// ── CLI parsing ──────────────────────────────────────────────────────────────

export type ProviderKind = 'anthropic' | 'openai';

export interface BackfillArgs {
  instance: string;
  limit: number;
  dryRun: boolean;
  runId: string;
  provider: ProviderKind;
  telemetryPath?: string;
  /**
   * When true, pass `{ strict: true }` through to extractFacts / validateFacts
   * and fail closed on ExtractionError / ValidationError.
   */
  strict: boolean;
}

export function parseArgs(argv: readonly string[]): BackfillArgs {
  const hasRunIdArg = argv.includes('--run-id');
  const hasTelemetryArg = argv.includes('--telemetry');
  const runIdFromCanonical = process.env.WHATSOUP_BACKFILL_RUN_ID;
  const runIdFromAlias = process.env.MW_MIND_RUN_ID;
  const telemetryDirFromCanonical = process.env.WHATSOUP_BACKFILL_TELEMETRY_DIR;
  const telemetryDirFromAlias = process.env.MW_MIND_CLOSEOUT_DIR;
  const telemetryDir = telemetryDirFromCanonical ?? telemetryDirFromAlias;

  const args: BackfillArgs = {
    instance: process.env.WHATSOUP_BACKFILL_INSTANCE ?? 'mw-bot',
    limit: 500,
    dryRun: false,
    provider: 'anthropic',
    strict: false,
    runId: runIdFromCanonical ?? runIdFromAlias ?? `backfill-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    telemetryPath: telemetryDir
      ? `${telemetryDir}/task-5-backfill-telemetry.jsonl`
      : undefined,
  };
  if (runIdFromAlias && !runIdFromCanonical && !hasRunIdArg) {
    console.warn(
      { alias: 'MW_MIND_RUN_ID', canonical: 'WHATSOUP_BACKFILL_RUN_ID', expires: '2026-10-26' },
      'backfill run id is using a deprecated environment alias',
    );
  }
  if (telemetryDirFromAlias && !telemetryDirFromCanonical && !hasTelemetryArg) {
    console.warn(
      {
        alias: 'MW_MIND_CLOSEOUT_DIR',
        canonical: 'WHATSOUP_BACKFILL_TELEMETRY_DIR',
        expires: '2026-10-26',
      },
      'backfill telemetry directory is using a deprecated environment alias',
    );
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--instance') args.instance = argv[++i] ?? args.instance;
    else if (a === '--limit') args.limit = Number.parseInt(argv[++i] ?? '', 10) || args.limit;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--strict') args.strict = true;
    else if (a === '--run-id') args.runId = argv[++i] ?? args.runId;
    else if (a === '--telemetry') args.telemetryPath = argv[++i];
    else if (a === '--provider') {
      const v = argv[++i];
      if (v !== 'anthropic' && v !== 'openai') {
        throw new Error(`--provider must be 'anthropic' or 'openai' (got: ${v ?? 'empty'})`);
      }
      args.provider = v;
    } else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  return args;
}

function printUsage(): void {
  const text = [
    'Usage: backfill-enrichment [options]',
    '',
    '  --instance <name>      Instance to backfill (default: $WHATSOUP_BACKFILL_INSTANCE or mw-bot)',
    '  --limit <N>            Max messages to process (default: 500)',
    '  --dry-run              Classify but do not enqueue',
    '  --strict               Fail-closed on ExtractionError / ValidationError',
    '                         (skip markProcessed + propagate non-zero exit)',
    '  --provider <name>      LLM provider: anthropic | openai (default: anthropic)',
    '  --run-id <id>          Run identifier (default: $WHATSOUP_BACKFILL_RUN_ID, deprecated $MW_MIND_RUN_ID, or backfill-<ts>)',
    '  --telemetry <path>     JSONL output path (default: $WHATSOUP_BACKFILL_TELEMETRY_DIR/task-5-backfill-telemetry.jsonl; deprecated alias $MW_MIND_CLOSEOUT_DIR)',
    '',
    'Provider config:',
    '  anthropic  → reads ANTHROPIC_API_KEY; default models claude-sonnet-4-6 / claude-haiku-4-5',
    '  openai     → reads OPENAI_BASE_URL (e.g. http://localhost:11434/v1 for Ollama) and OPENAI_API_KEY',
    '               (set to any non-empty placeholder when talking to Ollama). Requires',
    '               EXTRACTION_MODEL and VALIDATION_MODEL env vars because the built-in',
    '               defaults are Anthropic model IDs that will fail against an OpenAI-style endpoint.',
    '',
    'Honors EXTRACTION_MODEL / VALIDATION_MODEL env vars for all providers.',
  ].join('\n');
  console.log(text);
}

// ── Provider selection ──────────────────────────────────────────────────────

export interface ProviderFactories {
  anthropic: () => LLMProvider;
  openai: () => LLMProvider;
}

export const DEFAULT_PROVIDER_FACTORIES: ProviderFactories = {
  anthropic: createAnthropicProvider,
  openai: createOpenAIProvider,
};

export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderConfigError';
  }
}

export interface ProviderConfigEnv {
  EXTRACTION_MODEL?: string;
  VALIDATION_MODEL?: string;
  OPENAI_BASE_URL?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
}

/**
 * Validate the env for the selected provider BEFORE instantiating clients.
 * Fail-fast so a misconfigured --provider openai doesn't surprise us mid-run.
 */
export function validateProviderConfig(provider: ProviderKind, env: ProviderConfigEnv): void {
  if (provider === 'openai') {
    const baseUrl = env.OPENAI_BASE_URL;
    if (!baseUrl) {
      throw new ProviderConfigError(
        '--provider openai requires OPENAI_BASE_URL (e.g. http://localhost:11434/v1 for Ollama)',
      );
    }
    if (!env.OPENAI_API_KEY) {
      throw new ProviderConfigError(
        "--provider openai requires OPENAI_API_KEY (use any non-empty placeholder for Ollama, e.g. 'ollama')",
      );
    }
    // The built-in defaults (claude-sonnet-4-6 / claude-haiku-4-5) are Anthropic
    // model IDs and cannot be sent to an OpenAI-style endpoint. Force an
    // explicit override so operators don't accidentally talk to Ollama with
    // an Anthropic model name.
    if (!env.EXTRACTION_MODEL) {
      throw new ProviderConfigError(
        '--provider openai requires EXTRACTION_MODEL (e.g. qwen3:32b-tuned) — the default is an Anthropic model ID',
      );
    }
    if (!env.VALIDATION_MODEL) {
      throw new ProviderConfigError(
        '--provider openai requires VALIDATION_MODEL (e.g. qwen3:8b-tuned) — the default is an Anthropic model ID',
      );
    }
  } else {
    // anthropic path: the SDK will raise if the key is missing, but a
    // pre-flight message is more operator-friendly.
    if (!env.ANTHROPIC_API_KEY) {
      throw new ProviderConfigError('--provider anthropic requires ANTHROPIC_API_KEY');
    }
  }
}

export function buildProviders(
  provider: ProviderKind,
  factories: ProviderFactories = DEFAULT_PROVIDER_FACTORIES,
): { extraction: LLMProvider; validation: LLMProvider } {
  const make = factories[provider];
  // The extractor and validator receive distinct LLMProvider instances in the
  // live poller so the two stages can use different models via config. We
  // preserve that separation here even though both share a provider kind.
  return { extraction: make(), validation: make() };
}

// ── Telemetry ────────────────────────────────────────────────────────────────

interface TelemetryRecord {
  timestamp_utc: string;
  run_id: string;
  service: 'whatsoup';
  env: string;
  actor: 'backfill-script';
  trace_id: string;
  span_id: string;
  event: 'execution' | 'input' | 'output' | 'decision';
  action: string;
  result: 'Pass' | 'Fail' | 'Blocked' | 'Inconclusive';
  inputs: Record<string, unknown>;
  evidence: { artifact_paths: string[] };
  error: { type: string; message: string };
}

function emitTelemetry(path: string | undefined, record: TelemetryRecord): void {
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(record) + '\n');
  } catch (err) {
    console.warn(`telemetry write failed: ${(err as Error).message}`);
  }
}

// ── Backfill core (exported for tests) ───────────────────────────────────────

export interface BackfillBatchDeps {
  extract: typeof extractFacts;
  validate: typeof validateFacts;
  enqueue: typeof enqueueFacts;
  markProcessed: typeof markMessagesProcessed;
}

/**
 * P3.6-H2 strict-mode failure record attached to a per-batch result when
 * the extractor or validator raises. Lives on BackfillBatchResult so the
 * runBackfill caller can aggregate these into summary.failedBatches without
 * a second data path.
 */
export interface StrictFailure {
  errorType: 'ExtractionError' | 'ValidationError';
  stage: StrictStage;
  messageIds: number[];
  details: string;
}

export interface BackfillBatchResult {
  chatJid: string;
  messagesInBatch: number;
  factsExtracted: number;
  factsValidated: number;
  enqueueResult: EnqueueFactsResult | null;
  markedProcessed: boolean;
  error?: string;
  /**
   * P3.6-H2. Populated only when the batch failed-closed under strict mode
   * (caller passed `strict=true` and extractFacts / validateFacts raised).
   * Non-strict generic errors still land on `error` instead, preserving the
   * pre-H2 caller contract.
   */
  strictFailure?: StrictFailure;
}

export async function processBatch(
  db: Database,
  chatJid: string,
  chatMessages: StoredMessage[],
  providers: { extraction: Parameters<typeof extractFacts>[0]; validation: Parameters<typeof validateFacts>[0] },
  deps: BackfillBatchDeps,
  dryRun: boolean,
  strict: boolean = false,
): Promise<BackfillBatchResult> {
  const out: BackfillBatchResult = {
    chatJid,
    messagesInBatch: chatMessages.length,
    factsExtracted: 0,
    factsValidated: 0,
    enqueueResult: null,
    markedProcessed: false,
  };

  const batchMessageIds = chatMessages.map((m) => m.pk);

  try {
    // P3.6-H2: pass the strict flag through; H1 owns the decision of what
    // becomes an ExtractionError (provider-call / json-parse / schema-shape
    // / schema-items-all-dropped). Legitimate empties (empty batch, model
    // replied `[]`) still return `[]` silently — we do NOT classify those
    // as failures here.
    const facts = await deps.extract(providers.extraction, chatMessages, { strict });
    out.factsExtracted = facts.length;

    if (facts.length === 0) {
      if (!dryRun) deps.markProcessed(db, batchMessageIds);
      out.markedProcessed = !dryRun;
      return out;
    }

    const validated = await deps.validate(
      providers.validation,
      facts,
      chatMessages,
      { strict },
    );
    out.factsValidated = validated.length;

    if (validated.length === 0) {
      if (!dryRun) deps.markProcessed(db, batchMessageIds);
      out.markedProcessed = !dryRun;
      return out;
    }

    const exportable = validated.map(toExportable);

    if (dryRun) return out;

    const enq = deps.enqueue(db, exportable);
    out.enqueueResult = enq;

    if (accountingOk(enq, exportable.length)) {
      deps.markProcessed(db, batchMessageIds);
      out.markedProcessed = true;
    }
    // Note: accountingOk===false (T1 invariant) is a separate failure class
    // from strict-mode fail-closed. Both skip markProcessed but the
    // discrimination happens at the runBackfill summary level, not here.
  } catch (err) {
    // P3.6-H2 fail-closed: ExtractionError / ValidationError get structured
    // treatment — stage + messageIds preserved verbatim for the operator
    // retry path. Non-strict paths can never reach this branch (extract /
    // validate silently coerce to `[]`), so `strict` is implicitly true
    // when we observe these classes, but we still gate explicitly so a
    // future regression that throws H1 errors from a non-strict caller
    // doesn't silently corrupt the summary contract.
    if (strict && err instanceof ExtractionError) {
      out.strictFailure = {
        errorType: 'ExtractionError',
        stage: err.stage,
        messageIds: batchMessageIds,
        details: err.message,
      };
      log.error(
        { err, chatJid, batchMessageIds, stage: err.stage },
        'backfill: strict-mode extract fail-closed',
      );
    } else if (strict && err instanceof ValidationError) {
      out.strictFailure = {
        errorType: 'ValidationError',
        stage: err.stage,
        messageIds: batchMessageIds,
        details: err.message,
      };
      log.error(
        { err, chatJid, batchMessageIds, stage: err.stage },
        'backfill: strict-mode validate fail-closed',
      );
    }
    out.error = (err as Error).message || String(err);
  }

  return out;
}

// ── Main entrypoint ──────────────────────────────────────────────────────────

export interface BackfillSummary {
  instance: string;
  runId: string;
  dryRun: boolean;
  strict: boolean;
  unprocessedBefore: number;
  alreadyProcessedSkipped: number;
  messagesProcessed: number;
  factsExtracted: number;
  factsValidated: number;
  factsQueued: number;
  batchesOk: number;
  batchesFailed: number;
  elapsedMs: number;
  perChat: BackfillBatchResult[];
  /**
   * P3.6-H2. Every batch whose extractor / validator raised under strict
   * mode. Always present as an array (empty if no failures); non-strict
   * runs never populate entries here even if generic errors land on
   * `perChat[i].error`. The `chatJid` + `messageIds` are what operators
   * need for a manual retry.
   */
  failedBatches: Array<{
    chatJid: string;
    messageIds: number[];
    errorType: 'ExtractionError' | 'ValidationError';
    stage: StrictStage;
    details: string;
  }>;
}

export async function runBackfill(
  db: Database,
  args: BackfillArgs,
  providers: { extraction: Parameters<typeof extractFacts>[0]; validation: Parameters<typeof validateFacts>[0] },
  deps: BackfillBatchDeps = {
    extract: extractFacts,
    validate: validateFacts,
    enqueue: enqueueFacts,
    markProcessed: markMessagesProcessed,
  },
): Promise<BackfillSummary> {
  const start = Date.now();

  const totalMessages = getMessageCount(db);
  const unprocessedBefore = getUnprocessedCount(db);
  const alreadyProcessedSkipped = totalMessages - unprocessedBefore;

  const messages = getUnprocessedMessages(db, args.limit);
  const summary: BackfillSummary = {
    instance: args.instance,
    runId: args.runId,
    dryRun: args.dryRun,
    strict: args.strict,
    unprocessedBefore,
    alreadyProcessedSkipped,
    messagesProcessed: 0,
    factsExtracted: 0,
    factsValidated: 0,
    factsQueued: 0,
    batchesOk: 0,
    batchesFailed: 0,
    elapsedMs: 0,
    perChat: [],
    failedBatches: [],
  };

  if (messages.length === 0) {
    summary.elapsedMs = Date.now() - start;
    return summary;
  }

  const byChat = groupByChatJid(messages);

  for (const [chatJid, chatMessages] of byChat) {
    emitTelemetry(args.telemetryPath, {
      timestamp_utc: new Date().toISOString(),
      run_id: args.runId,
      service: 'whatsoup',
      env: process.env.NODE_ENV ?? 'prod',
      actor: 'backfill-script',
      trace_id: args.runId,
      span_id: `batch-start-${chatJid}`,
      event: 'input',
      action: 'queue_facts',
      result: 'Pass',
      inputs: { chatJid, batch_size: chatMessages.length },
      evidence: { artifact_paths: [] },
      error: { type: '', message: '' },
    });

    const batchResult = await processBatch(
      db,
      chatJid,
      chatMessages,
      providers,
      deps,
      args.dryRun,
      args.strict,
    );
    summary.perChat.push(batchResult);
    summary.messagesProcessed += batchResult.markedProcessed ? batchResult.messagesInBatch : 0;
    summary.factsExtracted += batchResult.factsExtracted;
    summary.factsValidated += batchResult.factsValidated;
    summary.factsQueued += batchResult.enqueueResult?.inserted ?? 0;
    // P3.6-H2: strict failures feed the structured failedBatches list so
    // main() can emit the JSON summary and pick the correct exit code.
    if (batchResult.strictFailure) {
      summary.failedBatches.push({
        chatJid: batchResult.chatJid,
        messageIds: batchResult.strictFailure.messageIds,
        errorType: batchResult.strictFailure.errorType,
        stage: batchResult.strictFailure.stage,
        details: batchResult.strictFailure.details,
      });
    }
    if (batchResult.error || (batchResult.enqueueResult && !batchResult.markedProcessed && !args.dryRun)) {
      summary.batchesFailed += 1;
    } else {
      summary.batchesOk += 1;
    }

    const status = args.dryRun
      ? 'backfill_dryrun'
      : batchResult.strictFailure
        ? `backfill_strict_fail_${batchResult.strictFailure.stage}`
        : batchResult.markedProcessed
          ? 'backfill_ok'
          : 'backfill_fail';
    try {
      db.raw
        .prepare(
          `INSERT INTO enrichment_runs (started_at, completed_at, messages_processed, facts_extracted, facts_upserted, error)
           VALUES (?, datetime('now'), ?, ?, ?, ?)`,
        )
        .run(
          new Date().toISOString(),
          batchResult.markedProcessed ? batchResult.messagesInBatch : 0,
          batchResult.factsExtracted,
          batchResult.enqueueResult?.inserted ?? 0,
          `${status}:${args.runId}`,
        );
    } catch {
      // enrichment_runs write failure is non-fatal for the backfill itself.
    }

    emitTelemetry(args.telemetryPath, {
      timestamp_utc: new Date().toISOString(),
      run_id: args.runId,
      service: 'whatsoup',
      env: process.env.NODE_ENV ?? 'prod',
      actor: 'backfill-script',
      trace_id: args.runId,
      span_id: `batch-done-${chatJid}`,
      event: 'execution',
      action: 'queue_facts',
      result: batchResult.error
        ? 'Fail'
        : batchResult.markedProcessed
        ? 'Pass'
        : args.dryRun
        ? 'Inconclusive'
        : 'Fail',
      inputs: {
        chatJid,
        batch_size: chatMessages.length,
        facts_extracted: batchResult.factsExtracted,
        facts_validated: batchResult.factsValidated,
        attempted: batchResult.enqueueResult?.attempted ?? 0,
        inserted: batchResult.enqueueResult?.inserted ?? 0,
        duplicates: batchResult.enqueueResult?.duplicates ?? 0,
        failed: batchResult.enqueueResult?.failed ?? 0,
      },
      evidence: { artifact_paths: [] },
      error: { type: batchResult.error ? 'BatchError' : '', message: batchResult.error ?? '' },
    });
  }

  summary.elapsedMs = Date.now() - start;

  // Emit a final run_complete telemetry record so operators reading the JSONL
  // can see the structured failure list. Written after the loop so batchesOk
  // and batchesFailed reflect the final totals.
  emitTelemetry(args.telemetryPath, {
    timestamp_utc: new Date().toISOString(),
    run_id: args.runId,
    service: 'whatsoup',
    env: process.env.NODE_ENV ?? 'prod',
    actor: 'backfill-script',
    trace_id: args.runId,
    span_id: 'run-complete',
    event: 'execution',
    action: 'run_complete',
    result: summary.failedBatches.length > 0 ? 'Fail' : 'Pass',
    inputs: {
      batchesOk: summary.batchesOk,
      batchesFailed: summary.batchesFailed,
      failedBatches: summary.failedBatches,
      strict: args.strict,
      dryRun: args.dryRun,
    },
    evidence: { artifact_paths: [] },
    error: { type: '', message: '' },
  });

  return summary;
}

// ── main() ───────────────────────────────────────────────────────────────────

export async function main(argv: readonly string[]): Promise<number> {
  let args: BackfillArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error((err as Error).message);
    printUsage();
    return 4;
  }

  // Resolve instance bot.db. `config.dbPath` reads the active-instance path
  // from env; we need to override to the requested instance if it differs.
  const defaultDbPath = process.env.HOME
    ? `${process.env.HOME}/.local/share/whatsoup/instances/${args.instance}/bot.db`
    : config.dbPath;
  const dbPath = process.env.WHATSOUP_BACKFILL_DB_PATH ?? defaultDbPath;

  if (!existsSync(dbPath)) {
    console.error(`FATAL: bot.db missing at ${dbPath}`);
    return 3;
  }

  try {
    validateProviderConfig(args.provider, {
      EXTRACTION_MODEL: process.env.EXTRACTION_MODEL,
      VALIDATION_MODEL: process.env.VALIDATION_MODEL,
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    });
  } catch (err) {
    console.error(`[backfill] ${(err as Error).message}`);
    return 5;
  }

  const db = new Database(dbPath);
  db.open();

  const providers = buildProviders(args.provider);

  console.log(
    `[backfill] instance=${args.instance} path=${dbPath} run_id=${args.runId} dry_run=${args.dryRun} strict=${args.strict} provider=${args.provider}`,
  );
  console.log(
    `[backfill] models extraction=${config.models.extraction} validation=${config.models.validation}`,
  );

  try {
    const summary = await runBackfill(db, args, providers);

    const perChatLines = summary.perChat
      .map(
        (b) =>
          `  ${b.chatJid}: msgs=${b.messagesInBatch} ex=${b.factsExtracted} v=${b.factsValidated} q=${b.enqueueResult?.inserted ?? 0} marked=${b.markedProcessed}${b.error ? ` err=${b.error}` : ''}`,
      )
      .join('\n');

    console.log(
      [
        '',
        `[backfill] unprocessed_before=${summary.unprocessedBefore} already_processed_skipped=${summary.alreadyProcessedSkipped} strict=${args.strict}`,
        `[backfill] messages_processed=${summary.messagesProcessed} facts_extracted=${summary.factsExtracted} facts_validated=${summary.factsValidated} facts_queued=${summary.factsQueued}`,
        `[backfill] batches_ok=${summary.batchesOk} batches_failed=${summary.batchesFailed}`,
        `[backfill] elapsed=${(summary.elapsedMs / 1000).toFixed(1)}s`,
        `[backfill] per-chat:`,
        perChatLines,
      ].join('\n'),
    );

    // P3.6-H2 summary block: always emit under --strict so operators see
    // the message pks they need to retry, even when failedBatches is empty
    // (the empty case proves fail-closed didn't fire, which is itself useful
    // evidence on a clean run).
    if (args.strict) {
      const n = summary.failedBatches.length;
      console.log(
        `[backfill] strict-mode: ${summary.batchesOk} batches succeeded, ${n} batches failed-closed ` +
          `(messages not marked processed and will be retried on next run)`,
      );
      if (n > 0) {
        console.log(
          `[backfill] strict-mode failedBatches:\n${JSON.stringify(summary.failedBatches, null, 2)}`,
        );
      }
    }

    if (summary.unprocessedBefore === 0) {
      console.log('[backfill] BACKFILL_NO_OP: 0 unprocessed messages');
      return 0;
    }
    // P3.6-H2: exit code 6 is reserved for "strict-mode fail-closed ran and
    // blocked at least one batch from being marked". Dry-run suppresses the
    // non-zero exit because dry-run is informational. Codes in use elsewhere:
    // 0 success, 2 unhandled, 3 bot.db missing, 4 general batch failure,
    // 5 provider config. Code 6 distinguishes strict-blocked from the
    // accountingOk===false path (which still returns 4).
    if (args.strict && !args.dryRun && summary.failedBatches.length > 0) {
      return 6;
    }
    if (summary.batchesFailed > 0) return 4;
    return 0;
  } catch (err) {
    console.error(`[backfill] unhandled: ${(err as Error).message}`);
    return 2;
  } finally {
    db.close();
  }
}

// Only invoke main() when executed directly (not when imported by tests).
// node:sqlite scripts have no import.meta.main; check argv instead.
const invokedDirectly =
  process.argv[1] !== undefined && /backfill-enrichment\.ts$/.test(process.argv[1]);
if (invokedDirectly) {
  process.on('unhandledRejection', (reason) => {
    console.error('unhandledRejection:', reason);
    process.exit(2);
  });
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}
