import { AsyncLocalStorage } from 'node:async_hooks';
import { Pinecone } from '@pinecone-database/pinecone';
import { config } from '../../../config.ts';
import { createChildLogger } from '../../../logger.ts';
import { WhatSoupError as AppError } from '../../../errors.ts';
import { truncateForRerank } from '../../../lib/text-utils.ts';
import { resolveApiKey } from '../../../lib/api-key-resolver.ts';
import { isNonEmptyString } from '../../../lib/type-guards.ts';
import { emitAlertChecked, clearAlertSourceChecked } from '../../../lib/emit-alert.ts';
import { CircuitBreaker } from '../../../core/circuit-breaker.ts';
import { sleep, sleepWithAbort } from '../../../core/retry.ts';
import {
  findPineconeIndex,
  hasPineconeProjectGuard,
  matchesPineconeProjectGuard,
  pineconeProjectGuardError,
  type PineconeProjectGuard,
} from '../../../lib/pinecone-project-guard.ts';
import {
  buildMemoryOperationEvent,
  classifyMemoryFilter,
  classifyMemoryOperationFailure,
  createMemoryOperationContext,
  type MemoryOperation,
  type MemoryOperationContext,
  type MemoryOperationFailure,
  type MemoryOperationFailureCode,
  type MemoryReadinessState,
} from '../../../lib/memory-operation-telemetry.ts';

const logger = createChildLogger('pinecone-provider');

const FAILURE_ALERT_THRESHOLD = 3;
const RETRY_DELAY_MS = 500;
const PROJECT_GUARD_TIMEOUT_MS = 30_000;
const pineconeOperationSignal = new AsyncLocalStorage<AbortSignal | undefined>();

function combinedSignal(
  sdkSignal: AbortSignal | null | undefined,
  operationSignal: AbortSignal | undefined,
): AbortSignal | undefined {
  if (!sdkSignal) return operationSignal;
  if (!operationSignal || sdkSignal === operationSignal) return sdkSignal;
  return AbortSignal.any([sdkSignal, operationSignal]);
}

/** Per-operation circuit breakers (threshold=3, reset after 30s) */
const breakers: Partial<Record<MemoryOperation, CircuitBreaker>> = {};

function getBreaker(operation: MemoryOperation): CircuitBreaker {
  if (!breakers[operation]) {
    breakers[operation] = new CircuitBreaker(operation, FAILURE_ALERT_THRESHOLD, 30_000, logger);
  }
  return breakers[operation];
}

function trackFailure(
  operation: MemoryOperation,
  operationId: string,
  failure: MemoryOperationFailure,
  attempt: 1 | 2,
): void {
  const breaker = getBreaker(operation);
  breaker.recordFailure();

  if (breaker.isOpen()) {
    alertedOperations.add(operation);
    emitAlertChecked(
      config.botName,
      'pinecone_degraded',
      `Pinecone ${operation} circuit breaker tripped`,
      [
        `operation=${operation}`,
        `operation_id=${operationId}`,
        `failure_code=${failure.code}`,
        `retryable=${failure.retryable}`,
        `attempt=${attempt}`,
      ].join(' '),
    );
  }
}

/** Track operations that have had alerts emitted, so we can clear on recovery. */
const alertedOperations = new Set<MemoryOperation>();

function trackSuccess(operation: MemoryOperation): void {
  getBreaker(operation).recordSuccess();
  if (alertedOperations.has(operation)) {
    alertedOperations.delete(operation);
    clearAlertSourceChecked(config.botName, 'pinecone_degraded');
  }
}

function isBreakerOpen(operation: MemoryOperation): boolean {
  return getBreaker(operation).isOpen();
}

function logMemoryOperation(
  context: MemoryOperationContext,
  outcome: Parameters<typeof buildMemoryOperationEvent>[1],
): void {
  const event = buildMemoryOperationEvent(context, outcome);
  if (outcome.status === 'failed') {
    logger.error(event, 'memory_operation');
  } else if (outcome.status === 'partial' || outcome.status === 'skipped') {
    logger.warn(event, 'memory_operation');
  } else {
    logger.info(event, 'memory_operation');
  }
}

