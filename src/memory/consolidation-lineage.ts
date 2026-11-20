import { shortHash } from '../lib/short-hash.ts';

/**
 * Promotion lineage identity for memory consolidation (#2569 source-set identity).
 *
 * A promotion's identity is its scope, the canonical set of source record ids
 * it was derived from, and the lineage policy version. Model wording never
 * enters it, so the same sources promoted again with different wording resolve
 * to the same remote record instead of an unlinked sibling.
 */
export const CONSOLIDATION_LINEAGE_POLICY_VERSION = 1 as const;

// Domain-separates this digest from every other shortHash input in the repo.
const LINEAGE_HASH_DOMAIN = 'whatsoup.memory-consolidation.lineage';
const LINEAGE_HASH_HEX_LENGTH = 32;

export interface ConsolidationLineage {
  /** Opaque lineage id, `l<policy>:<hex>`. */
  lineageId: string;
  /** Remote record id: `durable:<lineageId>`. Legacy claim-hash ids were `durable:<16 hex>`. */
  recordId: string;
  /** Validated source ids in canonical order. */
  sourceRecordIds: string[];
  policyVersion: typeof CONSOLIDATION_LINEAGE_POLICY_VERSION;
}

/** Code-unit ascending and locale-free: the order clusterMemories seeds with. */
export function canonicalSourceRecordIds(ids: readonly string[]): string[] {
  return [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The lineage of one promotion, or null when its source set is not a
 * non-empty, duplicate-free subset of the cluster the run holds. Null is a
 * fail-closed verdict: the caller writes nothing for that cluster.
 */
export function consolidationLineage(
  scope: { chatJid: string; senderJid: string },
  sourceRecordIds: readonly string[],
  clusterRecordIds: ReadonlySet<string>,
): ConsolidationLineage | null {
  if (sourceRecordIds.length === 0) return null;
  const canonical = canonicalSourceRecordIds(sourceRecordIds);
  for (let index = 0; index < canonical.length; index += 1) {
    if (!clusterRecordIds.has(canonical[index])) return null;
    if (index > 0 && canonical[index] === canonical[index - 1]) return null;
  }
  const digest = shortHash(
    JSON.stringify([
      LINEAGE_HASH_DOMAIN,
      CONSOLIDATION_LINEAGE_POLICY_VERSION,
      scope.chatJid,
      scope.senderJid,
      canonical,
    ]),
    LINEAGE_HASH_HEX_LENGTH,
  );
  const lineageId = `l${CONSOLIDATION_LINEAGE_POLICY_VERSION}:${digest}`;
  return {
    lineageId,
    recordId: `durable:${lineageId}`,
    sourceRecordIds: canonical,
    policyVersion: CONSOLIDATION_LINEAGE_POLICY_VERSION,
  };
}
