// src/runtimes/agent/model-catalogue-resolver.ts
//
// Per-harness source resolver for the `/config model` available-models section
// (CONFIG-MODEL-RENDER-SPEC.md; Q rulings 2026-07-19/20). Produces the
// AvailableModelsListing the formatter renders — the harness's OWN catalogue
// source, never a static/stale stand-in:
//   - opencode-cli            → `<binary> models` (cached, capture-stamped, shape-checked),
//   - claude-cli              → anthropic /v1/models ORG catalogue (classified failures),
//   - openai / openai-api     → openai /v1/models, keyed (Task B; both provider
//                               strings route here — see resolveModelCatalogue),
//   - codex-cli / gemini-cli  → no confirmed `<binary> models`-shaped listing
//                               surface exists today (verified 2026-07-20 —
//                               see resolveCodex/resolveGemini) → always
//                               no-adapter; no cache/fn plumbing until a real
//                               surface is confirmed (see the seam comment on
//                               each resolver),
//   - anything else           → no-adapter (named harness).
//
// Two DRY invariants Q pressed on (each mapping lives in exactly ONE place, so
// no second call site can translate the same signal into a different reason):
//   - the vendor fetch-failure CATEGORY comes from model-advisor's shared
//     classifier; categoryToReason is the sole category→render-reason map;
//   - probeReasonToReason is the sole opencode-probe-reason→render-reason map.

import { listModelCatalog, type ModelCatalogUnavailableReason } from './providers/binary-preflight.ts';
import {
  fetchAnthropicModelIdsWithStatus,
  fetchOpenAIModelIdsWithStatus,
  type ModelFetchFailureCategory,
  type OpenAIModelsResult,
} from '../../lib/model-advisor.ts';
import type { AvailableModelsListing, UnavailableReason } from './owner-render-format.ts';

/** How long a captured opencode catalogue stays fresh. A cache is what keeps the
 *  in-thread render off a live `<binary> models` spawn per turn (Q 2b#1/#3). */
const OPENCODE_CACHE_TTL_MS = 60_000;
/** Same TTL discipline for the openai adapter (Task B) — one constant per
 *  source so a tune to one harness never silently retunes another. codex-cli /
 *  gemini-cli have no cache: both are always no-adapter in production today
 *  (see the seam comment on resolveCodex/resolveGemini below). */
const OPENAI_CACHE_TTL_MS = 60_000;

interface CacheEntry {
  ids: string[];
  capturedAtMs: number;
}

const opencodeCache = new Map<string, CacheEntry>();
// openai is keyed (HTTP, no per-binary variance) — a single entry, not a Map.
let openaiCache: CacheEntry | null = null;

