import { Pinecone } from '@pinecone-database/pinecone';
import { config } from '../../../config.ts';
import { createChildLogger } from '../../../logger.ts';
import { WhatSoupError as AppError } from '../../../errors.ts';
import { truncateForRerank } from '../../../lib/text-utils.ts';
import { emitAlert, clearAlertSource } from '../../../lib/emit-alert.ts';
import { CircuitBreaker } from '../../../core/circuit-breaker.ts';
import { sleep } from '../../../core/retry.ts';

const logger = createChildLogger('pinecone-provider');

const FAILURE_ALERT_THRESHOLD = 3;
const RETRY_DELAY_MS = 500;

/** Per-operation circuit breakers (threshold=3, reset after 30s) */
const breakers: Record<string, CircuitBreaker> = {};

function getBreaker(operation: string): CircuitBreaker {
  if (!breakers[operation]) {
    breakers[operation] = new CircuitBreaker(operation, FAILURE_ALERT_THRESHOLD, 30_000, logger);
  }
  return breakers[operation];
}

function trackFailure(operation: string, err: unknown): void {
  const breaker = getBreaker(operation);
  breaker.recordFailure();
  const message = err instanceof Error ? err.message : String(err);

  logger.warn(
    { operation, error: message },
    'pinecone_api_error',
  );

  if (breaker.isOpen()) {
    alertedOperations.add(operation);
    emitAlert(
      config.botName,
      'pinecone_degraded',
      `Pinecone ${operation} circuit breaker tripped`,
      `Last error: ${message}`,
    );
  }
}

/** Track operations that have had alerts emitted, so we can clear on recovery. */
const alertedOperations = new Set<string>();

function trackSuccess(operation: string): void {
  getBreaker(operation).recordSuccess();
  if (alertedOperations.has(operation)) {
    alertedOperations.delete(operation);
    clearAlertSource(config.botName, 'pinecone_degraded');
  }
}

function isBreakerOpen(operation: string): boolean {
  return getBreaker(operation).isOpen();
}


export interface MemoryRecord {
  id: string;
  text: string;
  chatJid: string;
  senderJid: string;
  senderName: string;
  memoryType: 'user_fact' | 'group_context' | 'preference' | 'correction' | 'self_fact';
  confidence: number;
  createdAt: string;
  updatedAt: string;
  superseded: string;
  sourceMessagePks: string;
}

export interface SearchResult {
  id: string;
  score: number;
  record: MemoryRecord;
}

export interface EntityRecord {
  id: string;
  text: string;
  entityType: string;
  source: string;
  metadata: Record<string, unknown>;
}

export interface EntitySearchResult {
  id: string;
  score: number;
  record: EntityRecord;
}

type PineconeRecord = {
  _id: string;
  text: string;
  chat_jid: string;
  sender_jid: string;
  sender_name: string;
  memory_type: string;
  confidence: number;
  created_at: string;
  updated_at: string;
  superseded: string;
  source_message_pks: string;
  [key: string]: string | number | boolean | string[];
};

function toPineconeRecord(record: MemoryRecord): PineconeRecord {
  const raw: Record<string, string | number | boolean | string[] | undefined | null> = {
    _id: record.id,
    text: record.text,
    chat_jid: record.chatJid,
    sender_jid: record.senderJid,
    sender_name: record.senderName,
    memory_type: record.memoryType,
    confidence: record.confidence,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    superseded: record.superseded,
    source_message_pks: record.sourceMessagePks,
  };

  // Strip null/undefined values — Pinecone requires primitive fields only
  const cleaned: Record<string, string | number | boolean | string[]> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value !== null && value !== undefined) {
      cleaned[key] = value;
    }
  }

  return cleaned as PineconeRecord;
}

function fromPineconeHit(hit: {
  _id: string;
  _score: number;
  fields: object;
}): SearchResult {
  const f = hit.fields as Record<string, unknown>;

  const record: MemoryRecord = {
    id: hit._id,
    text: (f['text'] as string) ?? '',
    chatJid: (f['chat_jid'] as string) ?? '',
    senderJid: (f['sender_jid'] as string) ?? '',
    senderName: (f['sender_name'] as string) ?? '',
    memoryType: (f['memory_type'] as MemoryRecord['memoryType']) ?? 'user_fact',
    confidence: (f['confidence'] as number) ?? 0,
    createdAt: (f['created_at'] as string) ?? '',
    updatedAt: (f['updated_at'] as string) ?? '',
    superseded: (f['superseded'] as string) ?? '',
    sourceMessagePks: (f['source_message_pks'] as string) ?? '',
  };

  return { id: hit._id, score: hit._score, record };
}

