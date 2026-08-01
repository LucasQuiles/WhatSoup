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

/**
 * Narrow `unknown` to a string with non-whitespace content.
 *
 * Returns true iff the value is a string and `.trim()` leaves something behind
 * (rejects `''`, `'   '`, etc). Consolidates the many byte-near-identical
 * private `typeof value === 'string' && value.trim() !== ''` checks that
 * accreted across the codebase (agent-config-validator `nonBlankString`,
 * auth-loss-mode-bucket-producer `hasProof`, mcp/registry `hasNonEmptyString`,
 * runtimes/agent/stream-parser `isNonEmptyString`, and inline call sites in
 * config.ts, fleet/routes/lines.ts, and elsewhere).
 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Coerce `unknown` to its trimmed string form, else `undefined`.
 *
 * Companion coercer to {@link isNonEmptyString} (the predicate stays the
 * single source of truth). Returns `undefined` rather than `null` so the
 * result composes with optional parameters, optional chaining, and `??`
 * defaults — mirroring {@link asRecord}'s convention.
 *
 * Consolidates the private trimming-coercer clones that accreted across the
 * codebase (core/chat-display-name `nonEmpty`, core/fallback-chain
 * `stringOrUndefined`, fleet/auth-loss-signals `normalizedText`).
 */
export function asNonEmptyString(value: unknown): string | undefined {
  return isNonEmptyString(value) ? value.trim() : undefined;
}
