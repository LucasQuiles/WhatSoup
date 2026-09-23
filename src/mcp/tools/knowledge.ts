// src/mcp/tools/knowledge.ts
// Scoped Pinecone knowledge base search for agent instances.
// Exposes search over a configurable allowlist of Pinecone indexes.

import { z } from 'zod';
import { Pinecone } from '@pinecone-database/pinecone';
import { createChildLogger } from '../../logger.ts';
import { truncateForRerank } from '../../lib/text-utils.ts';
import { isNonEmptyString } from '../../lib/type-guards.ts';
import { type Clock, systemClock } from '../../lib/clock.ts';
import { routeQuery } from '../../runtimes/chat/memory/query-router.ts';
import { config } from '../../config.ts';
import type { KnowledgeProfileConfig } from '../../config.ts';
import {
  conversationBoundKey,
  errorResult,
  toolError,
  type SessionContext,
  type ToolDeclaration,
} from '../types.ts';
import {
  isOperatorInstance,
  pineconeProjectGuardError,
  resolvePineconeProjectGuard,
  type PineconeProjectGuard,
} from '../../lib/pinecone-project-guard.ts';
import type { Database } from '../../core/database.ts';
import {
  memoryHitTier,
  memoryIdentityFold,
  resolveMemoryScope,
  type GroupMembershipReader,
  type InstanceIdentities,
  type MemoryScope,
  type MemoryTier,
} from '../../core/memory-scope.ts';
import { errorMessage } from '../../lib/error-message.ts';
import { resolveApiKey } from '../../lib/api-key-resolver.ts';
import { EXTERNAL_EFFECT_CONTRACT_VERSION } from '../external-effect.ts';

const log = createChildLogger('knowledge-tools');

/** Max chars per result text to keep tool output within token budget. */
const MAX_TEXT_PER_RESULT = 600;

/** Max total results to return (after rerank/dedup). */
const MAX_RESULTS = 8;

/**
 * Most candidates sent to rerank. Candidates are cut in tier order, so this-chat
 * hits are never the ones dropped to fit a rerank model's document limit.
 */
const RERANK_CANDIDATE_CAP = 100;

interface ParsedHit {
  id: string;
  score: number;
  text: string;
  entityType: string;
  fields: Record<string, unknown>;
  namespace?: string;
}

interface TieredHit extends ParsedHit {
  /** Memory tier, or null for a document hit (not chat-scoped). */
  tier: MemoryTier | null;
}

/**
 * Instance facts knowledge_search needs to scope a search of the memory index.
 * Optional so callers without a connection (tests, tools) still register; with
 * none, admin and DM-lane checks cannot be proven and groups fall back to the
 * configurable-group rule.
 */
