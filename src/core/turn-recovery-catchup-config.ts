/**
 * `agentOptions.turnRecoveryCatchupReconcile` — the per-instance config gate
 * for the turn-recovery supervisor's automatic operator catch-up reconciler
 * (docs/turn-recovery-continuity-reconciler.md). Default OFF: an absent
 * block, or `enabled: false`, keeps the supervisor on its pre-reconciler
 * behavior. Lives in its own module so the validator and the runtime wiring
 * share one shape without growing agent-config-validator.ts or runtime.ts.
 */
import { isRecord } from '../lib/type-guards.ts';

export interface TurnRecoveryCatchupReconcileOptions {
  readonly enabled: boolean;
  /** Max caught-up groups closed per supervisor scan; reconciler default when absent. */
  readonly groupLimit?: number;
}

/**
 * Upper bound on `groupLimit`. The reconciler examines up to
 * `groupLimit * RECONCILE_EXAMINATION_MULTIPLIER` groups per scan, so an
 * unbounded value would turn one scan into an unbounded database sweep.
 */
export const CATCHUP_RECONCILE_MAX_GROUP_LIMIT = 1000;

const FIELD = 'agentOptions.turnRecoveryCatchupReconcile';
const ALLOWED_KEYS = new Set(['enabled', 'groupLimit']);

/**
 * Closed-shape validation (fail-closed, like `agentOptions.observability`): a
 * misspelled inner key is rejected rather than silently falling back to the
 * default limit, and `groupLimit` must satisfy the reconciler's own
 * positive-safe-integer check so a bad value fails at load, not as a
 * `catchup_reconcile_failed` on every scan.
 */
export function validateTurnRecoveryCatchupReconcileConfig(
  value: unknown,
): { field: string; message: string } | null {
  if (value === undefined) return null;
  if (!isRecord(value)) {
    return { field: FIELD, message: `${FIELD} must be an object when provided` };
  }
  const unknownKeys = Object.keys(value).filter((key) => !ALLOWED_KEYS.has(key));
  if (unknownKeys.length > 0) {
    return {
      field: FIELD,
      message: `${FIELD} has unknown key(s): ${unknownKeys.join(', ')} (allowed: enabled, groupLimit)`,
    };
  }
  if (typeof value['enabled'] !== 'boolean') {
    return { field: `${FIELD}.enabled`, message: `${FIELD}.enabled must be a boolean` };
  }
  const groupLimit = value['groupLimit'];
  if (
    groupLimit !== undefined &&
    (typeof groupLimit !== 'number' ||
      !Number.isSafeInteger(groupLimit) ||
      groupLimit < 1 ||
      groupLimit > CATCHUP_RECONCILE_MAX_GROUP_LIMIT)
  ) {
    return {
      field: `${FIELD}.groupLimit`,
      message: `${FIELD}.groupLimit must be an integer between 1 and ${CATCHUP_RECONCILE_MAX_GROUP_LIMIT}`,
    };
  }
  return null;
}

/**
 * Maps the config block to the supervisor's `catchupReconcile` dependency:
 * null (off) unless `enabled === true`.
 */
export function resolveCatchupReconcileDep(
  options: TurnRecoveryCatchupReconcileOptions | null | undefined,
): { readonly groupLimit?: number } | null {
  if (options?.enabled !== true) return null;
  return options.groupLimit === undefined ? {} : { groupLimit: options.groupLimit };
}
