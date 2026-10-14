/**
 * `agentOptions.deferredTurnAdmission` — the per-instance #3295 deferred-turn
 * setting (default OFF). One resolved value feeds BOTH startup consumers in
 * main.ts: the agent runtime option (admission deferral, planned-stop handoff
 * and the drain) and `preConnectRecovery`'s deferred owner. If they disagreed,
 * an enabled restart would close recoverable pre-commit work `owner_disabled`
 * (or a disabled one would hold inbounds for an owner that never runs).
 * Lives in its own module so the validator and main.ts share one shape.
 */
import { isRecord } from '../lib/type-guards.ts';

export interface DeferredTurnAdmissionOptions {
  readonly enabled: boolean;
}

const FIELD = 'agentOptions.deferredTurnAdmission';

/** Closed shape `{ enabled: boolean }`: a misspelled or extra key fails at load. */
export function validateDeferredTurnAdmissionConfig(
  value: unknown,
): { field: string; message: string } | null {
  if (value === undefined) return null;
  if (!isRecord(value)) {
    return { field: FIELD, message: `${FIELD} must be an object when provided` };
  }
  const unknownKeys = Object.keys(value).filter((key) => key !== 'enabled');
  if (unknownKeys.length > 0) {
    return { field: FIELD, message: `${FIELD} has unknown key(s): ${unknownKeys.join(', ')} (allowed: enabled)` };
  }
  if (typeof value['enabled'] !== 'boolean') {
    return { field: `${FIELD}.enabled`, message: `${FIELD}.enabled must be a boolean` };
  }
  return null;
}

export interface DeferredTurnStartupSetting {
  /** Passed to the agent runtime unchanged (absent = OFF). */
  readonly admission: DeferredTurnAdmissionOptions | undefined;
  /**
   * `preConnectRecovery({ deferredTurnOwnerEnabled })`: true exactly when the
   * runtime's drain will run — an agent instance in per_chat scope with the
   * setting on (the drain's own `enabled` predicate).
   */
  readonly ownerEnabled: boolean;
}

/** Resolve the setting once from the loaded instance config (validated at load). */
export function resolveDeferredTurnStartupSetting(
  instanceConfig: Record<string, unknown> | null,
): DeferredTurnStartupSetting {
  const agentOptions = instanceConfig?.['type'] === 'agent' && isRecord(instanceConfig['agentOptions'])
    ? instanceConfig['agentOptions']
    : null;
  const raw = agentOptions?.['deferredTurnAdmission'];
  const admission = isRecord(raw) && typeof raw['enabled'] === 'boolean' ? { enabled: raw['enabled'] } : undefined;
  return {
    admission,
    ownerEnabled: admission?.enabled === true && agentOptions?.['sessionScope'] === 'per_chat',
  };
}
