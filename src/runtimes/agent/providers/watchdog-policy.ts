/**
 * Per-provider hard-watchdog timeout resolution.
 *
 * Each {@link ProviderDescriptor} declares `defaultWatchdog.hardMs`, but `armWatchdog`
 * historically hardcoded the 30-min module constant for EVERY provider — so API providers
 * (anthropic-api / openai-api), whose descriptors declare a 10-min hard timeout, were
 * silently given 30 min (L1-F1). This table restores the descriptors' intent.
 *
 * It is deliberately dependency-free (literal data, no provider-module imports) to avoid a
 * `session.ts` ⇄ provider-module import cycle (`claude.ts` imports from `session.ts`). The
 * companion test `tests/runtimes/agent/providers/watchdog-policy.test.ts` asserts every entry
 * here equals the corresponding descriptor's `defaultWatchdog.hardMs`, so the table cannot
 * drift from the SSOT.
 */

/** Default hard-watchdog timeout (ms) — 30 min — for providers that do not override it. */
export const DEFAULT_WATCHDOG_HARD_MS = 1_800_000;

/**
 * Providers whose descriptor declares a hard-watchdog timeout that DEVIATES from the
 * 30-min default. Mirrors `<provider>Descriptor.defaultWatchdog.hardMs`.
 */
export const WATCHDOG_HARD_MS_BY_PROVIDER: Readonly<Record<string, number>> = Object.freeze({
  'anthropic-api': 600_000, // 10 min — anthropicApiDescriptor.defaultWatchdog.hardMs
  'openai-api': 600_000, //   10 min — openaiApiDescriptor.defaultWatchdog.hardMs
});

/** Resolve the hard-watchdog timeout (ms) for a provider id, honoring its descriptor. */
export function watchdogHardMsForProvider(provider: string): number {
  return WATCHDOG_HARD_MS_BY_PROVIDER[provider] ?? DEFAULT_WATCHDOG_HARD_MS;
}
