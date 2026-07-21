#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  chmodSync, closeSync, constants, copyFileSync, existsSync, fstatSync, fsyncSync,
  lstatSync, openSync, readSync, renameSync, statSync, unlinkSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { stderr, stdout } from 'node:process';
import { backup, constants as sqliteConstants, DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { CURRENT_SCHEMA_MIGRATION } from '../src/core/database-schema-version.ts';
import { withImmediateTransaction } from '../src/core/db-tx.ts';
import { redactBotErrorsText } from '../src/lib/bot-errors-outbox.ts';
import {
  assertPrivateDirectorySync,
  deletePrivateFileSync,
  forceEnsurePrivateDirectorySync,
  readPrivateFileSync,
  writePrivateJsonMarkerSync,
} from '../src/lib/private-fs.ts';
import { rejectProposalsBatch } from '../src/core/substrate/beads.ts';
import {
  classifyInlineImperative,
  type InlineImperativeResult,
} from '../src/core/substrate/inline-extractor.ts';

export const CLASSIFIER_VERSION = 'anchored-v1';
const FORMAT_VERSION = 2;
const CLEANUP_ACTOR = 'inline-proposal-cleanup';
const REASON_CODE = 'classifier_rejected';
const PRIVATE_FILE_MODE = 0o600;
export const HASH_CHUNK_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 2 * 1024 * 1024;

type Classifier = (body: string) => InlineImperativeResult;

interface RetainedValidCounts {
  admittedInline: number;
  admittedInlineOverdue: number;
  otherProposed: number;
  otherProposedOverdue: number;
}

interface CandidateState {
  status: 'proposed';
  createdAt: number;
  updatedAt: number;
  reviewByAt: number | null;
  sourceMessagePk: number | null;
  proposalReason: string | null;
  completedAt: null;
  cancelledAt: null;
}

interface CleanupCandidate {
  id: number;
  bodySha256: string;
  identitySha256: string;
  baselineEventSetSha256: string;
  rejectionReason: string;
  sourceEventId: number;
  sourceEventType: string;
  sourceEventPayloadSha256: string;
  sourceEventActor: string;
  sourceEventMessagePk: number | null;
  sourceEventCreatedAt: number;
  prior: CandidateState;
}

interface CompanionRecord {
  present: boolean;
  sha256: string | null;
  size: number | null;
  snapshotFile: string | null;
}

export interface CleanupManifest {
  formatVersion: 2;
  manifestId: string;
  classifierVersion: string;
  createdAt: number;
  database: {
    fingerprint: string;
    schemaVersion: number;
    snapshotFile: string;
    wal: CompanionRecord;
    shm: CompanionRecord;
  };
  retainedValid: RetainedValidCounts;
  candidates: CleanupCandidate[];
}

export interface PlanOptions {
  dbPath: string;
  artifactDir: string;
  classifierVersion?: string;
  expectedRetainedValid?: RetainedValidCounts;
  /** Test-only negative-control seam; unavailable outside NODE_ENV=test. */
  classifier?: Classifier;
  /** Test-only deterministic artifact fault. */
  testOnlyFault?: 'companion' | 'manifest';
}

export interface CleanupCommandOptions {
  dbPath: string;
  manifestPath: string;
  /** Test-only commit injected after fingerprinting and before the write lock. */
  testOnlyAfterFingerprint?: () => void;
  /** Test-only commit injected from the online-backup progress callback. */
  testOnlyDuringFingerprint?: () => void;
  /** Test-only fault injected under A5's BEGIN IMMEDIATE lock. */
  testOnlyUnderLockFault?: (raw: DatabaseSync) => void;
  /** Test-only path mutation injected after the cleanup transaction commits. */
  testOnlyAfterMutation?: () => void;
  /** Test-only deterministic receipt fault. */
  testOnlyFault?: 'apply-receipt' | 'rollback-receipt';
}

interface ApplyReceipt {
  formatVersion: 2;
  manifestId: string;
  appliedAt: number;
  affectedCount: number;
  eventCount: number;
  eventIds: number[];
  backupPath: string;
  backupSha256: string;
  postFingerprint: string;
  receiptId: string;
}

interface RollbackReceipt {
  formatVersion: 2;
  manifestId: string;
  rolledBackAt: number;
  restoredCount: number;
  removedEventCount: number;
  postFingerprint: string;
  receiptId: string;
}

interface BeadInspectionRow {
  id: number;
  status: string;
  body: string | null;
  created_at: number;
  updated_at: number;
  review_by_at: number | null;
  source_message_pk: number | null;
  proposal_reason: string | null;
  completed_at: number | null;
  cancelled_at: number | null;
  [key: string]: unknown;
}

interface OriginEventRow {
  id: number;
  bead_id: number;
  event_type: string;
  payload_json: string;
  actor: string;
  source_message_pk: number | null;
  created_at: number;
}

interface CleanupEventRow {
  id: number;
  bead_id: number;
  payload_json: string;
  actor: string;
  source_message_pk: number | null;
  created_at: number;
}

interface DatabaseFileIdentity { device: number; inode: number }

function sha256Bytes(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hashCleanupFile(path: string): string {
  const pathStat = lstatSync(path);
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) throw new Error(`Hash source is not a regular file: ${path}`);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const digest = createHash('sha256');
  const chunk = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new Error(`Hash source is not a regular file: ${path}`);
    for (;;) {
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      digest.update(chunk.subarray(0, count));
    }
  } finally { closeSync(fd); }
  return digest.digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function isCanonicalSourcePayload(payloadJson: string): boolean {
  try {
    return stableJson(JSON.parse(payloadJson)) === stableJson({ from: null, to: 'proposed' });
  } catch {
    return false;
  }
}

function manifestIdFor(manifest: Omit<CleanupManifest, 'manifestId'>): string {
  return sha256Bytes(stableJson(manifest));
}

function assertPrivateDirectory(path: string): void {
  const absolute = resolve(path);
  forceEnsurePrivateDirectorySync(absolute, 'inline cleanup artifact directory');
  assertPrivateDirectorySync(absolute);
  const stat = lstatSync(absolute);
  if ((stat.mode & 0o077) !== 0) throw new Error('Artifact directory must be private (mode 0700)');
}

function atomicWriteJson(path: string, value: unknown): void {
  assertPrivateDirectory(dirname(path));
  writePrivateJsonMarkerSync(path, value, {
    label: 'inline cleanup artifact', directoryFsync: 'required',
  });
}

function assertRegularDatabase(path: string): string {
  const absolute = resolve(path);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Database must be an existing regular file: ${absolute}`);
  }
  return absolute;
}

function databaseFileIdentity(path: string): DatabaseFileIdentity {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Database must remain an existing regular file: ${path}`);
  }
  return { device: stat.dev, inode: stat.ino };
}

function assertDatabaseFileIdentity(
  path: string,
  expected: DatabaseFileIdentity,
): void {
  const observed = databaseFileIdentity(path);
  if (observed.device !== expected.device || observed.inode !== expected.inode) {
    throw new Error('Database file identity changed during cleanup; refusing replacement path');
  }
}

function companionState(dbPath: string): { wal: boolean; shm: boolean } {
  const wal = existsSync(`${dbPath}-wal`);
  const shm = existsSync(`${dbPath}-shm`);
  if (wal !== shm) throw new Error('SQLite WAL/SHM companion pair is incomplete');
  return { wal, shm };
}

function privateCopy(source: string, target: string): void {
  const sourceStat = lstatSync(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error(`Companion source is not a regular file: ${source}`);
  }
  copyFileSync(source, target, constants.COPYFILE_EXCL);
  chmodSync(target, PRIVATE_FILE_MODE);
  const fileFd = openSync(target, 'r');
  try { fsyncSync(fileFd); } finally { closeSync(fileFd); }
}

