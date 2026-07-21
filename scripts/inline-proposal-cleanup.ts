#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  chmodSync, closeSync, constants, copyFileSync, existsSync, fstatSync, fsyncSync,
  lstatSync, openSync, readSync, renameSync, statSync, unlinkSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { stderr, stdout } from 'node:process';
import { backup, DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { CURRENT_SCHEMA_MIGRATION } from '../src/core/database-schema-version.ts';
import { withImmediateTransaction } from '../src/core/db-tx.ts';
import {
  assertPrivateDirectorySync,
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
const FORMAT_VERSION = 1;
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
  rejectionReason: string;
  sourceEventId: number;
  sourceEventMessagePk: number | null;
  prior: CandidateState;
}

interface CompanionRecord {
  present: boolean;
  sha256: string | null;
  size: number | null;
  snapshotFile: string | null;
}

export interface CleanupManifest {
  formatVersion: 1;
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
  /** Test-only deterministic receipt fault. */
  testOnlyFault?: 'apply-receipt' | 'rollback-receipt';
}

interface ApplyReceipt {
  formatVersion: 1;
  manifestId: string;
  appliedAt: number;
  affectedCount: number;
  eventCount: number;
  eventIds: number[];
  backupPath: string;
  backupSha256: string;
  postFingerprint: string;
}

interface RollbackReceipt {
  formatVersion: 1;
  manifestId: string;
  rolledBackAt: number;
  restoredCount: number;
  removedEventCount: number;
  postFingerprint: string;
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
  payload_json: string;
  source_message_pk: number | null;
}

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
    SELECT id, bead_id, payload_json, source_message_pk
    FROM bead_events
    WHERE actor = 'inline' AND event_type = 'status_change'
    ORDER BY bead_id, id
  `).all() as unknown as OriginEventRow[];
  const result = new Map<number, OriginEventRow[]>();
  for (const row of rows) {
    let payload: unknown;
    try { payload = JSON.parse(row.payload_json); } catch { continue; }
    if (stableJson(payload) !== stableJson({ from: null, to: 'proposed' })) continue;
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
    if (allInlineStatusEvents > 0 && (exactOrigins !== 1 || allInlineStatusEvents !== 1)) {
      throw new Error(`Ambiguous source events for bead ${row.id}`);
    }
  }
  const inline = proposed.filter((row) => (events.get(row.id)?.length ?? 0) === 1);
  for (const row of inline) {
    const sources = events.get(row.id) ?? [];
    if (sources.length !== 1 || sources[0]!.source_message_pk !== row.source_message_pk) {
      throw new Error(`Ambiguous source events for bead ${row.id}`);
    }
  }
  const classified = inline.map((row) => ({ row, result: classifier(row.body ?? '') }));
  const admitted = classified.filter((entry) => entry.result.admitted);
  const other = proposed.filter((row) => !events.has(row.id));
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
      rejectionReason: result.reason,
      sourceEventId: source.id,
      sourceEventMessagePk: source.source_message_pk,
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

function assertManifest(value: unknown): CleanupManifest {
  if (value === null || typeof value !== 'object') throw new Error('Invalid cleanup manifest');
  const manifest = value as CleanupManifest;
  assertKnownClassifier(manifest.classifierVersion);
  if (manifest.formatVersion !== FORMAT_VERSION || !Array.isArray(manifest.candidates)) {
    throw new Error('Invalid cleanup manifest format');
  }
  const { manifestId, ...unsigned } = manifest;
  if (!/^[a-f0-9]{64}$/.test(manifestId) || manifestIdFor(unsigned) !== manifestId) {
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

function receiptPaths(manifestPath: string): { apply: string; verify: string; rollback: string; backup: string } {
  const dir = dirname(resolve(manifestPath));
  return {
    apply: join(dir, 'apply-receipt.json'),
    verify: join(dir, 'verification-receipt.json'),
    rollback: join(dir, 'rollback-receipt.json'),
    backup: join(dir, 'pre-apply-backup.db'),
  };
}

function openWritable(path: string): DatabaseSync {
  const url = pathToFileURL(assertRegularDatabase(path));
  url.searchParams.set('mode', 'rw');
  const raw = new DatabaseSync(url.href, { timeout: 50 });
  raw.exec('PRAGMA foreign_keys = ON');
  return raw;
}

function cleanupEvents(raw: DatabaseSync, manifest: CleanupManifest): Array<{
  id: number; bead_id: number; payload_json: string; actor: string; source_message_pk: number | null; created_at: number;
}> {
  return raw.prepare(`
    SELECT id, bead_id, payload_json, actor, source_message_pk, created_at
    FROM bead_events WHERE actor = ? ORDER BY bead_id, id
  `).all(CLEANUP_ACTOR).filter((row) => {
    try {
      return (JSON.parse((row as { payload_json: string }).payload_json) as Record<string, unknown>).manifest_id
        === manifest.manifestId;
    } catch { return false; }
  }) as unknown as ReturnType<typeof cleanupEvents>;
}

function assertAppliedState(raw: DatabaseSync, manifest: CleanupManifest, receipt: ApplyReceipt): void {
  const events = cleanupEvents(raw, manifest);
  if (events.length !== manifest.candidates.length) throw new Error('Cleanup event count drift requires review');
  for (const candidate of manifest.candidates) {
    const row = raw.prepare('SELECT * FROM beads WHERE id = ?').get(candidate.id) as unknown as BeadInspectionRow | undefined;
    const event = events.find((entry) => entry.bead_id === candidate.id);
    if (!row || row.status !== 'cancelled' || row.cancelled_at !== receipt.appliedAt
      || row.updated_at !== receipt.appliedAt || sha256Bytes(row.body ?? '') !== candidate.bodySha256
      || candidateIdentityHash(row) !== candidate.identitySha256
      || !event || event.created_at !== receipt.appliedAt || event.source_message_pk !== null
      || !receipt.eventIds.includes(event.id)) {
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

function assertRolledBackState(raw: DatabaseSync, manifest: CleanupManifest): void {
  if (cleanupEvents(raw, manifest).length !== 0) throw new Error('Rollback event state drift requires review');
  for (const candidate of manifest.candidates) {
    const row = raw.prepare('SELECT * FROM beads WHERE id = ?').get(candidate.id) as unknown as BeadInspectionRow | undefined;
    if (!row || row.status !== candidate.prior.status || row.updated_at !== candidate.prior.updatedAt
      || row.cancelled_at !== null || sha256Bytes(row.body ?? '') !== candidate.bodySha256
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
  const receipt: ApplyReceipt = {
    formatVersion: FORMAT_VERSION, manifestId: manifest.manifestId, appliedAt,
    affectedCount: manifest.candidates.length, eventCount: manifest.candidates.length,
    eventIds: events.map((event) => event.id), backupPath, backupSha256, postFingerprint,
  };
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

async function currentFingerprint(dbPath: string, scratchPath: string): Promise<string> {
  if (existsSync(scratchPath)) unlinkSync(scratchPath);
  const companions = companionState(dbPath);
  try { return await consistentBackup(dbPath, scratchPath, !companions.wal); }
  finally { if (existsSync(scratchPath)) unlinkSync(scratchPath); }
}

export async function applyInlineProposalCleanup(options: CleanupCommandOptions): Promise<ApplyReceipt & {
  receiptPath: string; replayed: boolean;
}> {
  const dbPath = assertRegularDatabase(options.dbPath);
  const manifestPath = resolve(options.manifestPath);
  const manifest = assertManifest(readJson(manifestPath));
  const paths = receiptPaths(manifestPath);
  assertTestOnlySeam(Boolean(options.testOnlyAfterFingerprint || options.testOnlyDuringFingerprint
    || options.testOnlyUnderLockFault || options.testOnlyFault));
  if (existsSync(paths.apply)) {
    const receipt = readJson<ApplyReceipt>(paths.apply);
    const raw = new DatabaseSync(dbPath, { readOnly: true });
    try { assertAppliedState(raw, manifest, receipt); } finally { raw.close(); }
    assertReadableDatabase(receipt.backupPath);
    return { ...receipt, receiptPath: paths.apply, replayed: true };
  }
  const observer = new DatabaseSync(dbPath, { readOnly: true, timeout: 250 });
  const scratch = join(dirname(manifestPath), '.apply-fingerprint.db');
  let observedFingerprint: string;
  const dataVersionBeforeBackup = dataVersion(observer);
  try { observedFingerprint = await backupConnection(observer, scratch, options.testOnlyDuringFingerprint); }
  catch (error) { observer.close(); throw error; }
  const dataVersionAfterBackup = dataVersion(observer);
  if (dataVersionAfterBackup !== dataVersionBeforeBackup) {
    observer.close();
    if (existsSync(scratch)) unlinkSync(scratch);
    throw new Error('Database changed while the cleanup backup was created');
  }
  if (observedFingerprint !== manifest.database.fingerprint) {
    try {
      const inspection = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const recovered = reconstructApplyReceipt(inspection, manifest, paths.backup, observedFingerprint);
        if (recovered) {
          if (options.testOnlyFault === 'apply-receipt') throw new Error('Injected apply receipt write failure');
          atomicWriteJson(paths.apply, recovered);
          return { ...recovered, receiptPath: paths.apply, replayed: true };
        }
      } finally { inspection.close(); }
    } finally {
      observer.close();
      if (existsSync(scratch)) unlinkSync(scratch);
    }
    throw new Error('Database fingerprint is stale; create a new cleanup plan');
  }
  let backupSha256 = observedFingerprint;
  let observedDataVersion: number;
  let raw: DatabaseSync;
  try {
    if (existsSync(paths.backup)) {
      assertReadableDatabase(paths.backup);
      backupSha256 = hashCleanupFile(paths.backup);
      if (backupSha256 !== manifest.database.fingerprint) throw new Error('Existing pre-apply backup is stale');
      unlinkSync(scratch);
    } else {
      renameSync(scratch, paths.backup);
      chmodSync(paths.backup, PRIVATE_FILE_MODE);
    }
    observedDataVersion = dataVersionAfterBackup;
    options.testOnlyAfterFingerprint?.();
    raw = openWritable(dbPath);
  } catch (error) {
    observer.close();
    if (existsSync(scratch)) unlinkSync(scratch);
    throw error;
  }
  const appliedAt = Math.floor(Date.now() / 1000);
  try {
    schemaVersion(raw);
    const attest = (rows: readonly BeadInspectionRow[]): void => {
        if (dataVersion(observer) !== observedDataVersion) {
          throw new Error('Database changed between backup and cleanup write lock');
        }
        options.testOnlyUnderLockFault?.(raw);
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
      : rejectProposalsBatch(raw, {
        candidates: manifest.candidates.map((candidate) => ({ id: candidate.id, expected: candidate.prior })),
        actor: CLEANUP_ACTOR,
        at: appliedAt,
        audit: { reasonCode: REASON_CODE, classifierVersion: manifest.classifierVersion, manifestId: manifest.manifestId },
        assertExpectedRows: attest,
      });
    if (result.affectedCount !== manifest.candidates.length || result.eventCount !== manifest.candidates.length) {
      throw new Error('Cleanup affected/event counts did not match manifest');
    }
    const events = cleanupEvents(raw, manifest);
    if (events.length !== manifest.candidates.length) throw new Error('Cleanup event attestation failed');
    const postFingerprint = await currentFingerprint(dbPath, join(dirname(manifestPath), '.apply-post-fingerprint.db'));
    const receipt: ApplyReceipt = {
      formatVersion: FORMAT_VERSION, manifestId: manifest.manifestId, appliedAt,
      affectedCount: result.affectedCount, eventCount: result.eventCount,
      eventIds: events.map((event) => event.id), backupPath: paths.backup, backupSha256, postFingerprint,
    };
    assertAppliedState(raw, manifest, receipt);
    if (options.testOnlyFault === 'apply-receipt') throw new Error('Injected apply receipt write failure');
    atomicWriteJson(paths.apply, receipt);
    return { ...receipt, receiptPath: paths.apply, replayed: false };
  } finally { raw.close(); observer.close(); }
}

export async function verifyInlineProposalCleanup(options: CleanupCommandOptions): Promise<{
  integrity: 'ok'; cleanupEventCount: number; candidateCount: number; retainedValid: RetainedValidCounts;
  openOverdueCount: number; receiptPath: string;
}> {
  const dbPath = assertRegularDatabase(options.dbPath);
  const manifestPath = resolve(options.manifestPath);
  const manifest = assertManifest(readJson(manifestPath));
  const paths = receiptPaths(manifestPath);
  if (!existsSync(paths.apply)) throw new Error('Apply receipt is required before verification');
  const applyReceipt = readJson<ApplyReceipt>(paths.apply);
  assertReadableDatabase(applyReceipt.backupPath);
  if (hashCleanupFile(applyReceipt.backupPath) !== applyReceipt.backupSha256
    || applyReceipt.backupSha256 !== manifest.database.fingerprint) {
    throw new Error('Backup fingerprint/readability check failed');
  }
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
  const dbPath = assertRegularDatabase(options.dbPath);
  const manifestPath = resolve(options.manifestPath);
  const manifest = assertManifest(readJson(manifestPath));
  const paths = receiptPaths(manifestPath);
  assertTestOnlySeam(Boolean(options.testOnlyAfterFingerprint || options.testOnlyDuringFingerprint
    || options.testOnlyUnderLockFault || options.testOnlyFault));
  if (existsSync(paths.rollback)) {
    const receipt = readJson<RollbackReceipt>(paths.rollback);
    const raw = new DatabaseSync(dbPath, { readOnly: true });
    try { assertRolledBackState(raw, manifest); } finally { raw.close(); }
    return { ...receipt, receiptPath: paths.rollback, replayed: true };
  }
  if (!existsSync(paths.apply)) throw new Error('Apply receipt is required before rollback');
  const applyReceipt = readJson<ApplyReceipt>(paths.apply);
  const inspection = new DatabaseSync(dbPath, { readOnly: true });
  let alreadyRolledBack = false;
  try {
    assertRolledBackState(inspection, manifest);
    alreadyRolledBack = true;
  } catch { /* Expected before the first rollback. */ }
  finally { inspection.close(); }
  if (alreadyRolledBack) {
    const postFingerprint = await currentFingerprint(dbPath, join(dirname(manifestPath), '.rollback-recovery-fingerprint.db'));
    const recovered: RollbackReceipt = {
      formatVersion: FORMAT_VERSION, manifestId: manifest.manifestId,
      rolledBackAt: Math.floor(Date.now() / 1000), restoredCount: manifest.candidates.length,
      removedEventCount: manifest.candidates.length, postFingerprint,
    };
    if (options.testOnlyFault === 'rollback-receipt') throw new Error('Injected rollback receipt write failure');
    atomicWriteJson(paths.rollback, recovered);
    return { ...recovered, receiptPath: paths.rollback, replayed: true };
  }
  const raw = openWritable(dbPath);
  try {
    withImmediateTransaction(raw, () => {
      assertAppliedState(raw, manifest, applyReceipt);
      const update = raw.prepare(`
        UPDATE beads SET status='proposed', updated_at=?, completed_at=NULL, cancelled_at=NULL
        WHERE id=? AND status='cancelled' AND updated_at=? AND cancelled_at=?
      `);
      const removeEvent = raw.prepare('DELETE FROM bead_events WHERE id=? AND bead_id=?');
      for (const candidate of manifest.candidates) {
        const event = cleanupEvents(raw, manifest).find((entry) => entry.bead_id === candidate.id)!;
        if (update.run(candidate.prior.updatedAt, candidate.id, applyReceipt.appliedAt, applyReceipt.appliedAt).changes !== 1) {
          throw new Error(`Rollback row ${candidate.id} changed; review required`);
        }
        if (removeEvent.run(event.id, candidate.id).changes !== 1) {
          throw new Error(`Rollback event ${event.id} changed; review required`);
        }
      }
      assertRolledBackState(raw, manifest);
    });
    const postFingerprint = await currentFingerprint(dbPath, join(dirname(manifestPath), '.rollback-post-fingerprint.db'));
    const receipt: RollbackReceipt = {
      formatVersion: FORMAT_VERSION, manifestId: manifest.manifestId,
      rolledBackAt: Math.floor(Date.now() / 1000), restoredCount: manifest.candidates.length,
      removedEventCount: manifest.candidates.length, postFingerprint,
    };
    if (options.testOnlyFault === 'rollback-receipt') throw new Error('Injected rollback receipt write failure');
    atomicWriteJson(paths.rollback, receipt);
    return { ...receipt, receiptPath: paths.rollback, replayed: false };
  } finally { raw.close(); }
}

interface CliArgs { command: 'plan' | 'apply' | 'verify' | 'rollback'; dbPath: string; artifactDir?: string; manifestPath?: string }

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
      throw new Error(`Invalid or missing CLI argument near ${flag ?? '<end>'}`);
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
    io.err(`inline-proposal-cleanup: ${(error as Error).message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCleanupCli(process.argv.slice(2));
}
