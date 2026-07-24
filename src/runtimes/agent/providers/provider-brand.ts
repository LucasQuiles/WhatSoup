// Brand grouping for the `/model` drill-down Level-1: one entry per brand,
// resolved to the concrete provider to route to. Pure, standalone — no I/O,
// no runtime wiring. See docs/... drill-down design (T1 of the increment).

/** Brand is an OPEN string label (the fleet may add providers) — not a closed union. */
export type Brand = string;

/**
 * Per-brand access-path preference order, OAuth/CLI path before API path
 * (OAuth-default rule): within a brand, prefer the OAuth/CLI provider over
 * the API provider when both are routable. The SINGLE source of truth for the
 * brand↔provider relationship — `PROVIDER_BRAND` below is derived from it, so a
 * new provider is added in exactly ONE place (no hand-synced inverse to drift).
 */
const BRAND_PROVIDER_ORDER: Readonly<Record<Brand, readonly string[]>> = Object.freeze({
  Claude: ['claude-cli', 'anthropic-api'],
  OpenAI: ['openai-api'],
  OpenCode: ['opencode-cli'],
  Codex: ['codex-cli'],
  Gemini: ['gemini-cli'],
});

/** provider-id -> brand, DERIVED (inverted) from BRAND_PROVIDER_ORDER at module
 *  load. Any id not in the order -> null via brandOf, never throws. */
const PROVIDER_BRAND: Readonly<Record<string, Brand>> = Object.freeze(
  Object.fromEntries(
    Object.entries(BRAND_PROVIDER_ORDER).flatMap(([brand, ids]) =>
      ids.map((id) => [id, brand] as const),
    ),
  ),
);

/** Brand for a provider id, or null if the id is unknown. Never throws. */
export function brandOf(providerId: string): Brand | null {
  return PROVIDER_BRAND[providerId] ?? null;
}

/**
 * Provider id to route to for `brand`, picking the first entry of the
 * brand's preference order that is present in `routable`. Returns null for
 * an unknown brand or when nothing in the order is routable.
 */
export function resolveBrandProvider(brand: Brand, routable: readonly string[]): string | null {
  const order = BRAND_PROVIDER_ORDER[brand];
  if (!order) return null;
  return order.find((id) => routable.includes(id)) ?? null;
}

/**
 * One `{ brand, provider }` entry per brand present in `descriptors`, in
 * first-seen order. `provider` is resolved against the full set of
 * descriptor ids (not just the ids seen so far), so a later-preferred id
 * (e.g. `claude-cli`) wins even if a lower-preference sibling
 * (`anthropic-api`) appears first. A branded provider whose brand fails to
 * resolve (shouldn't happen for ids drawn from `descriptors` itself) is
 * skipped rather than dropping the whole call.
 */
export function listBrands(descriptors: readonly { id: string }[]): { brand: Brand; provider: string }[] {
  const allIds = descriptors.map((d) => d.id);
  const seen = new Set<Brand>();
  const result: { brand: Brand; provider: string }[] = [];
  for (const d of descriptors) {
    const brand = brandOf(d.id);
    if (brand === null || seen.has(brand)) continue;
    seen.add(brand);
    const provider = resolveBrandProvider(brand, allIds);
    if (provider === null) continue;
    result.push({ brand, provider });
  }
  return result;
}
