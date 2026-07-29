import { stripJsonFences } from '../lib/json-fences.ts';
import { createChildLogger } from '../logger.ts';
import { config } from '../config.ts';
import { resolveModelRole } from '../lib/model-advisor.ts';
import {
  classifyMemoryOperationFailure,
  type MemoryEvidenceCoverage,
  type MemoryOperationFailureCode,
} from '../lib/memory-operation-telemetry.ts';
import type { LLMProvider } from '../runtimes/chat/providers/types.ts';
import type {
  ClusterConsolidationOutcome,
  ClusterConsolidationStatus,
  ConsolidationResult,
  MemoryCluster,
} from './types.ts';
import { z } from 'zod';

/**
 * Production memory-consolidation cluster selection and typed model outcomes.
 *
 * The scheduler owns deadlines, durable run receipts, cancellation, and the
 * post-stop write fence. This module owns strict bounded validation and
 * content-free failure classification for each attempted cluster.
 */

const log = createChildLogger('consolidation');
const MAX_PROMOTED_ITEMS = 32;
const MAX_DISCARDED_ITEMS = 128;
const MAX_CLAIM_BYTES = 1_024;
const MAX_REASON_BYTES = 2_048;
const MAX_SOURCE_ID_BYTES = 512;

const boundedString = (maxBytes: number) =>
  z.string()
    .trim()
    .min(1)
    .refine((value) => Buffer.byteLength(value, 'utf8') <= maxBytes);

const consolidationOutputSchema = z.object({
  durableKnowledge: z.array(z.object({
    claim: boundedString(MAX_CLAIM_BYTES),
    promotionReason: boundedString(MAX_REASON_BYTES),
    confidence: z.number().finite().min(0).max(1),
    sourceRecordIds: z.array(boundedString(MAX_SOURCE_ID_BYTES)).min(1).max(128),
  }).strict()).max(MAX_PROMOTED_ITEMS),
  discarded: z.array(z.object({
    recordId: boundedString(MAX_SOURCE_ID_BYTES),
    reason: boundedString(MAX_REASON_BYTES),
  }).strict()).max(MAX_DISCARDED_ITEMS),
}).strict();

const EMPTY_RESULT: ConsolidationResult = {
  durableKnowledge: [],
  discarded: [],
};

function outcome(
  status: ClusterConsolidationStatus,
  input: {
    result?: ConsolidationResult;
    failureCode: MemoryOperationFailureCode;
    retryable: boolean;
    evidenceCoverage: MemoryEvidenceCoverage;
  },
): ClusterConsolidationOutcome {
  return {
    status,
    failureCode: input.failureCode,
    retryable: input.retryable,
    evidenceCoverage: input.evidenceCoverage,
    ...(input.result ?? EMPTY_RESULT),
  };
}

function outputMatchesCluster(
  result: ConsolidationResult,
  clusterRecordIds: ReadonlySet<string>,
): boolean {
  for (const durable of result.durableKnowledge) {
    const uniqueIds = new Set(durable.sourceRecordIds);
    if (uniqueIds.size !== durable.sourceRecordIds.length) return false;
    if (durable.sourceRecordIds.some((id) => !clusterRecordIds.has(id))) return false;
  }

  const discardedIds = result.discarded.map((item) => item.recordId);
  if (new Set(discardedIds).size !== discardedIds.length) return false;
  return discardedIds.every((id) => clusterRecordIds.has(id));
}

const CONSOLIDATION_PROMPT = `You are a memory consolidation engine. Given a cluster of related memories from an AI agent's episodic history, identify which patterns represent durable knowledge worth keeping long-term.

Output:
{
  "durableKnowledge": [
    {
      "claim": "the consolidated lasting truth",
      "promotionReason": "why this is worth keeping — how many times observed, over what time span, consistency",
      "confidence": 0.0-1.0,
      "sourceRecordIds": ["ids", "of", "supporting", "records"]
    }
  ],
  "discarded": [
    {
      "recordId": "id of record not promoted",
      "reason": "why this is transient — single mention, time-bound, etc."
    }
  ]
}

Promotion criteria:
- Mentioned multiple times across different sessions = strong signal
- Consistent over weeks = lasting truth
- Single mentions of time-bound facts (e.g. "meeting at 3pm") = discard
- Preferences and identity facts = promote even on single mention if high confidence

Output ONLY valid JSON. No markdown.`;

/**
 * Cluster records by keyword overlap (Jaccard-ish similarity >= 0.3).
 * Greedy single-pass: each record joins the first matching cluster.
 */
