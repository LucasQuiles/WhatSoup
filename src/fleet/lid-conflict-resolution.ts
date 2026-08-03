/**
 * Pure LID-mapping conflict-resolution algorithm.
 *
 * Extracted from `src/fleet/index.ts` (#2238) — the 1192-line god-module
 * co-located this pure algorithm with the HTTP route table, handler dispatch,
 * and server factory. `resolveConflict`, `compareLidInstances`, and
 * `buildConflictExplicitLidMappings` read only `updated_at` strings and
 * instance names — no HTTP, auth, DB, or schema-introspection coupling.
 *
 * Deterministic resolution contract (#251 §3.3): parsed max `updated_at` wins;
 * on tie, alphabetical `phone_jid` wins with reason `tied-deterministic`.
 * `source_instance` is the instance whose observation provided the winning
 * phone's max `updated_at`; on a within-phone tie, alphabetically-first
 * instance. Mirrors `writeLidMapping` in `freshness-gated` mode.
 */
import { compareLidUpdatedAt } from '../core/lid-resolver.ts';

export type LidMappingObservation = {
  lid: string;
  phone_jid: string;
  updated_at: string;
  instance: string;
};

export type LidMappingInstance = {
  instance: string;
  updated_at: string;
};

export type UnifiedLidMapping = {
  lid: string;
  phone_jid: string;
  instances: LidMappingInstance[];
};

export type ConflictResolutionReason = 'freshest' | 'tied-deterministic';

export type ConflictResolution = {
  phone_jid: string;
  source_instance: string;
  reason: ConflictResolutionReason;
};

export type ConflictingLidMapping = {
  lid: string;
  phones: Array<{
    phone_jid: string;
    instances: LidMappingInstance[];
  }>;
  /**
   * Deterministic resolution preview (#251 §3.3). Mirrors `writeLidMapping`
   * in `freshness-gated` mode: parsed max `updated_at` wins; on tie,
   * alphabetical `phone_jid` wins with reason `tied-deterministic`.
   * `source_instance` is the instance whose observation provided the winning
   * phone's max `updated_at`; on a within-phone tie, alphabetically-first
   * instance.
   */
  resolution: ConflictResolution;
};

/**
 * Compute the deterministic resolution for a conflicting LID. The conflict's
 * `phones` array is assumed already sorted alphabetically by phone_jid and
 * each phone's `instances` is assumed already sorted via `compareLidInstances`
 * (instance name ascending then updated_at ascending).
 */
export function resolveConflict(phones: ConflictingLidMapping['phones']): ConflictResolution {
  // Per phone, derive the maximum observed updated_at + the instance that
  // provided it. On within-phone tie, pick the alphabetically-first instance.
  const perPhone = phones.map(({ phone_jid, instances }) => {
    let maxAt = '';
    let maxInst = '';
    for (const inst of instances) {
      const byFreshness = maxAt === '' ? 1 : compareLidUpdatedAt(inst.updated_at, maxAt);
      if (byFreshness > 0) {
        maxAt = inst.updated_at;
        maxInst = inst.instance;
      } else if (byFreshness === 0 && (maxInst === '' || inst.instance < maxInst)) {
        maxInst = inst.instance;
      }
    }
    return { phone_jid, maxAt, maxInst };
  });

  // Find the overall freshest phone(s).
  const overallMax = perPhone.reduce(
    (acc, p) => (acc === '' || compareLidUpdatedAt(p.maxAt, acc) > 0 ? p.maxAt : acc),
    '',
  );
  const tied = perPhone.filter(p => compareLidUpdatedAt(p.maxAt, overallMax) === 0);

  if (tied.length === 1) {
    return {
      phone_jid: tied[0].phone_jid,
      source_instance: tied[0].maxInst,
      reason: 'freshest',
    };
  }

  // Tied: alphabetically-first phone wins.
  const winner = tied.toSorted((a, b) => a.phone_jid.localeCompare(b.phone_jid))[0];
  return {
    phone_jid: winner.phone_jid,
    source_instance: winner.maxInst,
    reason: 'tied-deterministic',
  };
}

export function compareLidInstances(a: LidMappingInstance, b: LidMappingInstance): number {
  return a.instance.localeCompare(b.instance) || a.updated_at.localeCompare(b.updated_at);
}

export function buildConflictExplicitLidMappings(observations: LidMappingObservation[]): {
  unified: UnifiedLidMapping[];
  conflicts: ConflictingLidMapping[];
} {
  const byLid = new Map<string, Map<string, LidMappingInstance[]>>();
  for (const obs of observations) {
    let byPhone = byLid.get(obs.lid);
    if (!byPhone) {
      byPhone = new Map<string, LidMappingInstance[]>();
      byLid.set(obs.lid, byPhone);
    }

    let instances = byPhone.get(obs.phone_jid);
    if (!instances) {
      instances = [];
      byPhone.set(obs.phone_jid, instances);
    }
    instances.push({ instance: obs.instance, updated_at: obs.updated_at });
  }

  const unified: UnifiedLidMapping[] = [];
  const conflicts: ConflictingLidMapping[] = [];
  for (const [lid, byPhone] of [...byLid.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const phones = [...byPhone.entries()].sort(([a], [b]) => a.localeCompare(b));
    if (phones.length === 1) {
      const [phone_jid, instances] = phones[0];
      unified.push({
        lid,
        phone_jid,
        instances: instances.toSorted(compareLidInstances),
      });
      continue;
    }

    const sortedPhones = phones.map(([phone_jid, instances]) => ({
      phone_jid,
      instances: instances.toSorted(compareLidInstances),
    }));
    conflicts.push({
      lid,
      phones: sortedPhones,
      resolution: resolveConflict(sortedPhones),
    });
  }

  return { unified, conflicts };
}
