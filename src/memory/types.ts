/** A durable knowledge record promoted from episodic memory consolidation */
export interface DurableKnowledge {
  id: string;
  claim: string;
  sourceRecordIds: string[];
  observationCount: number;
  topic: string;
  confidence: number;
  promotionReason: string;
  firstObserved: string;
  lastObserved: string;
  promotedAt: string;
}

/** Input to the consolidation pipeline — a cluster of related memories */
export interface MemoryCluster {
  topic: string;
  records: Array<{
    id: string;
    text: string;
    claim?: string;
    evidence: string;
    createdAt: string;
    confidence: number;
    chatJid?: string;
    senderJid?: string;
  }>;
}

/** Output of the consolidation LLM — what to promote */
export interface ConsolidationResult {
  durableKnowledge: Array<{
    claim: string;
    promotionReason: string;
    confidence: number;
    sourceRecordIds: string[];
  }>;
  discarded: Array<{
    recordId: string;
    reason: string;
  }>;
}
