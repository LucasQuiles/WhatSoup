// src/mcp/tools/knowledge.ts
// Scoped Pinecone knowledge base search for agent instances.
// Exposes search over a configurable allowlist of Pinecone indexes.

import { z } from 'zod';
import { Pinecone } from '@pinecone-database/pinecone';
import { createChildLogger } from '../../logger.ts';
import { truncateForRerank } from '../../lib/text-utils.ts';
import { routeQuery } from '../../runtimes/chat/memory/query-router.ts';
import { config } from '../../config.ts';
import type { KnowledgeProfileConfig } from '../../config.ts';
import { errorResult, toolError, type ToolDeclaration } from '../types.ts';
import { pineconeProjectGuardError, type PineconeProjectGuard } from '../../lib/pinecone-project-guard.ts';
import { errorMessage } from '../../lib/error-message.ts';
import { resolveApiKey } from '../../lib/api-key-resolver.ts';

const log = createChildLogger('knowledge-tools');

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

function pineconeMemoryConfig(): {
  apiKeyEnv: string;
  apiKeyService?: string;
  projectId?: string;
  expectedHostSuffix?: string;
  namespaces?: { facts?: string; chunks?: string; summaries?: string; [key: string]: string | undefined };
  knowledgeProfiles: Record<string, KnowledgeProfileConfig>;
} {
  const pinecone = (config as {
    memory?: {
      pinecone?: {
        apiKeyEnv?: string;
        apiKeyService?: string;
        projectId?: string;
        expectedHostSuffix?: string;
        namespaces?: { facts?: string; chunks?: string; summaries?: string; [key: string]: string | undefined };
        knowledgeProfiles?: Record<string, KnowledgeProfileConfig>;
      };
    };
  }).memory?.pinecone;
  return {
    apiKeyEnv: pinecone?.apiKeyEnv || 'PINECONE_API_KEY',
    apiKeyService: typeof pinecone?.apiKeyService === 'string' && pinecone.apiKeyService.trim() !== ''
      ? pinecone.apiKeyService
      : undefined,
    projectId: pinecone?.projectId,
    expectedHostSuffix: pinecone?.expectedHostSuffix,
    namespaces: pinecone?.namespaces,
    knowledgeProfiles: pinecone?.knowledgeProfiles ?? {},
  };
}

function namespaceAllowlist(profile: KnowledgeProfileConfig): Set<string> {
  return new Set(
    [profile.namespace, ...profile.namespaces]
      .filter((namespace): namespace is string => typeof namespace === 'string'),
  );
}

function resolveNamespacesToSearch(
  indexName: string,
  query: string,
  profile: KnowledgeProfileConfig,
  nsOverride: string | undefined,
  namespaces: ReturnType<typeof pineconeMemoryConfig>['namespaces'],
): { namespacesToSearch: string[]; queryIntent?: string; error?: string } {
  const allowed = namespaceAllowlist(profile);
  if (nsOverride) {
    if (allowed.size > 0 && !allowed.has(nsOverride)) {
      return { namespacesToSearch: [], error: `Namespace "${nsOverride}" is not allowed for index "${indexName}".` };
    }
    return { namespacesToSearch: [nsOverride] };
  }

  if (indexName === 'mw-mind') {
    const routed = routeQuery(query, { namespaces });
    const routedSet = new Set(routed.namespaces);
    const others = profile.namespaces.filter((ns) => !routedSet.has(ns));
    return { namespacesToSearch: [...routed.namespaces, ...others], queryIntent: routed.intent };
  }

  if (profile.namespaces.length > 0) {
    return { namespacesToSearch: profile.namespaces };
  }

  return { namespacesToSearch: [profile.namespace] };
}

