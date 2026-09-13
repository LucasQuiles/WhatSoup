// src/runtimes/agent/model-catalogue-resolver.ts
//
// Per-harness source resolver for the `/config model` available-models section
// (CONFIG-MODEL-RENDER-SPEC.md; Q rulings 2026-07-19/20). Produces the
// AvailableModelsListing the formatter renders — the harness's OWN catalogue
// source, never a static/stale stand-in:
//   - opencode-cli            → refreshed verbose catalogue, explicitly
//                               labeled cache/legacy degradation, then a
//                               short-lived resolver cache for render traffic,
//   - claude-cli              → anthropic /v1/models with the CLI OAuth identity,
//   - anthropic-api           → anthropic /v1/models with the managed API-key identity,
//   - openai / openai-api     → openai /v1/models, keyed (Task B; both provider
//                               strings route here — see resolveModelCatalogue),
//   - codex-cli               → native `debug models` runtime catalogue,
//                               labeled with its undisclosed upstream age,
//   - gemini-cli              → no confirmed standalone listing surface,
//   - anything else           → no-adapter (named harness).
//
// Two DRY invariants Q pressed on (each mapping lives in exactly ONE place, so
// no second call site can translate the same signal into a different reason):
//   - the vendor fetch-failure CATEGORY comes from model-advisor's shared
//     classifier; categoryToReason is the sole category→render-reason map;
//   - probeReasonToReason is the sole CLI-probe-reason→render-reason map.

import {
  listCodexModelCatalog,
  listModelCatalog,
  type ModelCatalogUnavailableReason,
} from './providers/binary-preflight.ts';
import {
  fetchAnthropicApiModelIdsWithStatus,
  fetchAnthropicModelIdsWithStatus,
  fetchOpenAIModelIdsWithStatus,
  type AnthropicModelsResult,
  type ModelFetchFailureCategory,
  type OpenAIModelsResult,
} from '../../lib/model-advisor.ts';
import type { AvailableModelsListing, UnavailableReason } from './owner-render-format.ts';

/** How long a resolved OpenCode catalogue stays fresh for command rendering.
 *  This is distinct from the CLI's models.dev cache: it keeps repeated renders
 *  off a child-process spawn, while listModelCatalog records whether its own
 *  upstream refresh succeeded or degraded. */
const OPENCODE_CACHE_TTL_MS = 60_000;
/** The native Codex command has its own opaque cache; this cache only avoids
 * repeatedly spawning the command while preserving a capture timestamp. */
const CODEX_CACHE_TTL_MS = 60_000;
/** Same TTL discipline for the openai adapter (Task B) — one constant per
 *  source so a tune to one harness never silently retunes another. */
const OPENAI_CACHE_TTL_MS = 60_000;

interface CacheEntry {
  ids: string[];
  capturedAtMs: number;
}

const opencodeCache = new Map<string, CacheEntry>();
const codexCache = new Map<string, CacheEntry>();
// openai is keyed (HTTP, no per-binary variance) — a single entry, not a Map.
let openaiCache: CacheEntry | null = null;

/** Test-only: clear every per-harness catalogue cache between cases. */
export function __resetModelCatalogueCacheForTest(): void {
  opencodeCache.clear();
  codexCache.clear();
  openaiCache = null;
}

/**
 * Humanize a capture age for the as-of label (Q 2b#1: the stamp is CAPTURE time,
 * and a cache old enough to matter must say so). Fresh cache reads render "just
 * now"; a stale entry served after a failed re-probe renders its true age.
 */