function assertTestOnlySeam(active: boolean): void {
  if (active && process.env.NODE_ENV !== 'test') throw new Error('Test-only cleanup seam is unavailable');
}

function normalizeBackup(path: string): string {
  chmodSync(path, PRIVATE_FILE_MODE);
  const raw = new DatabaseSync(path);
  try {
    raw.exec('PRAGMA journal_mode=DELETE');
    const result = raw.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    if (result.integrity_check !== 'ok') throw new Error(`integrity_check=${result.integrity_check}`);
  } finally { raw.close(); }
  chmodSync(path, PRIVATE_FILE_MODE);
  return hashCleanupFile(path);
}

async function backupConnection(
  source: DatabaseSync,
  targetPath: string,
  testOnlyDuringBackup?: () => void,
): Promise<string> {
  if (existsSync(targetPath)) throw new Error(`Backup already exists: ${targetPath}`);
  const temporary = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  let injected = false;
  try {
    await backup(source, temporary, {
      rate: testOnlyDuringBackup ? 1 : 128,
      progress: testOnlyDuringBackup ? () => {
        if (!injected) {
          injected = true;
          testOnlyDuringBackup();
        }
      } : undefined,
    });
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw new Error(`Database backup creation failed: ${(error as Error).message}`);
  }
  try {
    const fingerprint = normalizeBackup(temporary);
    const fileFd = openSync(temporary, 'r');
    try { fsyncSync(fileFd); } finally { closeSync(fileFd); }
    renameSync(temporary, targetPath);
    const dirFd = openSync(dirname(targetPath), 'r');
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    return fingerprint;
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw new Error(`Database backup is not readable: ${(error as Error).message}`);
  }
}

async function consistentBackup(sourcePath: string, targetPath: string, immutable = false): Promise<string> {
  const sourceUrl = pathToFileURL(sourcePath);
  sourceUrl.searchParams.set('mode', 'ro');
  if (immutable) sourceUrl.searchParams.set('immutable', '1');
  const source = new DatabaseSync(sourceUrl.href, { timeout: 250 });
  try { return await backupConnection(source, targetPath); }
  finally { source.close(); }
}

