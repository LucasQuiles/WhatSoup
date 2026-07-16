import { assertNoSecretLike } from '../../artifact-redaction.ts';

import { canonicalPathBlobRecords } from './fingerprint.ts';
import type {
  DispositionCategory,
  DispositionRecord,
  HistoryArtifactRecord,
} from './history-types.ts';

export interface HistoryPage {
  repository: string;
  observedAt: string;
  items: HistoryArtifactRecord[];
  nextCursor: string | null;
}

export interface HistoryProvider {
  readPage(input: {
    repository: string;
    cursor: string | null;
    signal?: AbortSignal;
  }): Promise<HistoryPage>;
}

export interface HistoryCollection {
  repository: string;
  observedAt: string[];
  artifacts: HistoryArtifactRecord[];
  pageCount: number;
  complete: boolean;
  limitations: string[];
}

export interface CollectHistoryInput {
  repository: string;
  provider: HistoryProvider;
  maxPages?: number;
  maxArtifacts?: number;
  signal?: AbortSignal;
}

export const DEFAULT_HISTORY_BOUNDS = Object.freeze({
  maxPages: 20,
  maxArtifacts: 1_000,
});

const LIMITATION_LENGTH = 240;
const GIT_OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const SHA256_RE = /^[0-9a-f]{64}$/i;
const REPOSITORY_RE = /^[^/\s]+\/[^/\s]+$/;
const DISPOSITION_CATEGORIES = new Set<DispositionCategory>([
  'duplicate-existing-mechanism',
  'reproduced-correctness-defect',
  'production-unreachable',
  'out-of-scope',
  'needs-specific-repro',
  'superseded',
  'accepted-for-reentry',
]);
const ARTIFACT_KINDS = new Set<HistoryArtifactRecord['kind']>(['pull-request', 'issue']);
const ARTIFACT_STATES = new Set<HistoryArtifactRecord['state']>([
  'open',
  'closed-unmerged',
  'merged',
]);
const ISO_TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;

function safeText(value: unknown): string {
  const text = String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/gu, ' ').trim();
  try {
    assertNoSecretLike(text, 'history limitation');
    return text;
  } catch {
    return 'redacted-sensitive-value';
  }
}

function limitation(code: string, detail: unknown): string {
  return `${code}: ${safeText(detail)}`.slice(0, LIMITATION_LENGTH);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = ISO_TIMESTAMP_RE.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , , , offsetHourText, offsetMinuteText] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, 0);
  if (
    local.getUTCFullYear() !== year ||
    local.getUTCMonth() !== month - 1 ||
    local.getUTCDate() !== day ||
    local.getUTCHours() !== hour ||
    local.getUTCMinutes() !== minute ||
    local.getUTCSeconds() !== second
  ) {
    return false;
  }
  if (offsetHourText != null && Number(offsetHourText) > 23) return false;
  if (offsetMinuteText != null && Number(offsetMinuteText) > 59) return false;
  return Number.isFinite(Date.parse(value));
}

function validUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function canonicalStringSet(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  const entries = value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new Error(`${field}[${index}] must be a non-empty string`);
    }
    return entry.trim();
  });
  const unique = [...new Set(entries)];
  if (unique.length !== entries.length) throw new Error(`${field} contains duplicate entries`);
  return unique.sort();
}

function canonicalDisposition(value: unknown): DispositionRecord {
  if (!value || typeof value !== 'object') throw new Error('disposition must be an object');
  const record = value as Partial<DispositionRecord>;
  if (!DISPOSITION_CATEGORIES.has(record.category as DispositionCategory)) {
    throw new Error('disposition category is invalid');
  }
  if (!isIsoTimestamp(record.recordedAt)) throw new Error('disposition recordedAt is invalid');
  return {
    category: record.category as DispositionCategory,
    artifactRefs: canonicalStringSet(record.artifactRefs, 'disposition artifactRefs'),
    reentryConditions: canonicalStringSet(
      record.reentryConditions,
      'disposition reentryConditions',
    ),
    recordedAt: record.recordedAt,
  };
}

function optionalOid(value: unknown, field: string): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string' || !GIT_OID_RE.test(value)) {
    throw new Error(`${field} is not a Git object identity`);
  }
  return value.toLowerCase();
}

