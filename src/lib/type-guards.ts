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
