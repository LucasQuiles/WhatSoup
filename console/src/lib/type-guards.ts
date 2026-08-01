/**
 * Shared runtime type guards for the console.
 *
 * Consolidates the byte-identical private definitions of the same
 * "is a plain object record" check that accreted across the console codebase
 * (components/line-detail/config-helpers, lib/realtime-events).
 *
 * Mirrors the Node-side `src/lib/type-guards.ts` extracted in PR #523.
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
 * Coerce `unknown` to a plain object record, returning `{}` for any
 * non-record value (null, primitive, array). Used for safely extracting
 * fields from untrusted JSON payloads without an explicit null check at
 * every call site.
 */
export function asRecordOrEmpty(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/**
 * Narrow `unknown` to a string with non-whitespace content.
 *
 * Returns true iff the value is a string and `.trim()` leaves something behind
 * (rejects `''`, `'   '`, etc). Mirrors the Node-side
 * `src/lib/type-guards.ts` `isNonEmptyString`, consolidating the private
 * `typeof value === 'string' && value.trim() !== ''` checks that accreted
 * across console components (agents/panels `str`, wizard/link-step-events).
 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Coerce `unknown` to its trimmed string form, else `undefined`.
 *
 * Companion coercer to {@link isNonEmptyString}, mirroring the Node-side
 * `asNonEmptyString` — `undefined` rather than `null` so the result composes
 * with optional chaining and `??` defaults.
 */
export function asNonEmptyString(value: unknown): string | undefined {
  return isNonEmptyString(value) ? value.trim() : undefined;
}
