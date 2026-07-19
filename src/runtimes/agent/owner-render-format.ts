/**
 * WhatSoup owner-render formatting seam (b28 r2a/r2d).
 *
 * WhatsApp is a narrow column with only three controls (single-`*` bold,
 * `_italic_`, backtick mono). Owner-facing route/model/session renders must not
 * cram enumerations onto a long ` → `-joined line; instead each entry gets its
 * own `• ` bullet. These helpers are PURE and hold no runtime state so they can
 * be unit-tested directly — the runtime assembles config-derived values and
 * passes them through here AFTER the sanitize choke point (formatChatRefForOwner
 * et al.), never before, so this layer only shapes already-safe strings.
 */

import { adviseModel } from '../../lib/model-catalog.ts';

/** WhatsApp bullet prefix for owner-facing enumerations. */
export const OWNER_BULLET = '• ';

/**
 * Render an enumeration as a header line followed by one `• ` bullet per entry
 * — the WhatsApp-narrow-column shape. Callers only reach here with a non-empty
 * list (the empty case renders a scalar "none configured" line instead), so a
 * genuinely empty `items` degrades to the bare header rather than throwing.
 */
export function bulletedSection(header: string, items: readonly string[]): string {
  return [header, ...items.map((item) => `${OWNER_BULLET}${item}`)].join('\n');
}

/**
 * Join zero or more short modifier tags into a trailing ` [a] [b]` suffix.
 * Empty → '' so a model with no modifiers renders exactly `provider (model)`.
 */
export function modifierSuffix(tags: readonly string[]): string {
  return tags.length > 0 ? ` ${tags.map((tag) => `[${tag}]`).join(' ')}` : '';
}

/**
 * Config-derived modifier tags for one model bullet on /model list.
 *
 * D7 honesty discipline: EVERY tag is a fact derivable from configuration —
 * the configured model ID (via the advisory catalog) and the configured tier
 * map (nlRoutingTiers). The catalog is model-agnostic: an ID it does not
 * recognize (e.g. `kimi/kimi-k3`, `glm/glm-5.2`) parses to null and yields NO
 * advisory, so this never invents a lifecycle claim about a third-party model.
 * A provider that is a configured tier target is tagged with that tier.
 */
export function modelModifierTags(
  modelId: string | undefined,
  provider: string,
  tiers: { strongest?: string; fastest?: string } | null | undefined,
): string[] {
  const tags: string[] = [];
  if (modelId !== undefined) {
    const advisory = adviseModel(modelId);
    if (advisory) {
      if (advisory.level === 'upgrade-available' && advisory.recommended) {
        tags.push(`newer: ${advisory.recommended}`);
      } else if (advisory.level === 'deprecated') {
        tags.push(`deprecated${advisory.recommended ? ` → ${advisory.recommended}` : ''}`);
      } else if (advisory.level === 'retired') {
        tags.push(`retired${advisory.recommended ? ` → ${advisory.recommended}` : ''}`);
      }
    }
  }
  if (tiers?.strongest && tiers.strongest === provider) tags.push('strongest');
  if (tiers?.fastest && tiers.fastest === provider) tags.push('fastest');
  return tags;
}

/** Cap on catalogue ids rendered in `/config model` — ONE constant across all
 *  harnesses (Q ruling 2026-07-19: no per-harness tuning). 12 fits the WhatsApp
 *  narrow column; larger sets truncate with an honest `showing N of M` line. */
export const MODEL_CATALOGUE_CAP = 12;

/** Input for {@link formatAvailableModels}. All values are already config- or
 *  catalogue-derived and sanitize-safe; this layer only shapes strings. */