export function clusterMemories(
  records: Array<{
    id: string;
    text: string;
    claim?: string;
    evidence: string;
    createdAt: string;
    confidence: number;
    chatJid?: string;
    senderJid?: string;
  }>,
): MemoryCluster[] {
  if (records.length === 0) return [];

  const tokenize = (s: string) =>
    (s || '').toLowerCase().split(/\W+/).filter((t) => t.length > 2);

  const assigned = new Set<number>();
  const clusters: MemoryCluster[] = [];

  for (let i = 0; i < records.length; i++) {
    if (assigned.has(i)) continue;

    const cluster: MemoryCluster = {
      topic: records[i].claim || records[i].text.slice(0, 50),
      records: [records[i]],
    };
    assigned.add(i);

    const tokensI = new Set(tokenize(records[i].claim || records[i].text));

    for (let j = i + 1; j < records.length; j++) {
      if (assigned.has(j)) continue;
      const tokensJ = tokenize(records[j].claim || records[j].text);
      const tokensJSet = new Set(tokensJ);
      const overlap = [...tokensJSet].filter((t) => tokensI.has(t)).length;
      const jaccardish = overlap / Math.max(tokensI.size + tokensJSet.size - overlap, 1);

      if (jaccardish >= 0.3) {
        cluster.records.push(records[j]);
        assigned.add(j);
      }
    }

    clusters.push(cluster);
  }

  return clusters;
}

export async function consolidateCluster(
  provider: LLMProvider,
  cluster: MemoryCluster,
  options: { signal?: AbortSignal } = {},
): Promise<ClusterConsolidationOutcome> {
  const clusterRecordIds = cluster.records.map((record) => record.id);
  if (
    clusterRecordIds.length === 0
    || clusterRecordIds.some((id) => id.length === 0 || Buffer.byteLength(id, 'utf8') > MAX_SOURCE_ID_BYTES)
    || new Set(clusterRecordIds).size !== clusterRecordIds.length
  ) {
    return outcome('scope_invalid', {
      failureCode: 'invalid_request',
      retryable: false,
      evidenceCoverage: 'local_guard',
    });
  }
  if (options.signal?.aborted) {
    return outcome('cancelled', {
      failureCode: 'timeout',
      retryable: true,
      evidenceCoverage: 'local_guard',
    });
  }

  const clusterJson = JSON.stringify({
    topic: cluster.topic,
    records: cluster.records.map((r) => ({
      id: r.id,
      claim: r.claim || r.text,
      text: r.text,
      confidence: r.confidence,
      created: r.createdAt,
    })),
  });

  let raw: string;
  try {
    const response = await provider.generate({
      // Resolve symbolic model values (vendor:family:latest[-stable]) at point
      // of use; literal IDs pass through untouched. Never throws.
      model: await resolveModelRole(config.models.validation),
      maxTokens: 1000,
      systemPrompt: CONSOLIDATION_PROMPT,
      messages: [{ role: 'user', content: clusterJson }],
      signal: options.signal,
    });
    raw = response.content.trim();
  } catch (error) {
    if (options.signal?.aborted) {
      return outcome('cancelled', {
        failureCode: 'timeout',
        retryable: true,
        evidenceCoverage: 'local_guard',
      });
    }
    const failure = classifyMemoryOperationFailure(error);
    const status = failure.code === 'timeout'
      ? 'provider_timeout'
      : 'provider_unavailable';
    log.warn({
      status,
      failureCode: failure.code,
      retryable: failure.retryable,
      recordCount: cluster.records.length,
      evidenceCoverage: 'provider_error',
    }, 'consolidation provider call failed');
    return outcome(status, {
      failureCode: failure.code,
      retryable: failure.retryable,
      evidenceCoverage: 'provider_error',
    });
  }

  const jsonStr = stripJsonFences(raw);

  try {
    const parsed = consolidationOutputSchema.safeParse(JSON.parse(jsonStr));
    if (!parsed.success || !outputMatchesCluster(parsed.data, new Set(clusterRecordIds))) {
      log.warn({
        status: 'output_invalid',
        failureCode: 'invalid_request',
        retryable: false,
        outputBytes: Buffer.byteLength(raw, 'utf8'),
        recordCount: cluster.records.length,
        evidenceCoverage: 'provider_response',
      }, 'consolidation output validation failed');
      return outcome('output_invalid', {
        failureCode: 'invalid_request',
        retryable: false,
        evidenceCoverage: 'provider_response',
      });
    }
    const result: ConsolidationResult = parsed.data;
    return outcome(
      result.durableKnowledge.length > 0
        ? 'completed_promoted'
        : 'completed_discarded',
      {
        result,
        failureCode: 'none',
        retryable: false,
        evidenceCoverage: 'provider_response',
      },
    );
  } catch {
    log.warn({
      status: 'output_invalid',
      failureCode: 'invalid_request',
      retryable: false,
      outputBytes: Buffer.byteLength(raw, 'utf8'),
      recordCount: cluster.records.length,
      evidenceCoverage: 'provider_response',
    }, 'consolidation output validation failed');
    return outcome('output_invalid', {
      failureCode: 'invalid_request',
      retryable: false,
      evidenceCoverage: 'provider_response',
    });
  }
}
