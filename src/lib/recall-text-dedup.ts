/**
 * Same-text collapse for memory recall surfaces (chat recall and
 * knowledge_search).
 *
 * One fact can be stored under two record ids: a consolidation promotion
 * written under its legacy claim-hash id (`durable:<16 hex>`) and again under
 * its source-set id (`durable:l<policy>:<hex>`, built by
 * `src/memory/consolidation-lineage.ts`). Nothing reconciles the two, so recall
 * collapses records by text instead.
 */

const SOURCE_SET_RECORD_ID = /^durable:l\d+:/;

/** Text identity: trimmed, whitespace runs collapsed, case kept. Null when there is no text to compare. */
export function recallTextKey(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const key = text.trim().replace(/\s+/g, ' ');
  return key.length > 0 ? key : null;
}

function isSourceSetRecordId(id: unknown): boolean {
  return typeof id === 'string' && SOURCE_SET_RECORD_ID.test(id);
}

/**
 * Keeps one item per text key, in input order. The survivor is the first item
 * with a source-set record id, else the first item: the source-set record is
 * the one later consolidation runs keep writing. Items without comparable text
 * all pass through.
 */
export function collapseSameText<T>(
  items: readonly T[],
  view: (item: T) => { id: unknown; text: unknown },
): T[] {
  const survivorByKey = new Map<string, number>();
  items.forEach((item, index) => {
    const { id, text } = view(item);
    const key = recallTextKey(text);
    if (key === null) return;
    const current = survivorByKey.get(key);
    if (
      current === undefined
      || (isSourceSetRecordId(id) && !isSourceSetRecordId(view(items[current]!).id))
    ) {
      survivorByKey.set(key, index);
    }
  });
  return items.filter((item, index) => {
    const key = recallTextKey(view(item).text);
    return key === null || survivorByKey.get(key) === index;
  });
}