function canonicalArtifact(value: unknown, repository: string): HistoryArtifactRecord {
  if (!value || typeof value !== 'object') throw new Error('artifact must be an object');
  const record = value as Partial<HistoryArtifactRecord>;
  if (record.repository !== repository) throw new Error('artifact repository does not match query');
  if (!ARTIFACT_KINDS.has(record.kind as HistoryArtifactRecord['kind'])) {
    throw new Error('artifact kind is invalid');
  }
  if (!Number.isSafeInteger(record.number) || Number(record.number) <= 0) {
    throw new Error('artifact number must be a positive safe integer');
  }
  if (!ARTIFACT_STATES.has(record.state as HistoryArtifactRecord['state'])) {
    throw new Error('artifact state is invalid');
  }
  if (record.kind === 'issue' && record.state === 'merged') {
    throw new Error('an issue cannot advertise merged state');
  }
  if (!validUrl(record.url)) throw new Error('artifact URL is invalid');

  const result: HistoryArtifactRecord = {
    repository,
    kind: record.kind as HistoryArtifactRecord['kind'],
    number: record.number as number,
    state: record.state as HistoryArtifactRecord['state'],
    url: record.url,
  };
  if (record.pathBlobSet !== undefined) {
    if (record.kind !== 'pull-request') throw new Error('only pull requests can advertise path blobs');
    if (!Array.isArray(record.pathBlobSet) || record.pathBlobSet.length === 0) {
      throw new Error('advertised path/blob evidence must be a non-empty array');
    }
    result.pathBlobSet = canonicalPathBlobRecords(record.pathBlobSet);
  }
  if (record.patchIdStable !== undefined) {
    if (record.kind !== 'pull-request') throw new Error('only pull requests can advertise a patch');
    result.patchIdStable = optionalOid(record.patchIdStable, 'stable patch');
  }
  if (record.taskFingerprintSha256 !== undefined) {
    if (
      record.taskFingerprintSha256 !== null &&
      (typeof record.taskFingerprintSha256 !== 'string' ||
        !SHA256_RE.test(record.taskFingerprintSha256))
    ) {
      throw new Error('task fingerprint is not a SHA-256 identity');
    }
    result.taskFingerprintSha256 = record.taskFingerprintSha256?.toLowerCase() ?? null;
  }
  if (record.disposition !== undefined) {
    result.disposition = record.disposition === null ? null : canonicalDisposition(record.disposition);
  }
  return result;
}

function artifactKey(artifact: HistoryArtifactRecord): string {
  return `${artifact.kind}#${artifact.number}`;
}

function compareArtifacts(left: HistoryArtifactRecord, right: HistoryArtifactRecord): number {
  if (left.kind < right.kind) return -1;
  if (left.kind > right.kind) return 1;
  return left.number - right.number;
}

function errorName(error: unknown): string {
  return error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
}

