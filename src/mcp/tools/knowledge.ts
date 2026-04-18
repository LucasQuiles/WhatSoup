// src/mcp/tools/knowledge.ts
// Scoped Pinecone knowledge base search for agent instances.
// Exposes search over a configurable allowlist of Pinecone indexes.

import { z } from 'zod';
import { Pinecone } from '@pinecone-database/pinecone';
import { createChildLogger } from '../../logger.ts';
import { truncateForRerank } from '../../lib/text-utils.ts';
import { routeQuery } from '../../runtimes/chat/memory/query-router.ts';
import type { ToolDeclaration } from '../types.ts';

const log = createChildLogger('knowledge-tools');

/** Index profiles: how to search each known index. */
const INDEX_PROFILES: Record<string, {
  /** Default namespace. Empty string = default namespace. */
  namespace: string;
  /** Named namespaces to fan-out search across (empty = use namespace field only). */
  namespaces: string[];
  searchMode: 'entity' | 'text' | 'vector';
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
  'mw-mind': {
    namespace: '',
    // Phase 3: fan-out includes the three new WhatsApp namespaces
    // (whatsapp-facts, whatsapp-chunks, whatsapp-summaries). The historical
    // `whatsapp` namespace remains read-only source material. WhatsApp queries
    // fan out in intent-ordered fashion via query-router.ts.
    namespaces: [
      'local-docs',
      'onedrive',
      'whatsapp',
      'whatsapp-contacts',
      'whatsapp-facts',
      'whatsapp-chunks',
      'whatsapp-summaries',
    ],
    searchMode: 'vector',
    rerank: false,
    rerankModel: '',
    topK: 20,
    rerankTopN: 6,
    description:
      "Michael's memory — local docs, OneDrive files, WhatsApp messages (facts, chunks, summaries), and WhatsApp contacts. " +
      "Standalone index; queries embed client-side via the local mw-mind-embed service. " +
      "WhatsApp queries route by intent: facts-first, raw-first, or hybrid.",
  },
};

/** Local embed service (mw-mind) — emits multilingual-e5-large vectors. */
const MW_MIND_EMBED_URL = 'http://127.0.0.1:8799/embed';

/** Max chars per result text to keep tool output within token budget. */
const MAX_TEXT_PER_RESULT = 600;

/** Max total results to return (after rerank/dedup). */
const MAX_RESULTS = 8;

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
    const lines = items.map((r) => `• ${truncateForRerank(r.text, MAX_TEXT_PER_RESULT)}`).join('\n');
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
    const display = truncateForRerank(summary || hit.text, MAX_TEXT_PER_RESULT);
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

      // Determine which namespaces to search.
      //
      // For the standalone mw-mind index, WhatsApp queries route by intent:
      //   - facts-first: whatsapp-facts, then whatsapp-summaries, whatsapp-chunks
      //   - raw-first:   whatsapp-summaries, whatsapp-chunks, then whatsapp-facts
      //   - hybrid:      whatsapp-summaries, whatsapp-facts, whatsapp-chunks
      // Other scopes (local-docs, onedrive, whatsapp, whatsapp-contacts) are
      // appended after the routed WhatsApp order so they still participate in
      // the fan-out. An explicit `namespace` argument overrides routing.
      let namespacesToSearch: string[];
      let queryIntent: string | undefined;
      if (nsOverride) {
        namespacesToSearch = [nsOverride];
      } else if (indexName === 'mw-mind') {
        const routed = routeQuery(query);
        queryIntent = routed.intent;
        const routedSet = new Set(routed.namespaces);
        const others = profile.namespaces.filter((ns) => !routedSet.has(ns));
        namespacesToSearch = [...routed.namespaces, ...others];
      } else if (profile.namespaces.length > 0) {
        namespacesToSearch = profile.namespaces;
      } else {
        namespacesToSearch = [profile.namespace];
      }

      try {
        const index = pc.index(indexName);
        let hits: ParsedHit[] = [];

        if (profile.searchMode === 'vector') {
          // Standalone index: embed the query client-side and call index.query.
          // mw-mind uses multilingual-e5-large (1024-dim) served at MW_MIND_EMBED_URL.
          let vec: number[];
          try {
            const embedResp = await fetch(MW_MIND_EMBED_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ texts: [query], input_type: 'query' }),
            });
            if (!embedResp.ok) {
              const status = embedResp.status;
              log.error({ index: indexName, status }, 'embed service returned non-OK');
              return { error: `Embed service unavailable (HTTP ${status}). Try again in a moment.` };
            }
            const embedJson = (await embedResp.json()) as { vectors: number[][]; dim?: number };
            if (!Array.isArray(embedJson.vectors) || embedJson.vectors.length === 0) {
              log.error({ index: indexName }, 'embed service returned no vectors');
              return { error: 'Embed service returned no vectors.' };
            }
            vec = embedJson.vectors[0]!;
          } catch (embedErr) {
            log.error({ err: embedErr, index: indexName }, 'embed service call failed');
            return { error: 'Knowledge base is temporarily unavailable (embed service). Try again in a moment.' };
          }

          const topK = top_k ?? profile.topK;
          const queryPromises = namespacesToSearch.map((ns) =>
            index.namespace(ns).query({
              topK,
              vector: vec,
              includeMetadata: true,
            }).catch((err) => {
              log.warn({ err, namespace: ns }, 'namespace vector query failed — skipping');
              return null;
            }),
          );
          const responses = await Promise.all(queryPromises);
          for (const response of responses) {
            if (!response || !Array.isArray(response.matches)) continue;
            for (const match of response.matches) {
              const fields = (match.metadata ?? {}) as Record<string, unknown>;
              hits.push({
                id: String(match.id),
                score: typeof match.score === 'number' ? match.score : 0,
                text: (fields['text'] as string) ?? '',
                entityType: (fields['entity_type'] as string) ?? 'document',
                fields,
              });
            }
          }
        } else {
          // Integrated-index branch: Pinecone-hosted embedding via searchRecords.
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
          for (const response of responses) {
            if (response?.result?.hits) {
              hits.push(...parseHits(response.result.hits));
            }
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
        // T1 PII hygiene: the raw query text may contain personal details
        // (names, phone numbers, addresses) and must NOT land in the INFO
        // stream that ships to aggregated log surfaces. The query prefix is
        // demoted to DEBUG for local diagnosis; routing and count metadata
        // remain at INFO so operators can still observe retrieval health.
        log.debug(
          {
            index: indexName,
            namespaces: namespacesToSearch,
            query: query.slice(0, 80),
            hits: deduped.length,
            durationMs,
            ...(queryIntent ? { queryIntent } : {}),
          },
          'knowledge search: query + duration (debug-only, may contain PII)',
        );
        log.info(
          {
            index: indexName,
            routedNamespaces: namespacesToSearch,
            hits: deduped.length,
            durationMs,
            ...(queryIntent ? { queryIntent } : {}),
          },
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
