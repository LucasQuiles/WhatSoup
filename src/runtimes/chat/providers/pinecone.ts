import { Pinecone } from '@pinecone-database/pinecone';
import { config } from '../../../config.ts';
import { createChildLogger } from '../../../logger.ts';
import { WhatSoupError as AppError } from '../../../errors.ts';
import { truncateForRerank } from '../../../lib/text-utils.ts';
import { errorMessage } from '../../../lib/error-message.ts';
import { shortHash } from '../../../lib/short-hash.ts';
import { resolveApiKey } from '../../../lib/api-key-resolver.ts';
import { emitAlertChecked, clearAlertSourceChecked } from '../../../lib/emit-alert.ts';
import { CircuitBreaker } from '../../../core/circuit-breaker.ts';
import { sleep } from '../../../core/retry.ts';
import {
  findPineconeIndex,
  hasPineconeProjectGuard,
  matchesPineconeProjectGuard,
  pineconeProjectGuardError,
  type PineconeProjectGuard,
} from '../../../lib/pinecone-project-guard.ts';

const logger = createChildLogger('pinecone-provider');

const FAILURE_ALERT_THRESHOLD = 3;
const RETRY_DELAY_MS = 500;

/** Per-operation circuit breakers (threshold=3, reset after 30s) */
const breakers: Record<string, CircuitBreaker> = {};

function queryLogFields(query: string): { queryHash: string; queryLength: number } {
  return {
    queryHash: shortHash(query),
    queryLength: query.length,
  };
}

function getBreaker(operation: string): CircuitBreaker {
  if (!breakers[operation]) {
    breakers[operation] = new CircuitBreaker(operation, FAILURE_ALERT_THRESHOLD, 30_000, logger);
  }
  return breakers[operation];
}

function trackFailure(operation: string, err: unknown): void {
  const breaker = getBreaker(operation);
  breaker.recordFailure();
  const message = errorMessage(err);

  logger.warn(
    { operation, error: message },
    'pinecone_api_error',
  );

  if (breaker.isOpen()) {
    alertedOperations.add(operation);
    emitAlertChecked(
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
    clearAlertSourceChecked(config.botName, 'pinecone_degraded');
  }
}

function isBreakerOpen(operation: string): boolean {
  return getBreaker(operation).isOpen();
}

export type PineconeReadinessState =
  | 'disabled'
  | 'auth_failed'
  | 'index_missing'
  | 'project_mismatch'
  | 'network_error'
  | 'ready';

function classifyReadinessError(err: unknown): Extract<PineconeReadinessState, 'auth_failed' | 'network_error'> {
  const status = typeof err === 'object' && err !== null && 'status' in err
    ? (err as { status?: number }).status
    : undefined;
  if (status === 401 || status === 403) {
    return 'auth_failed';
  }

  const cause = typeof err === 'object' && err !== null && 'cause' in err
    ? (err as { cause?: { code?: string } }).cause
    : undefined;
  if (cause?.code && ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'].includes(cause.code)) {
    return 'network_error';
  }

  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TypeError')) {
    return 'network_error';
  }

  return 'auth_failed';
}

export async function getPineconeReadiness(indexName: string = config.pineconeIndex): Promise<{
  state: PineconeReadinessState;
  index: string;
}> {
  const targetIndex = indexName.trim();
  if (!targetIndex) {
    return { state: 'disabled', index: targetIndex };
  }

  const apiKey = resolvePineconeApiKey().trim();
  if (!apiKey) {
    return { state: 'disabled', index: targetIndex };
  }

  const guard = configuredPineconeProjectGuard();
  if (missingRequiredProjectGuardError(guard)) {
    return { state: 'project_mismatch', index: targetIndex };
  }

  try {
    const client = new Pinecone({ apiKey });
    const found = findPineconeIndex(await client.listIndexes(), targetIndex);

    if (found) {
      if (!matchesPineconeProjectGuard(found.host, guard)) {
        return { state: 'project_mismatch', index: targetIndex };
      }
      return { state: 'ready', index: targetIndex };
    }

    return { state: 'index_missing', index: targetIndex };
  } catch (err) {
    const state = classifyReadinessError(err);
    logger.warn({ err, indexName: targetIndex, state }, 'pinecone readiness check failed');
    return { state, index: targetIndex };
  }
}

function configuredPineconeApiKeyEnv(): string {
  const memory = (config as { memory?: { pinecone?: { apiKeyEnv?: string } } }).memory;
  const apiKeyEnv = memory?.pinecone?.apiKeyEnv;
  return typeof apiKeyEnv === 'string' && apiKeyEnv.trim() !== '' ? apiKeyEnv : 'PINECONE_API_KEY';
}

// Optional keyring service name for the Pinecone API key. When set (e.g.
// 'pinecone'), resolveApiKey() consults the keyring first, falling back to the
// configured env var. Undefined (the default) preserves env-only behavior.
function configuredPineconeApiKeyService(): string | undefined {
  const memory = (config as { memory?: { pinecone?: { apiKeyService?: string } } }).memory;
  const apiKeyService = memory?.pinecone?.apiKeyService;
  return typeof apiKeyService === 'string' && apiKeyService.trim() !== '' ? apiKeyService : undefined;
}

