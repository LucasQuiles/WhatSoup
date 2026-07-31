// Provider ID registry shared by core, runtimes, fleet, and the console.
//
// The JSON file is the runtime source of truth. The literal tuple exists only
// because TypeScript widens JSON imports to string[], and registry tests pin
// the two representations together.
import providerIdsJson from './provider-ids.json' with { type: 'json' };

type ProviderIdTuple = readonly [
  'claude-cli',
  'codex-cli',
  'gemini-cli',
  'opencode-cli',
  'openai-api',
  'anthropic-api',
];

/** Canonical ordered list of supported provider IDs. */
export const PROVIDER_IDS: ProviderIdTuple = Object.freeze(
  providerIdsJson,
) as ProviderIdTuple;

/** Discriminated union derived from the canonical provider ID list. */
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** Narrows an unknown value to one of the canonical provider IDs. */
export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
}