export interface KnowledgeSearchDeps {
  db?: Database | null;
  identities?: () => InstanceIdentities;
  membership?: GroupMembershipReader | null;
  sharedWorkflowGroups?: Iterable<string>;
  contactRecallScopes?: Readonly<Record<string, string>>;
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
  const { guard } = resolvePineconeProjectGuard((config as { botName?: unknown }).botName, {
    projectId: pinecone?.projectId,
    expectedHostSuffix: pinecone?.expectedHostSuffix,
  });
  return {
    apiKeyEnv: pinecone?.apiKeyEnv || 'PINECONE_API_KEY',
    apiKeyService: isNonEmptyString(pinecone?.apiKeyService)
      ? pinecone.apiKeyService
      : undefined,
    projectId: guard.projectId,
    expectedHostSuffix: guard.expectedHostSuffix,
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

/**
 * Namespace that memory_write (PineconeMemory.upsert) writes to. PineconeMemory
 * opens `config.pineconeIndex` without a namespace, which the SDK resolves to
 * its default namespace, spelled `__default__` (the SDK maps `''` to it too).
 */
const MEMORY_WRITE_NAMESPACE = '__default__';

function isDefaultNamespace(namespace: string): boolean {
  return namespace === '' || namespace === MEMORY_WRITE_NAMESPACE;
}

interface ResolvedNamespaces {
  namespacesToSearch: string[];
  queryIntent?: string;
  error?: string;
}

function isMemoryIndex(indexName: string): boolean {
  const memoryIndex = (config as { pineconeIndex?: unknown }).pineconeIndex;
  return isNonEmptyString(memoryIndex) && indexName === memoryIndex;
}

/**
 * Keep memory_write and knowledge_search in agreement: a search of the
 * instance's own memory index always includes the namespace memory_write
 * writes to, so the bot can find what it saved. Other indexes are unchanged,
 * and a profile that already lists the default namespace keeps its behaviour.
 */
function withMemoryWriteNamespace(indexName: string, namespacesToSearch: string[]): { namespacesToSearch: string[] } {
  if (!isMemoryIndex(indexName)) return { namespacesToSearch };
  if (namespacesToSearch.some(isDefaultNamespace)) return { namespacesToSearch };
  return { namespacesToSearch: [...namespacesToSearch, MEMORY_WRITE_NAMESPACE] };
}

interface SearchLeg {
  namespace: string;
  filter?: Record<string, unknown>;
}

/**
 * Namespaces of the memory index whose records are chat memories, so the chat
 * tiers and the group boundary apply to them: the memory_write namespace, and the
 * WhatsApp conversation roles in `memory.pinecone.namespaces` (facts, chunks,
 * summaries, and the legacy message namespace). Every other namespace, including
 * the contacts, local-docs and OneDrive roles, is a document namespace: searched
 * unfiltered in every context and merged in by relevance, as before scoping.
 */
function chatAttributedNamespaces(namespaces: ReturnType<typeof pineconeMemoryConfig>['namespaces']): Set<string> {
  const roles = [namespaces?.facts, namespaces?.chunks, namespaces?.summaries, namespaces?.['legacy']];
  return new Set(['', MEMORY_WRITE_NAMESPACE, ...roles.filter(isNonEmptyString)]);
}

/**
 * The queries for one search. Outside the memory index, and for document
 * namespaces, each namespace is queried once, unfiltered. For a chat namespace a
 * scope with a pinned conversation also queries that conversation's records, so
 * they are not crowded out of topK by other chats; a configurable group queries
 * only this conversation. The filters only narrow the fetch: memoryHitTier
 * decides what the caller may see.
 */
function searchLegs(
  namespaces: string[],
  scope: MemoryScope | null,
  isChatNamespace: (namespace: string) => boolean,
): SearchLeg[] {
  if (!scope) return namespaces.map((namespace) => ({ namespace }));
  const thisChat = scope.chatSpellings.length > 0 ? { chat_jid: { $in: scope.chatSpellings } } : undefined;
  return namespaces.flatMap((namespace): SearchLeg[] => {
    if (!isChatNamespace(namespace)) return [{ namespace }];
    if (scope.kind === 'no_context') return [];
    if (scope.kind === 'configurable_group') return thisChat ? [{ namespace, filter: thisChat }] : [];
    return thisChat ? [{ namespace, filter: thisChat }, { namespace }] : [{ namespace }];
  });
}

/** Better duplicate: the better memory tier, then the higher score. */
function preferHit(candidate: TieredHit, existing: TieredHit): boolean {
  if (candidate.tier !== null && existing.tier !== null && candidate.tier !== existing.tier) {
    return candidate.tier < existing.tier;
  }
  return candidate.score > existing.score;
}

/**
 * Gate the merged hits and remove duplicates (one record returned by the chat leg
 * and the unfiltered leg) so they cannot take two result slots. Chat-memory hits
 * get a tier or are dropped; document hits pass ungated with tier null.
 */
function tierHits(
  hits: ParsedHit[],
  scope: MemoryScope | null,
  isChatNamespace: (namespace: string) => boolean,
  db: Database | null | undefined,
): TieredHit[] {
  const fold = memoryIdentityFold(db);
  const byId = new Map<string, TieredHit>();
  for (const hit of hits) {
    const isDocument = scope !== null && !isChatNamespace(hit.namespace ?? '');
    const tier = isDocument ? null : scope ? memoryHitTier(hit.fields, scope, fold) : 0;
    if (!isDocument && tier === null) continue;
    const candidate: TieredHit = { ...hit, tier };
    const existing = byId.get(hit.id);
    if (!existing || preferHit(candidate, existing)) byId.set(hit.id, candidate);
  }
  return [...byId.values()];
}

/**
 * Final order. Memories keep tier order (this chat -> other chats -> untagged),
 * ordered by score within a tier, or by their current order when `reranked`
 * (rerank orders within a tier only). Documents are merged in by score, so a
 * relevant document can sit above a weakly relevant memory.
 */
function orderHits(hits: TieredHit[], reranked: boolean): TieredHit[] {
  const memory = hits
    .map((hit, position) => ({ hit, position }))
    .filter(({ hit }) => hit.tier !== null)
    .sort((a, b) => (a.hit.tier ?? 0) - (b.hit.tier ?? 0)
      || (reranked ? a.position - b.position : b.hit.score - a.hit.score))
    .map(({ hit }) => hit);
  const documents = hits.filter((hit) => hit.tier === null);
  if (!reranked) documents.sort((a, b) => b.score - a.score);
  const merged: TieredHit[] = [];
  let m = 0;
  let d = 0;
  while (m < memory.length || d < documents.length) {
    const takeMemory = d >= documents.length || (m < memory.length && memory[m]!.score >= documents[d]!.score);
    merged.push(takeMemory ? memory[m++]! : documents[d++]!);
  }
  return merged;
}

function resolveNamespacesToSearch(
  indexName: string,
  query: string,
  profile: KnowledgeProfileConfig,
  nsOverride: string | undefined,
  namespaces: ReturnType<typeof pineconeMemoryConfig>['namespaces'],
): ResolvedNamespaces {
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
    return { ...withMemoryWriteNamespace(indexName, [...routed.namespaces, ...others]), queryIntent: routed.intent };
  }

  if (profile.namespaces.length > 0) {
    return withMemoryWriteNamespace(indexName, profile.namespaces);
  }

  return withMemoryWriteNamespace(indexName, [profile.namespace]);
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
        signal: AbortSignal.timeout(30_000),
      });
      if (!embedResp.ok) throw new Error(`embed service HTTP ${embedResp.status}`);
      let embedJson: { vectors: number[][] };
      try {
        embedJson = (await embedResp.json()) as { vectors: number[][] };
      } catch (err) {
        throw new Error(`embed service returned non-JSON response: ${errorMessage(err)}`);
      }
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
  // Injectable so search duration can be driven to a known instant (#2200).
  // Optional and defaulted, so this slice changes no existing call site.
  clock: Clock = systemClock,
  deps: KnowledgeSearchDeps = {},
): void {
  if (allowedIndexes.length === 0) return;

  const memoryConfig = pineconeMemoryConfig();
  const envVarName = memoryConfig.apiKeyEnv;
  const chatNamespaces = chatAttributedNamespaces(memoryConfig.namespaces);
  const isChatNamespace = (namespace: string): boolean => chatNamespaces.has(namespace);
  const noIdentities: InstanceIdentities = {
    adminPhones: new Set(), siblingPhones: new Set(), botJid: null, botLid: null,
  };
  const scopeFor = (session: SessionContext): Promise<MemoryScope> => resolveMemoryScope(
    {
      operatorInstance: isOperatorInstance((config as { botName?: unknown }).botName),
      tier: session.tier,
      conversationKey: conversationBoundKey(session) ?? session.conversationKey,
      deliveryJid: session.deliveryJid,
      actorJid: session.actorJid,
    },
    {
      db: deps.db,
      identities: deps.identities?.() ?? noIdentities,
      membership: deps.membership,
      sharedWorkflowGroups: deps.sharedWorkflowGroups ?? [],
      contactRecallScopes: deps.contactRecallScopes,
    },
  );
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
    externalEffect: { version: EXTERNAL_EFFECT_CONTRACT_VERSION, kind: 'none' },
    // Optional vendor-gated tool: Pinecone may be absent/misconfigured, in which case
    // registerAllTools logs and continues rather than aborting boot.
    core: false,
    handler: async (params, session) => {
      const parsed = KnowledgeSearchSchema.safeParse(params);
      if (!parsed.success) {
        return errorResult(`Invalid parameters: ${parsed.error.issues.map(i => i.message).join(', ')}`);
      }

      const { index: indexName, query, top_k, namespace: nsOverride } = parsed.data;
      const profile = memoryConfig.knowledgeProfiles[indexName]!;
      const startMs = clock.now();

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
        // Scope applies to every search of the instance's memory index, including
        // an explicit namespace argument; other indexes are not memory and are
        // searched as configured.
        const scope = isMemoryIndex(indexName) ? await scopeFor(session) : null;
        const legs = searchLegs(namespacesToSearch, scope, isChatNamespace);
        const projectError = await validatePineconeProject(pc, indexName, {
          projectId: memoryConfig.projectId,
          expectedHostSuffix: memoryConfig.expectedHostSuffix,
        });
        if (projectError) return errorResult(projectError);

        const index = pc.index(indexName);
        const hits: ParsedHit[] = [];

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
              signal: AbortSignal.timeout(30_000),
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
          const queryPromises = legs.map(({ namespace: ns, filter }) => {
            return index.namespace(ns).query({
              topK,
              vector: vec,
              includeMetadata: true,
              ...(filter ? { filter } : {}),
            }).catch((err) => {
              log.warn({ err, namespace: ns }, 'namespace vector query failed — skipping');
              return null;
            });
          });
          const responses = await Promise.all(queryPromises);
          responses.forEach((response, legIndex) => {
            if (!response || !Array.isArray(response.matches)) return;
            for (const match of response.matches) {
              const fields = (match.metadata ?? {}) as Record<string, unknown>;
              hits.push({
                id: String(match.id),
                score: typeof match.score === 'number' ? match.score : 0,
                text: (fields['text'] as string) ?? '',
                entityType: (fields['entity_type'] as string) ?? 'document',
                fields,
                namespace: legs[legIndex]!.namespace,
              });
            }
          });
        } else {
          // Integrated-index branch: Pinecone-hosted embedding via searchRecords.
          const searchPromises = legs.map(({ namespace: ns, filter }) => {
            return index.searchRecords({
              namespace: ns,
              query: {
                topK: top_k ?? profile.topK,
                inputs: { text: query },
                ...(filter ? { filter } : {}),
              },
              fields: ['*'],
            }).catch((err) => {
              log.warn({ err, namespace: ns }, 'namespace search failed — skipping');
              return null;
            });
          });

          const responses = await Promise.all(searchPromises);
          responses.forEach((response, legIndex) => {
            if (response?.result?.hits) {
              const namespace = legs[legIndex]!.namespace;
              hits.push(...parseHits(response.result.hits).map((hit) => ({ ...hit, namespace })));
            }
          });
        }

        // Gate, dedup by id, then order: memories by tier (this chat -> other
        // chats -> untagged) and score, documents merged in by score. Outside the
        // memory index every hit is tier 0.
        let ranked = orderHits(tierHits(hits, scope, isChatNamespace, deps.db), false)
          .slice(0, RERANK_CANDIDATE_CAP);
        let limit = MAX_RESULTS;

        // Client-side rerank if configured. It scores every candidate, then the
        // tier order is restored so rerank reorders memories within a tier only;
        // documents are merged back in by their rerank score.
        if (profile.rerank && ranked.length > 0) {
          try {
            const rerankResult = await pc.inference.rerank({
              model: profile.rerankModel,
              query,
              documents: ranked.map((h) => ({
                id: h.id,
                text: truncateForRerank(h.text),
              })),
              topN: ranked.length,
              rankFields: ['text'],
              returnDocuments: false,
            });

            const reranked: TieredHit[] = [];
            for (const doc of rerankResult.data) {
              const original = ranked[doc.index];
              if (original) {
                reranked.push({ ...original, score: doc.score });
              }
            }
            ranked = orderHits(reranked, true);
            limit = Math.min(profile.rerankTopN, MAX_RESULTS);
          } catch (rerankErr) {
            log.warn({ err: rerankErr }, 'Rerank failed — using vector scores');
          }
        }

        const hitsBeforeScoreFilter = ranked.length;
        const minScore = profile.minScore;
        if (typeof minScore === 'number') {
          ranked = ranked.filter((hit) => hit.score >= minScore);
        }
        const discardedLowScore = hitsBeforeScoreFilter - ranked.length;
        const deduped: ParsedHit[] = ranked.slice(0, limit);

        const durationMs = clock.now() - startMs;
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
            discardedLowScore,
            ...(scope ? { memoryScope: scope.kind, memoryScopeReason: scope.reason } : {}),
            ...(typeof minScore === 'number' ? { minScore } : {}),
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
            results: [],
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
          results: deduped.map((hit) => ({
            id: hit.id,
            score: hit.score,
            entity_type: hit.entityType,
          })),
          formatted,
        };
      } catch (err) {
        const durationMs = clock.now() - startMs;
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
