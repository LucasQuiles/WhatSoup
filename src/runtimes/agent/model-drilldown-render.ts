// Drill-down level renderers for `/model` (brand -> model). Slice 2 of the
// hybrid re-integration; the Level-3 reasoning-effort renderer is Slice 3.
//
// Pure module: render functions only, no I/O, no fetching, no runtime
// wiring. Each function turns one level's already-resolved data into the
// numbered, plain-language menu text AND the matching `DrillEntry[]` — the
// handler hands `entries` to `putDrillSnapshot` so a later `/model N`
// resolves against exactly what the user saw (same numbering, same order).

import type { DrillEntry } from './model-snapshot-cache.ts';
import type { ReasoningControl } from './reasoning-control.ts';

export interface RenderedLevel {
  text: string; // the numbered plain-language menu to send
  entries: DrillEntry[]; // SAME order as the numbering — handed to putDrillSnapshot
}

/** The Level-3 "no override" row label — pinning it clears any effort pin. */
export const DEFAULT_EFFORT_LABEL = 'Default (no override)';

/**
 * Plain display label for a reasoning-effort level. The internal ids are the
 * claude-cli `--effort` flag values ('xhigh'|'high'|'medium'|'low'); the menu
 * shows a plain word, never the flag token (no-jargon charter).
 */
export function prettyEffortLabel(effort: string): string {
  switch (effort) {
    case 'xhigh': return 'Highest';
    case 'high': return 'High';
    case 'medium': return 'Medium';
    case 'low': return 'Low';
    default: return effort;
  }
}

export function renderBrandLevel(
  brands: readonly { brand: string; provider: string }[],
  currentBrand?: string | null
): RenderedLevel {
  const entries: DrillEntry[] = brands.map(({ brand, provider }) => ({
    kind: 'brand',
    label: brand,
    brand,
    provider,
  }));

  const lines = brands.map(({ brand }, i) => {
    const current = brand === currentBrand ? ' (current)' : '';
    return `${i + 1}. ${brand}${current}`;
  });

  const text = ['*Pick a provider:*', ...lines, '_Reply /model N_'].join('\n');

  return { text, entries };
}

export function renderModelLevel(
  brand: string,
  provider: string,
  models: readonly string[],
  currentModel?: string | null
): RenderedLevel {
  const entries: DrillEntry[] = models.map((model) => ({
    kind: 'model',
    label: model,
    provider,
    model,
  }));

  const lines = models.map((model, i) => {
    const current = model === currentModel ? ' (current)' : '';
    return `${i + 1}. ${model}${current}`;
  });

  // FW-3 (owner-adjudicated A14): up-nav retired — the footer no longer
  // advertises `/model back` (it would no longer navigate if typed; `/reset`
  // is the undo path, `/model` reopens Level-1).
  const text = [`*${brand} — pick a model:*`, ...lines, '_Reply /model N_'].join('\n');

  return { text, entries };
}

/**
 * Level-3 (Slice 3) — the reasoning-effort menu for a model that has native
 * reasoning control. One numbered row per level (in `control.options` order),
 * then a "Default (no override)" row appended LAST (FW-7: adding it never
 * shifts the explicit picks). `currentEffort` (the route's effort, or
 * null/undefined for no override) marks the active row `(current)` — null
 * marks the Default row, so the user sees where they are without a readout.
 */
export function renderEffortLevel(
  model: string,
  provider: string,
  control: ReasoningControl,
  currentEffort?: string | null,
): RenderedLevel {
  const entries: DrillEntry[] = [
    ...control.options.map((effort): DrillEntry => ({
      kind: 'effort', label: prettyEffortLabel(effort), provider, model, effort,
    })),
    { kind: 'effort', label: DEFAULT_EFFORT_LABEL, provider, model, effort: null },
  ];

  const active = currentEffort ?? null;
  const lines = entries.map((entry, i) => {
    const current = entry.kind === 'effort' && entry.effort === active ? ' (current)' : '';
    return `${i + 1}. ${entry.label}${current}`;
  });

  const text = [`*${model} — reasoning effort:*`, ...lines, '_Reply /model N_'].join('\n');

  return { text, entries };
}
