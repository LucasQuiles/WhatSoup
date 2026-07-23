import { config } from '../../../config.ts';
import { createChildLogger } from '../../../logger.ts';
import type { Database } from '../../../core/database.ts';
import { getUnprocessedMessages, markMessagesProcessed, markMessagesWithError, incrementEnrichmentRetries, getUnprocessedCount } from '../../../core/messages.ts';
import type { LLMProvider } from '../providers/types.ts';
import type { PineconeMemory } from '../providers/pinecone.ts';
import type { StoredMessage } from '../../../core/messages.ts';
import { extractFacts } from './extractor.ts';
import { validateFacts } from './validator.ts';
import { enqueueFacts, toExportable } from './fact-export-queue.ts';

const log = createChildLogger('enrichment');

export class EnrichmentPoller {
  private timer: NodeJS.Timeout | null = null;
  private db: Database;
  private pinecone: PineconeMemory;
  private extractionProvider: LLMProvider;
  private validationProvider: LLMProvider;
  private stopped = false;
  public lastRunAt: string | null = null;

  /** Count of messages pending enrichment (not yet processed). */
  get unprocessedCount(): number {
    return getUnprocessedCount(this.db);
  }

  constructor(
    db: Database,
    pinecone: PineconeMemory,
    extractionProvider: LLMProvider,
    validationProvider: LLMProvider,
  ) {
    this.db = db;
    this.pinecone = pinecone;
    this.extractionProvider = extractionProvider;
    this.validationProvider = validationProvider;
  }