export type PineconeReadinessState = MemoryReadinessState;

export interface PineconeReadinessObservation {
  state: PineconeReadinessState;
  index: string;
  observedAt: string;
  failureCode: MemoryOperationFailureCode;
  retryable: boolean;
  evidenceCoverage: 'local_guard' | 'provider_response' | 'provider_error';
}

function readinessObservation(
  state: PineconeReadinessState,
  index: string,
  failureCode: MemoryOperationFailureCode,
  retryable: boolean,
  evidenceCoverage: PineconeReadinessObservation['evidenceCoverage'],
): PineconeReadinessObservation {
  return {
    state,
    index,
    observedAt: new Date().toISOString(),
    failureCode,
    retryable,
    evidenceCoverage,
  };
}

function classifyReadinessError(
  err: unknown,
): Extract<PineconeReadinessState, 'auth_failed' | 'network_error' | 'unknown'> {
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

  return 'unknown';
}

export async function getPineconeReadinessObservation(
  indexName: string = config.pineconeIndex,
): Promise<PineconeReadinessObservation> {
  const operation = createMemoryOperationContext({
    operation: 'readiness',
    scopeKind: 'none',
    filterShape: 'none',
  });
  const startMs = Date.now();
  const targetIndex = indexName.trim();
  if (!targetIndex) {
    logMemoryOperation(operation, {
      stage: 'guard',
      status: 'skipped',
      failureCode: 'none',
      retryable: false,
      attempt: 0,
      resultCount: 0,
      evidenceCoverage: 'local_guard',
    });
    return readinessObservation('disabled', targetIndex, 'none', false, 'local_guard');
  }

  const apiKey = resolvePineconeApiKey().trim();
  if (!apiKey) {
    logMemoryOperation(operation, {
      stage: 'guard',
      status: 'skipped',
      failureCode: 'none',
      retryable: false,
      attempt: 0,
      resultCount: 0,
      evidenceCoverage: 'local_guard',
    });
    return readinessObservation('disabled', targetIndex, 'none', false, 'local_guard');
  }

  const guard = configuredPineconeProjectGuard();
  if (missingRequiredProjectGuardError(guard)) {
    logMemoryOperation(operation, {
      stage: 'guard',
      status: 'failed',
      failureCode: 'project_guard_failed',
      retryable: false,
      attempt: 0,
      resultCount: 0,
      evidenceCoverage: 'local_guard',
    });
    return readinessObservation('project_mismatch', targetIndex, 'project_guard_failed', false, 'local_guard');
  }

  try {
    const client = new Pinecone({ apiKey });
    const found = findPineconeIndex(await client.listIndexes(), targetIndex);

    if (found) {
      if (!matchesPineconeProjectGuard(found.host, guard)) {
        logMemoryOperation(operation, {
          stage: 'guard',
          status: 'failed',
          failureCode: 'project_guard_failed',
          retryable: false,
          attempt: 1,
          resultCount: 0,
          durationMs: Date.now() - startMs,
          evidenceCoverage: 'provider_response',
        });
        return readinessObservation('project_mismatch', targetIndex, 'project_guard_failed', false, 'provider_response');
      }
      logMemoryOperation(operation, {
        stage: 'request',
        status: 'completed',
        failureCode: 'none',
        retryable: false,
        attempt: 1,
        resultCount: 1,
        durationMs: Date.now() - startMs,
        evidenceCoverage: 'provider_response',
      });
      return readinessObservation('ready', targetIndex, 'none', false, 'provider_response');
    }

    logMemoryOperation(operation, {
      stage: 'request',
      status: 'completed',
      failureCode: 'none',
      retryable: false,
      attempt: 1,
      resultCount: 0,
      durationMs: Date.now() - startMs,
      evidenceCoverage: 'provider_response',
    });
    return readinessObservation('index_missing', targetIndex, 'none', false, 'provider_response');
  } catch (err) {
    const state = classifyReadinessError(err);
    const failure = classifyMemoryOperationFailure(err);
    logMemoryOperation(operation, {
      stage: 'request',
      status: 'failed',
      failureCode: failure.code,
      retryable: failure.retryable,
      attempt: 1,
      resultCount: 0,
      durationMs: Date.now() - startMs,
      evidenceCoverage: 'provider_error',
    });
    return readinessObservation(state, targetIndex, failure.code, failure.retryable, 'provider_error');
  }
}