function fromPineconeHitEntity(hit: {
  _id: string;
  _score: number;
  fields: object;
}): EntitySearchResult {
  const f = hit.fields as Record<string, unknown>;

  // Collect all non-reserved fields as metadata
  const reservedFields = new Set(['text', 'entity_type', 'source']);
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(f)) {
    if (!reservedFields.has(key)) {
      metadata[key] = value;
    }
  }

  const record: EntityRecord = {
    id: hit._id,
    text: (f['text'] as string) ?? '',
    entityType: (f['entity_type'] as string) ?? 'unknown',
    source: (f['source'] as string) ?? '',
    metadata,
  };

  return { id: hit._id, score: hit._score, record };
}

export class PineconeMemory {
  private client: Pinecone;
  private index: ReturnType<InstanceType<typeof Pinecone>['index']>;

  constructor() {
    this.client = new Pinecone({ apiKey: process.env.PINECONE_API_KEY ?? '' });
    this.index = this.client.index(config.pineconeIndex);
  }

  async search(
    query: string,
    filters: Record<string, unknown>,
    topK: number,
  ): Promise<SearchResult[]> {
    if (isBreakerOpen('search')) {
      logger.warn('pinecone search circuit breaker open — skipping');
      return [];
    }

    const doSearch = () =>
      this.index.searchRecords({
        query: {
          topK,
          inputs: { text: query },
          filter: filters,
        },
        fields: ['*'],
      });

    const startMs = Date.now();
    try {
      const response = await doSearch();
      const results = (response.result.hits ?? []).map(fromPineconeHit);
      const durationMs = Date.now() - startMs;
      logger.info(
        { topScores: results.slice(0, 3).map((r) => r.score), durationMs },
        'Pinecone search complete',
      );
      trackSuccess('search');
      return results;
    } catch (err) {
      // One retry after a short delay to catch transient blips
      await sleep(RETRY_DELAY_MS);
      try {
        const response = await doSearch();
        const results = (response.result.hits ?? []).map(fromPineconeHit);
        const durationMs = Date.now() - startMs;
        logger.info(
          { topScores: results.slice(0, 3).map((r) => r.score), durationMs, retried: true },
          'Pinecone search complete (after retry)',
        );
        trackSuccess('search');
        return results;
      } catch (retryErr) {
        const durationMs = Date.now() - startMs;
        trackFailure('search', retryErr);
        logger.error(
          { err: retryErr, query: query.slice(0, 100), topK, filter: filters, durationMs },
          'Pinecone search failed — returning empty results',
        );
        return [];
      }
    }
  }

  private searchByField(
    query: string,
    field: string,
    value: string,
    topK: number,
  ): Promise<SearchResult[]> {
    return this.search(query, { [field]: { $eq: value } }, topK);
  }

  async searchForChat(chatJid: string, query: string): Promise<SearchResult[]> {
    return this.searchByField(query, 'chat_jid', chatJid, config.pineconeContextTopK);
  }

  async searchForSender(senderJid: string, query: string): Promise<SearchResult[]> {
    return this.searchByField(query, 'sender_jid', senderJid, config.pineconeSenderTopK);
  }

  async searchSelfFacts(query: string): Promise<SearchResult[]> {
    return this.searchByField(query, 'memory_type', 'self_fact', config.pineconeSelfFactTopK);
  }

