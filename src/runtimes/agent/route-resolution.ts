import type { ChatModelPreference } from './chat-preference-db.ts';
import { providerConfigEffort, providerHasNativeReasoningControl } from './reasoning-control.ts';
import {
  FALLBACK_MODEL_REQUIRED_PROVIDER_IDS,
  type AgentFallbackEntry,
} from '../../core/fallback-chain.ts';

/**
 * Pure route-resolution core (owner-approved PR-plan v2, slice 2).
 *
 * Decides which provider/model REASONS for the next session. Capability-
 * preserved routing: this decision never carries tool, mutation, or
 * authority state — the capability gate is a separate layer.
 *
 * Precedence (each level visible via `source`/`reasonCode`, never silent):
 *   1. active fallback window — health chooses the provider; a verified,
 *      credentialed model pin may refine only that same provider's model
 *   2. strict user pin — eligible routes to the pin; ineligible NEVER
 *      impersonates it (pin_blocked_default; zero silent-fallback paths)
 *   3. tier-mapped intent (strongest/fastest) via the instance-config tier
 *      map; unconfigured tiers resolve to the default route honestly
 *   4. configured default
 */

export interface RouteInputs {
  agentProvider: string;
  effectiveModel: string | undefined;
  /** Active-window fallback entry only (null when no window is armed). */
  fallbackEntry: { provider: string; model?: string } | null;
  /** Canonical-keyed, unexpired preference (or null). */
  pref: ChatModelPreference | null;
  /** Instance-routable probe result for the pinned provider (F07 semantics). */
  pinnedProviderEligible: boolean;
  /** Exact configured model entry exists and its credential is available. */
  pinnedModelEligible: boolean;
  /** Instance-config intent→provider map; null = unconfigured. */
  tierMap: { strongest?: string; fastest?: string } | null;
  /** Instance-routable probe result for the tier provider this pref maps to
   *  (same F07 probe as the pin). A configured tier whose provider is not
   *  routable must degrade to the default route, never spawn a keyless
   *  session — the strict-pin doctrine applies to tier intents too. */
  tierProviderEligible: boolean;
  /**
   * Provider id → that provider's validated config model (from the
   * instance's `agentFallbacks` entries — the same array
   * `isEntryCredentialed`/`routablePinTargets` already read to PROVE a
   * pin/tier target eligible). `undefined` for a provider with no matching
   * entry, or an entry that carries no model.
   *
   * EXECPROFILE-CI-FIX Finding 2: a route to a provider in
   * FALLBACK_MODEL_REQUIRED_PROVIDER_IDS (opencode-cli, the managed API
   * providers) MUST carry a model — those providers have no provider-owned
   * default and buildChildEnv hard-throws on null. Config admission already
   * guarantees a static fallback/tier-target entry naming one of these
   * providers has a model; this map is how resolveRoute reaches it instead
   * of discarding it to `undefined`.
   */
  configuredModelByProvider: Readonly<Record<string, string | undefined>>;
}

/**
 * The model a route to `provider` should carry when it is NOT the instance's
 * own primary (which keeps `effectiveModel` unconditionally — see both call
 * sites below). Only providers that cannot resolve their own default model
 * (FALLBACK_MODEL_REQUIRED_PROVIDER_IDS) get the config's validated model
 * threaded through; claude-cli/codex-cli/gemini-cli resolve their own
 * default with no `-m` flag, so `undefined` stays correct for them.
 *
 * Defensive/fail-closed: if a required-model provider has no entry in
 * `configuredModelByProvider` (shouldn't happen — config-validator enforces
 * a model on every such entry at admission), this returns `undefined` same
 * as today, so the existing buildChildEnv null-model guard still hard-fails
 * the spawn rather than silently forwarding a wrong/absent credential.
 */
function targetModel(provider: string, configuredModelByProvider: Readonly<Record<string, string | undefined>>): string | undefined {
  return FALLBACK_MODEL_REQUIRED_PROVIDER_IDS.has(provider) ? configuredModelByProvider[provider] : undefined;
}

export interface RouteDecision {
  provider: string;
  model: string | undefined;
  source: 'default' | 'preference' | 'fallback' | 'pin_blocked_default' | 'tier_unconfigured_default';
  /** Machine-readable; feeds ModelRouteEvent and the /why receipt. */
  reasonCode: string;
  /**
   * Slice 3: the per-chat reasoning-effort override to carry to spawn (only a
   * user model pin sets it; undefined on every other route). Consumed by
   * {@link applyRouteEffort} → providerConfig.effort → claude-cli `--effort`.
   * A cross-provider pin leaves it null (only claude-cli consumes effort).
   */
  effort?: string | null;
}

