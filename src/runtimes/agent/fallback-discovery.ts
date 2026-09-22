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
//  - Within a provider, a live operator pin wins. Otherwise recent successful
//    completion evidence wins, then stable lifecycle (an id carrying a
//    pre-release token such as `-exp` or `-preview` counts as preview even when
//    the gateway reports it active), then validated release date, then the
//    provider's rolling alias (an id equal to its models.dev family), and
//    finally descending model id. The representative never depends on where
//    an id appears in the catalogue listing (incident 2026-09-21: three
//    same-day DeepSeek ids tied and listing position picked an experimental
//    variant).
//  - A dead exact model does not condemn its provider: the next eligible model
//    can represent that provider. An all-dead provider keeps one bounded
//    recovery probe; a replaced dead sibling becomes eligible after its
//    failure evidence expires rather than expanding the canary sweep.
//  - A metadata-confirmed zero-cost gateway model is eligible ONLY for the
//    tail slot — a weak keyless model beats a chain-exhausted turn.

import {
  modelCatalogReleaseDateSortKey,
  type ModelCatalogMetadata,
} from './providers/binary-preflight.ts';

export type CandidateEvidence = 'ok' | 'dead' | 'unknown';
export type CandidateEligibilityBasis = 'metadata' | 'legacy-heuristic' | 'operator-pin';

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

/** Lifecycle values that explicitly mean the model should no longer receive
 *  automatic traffic. Preview/alpha/beta values stay eligible because they
 *  are not an inactive claim. */
const INACTIVE_MODEL_STATUSES = new Set(['inactive', 'deprecated', 'retired', 'disabled']);

/** True when a catalogue id's model segment matches a non-chat token. */
export function isNonChatCatalogModel(modelId: string): boolean {
  const slash = modelId.indexOf('/');
  const modelSegment = (slash >= 0 ? modelId.slice(slash + 1) : modelId).toLowerCase();
  return NON_CHAT_MODEL_TOKENS.some((token) => modelSegment.includes(token));
}

/**
 * Whole-word lifecycle tokens that mark a model id as pre-release. models.dev
 * publishes lifecycle only as absent, `beta`, or `deprecated`, and OpenCode
 * reports an absent value as `active`, so an experimental variant usually
 * arrives with the same status and release date as the stable model it
 * accompanies (observed 2026-09-21: `deepseek-v4-flash-vision-exp`). The id is
 * then the only lifecycle signal left. Tokens are matched as whole words so
 * `expert` or `betamax` never match.
 */
const PRE_RELEASE_ID_TOKENS = new Set(['exp', 'experimental', 'preview', 'alpha', 'beta']);

/** True when a catalogue id's model segment carries a pre-release token. */
export function isExperimentalCatalogModel(modelId: string): boolean {
  const slash = modelId.indexOf('/');
  const modelSegment = (slash >= 0 ? modelId.slice(slash + 1) : modelId).toLowerCase();
  return modelSegment.split(/[-_.]/).some((token) => PRE_RELEASE_ID_TOKENS.has(token));
}

export interface DiscoveredCandidate {
  catalogProvider: string;
  model: string;
  evidence: CandidateEvidence;
  catalogStatus: string | null;
  /** models.dev family of the representative, when the catalogue supplies one. */
  family: string | null;
  releaseDate: string | null;
  zeroCost: boolean | null;
  eligibilityBasis: CandidateEligibilityBasis;
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
  /** Shape-checked optional metadata keyed by exact catalogue id. */
  catalogMetadata?: Readonly<Record<string, ModelCatalogMetadata>>;
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

  // Group catalogue ids by provider prefix. Map insertion order (first
  // appearance of each provider) still orders providers in the final chain;
  // an id's position inside its provider group is never a ranking input.
  const groups = new Map<string, string[]>();
  for (const id of opts.catalogIds) {
    const slash = id.indexOf('/');
    if (slash <= 0 || slash === id.length - 1) continue; // malformed id
    const catalogProvider = id.slice(0, slash);
    if (excluded.has(catalogProvider)) continue;
    const group = groups.get(catalogProvider);
    if (group) group.push(id);
    else groups.set(catalogProvider, [id]);
  }