  async searchEntities(query: string): Promise<EntitySearchResult[]> {
    if (isBreakerOpen('searchEntities')) {
      logger.warn('pinecone searchEntities circuit breaker open — skipping');
      return [];
    }

    const doSearch = () =>
      this.index.searchRecords({
        query: {
          topK: config.pineconeTopK,
          inputs: { text: query },
          filter: { source: { $ne: 'archive_db' } },
        },
        fields: ['*'],
      });

    const startMs = Date.now();
    try {
      // Phase 1: vector search (no server-side rerank — docs may exceed 512-token reranker limit)
      let response: Awaited<ReturnType<typeof doSearch>>;
      try {
        response = await doSearch();
      } catch (firstErr) {
        logger.debug({ err: (firstErr as Error).message, operation: 'searchEntities' }, 'pinecone_first_attempt_failed');
        // One retry after short delay
        await sleep(RETRY_DELAY_MS);
        response = await doSearch();
      }

      const hits = response.result.hits ?? [];
      let mapped = hits.map(fromPineconeHitEntity);

      // Phase 2: client-side rerank with truncated text to stay within token limits
      if (config.pineconeRerank && mapped.length > 0) {
        try {
          const rerankResult = await this.client.inference.rerank({
            model: 'pinecone-rerank-v0',
            query,
            documents: mapped.map((r) => ({ id: r.id, text: truncateForRerank(r.record.text) })),
            topN: config.pineconeRerankTopN,
            rankFields: ['text'],
            returnDocuments: false,
          });

          // Rebuild ordered results from rerank response
          const reranked: EntitySearchResult[] = [];
          for (const doc of rerankResult.data) {
            const original = mapped[doc.index];
            if (original) {
              reranked.push({ ...original, score: doc.score });
            }
          }
          mapped = reranked;
        } catch (rerankErr) {
          trackFailure('rerank', rerankErr);
          logger.warn({ err: rerankErr }, 'Client-side rerank failed — using vector scores');
        }
      }

      // Exact-ID dedup
      const seen = new Set<string>();
      const deduped: EntitySearchResult[] = [];
      for (const result of mapped) {
        if (!seen.has(result.id)) {
          seen.add(result.id);
          deduped.push(result);
        }
      }

      // Cap transcript chunks (entity_type: 'notes') to 2
      let notesCount = 0;
      const capped: EntitySearchResult[] = [];
      for (const result of deduped) {
        if (result.record.entityType === 'notes') {
          if (notesCount < 2) {
            notesCount++;
            capped.push(result);
          }
        } else {
          capped.push(result);
        }
      }

      const durationMs = Date.now() - startMs;
      logger.info(
        { topScores: capped.slice(0, 3).map((r) => r.score), total: capped.length, durationMs },
        'Pinecone entity search complete',
      );
      trackSuccess('searchEntities');
      return capped;
    } catch (err) {
      const durationMs = Date.now() - startMs;
      trackFailure('searchEntities', err);
      logger.error(
        { err, query: query.slice(0, 100), durationMs },
        'Pinecone entity search failed — returning empty results',
      );
      return [];
    }
  }

  async upsert(records: MemoryRecord[]): Promise<void> {
    if (records.length === 0) return;

    if (isBreakerOpen('upsert')) {
      logger.warn('pinecone upsert circuit breaker open — skipping');
      throw new AppError('Pinecone circuit breaker open', 'PINECONE_UNAVAILABLE');
    }

    const pineconeRecords = records.map(toPineconeRecord);
    const startMs = Date.now();
    const doUpsert = () => this.index.upsertRecords({ records: pineconeRecords });

    try {
      await doUpsert();
      const durationMs = Date.now() - startMs;
      logger.info(
        { count: records.length, ids: records.map((r) => r.id), durationMs },
        'Pinecone upsert complete',
      );
      trackSuccess('upsert');
    } catch (err) {
      // One retry after short delay
      await sleep(RETRY_DELAY_MS);
      try {
        await doUpsert();
        const durationMs = Date.now() - startMs;
        logger.info(
          { count: records.length, ids: records.map((r) => r.id), durationMs, retried: true },
          'Pinecone upsert complete (after retry)',
        );
        trackSuccess('upsert');
      } catch (retryErr) {
        trackFailure('upsert', retryErr);
        logger.error({ err: retryErr, count: records.length }, 'Pinecone upsert failed');
        throw new AppError('Pinecone upsert failed', 'PINECONE_UNAVAILABLE', retryErr);
      }
    }
  }

  async checkDuplicate(
    chatJid: string,
    senderJid: string,
    text: string,
    threshold: number = config.enrichmentDedupThreshold,
  ): Promise<{ isDuplicate: boolean; existingId?: string; score?: number }> {
    const filters: Record<string, unknown> = {
      chat_jid: { $eq: chatJid },
    };
    if (senderJid) {
      filters['sender_jid'] = { $eq: senderJid };
    }

    const results = await this.search(text, filters, 1);

    if (results.length > 0 && results[0].score >= threshold) {
      return { isDuplicate: true, existingId: results[0].id, score: results[0].score };
    }

    return { isDuplicate: false };
  }
}
