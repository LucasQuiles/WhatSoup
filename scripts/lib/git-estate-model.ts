import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const HASH_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const BASELINE_SCHEMA_VERSION = 2 as const;
const FINDING_ID_PATTERN = /^(dirty|untracked|conflict|detached|locked|prunable|branch_no_upstream|branch_gone|branch_ahead|branch_behind|stash):[0-9a-f]{24}$/;
const WORKTREE_ID_PATTERN = /^worktree:[0-9a-f]{24}$/;
const BRANCH_ID_PATTERN = /^branch:[0-9a-f]{24}$/;

export type GuardPhase = 'pre-commit' | 'pre-push';
export type BaselineState = 'valid' | 'missing' | 'malformed';
export type SnapshotConsistency = 'single-pass' | 'verified';

export interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface WorktreePorcelain {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  locked: boolean;
  lockReason: string | null;
  prunable: boolean;
  pruneReason: string | null;
}

export interface TrackedStatus {
  path: string;
  originalPath?: string;
  xy: string;
  staged: boolean;
  unstaged: boolean;
}

export interface ConflictStatus {
  path: string;
  xy: string;
  stageOids: [string, string, string];
}

export interface WorktreeStatus {
  branchOid: string | null;
  branchHead: string | null;
  branchUpstream: string | null;
  ahead: number;
  behind: number;
  tracked: TrackedStatus[];
  untracked: string[];
  conflicts: ConflictStatus[];
  conflictOperationMarker: string | null;
  conflictOperationReliable: boolean;
}

export interface EstateWorktree extends WorktreePorcelain {
  primary: boolean;
  status: WorktreeStatus | null;
}

export interface EstateBranch {
  name: string;
  oid: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  gone: boolean;
}

export interface EstateStash {
  oid: string;
  parents: string[];
}

export interface EstateFinding {
  id: string;
  kind:
    | 'dirty'
    | 'untracked'
    | 'conflict'
    | 'detached'
    | 'locked'
    | 'prunable'
    | 'branch_no_upstream'
    | 'branch_gone'
    | 'branch_ahead'
    | 'branch_behind'
    | 'stash';
  worktree?: string;
  path?: string;
  branch?: string;
  upstream?: string;
  oid?: string;
  conflictInstanceReliable?: boolean;
}

export interface ScanError {
  kind:
    | 'worktree_status_failed'
    | 'worktree_status_rescan_failed'
    | 'topology_rescan_failed';
  message: string;
  worktree?: string;
}

export interface EstateSnapshotWithoutHash {
  schemaVersion: 1;
  commonDir: string;
  baselinePath: string;
  invokingWorktreePath: string;
  topologyFingerprintStart: string;
  topologyFingerprintEnd: string;
  statusFingerprintStart: string;
  statusFingerprintEnd: string;
  incomplete: boolean;
  racing: boolean;
  worktrees: EstateWorktree[];
  branches: EstateBranch[];
  stashes: EstateStash[];
  findings: EstateFinding[];
  errors: ScanError[];
}

export interface EstateSnapshot extends EstateSnapshotWithoutHash {
  snapshotHash: string;
}

export interface BaselinePayload {
  schemaVersion: 2;
  commonDir: string;
  snapshotHash: string;
  findingIds: string[];
  worktreeCount: number;
  branchCount: number;
  worktreeIds: string[];
  branchIds: string[];
}

export interface BaselineFile extends BaselinePayload {
  payloadHash: string;
}

export interface BaselineReceipt {
  state: BaselineState;
  path: string;
  /** SHA-256 of the exact on-disk baseline bytes, used only for acceptance. */
  rawHash: string;
  findingIds: string[];
  worktreeCount: number;
  branchCount: number;
  worktreeIds: string[];
  branchIds: string[];
  error?: string;
}

export interface GuardDecision {
  blocked: boolean;
  newConflictIds: string[];
  newCriticalFindingIds: string[];
  countGrowth: {
    worktrees: number;
    branches: number;
  };
  newWorktreeIds: string[];
  newBranchIds: string[];
  exemptedWorktreeIds: string[];
  exemptedBranchIds: string[];
  warningCounts: Record<string, number>;
  reasons: string[];
  /** Subset of `reasons` that actually caused `blocked`. Empty when advisory-only. */
  blockingReasons: string[];
  /** Subset of `reasons` that were reported without blocking. */
  advisoryReasons: string[];
}

export class GitEstateError extends Error {
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.kind = kind;
  }
}

