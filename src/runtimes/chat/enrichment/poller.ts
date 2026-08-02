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
import {
  readOnlineEnrichmentCycleLedger,
  writeEnrichmentCycleReceipt,
  type EnrichmentCycleFailureCode,
  type EnrichmentCycleReceipt,
  type EnrichmentCycleStage,
} from './cycle-receipt.ts';

const log = createChildLogger('enrichment');

export type EnrichmentCycleHealthState =
  | 'not_started'
  | 'no_work'
  | 'current'
  | 'partial'
  | 'failed'
  | 'stale'
  | 'unreadable'
  | 'invalid';

function failureCodeForStage(stage: EnrichmentCycleStage): EnrichmentCycleFailureCode {
  switch (stage) {
    case 'selection':
      return 'selection_failed';
    case 'message_state':
      return 'message_state_write_failed';
    case 'ledger':
      return 'ledger_write_failed';
    case 'none':
    case 'segment':
      return 'segment_failed';
  }
}

export class EnrichmentPoller {
  private timer: NodeJS.Timeout | null = null;
  private db: Database;
  private pinecone: PineconeMemory;
  private extractionProvider: LLMProvider;
  private validationProvider: LLMProvider;
  private stopped = false;
  public lastRunAt: string | null = null;
  public latestCycleReceipt: EnrichmentCycleReceipt | null = null;
  private receiptReadState: 'not_started' | 'available' | 'invalid' | 'unreadable' = 'not_started';

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

  get cycleHealthState(): EnrichmentCycleHealthState {
    if (this.receiptReadState === 'invalid') return 'invalid';
    if (this.receiptReadState === 'unreadable') return 'unreadable';
    if (!this.latestCycleReceipt) return 'not_started';
    switch (this.latestCycleReceipt.status) {
      case 'no_work':
        return 'no_work';
      case 'completed':
        return 'current';
      case 'partial':
      case 'failed':
        return this.latestCycleReceipt.status;
      case 'legacy_unclassified':
        return 'invalid';
    }
  }

  hydrateLatestCycleReceipt(): void {
    try {
      const ledger = readOnlineEnrichmentCycleLedger(this.db);
      if (ledger.state === 'available') {
        this.latestCycleReceipt = ledger.receipt;
        this.lastRunAt = ledger.lastSuccessfulAt;
        this.receiptReadState = 'available';
      } else {
        this.latestCycleReceipt = null;
        this.lastRunAt = null;
        this.receiptReadState = ledger.state === 'absent' ? 'not_started' : 'invalid';
      }
    } catch {
      this.latestCycleReceipt = null;
      this.lastRunAt = null;
      this.receiptReadState = 'unreadable';
      log.error({ stage: 'ledger' }, 'enrichment: cycle receipt ledger is unreadable');
    }
  }

  private persistReceipt(receipt: EnrichmentCycleReceipt): boolean {
    try {
      writeEnrichmentCycleReceipt(this.db, receipt);
    } catch {
      this.latestCycleReceipt = null;
      this.receiptReadState = 'unreadable';
      log.error(
        { failureCode: 'ledger_write_failed', stage: 'ledger' },
        'enrichment: failed to write enrichment-cycle receipt',
      );
      return false;
    }

    this.latestCycleReceipt = receipt;
    this.receiptReadState = 'available';
    if (receipt.successAt !== null) this.lastRunAt = receipt.successAt;
    return true;
  }

