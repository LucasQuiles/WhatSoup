/**
 * Unit matrix for the pure route-resolution core (PR-plan v2 slice 2, B1).
 *
 * Contract under test — precedence, strict-pin semantics:
 *   1. active fallback window: health selects the provider; an exact verified,
 *      credentialed model pin may refine only that provider's model
 *   2. strict pin: eligible → pinned provider; ineligible → pin_blocked_default
 *      (NEVER the pinned provider via another route — zero silent-fallback paths)
 *   3. tier-mapped intent (strongest/fastest) via instance-config tier map;
 *      unconfigured tiers resolve to the default route HONESTLY (distinct source)
 *   4. default
 * Capability boundaries (safe_read_only etc.) are NOT this function's job —
 * intent classes it cannot map must leave the provider unchanged.
 */
import { describe, it, expect } from 'vitest';
import {
  applyRouteEffort,
  isPinnedModelEligible,
  resolveRoute,
  type RouteInputs,
} from '../../../src/runtimes/agent/route-resolution.ts';
import type { ChatModelPreference } from '../../../src/runtimes/agent/chat-preference-db.ts';
import { nativeReasoningControl } from '../../../src/runtimes/agent/reasoning-control.ts';
import { PROVIDER_IDS } from '../../../src/runtimes/agent/providers/index.ts';

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
    pinnedModelEligible: false,
    tierMap: null,
    tierProviderEligible: false,
    // Empty by default: no test relies on a threaded model unless it opts in
    // via override — keeps every existing exact-`toEqual` assertion (e.g.
    // codex-cli pin → model: undefined) unaffected.
    configuredModelByProvider: {},
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

  it('keeps provider failover authoritative while honoring a verified eligible model pin on that provider', () => {
    const d = resolveRoute(inputs({
      fallbackEntry: { provider: 'opencode-cli', model: 'kimi/kimi-k3' },
      pref: pref({
        intent: 'provider_specific',
        requestedProvider: 'opencode-cli',
        requestedModel: 'glm/glm-5.2',
        validatedProvider: 'opencode-cli',
        modelPinVerified: true,
      }),
      pinnedProviderEligible: true,
      pinnedModelEligible: true,
    }));
    expect(d).toEqual({
      provider: 'opencode-cli',
      model: 'glm/glm-5.2',
      source: 'fallback',
      reasonCode: 'fallback_window_active_model_pin',
    });
  });

  it.each<[string, Partial<ChatModelPreference>, boolean]>([
    ['uncredentialed model', {}, false],
    ['unverified model', { modelPinVerified: false }, true],
    ['different provider', { requestedProvider: 'codex-cli', validatedProvider: 'codex-cli' }, true],
  ])('does not let a %s displace the selected fallback model', (_label, prefChanges, pinnedModelEligible) => {
    const d = resolveRoute(inputs({
      fallbackEntry: { provider: 'opencode-cli', model: 'kimi/kimi-k3' },
      pref: pref({
        intent: 'provider_specific',
        requestedProvider: 'opencode-cli',
        requestedModel: 'glm/glm-5.2',
        validatedProvider: 'opencode-cli',
        modelPinVerified: true,
        ...prefChanges,
      }),
      pinnedProviderEligible: true,
      pinnedModelEligible,
    }));
    expect(d).toEqual({
      provider: 'opencode-cli',
      model: 'kimi/kimi-k3',
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
      effort: null,
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

  // ── EXECPROFILE-CI-FIX Finding 2 (PLAN.md §5b) ────────────────────────────
  // opencode-cli (and the managed API providers) cannot resolve their own
  // default model — buildChildEnv hard-throws on a null model for them. The
  // config validator already guarantees a static fallback/tier entry naming
  // one of these providers carries a model; these branches must THREAD that
  // validated model through instead of discarding it to `undefined` the way
  // a genuine claude-cli/codex-cli/gemini-cli provider change correctly does
  // (contrast with the codex-cli case directly above, which stays undefined).

  it('an eligible pin to a credential-required provider (opencode-cli) threads its configured model (Finding 2 — pin)', () => {
    const d = resolveRoute(inputs({
      pref: pref({ intent: 'provider_specific', requestedProvider: 'opencode-cli' }),
      pinnedProviderEligible: true,
      configuredModelByProvider: { 'opencode-cli': 'glm/test-model' },
    }));
    expect(d.provider).toBe('opencode-cli');
    expect(d.model).toBe('glm/test-model');
    expect(d.source).toBe('preference');
    expect(d.reasonCode).toBe('user_pin');
  });

  it('an eligible pin to a credential-required provider with NO configured model fails closed to undefined (defensive — should not happen post-validation)', () => {
    const d = resolveRoute(inputs({
      pref: pref({ intent: 'provider_specific', requestedProvider: 'opencode-cli' }),
      pinnedProviderEligible: true,
      configuredModelByProvider: {},
    }));
    expect(d).toEqual({
      provider: 'opencode-cli',
      model: undefined,
      source: 'preference',
      reasonCode: 'user_pin',
      effort: null,
    });
  });

  it('an eligible tier route to a credential-required provider (opencode-cli) threads its configured model (Finding 2 — tier)', () => {
    const d = resolveRoute(inputs({
      pref: pref({ intent: 'fastest' }),
      tierMap: { fastest: 'opencode-cli' },
      tierProviderEligible: true,
      configuredModelByProvider: { 'opencode-cli': 'glm/test-model' },
    }));
    expect(d.provider).toBe('opencode-cli');
    expect(d.model).toBe('glm/test-model');
    expect(d.source).toBe('preference');
    expect(d.reasonCode).toBe('intent_fastest');
  });

  it('a tier that maps back to the instance primary keeps the operator-configured model even when the primary is credential-required', () => {
    // Guards the symmetry between the pin and tier branches: an opencode-cli
    // PRIMARY pinned/tier-routed to ITSELF must take the same
    // primary-keeps-its-own-model path as claude-cli/codex-cli/gemini-cli —
    // not fall through to the (empty, since it's the primary, not a fallback
    // entry) configuredModelByProvider lookup and go null.
    const d = resolveRoute(inputs({
      agentProvider: 'opencode-cli',
      effectiveModel: 'glm/primary-model',
      pref: pref({ intent: 'strongest' }),
      tierMap: { strongest: 'opencode-cli' },
      tierProviderEligible: true,
      configuredModelByProvider: {},
    }));
    expect(d.provider).toBe('opencode-cli');
    expect(d.model).toBe('glm/primary-model');
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

describe('isPinnedModelEligible', () => {
  const verifiedPin = pref({
    intent: 'provider_specific',
    requestedProvider: 'opencode-cli',
    requestedModel: 'glm/glm-5.2',
    validatedProvider: 'opencode-cli',
    modelPinVerified: true,
  });
  const entries = [
    { provider: 'opencode-cli', model: 'kimi/kimi-k3' },
    { provider: 'opencode-cli', model: 'glm/glm-5.2' },
  ];

  it('requires the exact configured entry to be credentialed', () => {
    const checked: string[] = [];
    expect(isPinnedModelEligible(verifiedPin, entries, (entry) => {
      checked.push(entry.model ?? '');
      return entry.model === 'glm/glm-5.2';
    })).toBe(true);
    expect(checked).toEqual(['glm/glm-5.2']);
  });

  it.each([
    ['missing exact model', verifiedPin, entries.slice(0, 1), true],
    ['missing credential', verifiedPin, entries, false],
    ['unverified pin', { ...verifiedPin, modelPinVerified: false }, entries, true],
    ['provider mismatch', { ...verifiedPin, validatedProvider: 'codex-cli' }, entries, true],
  ])('rejects %s', (_label, candidate, configured, credentialed) => {
    expect(isPinnedModelEligible(candidate, configured, () => credentialed)).toBe(false);
  });
});

describe('Slice 3 — reasoning-effort on the route', () => {
  it('an eligible claude-cli model pin carries its requestedEffort as route.effort', () => {
    const d = resolveRoute(inputs({
      pref: pref({ intent: 'provider_specific', requestedProvider: 'claude-cli', requestedEffort: 'high' }),
      pinnedProviderEligible: true,
    }));
    expect(d.source).toBe('preference');
    expect(d.effort).toBe('high');
  });

  it('a pin with no effort override sets route.effort=null (not undefined)', () => {
    const d = resolveRoute(inputs({
      pref: pref({ intent: 'provider_specific', requestedProvider: 'claude-cli' }),
      pinnedProviderEligible: true,
    }));
    expect(d.effort).toBeNull();
    // Terminal behavior assertion for the "not undefined" half of the claim: the
    // KEY is present and explicitly null (an absent key would also satisfy
    // toBeNull via undefined-ish reads, so assert presence concretely).
    expect(Object.prototype.hasOwnProperty.call(d, 'effort')).toBe(true);
  });

  it('the default route (no pin) carries no effort', () => {
    expect(resolveRoute(inputs()).effort).toBeUndefined();
  });

  describe('applyRouteEffort', () => {
    it('overrides claude-cli providerConfig.effort with a non-empty pin effort (base not mutated)', () => {
      const base = { effort: 'low', permissionMode: 'default' };
      const out = applyRouteEffort(base, { provider: 'claude-cli', effort: 'xhigh' });
      expect(out).toEqual({ effort: 'xhigh', permissionMode: 'default' });
      expect(base.effort).toBe('low'); // pure — original untouched
    });

    it('leaves a non-claude provider untouched (opencode ignores --effort)', () => {
      const base = { baseUrl: 'x' };
      expect(applyRouteEffort(base, { provider: 'opencode-cli', effort: 'high' })).toBe(base);
    });

    it('a null/absent effort keeps the base static effort (no override — hybrid semantics)', () => {
      const base = { effort: 'medium' };
      expect(applyRouteEffort(base, { provider: 'claude-cli', effort: null })).toBe(base);
      expect(applyRouteEffort(base, { provider: 'claude-cli' })).toBe(base);
    });

    it('undefined base + a pin effort yields a config carrying just the effort', () => {
      expect(applyRouteEffort(undefined, { provider: 'claude-cli', effort: 'high' })).toEqual({ effort: 'high' });
    });

    // Drift pin (not a claude-cli restatement): the provider set that OPENS a
    // Level-3 effort menu must be EXACTLY the set whose spawn config accepts an
    // effort. Asserted across every provider id, because the divergence that
    // matters is silent and user-visible in the worst direction — offer levels,
    // persist the pick, echo "high reasoning", then drop the value before spawn.
    // This is what makes Phase-2's second effort provider one edit, not two.
    it('menu capability and spawn application agree for every provider id', () => {
      for (const provider of PROVIDER_IDS) {
        const offersEffortMenu = nativeReasoningControl(provider, 'any-model') !== null;
        const appliesEffortAtSpawn = applyRouteEffort({}, { provider, effort: 'high' })?.['effort'] === 'high';
        expect(appliesEffortAtSpawn, `provider ${provider}`).toBe(offersEffortMenu);
      }
    });
  });
});
