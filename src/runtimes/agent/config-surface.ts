// src/runtimes/agent/config-surface.ts
//
// The `/config` surface — Q's one-namespace design (CONFIG-SURFACE-MAP.md) where
// ARG-COUNT decides read-vs-write, so discovery and mutation are the same command
// without a second surface. This module is the DETERMINISTIC action layer (owner
// directive 2026-07-20: every check the menu drives is code in the action, not
// the LLM; the LLM only triggers). It lives OUTSIDE runtime.ts so the growing
// command surface never bloats that file (already at its arch.file-size ceiling)
// and stays pure/unit-testable.
//
// This first slice is the GRAMMAR layer only: parse the raw argument string into
// a typed action. Validating the axis NAME against the registry and the VALUE
// against the live catalogue (fail-open shape gate, Q R2) belongs to the executor
// — a later slice — so this parser has no registry/catalogue dependency and is
// a pure function.

/**
 * A parsed `/config` invocation. Arg-count is the discriminator (Q): bare →
 * overview, one token → read that axis, `<axis> default` → unset, `<axis>
 * <value>` → write. `axis` is lowercased (canonical id); `value` preserves case
 * (model ids may be mixed-case, e.g. `minimax/MiniMax-M2`).
 */
export type ConfigAction =
  | { kind: 'overview' }
  | { kind: 'read'; axis: string }
  | { kind: 'unset'; axis: string }
  | { kind: 'write'; axis: string; value: string };

/** The reserved value that returns an axis to its inherited/default (Q R7 unset). */
const UNSET_KEYWORD = 'default';

/**
 * Parse a `/config` argument string into a {@link ConfigAction}. Pure and total:
 * every input maps to exactly one action shape. Unknown axes / invalid values are
 * NOT rejected here — the executor validates them against the axis registry and
 * the live catalogue so the error carries per-axis context (structured error
 * taxonomy, `designing-agent-clis`); this layer only shapes the grammar.
 */
export function parseConfigCommand(rawArgs: string): ConfigAction {
  const trimmed = rawArgs.trim();
  if (trimmed === '') return { kind: 'overview' };

  // First whitespace-run splits the axis token from the rest (the value, which
  // may itself contain spaces — the executor interprets it per axis).
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  // The regex always matches a non-empty trimmed string; the fallback keeps the
  // function total without a non-null assertion.
  const axis = (match?.[1] ?? trimmed).toLowerCase();
  const value = (match?.[2] ?? '').trim();

  if (value === '') return { kind: 'read', axis };
  if (value.toLowerCase() === UNSET_KEYWORD) return { kind: 'unset', axis };
  return { kind: 'write', axis, value };
}

/** The stored model-pin fields (subset of ChatModelPreference) the resolver reads. */
export interface ModelPinState {
  requestedModel: string | null;
  validatedProvider: string | null;
  modelPinVerified: boolean | null;
}

/** The effective provider's catalogue outcome at resolution time. */
export type CatalogueOutcome = { available: true; ids: readonly string[] } | { available: false };

/** What to do with a stored model pin this turn (Slice C.2). */
export type ModelPinDecision =
  | { action: 'none' }
  | { action: 'use'; modelId: string; revalidated?: { validatedProvider: string; verified: true } }
  | { action: 'needs-catalogue'; modelId: string }
  | { action: 'drop'; droppedModelId: string; reason: string }
  | { action: 'defer'; modelId: string };

/**
 * Resolve a stored model pin against the effective provider (Q 2026-07-20,
 * provider-qualified). A model id is only meaningful relative to a resolved
 * harness, so the pin is trusted ONLY while verified against the CURRENT
 * provider; every transition re-validates:
 *   - verified + same provider  → `use` with NO catalogue fetch (the hot path);
 *   - unverified / unvalidated / provider-changed → `needs-catalogue` (the caller
 *     fetches the effective provider's catalogue and calls again with it);
 *   - re-validate + present      → `use` + `revalidated` (caller persists the bit
 *     + provider so the next turn is the hot path);
 *   - re-validate + ABSENT       → `drop` with disclosure (closes the orphaned-pin
 *     and the permanent-fail-open holes — an unverified pin can't ride forever);
 *   - re-validate + catalogue DOWN → `defer` (fail-open: use it unverified, and
 *     re-validate on the next OK read — a DEFERRAL of verification, not a waiver).
 *
 * Why transition-only re-validation is safe (Q 2026-07-20): the pin's 24h TTL is
 * ALSO its staleness ceiling. A verified pin can go stale mid-window (its model
 * retired between transitions) but never indefinitely — it expires at the pin's
 * own lifetime. So this trades no correctness for the per-turn fetch savings;
 * whoever later "optimizes" the TTL upward is also raising the staleness bound.
 *
 * `drop` is only half the contract: the caller (Slice C.3) is OBLIGATED to
 * surface the returned `reason` to the user ON THE TURN the drop happens — a
 * silent storage mutation would make the pin vanish with no explanation. The
 * decision therefore carries `droppedModelId` + `reason` as values to render.
 * Pure and total; the caller owns the catalogue fetch + the persistence.
 */
export function decideModelPinResolution(
  pin: ModelPinState,
  effectiveProvider: string,
  catalogue?: CatalogueOutcome,
): ModelPinDecision {
  const modelId = pin.requestedModel;
  if (modelId === null) return { action: 'none' };
  if (pin.modelPinVerified === true && pin.validatedProvider === effectiveProvider) {
    return { action: 'use', modelId };
  }
  if (catalogue === undefined) return { action: 'needs-catalogue', modelId };
  if (!catalogue.available) return { action: 'defer', modelId };
  if (catalogue.ids.includes(modelId)) {
    return { action: 'use', modelId, revalidated: { validatedProvider: effectiveProvider, verified: true } };
  }
  return { action: 'drop', droppedModelId: modelId, reason: `not in ${effectiveProvider} catalogue` };
}