  start(): void {
    if (this.timer !== null) {
      log.warn('EnrichmentPoller.start() called while already running');
      return;
    }
    this.stopped = false;
    this.hydrateLatestCycleReceipt();
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
    } catch {
      // runCycle has comprehensive internal error handling; this catch is a
      // last-resort safety net ensuring the poller always reschedules even if
      // an unexpected bug causes runCycle to throw past its own finally block.
      log.error({ stage: 'ledger' }, 'enrichment: unexpected error in tick — rescheduling');
    }
    if (this.stopped === false) {
      this.scheduleNext();
    }
  }

  private async runCycle(): Promise<void> {
    const cycleStart = Date.now();

    let totalExtracted = 0;
    let totalQueued = 0;
    let messagesSelected = 0;
    let stage: EnrichmentCycleStage = 'selection';
    let segmentFailed = false;
    let successStateWriteFailed = false;
    let terminalStateWriteFailed = false;
    let interrupted = false;
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
      messagesSelected = messages.length;

      if (messages.length === 0) {
        const completedAt = new Date().toISOString();
        this.persistReceipt({
          source: 'online',
          status: 'no_work',
          failureCode: 'none',
          stage: 'none',
          retryable: false,
          evidenceCoverage: 'typed',
          startedAt: new Date(cycleStart).toISOString(),
          completedAt,
          successAt: completedAt,
          messagesSelected: 0,
          messagesSucceeded: 0,
          messagesDeferred: 0,
          messagesTerminal: 0,
          factsExtracted: 0,
          factsQueued: 0,
        });
        return;
      }

      stage = 'segment';

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
          const facts = await extractFacts(this.extractionProvider, chatMessages, { strict: true });
          if (this.stopped) {
            interrupted = true;
            break;
          }
          totalExtracted = totalExtracted + facts.length;

          if (facts.length === 0) {
            for (const msg of chatMessages) successPks.push(msg.pk);
            continue;
          }

          const validated = await validateFacts(
            this.validationProvider,
            facts,
            chatMessages,
            { strict: true },
          );
          if (this.stopped) {
            interrupted = true;
            break;
          }

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
            segmentFailed = true;
            log.warn(
              {
                failureCode: 'segment_failed',
                stage: 'segment',
                expected: exportable.length,
                attempted: result.attempted,
                inserted: result.inserted,
                duplicates: result.duplicates,
                failed: result.failed,
              },
              'enrichment: queue accounting mismatch — segment messages NOT marked processed',
            );
          }
        } catch {
          // Deliberately untyped: ExtractionError/ValidationError (both extend the
          // shared EnrichmentError base, #2846) carry a finer provider-call/json-parse/
          // schema-shape/schema-items-all-dropped stage for structured logging at throw
          // time, but the cycle receipt's failureCode/stage vocabulary (cycle-receipt.ts)
          // is bounded at the coarser selection/segment/message_state/ledger level by
          // design (#2565) — the durable ledger and health projection must never carry
          // raw exception detail. Narrowing on `instanceof EnrichmentError` here would
          // have no receipt field to populate; any segment failure, typed or not, is
          // uniformly `segment_failed`/`segment`.
          segmentFailed = true;
          log.error(
            { failureCode: 'segment_failed', stage: 'segment', messages: chatMessages.length },
            'enrichment: segment processing failed',
          );
          const retryPks: number[] = [];
          for (const msg of chatMessages) {
            // enrichmentRetries is the count BEFORE this failure (read from DB)
            const nextRetry = msg.enrichmentRetries + 1;
            if (nextRetry >= config.enrichmentMaxRetries) {
              log.warn(
                { failureCode: 'segment_failed', stage: 'segment', retries: nextRetry },
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
          } catch {
            successStateWriteFailed = true;
            log.error(
              { failureCode: 'message_state_write_failed', stage: 'message_state' },
              'enrichment: failed to persist retry counters',
            );
          }
        }
      }

      if (interrupted) {
        const completedAt = new Date().toISOString();
        this.persistReceipt({
          source: 'online',
          status: 'partial',
          failureCode: 'segment_failed',
          stage: 'segment',
          retryable: true,
          evidenceCoverage: 'typed',
          startedAt: new Date(cycleStart).toISOString(),
          completedAt,
          successAt: null,
          messagesSelected,
          messagesSucceeded: 0,
          messagesDeferred: messagesSelected,
          messagesTerminal: 0,
          factsExtracted: totalExtracted,
          factsQueued: totalQueued,
        });
        return;
      }

      stage = 'message_state';
      let messagesSucceeded = successPks.length;
      let messagesTerminal = failedPks.length;

      // Mark successes as processed
      try {
        markMessagesProcessed(this.db, successPks);
      } catch {
        successStateWriteFailed = true;
        messagesSucceeded = 0;
        log.error(
          { failureCode: 'message_state_write_failed', stage },
          'enrichment: failed to mark messages processed',
        );
      }

      // Mark terminal failures
      try {
        markMessagesWithError(this.db, failedPks, 'max_retries_exceeded');
      } catch {
        terminalStateWriteFailed = true;
        messagesTerminal = 0;
        log.error(
          { failureCode: 'message_state_write_failed', stage },
          'enrichment: failed to mark messages with error',
        );
      }

      const messageStateWriteFailed = successStateWriteFailed || terminalStateWriteFailed;
      const messagesDeferred = Math.max(
        0,
        messagesSelected - messagesSucceeded - messagesTerminal,
      );
      const hasCommittedOutcome = messagesSucceeded > 0 || messagesTerminal > 0;
      const status = messageStateWriteFailed
        ? (hasCommittedOutcome ? 'partial' : 'failed')
        : segmentFailed
          ? (messagesSucceeded > 0 ? 'partial' : 'failed')
          : 'completed';
      const failureCode = messageStateWriteFailed
        ? 'message_state_write_failed'
        : segmentFailed
          ? 'segment_failed'
          : 'none';
      const outcomeStage: EnrichmentCycleStage = messageStateWriteFailed
        ? 'message_state'
        : segmentFailed
          ? 'segment'
          : 'none';
      const completedAt = new Date().toISOString();
      const successAt = status === 'completed' ? completedAt : null;
      this.persistReceipt({
        source: 'online',
        status,
        failureCode,
        stage: outcomeStage,
        retryable: status !== 'completed' && messagesDeferred > 0,
        evidenceCoverage: 'typed',
        startedAt: new Date(cycleStart).toISOString(),
        completedAt,
        successAt,
        messagesSelected,
        messagesSucceeded,
        messagesDeferred,
        messagesTerminal,
        factsExtracted: totalExtracted,
        factsQueued: totalQueued,
      });

      const messagesProcessed = messagesSucceeded + messagesTerminal;
      const durationMs = Date.now() - cycleStart;

      log.info(
        {
          status,
          failureCode,
          messagesProcessed,
          factsExtracted: totalExtracted,
          factsQueued: totalQueued,
          durationMs,
        },
        'enrichment: cycle complete',
      );
    } catch {
      // Unexpected throw that escaped every step-level handler above —
      // including a message-fetch failure, which is the realistic case:
      // a DB error here used to just log and return with no durable
      // evidence at all. Record a terminal-failure enrichment_runs row
      // using whatever counts were accumulated before the throw.
      //
      // Deliberately do NOT update lastRunAt here: the runtime separately
      // projects the latest failed receipt and the prior proven success. A
      // failed cycle must not refresh the success clock while its typed
      // receipt keeps health degraded.
      const failureCode = failureCodeForStage(stage);
      const completedAt = new Date().toISOString();
      log.error({ failureCode, stage }, 'enrichment: cycle failed — recording failure receipt');
      this.persistReceipt({
        source: 'online',
        status: 'failed',
        failureCode,
        stage,
        retryable: true,
        evidenceCoverage: 'typed',
        startedAt: new Date(cycleStart).toISOString(),
        completedAt,
        successAt: null,
        messagesSelected,
        messagesSucceeded: 0,
        messagesDeferred: messagesSelected,
        messagesTerminal: 0,
        factsExtracted: totalExtracted,
        factsQueued: totalQueued,
      });
    }
  }
}
