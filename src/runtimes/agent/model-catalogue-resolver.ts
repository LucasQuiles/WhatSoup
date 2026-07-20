// src/runtimes/agent/model-catalogue-resolver.ts
//
// Per-harness source resolver for the `/config model` available-models section
// (CONFIG-MODEL-RENDER-SPEC.md; Q rulings 2026-07-19/20). Produces the
// AvailableModelsListing the formatter renders — the harness's OWN catalogue
// source, never a static/stale stand-in:
//   - opencode-cli → `<binary> models` (cached, capture-stamped, shape-checked),
//   - claude-cli   → anthropic /v1/models ORG catalogue (classified failures),
//   - anything else → no-adapter (named harness).
//
// Two DRY invariants Q pressed on (each mapping lives in exactly ONE place, so
// no second call site can translate the same signal into a different reason):
//   - the vendor fetch-failure CATEGORY comes from model-advisor's shared
//     classifier; categoryToReason is the sole category→render-reason map;
//   - probeReasonToReason is the sole opencode-probe-reason→render-reason map.

import { listModelCatalog, type ModelCatalogUnavailableReason } from './providers/binary-preflight.ts';
import {
  fetchAnthropicModelIdsWithStatus,
  type ModelFetchFailureCategory,
} from '../../lib/model-advisor.ts';
import type { AvailableModelsListing, UnavailableReason } from './owner-render-format.ts';

/** How long a captured opencode catalogue stays fresh. A cache is what keeps the
 *  in-thread render off a live `<binary> models` spawn per turn (Q 2b#1/#3). */
const OPENCODE_CACHE_TTL_MS = 60_000;

interface CacheEntry {
  ids: string[];
  capturedAtMs: number;
}

const opencodeCache = new Map<string, CacheEntry>();

/** Test-only: clear the opencode catalogue cache between cases. */
export function __resetModelCatalogueCacheForTest(): void {
  opencodeCache.clear();
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
}

/**
 * Resolve the dynamic per-harness available-models listing. Never throws (both
 * underlying probes are total). `binary` is the resolved harness binary for the
 * opencode path; `provider` selects the source.
 */
export async function resolveModelCatalogue(
  provider: string,
  binary: string,
  deps: CatalogueResolveDeps,
): Promise<AvailableModelsListing> {
  if (provider === 'opencode-cli') return resolveOpencode(binary, deps);
  if (provider === 'claude-cli') return resolveClaude(deps);
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
  if (result.status === 'failed') {
    return { status: 'unavailable', reason: categoryToReason(result.category), asOfLabel: 'just now' };
  }
  // The org catalogue — labeled as its source, NOT "what this harness can run".
  return { status: 'ok', ids: result.ids, sourceLabel: 'anthropic /v1/models (org catalogue)', asOfLabel: 'just now' };
}
