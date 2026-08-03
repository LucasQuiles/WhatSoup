// src/runtimes/agent/providers/index.ts
// Provider ID registry — single source of truth for the supported provider
// identifiers. See issue #447: prior to this module, each consumer site
// (validator, session.ts switches, console catalog) hardcoded its own copy
// of the ID list. A typo in config silently aliased to Claude semantics
// because the validator only checked for a non-empty string and the session
// switches used a `default:` fall-through.
//
// Add a new provider:
//   1. Append the canonical ID to src/lib/provider-ids.json (kebab-case,
//      transport-suffixed) AND to the ProviderIdTuple type below — the
//      registry test pins the two in lockstep.
//   2. Add display name in src/runtimes/agent/session.ts PROVIDER_DISPLAY_NAMES.
//   3. Add a case in the three switches in session.ts (getProviderBinary,
//      getProviderArgs, getParser) — TypeScript will surface any miss via
//      the assertNever pattern at the throw site.
//   4. Add display metadata in console/src/lib/providers.ts (PROVIDER_META) —
//      the ID list itself is shared via src/lib/provider-ids.json, so the console
//      picks up the new ID automatically.
//   5. Add an impl file (parser or API client) here under providers/.
//   6. Add the brand grouping in providers/provider-brand.ts BRAND_PROVIDER_ORDER
//      (which brand it belongs under, and its OAuth/CLI-before-API order) —
//      the registry test pins every ID to a brand, so a miss fails there; an
//      unmapped provider would silently vanish from the `/model` drill Level-1.

import type { ExecutionMode } from './types.ts';
export { isProviderId } from '../../../lib/provider-ids.ts';

export { PROVIDER_IDS, isProviderId, type ProviderId } from '../../../lib/provider-ids.ts';
export type ProviderMcpMode = 'stdio_proxy' | 'none';

/** Default provider when none is specified in config. */
export const DEFAULT_PROVIDER_ID: ProviderId = 'claude-cli';

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

/** Exhaustive WhatSoup MCP exposure decision for every supported provider. */
export function mcpModeForProvider(provider: ProviderId): ProviderMcpMode {
  switch (provider) {
    case 'claude-cli':
    case 'codex-cli':
    case 'gemini-cli':
    case 'opencode-cli':
      return 'stdio_proxy';
    case 'openai-api':
    case 'anthropic-api':
      return 'none';
    default:
      return assertNeverProvider(provider, 'providers:mcpModeForProvider');
  }
}

/** True when a known provider launches the WhatSoup stdio MCP proxy. */
export function providerUsesWhatSoupMcp(provider: unknown): provider is ProviderId {
  return isProviderId(provider) && mcpModeForProvider(provider) === 'stdio_proxy';
}

/** Canonical eligibility policy for actor-bound per-chat MCP transport. */
export function requiresPerChatActorSocket(
  provider: unknown,
  sessionScope: string,
  sandboxPerChat: boolean,
): provider is ProviderId {
  return (
    sessionScope === 'per_chat'
    && !sandboxPerChat
    && providerUsesWhatSoupMcp(provider)
  );
}
