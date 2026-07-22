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

export function setOwnRecordProperty(
  record: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}