async function validatePineconeProject(
  pc: Pinecone,
  indexName: string,
  guard: PineconeProjectGuard,
): Promise<string | null> {
  return pineconeProjectGuardError(pc, indexName, guard, {
    missingIndex: (targetIndex) => `Index "${targetIndex}" was not found for the configured Pinecone key.`,
    projectMismatch: (targetIndex) => `Index "${targetIndex}" is in the wrong Pinecone project for this instance.`,
  });
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

/**
 * Build a Pinecone search function for the substrate `poll.file`/`poll.pinecone`
 * trigger poller, REUSING the same client, project guard, and index/namespace
 * allowlist as `knowledge_search` (no second Pinecone client). Returns null when
 * Pinecone is unavailable (no API key, client init failure, or no valid
 * allowlisted indexes) — the poller then fails closed with `pinecone_unavailable`.
 *
 * The returned function takes `{ index, namespace, query, topK }` and resolves to
 * `{ matches: [{ score }] }` — ONLY scores cross the boundary, so record bodies
 * never enter the poller (redaction-by-construction).
 */
export function createPineconeWatchSearch(
  allowedIndexes: string[],
): {
  allowedIndexes: string[];
  search: (args: { index: string; namespace: string; query: string; topK: number }) => Promise<{ matches: Array<{ score: number }> }>;
} | null {
  if (allowedIndexes.length === 0) return null;

  const memoryConfig = pineconeMemoryConfig();
  const apiKey = resolveApiKey({ service: memoryConfig.apiKeyService, envVar: memoryConfig.apiKeyEnv });
  if (!apiKey) {
    log.warn('Pinecone API key env var not set — poll.pinecone watches disabled');
    return null;
  }

  let pc: Pinecone;
  try {
    pc = new Pinecone({ apiKey });
  } catch (err) {
    log.error({ err }, 'Failed to initialize Pinecone client — poll.pinecone watches disabled');
    return null;
  }

  const validIndexes = allowedIndexes.filter((name) => {
    if (memoryConfig.knowledgeProfiles[name]) return true;
    log.warn({ index: name }, 'Unknown index in allowedIndexes — poll.pinecone disabled for it');
    return false;
  });
  if (validIndexes.length === 0) return null;

  const search = async (args: { index: string; namespace: string; query: string; topK: number }): Promise<{ matches: Array<{ score: number }> }> => {
    const { index: indexName, namespace, query, topK } = args;
    const profile = memoryConfig.knowledgeProfiles[indexName];
    if (!profile) {
      // Re-guard at call time even though the poller also checks its allowlist.
      throw new Error(`index "${indexName}" is not an allowlisted knowledge profile`);
    }
    const projectError = await validatePineconeProject(pc, indexName, {
      projectId: memoryConfig.projectId,
      expectedHostSuffix: memoryConfig.expectedHostSuffix,
    });
    if (projectError) throw new Error(projectError);

    const index = pc.index(indexName);
    const scores: number[] = [];

    if (profile.searchMode === 'vector') {
      const embedUrl = profile.embedUrl;
      if (!embedUrl) throw new Error(`vector index "${indexName}" missing embedUrl`);
      const embedResp = await fetch(embedUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts: [query], input_type: 'query' }),
      });
      if (!embedResp.ok) throw new Error(`embed service HTTP ${embedResp.status}`);
      const embedJson = (await embedResp.json()) as { vectors: number[][] };
      const vec = embedJson.vectors?.[0];
      if (!Array.isArray(vec)) throw new Error('embed service returned no vectors');
      const resp = await index.namespace(namespace).query({ topK, vector: vec, includeMetadata: false });
      for (const m of resp.matches ?? []) {
        if (typeof m.score === 'number') scores.push(m.score);
      }
    } else {
      const resp = await index.searchRecords({
        namespace,
        query: { topK, inputs: { text: query } },
        fields: [],
      });
      for (const hit of resp.result?.hits ?? []) {
        if (typeof hit._score === 'number') scores.push(hit._score);
      }
    }

    return { matches: scores.map((score) => ({ score })) };
  };

  return { allowedIndexes: validIndexes, search };
}

