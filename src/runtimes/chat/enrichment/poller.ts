import { config } from '../../../config.ts';
import { createChildLogger } from '../../../logger.ts';
import type { Database } from '../../../core/database.ts';
import { getUnprocessedMessages, markMessagesProcessed, markMessagesWithError, incrementEnrichmentRetries } from '../../../core/messages.ts';
import type { LLMProvider } from '../providers/types.ts';
import type { PineconeMemory } from '../providers/pinecone.ts';
import type { StoredMessage } from '../../../core/messages.ts';
import { extractFacts } from './extractor.ts';
import { validateFacts } from './validator.ts';
import { upsertFacts } from './upserter.ts';

const log = createChildLogger('enrichment');

export class EnrichmentPoller {
  private timer: NodeJS.Timeout | null = null;
  private db: Database;
  private pinecone: PineconeMemory;
  private extractionProvider: LLMProvider;
  private validationProvider: LLMProvider;
  private stopped = false;
  public lastRunAt: string | null = null;

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

    let messages: StoredMessage[];
    try {
      messages = getUnprocessedMessages(this.db, config.enrichmentBatchSize);
    } catch (err) {
      log.error({ err }, 'enrichment: failed to fetch unprocessed messages');
      return;
    }

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

    let totalExtracted = 0;
    let totalUpserted = 0;
    let totalDeduplicated = 0;
    let totalSuperseded = 0;
    const successPks: number[] = [];
    const failedPks: number[] = [];

    for (const [chatJid, chatMessages] of byChat) {
      try {
        const facts = await extractFacts(this.extractionProvider, chatMessages);
        totalExtracted = totalExtracted + facts.length;

        if (facts.length === 0) {
          for (const msg of chatMessages) successPks.push(msg.pk);
          continue;
        }

        const validated = await validateFacts(this.validationProvider, facts, chatMessages);

        if (validated.length === 0) {
          for (const msg of chatMessages) successPks.push(msg.pk);
          continue;
        }

        const { upserted, deduplicated, superseded } = await upsertFacts(this.pinecone, validated);
        totalUpserted = totalUpserted + upserted;
        totalDeduplicated = totalDeduplicated + deduplicated;
        totalSuperseded = totalSuperseded + superseded;

        for (const msg of chatMessages) successPks.push(msg.pk);
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

    // Write to enrichment_runs table
    try {
      this.db.raw.prepare(`
        INSERT INTO enrichment_runs (started_at, completed_at, messages_processed, facts_extracted, facts_upserted)
        VALUES (?, datetime('now'), ?, ?, ?)
      `).run(new Date(cycleStart).toISOString(), messagesProcessed, totalExtracted, totalUpserted);
    } catch (err) {
      log.error({ err }, 'enrichment: failed to write enrichment_runs record');
    }

    log.info(
      {
        messagesProcessed,
        factsExtracted: totalExtracted,
        factsUpserted: totalUpserted,
        durationMs,
      },
      'enrichment: cycle complete',
    );

    this.lastRunAt = new Date().toISOString();
  }
}
