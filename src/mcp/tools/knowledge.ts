// src/mcp/tools/knowledge.ts
// Scoped Pinecone knowledge base search for agent instances.
// Exposes search over a configurable allowlist of Pinecone indexes.

import { z } from 'zod';
import { Pinecone } from '@pinecone-database/pinecone';
import { createChildLogger } from '../../logger.ts';
import { truncateForRerank } from '../../lib/text-utils.ts';
import type { ToolDeclaration } from '../types.ts';

const log = createChildLogger('knowledge-tools');

/** Index profiles: how to search each known index. */
const INDEX_PROFILES: Record<string, {
  /** Default namespace. Empty string = default namespace. */
  namespace: string;
  /** Named namespaces to fan-out search across (empty = use namespace field only). */
  namespaces: string[];
  searchMode: 'entity' | 'text';
  rerank: boolean;
  rerankModel: string;
  topK: number;
  rerankTopN: number;
  description: string;
}> = {
  'oneplatform-search': {
    namespace: '__default__',
    namespaces: [],
    searchMode: 'entity',
    rerank: true,
    rerankModel: 'pinecone-rerank-v0',
    topK: 20,
    rerankTopN: 6,
    description: 'BES business data — accounts, contacts, buildings, work orders, invoices',
  },
  'oneplatform-entities': {
    namespace: '',
    namespaces: ['accounts', 'contacts', 'buildings', 'people', 'externals'],
    searchMode: 'entity',
    rerank: true,
    rerankModel: 'pinecone-rerank-v0',
    topK: 20,
    rerankTopN: 6,
    description: 'Structured entities — accounts, contacts, buildings, people, external system records',
  },
};

/** Max chars per result text to keep tool output within token budget. */
const MAX_TEXT_PER_RESULT = 600;

/** Max total results to return (after rerank/dedup). */
const MAX_RESULTS = 8;

/** Truncate result text for output. */
function truncateResult(text: string): string {
  if (text.length <= MAX_TEXT_PER_RESULT) return text;
  return text.slice(0, MAX_TEXT_PER_RESULT) + '…';
}

interface ParsedHit {
  id: string;
  score: number;
  text: string;
  entityType: string;
  fields: Record<string, unknown>;
}

function parseHits(
  rawHits: Array<{ _id: string; _score: number; fields?: object | null }>,
): ParsedHit[] {
  return rawHits.map((hit) => {
    const fields = (hit.fields ?? {}) as Record<string, unknown>;
    return {
      id: hit._id,
      score: hit._score,
      text: (fields['text'] as string) ?? '',
      entityType: (fields['entity_type'] as string) ?? 'unknown',
      fields,
    };
  });
}

/**
 * Format entity results grouped by type. Output is plain text suitable for
 * WhatsApp relay — no markdown tables or complex formatting.
 */
function formatEntityResults(hits: ParsedHit[]): string {
  if (hits.length === 0) return 'No results found.';

  // Group by entity_type
  const groups = new Map<string, ParsedHit[]>();
  for (const hit of hits) {
    const group = groups.get(hit.entityType) ?? [];
    group.push(hit);
    groups.set(hit.entityType, group);
  }

  const parts: string[] = [];
  for (const [entityType, items] of groups) {
    const label = entityType.charAt(0).toUpperCase() + entityType.slice(1) +
      (entityType.endsWith('s') ? '' : 's');
    const lines = items.map((r) => `• ${truncateResult(r.text)}`).join('\n');
    parts.push(`${label}:\n${lines}`);
  }

  return parts.join('\n\n');
}

/**
 * Format text/document results. Each result shows source and a preview.
 */
function formatTextResults(hits: ParsedHit[]): string {
  if (hits.length === 0) return 'No results found.';

  return hits.map((hit) => {
    const filepath = (hit.fields['filepath'] as string) ?? '';
    const summary = (hit.fields['summary'] as string) ?? '';
    const source = filepath || hit.id;
    const display = truncateResult(summary || hit.text);
    return `[${source}]\n${display}`;
  }).join('\n\n');
}

