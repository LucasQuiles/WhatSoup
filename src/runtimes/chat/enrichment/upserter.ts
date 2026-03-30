import { createHash } from 'node:crypto';
import { createChildLogger } from '../../../logger.ts';
import type { PineconeMemory } from '../providers/pinecone.ts';
import type { ValidatedFact } from './validator.ts';

const log = createChildLogger('enrichment');

function shortHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

export async function upsertFacts(
  pinecone: PineconeMemory,
  facts: ValidatedFact[],
): Promise<{ upserted: number; deduplicated: number; superseded: number }> {
  let upserted = 0;
  let deduplicated = 0;
  let superseded = 0;

  for (const fact of facts) {
    const senderSegment = fact.senderJid || 'group';
    const id = `${fact.chatJid}:${senderSegment}:${shortHash(fact.text)}`;

    // Dedup check
    let isDup = false;
    try {
      const dupCheck = await pinecone.checkDuplicate(fact.chatJid, fact.senderJid, fact.text);
      if (dupCheck.isDuplicate) {
        log.debug({ id, score: dupCheck.score }, 'upserter: skipping duplicate');
        deduplicated = deduplicated + 1;
        isDup = true;
      }
    } catch (err) {
      log.warn({ err, id }, 'upserter: dedup check failed — proceeding with upsert');
    }

    if (isDup) continue;

    // Handle corrections — find and update the superseded record's text
    if (fact.supersedesText) {
      try {
        const hits = await pinecone.search(fact.supersedesText, { chat_jid: { $eq: fact.chatJid } }, 1);
        if (hits.length > 0 && hits[0].score >= 0.8) {
          const old = hits[0].record;
          const updatedText = `was: ${old.text}, now: ${fact.text}`;
          await pinecone.upsert([{
            ...old,
            text: updatedText,
            memoryType: 'correction',
            updatedAt: new Date().toISOString(),
            superseded: fact.text,
          }]);
          superseded = superseded + 1;
        }
      } catch (err) {
        log.warn({ err, supersedesText: fact.supersedesText }, 'upserter: supersede lookup failed — continuing');
      }
    }

    // Upsert the new fact
    const now = new Date().toISOString();
    try {
      await pinecone.upsert([{
        id,
        text: fact.text,
        chatJid: fact.chatJid,
        senderJid: fact.senderJid,
        senderName: fact.senderName,
        memoryType: fact.memoryType,
        confidence: fact.adjustedConfidence,
        createdAt: now,
        updatedAt: now,
        superseded: '',
        sourceMessagePks: fact.sourceMessagePks.join(','),
      }]);
      upserted = upserted + 1;
    } catch (err) {
      log.warn({ err, id }, 'upserter: upsert failed for fact');
    }
  }

  return { upserted, deduplicated, superseded };
}
