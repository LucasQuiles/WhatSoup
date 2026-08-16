// src/runtimes/agent/fallback-discovery.ts
// Pure catalogue→chain derivation for discovery-mode fallback selection (R6,
// owner directive 2026-08-15: chains are discovered per host/user/deployment,
// never hardcoded — static config lists remain only as an operator override).
//
// The discovery SOURCE is the provider gateway's self-reported model catalogue
// (`<binary> models` via listModelCatalog — credential-aware: the gateway only
// lists providers it holds auth for). This module is pure over its inputs so
// ranking is deterministic and unit-testable: the runtime threads the live
// catalogue, the primary route, and an evidence oracle (chain-canary results,
// quota-reset hints, failed-entry records) and receives an ordered chain.
//
// Ranking rationale:
//  - ONE model per catalogue provider — adjacent same-provider entries die
//    together on quota/suspension, so provider diversity IS the ladder's
//    resilience (incident 2026-08-15: kimi suspended + glm quota-exhausted
//    left a 3-entry chain with a single live entry).
//  - Within a provider, the operator pin wins, else the LAST catalogue entry
//    (observed newest/flagship across deepseek/glm/minimax/kimi catalogues).
//  - Candidates with real-completion 'ok' evidence rank before 'unknown';
//    'dead' candidates are excluded from selection but reported in the basis.
//  - Keyless free-tier gateway models are eligible ONLY for the tail slot — a
//    weak model that needs no credential beats a chain-exhausted turn.

export type CandidateEvidence = 'ok' | 'dead' | 'unknown';

export interface FallbackDiscoveryPolicy {
  /** Chain length cap; clamped to [1, 4] (mirrors the static-chain cap). */
  maxEntries: number;
  /** Per-catalogue-provider model pin, e.g. { glm: 'glm/glm-5.2' }. Ignored
   *  when the pinned id is absent from the live catalogue. */
  preferModels: Record<string, string>;
  /** Catalogue provider prefixes to skip entirely. */
  excludeProviders: readonly string[];
  /** Append one keyless free-tier gateway model as the tail entry. */
  includeFreeTier: boolean;
}

export const DEFAULT_DISCOVERY_POLICY: FallbackDiscoveryPolicy = {
  maxEntries: 3,
  preferModels: {},
  excludeProviders: [],
  includeFreeTier: true,
};

/** Catalogue provider prefix whose models run without operator credentials. */
const FREE_TIER_PREFIX = 'opencode';

/**
 * Model-name tokens that mark a catalogue id as NON-CHAT — embeddings, image/
 * video/music generation, speech, moderation, rerankers, realtime-audio.
 * Gateways list every model a credential unlocks, and the newest-per-provider
 * pick has no modality signal, so without this filter a chain candidate can be
 * a model that cannot serve a text turn at all (observed live 2026-08-16:
 * openai's pick was `text-embedding-ada-002`; google's would be
 * `veo-3.1-lite-generate-preview`, a VIDEO model). Substring heuristic on the
 * model segment; deliberately over-excludes — a wrongly excluded fringe chat
 * model costs one candidate, while a wrongly included non-chat model is a
 * guaranteed-dead fallback rung. Operator `preferModels` pins BYPASS the
 * filter (explicit intent beats the heuristic).
 */
const NON_CHAT_MODEL_TOKENS = [
  'embed', 'imagen', 'veo-', 'lyria', 'tts', 'dall-e', 'image', 'whisper',
  'moderation', 'realtime', 'transcribe', 'rerank', 'audio',
] as const;

/** True when a catalogue id's model segment matches a non-chat token. */
export function isNonChatCatalogModel(modelId: string): boolean {
  const slash = modelId.indexOf('/');
  const modelSegment = (slash >= 0 ? modelId.slice(slash + 1) : modelId).toLowerCase();
  return NON_CHAT_MODEL_TOKENS.some((token) => modelSegment.includes(token));
}

export interface DiscoveredCandidate {
  catalogProvider: string;
  model: string;
  evidence: CandidateEvidence;
  freeTier: boolean;
  selected: boolean;
}

export interface DiscoveredChainResult {
  /** Ordered chain entries for the runtime (gateway provider + model id). */
  entries: { provider: string; model: string }[];
  /** Every candidate considered, in rank order, for logs/status surfaces. */
  basis: DiscoveredCandidate[];
}