  const evidenceTier = (evidence: CandidateEvidence): number => {
    if (evidence === 'ok') return 0;
    if (evidence === 'unknown') return 1;
    return 2;
  };
  const statusTier = (status: string | null): number => {
    if (status === 'active' || status === 'stable' || status === 'ga') return 0;
    if (status === 'beta' || status === 'preview') return 1;
    if (status === 'alpha' || status === 'experimental') return 2;
    return 3;
  };
  // A pre-release id token can only lower a model to the preview tier. It
  // never lifts an explicit alpha status or an unknown status upward.
  const lifecycleTier = (status: string | null, modelId: string): number => {
    const tier = statusTier(status);
    return isExperimentalCatalogModel(modelId) ? Math.max(tier, 1) : tier;
  };

  type RankedProviderModel = {
    model: string;
    evidence: CandidateEvidence;
    catalogStatus: string | null;
    family: string | null;
    /** The id's model segment equals its family: the provider's rolling
     *  alias for that line (e.g. `deepseek/deepseek-flash`). */
    canonicalAlias: boolean;
    releaseDate: string | null;
    releaseDateSortKey: string | null;
    zeroCost: boolean | null;
    eligibilityBasis: CandidateEligibilityBasis;
    hasMetadataRecord: boolean;
    pinned: boolean;
  };

