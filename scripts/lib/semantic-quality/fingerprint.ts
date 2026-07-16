import { createHash } from 'node:crypto';

export type PathBlobStatus = 'added' | 'copied' | 'modified' | 'renamed' | 'deleted';

export interface PathBlobRecord {
  status: PathBlobStatus;
  oldPath?: string | null;
  path: string;
  blobOid: string;
}

export interface ProposalIdentity {
  contentFingerprintSha256: string;
  patchIdStable: string | null;
  proposalFingerprintSha256: string;
  taskFingerprintSha256: string | null;
}

const PATH_BLOB_STATUSES = new Set<PathBlobStatus>([
  'added',
  'copied',
  'modified',
  'renamed',
  'deleted',
]);
const GIT_OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

function bounded(value: unknown): string {
  return String(value).replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 120);
}

function invalid(field: string, value: unknown): Error {
  return new Error(`invalid semantic fingerprint ${field}: ${bounded(value)}`);
}

function canonicalGitOid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !GIT_OID_RE.test(value)) throw invalid(field, value);
  return value.toLowerCase();
}

function canonicalOptionalGitOid(value: string | null | undefined, field: string): string | null {
  return value == null ? null : canonicalGitOid(value, field);
}

function canonicalRepoPath(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw invalid(field, value);
  if (value.startsWith('/') || value.includes('\\')) throw invalid(field, value);
  const segments = value.split('/');
  if (segments.some((segment) => segment === '..')) throw invalid(field, value);
  const canonical = segments.filter((segment) => segment !== '' && segment !== '.').join('/');
  if (canonical.length === 0) throw invalid(field, value);
  return canonical;
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareRecords(left: PathBlobRecord, right: PathBlobRecord): number {
  return (
    compareStrings(left.status, right.status) ||
    compareStrings(left.oldPath ?? '', right.oldPath ?? '') ||
    compareStrings(left.path, right.path) ||
    compareStrings(left.blobOid, right.blobOid)
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalPathBlobRecords(
  records: ReadonlyArray<PathBlobRecord>,
): PathBlobRecord[] {
  if (!Array.isArray(records)) throw invalid('records', records);
  const canonical = records.map((record, index) => {
    if (!record || typeof record !== 'object') throw invalid(`record[${index}]`, record);
    if (!PATH_BLOB_STATUSES.has(record.status)) throw invalid(`record[${index}].status`, record.status);
    const needsOldPath = record.status === 'renamed' || record.status === 'copied';
    if (needsOldPath && record.oldPath == null) {
      throw invalid(`record[${index}].oldPath`, record.oldPath);
    }
    if (!needsOldPath && record.oldPath != null) {
      throw invalid(`record[${index}].oldPath`, record.oldPath);
    }
    return {
      status: record.status,
      oldPath: needsOldPath
        ? canonicalRepoPath(record.oldPath, `record[${index}].oldPath`)
        : null,
      path: canonicalRepoPath(record.path, `record[${index}].path`),
      blobOid: canonicalGitOid(record.blobOid, `record[${index}].blobOid`),
    } satisfies PathBlobRecord;
  });
  canonical.sort(compareRecords);
  for (let index = 1; index < canonical.length; index += 1) {
    if (JSON.stringify(canonical[index - 1]) === JSON.stringify(canonical[index])) {
      throw new Error(`duplicate canonical path/blob record: ${bounded(canonical[index]?.path)}`);
    }
  }
  return canonical;
}

export function contentFingerprintSha256(records: ReadonlyArray<PathBlobRecord>): string {
  return sha256(JSON.stringify(canonicalPathBlobRecords(records)));
}

function normalizedTaskText(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/\s+/gu, ' ').trim();
}

export function taskFingerprintSha256(input: { title: string; body: string }): string {
  if (typeof input?.title !== 'string') throw invalid('task.title', input?.title);
  if (typeof input.body !== 'string') throw invalid('task.body', input.body);
  return sha256(
    JSON.stringify({
      title: normalizedTaskText(input.title),
      body: normalizedTaskText(input.body),
    }),
  );
}

export function buildProposalIdentity(input: {
  records: ReadonlyArray<PathBlobRecord>;
  patchIdStable?: string | null;
  baseOid?: string | null;
  headOid?: string | null;
  task?: { title: string; body: string } | null;
}): ProposalIdentity {
  const contentFingerprint = contentFingerprintSha256(input.records);
  const patchIdStable = canonicalOptionalGitOid(input.patchIdStable, 'patchIdStable');
  const baseOid = canonicalOptionalGitOid(input.baseOid, 'baseOid');
  const headOid = canonicalOptionalGitOid(input.headOid, 'headOid');
  const taskFingerprint = input.task == null ? null : taskFingerprintSha256(input.task);
  return {
    contentFingerprintSha256: contentFingerprint,
    patchIdStable,
    proposalFingerprintSha256: sha256(
      JSON.stringify({
        contentFingerprintSha256: contentFingerprint,
        patchIdStable,
        baseOid,
        headOid,
        taskFingerprintSha256: taskFingerprint,
      }),
    ),
    taskFingerprintSha256: taskFingerprint,
  };
}