export function deriveFallbackChainFromCatalog(opts: {
  /** `listModelCatalog` ids in catalogue order (e.g. 'glm/glm-5.2'). */
  catalogIds: readonly string[];
  /** Runtime provider id the entries route through (e.g. 'opencode-cli'). */
  gatewayProvider: string;
  primary: { provider: string; model?: string | null };
  policy?: Partial<FallbackDiscoveryPolicy>;
  /** Evidence oracle; absent → every candidate is 'unknown'. */
  evidenceFor?: (modelId: string) => CandidateEvidence;
}): DiscoveredChainResult {
  const policy: FallbackDiscoveryPolicy = {
    ...DEFAULT_DISCOVERY_POLICY,
    ...opts.policy,
  };
  const maxEntries = Math.min(4, Math.max(1, Math.trunc(policy.maxEntries)));
  const evidenceFor = opts.evidenceFor ?? ((): CandidateEvidence => 'unknown');
  const excluded = new Set(policy.excludeProviders);

  // Group catalogue ids by provider prefix, preserving catalogue order.
  // Non-chat models (embeddings, image/video/speech generation, …) are
  // dropped here so BOTH the newest-per-provider pick and the free-tier tail
  // only ever consider ids that can serve a text turn — unless the operator
  // pinned one explicitly, which always wins over the heuristic.
  const groups = new Map<string, string[]>();
  for (const id of opts.catalogIds) {
    const slash = id.indexOf('/');
    if (slash <= 0 || slash === id.length - 1) continue; // malformed id
    const catalogProvider = id.slice(0, slash);
    if (excluded.has(catalogProvider)) continue;
    if (isNonChatCatalogModel(id) && policy.preferModels[catalogProvider] !== id) continue;
    const group = groups.get(catalogProvider);
    if (group) group.push(id);
    else groups.set(catalogProvider, [id]);
  }

  // One candidate per provider: operator pin when live, else last (newest).
  const candidates: DiscoveredCandidate[] = [];
  for (const [catalogProvider, ids] of groups) {
    const pinned = policy.preferModels[catalogProvider];
    const model = pinned !== undefined && ids.includes(pinned) ? pinned : ids[ids.length - 1]!;
    const freeTier = catalogProvider === FREE_TIER_PREFIX;
    if (freeTier && !policy.includeFreeTier) continue;
    if (opts.gatewayProvider === opts.primary.provider && model === opts.primary.model) continue;
    candidates.push({
      catalogProvider,
      model,
      evidence: evidenceFor(model),
      freeTier,
      selected: false,
    });
  }

  // Rank: keyed providers first (ok → unknown, catalogue order within each
  // tier), then the free-tier candidate; 'dead' never selectable.
  const tierOf = (c: DiscoveredCandidate): number => {
    if (c.evidence === 'dead') return Number.MAX_SAFE_INTEGER;
    return (c.freeTier ? 2 : 0) + (c.evidence === 'ok' ? 0 : 1);
  };
  const ranked = candidates
    .map((candidate, catalogRank) => ({ candidate, catalogRank }))
    .sort((a, b) => tierOf(a.candidate) - tierOf(b.candidate) || a.catalogRank - b.catalogRank)
    .map((r) => r.candidate);

  // The free-tier tail slot is RESERVED (not spare-capacity-only): a keyless
  // model is the one entry guaranteed to survive a total quota/billing
  // wipeout of the keyed providers — the incident class this module exists
  // for. Exception: a 1-entry chain keeps its single slot for the strongest
  // keyed candidate; free tier fills it only when nothing keyed is live.
  const freeTierCandidate = ranked.find((c) => c.freeTier && c.evidence !== 'dead');
  const reserveFreeTierSlot = freeTierCandidate !== undefined && maxEntries >= 2;
  const keyedBudget = reserveFreeTierSlot ? maxEntries - 1 : maxEntries;

  const entries: { provider: string; model: string }[] = [];
  for (const candidate of ranked) {
    if (entries.length >= keyedBudget) break;
    if (candidate.evidence === 'dead' || candidate.freeTier) continue;
    candidate.selected = true;
    entries.push({ provider: opts.gatewayProvider, model: candidate.model });
  }
  if (freeTierCandidate && entries.length < maxEntries) {
    freeTierCandidate.selected = true;
    entries.push({ provider: opts.gatewayProvider, model: freeTierCandidate.model });
  }
  return { entries, basis: ranked };
}