function assertReadableDatabase(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Backup is not a readable regular file: ${path}`);
  const raw = new DatabaseSync(path, { readOnly: true });
  try {
    const result = raw.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    if (result.integrity_check !== 'ok') throw new Error(`integrity_check=${result.integrity_check}`);
  } finally {
    raw.close();
  }
}

function dataVersion(raw: DatabaseSync): number {
  return (raw.prepare('PRAGMA data_version').get() as { data_version: number }).data_version;
}

function schemaVersion(raw: DatabaseSync): number {
  const table = raw.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
  ).get();
  if (!table) throw new Error('Database has no schema_migrations table');
  const row = raw.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null };
  if (row.version !== CURRENT_SCHEMA_MIGRATION) {
    throw new Error(`Database schema ${row.version ?? 'none'} does not match required ${CURRENT_SCHEMA_MIGRATION}`);
  }
  return row.version;
}

function originEvents(raw: DatabaseSync): Map<number, OriginEventRow[]> {
  const rows = raw.prepare(`
    SELECT id, bead_id, event_type, payload_json, actor, source_message_pk, created_at
    FROM bead_events
    WHERE event_type = 'status_change'
    ORDER BY bead_id, id
  `).all() as unknown as OriginEventRow[];
  const result = new Map<number, OriginEventRow[]>();
  for (const row of rows) {
    if (!isCanonicalSourcePayload(row.payload_json)) continue;
    const list = result.get(row.bead_id) ?? [];
    list.push(row);
    result.set(row.bead_id, list);
  }
  return result;
}

function inlineStatusEventCounts(raw: DatabaseSync): Map<number, number> {
  const rows = raw.prepare(`
    SELECT bead_id, COUNT(*) AS count FROM bead_events
    WHERE actor='inline' AND event_type='status_change'
    GROUP BY bead_id
  `).all() as Array<{ bead_id: number; count: number }>;
  return new Map(rows.map((row) => [row.bead_id, row.count]));
}

function sameCounts(left: RetainedValidCounts, right: RetainedValidCounts): boolean {
  return stableJson(left) === stableJson(right);
}

function inspectSnapshot(raw: DatabaseSync, classifier: Classifier, cutoffAt = Math.floor(Date.now() / 1000)): {
  candidates: CleanupCandidate[];
  retainedValid: RetainedValidCounts;
} {
  const beads = raw.prepare('SELECT * FROM beads ORDER BY id').all() as unknown as BeadInspectionRow[];
  const events = originEvents(raw);
  const inlineEventCounts = inlineStatusEventCounts(raw);
  const proposed = beads.filter((row) => row.status === 'proposed');
  for (const row of proposed) {
    const exactOrigins = events.get(row.id)?.length ?? 0;
    const allInlineStatusEvents = inlineEventCounts.get(row.id) ?? 0;
    const originActor = events.get(row.id)?.[0]?.actor;
    if (exactOrigins > 1 || (allInlineStatusEvents > 0
      && (exactOrigins !== 1 || allInlineStatusEvents !== 1 || originActor !== 'inline'))) {
      throw new Error(`Ambiguous source events for bead ${row.id}`);
    }
  }
  const inline = proposed.filter((row) => {
    const origins = events.get(row.id) ?? [];
    return origins.length === 1 && origins[0]!.actor === 'inline';
  });
  for (const row of inline) {
    const sources = events.get(row.id) ?? [];
    if (sources.length !== 1 || sources[0]!.source_message_pk !== row.source_message_pk) {
      throw new Error(`Ambiguous source events for bead ${row.id}`);
    }
  }
  const classified = inline.map((row) => ({ row, result: classifier(row.body ?? '') }));
  const admitted = classified.filter((entry) => entry.result.admitted);
  const other = proposed.filter((row) => !inline.some((candidate) => candidate.id === row.id));
  const retainedValid: RetainedValidCounts = {
    admittedInline: admitted.length,
    admittedInlineOverdue: admitted.filter(({ row }) => row.review_by_at !== null && row.review_by_at < cutoffAt).length,
    otherProposed: other.length,
    otherProposedOverdue: other.filter((row) => row.review_by_at !== null && row.review_by_at < cutoffAt).length,
  };
  const candidates = classified.flatMap(({ row, result }): CleanupCandidate[] => {
    if (result.admitted) return [];
    const source = events.get(row.id)![0]!;
    return [{
      id: row.id,
      bodySha256: sha256Bytes(row.body ?? ''),
      identitySha256: candidateIdentityHash(row),
      baselineEventSetSha256: beadEventSetFingerprint(raw, row.id),
      rejectionReason: result.reason,
      sourceEventId: source.id,
      sourceEventType: source.event_type,
      sourceEventPayloadSha256: sha256Bytes(source.payload_json),
      sourceEventActor: source.actor,
      sourceEventMessagePk: source.source_message_pk,
      sourceEventCreatedAt: source.created_at,
      prior: {
        status: 'proposed', createdAt: row.created_at, updatedAt: row.updated_at,
        reviewByAt: row.review_by_at, sourceMessagePk: row.source_message_pk,
        proposalReason: row.proposal_reason, completedAt: null, cancelledAt: null,
      },
    }];
  });
  return { candidates, retainedValid };
}

function assertKnownClassifier(version: string): void {
  if (version !== CLASSIFIER_VERSION) throw new Error(`Unknown classifier version: ${version}`);
}

function candidateIdentityHash(row: BeadInspectionRow): string {
  const { status: _status, updated_at: _updatedAt, completed_at: _completedAt,
    cancelled_at: _cancelledAt, body, ...identity } = row;
  return sha256Bytes(stableJson({ ...identity, bodySha256: sha256Bytes(body ?? '') }));
}

function isNullableSafeInteger(value: unknown): value is number | null {
  return value === null || isNonNegativeSafeInteger(value);
}

function isCleanupCandidate(value: unknown): value is CleanupCandidate {
  if (!isRecord(value) || !hasExactKeys(value, [
    'id', 'bodySha256', 'identitySha256', 'baselineEventSetSha256', 'rejectionReason',
    'sourceEventId', 'sourceEventType', 'sourceEventPayloadSha256',
    'sourceEventActor', 'sourceEventMessagePk', 'sourceEventCreatedAt', 'prior',
  ])) return false;
  if (!isRecord(value.prior) || !hasExactKeys(value.prior, [
    'status', 'createdAt', 'updatedAt', 'reviewByAt', 'sourceMessagePk',
    'proposalReason', 'completedAt', 'cancelledAt',
  ])) return false;
  const prior = value.prior;
  return isNonNegativeSafeInteger(value.id) && value.id > 0
    && isSha256(value.bodySha256)
    && isSha256(value.identitySha256)
    && isSha256(value.baselineEventSetSha256)
    && typeof value.rejectionReason === 'string' && value.rejectionReason.length > 0
    && isNonNegativeSafeInteger(value.sourceEventId) && value.sourceEventId > 0
    && value.sourceEventType === 'status_change'
    && isSha256(value.sourceEventPayloadSha256)
    && value.sourceEventActor === 'inline'
    && isNullableSafeInteger(value.sourceEventMessagePk)
    && isNonNegativeSafeInteger(value.sourceEventCreatedAt)
    && prior.status === 'proposed'
    && isNonNegativeSafeInteger(prior.createdAt)
    && isNonNegativeSafeInteger(prior.updatedAt)
    && isNullableSafeInteger(prior.reviewByAt)
    && isNullableSafeInteger(prior.sourceMessagePk)
    && (typeof prior.proposalReason === 'string' || prior.proposalReason === null)
    && prior.completedAt === null
    && prior.cancelledAt === null
    && value.sourceEventMessagePk === prior.sourceMessagePk;
}

function isCompanionRecord(value: unknown, snapshotFile: string): value is CompanionRecord {
  if (!isRecord(value) || !hasExactKeys(value, ['present', 'sha256', 'size', 'snapshotFile'])
    || typeof value.present !== 'boolean') return false;
  if (!value.present) {
    return value.sha256 === null && value.size === null && value.snapshotFile === null;
  }
  return isSha256(value.sha256)
    && isNonNegativeSafeInteger(value.size)
    && value.snapshotFile === snapshotFile;
}

function isRetainedValidCounts(value: unknown): value is RetainedValidCounts {
  if (!isRecord(value) || !hasExactKeys(value, [
    'admittedInline', 'admittedInlineOverdue', 'otherProposed', 'otherProposedOverdue',
  ])) return false;
  return isNonNegativeSafeInteger(value.admittedInline)
    && isNonNegativeSafeInteger(value.admittedInlineOverdue)
    && isNonNegativeSafeInteger(value.otherProposed)
    && isNonNegativeSafeInteger(value.otherProposedOverdue)
    && value.admittedInlineOverdue <= value.admittedInline
    && value.otherProposedOverdue <= value.otherProposed;
}

function isManifestDatabase(value: unknown): value is CleanupManifest['database'] {
  if (!isRecord(value) || !hasExactKeys(value, [
    'fingerprint', 'schemaVersion', 'snapshotFile', 'wal', 'shm',
  ])) return false;
  return isSha256(value.fingerprint)
    && value.schemaVersion === CURRENT_SCHEMA_MIGRATION
    && value.snapshotFile === 'database-snapshot.db'
    && isCompanionRecord(value.wal, 'source-wal.provenance')
    && isCompanionRecord(value.shm, 'source-shm.provenance');
}

function assertManifest(value: unknown): CleanupManifest {
  if (!isRecord(value) || !hasExactKeys(value, [
    'formatVersion', 'manifestId', 'classifierVersion', 'createdAt',
    'database', 'retainedValid', 'candidates',
  ])) throw new Error('Invalid cleanup manifest shape');
  const manifest = value as unknown as CleanupManifest;
  if (manifest.formatVersion !== FORMAT_VERSION
    || typeof manifest.classifierVersion !== 'string'
    || !isNonNegativeSafeInteger(manifest.createdAt)
    || !isManifestDatabase(manifest.database)
    || !isRetainedValidCounts(manifest.retainedValid)
    || !Array.isArray(manifest.candidates)) {
    throw new Error('Invalid cleanup manifest format or shape');
  }
  assertKnownClassifier(manifest.classifierVersion);
  if (manifest.candidates.some((candidate) => !isCleanupCandidate(candidate))) {
    throw new Error('Invalid cleanup manifest candidate shape');
  }
  const { manifestId, ...unsigned } = manifest;
  if (!isSha256(manifestId) || manifestIdFor(unsigned) !== manifestId) {
    throw new Error('Cleanup manifest fingerprint is invalid');
  }
  if (new Set(manifest.candidates.map((candidate) => candidate.id)).size !== manifest.candidates.length) {
    throw new Error('Cleanup manifest contains duplicate candidates');
  }
  return manifest;
}

function readJson<T>(path: string): T {
  const maxBytes = basename(path) === 'manifest.json' ? MAX_MANIFEST_BYTES : MAX_RECEIPT_BYTES;
  const text = readPrivateFileSync(path, { label: 'inline cleanup artifact', maxBytes });
  if (text === null) throw new Error(`Required cleanup artifact is missing: ${path}`);
  return JSON.parse(text) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const observed = Object.keys(value).sort();
  const expected = [...keys].sort();
  return observed.length === expected.length
    && observed.every((key, index) => key === expected[index]);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function receiptIdFor(receipt: unknown): string {
  return sha256Bytes(stableJson(receipt));
}

function assertApplyReceipt(
  value: unknown,
  manifest: CleanupManifest,
  expectedBackupPath: string,
): ApplyReceipt {
  const keys = [
    'formatVersion', 'manifestId', 'appliedAt', 'affectedCount', 'eventCount',
    'eventIds', 'backupPath', 'backupSha256', 'postFingerprint', 'receiptId',
  ] as const;
  if (!isRecord(value) || !hasExactKeys(value, keys)
    || value.formatVersion !== FORMAT_VERSION
    || value.manifestId !== manifest.manifestId
    || !isNonNegativeSafeInteger(value.appliedAt)
    || value.affectedCount !== manifest.candidates.length
    || value.eventCount !== manifest.candidates.length
    || !Array.isArray(value.eventIds)
    || value.eventIds.length !== manifest.candidates.length
    || value.eventIds.some((id) => !Number.isSafeInteger(id) || id <= 0)
    || new Set(value.eventIds).size !== value.eventIds.length
    || typeof value.backupPath !== 'string'
    || resolve(value.backupPath) !== resolve(expectedBackupPath)
    || !isSha256(value.backupSha256)
    || value.backupSha256 !== manifest.database.fingerprint
    || !isSha256(value.postFingerprint)
    || !isSha256(value.receiptId)) {
    throw new Error('Apply receipt failed strict manifest/database validation');
  }
  const receipt = value as unknown as ApplyReceipt;
  const { receiptId, ...unsigned } = receipt;
  if (receiptId !== receiptIdFor(unsigned)) {
    throw new Error('Apply receipt failed strict manifest/database validation');
  }
  return receipt;
}

function assertRollbackReceipt(value: unknown, manifest: CleanupManifest): RollbackReceipt {
  const keys = [
    'formatVersion', 'manifestId', 'rolledBackAt', 'restoredCount',
    'removedEventCount', 'postFingerprint', 'receiptId',
  ] as const;
  if (!isRecord(value) || !hasExactKeys(value, keys)
    || value.formatVersion !== FORMAT_VERSION
    || value.manifestId !== manifest.manifestId
    || !isNonNegativeSafeInteger(value.rolledBackAt)
    || value.restoredCount !== manifest.candidates.length
    || value.removedEventCount !== manifest.candidates.length
    || !isSha256(value.postFingerprint)
    || !isSha256(value.receiptId)) {
    throw new Error('Rollback receipt failed strict manifest/database validation');
  }
  const receipt = value as unknown as RollbackReceipt;
  const { receiptId, ...unsigned } = receipt;
  if (receiptId !== receiptIdFor(unsigned)) {
    throw new Error('Rollback receipt failed strict manifest/database validation');
  }
  return receipt;
}

function receiptPaths(manifestPath: string): { apply: string; verify: string; rollback: string; backup: string } {
  const dir = dirname(resolve(manifestPath));
  return {
    apply: join(dir, 'apply-receipt.json'),
    verify: join(dir, 'verification-receipt.json'),
    rollback: join(dir, 'rollback-receipt.json'),
    backup: join(dir, 'pre-apply-backup.db'),
  };
}

function openWritable(path: string, expectedIdentity?: DatabaseFileIdentity): DatabaseSync {
  if (expectedIdentity) assertDatabaseFileIdentity(path, expectedIdentity);
  const url = pathToFileURL(assertRegularDatabase(path));
  url.searchParams.set('mode', 'rw');
  const raw = new DatabaseSync(url.href, { timeout: 50 });
  try {
    if (expectedIdentity) assertDatabaseFileIdentity(path, expectedIdentity);
    raw.exec('PRAGMA foreign_keys = ON');
    return raw;
  } catch (error) {
    raw.close();
    throw error;
  }
}

function cleanupEvents(raw: DatabaseSync, manifest: CleanupManifest): CleanupEventRow[] {
  return raw.prepare(`
    SELECT id, bead_id, payload_json, actor, source_message_pk, created_at
    FROM bead_events WHERE actor = ? ORDER BY bead_id, id
  `).all(CLEANUP_ACTOR).filter((row) => {
    try {
      return (JSON.parse((row as { payload_json: string }).payload_json) as Record<string, unknown>).manifest_id
        === manifest.manifestId;
    } catch { return false; }
  }) as unknown as CleanupEventRow[];
}

function assertCandidateEventParity(
  raw: DatabaseSync,
  candidate: CleanupCandidate,
  cleanup: readonly CleanupEventRow[],
  expectedCleanupCount: 0 | 1,
): CleanupEventRow | undefined {
  const sources = (raw.prepare(`
    SELECT id, bead_id, event_type, payload_json, actor, source_message_pk, created_at
    FROM bead_events
    WHERE bead_id = ? AND event_type = 'status_change'
    ORDER BY id
  `).all(candidate.id) as unknown as OriginEventRow[])
    .filter((event) => isCanonicalSourcePayload(event.payload_json));
  const candidateCleanup = cleanup.filter((event) => event.bead_id === candidate.id);
  const source = sources[0];
  if (sources.length !== 1 || candidateCleanup.length !== expectedCleanupCount
    || !source
    || source.id !== candidate.sourceEventId
    || source.bead_id !== candidate.id
    || source.event_type !== candidate.sourceEventType
    || sha256Bytes(source.payload_json) !== candidate.sourceEventPayloadSha256
    || source.actor !== candidate.sourceEventActor
    || source.source_message_pk !== candidate.sourceEventMessagePk
    || source.created_at !== candidate.sourceEventCreatedAt
    || beadEventSetFingerprint(
      raw,
      candidate.id,
      new Set(candidateCleanup.map((event) => event.id)),
    ) !== candidate.baselineEventSetSha256) {
    throw new Error(`Source event parity for bead ${candidate.id} drifted; review required`);
  }
  return candidateCleanup[0];
}

function beadEventSetFingerprint(
  raw: DatabaseSync,
  beadId: number,
  excludedEventIds: ReadonlySet<number> = new Set(),
): string {
  const rows = (raw.prepare('SELECT * FROM bead_events WHERE bead_id = ? ORDER BY id')
    .all(beadId) as Array<Record<string, unknown>>)
    .filter((row) => !excludedEventIds.has(row.id as number));
  return sha256Bytes(stableJson(rows));
}

function withCleanupMutationGuards<T>(
  raw: DatabaseSync,
  manifest: CleanupManifest,
  mode: 'apply' | 'rollback',
  rollbackEventIds: readonly number[],
  appliedAt: number | null,
  action: (enable: () => void) => T,
): T {
  raw.exec(`
    CREATE TEMP TABLE inline_cleanup_candidate_guard (
      bead_id INTEGER PRIMARY KEY
    ) WITHOUT ROWID;
    CREATE TEMP TABLE inline_cleanup_rollback_event_guard (
      event_id INTEGER PRIMARY KEY
    ) WITHOUT ROWID;
    CREATE TEMP TABLE inline_cleanup_guard_config (
      mode TEXT NOT NULL,
      applied_at INTEGER,
      enabled INTEGER NOT NULL DEFAULT 0
    );
  `);
  try {
    const addCandidate = raw.prepare('INSERT INTO inline_cleanup_candidate_guard (bead_id) VALUES (?)');
    for (const candidate of manifest.candidates) addCandidate.run(candidate.id);
    const addEvent = raw.prepare('INSERT INTO inline_cleanup_rollback_event_guard (event_id) VALUES (?)');
    for (const eventId of rollbackEventIds) addEvent.run(eventId);
    raw.prepare('INSERT INTO inline_cleanup_guard_config (mode, applied_at) VALUES (?, ?)').run(mode, appliedAt);
    raw.exec(`
    CREATE TEMP TRIGGER inline_cleanup_block_bead_insert
    BEFORE INSERT ON beads
    WHEN (SELECT enabled FROM inline_cleanup_guard_config) = 1
    BEGIN
      SELECT RAISE(ABORT, 'cleanup guard blocked bead insert');
    END;
    CREATE TEMP TRIGGER inline_cleanup_block_bead_delete
    BEFORE DELETE ON beads
    WHEN (SELECT enabled FROM inline_cleanup_guard_config) = 1
    BEGIN
      SELECT RAISE(ABORT, 'cleanup guard blocked bead delete');
    END;
    CREATE TEMP TRIGGER inline_cleanup_block_unrelated_bead_update
    BEFORE UPDATE ON beads
    WHEN (SELECT enabled FROM inline_cleanup_guard_config) = 1
      AND (NOT EXISTS (
        SELECT 1 FROM inline_cleanup_candidate_guard WHERE bead_id = OLD.id
      ) OR NEW.id != OLD.id)
    BEGIN
      SELECT RAISE(ABORT, 'cleanup guard blocked unrelated bead update');
    END;
    CREATE TEMP TRIGGER inline_cleanup_block_event_update
    BEFORE UPDATE ON bead_events
    WHEN (SELECT enabled FROM inline_cleanup_guard_config) = 1
    BEGIN
      SELECT RAISE(ABORT, 'cleanup guard blocked event update');
    END;
    CREATE TEMP TRIGGER inline_cleanup_block_event_insert
    BEFORE INSERT ON bead_events
    WHEN (SELECT enabled FROM inline_cleanup_guard_config) = 1
      AND ((SELECT mode FROM inline_cleanup_guard_config) != 'apply'
        OR NOT EXISTS (
          SELECT 1 FROM inline_cleanup_candidate_guard WHERE bead_id = NEW.bead_id
        )
        OR NEW.event_type != 'status_change'
        OR NEW.actor != '${CLEANUP_ACTOR}'
        OR NEW.source_message_pk IS NOT NULL
        OR NEW.created_at != (SELECT applied_at FROM inline_cleanup_guard_config)
        OR EXISTS (SELECT 1 FROM bead_events WHERE id = NEW.id))
    BEGIN
      SELECT RAISE(ABORT, 'cleanup guard blocked event insert or collision');
    END;
    CREATE TEMP TRIGGER inline_cleanup_block_event_delete
    BEFORE DELETE ON bead_events
    WHEN (SELECT enabled FROM inline_cleanup_guard_config) = 1
      AND ((SELECT mode FROM inline_cleanup_guard_config) != 'rollback'
        OR NOT EXISTS (
          SELECT 1 FROM inline_cleanup_rollback_event_guard WHERE event_id = OLD.id
        ))
    BEGIN
      SELECT RAISE(ABORT, 'cleanup guard blocked event delete');
    END;
    `);
    const allowedBeadColumns = new Set(mode === 'apply'
      ? ['status', 'updated_at', 'cancelled_at']
      : ['status', 'updated_at', 'completed_at', 'cancelled_at']);
    let enabled = false;
    const enable = (): void => {
      if (enabled) throw new Error('Cleanup mutation guard enabled more than once');
      raw.prepare('UPDATE inline_cleanup_guard_config SET enabled = 1').run();
      raw.setAuthorizer((actionCode, table, column) => {
        if (actionCode === sqliteConstants.SQLITE_INSERT) {
          return mode === 'apply' && table === 'bead_events'
            ? sqliteConstants.SQLITE_OK : sqliteConstants.SQLITE_DENY;
        }
        if (actionCode === sqliteConstants.SQLITE_UPDATE) {
          return table === 'beads' && column !== null && allowedBeadColumns.has(column)
            ? sqliteConstants.SQLITE_OK : sqliteConstants.SQLITE_DENY;
        }
        if (actionCode === sqliteConstants.SQLITE_DELETE) {
          return mode === 'rollback' && table === 'bead_events'
            ? sqliteConstants.SQLITE_OK : sqliteConstants.SQLITE_DENY;
        }
        return sqliteConstants.SQLITE_OK;
      });
      enabled = true;
    };
    try {
      return action(enable);
    } finally {
      if (enabled) raw.setAuthorizer(null);
    }
  } finally {
    raw.exec(`
      DROP TRIGGER IF EXISTS inline_cleanup_block_bead_insert;
      DROP TRIGGER IF EXISTS inline_cleanup_block_bead_delete;
      DROP TRIGGER IF EXISTS inline_cleanup_block_unrelated_bead_update;
      DROP TRIGGER IF EXISTS inline_cleanup_block_event_update;
      DROP TRIGGER IF EXISTS inline_cleanup_block_event_insert;
      DROP TRIGGER IF EXISTS inline_cleanup_block_event_delete;
      DROP TABLE IF EXISTS inline_cleanup_candidate_guard;
      DROP TABLE IF EXISTS inline_cleanup_rollback_event_guard;
      DROP TABLE IF EXISTS inline_cleanup_guard_config;
    `);
  }
}

function assertAppliedMutationState(
  raw: DatabaseSync,
  manifest: CleanupManifest,
  appliedAt: number,
  eventIds: readonly number[],
): void {
  const events = cleanupEvents(raw, manifest);
  if (events.length !== manifest.candidates.length) throw new Error('Cleanup event count drift requires review');
  for (const candidate of manifest.candidates) {
    const row = raw.prepare('SELECT * FROM beads WHERE id = ?').get(candidate.id) as unknown as BeadInspectionRow | undefined;
    const event = assertCandidateEventParity(raw, candidate, events, 1);
    if (!row || row.status !== 'cancelled' || row.cancelled_at !== appliedAt
      || row.updated_at !== appliedAt || sha256Bytes(row.body ?? '') !== candidate.bodySha256
      || candidateIdentityHash(row) !== candidate.identitySha256
      || !event || event.created_at !== appliedAt || event.source_message_pk !== null
      || !eventIds.includes(event.id)) {
      throw new Error(`Cleanup state for bead ${candidate.id} drifted; review required`);
    }
    const payload = JSON.parse(event.payload_json) as Record<string, unknown>;
    if (stableJson(payload) !== stableJson({
      from: 'proposed', to: 'cancelled', rejection_reason: REASON_CODE,
      classifier_version: manifest.classifierVersion, manifest_id: manifest.manifestId,
    })) throw new Error(`Cleanup event for bead ${candidate.id} drifted; review required`);
    const later = raw.prepare('SELECT COUNT(*) AS count FROM bead_events WHERE bead_id = ? AND id > ?')
      .get(candidate.id, event.id) as { count: number };
    if (later.count !== 0) throw new Error(`Later edit on bead ${candidate.id}; review required`);
  }
}

function assertAppliedState(raw: DatabaseSync, manifest: CleanupManifest, receipt: ApplyReceipt): void {
  assertAppliedMutationState(raw, manifest, receipt.appliedAt, receipt.eventIds);
}

function assertRolledBackState(raw: DatabaseSync, manifest: CleanupManifest): void {
  const events = cleanupEvents(raw, manifest);
  if (events.length !== 0) throw new Error('Rollback event state drift requires review');
  for (const candidate of manifest.candidates) {
    assertCandidateEventParity(raw, candidate, events, 0);
    const row = raw.prepare('SELECT * FROM beads WHERE id = ?').get(candidate.id) as unknown as BeadInspectionRow | undefined;
    if (!row || row.status !== candidate.prior.status || row.updated_at !== candidate.prior.updatedAt
      || row.completed_at !== null || row.cancelled_at !== null
      || sha256Bytes(row.body ?? '') !== candidate.bodySha256
      || candidateIdentityHash(row) !== candidate.identitySha256) {
      throw new Error(`Rolled-back bead ${candidate.id} drifted; review required`);
    }
  }
}

function reconstructApplyReceipt(
  raw: DatabaseSync,
  manifest: CleanupManifest,
  backupPath: string,
  postFingerprint: string,
): ApplyReceipt | null {
  if (!existsSync(backupPath)) return null;
  const events = cleanupEvents(raw, manifest);
  if (events.length !== manifest.candidates.length || events.length === 0) return null;
  const appliedAt = events[0]!.created_at;
  if (events.some((event) => event.created_at !== appliedAt)) return null;
  const backupSha256 = hashCleanupFile(backupPath);
  if (backupSha256 !== manifest.database.fingerprint) return null;
  const unsigned: Omit<ApplyReceipt, 'receiptId'> = {
    formatVersion: FORMAT_VERSION, manifestId: manifest.manifestId, appliedAt,
    affectedCount: manifest.candidates.length, eventCount: manifest.candidates.length,
    eventIds: events.map((event) => event.id), backupPath, backupSha256, postFingerprint,
  };
  const receipt: ApplyReceipt = { ...unsigned, receiptId: receiptIdFor(unsigned) };
  try { assertAppliedState(raw, manifest, receipt); } catch { return null; }
  return receipt;
}

export async function planInlineProposalCleanup(options: PlanOptions): Promise<{
  manifest: CleanupManifest; manifestPath: string; snapshotPath: string;
}> {
  const dbPath = assertRegularDatabase(options.dbPath);
  const artifactDir = resolve(options.artifactDir);
  assertPrivateDirectory(artifactDir);
  assertTestOnlySeam(Boolean(options.classifier || options.testOnlyFault));
  const classifierVersion = options.classifierVersion ?? CLASSIFIER_VERSION;
  assertKnownClassifier(classifierVersion);
  if (options.classifier && (process.env.NODE_ENV !== 'test' || !options.expectedRetainedValid)) {
    throw new Error('Classifier override is restricted to retained-valid test controls');
  }
  const classifier = options.classifier ?? classifyInlineImperative;
  const companionsBefore = companionState(dbPath);
  const walBefore = companionsBefore.wal ? hashCleanupFile(`${dbPath}-wal`) : null;
  const snapshotPath = join(artifactDir, 'database-snapshot.db');
  const manifestPath = join(artifactDir, 'manifest.json');
  const owned: string[] = [];
  try {
    if (existsSync(manifestPath)) throw new Error(`Artifact already exists: ${manifestPath}`);
    const fingerprint = await consistentBackup(dbPath, snapshotPath, !companionsBefore.wal);
    owned.push(snapshotPath);
    const companionsAfter = companionState(dbPath);
    if (stableJson(companionsBefore) !== stableJson(companionsAfter)) {
      throw new Error('SQLite companion state changed during snapshot');
    }
    if (walBefore !== null && hashCleanupFile(`${dbPath}-wal`) !== walBefore) {
      throw new Error('SQLite WAL changed during snapshot');
    }
    const companion = (suffix: '-wal' | '-shm', present: boolean): CompanionRecord => {
      if (!present) return { present: false, sha256: null, size: null, snapshotFile: null };
      if (options.testOnlyFault === 'companion') throw new Error('Injected companion copy failure');
      const source = `${dbPath}${suffix}`;
      const target = join(artifactDir, suffix === '-wal' ? 'source-wal.provenance' : 'source-shm.provenance');
      privateCopy(source, target);
      owned.push(target);
      if (suffix === '-wal' && (hashCleanupFile(source) !== walBefore || hashCleanupFile(target) !== walBefore)) {
        throw new Error('SQLite WAL changed during provenance capture');
      }
      return { present: true, sha256: hashCleanupFile(target), size: statSync(target).size, snapshotFile: basename(target) };
    };
    const createdAt = Math.floor(Date.now() / 1000);
    const raw = new DatabaseSync(snapshotPath, { readOnly: true });
    let inspected: ReturnType<typeof inspectSnapshot>;
    let version: number;
    try {
      version = schemaVersion(raw);
      inspected = inspectSnapshot(raw, classifier, createdAt);
    } finally { raw.close(); }
    if (options.expectedRetainedValid && !sameCounts(inspected.retainedValid, options.expectedRetainedValid)) {
      throw new Error('Retained-valid drift detected by classifier control');
    }
    const unsigned: Omit<CleanupManifest, 'manifestId'> = {
      formatVersion: FORMAT_VERSION,
      classifierVersion,
      createdAt,
      database: {
        fingerprint, schemaVersion: version, snapshotFile: basename(snapshotPath),
        wal: companion('-wal', companionsAfter.wal), shm: companion('-shm', companionsAfter.shm),
      },
      retainedValid: inspected.retainedValid,
      candidates: inspected.candidates,
    };
    const manifest: CleanupManifest = { ...unsigned, manifestId: manifestIdFor(unsigned) };
    if (options.testOnlyFault === 'manifest') throw new Error('Injected manifest write failure');
    atomicWriteJson(manifestPath, manifest);
    owned.push(manifestPath);
    return { manifest, manifestPath, snapshotPath };
  } catch (error) {
    for (const path of owned.reverse()) {
      if (existsSync(path)) unlinkSync(path);
    }
    throw error;
  }
}

async function currentFingerprint(
  dbPath: string,
  scratchPath: string,
  source?: DatabaseSync,
): Promise<string> {
  if (existsSync(scratchPath)) unlinkSync(scratchPath);
  try {
    if (source) return await backupConnection(source, scratchPath);
    const companions = companionState(dbPath);
    return await consistentBackup(dbPath, scratchPath, !companions.wal);
  }
  finally { if (existsSync(scratchPath)) unlinkSync(scratchPath); }
}

function assertApplyBackup(receipt: ApplyReceipt, manifest: CleanupManifest): void {
  try {
    assertReadableDatabase(receipt.backupPath);
    if (hashCleanupFile(receipt.backupPath) !== receipt.backupSha256
      || receipt.backupSha256 !== manifest.database.fingerprint) {
      throw new Error('backup fingerprint mismatch');
    }
  } catch {
    throw new Error('Apply receipt failed strict manifest/database validation');
  }
}

function writeReceiptBound(
  receiptPath: string,
  receipt: unknown,
  label: 'apply' | 'rollback',
  dbPath: string,
  expectedIdentity: DatabaseFileIdentity,
): void {
  assertDatabaseFileIdentity(dbPath, expectedIdentity);
  atomicWriteJson(receiptPath, receipt);
  try {
    assertDatabaseFileIdentity(dbPath, expectedIdentity);
  } catch (error) {
    deletePrivateFileSync(receiptPath, `inline cleanup ${label} receipt`);
    throw error;
  }
}

export async function applyInlineProposalCleanup(options: CleanupCommandOptions): Promise<ApplyReceipt & {
  receiptPath: string; replayed: boolean;
}> {
  const manifestPath = resolve(options.manifestPath);
  const manifest = assertManifest(readJson(manifestPath));
  const dbPath = assertRegularDatabase(options.dbPath);
  const paths = receiptPaths(manifestPath);
  assertTestOnlySeam(Boolean(options.testOnlyAfterFingerprint || options.testOnlyDuringFingerprint
    || options.testOnlyUnderLockFault || options.testOnlyAfterMutation || options.testOnlyFault));
  if (existsSync(paths.apply)) {
    const receipt = assertApplyReceipt(readJson(paths.apply), manifest, paths.backup);
    const raw = new DatabaseSync(dbPath, { readOnly: true });
    try { assertAppliedState(raw, manifest, receipt); } finally { raw.close(); }
    assertApplyBackup(receipt, manifest);
    return { ...receipt, receiptPath: paths.apply, replayed: true };
  }
  const expectedIdentity = databaseFileIdentity(dbPath);
  const observer = new DatabaseSync(dbPath, { readOnly: true, timeout: 250 });
  try { assertDatabaseFileIdentity(dbPath, expectedIdentity); }
  catch (error) { observer.close(); throw error; }
  const scratch = join(dirname(manifestPath), '.apply-fingerprint.db');
  let observedFingerprint: string;
  const dataVersionBeforeBackup = dataVersion(observer);
  const backupPreexisting = existsSync(paths.backup);
  const fingerprintTarget = backupPreexisting ? scratch : paths.backup;
  try {
    observedFingerprint = backupPreexisting
      ? await backupConnection(observer, scratch, options.testOnlyDuringFingerprint)
      : await backupConnection(observer, paths.backup, options.testOnlyDuringFingerprint);
  } catch (error) { observer.close(); throw error; }
  try { assertDatabaseFileIdentity(dbPath, expectedIdentity); }
  catch (error) {
    observer.close();
    if (existsSync(fingerprintTarget) && !backupPreexisting) unlinkSync(fingerprintTarget);
    throw error;
  }
  const dataVersionAfterBackup = dataVersion(observer);
  if (dataVersionAfterBackup !== dataVersionBeforeBackup) {
    observer.close();
    if (existsSync(fingerprintTarget) && !backupPreexisting) unlinkSync(fingerprintTarget);
    else if (existsSync(scratch)) unlinkSync(scratch);
    throw new Error('Database changed while the cleanup backup was created');
  }
  try {
    options.testOnlyAfterFingerprint?.();
    assertDatabaseFileIdentity(dbPath, expectedIdentity);
  } catch (error) {
    observer.close();
    if (existsSync(scratch)) unlinkSync(scratch);
    throw error;
  }
  if (observedFingerprint !== manifest.database.fingerprint) {
    try {
      const recovered = reconstructApplyReceipt(observer, manifest, paths.backup, observedFingerprint);
      if (recovered) {
        if (options.testOnlyFault === 'apply-receipt') throw new Error('Injected apply receipt write failure');
        writeReceiptBound(paths.apply, recovered, 'apply', dbPath, expectedIdentity);
        return { ...recovered, receiptPath: paths.apply, replayed: true };
      }
    } finally {
      observer.close();
      if (existsSync(scratch)) unlinkSync(scratch);
      if (!backupPreexisting && existsSync(paths.backup)) unlinkSync(paths.backup);
    }
    throw new Error('Database fingerprint is stale; create a new cleanup plan');
  }
  let backupSha256 = observedFingerprint;
  let observedDataVersion: number;
  let raw: DatabaseSync;
  try {
    if (backupPreexisting) {
      assertReadableDatabase(paths.backup);
      backupSha256 = hashCleanupFile(paths.backup);
      if (backupSha256 !== manifest.database.fingerprint) throw new Error('Existing pre-apply backup is stale');
      unlinkSync(scratch);
    } else {
      assertReadableDatabase(paths.backup);
      backupSha256 = hashCleanupFile(paths.backup);
      if (backupSha256 !== manifest.database.fingerprint) throw new Error('Pre-apply backup fingerprint drifted');
    }
    observedDataVersion = dataVersionAfterBackup;
    assertDatabaseFileIdentity(dbPath, expectedIdentity);
    raw = openWritable(dbPath, expectedIdentity);
  } catch (error) {
    observer.close();
    if (existsSync(scratch)) unlinkSync(scratch);
    throw error;
  }
  const appliedAt = Math.floor(Date.now() / 1000);
  try {
    schemaVersion(raw);
    const attest = (rows: readonly BeadInspectionRow[]): void => {
      assertDatabaseFileIdentity(dbPath, expectedIdentity);
      if (dataVersion(observer) !== observedDataVersion) {
        throw new Error('Database changed between backup and cleanup write lock');
      }
      options.testOnlyUnderLockFault?.(raw);
      assertDatabaseFileIdentity(dbPath, expectedIdentity);
      if (dataVersion(observer) !== observedDataVersion) {
        throw new Error('Database changed under the cleanup write lock');
      }
      const existingCleanup = cleanupEvents(raw, manifest);
      if (existingCleanup.length !== 0) throw new Error('Cleanup event parity drifted under lock');
      for (const candidate of manifest.candidates) {
        assertCandidateEventParity(raw, candidate, existingCleanup, 0);
      }
      rows.forEach((row, index) => {
        const candidate = manifest.candidates[index]!;
        const body = row.body ?? '';
        const classified = classifyInlineImperative(body);
        if (sha256Bytes(body) !== candidate.bodySha256 || classified.admitted
          || classified.reason !== candidate.rejectionReason
          || candidateIdentityHash(row as BeadInspectionRow) !== candidate.identitySha256) {
          throw new Error(`Candidate ${candidate.id} classifier/body drift under lock`);
        }
      });
    };
    const result = manifest.candidates.length === 0
      ? withImmediateTransaction(raw, () => {
        attest([]);
        return { affectedCount: 0, eventCount: 0 };
      })
      : withCleanupMutationGuards(raw, manifest, 'apply', [], appliedAt, (enable) => rejectProposalsBatch(raw, {
        candidates: manifest.candidates.map((candidate) => ({ id: candidate.id, expected: candidate.prior })),
        actor: CLEANUP_ACTOR,
        at: appliedAt,
        audit: { reasonCode: REASON_CODE, classifierVersion: manifest.classifierVersion, manifestId: manifest.manifestId },
        assertExpectedRows: (rows) => {
          attest(rows);
          enable();
        },
        assertMutatedState: (mutation) => {
          if (mutation.affectedCount !== manifest.candidates.length
            || mutation.eventCount !== manifest.candidates.length) {
            throw new Error('Cleanup affected/event counts did not match manifest');
          }
          const events = cleanupEvents(raw, manifest);
          assertAppliedMutationState(raw, manifest, appliedAt, events.map((event) => event.id));
        },
      }));
    if (result.affectedCount !== manifest.candidates.length || result.eventCount !== manifest.candidates.length) {
      throw new Error('Cleanup affected/event counts did not match manifest');
    }
    assertDatabaseFileIdentity(dbPath, expectedIdentity);
    options.testOnlyAfterMutation?.();
    assertDatabaseFileIdentity(dbPath, expectedIdentity);
    const events = cleanupEvents(raw, manifest);
    if (events.length !== manifest.candidates.length) throw new Error('Cleanup event attestation failed');
    const postFingerprint = await currentFingerprint(
      dbPath,
      join(dirname(manifestPath), '.apply-post-fingerprint.db'),
      observer,
    );
    assertDatabaseFileIdentity(dbPath, expectedIdentity);
    const unsigned: Omit<ApplyReceipt, 'receiptId'> = {
      formatVersion: FORMAT_VERSION, manifestId: manifest.manifestId, appliedAt,
      affectedCount: result.affectedCount, eventCount: result.eventCount,
      eventIds: events.map((event) => event.id), backupPath: paths.backup, backupSha256, postFingerprint,
    };
    const receipt: ApplyReceipt = { ...unsigned, receiptId: receiptIdFor(unsigned) };
    assertAppliedState(raw, manifest, receipt);
    if (options.testOnlyFault === 'apply-receipt') throw new Error('Injected apply receipt write failure');
    writeReceiptBound(paths.apply, receipt, 'apply', dbPath, expectedIdentity);
    return { ...receipt, receiptPath: paths.apply, replayed: false };
  } finally { raw.close(); observer.close(); }
}

export async function verifyInlineProposalCleanup(options: CleanupCommandOptions): Promise<{
  integrity: 'ok'; cleanupEventCount: number; candidateCount: number; retainedValid: RetainedValidCounts;
  openOverdueCount: number; receiptPath: string;
}> {
  const manifestPath = resolve(options.manifestPath);
  const manifest = assertManifest(readJson(manifestPath));
  const dbPath = assertRegularDatabase(options.dbPath);
  const paths = receiptPaths(manifestPath);
  if (!existsSync(paths.apply)) throw new Error('Apply receipt is required before verification');
  const applyReceipt = assertApplyReceipt(readJson(paths.apply), manifest, paths.backup);
  assertApplyBackup(applyReceipt, manifest);
  const raw = new DatabaseSync(dbPath, { readOnly: true });
  let retainedValid: RetainedValidCounts;
  let openOverdueCount: number;
  try {
    assertReadableDatabase(dbPath);
    assertAppliedState(raw, manifest, applyReceipt);
    retainedValid = inspectSnapshot(raw, classifyInlineImperative, manifest.createdAt).retainedValid;
    if (!sameCounts(retainedValid, manifest.retainedValid)) throw new Error('Retained-valid count drift');
    openOverdueCount = (raw.prepare(`
      SELECT COUNT(*) AS count FROM beads
      WHERE status='proposed' AND review_by_at IS NOT NULL AND review_by_at < ?
    `).get(Math.floor(Date.now() / 1000)) as { count: number }).count;
  } finally { raw.close(); }
  const receipt = {
    formatVersion: FORMAT_VERSION, manifestId: manifest.manifestId,
    verifiedAt: Math.floor(Date.now() / 1000), integrity: 'ok' as const,
    cleanupEventCount: manifest.candidates.length, candidateCount: manifest.candidates.length,
    retainedValid, openOverdueCount,
  };
  atomicWriteJson(paths.verify, receipt);
  return { ...receipt, receiptPath: paths.verify };
}

export async function rollbackInlineProposalCleanup(options: CleanupCommandOptions): Promise<RollbackReceipt & {
  receiptPath: string; replayed: boolean;
}> {
  const manifestPath = resolve(options.manifestPath);
  const manifest = assertManifest(readJson(manifestPath));
  const dbPath = assertRegularDatabase(options.dbPath);
  const paths = receiptPaths(manifestPath);
  assertTestOnlySeam(Boolean(options.testOnlyAfterFingerprint || options.testOnlyDuringFingerprint
    || options.testOnlyUnderLockFault || options.testOnlyAfterMutation || options.testOnlyFault));
  if (existsSync(paths.rollback)) {
    const receipt = assertRollbackReceipt(readJson(paths.rollback), manifest);
    const raw = new DatabaseSync(dbPath, { readOnly: true });
    try { assertRolledBackState(raw, manifest); } finally { raw.close(); }
    return { ...receipt, receiptPath: paths.rollback, replayed: true };
  }
  if (!existsSync(paths.apply)) throw new Error('Apply receipt is required before rollback');
  const applyReceipt = assertApplyReceipt(readJson(paths.apply), manifest, paths.backup);
  assertApplyBackup(applyReceipt, manifest);
  const expectedIdentity = databaseFileIdentity(dbPath);
  const observer = new DatabaseSync(dbPath, { readOnly: true, timeout: 250 });
  try { assertDatabaseFileIdentity(dbPath, expectedIdentity); }
  catch (error) { observer.close(); throw error; }
  const observedDataVersion = dataVersion(observer);
  let alreadyRolledBack = false;
  try {
    assertRolledBackState(observer, manifest);
    alreadyRolledBack = true;
  } catch { /* Expected before the first rollback. */ }
  if (alreadyRolledBack) {
    try {
      assertDatabaseFileIdentity(dbPath, expectedIdentity);
      const postFingerprint = await currentFingerprint(
        dbPath,
        join(dirname(manifestPath), '.rollback-recovery-fingerprint.db'),
        observer,
      );
      assertDatabaseFileIdentity(dbPath, expectedIdentity);
      const unsigned: Omit<RollbackReceipt, 'receiptId'> = {
        formatVersion: FORMAT_VERSION, manifestId: manifest.manifestId,
        rolledBackAt: Math.floor(Date.now() / 1000), restoredCount: manifest.candidates.length,
        removedEventCount: manifest.candidates.length, postFingerprint,
      };
      const recovered: RollbackReceipt = { ...unsigned, receiptId: receiptIdFor(unsigned) };
      if (options.testOnlyFault === 'rollback-receipt') throw new Error('Injected rollback receipt write failure');
      writeReceiptBound(paths.rollback, recovered, 'rollback', dbPath, expectedIdentity);
      return { ...recovered, receiptPath: paths.rollback, replayed: true };
    } finally { observer.close(); }
  }
  let raw: DatabaseSync;
  try { raw = openWritable(dbPath, expectedIdentity); }
  catch (error) { observer.close(); throw error; }
  try {
    const guardedCleanup = cleanupEvents(raw, manifest);
    withCleanupMutationGuards(
      raw,
      manifest,
      'rollback',
      guardedCleanup.map((event) => event.id),
      null,
      (enable) => withImmediateTransaction(raw, () => {
      assertDatabaseFileIdentity(dbPath, expectedIdentity);
      if (dataVersion(observer) !== observedDataVersion) {
        throw new Error('Database changed between rollback inspection and write lock');
      }
      options.testOnlyUnderLockFault?.(raw);
      assertDatabaseFileIdentity(dbPath, expectedIdentity);
      if (dataVersion(observer) !== observedDataVersion) {
        throw new Error('Database changed under the rollback write lock');
      }
      enable();
      assertAppliedState(raw, manifest, applyReceipt);
      const cleanup = cleanupEvents(raw, manifest);
      const update = raw.prepare(`
        UPDATE beads SET status='proposed', updated_at=?, completed_at=NULL, cancelled_at=NULL
        WHERE id=? AND status='cancelled' AND updated_at=? AND cancelled_at=?
      `);
      const removeEvent = raw.prepare('DELETE FROM bead_events WHERE id=? AND bead_id=?');
      for (const candidate of manifest.candidates) {
        const event = cleanup.find((entry) => entry.bead_id === candidate.id)!;
        if (update.run(candidate.prior.updatedAt, candidate.id, applyReceipt.appliedAt, applyReceipt.appliedAt).changes !== 1) {
          throw new Error(`Rollback row ${candidate.id} changed; review required`);
        }
        if (removeEvent.run(event.id, candidate.id).changes !== 1) {
          throw new Error(`Rollback event ${event.id} changed; review required`);
        }
      }
      assertRolledBackState(raw, manifest);
      }),
    );
    assertDatabaseFileIdentity(dbPath, expectedIdentity);
    options.testOnlyAfterMutation?.();
    assertDatabaseFileIdentity(dbPath, expectedIdentity);
    const postFingerprint = await currentFingerprint(
      dbPath,
      join(dirname(manifestPath), '.rollback-post-fingerprint.db'),
      observer,
    );
    assertDatabaseFileIdentity(dbPath, expectedIdentity);
    const unsigned: Omit<RollbackReceipt, 'receiptId'> = {
      formatVersion: FORMAT_VERSION, manifestId: manifest.manifestId,
      rolledBackAt: Math.floor(Date.now() / 1000), restoredCount: manifest.candidates.length,
      removedEventCount: manifest.candidates.length, postFingerprint,
    };
    const receipt: RollbackReceipt = { ...unsigned, receiptId: receiptIdFor(unsigned) };
    if (options.testOnlyFault === 'rollback-receipt') throw new Error('Injected rollback receipt write failure');
    writeReceiptBound(paths.rollback, receipt, 'rollback', dbPath, expectedIdentity);
    return { ...receipt, receiptPath: paths.rollback, replayed: false };
  } finally { raw.close(); observer.close(); }
}

interface CliArgs { command: 'plan' | 'apply' | 'verify' | 'rollback'; dbPath: string; artifactDir?: string; manifestPath?: string }

const MAX_CLI_ERROR_BYTES = 256;
const CLI_BARE_PHONE = /(?<!\d)\+?\d{10,16}(?!\d)/g;

function boundedCliError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = redactBotErrorsText(raw)
    .replace(CLI_BARE_PHONE, '[REDACTED PHONE]')
    .replace(/\s+/g, ' ')
    .trim() || 'unknown cleanup failure';
  let result = '';
  for (const character of redacted) {
    if (Buffer.byteLength(result + character, 'utf8') > MAX_CLI_ERROR_BYTES) return `${result}…`;
    result += character;
  }
  return result;
}

export function parseCleanupArgs(argv: readonly string[]): CliArgs {
  const [command, ...rest] = argv;
  if (!['plan', 'apply', 'verify', 'rollback'].includes(command ?? '')) {
    throw new Error('Usage: inline-proposal-cleanup <plan|apply|verify|rollback> --db PATH (--artifact-dir DIR | --manifest PATH)');
  }
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!['--db', '--artifact-dir', '--manifest'].includes(flag ?? '') || !value || value.startsWith('--')) {
      throw new Error('Invalid or missing CLI argument');
    }
    if (values.has(flag!)) throw new Error(`Duplicate argument: ${flag}`);
    values.set(flag!, value);
  }
  const dbPath = values.get('--db');
  if (!dbPath) throw new Error('--db is required');
  if (command === 'plan') {
    const artifactDir = values.get('--artifact-dir');
    if (!artifactDir || values.has('--manifest')) throw new Error('plan requires --artifact-dir and forbids --manifest');
    return { command, dbPath, artifactDir };
  }
  const manifestPath = values.get('--manifest');
  if (!manifestPath || values.has('--artifact-dir')) throw new Error(`${command} requires --manifest and forbids --artifact-dir`);
  return { command: command as CliArgs['command'], dbPath, manifestPath };
}

export async function runCleanupCli(argv: readonly string[], io: {
  out: (text: string) => void; err: (text: string) => void;
} = { out: (text) => stdout.write(text), err: (text) => stderr.write(text) }): Promise<number> {
  try {
    const args = parseCleanupArgs(argv);
    let result: unknown;
    if (args.command === 'plan') result = await planInlineProposalCleanup({ dbPath: args.dbPath, artifactDir: args.artifactDir! });
    else if (args.command === 'apply') result = await applyInlineProposalCleanup({ dbPath: args.dbPath, manifestPath: args.manifestPath! });
    else if (args.command === 'verify') result = await verifyInlineProposalCleanup({ dbPath: args.dbPath, manifestPath: args.manifestPath! });
    else result = await rollbackInlineProposalCleanup({ dbPath: args.dbPath, manifestPath: args.manifestPath! });
    io.out(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    io.err(`inline-proposal-cleanup: ${boundedCliError(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCleanupCli(process.argv.slice(2));
}
