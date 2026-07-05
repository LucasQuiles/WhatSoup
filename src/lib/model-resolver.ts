/**
 * Symbolic model resolution — grammar and selection logic for dynamic
 * model-role values.
 *
 * A model-role config value (`models.conversation|extraction|validation|
 * fallback`) is one of:
 *   1. A literal ID (`gpt-5.4`, `claude-opus-4-8`) — pinned, exact
 *      passthrough. The default; fully backward compatible.
 *   2. `<vendor>:<family>:latest-stable` — newest STABLE model in the
 *      vendor+family line: current/legacy catalog entries plus live-served
 *      IDs, excluding pre-release markers (-preview, -beta, …), dated
 *      snapshots (normalized to their base ID), and variant product lines
 *      (-codex, -mini).
 *   3. `<vendor>:<family>:latest` — newest served ID in the line, INCLUDING
 *      pre-release markers. Variant product lines stay excluded: `-codex`
 *      / `-mini` are different products, not newer builds of the family.
 *
 * The family segment may be omitted (`openai:latest-stable`) and defaults to
 * the vendor's flagship chat line (openai→gpt, anthropic→opus). Unknown
 * vendors/families are a config-load error — never a silent passthrough —
 * so typos cannot masquerade as literal model IDs.
 *
 * This module is intentionally pure/synchronous (catalog-only) so
 * `config.ts` can validate values at load without touching the network.
 * The async, live-list-backed entry point is `resolveModelRole` in
 * model-advisor.ts, which owns the shared live-ID cache.
 */
import {
  MODEL_CATALOG,
  latestInFamily,
  parseModelId,
  type ParsedModel,
} from './model-catalog.ts';

export type SymbolicVendor = ParsedModel['vendor'];

export interface SymbolicModelSpec {
  vendor: SymbolicVendor;
  family: string;
  /** true for `latest-stable`, false for `latest`. */
  stable: boolean;
  /** The raw configured value, for logging. */
  raw: string;
}

const SYMBOLIC_VENDORS: ReadonlySet<string> = new Set(['anthropic', 'openai']);

const VENDOR_FLAGSHIP_FAMILY: Record<SymbolicVendor, string> = {
  openai: 'gpt',
  anthropic: 'opus',
};

// Families we can resolve for a vendor, derived from the static catalog so a
// new family only needs a catalog entry. A family absent here would have no
// offline fallback, so it is rejected at config load.
let knownFamiliesCache: Map<SymbolicVendor, Set<string>> | null = null;

function knownFamilies(vendor: SymbolicVendor): Set<string> {
  if (!knownFamiliesCache) {
    knownFamiliesCache = new Map();
    for (const entry of MODEL_CATALOG) {
      const parsed = parseModelId(entry.id);
      if (!parsed) continue;
      let families = knownFamiliesCache.get(parsed.vendor);
      if (!families) {
        families = new Set();
        knownFamiliesCache.set(parsed.vendor, families);
      }
      families.add(parsed.family);
    }
  }
  return knownFamiliesCache.get(vendor) ?? new Set();
}

/**
 * Parse a model-role value against the symbolic grammar.
 *
 * Returns null for literal IDs (no resolution needed). Throws for values
 * that claim the grammar but are malformed: a value claims the grammar when
 * its first `:`-segment is a symbolic vendor OR its last segment is
 * `latest`/`latest-stable`. This deliberately claims colon-tagged literals
 * like `llama3:latest` — an unresolvable vendor there is far more likely a
 * typo of this grammar than a supported literal, and silently passing it
 * through would mask the typo (see docs/configuration.md).
 */
export function parseSymbolicModel(value: string): SymbolicModelSpec | null {
  const trimmed = value.trim();
  if (!trimmed.includes(':')) return null;

  const segments = trimmed.toLowerCase().split(':');
  const mode = segments[segments.length - 1];
  const claimsGrammar = SYMBOLIC_VENDORS.has(segments[0]) || mode === 'latest' || mode === 'latest-stable';
  if (!claimsGrammar) return null;

  if (mode !== 'latest' && mode !== 'latest-stable') {
    throw new Error(
      `invalid symbolic model "${value}" — expected <vendor>[:<family>]:latest or <vendor>[:<family>]:latest-stable`,
    );
  }
  if (segments.length < 2 || segments.length > 3 || segments.some((s) => s === '')) {
    throw new Error(
      `invalid symbolic model "${value}" — expected <vendor>[:<family>]:${mode}`,
    );
  }
  const vendor = segments[0];
  if (!SYMBOLIC_VENDORS.has(vendor)) {
    throw new Error(
      `unknown vendor "${vendor}" in symbolic model "${value}" — supported vendors: ${[...SYMBOLIC_VENDORS].join(', ')}`,
    );
  }
  const typedVendor = vendor as SymbolicVendor;
  const family = segments.length === 3 ? segments[1] : VENDOR_FLAGSHIP_FAMILY[typedVendor];
  const families = knownFamilies(typedVendor);
  if (!families.has(family)) {
    throw new Error(
      `unknown ${vendor} family "${family}" in symbolic model "${value}" — known families: ${[...families].sort().join(', ')}`,
    );
  }
  return { vendor: typedVendor, family, stable: mode === 'latest-stable', raw: trimmed };
}

/**
 * Validate a model-role config value at load time. Literal IDs and
 * well-formed symbolic values pass through unchanged; malformed symbolic
 * values throw with the role name attached. Called synchronously from
 * config.ts — no network, no resolution.
 */
export function validateModelRoleValue(value: string, role: string): string {
  try {
    parseSymbolicModel(value);
  } catch (err) {
    throw new Error(`models.${role}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return value;
}

/**
 * Resolve a symbolic spec against a set of served model IDs (plus the
 * static catalog, via latestInFamily). Returns null when nothing in the
 * family matched — callers fall back to resolveSymbolicFromCatalog.
 */
export function resolveSymbolicFromIds(
  spec: SymbolicModelSpec,
  liveIds: readonly string[],
): string | null {
  const seed: ParsedModel = { vendor: spec.vendor, family: spec.family, version: -1, normalized: '' };
  return latestInFamily(seed, liveIds, { stable: spec.stable })?.normalized ?? null;
}

/**
 * Offline/degraded fallback: the newest `current` catalog entry in the
 * family, else the newest entry of any status. Null only for families with
 * no catalog presence — which parseSymbolicModel rejects, so callers can
 * treat null as "keep the raw value" without ever throwing at runtime.
 */
export function resolveSymbolicFromCatalog(spec: SymbolicModelSpec): string | null {
  let bestCurrent: { id: string; version: number } | null = null;
  let bestAny: { id: string; version: number } | null = null;
  for (const entry of MODEL_CATALOG) {
    const parsed = parseModelId(entry.id);
    if (!parsed || parsed.vendor !== spec.vendor || parsed.family !== spec.family) continue;
    if (entry.status === 'current' && (!bestCurrent || parsed.version > bestCurrent.version)) {
      bestCurrent = { id: entry.id, version: parsed.version };
    }
    if (!bestAny || parsed.version > bestAny.version) {
      bestAny = { id: entry.id, version: parsed.version };
    }
  }
  return (bestCurrent ?? bestAny)?.id ?? null;
}
