/**
 * Consolidation promotion record ids, and the twin collapse that the recall
 * surfaces (chat recall and knowledge_search) apply to them.
 *
 * The id format is defined here once, and the writer
 * (`src/memory/consolidation-lineage.ts`) builds its ids from it: memory may
 * import lib, but lib and the recall surfaces may not import memory
 * (`scripts/lib/fitness/registry.ts`, layer rules).
 *
 * One fact can be stored under two record ids: a promotion written before
 * source-set identity keeps its legacy claim-hash id (`durable:<16 hex>`), and
 * the same fact promoted again is written under its source-set id
 * (`durable:l<policy>:<32 hex>`). Nothing reconciles the two, so recall
 * collapses exactly that pair. Every other pair of hits is left alone,
 * whatever their text.
 */

const DURABLE_RECORD_ID_PREFIX = 'durable:';
const LEGACY_CLAIM_HASH_HEX_LENGTH = 16;

/** Lineage policy version: part of the source-set id and of its hash input. */
export const CONSOLIDATION_LINEAGE_POLICY_VERSION = 1 as const;
/** Lowercase hex digits of a source-set lineage digest. */
export const SOURCE_SET_DIGEST_HEX_LENGTH = 32;

/** Lineage id: `l<policy>:<digest>`. */
export function sourceSetLineageId(digest: string): string {
  return `l${CONSOLIDATION_LINEAGE_POLICY_VERSION}:${digest}`;
}

/** Remote record id of a source-set promotion: `durable:<lineageId>`. */
export function sourceSetRecordId(lineageId: string): string {
  return `${DURABLE_RECORD_ID_PREFIX}${lineageId}`;
}

// Built with the writer's own builders, so the recogniser cannot drift from them.
const SOURCE_SET_RECORD_ID = new RegExp(
  `^${sourceSetRecordId(sourceSetLineageId(`[0-9a-f]{${SOURCE_SET_DIGEST_HEX_LENGTH}}`))}$`,
);
const LEGACY_CLAIM_HASH_RECORD_ID = new RegExp(
  `^${DURABLE_RECORD_ID_PREFIX}[0-9a-f]{${LEGACY_CLAIM_HASH_HEX_LENGTH}}$`,
);

export function isSourceSetRecordId(id: unknown): boolean {
  return typeof id === 'string' && SOURCE_SET_RECORD_ID.test(id);
}

export function isLegacyClaimHashRecordId(id: unknown): boolean {
  return typeof id === 'string' && LEGACY_CLAIM_HASH_RECORD_ID.test(id);
}

/** Text identity: trimmed, whitespace runs collapsed, case kept. Null when there is no text to compare. */
function recallTextKey(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const key = text.trim().replace(/\s+/g, ' ');
  return key.length > 0 ? key : null;
}

export interface RecallTwinView {
  text: unknown;
  /** Surface-defined scope: twins collapse only within one scope. */
  scope: string;
  score: number;
}

/**
 * Collapses each legacy/source-set twin pair: within one scope, the first
 * legacy claim-hash record and the first source-set record whose texts match.
 * The source-set record survives at the earlier position of the two, carrying
 * the higher score of the two, so the fact keeps the best rank either twin
 * had. Every other item is returned unchanged, in order.
 *
 * Ids are scanned first. Unless both id kinds are present (never the case
 * with consolidation off), or when no pair matches, the input array itself is
 * returned and `view` is never called, so no text is read and no scope key is
 * built. Otherwise `view` runs once per legacy or source-set record only.
 */
export function collapseConsolidationTwins<T>(
  items: T[],
  idOf: (item: T) => unknown,
  view: (item: T) => RecallTwinView,
  withScore: (item: T, score: number) => T,
): T[] {
  let hasLegacy = false;
  let hasSourceSet = false;
  for (let index = 0; index < items.length && !(hasLegacy && hasSourceSet); index += 1) {
    const id = idOf(items[index]!);
    if (isLegacyClaimHashRecordId(id)) hasLegacy = true;
    else if (isSourceSetRecordId(id)) hasSourceSet = true;
  }
  if (!hasLegacy || !hasSourceSet) return items;

  const legacyByKey = new Map<string, number>();
  const sourceSetByKey = new Map<string, number>();
  const scoreAt = new Map<number, number>();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    const id = idOf(item);
    const byKey = isLegacyClaimHashRecordId(id)
      ? legacyByKey
      : isSourceSetRecordId(id) ? sourceSetByKey : null;
    if (byKey === null) continue;
    const { text, scope, score } = view(item);
    const textKey = recallTextKey(text);
    if (textKey === null) continue;
    const key = `${scope}\0${textKey}`;
    if (byKey.has(key)) continue;
    byKey.set(key, index);
    scoreAt.set(index, score);
  }

  const survivorAt = new Map<number, T>();
  const removed = new Set<number>();
  for (const [key, legacyIndex] of legacyByKey) {
    const sourceSetIndex = sourceSetByKey.get(key);
    if (sourceSetIndex === undefined) continue;
    survivorAt.set(
      Math.min(legacyIndex, sourceSetIndex),
      withScore(items[sourceSetIndex]!, Math.max(scoreAt.get(legacyIndex)!, scoreAt.get(sourceSetIndex)!)),
    );
    removed.add(Math.max(legacyIndex, sourceSetIndex));
  }
  if (survivorAt.size === 0) return items;
  return items.flatMap((item, index) => {
    if (removed.has(index)) return [];
    return [survivorAt.has(index) ? survivorAt.get(index)! : item];
  });
}