export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort(compareText).map((key) =>
    `${JSON.stringify(key)}:${stableJson(record[key])}`
  ).join(',')}}`;
}

export function isFullObjectId(value: string): boolean {
  return HASH_PATTERN.test(value);
}

export function readBaseline(snapshot: EstateSnapshot): BaselineReceipt {
  try {
    const raw = readFileSync(snapshot.baselinePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new GitEstateError('baseline_schema_invalid', 'baseline root must be an object');
    }
    const record = parsed as Record<string, unknown>;
    const expectedKeys = [
      'branchCount',
      'branchIds',
      'commonDir',
      'findingIds',
      'payloadHash',
      'schemaVersion',
      'snapshotHash',
      'worktreeCount',
      'worktreeIds',
    ];
    if (
      stableJson(Object.keys(record).sort(compareText)) !== stableJson(expectedKeys)
    ) {
      throw new GitEstateError('baseline_schema_invalid', 'baseline fields do not match schema');
    }
    const findingIds = record['findingIds'];
    const worktreeIds = record['worktreeIds'];
    const branchIds = record['branchIds'];
    if (
      record['schemaVersion'] !== BASELINE_SCHEMA_VERSION
      || record['commonDir'] !== snapshot.commonDir
      || typeof record['snapshotHash'] !== 'string'
      || !/^[0-9a-f]{64}$/.test(record['snapshotHash'])
      || !Array.isArray(findingIds)
      || !findingIds.every((id) => typeof id === 'string' && FINDING_ID_PATTERN.test(id))
      || new Set(findingIds).size !== findingIds.length
      || stableJson(findingIds) !== stableJson([...findingIds].sort(compareText))
      || !Array.isArray(worktreeIds)
      || !worktreeIds.every((id) => typeof id === 'string' && WORKTREE_ID_PATTERN.test(id))
      || new Set(worktreeIds).size !== worktreeIds.length
      || stableJson(worktreeIds) !== stableJson([...worktreeIds].sort(compareText))
      || !Array.isArray(branchIds)
      || !branchIds.every((id) => typeof id === 'string' && BRANCH_ID_PATTERN.test(id))
      || new Set(branchIds).size !== branchIds.length
      || stableJson(branchIds) !== stableJson([...branchIds].sort(compareText))
      || !Number.isSafeInteger(record['worktreeCount'])
      || (record['worktreeCount'] as number) < 0
      || record['worktreeCount'] !== worktreeIds.length
      || !Number.isSafeInteger(record['branchCount'])
      || (record['branchCount'] as number) < 0
      || record['branchCount'] !== branchIds.length
      || typeof record['payloadHash'] !== 'string'
      || !/^[0-9a-f]{64}$/.test(record['payloadHash'])
    ) {
      throw new GitEstateError(
        'baseline_schema_invalid',
        `baseline does not match schema version ${BASELINE_SCHEMA_VERSION}`,
      );
    }
    const payload: BaselinePayload = {
      schemaVersion: BASELINE_SCHEMA_VERSION,
      commonDir: record['commonDir'] as string,
      snapshotHash: record['snapshotHash'],
      findingIds: findingIds as string[],
      worktreeCount: record['worktreeCount'] as number,
      branchCount: record['branchCount'] as number,
      worktreeIds: worktreeIds as string[],
      branchIds: branchIds as string[],
    };
    if (record['payloadHash'] !== sha256(stableJson(payload))) {
      throw new GitEstateError(
        'baseline_payload_hash_invalid',
        'baseline canonical payload hash does not match its fields',
      );
    }
    return {
      state: 'valid',
      path: snapshot.baselinePath,
      rawHash: sha256(raw),
      findingIds: [...payload.findingIds],
      worktreeCount: payload.worktreeCount,
      branchCount: payload.branchCount,
      worktreeIds: [...payload.worktreeIds],
      branchIds: [...payload.branchIds],
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT'
      ? {
          state: 'missing',
          path: snapshot.baselinePath,
          rawHash: '',
          findingIds: [],
          worktreeCount: 0,
          branchCount: 0,
          worktreeIds: [],
          branchIds: [],
        }
      : {
          state: 'malformed',
          path: snapshot.baselinePath,
          rawHash: '',
          findingIds: [],
          worktreeCount: 0,
          branchCount: 0,
          worktreeIds: [],
          branchIds: [],
          error: 'baseline could not be parsed',
        };
  }
}
