/**
 * Unit matrix for the pure route-resolution core (PR-plan v2 slice 2, B1).
 *
 * Contract under test — precedence, strict-pin semantics:
 *   1. active fallback window: health beats preference, visibly (source records it)
 *   2. strict pin: eligible → pinned provider; ineligible → pin_blocked_default
 *      (NEVER the pinned provider via another route — zero silent-fallback paths)
 *   3. tier-mapped intent (strongest/fastest) via instance-config tier map;
 *      unconfigured tiers resolve to the default route HONESTLY (distinct source)
 *   4. default
 * Capability boundaries (safe_read_only etc.) are NOT this function's job —
 * intent classes it cannot map must leave the provider unchanged.
 */
import { describe, it, expect } from 'vitest';
import { resolveRoute, type RouteInputs } from '../../../src/runtimes/agent/route-resolution.ts';
import type { ChatModelPreference } from '../../../src/runtimes/agent/chat-preference-db.ts';

function pref(overrides: Partial<ChatModelPreference> = {}): ChatModelPreference {
  return {
    chatJid: '15550000001@s.whatsapp.net',
    senderJid: '15550000002@s.whatsapp.net',
    intent: 'strongest',
    requestedProvider: null,
    scope: 'this_thread',
    pinStrict: true,
    fallbackPermitted: false,
    updatedAt: 1_000,
    expiresAt: 2_000,
    requestedModel: null,
    validatedProvider: null,
    modelPinVerified: null,
    ...overrides,
  };
}

function inputs(overrides: Partial<RouteInputs> = {}): RouteInputs {
  return {
    agentProvider: 'claude-cli',
    effectiveModel: 'opus-4-8',
    fallbackEntry: null,
    pref: null,
    pinnedProviderEligible: false,
    tierMap: null,
    tierProviderEligible: false,
    ...overrides,
  };
}

describe('resolveRoute precedence', () => {
  it('no preference → default provider and model', () => {
    expect(resolveRoute(inputs())).toEqual({
      provider: 'claude-cli',
      model: 'opus-4-8',
      source: 'default',
      reasonCode: 'no_preference',
    });
  });

  it('active fallback window beats everything, including an eligible pin', () => {
    const d = resolveRoute(inputs({
      fallbackEntry: { provider: 'opencode-cli', model: 'glm-4.7' },
      pref: pref({ intent: 'provider_specific', requestedProvider: 'codex-cli' }),
      pinnedProviderEligible: true,
    }));
    expect(d).toEqual({
      provider: 'opencode-cli',
      model: 'glm-4.7',
      source: 'fallback',
      reasonCode: 'fallback_window_active',
    });
  });

  it('fallback entry without a model falls back to effectiveModel', () => {
    const d = resolveRoute(inputs({ fallbackEntry: { provider: 'opencode-cli' } }));
    expect(d.model).toBe('opus-4-8');
    expect(d.source).toBe('fallback');
  });

  it('eligible strict pin routes to the pinned provider (provider default model)', () => {
    const d = resolveRoute(inputs({
      pref: pref({ intent: 'provider_specific', requestedProvider: 'codex-cli' }),
      pinnedProviderEligible: true,
    }));
    expect(d).toEqual({
      provider: 'codex-cli',
      model: undefined,
      source: 'preference',
      reasonCode: 'user_pin',
    });
  });

  it('ineligible strict pin NEVER silently impersonates — default route, distinct source', () => {
    const d = resolveRoute(inputs({
      pref: pref({ intent: 'provider_specific', requestedProvider: 'codex-cli' }),
      pinnedProviderEligible: false,
    }));
    expect(d.provider).toBe('claude-cli');
    expect(d.provider).not.toBe('codex-cli');
    expect(d.source).toBe('pin_blocked_default');
    expect(d.reasonCode).toBe('user_pin_unreachable');
  });

  it('strongest with a configured tier routes to the tier provider', () => {
    const d = resolveRoute(inputs({
      pref: pref({ intent: 'strongest' }),
      tierMap: { strongest: 'anthropic-api' },
      tierProviderEligible: true,
    }));
    expect(d).toEqual({
      provider: 'anthropic-api',
      model: undefined,
      source: 'preference',
      reasonCode: 'intent_strongest',
    });
  });

  it('fastest with a configured tier routes to the tier provider', () => {
    const d = resolveRoute(inputs({
      pref: pref({ intent: 'fastest' }),
      tierMap: { strongest: 'anthropic-api', fastest: 'opencode-cli' },
      tierProviderEligible: true,
    }));
    expect(d.provider).toBe('opencode-cli');
    expect(d.reasonCode).toBe('intent_fastest');
  });

  it('a configured tier whose provider is NOT routable degrades to the default route honestly (R5)', () => {
    // The tier IS configured, but the instance cannot route to that provider
    // (no credential / not in the fallback chain). Strict-degrade doctrine:
    // never spawn a keyless session — fall back to the default route visibly.
    const d = resolveRoute(inputs({
      pref: pref({ intent: 'strongest' }),
      tierMap: { strongest: 'anthropic-api' },
      tierProviderEligible: false,
    }));
    expect(d.provider).toBe('claude-cli');
    expect(d.provider).not.toBe('anthropic-api');
    expect(d.model).toBe('opus-4-8');
    expect(d.source).toBe('tier_unconfigured_default');
    expect(d.reasonCode).toBe('intent_strongest_unreachable');
  });

  it('an eligible pin to the instance PRIMARY keeps the operator-configured model (R3)', () => {
    // Pinning your own primary must not discard agentOptions.model — only a
    // genuine provider change drops to the provider-default model.
    const d = resolveRoute(inputs({
      pref: pref({ intent: 'provider_specific', requestedProvider: 'claude-cli' }),
      pinnedProviderEligible: true,
    }));
    expect(d.provider).toBe('claude-cli');
    expect(d.model).toBe('opus-4-8');
    expect(d.source).toBe('preference');
    expect(d.reasonCode).toBe('user_pin');
  });

  it('an eligible pin to a DIFFERENT provider still drops to the provider-default model (R3)', () => {
    const d = resolveRoute(inputs({
      pref: pref({ intent: 'provider_specific', requestedProvider: 'codex-cli' }),
      pinnedProviderEligible: true,
    }));
    expect(d.provider).toBe('codex-cli');
    expect(d.model).toBeUndefined();
    expect(d.source).toBe('preference');
    expect(d.reasonCode).toBe('user_pin');
  });

  it('an unconfigured tier resolves to the default route with an HONEST distinct source', () => {
    const d = resolveRoute(inputs({ pref: pref({ intent: 'strongest' }) }));
    expect(d.provider).toBe('claude-cli');
    expect(d.model).toBe('opus-4-8');
    expect(d.source).toBe('tier_unconfigured_default');
    expect(d.reasonCode).toBe('intent_strongest_unmapped');
  });

  it('capability-class intents (safe_read_only) never change the provider here', () => {
    const d = resolveRoute(inputs({ pref: pref({ intent: 'safe_read_only' }) }));
    expect(d.provider).toBe('claude-cli');
    expect(d.source).toBe('tier_unconfigured_default');
    expect(d.reasonCode).toBe('intent_safe_read_only_unmapped');
  });

  it('a provider_specific pref with a null provider (out-of-contract) is treated as unmapped, not a pin', () => {
    const d = resolveRoute(inputs({
      pref: pref({ intent: 'provider_specific', requestedProvider: null }),
      pinnedProviderEligible: true,
    }));
    expect(d.provider).toBe('claude-cli');
    expect(d.source).toBe('tier_unconfigured_default');
  });
});
