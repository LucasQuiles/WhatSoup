export type BoundaryDecision = 'pass' | 'warn' | 'block' | 'inconclusive';

export type FindingDecision = Exclude<BoundaryDecision, 'pass'>;

export type BoundaryActionV1 = 'commit' | 'push' | 'open-pr' | 'reopen-pr' | 'open-issue';

export type BoundaryAction = BoundaryActionV1
  | 'update-pr' | 'merge' | 'tag' | 'release' | 'config-write';

export type EnforcementMode = 'shadow' | 'enforce';

export type EvidenceState = 'observed' | 'absent' | 'invalid' | 'unavailable' | 'stale' | 'unknown';

export interface BoundaryCorrectionStep {
  operation: 'edit' | 'reuse' | 'remove' | 'refresh' | 'split' | 'retry';
  target: string;
  expected: string;
}

export interface BoundaryCommand {
  command: string;
  args: string[];
}

export interface BoundaryVerificationStep extends BoundaryCommand {
  expected: string;
}

export interface BoundaryArtifact {
  kind: 'pull-request' | 'issue' | 'commit' | 'path';
  repository: string;
  id: string;
  url?: string;
  state?: string;
  fingerprintSha256?: string;
}

export interface BoundaryEvidenceRecord {
  label: string;
  value: string;
}

export interface BoundaryFindingV1 {
  ruleId: string;
  decision: FindingDecision;
  action: BoundaryAction;
  summary: string;
  why: string;
  observed: BoundaryEvidenceRecord[];
  matchedArtifacts: BoundaryArtifact[];
  correction: string[];
  rerun: string;
  sourceRefs: string[];
}

export type BoundaryFinding = BoundaryFindingV1;

export interface BoundaryFindingInput {
  ruleId: string;
  decision: FindingDecision;
  action: BoundaryAction;
  evidenceState: EvidenceState;
  summary: string;
  why: string;
  observed: BoundaryEvidenceRecord[];
  matchedArtifacts: BoundaryArtifact[];
  limitations?: string[];
}

export interface CanonicalBoundaryFinding extends BoundaryFindingInput {
  ruleVersion: number;
  expected: string[];
  impact: string[];
  safeControls: string[];
  correction: BoundaryCorrectionStep[];
  verification: BoundaryVerificationStep[];
  rerun: BoundaryCommand;
  rerunPurpose: 'integration-boundary' | 'focused-family-replay';
  sourceRefs: string[];
  limitations: string[];
  findingDigestSha256: string;
}

export interface BoundaryTarget {
  repository: 'LucasQuiles/WhatSoup';
  actionTarget: string;
  headOid: string | null;
}

export interface BoundaryReceiptBase {
  headOid: string | null;
  baseOid: string | null;
  mergeBaseOid: string | null;
  evidenceSource: string;
}

export interface BoundaryOverflow {
  reason: 'boundary.evidence-volume-exceeded';
  inputCounts: {
    findings: number;
    observed: number;
    artifacts: number;
    limitations: number;
    fingerprints: number;
    corrections: number;
    verification: number;
    sources: number;
    canonicalRecords: number;
  };
  rejectedBytes: number | null;
  descriptorDigestSha256: string;
  digestCoverage: 'bounded-structural-descriptor';
}