export function resolveRoute(i: RouteInputs): RouteDecision {
  if (i.fallbackEntry) {
    const pinnedModel = i.pref?.intent === 'provider_specific' &&
      i.pref.requestedProvider === i.fallbackEntry.provider &&
      i.pref.validatedProvider === i.fallbackEntry.provider &&
      i.pref.modelPinVerified === true && i.pinnedModelEligible
      ? i.pref.requestedModel
      : null;
    return {
      provider: i.fallbackEntry.provider,
      model: pinnedModel ?? i.fallbackEntry.model ?? i.effectiveModel,
      source: 'fallback',
      reasonCode: pinnedModel ? 'fallback_window_active_model_pin' : 'fallback_window_active',
    };
  }
  if (!i.pref) {
    return {
      provider: i.agentProvider,
      model: i.effectiveModel,
      source: 'default',
      reasonCode: 'no_preference',
    };
  }
  if (i.pref.intent === 'provider_specific' && i.pref.requestedProvider) {
    if (i.pinnedProviderEligible) {
      return {
        provider: i.pref.requestedProvider,
        // Pinning the instance's own primary keeps the operator-configured
        // model; a genuine provider change drops to the provider default —
        // UNLESS the target can't resolve one itself (opencode-cli et al.),
        // in which case its own validated config model is threaded through,
        // avoiding the null buildChildEnv otherwise hard-throws on (Finding 2).
        model: i.pref.requestedProvider === i.agentProvider
          ? i.effectiveModel
          : targetModel(i.pref.requestedProvider, i.configuredModelByProvider),
        source: 'preference',
        reasonCode: 'user_pin',
        // Slice 3: carry the pin's reasoning-effort override. Meaningful only
        // for claude-cli (the sole `--effort` consumer); requestedEffort is
        // null for a cross-provider pin, so this is null there too.
        effort: i.pref.requestedEffort ?? null,
      };
    }
    return {
      provider: i.agentProvider,
      model: i.effectiveModel,
      source: 'pin_blocked_default',
      reasonCode: 'user_pin_unreachable',
    };
  }
  const tier =
    i.pref.intent === 'strongest' ? i.tierMap?.strongest
    : i.pref.intent === 'fastest' ? i.tierMap?.fastest
    : undefined;
  if (tier) {
    if (i.tierProviderEligible) {
      return {
        provider: tier,
        // Same rule as the pin branch above: a tier that (unusually) maps
        // back to the instance's own primary keeps the operator-configured
        // model; a tier pointing at a required-model provider (opencode-cli
        // et al.) threads that provider's validated config model instead of
        // discarding it (Finding 2) — every other tier target keeps
        // `undefined` and resolves its own provider default.
        model: tier === i.agentProvider ? i.effectiveModel : targetModel(tier, i.configuredModelByProvider),
        source: 'preference',
        reasonCode: `intent_${i.pref.intent}`,
      };
    }
    // Tier IS configured but its provider is not routable on this instance —
    // degrade to the default route honestly (never a keyless session). The
    // distinct reasonCode lets /why tell "unreachable" from "unconfigured".
    return {
      provider: i.agentProvider,
      model: i.effectiveModel,
      source: 'tier_unconfigured_default',
      reasonCode: `intent_${i.pref.intent}_unreachable`,
    };
  }
  return {
    provider: i.agentProvider,
    model: i.effectiveModel,
    source: 'tier_unconfigured_default',
    reasonCode: `intent_${i.pref.intent}_unmapped`,
  };
}

/**
 * Slice 3 — thread a route's reasoning-effort override into the provider
 * config the session spawns with. Only a provider with native reasoning control
 * consumes an effort flag (claude-cli's `--effort`, read by session.ts
 * resolveProviderArgs); every other provider ignores it, so the base is
 * returned untouched. The provider set is NOT re-tested here — it is read from
 * reasoning-control.ts, the same predicate the Level-3 menu gates on. That
 * removes one of two duplicate encodings, not all of them: writing the key here
 * does not mean the child receives a flag, which is session.ts's per-provider
 * argv switch (see providerHasNativeReasoningControl for the remaining gap).
 *
 * A per-chat effort PIN (a non-empty `route.effort`) OVERRIDES the static
 * `providerConfig.effort` for that spawn. A route with no effort override
 * (undefined, or the FW-7 "Default (no override)" pick = null) keeps whatever
 * the base config carries — matching the hybrid's semantics: a null/absent
 * effort is "no override", not "force the harness default over a configured
 * static effort". Pure; never mutates `base`.
 */
export function applyRouteEffort(
  base: Record<string, unknown> | undefined,
  route: Pick<RouteDecision, 'provider' | 'effort'>,
): Record<string, unknown> | undefined {
  if (!providerHasNativeReasoningControl(route.provider)) return base;
  // Validate the WRITE through the same reader the spawn path reads with, so the
  // guard is symmetric by construction. It also keeps the safe direction: a
  // malformed (non-string) effort yields null and returns `base` untouched,
  // rather than clobbering a valid operator-configured static effort with
  // garbage that the reader would then report as absent.
  const level = providerConfigEffort({ effort: route.effort });
  return level ? { ...(base ?? {}), effort: level } : base;
}

export function isPinnedModelEligible(
  pref: ChatModelPreference | null,
  entries: readonly AgentFallbackEntry[],
  isCredentialed: (entry: AgentFallbackEntry) => boolean,
): boolean {
  if (!pref?.requestedProvider || !pref.requestedModel || pref.modelPinVerified !== true ||
      pref.validatedProvider !== pref.requestedProvider) return false;
  const entry = entries.find((candidate) =>
    candidate.provider === pref.requestedProvider && candidate.model === pref.requestedModel);
  return entry !== undefined && isCredentialed(entry);
}
