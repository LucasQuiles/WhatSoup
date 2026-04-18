/**
 * One-shot retroactive backfill for Phase 3 closure.
 *
 * Reads messages from bot.db where `enrichment_processed_at IS NULL AND
 * is_from_me = 0`, runs them through the same extract/validate/enqueue
 * pipeline the real-time EnrichmentPoller uses, and writes validated facts
 * into `fact_export_queue`. The downstream mw-mind bridge drains the queue
 * and upserts into the MWLab `whatsapp-facts` namespace.
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
 * Run this with `com.whatsoup.mw-bot` STOPPED. See Phase 3.5 plan.
 */

import { createHash } from 'node:crypto';
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
import { extractFacts } from '../src/runtimes/chat/enrichment/extractor.ts';
import { validateFacts, type ValidatedFact } from '../src/runtimes/chat/enrichment/validator.ts';
import {
  enqueueFacts,
  type ExportableFact,
  type EnqueueFactsResult,
} from '../src/runtimes/chat/enrichment/fact-export-queue.ts';

// ── Pure helpers (exported for tests) ────────────────────────────────────────

export function shortHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

/**
 * Mirror of the private `toExportable` in poller.ts. Kept inline here so the
 * backfill stays decoupled from the live poller's internals. Any drift
 * between this and `poller.ts:toExportable` means the backfill's fact_ids
 * would not match the poller's — both codepaths MUST produce the same
 * `factId` for the same `ValidatedFact` or the queue's UNIQUE constraint
 * stops deduplicating correctly.
 */
export function toExportable(fact: ValidatedFact): ExportableFact {
  const senderSegment = fact.senderJid || 'group';
  const factId = `${fact.chatJid}:${senderSegment}:${shortHash(fact.text)}`;
  return {
    factId,
    chatJid: fact.chatJid,
    senderJid: fact.senderJid || null,
    text: fact.text,
    memoryType: fact.memoryType,
    confidence: fact.adjustedConfidence,
    senderName: fact.senderName,
    supersedesText: fact.supersedesText,
    sourceMessagePks: fact.sourceMessagePks,
  };
}

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

export interface BackfillArgs {
  instance: string;
  limit: number;
  dryRun: boolean;
  runId: string;
  telemetryPath?: string;
}

export function parseArgs(argv: readonly string[]): BackfillArgs {
  const args: BackfillArgs = {
    instance: 'mw-bot',
    limit: 500,
    dryRun: false,
    runId:
      process.env.MW_MIND_RUN_ID ||
      `backfill-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    telemetryPath: process.env.MW_MIND_CLOSEOUT_DIR
      ? `${process.env.MW_MIND_CLOSEOUT_DIR}/task-5-backfill-telemetry.jsonl`
      : undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--instance') args.instance = argv[++i] ?? args.instance;
    else if (a === '--limit') args.limit = Number.parseInt(argv[++i] ?? '', 10) || args.limit;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--run-id') args.runId = argv[++i] ?? args.runId;
    else if (a === '--telemetry') args.telemetryPath = argv[++i];
    else if (a === '--help' || a === '-h') {
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
    '  --instance <name>      Instance to backfill (default: mw-bot)',
    '  --limit <N>            Max messages to process (default: 500)',
    '  --dry-run              Classify but do not enqueue',
    '  --run-id <id>          Run identifier (default: $MW_MIND_RUN_ID or backfill-<ts>)',
    '  --telemetry <path>     JSONL output path (default: $MW_MIND_CLOSEOUT_DIR/task-5-backfill-telemetry.jsonl)',
    '',
    'Honors EXTRACTION_MODEL / VALIDATION_MODEL / ANTHROPIC_API_KEY env vars.',
  ].join('\n');
  console.log(text);
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

export interface BackfillBatchResult {
  chatJid: string;
  messagesInBatch: number;
  factsExtracted: number;
  factsValidated: number;
  enqueueResult: EnqueueFactsResult | null;
  markedProcessed: boolean;
  error?: string;
}

export async function processBatch(
  db: Database,
  chatJid: string,
  chatMessages: StoredMessage[],
  providers: { extraction: Parameters<typeof extractFacts>[0]; validation: Parameters<typeof validateFacts>[0] },
  deps: BackfillBatchDeps,
  dryRun: boolean,
): Promise<BackfillBatchResult> {
  const out: BackfillBatchResult = {
    chatJid,
    messagesInBatch: chatMessages.length,
    factsExtracted: 0,
    factsValidated: 0,
    enqueueResult: null,
    markedProcessed: false,
  };

  try {
    const facts = await deps.extract(providers.extraction, chatMessages);
    out.factsExtracted = facts.length;

    if (facts.length === 0) {
      if (!dryRun) deps.markProcessed(db, chatMessages.map((m) => m.pk));
      out.markedProcessed = !dryRun;
      return out;
    }

    const validated = await deps.validate(providers.validation, facts, chatMessages);
    out.factsValidated = validated.length;

    if (validated.length === 0) {
      if (!dryRun) deps.markProcessed(db, chatMessages.map((m) => m.pk));
      out.markedProcessed = !dryRun;
      return out;
    }

    const exportable = validated.map(toExportable);

    if (dryRun) return out;

    const enq = deps.enqueue(db, exportable);
    out.enqueueResult = enq;

    if (accountingOk(enq, exportable.length)) {
      deps.markProcessed(db, chatMessages.map((m) => m.pk));
      out.markedProcessed = true;
    }
  } catch (err) {
    out.error = (err as Error).message || String(err);
  }

  return out;
}

// ── Main entrypoint ──────────────────────────────────────────────────────────

export interface BackfillSummary {
  instance: string;
  runId: string;
  dryRun: boolean;
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

    const batchResult = await processBatch(db, chatJid, chatMessages, providers, deps, args.dryRun);
    summary.perChat.push(batchResult);
    summary.messagesProcessed += batchResult.markedProcessed ? batchResult.messagesInBatch : 0;
    summary.factsExtracted += batchResult.factsExtracted;
    summary.factsValidated += batchResult.factsValidated;
    summary.factsQueued += batchResult.enqueueResult?.inserted ?? 0;
    if (batchResult.error || (batchResult.enqueueResult && !batchResult.markedProcessed && !args.dryRun)) {
      summary.batchesFailed += 1;
    } else {
      summary.batchesOk += 1;
    }

    const status = args.dryRun ? 'backfill_dryrun' : batchResult.markedProcessed ? 'backfill_ok' : 'backfill_fail';
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

  const db = new Database(dbPath);
  db.open();

  const providers = {
    extraction: createAnthropicProvider(),
    validation: createAnthropicProvider(),
  };

  console.log(
    `[backfill] instance=${args.instance} path=${dbPath} run_id=${args.runId} dry_run=${args.dryRun}`,
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
        `[backfill] unprocessed_before=${summary.unprocessedBefore} already_processed_skipped=${summary.alreadyProcessedSkipped}`,
        `[backfill] messages_processed=${summary.messagesProcessed} facts_extracted=${summary.factsExtracted} facts_validated=${summary.factsValidated} facts_queued=${summary.factsQueued}`,
        `[backfill] batches_ok=${summary.batchesOk} batches_failed=${summary.batchesFailed}`,
        `[backfill] elapsed=${(summary.elapsedMs / 1000).toFixed(1)}s`,
        `[backfill] per-chat:`,
        perChatLines,
      ].join('\n'),
    );

    if (summary.unprocessedBefore === 0) {
      console.log('[backfill] BACKFILL_NO_OP: 0 unprocessed messages');
      return 0;
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