// Centralized Pinecone API-key resolution through the shared resolver.
// Precedence: apiKeyService keyring lookup (when configured) → configured env var.
function resolvePineconeApiKey(): string {
  return resolveApiKey({
    service: configuredPineconeApiKeyService(),
    envVar: configuredPineconeApiKeyEnv(),
  });
}

function configuredPineconeProjectGuard(): PineconeProjectGuard {
  const memory = (config as { memory?: { pinecone?: { projectId?: string; expectedHostSuffix?: string } } }).memory;
  return {
    projectId: memory?.pinecone?.projectId,
    expectedHostSuffix: memory?.pinecone?.expectedHostSuffix,
  };
}

function pineconeProjectGuardRequired(): boolean {
  const botName = (config as { botName?: unknown }).botName;
  if (typeof botName !== 'string' || botName.trim() === '') return false;
  return botName.trim().toLowerCase() !== 'q';
}

function missingRequiredProjectGuardError(guard: PineconeProjectGuard): string | null {
  if (!pineconeProjectGuardRequired()) return null;
  if (hasPineconeProjectGuard(guard)) return null;
  return 'Pinecone project guard is required for non-q instances';
}

async function configuredProjectGuardError(client: Pinecone, targetIndex: string): Promise<string | null> {
  const guard = configuredPineconeProjectGuard();
  const missingGuardError = missingRequiredProjectGuardError(guard);
  if (missingGuardError) return missingGuardError;
  return pineconeProjectGuardError(client, targetIndex, guard, {
    missingIndex: (indexName) => `Pinecone index "${indexName}" is missing for the configured key`,
    projectMismatch: (indexName) => `Pinecone index "${indexName}" is not in the configured project`,
  });
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
  promotionReason?: string;
  claim?: string;
  evidence?: string;
  warrant?: string;
  confidenceQualifier?: string;
  contradicts?: string;
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

export type PineconeSearchStatus =
  | 'ok'
  | 'breaker_open'
  | 'project_guard_failed'
  | 'failed';

export interface PineconeSearchDetails {
  results: SearchResult[];
  status: PineconeSearchStatus;
  durationMs?: number;
  retried?: boolean;
  error?: string;
  projectGuardError?: string;
}

export interface PineconeEntitySearchDetails {
  results: EntitySearchResult[];
  status: PineconeSearchStatus;
  durationMs?: number;
  retried?: boolean;
  error?: string;
  projectGuardError?: string;
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
    promotion_reason: record.promotionReason,
    claim: record.claim,
    evidence: record.evidence,
    warrant: record.warrant,
    confidence_qualifier: record.confidenceQualifier,
    contradicts: record.contradicts,
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

  if (typeof f['promotion_reason'] === 'string') record.promotionReason = f['promotion_reason'];
  if (typeof f['claim'] === 'string') record.claim = f['claim'];
  if (typeof f['evidence'] === 'string') record.evidence = f['evidence'];
  if (typeof f['warrant'] === 'string') record.warrant = f['warrant'];
  if (typeof f['confidence_qualifier'] === 'string') record.confidenceQualifier = f['confidence_qualifier'];
  if (typeof f['contradicts'] === 'string') record.contradicts = f['contradicts'];

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

// ---------------------------------------------------------------------------
// Recency decay — Ebbinghaus-style exponential forgetting
// ---------------------------------------------------------------------------

const LN2 = 0.693147;

export function decayScore(
  similarity: number,
  ageDays: number,
  halfLifeDays: number,
  maxAgeDays?: number,
): number {
  if (similarity <= 0) return 0;
  if (maxAgeDays !== undefined && ageDays > maxAgeDays) return 0;
  if (halfLifeDays <= 0) return ageDays > 0 ? 0 : similarity;
  return similarity * Math.exp(-LN2 * ageDays / halfLifeDays);
}

export function applyDecay(
  results: SearchResult[],
  halfLifeDays: number,
  maxAgeDays: number,
): SearchResult[] {
  const now = Date.now();
  return results
    .map((r) => {
      const createdMs = new Date(r.record.createdAt).getTime();
      if (isNaN(createdMs)) return { ...r }; // no decay, preserve original score
      const ageDays = Math.max(0, (now - createdMs) / 86_400_000);
      const decayed = decayScore(r.score, ageDays, halfLifeDays, maxAgeDays);
      return { ...r, score: decayed };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
}

export class PineconeMemory {
  private client: Pinecone;
  private index: ReturnType<InstanceType<typeof Pinecone>['index']>;
  private projectGuardCheck: Promise<string | null> | null = null;

  constructor() {
    this.client = new Pinecone({ apiKey: resolvePineconeApiKey() });
    this.index = this.client.index(config.pineconeIndex);
  }

  private async getProjectGuardError(): Promise<string | null> {
    this.projectGuardCheck ??= configuredProjectGuardError(this.client, config.pineconeIndex);
    return this.projectGuardCheck;
  }

  private async _searchCoreDetailed(
    query: string,
    filters: Record<string, unknown>,
    topK: number,
  ): Promise<PineconeSearchDetails> {
    if (isBreakerOpen('search')) {
      logger.warn('pinecone search circuit breaker open — skipping');
      return { results: [], status: 'breaker_open' };
    }
    const projectGuardError = await this.getProjectGuardError();
    if (projectGuardError) {
      logger.error({ projectGuardError, index: config.pineconeIndex }, 'Pinecone project guard failed — skipping search');
      return { results: [], status: 'project_guard_failed', projectGuardError };
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
      return { results, status: 'ok', durationMs };
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
        return { results, status: 'ok', durationMs, retried: true };
      } catch (retryErr) {
        const durationMs = Date.now() - startMs;
        const message = errorMessage(retryErr);
        trackFailure('search', retryErr);
        logger.error(
          { err: retryErr, ...queryLogFields(query), topK, filter: filters, durationMs },
          'Pinecone search failed — returning empty results',
        );
        return { results: [], status: 'failed', durationMs, retried: true, error: message };
      }
    }
  }

  private async _searchCore(
    query: string,
    filters: Record<string, unknown>,
    topK: number,
  ): Promise<SearchResult[]> {
    return (await this._searchCoreDetailed(query, filters, topK)).results;
  }

  async searchDetailed(
    query: string,
    filters: Record<string, unknown>,
    topK: number,
  ): Promise<PineconeSearchDetails> {
    const details = await this._searchCoreDetailed(query, filters, topK);
    return {
      ...details,
      results: applyDecay(details.results, config.recencyHalfLifeDays, config.maxAgeDays),
    };
  }

  async search(
    query: string,
    filters: Record<string, unknown>,
    topK: number,
  ): Promise<SearchResult[]> {
    return (await this.searchDetailed(query, filters, topK)).results;
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
    return (await this.searchEntitiesDetailed(query)).results;
  }

  async searchEntitiesDetailed(query: string): Promise<PineconeEntitySearchDetails> {
    if (isBreakerOpen('searchEntities')) {
      logger.warn('pinecone searchEntities circuit breaker open — skipping');
      return { results: [], status: 'breaker_open' };
    }
    const projectGuardError = await this.getProjectGuardError();
    if (projectGuardError) {
      logger.error({ projectGuardError, index: config.pineconeIndex }, 'Pinecone project guard failed — skipping entity search');
      return { results: [], status: 'project_guard_failed', projectGuardError };
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
    let retried = false;
    try {
      // Step 1: vector search (no server-side rerank — docs may exceed 512-token reranker limit)
      let response: Awaited<ReturnType<typeof doSearch>>;
      try {
        response = await doSearch();
      } catch (firstErr) {
        logger.debug({ err: (firstErr as Error).message, operation: 'searchEntities' }, 'pinecone_first_attempt_failed');
        // One retry after short delay
        retried = true;
        await sleep(RETRY_DELAY_MS);
        response = await doSearch();
      }

      const hits = response.result.hits ?? [];
      let mapped = hits.map(fromPineconeHitEntity);

      // Step 2: client-side rerank with truncated text to stay within token limits
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
      return { results: capped, status: 'ok', durationMs, ...(retried ? { retried } : {}) };
    } catch (err) {
      const durationMs = Date.now() - startMs;
      const message = errorMessage(err);
      trackFailure('searchEntities', err);
      logger.error(
        { err, ...queryLogFields(query), durationMs },
        'Pinecone entity search failed — returning empty results',
      );
      return { results: [], status: 'failed', durationMs, retried, error: message };
    }
  }

  async upsert(records: MemoryRecord[]): Promise<void> {
    if (records.length === 0) return;

    if (isBreakerOpen('upsert')) {
      logger.warn('pinecone upsert circuit breaker open — skipping');
      throw new AppError('Pinecone circuit breaker open', 'PINECONE_UNAVAILABLE');
    }
    const projectGuardError = await this.getProjectGuardError();
    if (projectGuardError) {
      logger.error({ projectGuardError, index: config.pineconeIndex }, 'Pinecone project guard failed — skipping upsert');
      throw new AppError(projectGuardError, 'PINECONE_UNAVAILABLE');
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

    const results = await this._searchCore(text, filters, 1);

    if (results.length > 0 && results[0].score >= threshold) {
      return { isDuplicate: true, existingId: results[0].id, score: results[0].score };
    }

    return { isDuplicate: false };
  }

  async searchClaims(
    chatJid: string,
    senderJid: string,
    claimText: string,
    topK: number = 5,
  ): Promise<SearchResult[]> {
    const filters: Record<string, unknown> = {
      chat_jid: { $eq: chatJid },
    };
    if (senderJid) {
      filters['sender_jid'] = { $eq: senderJid };
    }
    return this._searchCore(claimText, filters, topK);
  }
}