/** Test-only: clear every per-harness catalogue cache between cases. */
export function __resetModelCatalogueCacheForTest(): void {
  opencodeCache.clear();
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

/** SOLE opencode-probe-reason → render-reason map. */
function probeReasonToReason(reason: ModelCatalogUnavailableReason): UnavailableReason {
  switch (reason) {
    case 'timeout':
      return { kind: 'timeout' };
    case 'spawn-error':
      return { kind: 'probe-failed' };
    case 'empty':
      return { kind: 'empty' };
  }
}

export interface CatalogueResolveDeps {
  /** Current time in ms (injected so the cache + as-of are deterministic in tests). */
  nowMs: number;
  /** Injectable for tests; defaults to the real per-harness probes. */
  listFn?: typeof listModelCatalog;
  anthropicFn?: typeof fetchAnthropicModelIdsWithStatus;
  /** openai adapter (keyed, HTTP `/v1/models`). */
  openaiFn?: typeof fetchOpenAIModelIdsWithStatus;
  // codex-cli / gemini-cli have no dep slot: no confirmed `<binary> models`-
  // shaped listing surface exists for either (verified 2026-07-20, see the
  // seam comment on resolveCodex/resolveGemini below), so both are always
  // design-time no-adapter. Add a fn slot here (mirroring openaiFn/listFn)
  // when a real surface is confirmed.
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
  const cached = opencodeCache.get(binary);

  // Fresh cache → serve without spawning (capture-stamped as-of).
  if (cached && deps.nowMs - cached.capturedAtMs < OPENCODE_CACHE_TTL_MS) {
    return { status: 'ok', ids: cached.ids, sourceLabel: 'opencode CLI', asOfLabel: formatCaptureAsOf(cached.capturedAtMs, deps.nowMs) };
  }

  const result = await listFn(binary);
  if (result.status === 'ok' && looksLikeModelIds(result.ids)) {
    opencodeCache.set(binary, { ids: [...result.ids], capturedAtMs: deps.nowMs });
    return { status: 'ok', ids: result.ids, sourceLabel: 'opencode CLI', asOfLabel: 'just now' };
  }

  // Re-probe failed (or output looked unparseable). If we have any prior capture,
  // serve it STALE with a disclosed age rather than blank the catalogue on a
  // transient failure (Q 2b#1: staleness said out loud, not silent).
  if (cached) {
    return { status: 'ok', ids: cached.ids, sourceLabel: 'opencode CLI', asOfLabel: formatCaptureAsOf(cached.capturedAtMs, deps.nowMs) };
  }

  const reason: UnavailableReason =
    result.status === 'unavailable' ? probeReasonToReason(result.reason) : { kind: 'unparseable' };
  return { status: 'unavailable', reason, asOfLabel: 'just now' };
}

async function resolveClaude(deps: CatalogueResolveDeps): Promise<AvailableModelsListing> {
  const anthropicFn = deps.anthropicFn ?? fetchAnthropicModelIdsWithStatus;
  const result = await anthropicFn();
  if (result.status === 'no-key') {
    return { status: 'unavailable', reason: { kind: 'no-key' }, asOfLabel: 'just now' };
  }
  if (result.status === 'credential-expired') {
    return { status: 'unavailable', reason: { kind: 'credential-expired' }, asOfLabel: 'just now' };
  }
  if (result.status === 'failed') {
    return { status: 'unavailable', reason: categoryToReason(result.category), asOfLabel: 'just now' };
  }
  // The org catalogue — labeled as its source, NOT "what this harness can run".
  return { status: 'ok', ids: result.ids, sourceLabel: 'anthropic /v1/models (org catalogue)', asOfLabel: 'just now' };
}

/**
 * openai adapter (keyed, HTTP `/v1/models`) — Task B. Same cache + stale-serve
 * discipline as resolveOpencode: a fresh capture serves without a network call,
 * and a transient re-probe failure (including a THROWN fetch, never assumed
 * total from an injected fn) serves the last-known-good list stale rather than
 * blanking the catalogue, with the age disclosed rather than hidden.
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
 * VERIFIED 2026-07-20 (live host probe, not assumed): `codex --help`'s
 * top-level Commands list has no `models` entry, and `codex models` (no TTY)
 * exits with "stdin is not a terminal" — the string is parsed as the
 * `[PROMPT]` positional and forwarded to the interactive CLI, not read as a
 * subcommand. There is no `<binary> models`-shaped listing surface today.
 * Spawning it for real would therefore capture the codex binary's chat-prompt
 * error output as if it were a model catalogue, and an empty/failed capture
 * would render `empty` or `probe-failed` — both of which claim "we asked and
 * got nothing/broke", when the true state is "this was never wired". That is
 * exactly the misreport the brief calls out: DESIGN-TIME no-adapter is the
 * honest default here (Q 2b), not a runtime probe that can't tell the
 * difference — and since no call site ever supplies a codex fn, that's the
 * ONLY reachable behavior, so this stays a lean early return rather than
 * carrying cache/stale-serve plumbing nothing exercises.
 *
 * SEAM: if a confirmed `codex models`-shaped listing surface is ever wired,
 * add an adapter here shaped like {@link resolveOpenai} — an injectable fn on
 * `CatalogueResolveDeps` plus its own capture-stamped TTL cache — rather than
 * reviving this dead plumbing wholesale.
 */
async function resolveCodex(_binary: string, _deps: CatalogueResolveDeps): Promise<AvailableModelsListing> {
  return { status: 'unavailable', reason: { kind: 'no-adapter', harness: 'codex-cli' }, asOfLabel: 'just now' };
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