export function registerKnowledgeTools(
  allowedIndexes: string[],
  register: (tool: ToolDeclaration) => void,
): void {
  if (allowedIndexes.length === 0) return;

  const memoryConfig = pineconeMemoryConfig();
  const envVarName = memoryConfig.apiKeyEnv;
  const apiKey = resolveApiKey({ service: memoryConfig.apiKeyService, envVar: envVarName });
  if (!apiKey) {
    log.warn('Pinecone API key env var not set — knowledge tools will not be registered');
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
    if (memoryConfig.knowledgeProfiles[name]) return true;
    log.warn({ index: name }, 'Unknown index in memory.pinecone.allowedIndexes — skipping');
    return false;
  });

  if (validIndexes.length === 0) return;

  // Build enum description
  const indexDescriptions = validIndexes
    .map((name) => `"${name}": ${memoryConfig.knowledgeProfiles[name]!.description}`)
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
    // Optional vendor-gated tool: Pinecone may be absent/misconfigured, in which case
    // registerAllTools logs and continues rather than aborting boot.
    core: false,
    handler: async (params) => {
      const parsed = KnowledgeSearchSchema.safeParse(params);
      if (!parsed.success) {
        return errorResult(`Invalid parameters: ${parsed.error.issues.map(i => i.message).join(', ')}`);
      }

      const { index: indexName, query, top_k, namespace: nsOverride } = parsed.data;
      const profile = memoryConfig.knowledgeProfiles[indexName]!;
      const startMs = Date.now();

      // Determine which namespaces to search.
      //
      // For the standalone mw-mind index, WhatsApp queries route by intent:
      //   - facts-first: configured facts, then summaries, chunks
      //   - raw-first:   configured summaries, chunks, then facts
      //   - hybrid:      configured summaries, facts, chunks
      // Other configured profile namespaces are
      // appended after the routed WhatsApp order so they still participate in
      // the fan-out. An explicit `namespace` argument overrides routing.
      const routed = resolveNamespacesToSearch(
        indexName,
        query,
        profile,
        nsOverride,
        memoryConfig.namespaces,
      );
      if (routed.error) {
        return errorResult(routed.error);
      }
      const namespacesToSearch = routed.namespacesToSearch;
      const queryIntent = routed.queryIntent;

      try {
        const projectError = await validatePineconeProject(pc, indexName, {
          projectId: memoryConfig.projectId,
          expectedHostSuffix: memoryConfig.expectedHostSuffix,
        });
        if (projectError) return errorResult(projectError);

        const index = pc.index(indexName);
        let hits: ParsedHit[] = [];

        if (profile.searchMode === 'vector') {
          // Standalone index: embed the query client-side and call index.query.
          let vec: number[];
          try {
            const embedUrl = profile.embedUrl ?? memoryConfig.knowledgeProfiles[indexName]?.embedUrl;
            if (!embedUrl) {
              return errorResult(`Vector index "${indexName}" is missing memory.pinecone.knowledgeProfiles.${indexName}.embedUrl.`);
            }
            const embedResp = await fetch(embedUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ texts: [query], input_type: 'query' }),
            });
            if (!embedResp.ok) {
              const status = embedResp.status;
              log.error({ index: indexName, status }, 'embed service returned non-OK');
              return errorResult(`Embed service unavailable (HTTP ${status}). Try again in a moment.`);
            }
            const embedJson = (await embedResp.json()) as { vectors: number[][]; dim?: number };
            if (!Array.isArray(embedJson.vectors) || embedJson.vectors.length === 0) {
              log.error({ index: indexName }, 'embed service returned no vectors');
              return errorResult('Embed service returned no vectors.');
            }
            vec = embedJson.vectors[0]!;
          } catch (embedErr) {
            log.error({ err: embedErr, index: indexName }, 'embed service call failed');
            return errorResult('Knowledge base is temporarily unavailable (embed service). Try again in a moment.');
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

        // Client-side rerank if configured
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
        // PII hygiene: the raw query text may contain personal details
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
        const message = errorMessage(err);
        log.error({ err, index: indexName, query: query.slice(0, 80), durationMs }, 'knowledge search failed');

        // User-friendly error for common failures
        if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i.test(message)) {
          return errorResult('Knowledge base is temporarily unavailable. Try again in a moment.');
        }
        if (/401|403|unauthorized|forbidden/i.test(message)) {
          return errorResult('Knowledge base authentication error. Contact admin.');
        }
        return errorResult(`Search failed: ${message}`);
      }
    },
  });

  log.info({ indexes: validIndexes }, 'knowledge tools registered');
}