  // One representative per provider. A pin wins while it is not dead. For an
  // automatic pick, completion evidence is stronger than catalogue recency;
  // lifecycle, release date and finally the model id break the remaining
  // ties, so the result is a pure function of the id set and its metadata.
  const candidates: DiscoveredCandidate[] = [];
  for (const [catalogProvider, ids] of groups) {
    if (catalogProvider === FREE_TIER_PREFIX && !policy.includeFreeTier) continue;
    const pinned = policy.preferModels[catalogProvider];
    const providerModels: RankedProviderModel[] = [];
    for (const id of ids) {
      if (opts.gatewayProvider === opts.primary.provider && id === opts.primary.model) continue;
      const isPinned = pinned === id;
      const hasMetadataRecord = opts.catalogMetadata !== undefined
        && Object.prototype.hasOwnProperty.call(opts.catalogMetadata, id);
      const rawMetadata = opts.catalogMetadata?.[id];
      const status = typeof rawMetadata?.status === 'string'
        ? rawMetadata.status.trim().toLowerCase()
        : null;
      const rawReleaseDate = rawMetadata?.releaseDate;
      const releaseDateSortKey = modelCatalogReleaseDateSortKey(rawReleaseDate);
      const releaseDate = releaseDateSortKey !== null && typeof rawReleaseDate === 'string'
        ? rawReleaseDate
        : null;
      const zeroCost = typeof rawMetadata?.zeroCost === 'boolean'
        ? rawMetadata.zeroCost
        : null;
      const family = typeof rawMetadata?.family === 'string' && rawMetadata.family.trim() !== ''
        ? rawMetadata.family.trim()
        : null;
      const canonicalAlias = family !== null
        && id.slice(catalogProvider.length + 1).toLowerCase() === family.toLowerCase();

      // The opencode gateway also lists paid catalogue entries. Only a model
      // explicitly recorded as zero-cost (or a metadata-free legacy entry)
      // can fill the automatic keyless/free-tier reserve. A verbose record
      // with missing/malformed cost is unknown, not free. An exact operator
      // pin may still choose such an entry, but it is not labeled free tier.
      if (
        catalogProvider === FREE_TIER_PREFIX
        && !isPinned
        && hasMetadataRecord
        && zeroCost !== true
      ) continue;

      let eligibilityBasis: CandidateEligibilityBasis;
      if (isPinned) {
        eligibilityBasis = 'operator-pin';
      } else {
        const explicitlyIneligible = (status !== null && INACTIVE_MODEL_STATUSES.has(status))
          || rawMetadata?.textOutput === false
          || rawMetadata?.toolCall === false;
        if (explicitlyIneligible) continue;
        if (rawMetadata?.textOutput === true && rawMetadata?.toolCall === true) {
          eligibilityBasis = 'metadata';
        } else {
          if (isNonChatCatalogModel(id)) continue;
          eligibilityBasis = 'legacy-heuristic';
        }
      }

      providerModels.push({
        model: id,
        evidence: evidenceFor(id),
        catalogStatus: status,
        family,
        canonicalAlias,
        releaseDate,
        releaseDateSortKey,
        zeroCost,
        eligibilityBasis,
        hasMetadataRecord,
        pinned: isPinned,
      });
    }
    if (providerModels.length === 0) continue;

    providerModels.sort((a, b) => {
      if (a.pinned !== b.pinned) {
        if (a.pinned && a.evidence !== 'dead') return -1;
        if (b.pinned && b.evidence !== 'dead') return 1;
      }
      const evidenceDifference = evidenceTier(a.evidence) - evidenceTier(b.evidence);
      if (evidenceDifference !== 0) return evidenceDifference;
      const lifecycleDifference = lifecycleTier(a.catalogStatus, a.model)
        - lifecycleTier(b.catalogStatus, b.model);
      if (lifecycleDifference !== 0) return lifecycleDifference;
      if (a.releaseDateSortKey !== b.releaseDateSortKey) {
        if (a.releaseDateSortKey === null) return 1;
        if (b.releaseDateSortKey === null) return -1;
        return b.releaseDateSortKey.localeCompare(a.releaseDateSortKey);
      }
      // Among equally evidenced, equally stable, same-day models, prefer the
      // provider's rolling alias. Sitting after release date, this can never
      // choose an alias over a newer versioned model, and after lifecycle it
      // can never choose a pre-release alias over a stable sibling. On the
      // fleet host it also avoids a legacy alias carrying a smaller locally
      // configured output limit (observed 2026-09-22).
      if (a.canonicalAlias !== b.canonicalAlias) return a.canonicalAlias ? -1 : 1;
      // Total order: descending plain string comparison of the id (not
      // locale-aware, so the result is identical on every host). OpenCode
      // lists ids ascending within a provider, so this reproduces the former
      // later-entry pick for metadata-free gateways without reading position.
      if (a.model === b.model) return 0;
      return a.model < b.model ? 1 : -1;
    });

    const representative = providerModels[0]!;
    const freeTier = catalogProvider === FREE_TIER_PREFIX
      && (representative.zeroCost === true || !representative.hasMetadataRecord);
    candidates.push({
      catalogProvider,
      model: representative.model,
      evidence: representative.evidence,
      catalogStatus: representative.catalogStatus,
      family: representative.family,
      releaseDate: representative.releaseDate,
      zeroCost: representative.zeroCost,
      eligibilityBasis: representative.eligibilityBasis,
      freeTier,
      selected: false,
    });
  }

  // Rank: keyed providers first (ok → unknown, then the order in which each
  // provider first appears in the catalogue), then the free-tier candidate;
  // 'dead' never selectable. Provider order deliberately still follows the
  // listing: only the choice of model WITHIN a provider is order-invariant.
  const tierOf = (c: DiscoveredCandidate): number => {
    if (c.evidence === 'dead') return Number.MAX_SAFE_INTEGER;
    return (c.freeTier ? 2 : 0) + (c.evidence === 'ok' ? 0 : 1);
  };
  const ranked = candidates
    .map((candidate, providerOrder) => ({ candidate, providerOrder }))
    .sort((a, b) => tierOf(a.candidate) - tierOf(b.candidate) || a.providerOrder - b.providerOrder)
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