export function formatCaptureAsOf(capturedAtMs: number, nowMs: number): string {
  const ageMs = Math.max(0, nowMs - capturedAtMs);
  const mins = Math.floor(ageMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago (stale)`;
}

/** A model id from `<binary> models` has no whitespace; a line with a space is
 *  the tell of an output-shape change (prose/table regression) — surface it as
 *  `unparseable` (pointing at the parser) rather than as garbage ids (Q 2b). */
function looksLikeModelIds(ids: readonly string[]): boolean {
  return ids.every((id) => !/\s/.test(id));
}

/** SOLE vendor-category → render-reason map (Q 2b: one place, no drift). */
function categoryToReason(category: ModelFetchFailureCategory): UnavailableReason {
  switch (category) {
    case 'unauthorized':
      return { kind: 'key-rejected' };
    case 'timeout':
      return { kind: 'timeout' };
    case 'lookup-failed':
      return { kind: 'lookup-failed' };
  }
}

/** SOLE CLI-probe-reason → render-reason map. */
function probeReasonToReason(reason: ModelCatalogUnavailableReason): UnavailableReason {
  switch (reason) {
    case 'timeout':
      return { kind: 'timeout' };
    case 'spawn-error':
    case 'command-error':
      return { kind: 'probe-failed' };
    case 'empty':
      return { kind: 'empty' };
    case 'unparseable':
    case 'output-limit':
      return { kind: 'unparseable' };
  }
}

export interface CatalogueResolveDeps {
  /** Current time in ms (injected so the cache + as-of are deterministic in tests). */
  nowMs: number;
  /** Injectable for tests; defaults to the real per-harness probes. */
  listFn?: typeof listModelCatalog;
  codexFn?: typeof listCodexModelCatalog;
  anthropicFn?: typeof fetchAnthropicModelIdsWithStatus;
  anthropicApiFn?: typeof fetchAnthropicApiModelIdsWithStatus;
  /** openai adapter (keyed, HTTP `/v1/models`). */
  openaiFn?: typeof fetchOpenAIModelIdsWithStatus;
  // gemini-cli has no dep slot until a confirmed standalone source exists.
}

/**
 * Resolve the dynamic per-harness available-models listing. Never throws — the
 * openai path additionally wraps its (possibly injected, not-guaranteed-total)
 * fetch in a try/catch so a rejection fails open like every other adapter here.
 * `binary` is the resolved harness binary for the opencode/codex/gemini paths;
 * `provider` selects the source.
 */
export async function resolveModelCatalogue(
  provider: string,
  binary: string,
  deps: CatalogueResolveDeps,
): Promise<AvailableModelsListing> {
  if (provider === 'opencode-cli') return resolveOpencode(binary, deps);
  if (provider === 'claude-cli') return resolveClaude(deps);
  if (provider === 'anthropic-api') return resolveAnthropicApi(deps);
  // Both strings route to the same adapter: 'openai' is the harness id the
  // formatter/tests use, 'openai-api' is the actual provider-ids.json id the
  // live call site (runtime.ts `this.agentProvider`) passes — matching only
  // one would leave the adapter unreachable from either the tests or prod.
  if (provider === 'openai' || provider === 'openai-api') return resolveOpenai(deps);
  if (provider === 'codex-cli') return resolveCodex(binary, deps);
  if (provider === 'gemini-cli') return resolveGemini(binary, deps);
  return { status: 'unavailable', reason: { kind: 'no-adapter', harness: provider }, asOfLabel: 'just now' };
}

async function resolveOpencode(binary: string, deps: CatalogueResolveDeps): Promise<AvailableModelsListing> {
  const listFn = deps.listFn ?? listModelCatalog;
  return resolveCachedCliCatalogue(
    binary,
    deps,
    listFn,
    opencodeCache,
    OPENCODE_CACHE_TTL_MS,
    'opencode CLI',
  );
}

/** Shared capture-cache policy for native CLI catalogues. Parsing and command
 * selection stay in the harness adapters; freshness, stale serve, and reason
 * mapping stay canonical here. */
async function resolveCachedCliCatalogue(
  binary: string,
  deps: CatalogueResolveDeps,
  listFn: typeof listModelCatalog,
  cache: Map<string, CacheEntry>,
  ttlMs: number,
  sourceLabel: string,
): Promise<AvailableModelsListing> {
  const cached = cache.get(binary);

  // Fresh cache → serve without spawning (capture-stamped as-of).
  if (cached && deps.nowMs - cached.capturedAtMs < ttlMs) {
    return { status: 'ok', ids: cached.ids, sourceLabel, asOfLabel: formatCaptureAsOf(cached.capturedAtMs, deps.nowMs) };
  }

  const result = await listFn(binary);
  if (result.status === 'ok' && looksLikeModelIds(result.ids)) {
    cache.set(binary, { ids: [...result.ids], capturedAtMs: deps.nowMs });
    return { status: 'ok', ids: result.ids, sourceLabel, asOfLabel: 'just now' };
  }

  // Re-probe failed (or output looked unparseable). If we have any prior capture,
  // serve it STALE with a disclosed age rather than blank the catalogue on a
  // transient failure (Q 2b#1: staleness said out loud, not silent).
  if (cached) {
    return { status: 'ok', ids: cached.ids, sourceLabel, asOfLabel: formatCaptureAsOf(cached.capturedAtMs, deps.nowMs) };
  }

  const reason: UnavailableReason =
    result.status === 'unavailable' ? probeReasonToReason(result.reason) : { kind: 'unparseable' };
  return { status: 'unavailable', reason, asOfLabel: 'just now' };
}

async function resolveClaude(deps: CatalogueResolveDeps): Promise<AvailableModelsListing> {
  const anthropicFn = deps.anthropicFn ?? fetchAnthropicModelIdsWithStatus;
  return resolveAnthropicResult(await anthropicFn());
}

async function resolveAnthropicApi(deps: CatalogueResolveDeps): Promise<AvailableModelsListing> {
  const anthropicApiFn = deps.anthropicApiFn ?? fetchAnthropicApiModelIdsWithStatus;
  return resolveAnthropicResult(await anthropicApiFn());
}

function resolveAnthropicResult(result: AnthropicModelsResult): AvailableModelsListing {
  if (result.status === 'no-key') {
    return { status: 'unavailable', reason: { kind: 'no-key' }, asOfLabel: 'just now' };
  }
  if (result.status === 'credential-expired') {
    return { status: 'unavailable', reason: { kind: 'credential-expired' }, asOfLabel: 'just now' };
  }
  if (result.status === 'failed') {
    return { status: 'unavailable', reason: categoryToReason(result.category), asOfLabel: 'just now' };
  }
  // An HTTP-200 with an EMPTY body is untrustworthy, not "this org has zero
  // models" — normalize to unavailable/empty (matches resolveOpencode's own
  // empty handling) rather than ok+ids:[], which downstream (the drill
  // Level-2 render, and verifyModelPinAgainstCatalogue's pin re-validation)
  // reads as a real, queried, empty catalogue: the drill would render a
  // blank menu instead of degrading, and the pin re-validation would map it
  // to {available:true, ids:[]} and silently drop a just-verified pin. No
  // cache exists on this path (unlike resolveOpenai below), so there is no
  // stale-serve interaction to preserve here.
  if (result.ids.length === 0) {
    return { status: 'unavailable', reason: { kind: 'empty' }, asOfLabel: 'just now' };
  }
  // The org catalogue — labeled as its source, NOT "what this harness can run".
  return { status: 'ok', ids: result.ids, sourceLabel: 'anthropic /v1/models (org catalogue)', asOfLabel: 'just now' };
}

/**
 * openai adapter (keyed, HTTP `/v1/models`) — Task B. Same cache + stale-serve
 * discipline as resolveOpencode: a fresh capture serves without a network call,
 * and a transient re-probe failure (including a THROWN fetch, never assumed
 * total from an injected fn) serves the last-known-good list stale rather than
 * blanking the catalogue, with the age disclosed rather than hidden. An
 * HTTP-200-but-EMPTY response is treated the same way: it never overwrites the
 * cache and never wins over a stale non-empty last-known-good serve — it only
 * becomes unavailable/empty when there is no prior capture to fall back on.
 */
async function resolveOpenai(deps: CatalogueResolveDeps): Promise<AvailableModelsListing> {
  const openaiFn = deps.openaiFn ?? fetchOpenAIModelIdsWithStatus;
  const sourceLabel = 'openai /v1/models';
  const cached = openaiCache;

  if (cached && deps.nowMs - cached.capturedAtMs < OPENAI_CACHE_TTL_MS) {
    return { status: 'ok', ids: cached.ids, sourceLabel, asOfLabel: formatCaptureAsOf(cached.capturedAtMs, deps.nowMs) };
  }

  let result: OpenAIModelsResult;
  try {
    result = await openaiFn();
  } catch {
    // An injected (or future real) fetch that rejects is a transient failure
    // like any classified one below — NEVER let it escape as a thrown error.
    result = { status: 'failed', category: 'lookup-failed' };
  }

  if (result.status === 'ok') {
    // An HTTP-200 with an EMPTY body is untrustworthy, not "this org has zero
    // models" — treat it exactly like a transient failure for cache purposes:
    // never let it overwrite `openaiCache`, and prefer serving the stale
    // last-known-good list (age disclosed, same as the 'failed' branch below)
    // over blanking the catalogue. Only when there is no prior capture to
    // fall back on does it become unavailable/empty. This mirrors
    // resolveOpencode's own empty handling and keeps an empty fresh capture
    // from clobbering a non-empty last-known-good serve.
    if (result.ids.length === 0) {
      if (cached) {
        return { status: 'ok', ids: cached.ids, sourceLabel, asOfLabel: formatCaptureAsOf(cached.capturedAtMs, deps.nowMs) };
      }
      return { status: 'unavailable', reason: { kind: 'empty' }, asOfLabel: 'just now' };
    }
    openaiCache = { ids: [...result.ids], capturedAtMs: deps.nowMs };
    return { status: 'ok', ids: result.ids, sourceLabel, asOfLabel: 'just now' };
  }

  // 'no-key' is a STRUCTURAL absence (no credential exists at all), not a
  // transient failure — it answers immediately without consulting the cache,
  // same as resolveClaude's 'no-key' branch above. A key that resolved a
  // minute ago and is now absent is a real state change, not noise to paper
  // over with a stale list (Q 2b: structural reasons don't stale-serve).
  if (result.status === 'no-key') {
    return { status: 'unavailable', reason: { kind: 'no-key' }, asOfLabel: 'just now' };
  }

  // Re-probe failed transiently ('failed' category, including a caught throw
  // mapped to 'lookup-failed' above). Serve a stale cache with disclosed age
  // rather than blank the catalogue on a transient failure (Q 2b#1).
  if (cached) {
    return { status: 'ok', ids: cached.ids, sourceLabel, asOfLabel: formatCaptureAsOf(cached.capturedAtMs, deps.nowMs) };
  }

  return { status: 'unavailable', reason: categoryToReason(result.category), asOfLabel: 'just now' };
}

/**
 * codex-cli adapter — Task B.
 *
 * Codex gained a native JSON catalogue after the 2026-07-20 no-adapter
 * decision. `debug models` uses the installed binary's online-if-uncached
 * policy, but its JSON omits cache age/source and upstream suppresses refresh
 * errors. The source label therefore identifies the runtime capture while
 * explicitly leaving upstream freshness unknown.
 */
async function resolveCodex(binary: string, deps: CatalogueResolveDeps): Promise<AvailableModelsListing> {
  const listFn = deps.codexFn ?? listCodexModelCatalog;
  return resolveCachedCliCatalogue(
    binary,
    deps,
    listFn,
    codexCache,
    CODEX_CACHE_TTL_MS,
    'codex CLI runtime catalogue (upstream freshness unreported)',
  );
}

/**
 * gemini-cli adapter — Task B.
 *
 * Reason-evidence (Q 2026-07-20, carried from old Slice 3) — the obligation is
 * to document WHY a displayed list would be trustworthy; here that means
 * documenting why NONE is displayed by default. `gemini` is not installed on
 * this host, so the interactive CLI itself could not be probed directly, but
 * the official docs (geminicli.com/docs/cli/commands, google-gemini/gemini-cli
 * on GitHub) show model selection as an IN-SESSION `/model manage|set` slash
 * command inside a live ACP conversation (confirmed by this repo's own
 * `gemini-acp-parser.ts`, which drives `gemini --acp` over JSON-RPC and has no
 * models-list method) — there is no standalone `gemini models`-shaped listing
 * surface analogous to opencode's. Fabricating a spawn attempt at a subcommand
 * with no confirmed existence would render `empty`/`probe-failed` for a
 * command that was never real (the same misreport risk as codex-cli above) —
 * this is stronger than "assume it works", it is a deliberate NON-claim. Since
 * no call site ever supplies a gemini fn, that non-claim is the ONLY reachable
 * behavior, so this stays a lean early return rather than carrying cache/
 * stale-serve plumbing nothing exercises.
 *
 * SEAM: if a real listing surface is later confirmed (e.g. a session-scoped
 * query wired through the ACP session `gemini-acp-parser.ts` already parses),
 * add an adapter here shaped like {@link resolveOpenai} — an injectable fn on
 * `CatalogueResolveDeps` plus its own capture-stamped TTL cache, staleness
 * disclosed rather than hidden (Q 2b#1) — rather than reviving this dead
 * plumbing wholesale. The trustworthiness argument then: gemini-cli is a
 * `native` audience harness (provider-credential-eligibility.ts) — validity is
 * proven at spawn/session start, not by a key q holds — so a captured list
 * from a live session is live evidence, not a guess.
 */
async function resolveGemini(_binary: string, _deps: CatalogueResolveDeps): Promise<AvailableModelsListing> {
  return { status: 'unavailable', reason: { kind: 'no-adapter', harness: 'gemini-cli' }, asOfLabel: 'just now' };
}
