// Drill-down level renderers for `/model` (brand -> model). Slice 2 of the
// hybrid re-integration; the Level-3 reasoning-effort renderer is Slice 3.
//
// Pure module: render functions only, no I/O, no fetching, no runtime
// wiring. Each function turns one level's already-resolved data into the
// numbered, plain-language menu text AND the matching `DrillEntry[]` — the
// handler hands `entries` to `putDrillSnapshot` so a later `/model N`
// resolves against exactly what the user saw (same numbering, same order).

import type { DrillEntry } from './model-snapshot-cache.ts';

export interface RenderedLevel {
  text: string; // the numbered plain-language menu to send
  entries: DrillEntry[]; // SAME order as the numbering — handed to putDrillSnapshot
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
