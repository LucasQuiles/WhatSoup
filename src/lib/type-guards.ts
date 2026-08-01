/**
 * Shared runtime type guards.
 *
 * Consolidates the 6 byte-identical private definitions of the same
 * "is a plain object record" check that accreted across the codebase
 * (config-memory-migration, core/health, core/send-pipeline, fleet/routes/ops,
 * fleet/routes/mcp-proxy, runtimes/agent/providers/parser-utils).
 */

/**
 * Narrow `unknown` to a non-null, non-array object record.
 *
 * Returns true iff the value is a plain object (not null, not an Array).
 * Used for safely indexing untrusted JSON payloads.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Coerce `unknown` to a plain-object record, else `undefined`.
 *
 * Companion coercer to {@link isRecord} (the predicate stays the single
 * source of truth). Returns `undefined` rather than `null` so the result
 * composes with optional parameters, optional chaining, and `??` defaults.
 *
 * Consolidates the 4 private coercer clones that accreted across the
 * codebase (config.ts `record`, core/fallback-chain `record`,
 * fleet/health-poller `recordValue`, fleet/routes/lines `recordValue`).
 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

// ---------------------------------------------------------------------------
// Non-empty-string type guards (#2211)
// ---------------------------------------------------------------------------

/**
 * Branded non-empty string type. Constructable only through {@link nonEmptyString},
 * which guarantees the value is a string with non-whitespace content (trimmed).
 * Assignable to `string` (transparent brand) but cannot be constructed by accident.
 */
export type NonEmptyString = string & { readonly __nonEmpty: unique symbol };

/**
 * Narrow `unknown` to a trimmed non-empty string, else `null`.
 *
 * Returns the **trimmed** value when `value` is a string with non-whitespace
 * content; `null` otherwise. This is the canonical non-empty-string coercer —
 * the consolidation target for the 26+ open-coded `typeof v === 'string' &&
 * v.trim() !== ''` sites across the codebase (#2211).
 *
 * Sites that intentionally return the **raw** (un-trimmed) value must use
 * {@link nonEmptyStringRaw} instead. The raw-vs-trimmed distinction is the
 * exact divergence this helper eliminates — each call-site now declares its
 * intent by name rather than hiding it in a ternary branch.
 */
export function nonEmptyString(value: unknown): NonEmptyString | null {
  return typeof value === 'string' && value.trim() !== ''
    ? (value.trim() as NonEmptyString)
    : null;
}

/**
 * Narrow `unknown` to a non-empty (but **un-trimmed**) string, else `null`.
 *
 * Returns the **raw** value when `value` is a non-whitespace string; `null`
 * otherwise. Use this at sites that historically returned `value` (not
 * `value.trim()`) from the open-coded idiom — preserving the raw semantics
 * is critical for values where leading/trailing whitespace is significant.
 */
export function nonEmptyStringRaw(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== ''
    ? value
    : null;
}