  start(): void {
    if (this.timer !== null) {
      log.warn('EnrichmentPoller.start() called while already running');
      return;
    }
    this.stopped = false;
    log.info({ intervalMs: config.enrichmentIntervalMs }, 'Enrichment poller starting');
    this.scheduleNext();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
      log.info('Enrichment poller stopped');
    }
  }

  private scheduleNext(): void {
    this.timer = setTimeout(() => void this.tick(), config.enrichmentIntervalMs);
  }

  private async tick(): Promise<void> {
    this.timer = null;
    try {
      await this.runCycle();
    } catch (err) {
      // runCycle has comprehensive internal error handling; this catch is a
      // last-resort safety net ensuring the poller always reschedules even if
      // an unexpected bug causes runCycle to throw past its own finally block.
      log.error({ err }, 'enrichment: unexpected error in tick — rescheduling');
    }
    if (this.stopped === false) {
      this.scheduleNext();
    }
  }

  private async runCycle(): Promise<void> {
    const cycleStart = Date.now();
    const runId = process.env.MW_MIND_RUN_ID;

    let totalExtracted = 0;
    let totalQueued = 0;
    const successPks: number[] = [];
    const failedPks: number[] = [];

    // Everything from the message fetch through the success-path INSERT
    // lives in one try/catch. Per-chat-segment failures below (extraction,
    // validation, enqueue) already have their own inline handling so the
    // cycle can continue with the next chat — this outer catch is what
    // fires for anything that escapes ALL of that step-level handling
    // (including the message fetch itself, which previously logged and
    // returned with zero durable evidence on failure). Any such throw
    // records a terminal-failure enrichment_runs row using whatever counts
    // were known before the throw, instead of the cycle vanishing silently.
    try {
      const messages = getUnprocessedMessages(this.db, config.enrichmentBatchSize);

      if (messages.length === 0) return;

      log.debug({ count: messages.length }, 'enrichment: processing messages');

      // Group by chatJid
      const byChat = new Map<string, StoredMessage[]>();
      for (const msg of messages) {
        const existing = byChat.get(msg.chatJid);
        if (existing) {
          existing.push(msg);
        } else {
          byChat.set(msg.chatJid, [msg]);
        }
      }

      for (const [chatJid, chatMessages] of byChat) {
        try {
          const facts = await extractFacts(this.extractionProvider, chatMessages);
          if (this.stopped) return;
          totalExtracted = totalExtracted + facts.length;

          if (facts.length === 0) {
            for (const msg of chatMessages) successPks.push(msg.pk);
            continue;
          }

          const validated = await validateFacts(this.validationProvider, facts, chatMessages);
          if (this.stopped) return;

          if (validated.length === 0) {
            for (const msg of chatMessages) successPks.push(msg.pk);
            continue;
          }

          // Enqueue validated facts for an external Pinecone exporter. Source
          // messages are marked processed after successful queueing, NOT after
          // Pinecone write. A deployment-provided bridge, if configured, owns the
          // remote upsert and calls markFactsExported after Pinecone confirms.
          //
          // Queue accounting-gated promotion: we only mark the segment's
          // messages as processed if the queue accepted every fact without
          // a hard failure. `failed === 0 && inserted + duplicates === facts.length`
          // captures both the "all new" and the "some idempotent duplicates"
          // happy paths; any mismatch means at least one fact did not land
          // and the source messages must remain eligible for retry.
          const exportable = validated.map(toExportable);
          const result = enqueueFacts(this.db, exportable);
          totalQueued = totalQueued + result.inserted;

          const accountingOk =
            result.failed === 0 &&
            result.inserted + result.duplicates === exportable.length;

          if (accountingOk) {
            for (const msg of chatMessages) successPks.push(msg.pk);
          } else {
            log.warn(
              {
                chatJid,
                expected: exportable.length,
                attempted: result.attempted,
                inserted: result.inserted,
                duplicates: result.duplicates,
                failed: result.failed,
                segmentMessagePks: chatMessages.map((m) => m.pk),
                ...(runId ? { runId } : {}),
              },
              'enrichment: queue accounting mismatch — segment messages NOT marked processed',
            );
          }
        } catch (err) {
          log.error({ err, chatJid }, 'enrichment: segment processing failed');
          const retryPks: number[] = [];
          for (const msg of chatMessages) {
            // enrichmentRetries is the count BEFORE this failure (read from DB)
            const nextRetry = msg.enrichmentRetries + 1;
            if (nextRetry >= config.enrichmentMaxRetries) {
              log.warn(
                { pk: msg.pk, chatJid, retries: nextRetry },
                'enrichment: message permanently failed — max_retries_exceeded',
              );
              failedPks.push(msg.pk);
            } else {
              retryPks.push(msg.pk);
            }
          }
          // Persist incremented retry counts for messages that will be retried
          try {
            incrementEnrichmentRetries(this.db, retryPks);
          } catch (dbErr) {
            log.error({ err: dbErr }, 'enrichment: failed to persist retry counters');
          }
        }
      }

      // Mark successes as processed
      try {
        markMessagesProcessed(this.db, successPks);
      } catch (err) {
        log.error({ err }, 'enrichment: failed to mark messages processed');
      }

      // Mark terminal failures
      try {
        markMessagesWithError(this.db, failedPks, 'max_retries_exceeded');
      } catch (err) {
        log.error({ err }, 'enrichment: failed to mark messages with error');
      }

      const messagesProcessed = successPks.length + failedPks.length;
      const durationMs = Date.now() - cycleStart;

      // Write to enrichment_runs table. `facts_upserted` is retained as the
      // column name for wire-compatibility with existing metrics readers; the
      // value now represents facts successfully queued for external export. It
      // is not proof that a Pinecone upsert has happened.
      try {
        this.db.raw.prepare(`
          INSERT INTO enrichment_runs (started_at, completed_at, messages_processed, facts_extracted, facts_upserted)
          VALUES (?, datetime('now'), ?, ?, ?)
        `).run(new Date(cycleStart).toISOString(), messagesProcessed, totalExtracted, totalQueued);
      } catch (err) {
        log.error({ err }, 'enrichment: failed to write enrichment_runs record');
      }

      log.info(
        {
          messagesProcessed,
          factsExtracted: totalExtracted,
          factsQueued: totalQueued,
          durationMs,
          ...(runId ? { runId } : {}),
        },
        'enrichment: cycle complete',
      );

      this.lastRunAt = new Date().toISOString();
    } catch (err) {
      // Unexpected throw that escaped every step-level handler above —
      // including a message-fetch failure, which is the realistic case:
      // a DB error here used to just log and return with no durable
      // evidence at all. Record a terminal-failure enrichment_runs row
      // using whatever counts were accumulated before the throw.
      const messagesProcessedAtFailure = successPks.length + failedPks.length;
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err }, 'enrichment: cycle failed — recording failure run');
      try {
        this.db.raw.prepare(`
          INSERT INTO enrichment_runs (started_at, completed_at, messages_processed, facts_extracted, facts_upserted, error)
          VALUES (?, datetime('now'), ?, ?, ?, ?)
        `).run(new Date(cycleStart).toISOString(), messagesProcessedAtFailure, totalExtracted, totalQueued, message);
      } catch (writeErr) {
        log.error({ err: writeErr }, 'enrichment: failed to write enrichment_runs failure record');
      }
      this.lastRunAt = new Date().toISOString();
    }
  }
}
