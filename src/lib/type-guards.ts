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

/**
 * Throwing companions to the predicates above.
 *
 * Naming law for this module:
 *   - `is*`      predicate, returns boolean
 *   - `as*`      coerce-or-undefined (safe; never throws)
 *   - `require*` coerce-or-throw (fail-closed; for callers that would rather
 *                abort than propagate a malformed value)
 *
 * `require*` deliberately does NOT reuse the `asRecord` name for a throwing
 * variant — a same-named function with a different arity/behaviour depending
 * on caller intent is the exact ambiguity this module exists to eliminate.
 * Every `require*` helper takes `(value, label, ...)`, where `label` names the
 * value in the thrown message, mirroring the 6+ call-site clones this SSOT
 * consolidates (see #2253).
 */

/**
 * Narrow `unknown` to a plain-object record, else throw.
 *
 * Throwing companion to {@link isRecord}/{@link asRecord}. Consolidates the
 * throwing `asRecord(value, label)` clones that accreted across the codebase
 * (scripts/provider-parity-report.ts, scripts/arc-runtime-proof.ts,
 * scripts/harness-maintenance-guard.ts, src/fleet/auth-loss-mode-bucket-artifact-contract.ts,
 * and others) because the SSOT previously exported only the non-throwing coercer.
 */
export function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

/**
 * Narrow `unknown` to a string, else throw.
 *
 * Rejects only non-strings and the empty string (`.length === 0`) — it does
 * NOT apply {@link isNonEmptyString}'s whitespace-trim check. A call site
 * that needs whitespace-only strings rejected should compose
 * `isNonEmptyString`/`asNonEmptyString` instead.
 */
export function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

/**
 * Narrow `unknown` to a boolean, else throw.
 */
export function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${label} must be a boolean`);
  }
  return value;
}

/**
 * Narrow `unknown` to a finite number, else throw.
 *
 * Rejects `NaN` and `Infinity`/`-Infinity` in addition to non-numbers — a
 * plain `typeof value === 'number'` check (as several of the clones this
 * consolidates used) silently admits those.
 */
export function requireNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a number`);
  }
  return value;
}

/**
 * Narrow `unknown` to a member of `allowed`, else throw.
 *
 * Argument order is `(value, label, allowed)` — `label` stays the second
 * parameter across every `require*` helper in this module. `allowed` is a
 * `ReadonlySet<T>` for O(1) membership, matching existing call sites (e.g.
 * scripts/provider-parity-report.ts's `EXPECTATION_VALUES`/`PROBE_STATE_VALUES`).
 */
export function requireEnum<T extends string>(value: unknown, label: string, allowed: ReadonlySet<T>): T {
  if (typeof value !== 'string' || !allowed.has(value as T)) {
    throw new Error(`${label} must be one of ${[...allowed].join(', ')}`);
  }
  return value as T;
}

/**
 * Narrow `unknown` to a string OR `null`, else throw.
 *
 * `undefined` is deliberately NOT accepted as `null` — a missing key and an
 * explicit null are different failure signatures under a strict schema.
 */
export function requireNullableString(value: unknown, label: string): string | null {
  if (value === null || typeof value === 'string') return value;
  throw new Error(`${label} must be a string or null`);
}

/**
 * Narrow `unknown` to a boolean OR `null`, else throw.
 */
export function requireNullableBoolean(value: unknown, label: string): boolean | null {
  if (value === null || typeof value === 'boolean') return value;
  throw new Error(`${label} must be a boolean or null`);
}

/**
 * Narrow `unknown` to a finite number OR `null`, else throw.
 */
export function requireNullableNumber(value: unknown, label: string): number | null {
  if (value === null || (typeof value === 'number' && Number.isFinite(value))) return value;
  throw new Error(`${label} must be a finite number or null`);
}

/**
 * Narrow `unknown` to an array of strings, else throw.
 *
 * Delegates each element to {@link requireString}; a failing element's
 * thrown message embeds its index as `${label}[${index}]`.
 */
export function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  value.forEach((entry, index) => requireString(entry, `${label}[${index}]`));
  return value as string[];
}

/**
 * Narrow `unknown` to an array of plain-object records, else throw.
 *
 * Delegates each element to {@link requireRecord}; a failing element's
 * thrown message embeds its index as `${label}[${index}]`.
 */
export function requireArrayOfRecords(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry, index) => requireRecord(entry, `${label}[${index}]`));
}
