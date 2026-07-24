// src/runtimes/agent/providers/index.ts
// Provider ID registry — single source of truth for the supported provider
// identifiers. See issue #447: prior to this module, each consumer site
// (validator, session.ts switches, console catalog) hardcoded its own copy
// of the ID list. A typo in config silently aliased to Claude semantics
// because the validator only checked for a non-empty string and the session
// switches used a `default:` fall-through.
//
// Add a new provider:
//   1. Append the canonical ID to provider-ids.json (kebab-case,
//      transport-suffixed) AND to the ProviderIdTuple type below — the
//      registry test pins the two in lockstep.
//   2. Add display name in src/runtimes/agent/session.ts PROVIDER_DISPLAY_NAMES.
//   3. Add a case in the three switches in session.ts (getProviderBinary,
//      getProviderArgs, getParser) — TypeScript will surface any miss via
//      the assertNever pattern at the throw site.
//   4. Add display metadata in console/src/lib/providers.ts (PROVIDER_META) —
//      the ID list itself is shared via provider-ids.json, so the console
//      picks up the new ID automatically.
//   5. Add an impl file (parser or API client) here under providers/.
//   6. Add the brand grouping in providers/provider-brand.ts BRAND_PROVIDER_ORDER
//      (which brand it belongs under, and its OAuth/CLI-before-API order) —
//      the registry test pins every ID to a brand, so a miss fails there; an
//      unmapped provider would silently vanish from the `/model` drill Level-1.

import providerIdsJson from './provider-ids.json' with { type: 'json' };
import type { ExecutionMode } from './types.ts';

/**
 * Literal tuple type of the canonical provider IDs. TypeScript widens JSON
 * imports to `string[]`, so the literal types live here while the runtime
 * values live in provider-ids.json (the single source shared with the
 * console). tests/runtimes/agent/providers/registry.test.ts pins the JSON
 * values to this tuple, so the two cannot drift silently.
 */
type ProviderIdTuple = readonly [
  'claude-cli',
  'codex-cli',
  'gemini-cli',
  'opencode-cli',
  'openai-api',
  'anthropic-api',
];

/**
 * Canonical, ordered list of supported provider IDs, loaded from
 * provider-ids.json (shared with the console catalog). Frozen at module load
 * so accidental mutation throws in strict mode. Treat as a closed set — if
 * a new provider is needed, follow the steps listed above (the conformance
 * test in tests/runtimes/agent/providers/registry.test.ts pins the
 * relationship to impl files).
 */
export const PROVIDER_IDS: ProviderIdTuple = Object.freeze(
  providerIdsJson,
) as ProviderIdTuple;

/** Discriminated-union of supported provider IDs derived from {@link PROVIDER_IDS}. */
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** Default provider when none is specified in config. */
export const DEFAULT_PROVIDER_ID: ProviderId = 'claude-cli';

/**
 * Type guard: narrows an unknown value to {@link ProviderId} iff it is one
 * of the canonical IDs. Case-sensitive — operators must use the exact ID.
 */
export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * Exhaustiveness helper for `switch` statements over {@link ProviderId}.
 * Use at the end of a switch instead of a silent `default:` branch so that
 * adding a new provider ID surfaces a compile error at every consumer site.
 */
export function assertNeverProvider(value: never, context: string): never {
  throw new Error(
    `[${context}] unknown provider id: ${JSON.stringify(value)}. ` +
      `Valid: ${PROVIDER_IDS.join(', ')}.`,
  );
}

/** Canonical process-lifecycle model for each provider. */
export function executionModeForProvider(provider: ProviderId): ExecutionMode {
  switch (provider) {
    case 'claude-cli':
    case 'codex-cli':
    case 'gemini-cli':
      return 'persistent_session';
    case 'opencode-cli':
      return 'spawn_per_turn';
    case 'openai-api':
    case 'anthropic-api':
      return 'managed_loop';
    default:
      return assertNeverProvider(provider, 'providers:executionModeForProvider');
  }
}