export interface AvailableModelsInput {
  /** Configured/pinned model id — ranked first and marked `[current]`, if in the set. */
  currentModelId: string | null;
  /** Configured fallback model ids — ranked after the current model, in order. */
  fallbackModelIds: readonly string[];
  /** The harness's self-reported catalogue (from listModelCatalog). */
  listing: { status: 'ok' | 'unavailable'; ids: readonly string[] };
  /** Optional case-insensitive substring filter from `/config model <filter>`. */
  filter: string | null;
  /** Max ids to render before truncating (pass {@link MODEL_CATALOGUE_CAP}). */
  cap: number;
  /** Human as-of label for degrade/truncation lines, e.g. 'just now'. */
  asOfLabel: string;
}

/**
 * Render the dynamic PER-HARNESS available-models section for `/config model`
 * (Q ruling 2026-07-19, CONFIG-MODEL-RENDER-SPEC.md). The caller renders the
 * config-derived pin/primary block ABOVE this — so this section degrades
 * INDEPENDENTLY and its failure never takes the "what am I on" answer down.
 *
 * Four load-bearing constraints:
 *  1. (caller's job) pin renders first/unconditionally above this section.
 *  2. Ranked head: current → configured fallbacks → rest (catalogue order),
 *     deduped. When nothing config-derived ranks the head, the truncation line
 *     SAYS it is catalogue order rather than implying it is "the top".
 *  3. `showing N of M` ONLY when M > cap (a "showing 12 of 12" line trains
 *     people to ignore exactly the line they must read).
 *  4. Filter-miss (`no match for 'x' in M models`) is rendered distinctly from
 *     catalogue-unavailable — same slot, opposite meaning (dead-knob defense).
 *
 * Pure and stateless. Never throws.
 */
export function formatAvailableModels(input: AvailableModelsInput): string {
  const { currentModelId, fallbackModelIds, listing, filter, cap, asOfLabel } = input;

  // Constraint 4 (half): catalogue unreachable → honest degrade. The pin is the
  // caller's config-derived block above, so it survives this (constraint 1).
  if (listing.status === 'unavailable') {
    return `*Available models:* catalogue unavailable (as of ${asOfLabel})`;
  }

  // Optional case-insensitive substring filter over the full catalogue.
  let pool: readonly string[] = listing.ids;
  if (filter !== null) {
    const needle = filter.toLowerCase();
    const matched = listing.ids.filter((id) => id.toLowerCase().includes(needle));
    if (matched.length === 0) {
      // Constraint 4 (other half): filter-miss is NOT catalogue-unavailable —
      // count the full catalogue that was searched.
      return `*Available models:* no match for '${filter}' in ${listing.ids.length} models (as of ${asOfLabel})`;
    }
    pool = matched;
  }

  // Constraint 2: rank current → fallbacks → rest (catalogue order), deduped.
  // A pin/fallback present in the pool is the "meaningful rank" signal.
  const seen = new Set<string>();
  const ranked: string[] = [];
  const push = (id: string): void => {
    if (!seen.has(id)) {
      seen.add(id);
      ranked.push(id);
    }
  };
  const currentInPool = currentModelId !== null && pool.includes(currentModelId);
  if (currentInPool && currentModelId !== null) push(currentModelId);
  let fallbackInPool = false;
  for (const fb of fallbackModelIds) {
    if (pool.includes(fb)) {
      fallbackInPool = true;
      push(fb);
    }
  }
  for (const id of pool) push(id);

  const total = ranked.length;
  const shown = ranked.slice(0, cap);
  const header =
    filter !== null
      ? `*Available models* matching '${filter}' (as of ${asOfLabel})`
      : `*Available models* (as of ${asOfLabel})`;
  const bullets = shown.map(
    (id) => `${OWNER_BULLET}${id}${id === currentModelId ? modifierSuffix(['current']) : ''}`,
  );

  const lines = [header, ...bullets];
  if (total > cap) {
    // Constraint 3: truncation line ONLY when it truncates. Constraint 2: if no
    // preference ranked the head, say it is catalogue order, not "the top".
    lines.push(
      currentInPool || fallbackInPool
        ? `showing ${cap} of ${total}`
        : `showing first ${cap} of ${total} (catalogue order — no configured preference to rank by)`,
    );
  }
  return lines.join('\n');
}
