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
