export type BoundaryDecision = 'pass' | 'warn' | 'block' | 'inconclusive';

export type BoundaryAction = 'commit' | 'push' | 'open-pr' | 'reopen-pr' | 'open-issue';

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

export interface BoundaryFinding {
  ruleId: string;
  decision: Exclude<BoundaryDecision, 'pass'>;
  action: BoundaryAction;
  summary: string;
  why: string;
  observed: BoundaryEvidenceRecord[];
  matchedArtifacts: BoundaryArtifact[];
  correction: string[];
  rerun: string;
  sourceRefs: string[];
}
