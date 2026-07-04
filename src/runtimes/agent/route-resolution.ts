import type { ChatModelPreference } from './chat-preference-db.ts';

/**
 * Pure route-resolution core (owner-approved PR-plan v2, slice 2).
 *
 * Decides which provider/model REASONS for the next session. Capability-
 * preserved routing: this decision never carries tool, mutation, or
 * authority state — the capability gate is a separate layer.
 *
 * Precedence (each level visible via `source`/`reasonCode`, never silent):
 *   1. active fallback window — health beats preference
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
  /** Instance-config intent→provider map; null = unconfigured. */
  tierMap: { strongest?: string; fastest?: string } | null;
  /** Instance-routable probe result for the tier provider this pref maps to
   *  (same F07 probe as the pin). A configured tier whose provider is not
   *  routable must degrade to the default route, never spawn a keyless
   *  session — the strict-pin doctrine applies to tier intents too. */
  tierProviderEligible: boolean;
}

export interface RouteDecision {
  provider: string;
  model: string | undefined;
  source: 'default' | 'preference' | 'fallback' | 'pin_blocked_default' | 'tier_unconfigured_default';
  /** Machine-readable; feeds ModelRouteEvent and the /why receipt. */
  reasonCode: string;
}

export function resolveRoute(i: RouteInputs): RouteDecision {
  if (i.fallbackEntry) {
    return {
      provider: i.fallbackEntry.provider,
      model: i.fallbackEntry.model ?? i.effectiveModel,
      source: 'fallback',
      reasonCode: 'fallback_window_active',
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
        // model; only a genuine provider change drops to the provider default.
        model: i.pref.requestedProvider === i.agentProvider ? i.effectiveModel : undefined,
        source: 'preference',
        reasonCode: 'user_pin',
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
        model: undefined,
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
