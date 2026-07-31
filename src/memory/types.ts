import type {
  MemoryEvidenceCoverage,
  MemoryOperationFailureCode,
} from '../lib/memory-operation-telemetry.ts';

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

export type ClusterConsolidationStatus =
  | 'completed_promoted'
  | 'completed_discarded'
  | 'provider_unavailable'
  | 'provider_timeout'
  | 'output_invalid'
  | 'scope_invalid'
  | 'cancelled';

export type ClusterExecutionStatus =
  | ClusterConsolidationStatus
  | 'write_failed';

export interface ClusterExecutionOutcome extends ConsolidationResult {
  status: ClusterExecutionStatus;
  failureCode: MemoryOperationFailureCode | 'write_failed';
  retryable: boolean;
  evidenceCoverage: MemoryEvidenceCoverage;
}

export interface ClusterConsolidationOutcome
  extends ClusterExecutionOutcome {
  status: ClusterConsolidationStatus;
  failureCode: MemoryOperationFailureCode;
}