export function registerKnowledgeTools(
  allowedIndexes: string[],
  register: (tool: ToolDeclaration) => void,
): void {
  if (allowedIndexes.length === 0) return;

  const apiKey = process.env.PINECONE_API_KEY ?? '';
  if (!apiKey) {
    log.warn('PINECONE_API_KEY not set — knowledge tools will not be registered');
    return;
  }

  let pc: Pinecone;
  try {
    pc = new Pinecone({ apiKey });
  } catch (err) {
    log.error({ err }, 'Failed to initialize Pinecone client — knowledge tools will not be registered');
    return;
  }

  // Validate and filter to known indexes
  const validIndexes = allowedIndexes.filter((name) => {
    if (INDEX_PROFILES[name]) return true;
    log.warn({ index: name }, 'Unknown index in pineconeAllowedIndexes — skipping');
    return false;
  });

  if (validIndexes.length === 0) return;

  // Build enum description
  const indexDescriptions = validIndexes
    .map((name) => `"${name}": ${INDEX_PROFILES[name].description}`)
    .join('; ');

  const KnowledgeSearchSchema = z.object({
    index: z.enum(validIndexes as [string, ...string[]]),
    query: z.string().min(2).max(500),
    top_k: z.number().min(1).max(20).optional(),
    namespace: z.string().optional(),
  });

  register({
    name: 'knowledge_search',
    description:
      `Search company knowledge bases. ` +
      `Available: ${indexDescriptions}. ` +
      `Use natural language queries (3-6 words). ` +
      `Results are pre-formatted — summarize the key facts for the user, don't dump raw output.`,
    schema: KnowledgeSearchSchema,
    scope: 'chat',
    targetMode: 'caller-supplied',
    replayPolicy: 'read_only',
    handler: async (params) => {
      const parsed = KnowledgeSearchSchema.safeParse(params);
      if (!parsed.success) {
        return { error: `Invalid parameters: ${parsed.error.issues.map(i => i.message).join(', ')}` };
      }

      const { index: indexName, query, top_k, namespace: nsOverride } = parsed.data;
      const profile = INDEX_PROFILES[indexName];
      const startMs = Date.now();

      // Determine which namespaces to search
      const namespacesToSearch: string[] = nsOverride
        ? [nsOverride]
        : profile.namespaces.length > 0
          ? profile.namespaces
          : [profile.namespace];

      try {
        const index = pc.index(indexName);

        // Phase 1: vector search (fan out across namespaces if needed)
        const searchPromises = namespacesToSearch.map((ns) =>
          index.searchRecords({
            namespace: ns,
            query: {
              topK: top_k ?? profile.topK,
              inputs: { text: query },
            },
            fields: ['*'],
          }).catch((err) => {
            log.warn({ err, namespace: ns }, 'namespace search failed — skipping');
            return null;
          }),
        );

        const responses = await Promise.all(searchPromises);
        let hits: ParsedHit[] = [];
        for (const response of responses) {
          if (response?.result?.hits) {
            hits.push(...parseHits(response.result.hits));
          }
        }

        // Sort merged results by score descending
        hits.sort((a, b) => b.score - a.score);

        // Phase 2: client-side rerank if configured
        if (profile.rerank && hits.length > 0) {
          try {
            const rerankResult = await pc.inference.rerank({
              model: profile.rerankModel,
              query,
              documents: hits.map((h) => ({
                id: h.id,
                text: truncateForRerank(h.text),
              })),
              topN: Math.min(profile.rerankTopN, MAX_RESULTS),
              rankFields: ['text'],
              returnDocuments: false,
            });

            const reranked: ParsedHit[] = [];
            for (const doc of rerankResult.data) {
              const original = hits[doc.index];
              if (original) {
                reranked.push({ ...original, score: doc.score });
              }
            }
            hits = reranked;
          } catch (rerankErr) {
            log.warn({ err: rerankErr }, 'Rerank failed — using vector scores');
            // Fall through with unreranked results, capped
            hits = hits.slice(0, MAX_RESULTS);
          }
        } else {
          hits = hits.slice(0, MAX_RESULTS);
        }

        // Dedup by ID
        const seen = new Set<string>();
        const deduped = hits.filter((h) => {
          if (seen.has(h.id)) return false;
          seen.add(h.id);
          return true;
        });

        const durationMs = Date.now() - startMs;
        log.info(
          { index: indexName, namespaces: namespacesToSearch, query: query.slice(0, 80), hits: deduped.length, durationMs },
          'knowledge search complete',
        );

        if (deduped.length === 0) {
          return {
            index: indexName,
            query,
            results_count: 0,
            formatted: 'No results found for this query. Try different wording or a broader search.',
          };
        }

        const formatted = profile.searchMode === 'entity'
          ? formatEntityResults(deduped)
          : formatTextResults(deduped);

        return {
          index: indexName,
          query,
          results_count: deduped.length,
          formatted,
        };
      } catch (err) {
        const durationMs = Date.now() - startMs;
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err, index: indexName, query: query.slice(0, 80), durationMs }, 'knowledge search failed');

        // User-friendly error for common failures
        if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i.test(message)) {
          return { error: 'Knowledge base is temporarily unavailable. Try again in a moment.' };
        }
        if (/401|403|unauthorized|forbidden/i.test(message)) {
          return { error: 'Knowledge base authentication error. Contact admin.' };
        }
        return { error: `Search failed: ${message}` };
      }
    },
  });

  log.info({ indexes: validIndexes }, 'knowledge tools registered');
}
