import { createChildLogger } from '../../../logger.ts';
import type { PineconeMemory } from '../providers/pinecone.ts';
import type { LLMProvider } from '../providers/types.ts';
import type { ValidatedFact } from './validator.ts';
import { detectContradictions } from './contradiction.ts';
import { shortHash } from './fact-export-queue.ts';

const log = createChildLogger('enrichment');

export async function upsertFacts(
  pinecone: PineconeMemory,
  facts: ValidatedFact[],
  provider?: LLMProvider,
): Promise<{ upserted: number; deduplicated: number; superseded: number; contradictions: number }> {
  let upserted = 0;
  let deduplicated = 0;
  let superseded = 0;
  let contradictions = 0;

  for (const fact of facts) {
    const senderSegment = fact.senderJid || 'group';
    const id = `${fact.chatJid}:${senderSegment}:${shortHash(fact.text)}`;

    // Dedup check
    let isDup = false;
    try {
      const dedupStart = Date.now();
      const dupCheck = await pinecone.checkDuplicate(fact.chatJid, fact.senderJid, fact.text);
      if (dupCheck.isDuplicate) {
        log.debug({ id, score: dupCheck.score, elapsed_ms: Date.now() - dedupStart }, 'upserter: skipping duplicate');
        deduplicated = deduplicated + 1;
        isDup = true;
      }
    } catch (err) {
      log.warn({ err, id, operation: 'dedup_check' }, 'upserter: dedup check failed — proceeding with upsert');
    }

    if (isDup) continue;

    // Handle corrections — find and update the superseded record's text
    if (fact.supersedesText) {
      const supersedeStart = Date.now();
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
        log.warn({
          err,
          supersedesHash: shortHash(fact.supersedesText),
          supersedesLength: fact.supersedesText.length,
          operation: 'supersede_lookup',
          elapsed_ms: Date.now() - supersedeStart,
        }, 'upserter: supersede lookup failed — continuing');
      }
    }

    let contradictIds = '';
    if (provider && (fact.claim || fact.text)) {
      try {
        const existing = await pinecone.searchClaims(fact.chatJid, fact.senderJid, fact.claim || fact.text, 5);
        const existingForNli = existing.map((r) => ({
          id: r.id,
          claim: r.record.claim ?? r.record.text,
          text: r.record.text,
          score: r.score,
        }));
        const contradictionResults = await detectContradictions(provider, fact, existingForNli);
        if (contradictionResults.length > 0) {
          contradictIds = contradictionResults.map((c) => c.existingId).join(',');
          contradictions += 1;
          log.info({ factHash: shortHash(fact.claim || fact.text), contradictIds }, 'contradiction detected');
        }
      } catch (err) {
        log.warn({ err }, 'contradiction check failed — proceeding without');
      }
    }

    // Upsert the new fact
    const now = new Date().toISOString();
    const upsertStart = Date.now();
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
        promotionReason: fact.validationReason ?? '',
        claim: fact.claim ?? '',
        evidence: fact.evidence ?? '',
        warrant: fact.warrant ?? '',
        confidenceQualifier: fact.confidenceQualifier ?? '',
        contradicts: contradictIds,
      }]);
      upserted = upserted + 1;
    } catch (err) {
      log.warn({ err, id, operation: 'upsert', elapsed_ms: Date.now() - upsertStart }, 'upserter: upsert failed for fact');
    }
  }

  return { upserted, deduplicated, superseded, contradictions };
}
