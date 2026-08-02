/**
 * Typed SSOT for the instance runtime context (#2206).
 *
 * Before this module, four in-process modules each did
 * `JSON.parse(process.env.INSTANCE_CONFIG)` with their own error handling —
 * every parse site a fresh chance for drift, and the value round-tripped
 * through a string-only map to bypass ring constraints. The constraint is
 * real: `src/core/` readers cannot import the root-ring `instance-loader`.
 * This ring-0 leaf is importable by every layer.
 *
 * Semantics:
 * - Writers set the store DIRECTLY (and keep writing the env var for the
 *   remaining compat consumers — see the ratchet in
 *   tests/lib/instance-context.test.ts).
 * - Readers use typed getters. When the direct store is empty they fall back
 *   to a FRESH read of the env var through the shared parse point — the
 *   per-site parse IMPLEMENTATIONS die, while env-driven test setups and
 *   boot order keep working unchanged. The env fallback deliberately does
 *   NOT cache: tests mutate the env between cases, and a stale cache is the
 *   init-order bug class this module exists to kill.
 * - A second direct write that CONTRADICTS the first throws — the
 *   two-writers race (instance-loader vs database-compatibility-config)
 *   becomes loud instead of silent.
 * - `_resetInstanceContext()` is the test invalidation hook for the direct
 *   store (the env fallback needs no reset — it re-reads each call).
 *
 * Deliberately dependency-light: no imports from fleet/paths (ring
 * violation); the paths shape is structural. ConfigValidationError comes
 * from the same ring (lib).
 */
import { ConfigValidationError } from './startup-error.ts';

/** Minimal structural view of the bootstrap-critical paths. */
export interface BootstrapInstancePaths {
  dbPath: string;
  lockPath: string;
}

export interface BootstrapInstanceContext {
  name: string;
  healthPort: number;
  paths: BootstrapInstancePaths;
}

let bootstrapContext: BootstrapInstanceContext | null = null;
let loadedConfig: Record<string, unknown> | null = null;

function sameBootstrap(a: BootstrapInstanceContext, b: BootstrapInstanceContext): boolean {
  return (
    a.name === b.name
    && a.healthPort === b.healthPort
    && a.paths.dbPath === b.paths.dbPath
    && a.paths.lockPath === b.paths.lockPath
  );
}

/** database-compatibility-config (early bootstrap) writes the reduced view. */
export function setBootstrapInstanceContext(context: BootstrapInstanceContext): void {
  if (bootstrapContext && !sameBootstrap(bootstrapContext, context)) {
    throw new ConfigValidationError(
      'conflicting bootstrap instance context write: a second writer supplied'
        + ` different values (have name=${bootstrapContext.name} dbPath=${bootstrapContext.paths.dbPath},`
        + ` got name=${context.name} dbPath=${context.paths.dbPath}) — the two-writers race is not allowed`,
    );
  }
  bootstrapContext = context;
}

/** instance-loader writes the validated full config (last-writer-wins, mirroring env semantics). */
export function setLoadedInstanceConfig(config: Record<string, unknown>): void {
  loadedConfig = config;
}

function readEnvFallback(): Record<string, unknown> | null {
  const encoded = process.env.INSTANCE_CONFIG;
  if (!encoded) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch (error) {
    throw new ConfigValidationError(
      `INSTANCE_CONFIG contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigValidationError('INSTANCE_CONFIG must contain a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Shape-tolerant bootstrap view: the record carries whatever the writer put
 * there, and each reader's own field checks decide sufficiency — exactly the
 * semantics the env-JSON readers had before (a missing name/healthPort was
 * their problem, not the parse site's).
 */
function bootstrapFromRecord(record: Record<string, unknown>): BootstrapInstanceContext | null {
  const paths = record['paths'];
  if (typeof paths !== 'object' || paths === null) return null;
  return {
    name: record['name'] as string,
    healthPort: record['healthPort'] as number,
    paths: paths as BootstrapInstancePaths,
  };
}

/**
 * Fail-closed read for the database-compatibility gate: the context must
 * exist (direct store or env fallback) and carry the bootstrap fields.
 */
export function getBootstrapInstanceContext(): BootstrapInstanceContext {
  if (bootstrapContext) return bootstrapContext;
  const record = readEnvFallback();
  const fromEnv = record ? bootstrapFromRecord(record) : null;
  if (fromEnv) return fromEnv;
  throw new ConfigValidationError(
    'instance context is required before the database compatibility gate',
  );
}

/** Null-returning variant for readers that keep their own error wording. */
export function getBootstrapInstanceContextOrNull(): BootstrapInstanceContext | null {
  if (bootstrapContext) return bootstrapContext;
  const record = readEnvFallback();
  return record ? bootstrapFromRecord(record) : null;
}

/**
 * The validated full config as written by the loader, or null when the boot
 * has not loaded an instance (main.ts's agent-boot probe keeps its
 * absent-means-default semantics).
 */
export function getLoadedInstanceConfigOrNull(): Record<string, unknown> | null {
  if (loadedConfig) return loadedConfig;
  return readEnvFallback();
}

/** Test invalidation hook: clears the direct store (the env fallback re-reads). */
export function _resetInstanceContext(): void {
  bootstrapContext = null;
  loadedConfig = null;
}