export async function collectHistory(input: CollectHistoryInput): Promise<HistoryCollection> {
  const repository = input?.repository;
  const result: HistoryCollection = {
    repository: typeof repository === 'string' ? repository : '',
    observedAt: [],
    artifacts: [],
    pageCount: 0,
    complete: false,
    limitations: [],
  };
  if (typeof repository !== 'string' || !REPOSITORY_RE.test(repository)) {
    result.limitations.push(limitation('history.invalid-input', 'repository must be owner/name'));
    return result;
  }
  if (!input.provider || typeof input.provider.readPage !== 'function') {
    result.limitations.push(limitation('history.invalid-input', 'provider.readPage is required'));
    return result;
  }
  const maxPages = input.maxPages ?? DEFAULT_HISTORY_BOUNDS.maxPages;
  const maxArtifacts = input.maxArtifacts ?? DEFAULT_HISTORY_BOUNDS.maxArtifacts;
  if (!Number.isSafeInteger(maxPages) || maxPages <= 0) {
    result.limitations.push(limitation('history.invalid-input', 'maxPages must be positive'));
    return result;
  }
  if (!Number.isSafeInteger(maxArtifacts) || maxArtifacts <= 0) {
    result.limitations.push(limitation('history.invalid-input', 'maxArtifacts must be positive'));
    return result;
  }

  const artifacts = new Map<string, HistoryArtifactRecord>();
  const usedCursors = new Set<string>();
  let cursor: string | null = null;

  for (;;) {
    if (input.signal?.aborted) {
      result.limitations.push(
        limitation('history.aborted', `request was aborted before page ${result.pageCount + 1}`),
      );
      break;
    }
    const cursorKey = cursor === null ? '<initial>' : cursor;
    if (usedCursors.has(cursorKey)) {
      result.limitations.push(limitation('history.cursor-cycle', `cursor ${cursorKey} was reused`));
      break;
    }
    usedCursors.add(cursorKey);

    let page: HistoryPage;
    try {
      page = await input.provider.readPage({ repository, cursor, signal: input.signal });
    } catch (error) {
      const name = errorName(error);
      const code =
        input.signal?.aborted || name === 'AbortError'
          ? 'history.aborted'
          : name === 'TimeoutError'
            ? 'history.provider-timeout'
            : 'history.provider-failed';
      result.limitations.push(limitation(code, error));
      break;
    }
    if (input.signal?.aborted) {
      result.limitations.push(
        limitation('history.aborted', `request was aborted while reading page ${result.pageCount + 1}`),
      );
      break;
    }
    if (!page || typeof page !== 'object') {
      result.limitations.push(limitation('history.invalid-page', 'provider returned a non-object'));
      break;
    }
    if (page.repository !== repository) {
      result.limitations.push(
        limitation(
          'history.repository-mismatch',
          `page ${result.pageCount + 1} reported ${page.repository} instead of ${repository}`,
        ),
      );
      break;
    }
    if (!isIsoTimestamp(page.observedAt)) {
      result.limitations.push(
        limitation('history.invalid-observed-at', `page ${result.pageCount + 1} has no valid time`),
      );
      break;
    }
    if (!Array.isArray(page.items)) {
      result.limitations.push(
        limitation('history.invalid-page', `page ${result.pageCount + 1} items must be an array`),
      );
      break;
    }
    if (
      page.nextCursor !== null &&
      (typeof page.nextCursor !== 'string' ||
        page.nextCursor.length === 0 ||
        safeText(page.nextCursor) !== page.nextCursor)
    ) {
      result.limitations.push(
        limitation('history.invalid-page', `page ${result.pageCount + 1} cursor is invalid`),
      );
      break;
    }

    result.pageCount += 1;
    result.observedAt.push(page.observedAt);
    let pageFailed = false;
    for (let index = 0; index < page.items.length; index += 1) {
      if (artifacts.size >= maxArtifacts) {
        result.limitations.push(
          limitation('history.artifact-limit', `maxArtifacts=${maxArtifacts} was exceeded`),
        );
        pageFailed = true;
        break;
      }
      let candidate: HistoryArtifactRecord;
      try {
        candidate = canonicalArtifact(page.items[index], repository);
      } catch (error) {
        result.limitations.push(
          limitation(
            'history.invalid-artifact',
            `page ${result.pageCount} item ${index + 1}: ${safeText(error)}`,
          ),
        );
        pageFailed = true;
        break;
      }
      const key = artifactKey(candidate);
      const existing = artifacts.get(key);
      if (existing && JSON.stringify(existing) !== JSON.stringify(candidate)) {
        result.limitations.push(
          limitation('history.conflicting-artifact', `${key} has inconsistent evidence`),
        );
        pageFailed = true;
        break;
      }
      if (!existing) artifacts.set(key, candidate);
    }
    if (pageFailed) break;

    if (page.nextCursor === null) {
      result.complete = true;
      break;
    }
    if (usedCursors.has(page.nextCursor)) {
      result.limitations.push(
        limitation('history.cursor-cycle', `cursor ${page.nextCursor} was reused`),
      );
      break;
    }
    if (result.pageCount >= maxPages) {
      result.limitations.push(
        limitation('history.page-limit', `maxPages=${maxPages} reached while a cursor remains`),
      );
      break;
    }
    if (artifacts.size >= maxArtifacts) {
      result.limitations.push(
        limitation(
          'history.artifact-limit',
          `maxArtifacts=${maxArtifacts} reached while a cursor remains`,
        ),
      );
      break;
    }
    cursor = page.nextCursor;
  }

  result.artifacts = [...artifacts.values()].sort(compareArtifacts);
  return result;
}
