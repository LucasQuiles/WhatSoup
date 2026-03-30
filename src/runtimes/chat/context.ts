import type { EntitySearchResult, PineconeMemory, SearchResult } from './providers/pinecone.ts';
import { config } from '../../config.ts';
import { createChildLogger } from '../../logger.ts';

const log = createChildLogger('conversation');

/**
 * Format entity search results grouped by entity type into a WhatsApp-friendly
 * plaintext block. Returns an empty string when results is empty.
 *
 * LLM-001/002: Entity text is framed as "background data" to prevent retrieval
 * content from escaping its context role in the system prompt.
 */
function loadEntityContext(results: EntitySearchResult[]): string {
  if (results.length === 0) return '';

  // Group by entityType
  const groups = new Map<string, EntitySearchResult[]>();
  for (const result of results) {
    const group = groups.get(result.record.entityType) ?? [];
    group.push(result);
    groups.set(result.record.entityType, group);
  }

  const parts: string[] = [];
  for (const [entityType, items] of groups) {
    const label = entityType.endsWith('s')
      ? entityType.charAt(0).toUpperCase() + entityType.slice(1)
      : entityType.charAt(0).toUpperCase() + entityType.slice(1) + 's';
    const lines = items.map((r) => `- ${r.record.text}`).join('\n');
    parts.push(`${label}:\n${lines}`);
  }

  return `Background data (retrieved from business records — use to answer the question):\n\n${parts.join('\n\n')}`;
}

/**
 * Retrieve and merge relevant context from Pinecone for the given message.
 *
 * In memory mode (default), queries three scopes in parallel:
 *   1. Chat-specific context (facts/events tied to this group or DM).
 *   2. Sender-specific context (facts about this person across all chats).
 *   3. Self-facts (things Loops has said about itself — for identity consistency).
 *
 * In entity mode, queries the entity index with a single call and formats
 * results grouped by entity type. Self-fact and memory sections are suppressed.
 *
 * Results are deduplicated by id and formatted as a bulleted block.
 * Returns an empty string when no results are found.
 */
export async function loadContext(
  pinecone: PineconeMemory,
  chatJid: string,
  senderJid: string,
  messageText: string,
): Promise<string> {
  if (!messageText.trim()) return '';

  if (config.pineconeSearchMode === 'entity') {
    const results = await pinecone.searchEntities(messageText);
    const topScores = results.slice(0, 3).map((r) => r.score);
    log.info(
      { chatJid, senderJid, entityHits: results.length, topScores },
      'entity context retrieval complete',
    );
    return loadEntityContext(results);
  }

  const [chatResults, senderResults, selfResults] = await Promise.all([
    pinecone.searchForChat(chatJid, messageText),
    pinecone.searchForSender(senderJid, messageText),
    pinecone.searchSelfFacts(messageText),
  ]);

  // Merge, deduplicate by id, preserve insertion order (chat results first)
  const seen = new Set<string>();
  const merged: SearchResult[] = [];

  for (const result of [...chatResults, ...senderResults]) {
    if (!seen.has(result.id)) {
      seen.add(result.id);
      merged.push(result);
    }
  }

  // Self-facts go into a separate block
  const selfFacts: SearchResult[] = [];
  for (const result of selfResults) {
    if (!seen.has(result.id)) {
      seen.add(result.id);
      selfFacts.push(result);
    }
  }

  if (merged.length === 0 && selfFacts.length === 0) return '';

  const topScores = [...merged, ...selfFacts].slice(0, 3).map((r) => r.score);
  log.info({ chatJid, senderJid, chatHits: chatResults.length, senderHits: senderResults.length, selfHits: selfResults.length, mergedHits: merged.length + selfFacts.length, topScores }, 'context retrieval complete');

  const parts: string[] = [];

  if (merged.length > 0) {
    const lines = merged.map((r) => `- ${r.record.text}`).join('\n');
    parts.push(`Background knowledge:\n${lines}`);
  }

  if (selfFacts.length > 0) {
    const lines = selfFacts.map((r) => `- ${r.record.text}`).join('\n');
    parts.push(`Things you (Loops) have said about yourself before — stay consistent with these:\n${lines}`);
  }

  return parts.join('\n\n');
}