export async function getPineconeReadiness(
  indexName: string = config.pineconeIndex,
): Promise<{ state: PineconeReadinessState; index: string }> {
  const { state, index } = await getPineconeReadinessObservation(indexName);
  return { state, index };
}

function configuredPineconeApiKeyEnv(): string {
  const memory = (config as { memory?: { pinecone?: { apiKeyEnv?: string } } }).memory;
  const apiKeyEnv = memory?.pinecone?.apiKeyEnv;
  return isNonEmptyString(apiKeyEnv) ? apiKeyEnv : 'PINECONE_API_KEY';
}

// Optional keyring service name for the Pinecone API key. When set (e.g.
// 'pinecone'), resolveApiKey() consults the keyring first, falling back to the
// configured env var. Undefined (the default) preserves env-only behavior.
function configuredPineconeApiKeyService(): string | undefined {
  const memory = (config as { memory?: { pinecone?: { apiKeyService?: string } } }).memory;
  const apiKeyService = memory?.pinecone?.apiKeyService;
  return isNonEmptyString(apiKeyService) ? apiKeyService : undefined;
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
  if (!isNonEmptyString(botName)) return false;
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
  failureCode?: MemoryOperationFailureCode;
  retryable?: boolean;
}

export interface PineconeEntitySearchDetails {
  results: EntitySearchResult[];
  status: PineconeSearchStatus;
  durationMs?: number;
  retried?: boolean;
  failureCode?: MemoryOperationFailureCode;
  retryable?: boolean;
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
    this.client = new Pinecone({
      apiKey: resolvePineconeApiKey(),
      fetchApi: (input, init) => {
        const signal = combinedSignal(
          init?.signal,
          pineconeOperationSignal.getStore(),
        );
        return globalThis.fetch(input, {
          ...init,
          ...(signal ? { signal } : {}),
        });
      },
    });
    this.index = this.client.index(config.pineconeIndex);
  }

  private async getProjectGuardError(): Promise<string | null> {
    if (!this.projectGuardCheck) {
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const guardWork = pineconeOperationSignal.run(
        controller.signal,
        () => configuredProjectGuardError(this.client, config.pineconeIndex),
      );
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          const error = new DOMException(
          'Pinecone project guard deadline exceeded',
          'TimeoutError',
          );
          controller.abort(error);
          reject(error);
        }, PROJECT_GUARD_TIMEOUT_MS);
        timeout.unref?.();
      });
      this.projectGuardCheck = Promise.race([guardWork, deadline]).finally(() => {
        if (timeout) clearTimeout(timeout);
      });
    }
    const check = this.projectGuardCheck;
    try {
      return await check;
    } catch (error) {
      if (this.projectGuardCheck === check) this.projectGuardCheck = null;
      throw error;
    }
  }

  private async _searchCoreDetailed(
    query: string,
    filters: Record<string, unknown>,
    topK: number,
    traceId?: string,
    signal?: AbortSignal,
  ): Promise<PineconeSearchDetails> {
    signal?.throwIfAborted();
    const filter = classifyMemoryFilter(filters);
    const operation = createMemoryOperationContext({
      operation: 'search',
      traceId,
      scopeKind: filter.scopeKind,
      filterShape: filter.filterShape,
    });
    if (isBreakerOpen('search')) {
      logMemoryOperation(operation, {
        stage: 'guard',
        status: 'skipped',
        failureCode: 'breaker_open',
        retryable: true,
        attempt: 0,
        resultCount: 0,
        evidenceCoverage: 'local_guard',
      });
      return {
        results: [],
        status: 'breaker_open',
        failureCode: 'breaker_open',
        retryable: true,
      };
    }
    const projectGuardError = await this.getProjectGuardError();
    if (projectGuardError) {
      logMemoryOperation(operation, {
        stage: 'guard',
        status: 'failed',
        failureCode: 'project_guard_failed',
        retryable: false,
        attempt: 0,
        resultCount: 0,
        evidenceCoverage: 'local_guard',
      });
      return {
        results: [],
        status: 'project_guard_failed',
        failureCode: 'project_guard_failed',
        retryable: false,
      };
    }

    const doSearch = () => {
      signal?.throwIfAborted();
      return this.index.searchRecords({
        query: {
          topK,
          inputs: { text: query },
          filter: filters,
        },
        fields: ['*'],
      });
    };

    const startMs = Date.now();
    try {
      const response = await doSearch();
      const results = (response.result.hits ?? []).map(fromPineconeHit);
      const durationMs = Date.now() - startMs;
      logMemoryOperation(operation, {
        stage: 'request',
        status: 'completed',
        failureCode: 'none',
        retryable: false,
        attempt: 1,
        resultCount: results.length,
        durationMs,
        scores: results.map((result) => result.score),
        evidenceCoverage: 'provider_response',
      });
      trackSuccess('search');
      return { results, status: 'ok', durationMs };
    } catch (err) {
      // One retry after a short delay to catch transient blips
      await sleepWithAbort(RETRY_DELAY_MS, signal);
      try {
        const response = await doSearch();
        const results = (response.result.hits ?? []).map(fromPineconeHit);
        const durationMs = Date.now() - startMs;
        logMemoryOperation(operation, {
          stage: 'request',
          status: 'completed',
          failureCode: 'none',
          retryable: false,
          attempt: 2,
          resultCount: results.length,
          durationMs,
          scores: results.map((result) => result.score),
          evidenceCoverage: 'provider_response',
        });
        trackSuccess('search');
        return { results, status: 'ok', durationMs, retried: true };
      } catch (retryErr) {
        const durationMs = Date.now() - startMs;
        const failure = classifyMemoryOperationFailure(retryErr);
        trackFailure('search', operation.operationId, failure, 2);
        logMemoryOperation(operation, {
          stage: 'request',
          status: 'failed',
          failureCode: failure.code,
          retryable: failure.retryable,
          attempt: 2,
          resultCount: 0,
          durationMs,
          evidenceCoverage: 'provider_error',
        });
        return {
          results: [],
          status: 'failed',
          durationMs,
          retried: true,
          failureCode: failure.code,
          retryable: failure.retryable,
        };
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
    traceId?: string,
    signal?: AbortSignal,
  ): Promise<PineconeSearchDetails> {
    return pineconeOperationSignal.run(signal, async () => {
      const details = await this._searchCoreDetailed(
        query,
        filters,
        topK,
        traceId,
        signal,
      );
      return {
        ...details,
        results: applyDecay(details.results, config.recencyHalfLifeDays, config.maxAgeDays),
      };
    });
  }

  async search(
    query: string,
    filters: Record<string, unknown>,
    topK: number,
    traceId?: string,
  ): Promise<SearchResult[]> {
    return (await this.searchDetailed(query, filters, topK, traceId)).results;
  }

  private searchByFieldDetailed(
    query: string,
    field: string,
    value: string,
    topK: number,
    traceId?: string,
  ): Promise<PineconeSearchDetails> {
    return this.searchDetailed(query, { [field]: { $eq: value } }, topK, traceId);
  }

  async searchForChatDetailed(
    chatJid: string,
    query: string,
    traceId?: string,
  ): Promise<PineconeSearchDetails> {
    return this.searchByFieldDetailed(query, 'chat_jid', chatJid, config.pineconeContextTopK, traceId);
  }

  async searchForChat(chatJid: string, query: string, traceId?: string): Promise<SearchResult[]> {
    return (await this.searchForChatDetailed(chatJid, query, traceId)).results;
  }

  async searchForSenderDetailed(
    senderJid: string,
    query: string,
    traceId?: string,
  ): Promise<PineconeSearchDetails> {
    return this.searchByFieldDetailed(query, 'sender_jid', senderJid, config.pineconeSenderTopK, traceId);
  }

  async searchForSender(senderJid: string, query: string, traceId?: string): Promise<SearchResult[]> {
    return (await this.searchForSenderDetailed(senderJid, query, traceId)).results;
  }

  async searchSelfFactsDetailed(query: string, traceId?: string): Promise<PineconeSearchDetails> {
    return this.searchByFieldDetailed(query, 'memory_type', 'self_fact', config.pineconeSelfFactTopK, traceId);
  }

  async searchSelfFacts(query: string, traceId?: string): Promise<SearchResult[]> {
    return (await this.searchSelfFactsDetailed(query, traceId)).results;
  }

  async searchEntities(query: string, traceId?: string): Promise<EntitySearchResult[]> {
    return (await this.searchEntitiesDetailed(query, traceId)).results;
  }

  async searchEntitiesDetailed(query: string, traceId?: string): Promise<PineconeEntitySearchDetails> {
    const operation = createMemoryOperationContext({
      operation: 'entity_search',
      traceId,
      scopeKind: 'entity',
      filterShape: 'source_ne',
    });
    if (isBreakerOpen('entity_search')) {
      logMemoryOperation(operation, {
        stage: 'guard',
        status: 'skipped',
        failureCode: 'breaker_open',
        retryable: true,
        attempt: 0,
        resultCount: 0,
        evidenceCoverage: 'local_guard',
      });
      return {
        results: [],
        status: 'breaker_open',
        failureCode: 'breaker_open',
        retryable: true,
      };
    }
    const projectGuardError = await this.getProjectGuardError();
    if (projectGuardError) {
      logMemoryOperation(operation, {
        stage: 'guard',
        status: 'failed',
        failureCode: 'project_guard_failed',
        retryable: false,
        attempt: 0,
        resultCount: 0,
        evidenceCoverage: 'local_guard',
      });
      return {
        results: [],
        status: 'project_guard_failed',
        failureCode: 'project_guard_failed',
        retryable: false,
      };
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
    let usedFallbackScores = false;
    try {
      // Step 1: vector search (no server-side rerank — docs may exceed 512-token reranker limit)
      let response: Awaited<ReturnType<typeof doSearch>>;
      try {
        response = await doSearch();
      } catch {
        // One retry after short delay
        retried = true;
        await sleep(RETRY_DELAY_MS);
        response = await doSearch();
      }

      const hits = response.result.hits ?? [];
      let mapped = hits.map(fromPineconeHitEntity);

      // Step 2: client-side rerank with truncated text to stay within token limits
      if (config.pineconeRerank && mapped.length > 0) {
        const rerankStartMs = Date.now();
        const rerankOperation = createMemoryOperationContext({
          operation: 'rerank',
          traceId,
          scopeKind: 'entity',
          filterShape: 'source_ne',
        });
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
          logMemoryOperation(rerankOperation, {
            stage: 'rerank',
            status: 'completed',
            failureCode: 'none',
            retryable: false,
            attempt: 1,
            resultCount: mapped.length,
            durationMs: Date.now() - rerankStartMs,
            scores: mapped.map((result) => result.score),
            evidenceCoverage: 'provider_response',
          });
          trackSuccess('rerank');
        } catch (rerankErr) {
          usedFallbackScores = true;
          const failure = classifyMemoryOperationFailure(rerankErr);
          trackFailure('rerank', rerankOperation.operationId, failure, 1);
          logMemoryOperation(rerankOperation, {
            stage: 'rerank',
            status: 'partial',
            failureCode: failure.code,
            retryable: failure.retryable,
            attempt: 1,
            resultCount: mapped.length,
            durationMs: Date.now() - rerankStartMs,
            scores: mapped.map((result) => result.score),
            evidenceCoverage: 'fallback_scores',
          });
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
      logMemoryOperation(operation, {
        stage: 'request',
        status: 'completed',
        failureCode: 'none',
        retryable: false,
        attempt: retried ? 2 : 1,
        resultCount: capped.length,
        durationMs,
        scores: capped.map((result) => result.score),
        evidenceCoverage: usedFallbackScores
          ? 'fallback_scores'
          : 'provider_response',
      });
      trackSuccess('entity_search');
      return { results: capped, status: 'ok', durationMs, ...(retried ? { retried } : {}) };
    } catch (err) {
      const durationMs = Date.now() - startMs;
      const failure = classifyMemoryOperationFailure(err);
      const attempt = retried ? 2 : 1;
      trackFailure('entity_search', operation.operationId, failure, attempt);
      logMemoryOperation(operation, {
        stage: 'request',
        status: 'failed',
        failureCode: failure.code,
        retryable: failure.retryable,
        attempt,
        resultCount: 0,
        durationMs,
        evidenceCoverage: 'provider_error',
      });
      return {
        results: [],
        status: 'failed',
        durationMs,
        retried,
        failureCode: failure.code,
        retryable: failure.retryable,
      };
    }
  }

  async upsert(
    records: MemoryRecord[],
    contextInput: {
      operationId?: string;
      traceId?: string;
      operation?: 'upsert' | 'memory_write';
      signal?: AbortSignal;
    } = {},
  ): Promise<void> {
    return pineconeOperationSignal.run(
      contextInput.signal,
      () => this.upsertWithSignal(records, contextInput),
    );
  }

  private async upsertWithSignal(
    records: MemoryRecord[],
    contextInput: {
      operationId?: string;
      traceId?: string;
      operation?: 'upsert' | 'memory_write';
      signal?: AbortSignal;
    } = {},
  ): Promise<void> {
    contextInput.signal?.throwIfAborted();
    const operation = createMemoryOperationContext({
      operation: contextInput.operation ?? 'upsert',
      operationId: contextInput.operationId,
      traceId: contextInput.traceId,
      scopeKind: 'batch',
      filterShape: 'none',
    });
    if (records.length === 0) {
      logMemoryOperation(operation, {
        stage: 'finalize',
        status: 'skipped',
        failureCode: 'none',
        retryable: false,
        attempt: 0,
        resultCount: 0,
        evidenceCoverage: 'not_observed',
      });
      return;
    }

    if (isBreakerOpen('upsert')) {
      logMemoryOperation(operation, {
        stage: 'guard',
        status: 'skipped',
        failureCode: 'breaker_open',
        retryable: true,
        attempt: 0,
        resultCount: 0,
        evidenceCoverage: 'local_guard',
      });
      throw new AppError('Pinecone circuit breaker open', 'PINECONE_UNAVAILABLE');
    }
    const projectGuardError = await this.getProjectGuardError();
    if (projectGuardError) {
      logMemoryOperation(operation, {
        stage: 'guard',
        status: 'failed',
        failureCode: 'project_guard_failed',
        retryable: false,
        attempt: 0,
        resultCount: 0,
        evidenceCoverage: 'local_guard',
      });
      throw new AppError(
        'Pinecone project guard failed',
        'PINECONE_UNAVAILABLE',
        projectGuardError,
      );
    }

    const pineconeRecords = records.map(toPineconeRecord);
    const startMs = Date.now();
    const doUpsert = () => {
      contextInput.signal?.throwIfAborted();
      return this.index.upsertRecords({ records: pineconeRecords });
    };

    try {
      await doUpsert();
      const durationMs = Date.now() - startMs;
      logMemoryOperation(operation, {
        stage: 'write',
        status: 'completed',
        failureCode: 'none',
        retryable: false,
        attempt: 1,
        resultCount: records.length,
        durationMs,
        evidenceCoverage: 'provider_response',
      });
      trackSuccess('upsert');
    } catch (err) {
      // One retry after short delay
      await sleepWithAbort(RETRY_DELAY_MS, contextInput.signal);
      try {
        await doUpsert();
        const durationMs = Date.now() - startMs;
        logMemoryOperation(operation, {
          stage: 'write',
          status: 'completed',
          failureCode: 'none',
          retryable: false,
          attempt: 2,
          resultCount: records.length,
          durationMs,
          evidenceCoverage: 'provider_response',
        });
        trackSuccess('upsert');
      } catch (retryErr) {
        const failure = classifyMemoryOperationFailure(retryErr);
        trackFailure('upsert', operation.operationId, failure, 2);
        logMemoryOperation(operation, {
          stage: 'write',
          status: 'failed',
          failureCode: failure.code,
          retryable: failure.retryable,
          attempt: 2,
          resultCount: 0,
          durationMs: Date.now() - startMs,
          evidenceCoverage: 'provider_error',
        });
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
