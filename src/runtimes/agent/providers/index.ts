// src/runtimes/agent/providers/index.ts
// Provider ID registry — single source of truth for the supported provider
// identifiers. See issue #447: prior to this module, each consumer site
// (validator, session.ts switches, console catalog) hardcoded its own copy
// of the ID list. A typo in config silently aliased to Claude semantics
// because the validator only checked for a non-empty string and the session
// switches used a `default:` fall-through.
//
// Add a new provider:
//   1. Append the canonical ID below (kebab-case, transport-suffixed).
//   2. Add display name in src/runtimes/agent/session.ts PROVIDER_DISPLAY_NAMES.
//   3. Add a case in the three switches in session.ts (getProviderBinary,
//      getProviderArgs, getParser) — TypeScript will surface any miss via
//      the assertNever pattern at the throw site.
//   4. Mirror the entry in console/src/lib/providers.ts (PROVIDERS).
//   5. Add an impl file (parser or API client) here under providers/.

/**
 * Canonical, ordered list of supported provider IDs. Frozen at module load
 * so accidental mutation throws in strict mode. Treat as a closed set — if
 * a new provider is needed, add it here and update the consumers listed
 * above (the conformance test in tests/runtimes/agent/providers/registry.test.ts
 * pins the relationship to impl files).
 */
export const PROVIDER_IDS = Object.freeze([
  'claude-cli',
  'codex-cli',
  'gemini-cli',
  'opencode-cli',
  'openai-api',
  'anthropic-api',
] as const);

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
