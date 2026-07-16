import type { PathBlobRecord } from './fingerprint.ts';

export type DispositionCategory =
  | 'duplicate-existing-mechanism'
  | 'reproduced-correctness-defect'
  | 'production-unreachable'
  | 'out-of-scope'
  | 'needs-specific-repro'
  | 'superseded'
  | 'accepted-for-reentry';

export interface DispositionRecord {
  category: DispositionCategory;
  artifactRefs: string[];
  reentryConditions: string[];
  recordedAt: string;
}

export interface HistoryArtifactRecord {
  repository: string;
  kind: 'pull-request' | 'issue';
  number: number;
  state: 'open' | 'closed-unmerged' | 'merged';
  url: string;
  pathBlobSet?: PathBlobRecord[];
  patchIdStable?: string | null;
  taskFingerprintSha256?: string | null;
  disposition?: DispositionRecord | null;
}
