import { shortHash } from '../lib/short-hash.ts';
import { stripJsonFences } from '../lib/json-fences.ts';
import { createChildLogger } from '../logger.ts';
import { config } from '../config.ts';
import { resolveModelRole } from '../lib/model-advisor.ts';
import type { LLMProvider } from '../runtimes/chat/providers/types.ts';
import type { MemoryCluster, ConsolidationResult } from './types.ts';

/**
 * Dormant memory-consolidation infrastructure.
 *
 * As of 2026-04-25 this module is exercised by tests only; no production
 * scheduler calls `clusterMemories` or `consolidateCluster` yet. Keep the
 * implementation staged here until the memory scheduler workstream wires
 * bounded cluster selection, validated LLM output, and provider deadlines.
 */

const log = createChildLogger('consolidation');

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
): Promise<ConsolidationResult> {
  const empty: ConsolidationResult = { durableKnowledge: [], discarded: [] };
  if (cluster.records.length === 0) return empty;

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
    });
    raw = response.content.trim();
  } catch (err) {
    log.warn({ err, recordCount: cluster.records.length }, 'consolidation LLM call failed');
    return empty;
  }

  const jsonStr = stripJsonFences(raw);

  try {
    const parsed = JSON.parse(jsonStr) as ConsolidationResult;
    return {
      durableKnowledge: Array.isArray(parsed.durableKnowledge) ? parsed.durableKnowledge : [],
      discarded: Array.isArray(parsed.discarded) ? parsed.discarded : [],
    };
  } catch {
    log.warn({ rawHash: shortHash(raw), rawLength: raw.length }, 'consolidation JSON parse failed');
    return empty;
  }
}
