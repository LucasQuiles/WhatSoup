import { createHash } from 'node:crypto';
import {
  constants,
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  type BigIntStats,
  writeFileSync,
} from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { assertNoSecretLike } from '../artifact-redaction.ts';
import { isNonEmptyString } from '../../src/lib/type-guards.ts';
import {
  buildArtifactGraph,
  FORENSIC_RETRIEVAL_CONFIGURATION,
  normalizeRetrievalText,
  parseJsonLines,
  sanitizeEvidenceText,
  summarizeAdaptivePasses,
} from './forensic-retrieval.ts';

export type ForensicHarnessFamily = 'claude' | 'codex' | 'opencode';
export type ForensicQueryMode = 'substring' | 'all_tokens';

export interface ForensicQuery {
  readonly id: string;
  readonly mode: ForensicQueryMode;
  readonly text: string;
}

export type ForensicEvidenceLocator =
  | {
    readonly kind: 'jsonl';
    readonly line: number;
    readonly byte_start: number;
    readonly byte_end: number;
  }
  | {
    readonly kind: 'sqlite-row';
    readonly table: 'session' | 'message' | 'part' | 'session_message';
    readonly row_hash: string;
  };

export interface ForensicEvidenceHit {
  readonly evidence_id: string;
  readonly source_alias: string;
  readonly locator: ForensicEvidenceLocator;
  readonly record_sha256: string;
  readonly matched_query_ids: readonly string[];
  readonly envelope: {
    readonly type: string | null;
    readonly role: string | null;
  };
}

export interface ForensicSearchFinding {
  readonly code: string;
  readonly line?: number | null;
  readonly byte_start?: number;
  readonly byte_end?: number;
}

export interface ForensicHarnessSearchResult {
  readonly schema_version: 'forensic.harness-search.v1';
  readonly family: ForensicHarnessFamily;
  readonly pass: number;
  readonly queries: readonly {
    readonly id: string;
    readonly mode: ForensicQueryMode;
  }[];
  readonly sources: readonly {
    readonly source_alias: string;
    readonly adapter: string;
    readonly identity: {
      readonly bytes: number;
      readonly sha256: string;
      readonly members?: readonly {
        readonly name: 'database' | 'wal' | 'shm';
        readonly bytes: number;
        readonly sha256: string;
      }[];
    };
    readonly records_examined: number;
    readonly matches_observed: number;
    readonly complete: boolean;
    readonly findings: readonly ForensicSearchFinding[];
    readonly hits: readonly ForensicEvidenceHit[];
  }[];
  readonly metrics: {
    readonly sources_examined: number;
    readonly failed_sources: number;
    readonly candidates: number;
    readonly new_evidence: number;
  };
}

export interface ForensicPackageSpec {
  readonly schema_version: 'forensic.package-spec.v1';
  readonly observation_timestamp: string;
  readonly searches: readonly ForensicHarnessSearchResult[];
  readonly conclusions: readonly {
    readonly id: string;
    readonly confidence: 'high' | 'medium' | 'low' | 'unknown';
    readonly statement: string;
    readonly harness_evidence_ids: readonly string[];
    readonly independent_sources: readonly {
      readonly kind: 'git' | 'file' | 'test' | 'database' | 'runtime';
      readonly reference: string;
      readonly sha256: string | null;
    }[];
  }[];
  readonly narrative: readonly {
    readonly id: string;
    readonly at: string;
    readonly summary: string;
    readonly evidence_ids: readonly string[];
  }[];
  readonly analysis: {
    readonly source_assessments: readonly {
      readonly source_alias: string;
      readonly family: ForensicHarnessFamily;
      readonly authority: 'primary-record' | 'supporting';
      readonly freshness: 'current-at-observation' | 'frozen-at-observation' | 'historical' | 'unknown';
      readonly completeness: 'complete' | 'truncated' | 'summarized' | 'potentially-pruned' | 'unknown';
      readonly mutability: 'hash-bound' | 'mutable' | 'unknown';
      readonly provenance: 'raw' | 'snapshot' | 'summary' | 'derived' | 'duplicate';
      readonly access: 'read' | 'absent' | 'inaccessible' | 'rotated';
    }[];
    readonly query_assessments: readonly {
      readonly family: ForensicHarnessFamily;
      readonly pass: number;
      readonly query_id: string;
      readonly useful_evidence_ids: readonly string[];
      readonly false_positive_evidence_ids: readonly string[];
      readonly pivot_query_ids: readonly string[];
      readonly confidence_change: 'increase' | 'decrease' | 'unchanged' | 'unknown';
      readonly note: string;
    }[];
    readonly entity_aliases: readonly {
      readonly canonical: string;
      readonly aliases: readonly string[];
    }[];
    readonly findings: {
      readonly lifecycle_anomalies: readonly EvidenceStatement[];
      readonly contradictions: readonly EvidenceStatement[];
      readonly negative_space: readonly EvidenceStatement[];
      readonly copied_forward_claims: readonly EvidenceStatement[];
    };
    readonly next_searches: readonly { readonly id: string; readonly statement: string }[];
    readonly recommendations: readonly { readonly id: string; readonly statement: string }[];
  };
  readonly state: {
    readonly decisions: readonly { readonly id: string; readonly statement: string }[];
    readonly unknowns: readonly { readonly id: string; readonly statement: string }[];
    readonly falsified_hypotheses: readonly { readonly id: string; readonly statement: string }[];
  };
}

export interface ForensicPackageWriteOptions {
  /**
   * Private, operator-supplied literals that may not appear in the published package.
   * The values are intentionally not copied into package data, manifests, or errors.
   */
  readonly forbiddenTerms?: readonly string[];
}

interface EvidenceStatement {
  readonly id: string;
  readonly statement: string;
  readonly evidence_ids: readonly string[];
}

interface FileMetadata {
  readonly bytes: number;
  readonly mtimeNs: string;
  readonly device: string;
  readonly inode: string;
}

interface FileIdentity extends FileMetadata {
  readonly sha256: string;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SAFE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;
const SAFE_REFERENCE_PATTERN = /^[A-Za-z][A-Za-z0-9._/-]{0,31}:[A-Za-z0-9._/@+-]{1,240}$/u;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;
const REQUIRED_FAMILIES: readonly ForensicHarnessFamily[] = ['claude', 'codex', 'opencode'];
const PACKAGE_DATA_FILES = [
  'analysis.json',
  'evidence.json',
  'narrative.json',
  'query-journal.json',
  'report.md',
  'source-inventory.json',
  'state.json',
] as const;
const PACKAGE_FILES = [...PACKAGE_DATA_FILES, 'manifest.json'].sort();
const SQLITE_TABLES = ['session', 'message', 'part', 'session_message'] as const;
type SqliteTable = typeof SQLITE_TABLES[number];

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function metadataFromStat(stat: BigIntStats): FileMetadata {
  return {
    bytes: Number(stat.size),
    mtimeNs: stat.mtimeNs.toString(),
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
  };
}

function openStableBoundedFile(file: string, maximumBytes: number): {
  descriptor: number;
  metadata: FileMetadata;
} {
  const metadata = fileMetadata(file);
  if (metadata.bytes > maximumBytes) {
    throw new Error(`source exceeds maximum bytes before read: ${metadata.bytes} > ${maximumBytes}`);
  }
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    assertSameMetadata(metadata, metadataFromStat(fstatSync(descriptor, { bigint: true })), 'source');
    return { descriptor, metadata };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function assertStableBoundedFile(
  file: string,
  descriptor: number,
  metadata: FileMetadata,
): void {
  assertSameMetadata(metadata, metadataFromStat(fstatSync(descriptor, { bigint: true })), 'source');
  assertSameMetadata(metadata, fileMetadata(file), 'source');
}

function sha256File(file: string, maximumBytes = Number.MAX_SAFE_INTEGER): string {
  const digest = createHash('sha256');
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  const { descriptor, metadata } = openStableBoundedFile(file, maximumBytes);
  let total = 0;
  try {
    let bytesRead = 0;
    do {
      const remaining = metadata.bytes - total;
      bytesRead = readSync(descriptor, chunk, 0, Math.min(chunk.length, remaining + 1), null);
      total += bytesRead;
      if (total > metadata.bytes) throw new Error('source changed during read');
      if (bytesRead > 0) digest.update(chunk.subarray(0, bytesRead));
    } while (bytesRead > 0);
    if (total !== metadata.bytes) throw new Error('source changed during read');
    assertStableBoundedFile(file, descriptor, metadata);
  } finally {
    closeSync(descriptor);
  }
  return digest.digest('hex');
}

function readStableBoundedFile(file: string, maximumBytes: number): Buffer {
  const { descriptor, metadata } = openStableBoundedFile(file, maximumBytes);
  const bytes = Buffer.allocUnsafe(metadata.bytes + 1);
  let total = 0;
  try {
    while (total < bytes.length) {
      const bytesRead = readSync(descriptor, bytes, total, bytes.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total !== metadata.bytes) throw new Error('source changed during read');
    assertStableBoundedFile(file, descriptor, metadata);
    return bytes.subarray(0, total);
  } finally {
    closeSync(descriptor);
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new TypeError(`${label} has unknown key: ${key}`);
  }
  for (const key of keys) {
    if (!(key in record)) throw new TypeError(`${label} is missing key: ${key}`);
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  return value;
}

function requireId(value: unknown, label: string): string {
  const id = requireString(value, label);
  if (!SAFE_ID_PATTERN.test(id)) throw new TypeError(`${label} must be a bounded portable identifier`);
  return id;
}

function requireSha256(value: unknown, label: string): string {
  const digest = requireString(value, label);
  if (!SHA256_PATTERN.test(digest)) throw new TypeError(`${label} must be a lowercase SHA-256`);
  return digest;
}

function requireTimestamp(value: unknown, label: string): string {
  const timestamp = requireString(value, label);
  if (!ISO_TIMESTAMP_PATTERN.test(timestamp) || !Number.isFinite(Date.parse(timestamp))) {
    throw new TypeError(`${label} must be an RFC 3339 UTC timestamp`);
  }
  return timestamp;
}

function requireInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new TypeError(`${label} must be a safe integer >= ${minimum}`);
  }
  return Number(value);
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean`);
  return value;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new TypeError(`${label} must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function requireUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new TypeError(`${label} must be unique`);
}

function requireSafeStatement(value: unknown, label: string): string {
  const statement = requireString(value, label);
  if (statement.trim().length === 0 || statement.length > 2_000) {
    throw new TypeError(`${label} must be non-empty and at most 2000 characters`);
  }
  return statement;
}

function fileMetadata(file: string): FileMetadata {
  const link = lstatSync(file, { bigint: true });
  if (link.isSymbolicLink()) throw new Error(`source must not be a symlink: ${file}`);
  if (!link.isFile()) throw new Error(`source must be a regular file: ${file}`);
  return {
    bytes: Number(link.size),
    mtimeNs: link.mtimeNs.toString(),
    device: link.dev.toString(),
    inode: link.ino.toString(),
  };
}

function assertSameMetadata(before: FileMetadata, after: FileMetadata, label: string): void {
  if (
    before.bytes !== after.bytes
    || before.mtimeNs !== after.mtimeNs
    || before.device !== after.device
    || before.inode !== after.inode
  ) {
    throw new Error(`${label} changed during read`);
  }
}

function validateQueries(queries: readonly ForensicQuery[]): void {
  if (queries.length === 0) throw new TypeError('queries must not be empty');
  const ids: string[] = [];
  for (const [index, query] of queries.entries()) {
    ids.push(requireId(query.id, `queries[${index}].id`));
    requireEnum(query.mode, ['substring', 'all_tokens'], `queries[${index}].mode`);
    if (query.text.length === 0 || query.text.length > 2_000) {
      throw new TypeError(`queries[${index}].text must be non-empty and bounded`);
    }
  }
  requireUnique(ids, 'query ids');
}

function queryMatches(text: string, query: ForensicQuery): boolean {
  if (query.mode === 'substring') {
    return text.toLocaleLowerCase('en-US').includes(query.text.toLocaleLowerCase('en-US'));
  }
  const haystack = normalizeRetrievalText(text).normalized;
  return normalizeRetrievalText(query.text).tokens.every((token) => haystack.includes(token));
}

function boundedEnvelope(value: unknown): { type: string | null; role: string | null } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { type: null, role: null };
  }
  const record = value as Record<string, unknown>;
  const type = isNonEmptyString(record.type) && record.type.length <= 64 ? record.type : null;
  const role = isNonEmptyString(record.role) && record.role.length <= 32 ? record.role : null;
  return { type, role };
}

function resultMetrics(
  sources: ForensicHarnessSearchResult['sources'],
  priorEvidenceIds: ReadonlySet<string>,
): ForensicHarnessSearchResult['metrics'] {
  const hits = sources.flatMap((source) => source.hits);
  const newEvidenceIds = new Set(hits
    .filter((hit) => !priorEvidenceIds.has(hit.evidence_id))
    .map((hit) => hit.evidence_id));
  return {
    sources_examined: sources.length,
    failed_sources: sources.filter((source) => !source.complete).length,
    candidates: hits.length,
    new_evidence: newEvidenceIds.size,
  };
}

export async function scanJsonlHarnessSource(options: {
  readonly family: 'claude' | 'codex';
  readonly pass: number;
  readonly sourceAlias: string;
  readonly sourcePath: string;
  readonly expectedSha256: string;
  readonly queries: readonly ForensicQuery[];
  readonly priorEvidenceIds?: ReadonlySet<string>;
  readonly limits: {
    readonly maxSourceBytes: number;
    readonly maxRecordBytes: number;
    readonly maxHits: number;
  };
}): Promise<ForensicHarnessSearchResult> {
  requireId(options.sourceAlias, 'sourceAlias');
  requireInteger(options.pass, 'pass', 1);
  requireSha256(options.expectedSha256, 'expectedSha256');
  validateQueries(options.queries);
  requireInteger(options.limits.maxSourceBytes, 'maxSourceBytes', 1);
  requireInteger(options.limits.maxRecordBytes, 'maxRecordBytes', 1);
  requireInteger(options.limits.maxHits, 'maxHits');
  const before = fileMetadata(options.sourcePath);
  if (before.bytes > options.limits.maxSourceBytes) {
    throw new Error(`source exceeds maxSourceBytes before read: ${before.bytes} > ${options.limits.maxSourceBytes}`);
  }
  const input = readStableBoundedFile(options.sourcePath, options.limits.maxSourceBytes);
  const observedSha256 = sha256(input);
  if (observedSha256 !== options.expectedSha256 || input.length !== before.bytes) {
    throw new Error('source identity mismatch before read');
  }
  const terminalNewline = input.length === 0 || input[input.length - 1] === 0x0a;
  const parsed = parseJsonLines(input, {
    sourceId: options.sourceAlias,
    complete: terminalNewline,
    maxBytes: options.limits.maxSourceBytes,
    maxRecordBytes: options.limits.maxRecordBytes,
  });
  const findings: ForensicSearchFinding[] = parsed.findings.map((finding) => ({
    code: finding.code,
    line: finding.line,
    byte_start: finding.byteStart,
    byte_end: finding.byteEnd,
  }));
  const hits: ForensicEvidenceHit[] = [];
  let matchesObserved = 0;
  let hitLimitReported = false;
  for (const record of parsed.records) {
    const rawBytes = input.subarray(record.byteStart, record.byteEnd);
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(rawBytes).trimEnd();
    const matched = options.queries.filter((query) => queryMatches(raw, query));
    if (matched.length === 0) continue;
    matchesObserved += 1;
    if (hits.length >= options.limits.maxHits) {
      if (!hitLimitReported) {
        findings.push({ code: 'FORENSIC_HIT_LIMIT' });
        hitLimitReported = true;
      }
      continue;
    }
    const recordSha256 = sha256(rawBytes);
    hits.push({
      evidence_id: `evidence-${recordSha256}`,
      source_alias: options.sourceAlias,
      locator: {
        kind: 'jsonl',
        line: record.line,
        byte_start: record.byteStart,
        byte_end: record.byteEnd,
      },
      record_sha256: recordSha256,
      matched_query_ids: matched.map((query) => query.id),
      envelope: boundedEnvelope(record.value),
    });
  }
  const after = fileMetadata(options.sourcePath);
  assertSameMetadata(before, after, 'source');
  const complete = parsed.complete && findings.length === 0;
  const sources: ForensicHarnessSearchResult['sources'] = [{
    source_alias: options.sourceAlias,
    adapter: `${options.family}-jsonl`,
    identity: { bytes: before.bytes, sha256: observedSha256 },
    records_examined: parsed.records.length + parsed.findings.length,
    matches_observed: matchesObserved,
    complete,
    findings,
    hits,
  }];
  return {
    schema_version: 'forensic.harness-search.v1',
    family: options.family,
    pass: options.pass,
    queries: options.queries.map(({ id, mode }) => ({ id, mode })),
    sources,
    metrics: resultMetrics(sources, options.priorEvidenceIds ?? new Set()),
  };
}

export async function scanJsonlHarnessSources(options: {
  readonly family: 'claude' | 'codex';
  readonly pass: number;
  readonly sources: readonly {
    readonly alias: string;
    readonly path: string;
    readonly expectedSha256: string;
  }[];
  readonly queries: readonly ForensicQuery[];
  readonly priorEvidenceIds?: ReadonlySet<string>;
  readonly limits: {
    readonly maxSourceBytes: number;
    readonly maxRecordBytes: number;
    readonly maxHits: number;
  };
}): Promise<ForensicHarnessSearchResult> {
  if (options.sources.length === 0) throw new TypeError('sources must not be empty');
  const aliases = options.sources.map((source) => requireId(source.alias, 'source alias'));
  requireUnique(aliases, 'source aliases');
  const sources: ForensicHarnessSearchResult['sources'][number][] = [];
  for (const source of options.sources) {
    const result = await scanJsonlHarnessSource({
      family: options.family,
      pass: options.pass,
      sourceAlias: source.alias,
      sourcePath: source.path,
      expectedSha256: source.expectedSha256,
      queries: options.queries,
      limits: options.limits,
    });
    sources.push(...result.sources);
  }
  return {
    schema_version: 'forensic.harness-search.v1',
    family: options.family,
    pass: options.pass,
    queries: options.queries.map(({ id, mode }) => ({ id, mode })),
    sources,
    metrics: resultMetrics(sources, options.priorEvidenceIds ?? new Set()),
  };
}

function sqliteFamilyMetadataRows(databasePath: string): Array<{
  name: 'database' | 'wal' | 'shm';
  file: string;
  metadata: FileMetadata;
}> {
  const candidates = [
    { name: 'database' as const, file: databasePath },
    { name: 'wal' as const, file: `${databasePath}-wal` },
    { name: 'shm' as const, file: `${databasePath}-shm` },
  ];
  return candidates.filter(({ file }) => existsSync(file)).map(({ name, file }) => ({
    name,
    file,
    metadata: fileMetadata(file),
  }));
}

function sqliteFamilyIdentity(databasePath: string, maximumBytes: number): {
  primary: FileIdentity;
  members: Array<{ name: 'database' | 'wal' | 'shm'; bytes: number; sha256: string }>;
  metadataFingerprint: string;
} {
  const metadataRows = sqliteFamilyMetadataRows(databasePath);
  const totalBytes = metadataRows.reduce((sum, row) => sum + row.metadata.bytes, 0);
  if (totalBytes > maximumBytes) {
    throw new Error(`SQLite source family exceeds maxSourceBytes before identity: ${totalBytes} > ${maximumBytes}`);
  }
  const identities = metadataRows.map(({ name, file, metadata }) => ({
    name,
    identity: { ...metadata, sha256: sha256File(file, metadata.bytes) },
  }));
  const primary = identities[0]?.identity;
  if (!primary) throw new Error('SQLite database source is missing');
  const members = identities.map(({ name, identity }) => ({
    name,
    bytes: identity.bytes,
    sha256: identity.sha256,
  }));
  const metadataFingerprint = sha256(JSON.stringify(identities.map(({ name, identity }) => ({
    name,
    bytes: identity.bytes,
    mtimeNs: identity.mtimeNs,
    device: identity.device,
    inode: identity.inode,
  }))));
  return { primary, members, metadataFingerprint };
}

function sqliteFamilyMetadata(databasePath: string): {
  readonly primary: FileMetadata;
  readonly fingerprint: string;
} {
  const members = sqliteFamilyMetadataRows(databasePath).map(({ name, metadata }) => ({ name, ...metadata }));
  return { primary: members[0]!, fingerprint: sha256(JSON.stringify(members)) };
}

function sqliteContentColumns(table: SqliteTable, columns: ReadonlySet<string>): string[] {
  const candidates: Readonly<Record<SqliteTable, readonly string[]>> = {
    session: ['title'],
    message: ['data'],
    part: ['data'],
    session_message: ['message', 'parts', 'data'],
  };
  return candidates[table].filter((column) => columns.has(column));
}

function createSqliteWorkingCopy(databasePath: string): { root: string; databasePath: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'whatsoup-opencode-forensic-'));
  const copy = path.join(root, 'opencode.db');
  try {
    copyFileSync(databasePath, copy, constants.COPYFILE_FICLONE);
    if (existsSync(`${databasePath}-wal`)) {
      copyFileSync(`${databasePath}-wal`, `${copy}-wal`, constants.COPYFILE_FICLONE);
    }
    return { root, databasePath: copy };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export function scanOpenCodeSnapshot(options: {
  readonly pass: number;
  readonly sourceAlias: string;
  readonly databasePath: string;
  readonly expectedSha256: string;
  readonly expectedMembers?: readonly {
    readonly name: 'database' | 'wal' | 'shm';
    readonly bytes: number;
    readonly sha256: string;
  }[];
  readonly queries: readonly ForensicQuery[];
  readonly priorEvidenceIds?: ReadonlySet<string>;
  readonly limits: {
    readonly maxSourceBytes: number;
    readonly maxRows: number;
    readonly maxHits: number;
  };
}): ForensicHarnessSearchResult {
  requireInteger(options.pass, 'pass', 1);
  requireId(options.sourceAlias, 'sourceAlias');
  requireSha256(options.expectedSha256, 'expectedSha256');
  validateQueries(options.queries);
  requireInteger(options.limits.maxSourceBytes, 'maxSourceBytes', 1);
  requireInteger(options.limits.maxRows, 'maxRows', 1);
  requireInteger(options.limits.maxHits, 'maxHits');
  const before = sqliteFamilyIdentity(options.databasePath, options.limits.maxSourceBytes);
  if (before.primary.sha256 !== options.expectedSha256) {
    throw new Error('source identity mismatch before read');
  }
  if (options.expectedMembers && JSON.stringify(before.members) !== JSON.stringify(options.expectedMembers)) {
    throw new Error('SQLite snapshot family identity mismatch before read');
  }

  const hits: ForensicEvidenceHit[] = [];
  const findings: ForensicSearchFinding[] = [];
  let matchesObserved = 0;
  let recordsExamined = 0;
  let rowLimit = false;
  let hitLimit = false;
  const working = createSqliteWorkingCopy(options.databasePath);
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(working.databasePath, { readOnly: true });
    const quick = database.prepare('PRAGMA quick_check').all() as Array<Record<string, unknown>>;
    if (quick.length !== 1 || Object.values(quick[0] ?? {})[0] !== 'ok') {
      findings.push({ code: 'FORENSIC_SQLITE_QUICK_CHECK_FAILED' });
    }
    const present = new Set((database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all() as Array<{ name: string }>).map((row) => row.name));
    for (const required of ['session', 'message', 'part'] as const) {
      if (!present.has(required)) findings.push({ code: `FORENSIC_SQLITE_REQUIRED_TABLE_MISSING:${required}` });
    }
    outer: for (const table of SQLITE_TABLES) {
      if (!present.has(table)) continue;
      const columnRows = database.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
      const columns = new Set(columnRows.map((row) => row.name));
      const contentColumns = sqliteContentColumns(table, columns);
      if (contentColumns.length === 0) {
        findings.push({ code: `FORENSIC_SQLITE_CONTENT_COLUMN_MISSING:${table}` });
        continue;
      }
      const projection = contentColumns.map((column) => `"${column}"`).join(', ');
      const rows = database.prepare(`SELECT rowid AS _rowid, ${projection} FROM "${table}" ORDER BY rowid`).iterate() as Iterable<Record<string, unknown>>;
      for (const row of rows) {
        if (recordsExamined >= options.limits.maxRows) {
          findings.push({ code: 'FORENSIC_SQLITE_ROW_LIMIT' });
          rowLimit = true;
          break outer;
        }
        recordsExamined += 1;
        const raw = contentColumns.map((column) => {
          const value = row[column];
          return typeof value === 'string' ? value : Buffer.isBuffer(value) ? value.toString('utf8') : '';
        }).join('\n');
        const matched = options.queries.filter((query) => queryMatches(raw, query));
        if (matched.length === 0) continue;
        matchesObserved += 1;
        if (hits.length >= options.limits.maxHits) {
          if (!hitLimit) findings.push({ code: 'FORENSIC_HIT_LIMIT' });
          hitLimit = true;
          continue;
        }
        const recordSha256 = sha256(raw);
        const rowHash = sha256(`${options.sourceAlias}\0${table}\0${String(row._rowid)}`);
        hits.push({
          evidence_id: `evidence-${recordSha256}`,
          source_alias: options.sourceAlias,
          locator: { kind: 'sqlite-row', table, row_hash: rowHash },
          record_sha256: recordSha256,
          matched_query_ids: matched.map((query) => query.id),
          envelope: { type: table, role: null },
        });
      }
    }
  } finally {
    database?.close();
    rmSync(working.root, { recursive: true, force: true });
  }
  const after = sqliteFamilyMetadata(options.databasePath);
  assertSameMetadata(before.primary, after.primary, 'SQLite database');
  if (before.metadataFingerprint !== after.fingerprint) {
    throw new Error('SQLite snapshot family changed during read');
  }
  const complete = findings.length === 0 && !rowLimit && !hitLimit;
  const sources: ForensicHarnessSearchResult['sources'] = [{
    source_alias: options.sourceAlias,
    adapter: 'opencode-sqlite',
    identity: {
      bytes: before.primary.bytes,
      sha256: before.primary.sha256,
      members: before.members,
    },
    records_examined: recordsExamined,
    matches_observed: matchesObserved,
    complete,
    findings,
    hits,
  }];
  return {
    schema_version: 'forensic.harness-search.v1',
    family: 'opencode',
    pass: options.pass,
    queries: options.queries.map(({ id, mode }) => ({ id, mode })),
    sources,
    metrics: resultMetrics(sources, options.priorEvidenceIds ?? new Set()),
  };
}

export function parseForensicHarnessSearchResult(
  value: unknown,
  label = 'search result',
): ForensicHarnessSearchResult {
  const result = asRecord(value, label);
  exactKeys(result, ['schema_version', 'family', 'pass', 'queries', 'sources', 'metrics'], label);
  if (result.schema_version !== 'forensic.harness-search.v1') {
    throw new TypeError(`${label}.schema_version must be forensic.harness-search.v1`);
  }
  const family = requireEnum(result.family, REQUIRED_FAMILIES, `${label}.family`);
  const expectedAdapter = family === 'opencode' ? 'opencode-sqlite' : `${family}-jsonl`;
  const pass = requireInteger(result.pass, `${label}.pass`, 1);
  const queries = requireArray(result.queries, `${label}.queries`).map((value, index) => {
    const query = asRecord(value, `${label}.queries[${index}]`);
    exactKeys(query, ['id', 'mode'], `${label}.queries[${index}]`);
    return {
      id: requireId(query.id, `${label}.queries[${index}].id`),
      mode: requireEnum(query.mode, ['substring', 'all_tokens'], `${label}.queries[${index}].mode`),
    };
  });
  requireUnique(queries.map((query) => query.id), `${label} query ids`);
  const knownQueryIds = new Set(queries.map((query) => query.id));
  const sources = requireArray(result.sources, `${label}.sources`).map((value, index) => {
    const sourceLabel = `${label}.sources[${index}]`;
    const source = asRecord(value, sourceLabel);
    exactKeys(source, [
      'source_alias', 'adapter', 'identity', 'records_examined', 'matches_observed',
      'complete', 'findings', 'hits',
    ], sourceLabel);
    const identity = asRecord(source.identity, `${sourceLabel}.identity`);
    const identityKeys = 'members' in identity ? ['bytes', 'sha256', 'members'] : ['bytes', 'sha256'];
    exactKeys(identity, identityKeys, `${sourceLabel}.identity`);
    const parsedIdentity: ForensicHarnessSearchResult['sources'][number]['identity'] = {
      bytes: requireInteger(identity.bytes, `${sourceLabel}.identity.bytes`),
      sha256: requireSha256(identity.sha256, `${sourceLabel}.identity.sha256`),
      ...('members' in identity ? {
        members: requireArray(identity.members, `${sourceLabel}.identity.members`).map((value, memberIndex) => {
          const member = asRecord(value, `${sourceLabel}.identity.members[${memberIndex}]`);
          exactKeys(member, ['name', 'bytes', 'sha256'], `${sourceLabel}.identity.members[${memberIndex}]`);
          return {
            name: requireEnum(member.name, ['database', 'wal', 'shm'], `${sourceLabel}.identity.members[${memberIndex}].name`),
            bytes: requireInteger(member.bytes, `${sourceLabel}.identity.members[${memberIndex}].bytes`),
            sha256: requireSha256(member.sha256, `${sourceLabel}.identity.members[${memberIndex}].sha256`),
          };
        }),
      } : {}),
    };
    const findings = requireArray(source.findings, `${sourceLabel}.findings`).map((value, findingIndex) => {
      const finding = asRecord(value, `${sourceLabel}.findings[${findingIndex}]`);
      const allowed = ['code', 'line', 'byte_start', 'byte_end'];
      for (const key of Object.keys(finding)) {
        if (!allowed.includes(key)) throw new TypeError(`${sourceLabel}.findings[${findingIndex}] has unknown key: ${key}`);
      }
      return {
        code: requireString(finding.code, `${sourceLabel}.findings[${findingIndex}].code`),
        ...(finding.line !== undefined ? { line: finding.line === null ? null : requireInteger(finding.line, `${sourceLabel}.findings[${findingIndex}].line`, 1) } : {}),
        ...(finding.byte_start !== undefined ? { byte_start: requireInteger(finding.byte_start, `${sourceLabel}.findings[${findingIndex}].byte_start`) } : {}),
        ...(finding.byte_end !== undefined ? { byte_end: requireInteger(finding.byte_end, `${sourceLabel}.findings[${findingIndex}].byte_end`) } : {}),
      };
    });
    const hits = requireArray(source.hits, `${sourceLabel}.hits`).map((value, hitIndex) => {
      const hitLabel = `${sourceLabel}.hits[${hitIndex}]`;
      const hit = asRecord(value, hitLabel);
      exactKeys(hit, [
        'evidence_id', 'source_alias', 'locator', 'record_sha256', 'matched_query_ids', 'envelope',
      ], hitLabel);
      const locator = asRecord(hit.locator, `${hitLabel}.locator`);
      let parsedLocator: ForensicEvidenceLocator;
      if (locator.kind === 'jsonl') {
        exactKeys(locator, ['kind', 'line', 'byte_start', 'byte_end'], `${hitLabel}.locator`);
        parsedLocator = {
          kind: 'jsonl',
          line: requireInteger(locator.line, `${hitLabel}.locator.line`, 1),
          byte_start: requireInteger(locator.byte_start, `${hitLabel}.locator.byte_start`),
          byte_end: requireInteger(locator.byte_end, `${hitLabel}.locator.byte_end`),
        };
      } else if (locator.kind === 'sqlite-row') {
        exactKeys(locator, ['kind', 'table', 'row_hash'], `${hitLabel}.locator`);
        parsedLocator = {
          kind: 'sqlite-row',
          table: requireEnum(locator.table, SQLITE_TABLES, `${hitLabel}.locator.table`),
          row_hash: requireSha256(locator.row_hash, `${hitLabel}.locator.row_hash`),
        };
      } else {
        throw new TypeError(`${hitLabel}.locator.kind is unsupported`);
      }
      if ((family === 'opencode') !== (parsedLocator.kind === 'sqlite-row')) {
        throw new TypeError(`${hitLabel}.locator mismatch for ${family}`);
      }
      const envelope = asRecord(hit.envelope, `${hitLabel}.envelope`);
      exactKeys(envelope, ['type', 'role'], `${hitLabel}.envelope`);
      const nullableBounded = (item: unknown, field: string, maximum: number): string | null => {
        if (item === null) return null;
        const text = requireString(item, field);
        if (text.length > maximum) throw new TypeError(`${field} is too long`);
        return text;
      };
      return {
        evidence_id: requireId(hit.evidence_id, `${hitLabel}.evidence_id`),
        source_alias: requireId(hit.source_alias, `${hitLabel}.source_alias`),
        locator: parsedLocator,
        record_sha256: requireSha256(hit.record_sha256, `${hitLabel}.record_sha256`),
        matched_query_ids: requireArray(hit.matched_query_ids, `${hitLabel}.matched_query_ids`).map((item, queryIndex) =>
          requireId(item, `${hitLabel}.matched_query_ids[${queryIndex}]`)),
        envelope: {
          type: nullableBounded(envelope.type, `${hitLabel}.envelope.type`, 64),
          role: nullableBounded(envelope.role, `${hitLabel}.envelope.role`, 32),
        },
      };
    });
    const sourceAlias = requireId(source.source_alias, `${sourceLabel}.source_alias`);
    const complete = requireBoolean(source.complete, `${sourceLabel}.complete`);
    const recordsExamined = requireInteger(source.records_examined, `${sourceLabel}.records_examined`);
    const matchesObserved = requireInteger(source.matches_observed, `${sourceLabel}.matches_observed`);
    if (complete && findings.length > 0) throw new TypeError(`${sourceLabel} complete source has findings`);
    if (matchesObserved > recordsExamined) throw new TypeError(`${sourceLabel}.matches_observed exceeds records_examined`);
    if (hits.length > matchesObserved) throw new TypeError(`${sourceLabel}.hits exceeds matches_observed`);
    for (const [hitIndex, hit] of hits.entries()) {
      if (hit.evidence_id !== `evidence-${hit.record_sha256}`) {
        throw new TypeError(`${sourceLabel}.hits[${hitIndex}].evidence_id does not match record_sha256`);
      }
      if (hit.source_alias !== sourceAlias) {
        throw new TypeError(`${sourceLabel}.hits[${hitIndex}].source_alias mismatch`);
      }
      for (const queryId of hit.matched_query_ids) {
        if (!knownQueryIds.has(queryId)) {
          throw new TypeError(`${sourceLabel}.hits[${hitIndex}] has unknown matched query: ${queryId}`);
        }
      }
    }
    const adapter = requireId(source.adapter, `${sourceLabel}.adapter`);
    if (adapter !== expectedAdapter) {
      throw new TypeError(`${sourceLabel}.adapter mismatch for ${family}`);
    }
    return {
      source_alias: sourceAlias,
      adapter,
      identity: parsedIdentity,
      records_examined: recordsExamined,
      matches_observed: matchesObserved,
      complete,
      findings,
      hits,
    };
  });
  requireUnique(sources.map((source) => source.source_alias), `${label} source aliases`);
  const metricsRecord = asRecord(result.metrics, `${label}.metrics`);
  exactKeys(metricsRecord, ['sources_examined', 'failed_sources', 'candidates', 'new_evidence'], `${label}.metrics`);
  const metrics = {
    sources_examined: requireInteger(metricsRecord.sources_examined, `${label}.metrics.sources_examined`),
    failed_sources: requireInteger(metricsRecord.failed_sources, `${label}.metrics.failed_sources`),
    candidates: requireInteger(metricsRecord.candidates, `${label}.metrics.candidates`),
    new_evidence: requireInteger(metricsRecord.new_evidence, `${label}.metrics.new_evidence`),
  };
  if (metrics.sources_examined !== sources.length) throw new TypeError(`${label}.metrics.sources_examined mismatch`);
  if (metrics.failed_sources !== sources.filter((source) => !source.complete).length) {
    throw new TypeError(`${label}.metrics.failed_sources mismatch`);
  }
  if (metrics.candidates !== sources.reduce((sum, source) => sum + source.hits.length, 0)) {
    throw new TypeError(`${label}.metrics.candidates mismatch`);
  }
  if (metrics.new_evidence > metrics.candidates) throw new TypeError(`${label}.metrics.new_evidence exceeds candidates`);
  return { schema_version: 'forensic.harness-search.v1', family, pass, queries, sources, metrics };
}

function parseStatementRows(value: unknown, label: string): Array<{ id: string; statement: string }> {
  return requireArray(value, label).map((item, index) => {
    const row = asRecord(item, `${label}[${index}]`);
    exactKeys(row, ['id', 'statement'], `${label}[${index}]`);
    return {
      id: requireId(row.id, `${label}[${index}].id`),
      statement: requireSafeStatement(row.statement, `${label}[${index}].statement`),
    };
  });
}

function parseEvidenceStatementRows(
  value: unknown,
  label: string,
  knownEvidenceIds: ReadonlySet<string>,
): EvidenceStatement[] {
  const rows = requireArray(value, label).map((item, index) => {
    const rowLabel = `${label}[${index}]`;
    const row = asRecord(item, rowLabel);
    exactKeys(row, ['id', 'statement', 'evidence_ids'], rowLabel);
    const evidenceIds = requireArray(row.evidence_ids, `${rowLabel}.evidence_ids`).map((entry, evidenceIndex) =>
      requireId(entry, `${rowLabel}.evidence_ids[${evidenceIndex}]`));
    requireUnique(evidenceIds, `${rowLabel}.evidence_ids`);
    for (const evidenceId of evidenceIds) {
      if (!knownEvidenceIds.has(evidenceId)) {
        throw new TypeError(`${rowLabel} references unknown evidence: ${evidenceId}`);
      }
    }
    return {
      id: requireId(row.id, `${rowLabel}.id`),
      statement: requireSafeStatement(row.statement, `${rowLabel}.statement`),
      evidence_ids: evidenceIds,
    };
  });
  requireUnique(rows.map((row) => row.id), `${label} ids`);
  return rows;
}

export function parseForensicPackageSpec(value: unknown): ForensicPackageSpec {
  const spec = asRecord(value, 'spec');
  exactKeys(spec, [
    'schema_version', 'observation_timestamp', 'searches', 'conclusions', 'narrative', 'analysis', 'state',
  ], 'spec');
  if (spec.schema_version !== 'forensic.package-spec.v1') {
    throw new TypeError('spec.schema_version must be forensic.package-spec.v1');
  }
  const searches = requireArray(spec.searches, 'spec.searches').map((item, index) =>
    parseForensicHarnessSearchResult(item, `spec.searches[${index}]`));
  const sourceAliasFamilies = new Map<string, ForensicHarnessFamily>();
  for (const search of searches) {
    for (const source of search.sources) {
      const priorFamily = sourceAliasFamilies.get(source.source_alias);
      if (priorFamily !== undefined && priorFamily !== search.family) {
        throw new TypeError(`source alias ${source.source_alias} is reused across harness families`);
      }
      sourceAliasFamilies.set(source.source_alias, search.family);
    }
  }
  for (const family of REQUIRED_FAMILIES) {
    const familySearches = searches.filter((search) => search.family === family)
      .sort((left, right) => left.pass - right.pass);
    const passes = familySearches.map((search) => search.pass);
    requireUnique(passes.map(String), `${family} pass numbers`);
    if (passes.length < 2) throw new TypeError(`spec.searches requires at least two passes for ${family}`);
    const priorEvidence = new Set<string>();
    for (const search of familySearches) {
      const hits = search.sources.flatMap((source) => source.hits);
      const observedNewEvidence = new Set(hits
        .filter((hit) => !priorEvidence.has(hit.evidence_id))
        .map((hit) => hit.evidence_id)).size;
      if (search.metrics.new_evidence !== observedNewEvidence) {
        throw new TypeError(`spec.searches ${family} pass ${search.pass} new_evidence mismatch`);
      }
      for (const hit of hits) priorEvidence.add(hit.evidence_id);
    }
  }
  const knownEvidenceIds = new Set(searches.flatMap((search) =>
    search.sources.flatMap((source) => source.hits.map((hit) => hit.evidence_id))));
  const conclusions = requireArray(spec.conclusions, 'spec.conclusions').map((item, index) => {
    const label = `spec.conclusions[${index}]`;
    const conclusion = asRecord(item, label);
    exactKeys(conclusion, [
      'id', 'confidence', 'statement', 'harness_evidence_ids', 'independent_sources',
    ], label);
    const confidence = requireEnum(conclusion.confidence, ['high', 'medium', 'low', 'unknown'], `${label}.confidence`);
    const harnessEvidenceIds = requireArray(conclusion.harness_evidence_ids, `${label}.harness_evidence_ids`).map((value, evidenceIndex) =>
      requireId(value, `${label}.harness_evidence_ids[${evidenceIndex}]`));
    requireUnique(harnessEvidenceIds, `${label}.harness_evidence_ids`);
    for (const evidenceId of harnessEvidenceIds) {
      if (!knownEvidenceIds.has(evidenceId)) throw new TypeError(`${label} references unknown harness evidence: ${evidenceId}`);
    }
    const independentSources = requireArray(conclusion.independent_sources, `${label}.independent_sources`).map((value, sourceIndex) => {
      const sourceLabel = `${label}.independent_sources[${sourceIndex}]`;
      const source = asRecord(value, sourceLabel);
      exactKeys(source, ['kind', 'reference', 'sha256'], sourceLabel);
      const reference = requireString(source.reference, `${sourceLabel}.reference`);
      if (!SAFE_REFERENCE_PATTERN.test(reference)) {
        throw new TypeError(`${sourceLabel}.reference must be repository-safe and relative`);
      }
      return {
        kind: requireEnum(source.kind, ['git', 'file', 'test', 'database', 'runtime'], `${sourceLabel}.kind`),
        reference,
        sha256: source.sha256 === null ? null : requireSha256(source.sha256, `${sourceLabel}.sha256`),
      };
    });
    if (confidence === 'high' && (
      harnessEvidenceIds.length === 0
      || independentSources.length === 0
      || !independentSources.some((source) => source.sha256 !== null)
    )) {
      throw new TypeError(`${label} high confidence requires harness evidence and a content-bound independent source`);
    }
    return {
      id: requireId(conclusion.id, `${label}.id`),
      confidence,
      statement: requireSafeStatement(conclusion.statement, `${label}.statement`),
      harness_evidence_ids: harnessEvidenceIds,
      independent_sources: independentSources,
    };
  });
  const narrative = requireArray(spec.narrative, 'spec.narrative').map((item, index) => {
    const label = `spec.narrative[${index}]`;
    const row = asRecord(item, label);
    exactKeys(row, ['id', 'at', 'summary', 'evidence_ids'], label);
    const evidenceIds = requireArray(row.evidence_ids, `${label}.evidence_ids`).map((value, evidenceIndex) =>
      requireId(value, `${label}.evidence_ids[${evidenceIndex}]`));
    for (const evidenceId of evidenceIds) {
      if (!knownEvidenceIds.has(evidenceId)) throw new TypeError(`${label} references unknown evidence: ${evidenceId}`);
    }
    return {
      id: requireId(row.id, `${label}.id`),
      at: requireTimestamp(row.at, `${label}.at`),
      summary: requireSafeStatement(row.summary, `${label}.summary`),
      evidence_ids: evidenceIds,
    };
  });
  const analysisRecord = asRecord(spec.analysis, 'spec.analysis');
  exactKeys(analysisRecord, [
    'source_assessments', 'query_assessments', 'entity_aliases', 'findings',
    'next_searches', 'recommendations',
  ], 'spec.analysis');
  const sourceAssessments = requireArray(
    analysisRecord.source_assessments,
    'spec.analysis.source_assessments',
  ).map((item, index) => {
    const label = `spec.analysis.source_assessments[${index}]`;
    const row = asRecord(item, label);
    exactKeys(row, [
      'source_alias', 'family', 'authority', 'freshness', 'completeness', 'mutability',
      'provenance', 'access',
    ], label);
    return {
      source_alias: requireId(row.source_alias, `${label}.source_alias`),
      family: requireEnum(row.family, REQUIRED_FAMILIES, `${label}.family`),
      authority: requireEnum(row.authority, ['primary-record', 'supporting'], `${label}.authority`),
      freshness: requireEnum(row.freshness, [
        'current-at-observation', 'frozen-at-observation', 'historical', 'unknown',
      ], `${label}.freshness`),
      completeness: requireEnum(row.completeness, [
        'complete', 'truncated', 'summarized', 'potentially-pruned', 'unknown',
      ], `${label}.completeness`),
      mutability: requireEnum(row.mutability, ['hash-bound', 'mutable', 'unknown'], `${label}.mutability`),
      provenance: requireEnum(row.provenance, [
        'raw', 'snapshot', 'summary', 'derived', 'duplicate',
      ], `${label}.provenance`),
      access: requireEnum(row.access, ['read', 'absent', 'inaccessible', 'rotated'], `${label}.access`),
    };
  });
  requireUnique(sourceAssessments.map((row) => row.source_alias), 'source assessment aliases');
  const sourceAssessmentByAlias = new Map(sourceAssessments.map((row) => [row.source_alias, row]));
  for (const [sourceAlias, family] of sourceAliasFamilies) {
    const assessment = sourceAssessmentByAlias.get(sourceAlias);
    if (!assessment) throw new TypeError(`missing source assessment for ${sourceAlias}`);
    if (assessment.family !== family) throw new TypeError(`source assessment family mismatch for ${sourceAlias}`);
    if (assessment.access !== 'read') throw new TypeError(`searched source assessment must record read access: ${sourceAlias}`);
    const observedComplete = searches
      .filter((search) => search.family === family)
      .flatMap((search) => search.sources)
      .filter((source) => source.source_alias === sourceAlias)
      .every((source) => source.complete);
    if (observedComplete !== (assessment.completeness === 'complete')) {
      throw new TypeError(`source assessment completeness mismatch for ${sourceAlias}`);
    }
  }
  for (const assessment of sourceAssessments) {
    if (!sourceAliasFamilies.has(assessment.source_alias) && assessment.access === 'read') {
      throw new TypeError(`read source assessment has no search receipt: ${assessment.source_alias}`);
    }
  }

  const queryEvidenceByKey = new Map<string, Set<string>>();
  const familyQueryIds = new Map<ForensicHarnessFamily, Set<string>>();
  for (const search of searches) {
    const knownForFamily = familyQueryIds.get(search.family) ?? new Set<string>();
    for (const query of search.queries) {
      knownForFamily.add(query.id);
      const key = `${search.family}:${search.pass}:${query.id}`;
      queryEvidenceByKey.set(key, new Set(search.sources.flatMap((source) => source.hits)
        .filter((hit) => hit.matched_query_ids.includes(query.id))
        .map((hit) => hit.evidence_id)));
    }
    familyQueryIds.set(search.family, knownForFamily);
  }
  const queryAssessments = requireArray(
    analysisRecord.query_assessments,
    'spec.analysis.query_assessments',
  ).map((item, index) => {
    const label = `spec.analysis.query_assessments[${index}]`;
    const row = asRecord(item, label);
    exactKeys(row, [
      'family', 'pass', 'query_id', 'useful_evidence_ids', 'false_positive_evidence_ids',
      'pivot_query_ids', 'confidence_change', 'note',
    ], label);
    const family = requireEnum(row.family, REQUIRED_FAMILIES, `${label}.family`);
    const pass = requireInteger(row.pass, `${label}.pass`, 1);
    const queryId = requireId(row.query_id, `${label}.query_id`);
    const key = `${family}:${pass}:${queryId}`;
    const matchingEvidence = queryEvidenceByKey.get(key);
    if (!matchingEvidence) throw new TypeError(`${label} does not match a search query`);
    const usefulEvidenceIds = requireArray(row.useful_evidence_ids, `${label}.useful_evidence_ids`)
      .map((entry, evidenceIndex) => requireId(entry, `${label}.useful_evidence_ids[${evidenceIndex}]`));
    const falsePositiveEvidenceIds = requireArray(
      row.false_positive_evidence_ids,
      `${label}.false_positive_evidence_ids`,
    ).map((entry, evidenceIndex) => requireId(entry, `${label}.false_positive_evidence_ids[${evidenceIndex}]`));
    requireUnique(usefulEvidenceIds, `${label}.useful_evidence_ids`);
    requireUnique(falsePositiveEvidenceIds, `${label}.false_positive_evidence_ids`);
    for (const evidenceId of [...usefulEvidenceIds, ...falsePositiveEvidenceIds]) {
      if (!matchingEvidence.has(evidenceId)) {
        throw new TypeError(`${label} evidence ${evidenceId} does not match assessed query`);
      }
    }
    if (usefulEvidenceIds.some((evidenceId) => falsePositiveEvidenceIds.includes(evidenceId))) {
      throw new TypeError(`${label} evidence cannot be both useful and false positive`);
    }
    const pivotQueryIds = requireArray(row.pivot_query_ids, `${label}.pivot_query_ids`)
      .map((entry, pivotIndex) => requireId(entry, `${label}.pivot_query_ids[${pivotIndex}]`));
    requireUnique(pivotQueryIds, `${label}.pivot_query_ids`);
    for (const pivotQueryId of pivotQueryIds) {
      if (!familyQueryIds.get(family)?.has(pivotQueryId)) {
        throw new TypeError(`${label} references unknown family pivot query: ${pivotQueryId}`);
      }
    }
    return {
      family,
      pass,
      query_id: queryId,
      useful_evidence_ids: usefulEvidenceIds,
      false_positive_evidence_ids: falsePositiveEvidenceIds,
      pivot_query_ids: pivotQueryIds,
      confidence_change: requireEnum(row.confidence_change, [
        'increase', 'decrease', 'unchanged', 'unknown',
      ], `${label}.confidence_change`),
      note: requireSafeStatement(row.note, `${label}.note`),
    };
  });
  const queryAssessmentKeys = queryAssessments.map((row) => `${row.family}:${row.pass}:${row.query_id}`);
  requireUnique(queryAssessmentKeys, 'query assessment keys');
  for (const key of queryEvidenceByKey.keys()) {
    if (!queryAssessmentKeys.includes(key)) throw new TypeError(`missing query assessment for ${key}`);
  }
  const entityAliases = requireArray(analysisRecord.entity_aliases, 'spec.analysis.entity_aliases')
    .map((item, index) => {
      const label = `spec.analysis.entity_aliases[${index}]`;
      const row = asRecord(item, label);
      exactKeys(row, ['canonical', 'aliases'], label);
      const aliases = requireArray(row.aliases, `${label}.aliases`)
        .map((entry, aliasIndex) => requireSafeStatement(entry, `${label}.aliases[${aliasIndex}]`));
      if (aliases.length === 0) throw new TypeError(`${label}.aliases must not be empty`);
      requireUnique(aliases, `${label}.aliases`);
      return { canonical: requireId(row.canonical, `${label}.canonical`), aliases };
    });
  requireUnique(entityAliases.map((row) => row.canonical), 'entity alias canonical ids');
  const findingsRecord = asRecord(analysisRecord.findings, 'spec.analysis.findings');
  exactKeys(findingsRecord, [
    'lifecycle_anomalies', 'contradictions', 'negative_space', 'copied_forward_claims',
  ], 'spec.analysis.findings');
  const analysis = {
    source_assessments: sourceAssessments,
    query_assessments: queryAssessments,
    entity_aliases: entityAliases,
    findings: {
      lifecycle_anomalies: parseEvidenceStatementRows(
        findingsRecord.lifecycle_anomalies,
        'spec.analysis.findings.lifecycle_anomalies',
        knownEvidenceIds,
      ),
      contradictions: parseEvidenceStatementRows(
        findingsRecord.contradictions,
        'spec.analysis.findings.contradictions',
        knownEvidenceIds,
      ),
      negative_space: parseEvidenceStatementRows(
        findingsRecord.negative_space,
        'spec.analysis.findings.negative_space',
        knownEvidenceIds,
      ),
      copied_forward_claims: parseEvidenceStatementRows(
        findingsRecord.copied_forward_claims,
        'spec.analysis.findings.copied_forward_claims',
        knownEvidenceIds,
      ),
    },
    next_searches: parseStatementRows(analysisRecord.next_searches, 'spec.analysis.next_searches'),
    recommendations: parseStatementRows(analysisRecord.recommendations, 'spec.analysis.recommendations'),
  };
  const state = asRecord(spec.state, 'spec.state');
  exactKeys(state, ['decisions', 'unknowns', 'falsified_hypotheses'], 'spec.state');
  const parsed = {
    schema_version: 'forensic.package-spec.v1' as const,
    observation_timestamp: requireTimestamp(spec.observation_timestamp, 'spec.observation_timestamp'),
    searches,
    conclusions,
    narrative,
    analysis,
    state: {
      decisions: parseStatementRows(state.decisions, 'spec.state.decisions'),
      unknowns: parseStatementRows(state.unknowns, 'spec.state.unknowns'),
      falsified_hypotheses: parseStatementRows(state.falsified_hypotheses, 'spec.state.falsified_hypotheses'),
    },
  };
  requireUnique(parsed.conclusions.map((row) => row.id), 'conclusion ids');
  requireUnique(parsed.narrative.map((row) => row.id), 'narrative ids');
  return parsed;
}

function sanitizedStatement(statement: string): { text: string; redactions: readonly string[] } {
  const sanitized = sanitizeEvidenceText(statement);
  assertNoSecretLike(sanitized.text, 'forensic package statement');
  return { text: sanitized.text, redactions: sanitized.categories };
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function normalizeForbiddenTerms(terms: readonly string[] | undefined): readonly string[] {
  if (terms === undefined) return [];
  if (!Array.isArray(terms) || terms.length > 256) {
    throw new TypeError('forbiddenTerms must contain at most 256 strings');
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const term of terms) {
    if (typeof term !== 'string' || term.length === 0 || term.length > 256 || term.trim() !== term) {
      throw new TypeError('each forbidden term must be a non-empty trimmed string of at most 256 characters');
    }
    if (/\p{Cc}/u.test(term)) throw new TypeError('forbidden terms must not contain control characters');
    const folded = term.toLocaleLowerCase('en-US');
    if (seen.has(folded)) throw new TypeError('forbidden terms must be unique ignoring case');
    seen.add(folded);
    normalized.push(folded);
  }
  return normalized;
}

function publicInteger(value: number): number | string {
  if (value < 1_000_000_000) return value;
  return String(value).replace(/\B(?=(?:\d{3})+(?!\d))/gu, '_');
}

function publicSourceIdentity(
  identity: ForensicHarnessSearchResult['sources'][number]['identity'],
): Record<string, unknown> {
  return {
    bytes: publicInteger(identity.bytes),
    sha256: identity.sha256,
    ...(identity.members === undefined ? {} : {
      members: identity.members.map((member) => ({
        ...member,
        bytes: publicInteger(member.bytes),
      })),
    }),
  };
}

function assertPublicContent(
  content: string,
  name: string,
  forbiddenTerms: readonly string[],
): void {
  assertNoSecretLike(content, name);
  if (/\/(?:Users|home)\//u.test(content)) {
    throw new Error(`redaction_violation: ${name} contains a private home path`);
  }
  const folded = content.toLocaleLowerCase('en-US');
  if (forbiddenTerms.some((term) => folded.includes(term))) {
    throw new Error(`redaction_violation: ${name} contains a configured forbidden term`);
  }
}

function packagePayloads(
  spec: ForensicPackageSpec,
  forbiddenTerms: readonly string[],
): Record<typeof PACKAGE_DATA_FILES[number], string> {
  const sourceRows = new Map<string, ForensicHarnessSearchResult['sources'][number]>();
  const evidenceByHash = new Map<string, {
    evidence_id: string;
    record_sha256: string;
    occurrences: Array<{
      family: ForensicHarnessFamily;
      pass: number;
      source_alias: string;
      locator: ForensicEvidenceLocator;
      matched_query_ids: readonly string[];
      envelope: { type: string | null; role: string | null };
    }>;
  }>();
  for (const search of spec.searches) {
    for (const source of search.sources) {
      const prior = sourceRows.get(source.source_alias);
      if (prior && JSON.stringify(prior.identity) !== JSON.stringify(source.identity)) {
        throw new Error(`source identity drift across passes: ${source.source_alias}`);
      }
      sourceRows.set(source.source_alias, source);
      for (const hit of source.hits) {
        const evidence = evidenceByHash.get(hit.record_sha256) ?? {
          evidence_id: `evidence-${hit.record_sha256}`,
          record_sha256: hit.record_sha256,
          occurrences: [],
        };
        evidence.occurrences.push({
          family: search.family,
          pass: search.pass,
          source_alias: hit.source_alias,
          locator: hit.locator,
          matched_query_ids: hit.matched_query_ids,
          envelope: hit.envelope,
        });
        evidenceByHash.set(hit.record_sha256, evidence);
      }
    }
  }
  const sourceInventory = {
    schema_version: 'forensic.source-inventory.v1',
    integer_encoding: 'number-or-underscore-grouped-decimal-string',
    sources: [...spec.analysis.source_assessments]
      .sort((left, right) => compareText(left.source_alias, right.source_alias))
      .map((assessment) => {
        const observed = sourceRows.get(assessment.source_alias);
        const observations = spec.searches.flatMap((search) => search.sources
          .filter((source) => source.source_alias === assessment.source_alias)
          .map((source) => ({
            family: search.family,
            pass: search.pass,
            complete: source.complete,
            records_examined: source.records_examined,
            matches_observed: source.matches_observed,
            findings: source.findings,
          })))
          .sort((left, right) => left.pass - right.pass);
        return {
          alias: assessment.source_alias,
          family: assessment.family,
          authority: assessment.authority,
          freshness: assessment.freshness,
          completeness: assessment.completeness,
          mutability: assessment.mutability,
          provenance: assessment.provenance,
          access: assessment.access,
          ...(observed ? { adapter: observed.adapter, identity: publicSourceIdentity(observed.identity) } : {}),
          observations,
        };
      }),
  };
  const queryAssessmentByKey = new Map(spec.analysis.query_assessments.map((row) => [
    `${row.family}:${row.pass}:${row.query_id}`,
    row,
  ]));
  const queryJournal = {
    schema_version: 'forensic.query-journal.v1',
    families: REQUIRED_FAMILIES.map((family) => {
      const searches = spec.searches.filter((search) => search.family === family).sort((left, right) => left.pass - right.pass);
      const summary = summarizeAdaptivePasses(searches.map((search) => ({
        pass: search.pass,
        candidates: search.metrics.candidates,
        newEvidence: search.metrics.new_evidence,
        failedSources: search.metrics.failed_sources,
      })));
      return {
        family,
        passes: searches.map((search) => ({
          pass: search.pass,
          corpus: search.sources.map((source) => source.source_alias).sort(compareText),
          queries: search.queries.map((query) => {
            const assessment = queryAssessmentByKey.get(`${family}:${search.pass}:${query.id}`)!;
            const retainedHits = search.sources.flatMap((source) => source.hits)
              .filter((hit) => hit.matched_query_ids.includes(query.id));
            return {
              id: query.id,
              technique: query.mode,
              retained_hits: retainedHits.length,
              useful_evidence_ids: assessment.useful_evidence_ids,
              false_positive_evidence_ids: assessment.false_positive_evidence_ids,
              unreviewed_hits: Math.max(
                0,
                retainedHits.length - assessment.useful_evidence_ids.length -
                  assessment.false_positive_evidence_ids.length,
              ),
              pivot_query_ids: assessment.pivot_query_ids,
              confidence_change: assessment.confidence_change,
              note: sanitizedStatement(assessment.note),
            };
          }),
          metrics: search.metrics,
        })),
        saturation: summary,
      };
    }),
  };
  const selectedEvidenceIds = new Set([
    ...spec.conclusions.flatMap((row) => row.harness_evidence_ids),
    ...spec.narrative.flatMap((row) => row.evidence_ids),
    ...spec.analysis.query_assessments.flatMap((row) => [
      ...row.useful_evidence_ids,
      ...row.false_positive_evidence_ids,
    ]),
    ...Object.values(spec.analysis.findings).flatMap((rows) =>
      rows.flatMap((row) => row.evidence_ids)),
  ]);
  const evidence = {
    schema_version: 'forensic.evidence.v1',
    selection: {
      retained: selectedEvidenceIds.size,
      observed_candidates: evidenceByHash.size,
      rule: 'referenced-by-adjudication',
    },
    evidence: [...evidenceByHash.values()]
      .filter((row) => selectedEvidenceIds.has(row.evidence_id))
      .sort((left, right) => compareText(left.record_sha256, right.record_sha256))
      .map((row) => ({
        ...row,
        occurrences: row.occurrences.sort((left, right) =>
          compareText(left.family, right.family)
          || left.pass - right.pass
          || compareText(left.source_alias, right.source_alias)),
      })),
  };
  const narrative = {
    schema_version: 'forensic.narrative.v1',
    events: spec.narrative.map((row) => ({ ...row, summary: sanitizedStatement(row.summary) })),
  };
  const state = {
    schema_version: 'forensic.state.v1',
    observation_timestamp: spec.observation_timestamp,
    conclusions: spec.conclusions.map((row) => ({
      ...row,
      statement: sanitizedStatement(row.statement),
    })),
    decisions: spec.state.decisions.map((row) => ({ ...row, statement: sanitizedStatement(row.statement) })),
    unknowns: spec.state.unknowns.map((row) => ({ ...row, statement: sanitizedStatement(row.statement) })),
    falsified_hypotheses: spec.state.falsified_hypotheses.map((row) => ({ ...row, statement: sanitizedStatement(row.statement) })),
  };
  const graphDocuments = [
    ...state.conclusions.map((row) => ({
      id: `conclusion-${row.id}`,
      title: row.id,
      text: row.statement.text,
      timestampMs: Date.parse(spec.observation_timestamp),
      fields: {},
    })),
    ...narrative.events.map((row) => ({
      id: `narrative-${row.id}`,
      title: row.id,
      text: row.summary.text,
      timestampMs: Date.parse(row.at),
      fields: {},
    })),
  ];
  const projectEvidenceRows = (rows: readonly EvidenceStatement[]) => rows.map((row) => ({
    ...row,
    statement: sanitizedStatement(row.statement),
  }));
  const analysis = {
    schema_version: 'forensic.analysis.v1',
    method_configuration: {
      applied_search_modes: [...new Set(spec.searches.flatMap((search) =>
        search.queries.map((query) => query.mode)))].sort(compareText),
      query_text_published: false,
      normalization: {
        applied_to_modes: spec.searches.some((search) =>
          search.queries.some((query) => query.mode === 'all_tokens')) ? ['all_tokens'] : [],
        ...FORENSIC_RETRIEVAL_CONFIGURATION.normalization,
      },
      synonyms: {
        applied_to_search: false,
        groups: spec.analysis.entity_aliases.map((row) => ({
          canonical: row.canonical,
          aliases: row.aliases.map((alias) => sanitizedStatement(alias)),
        })),
      },
      regex: { applied_to_search: false, patterns: [] },
      ngram: { applied_to_search: false, ...FORENSIC_RETRIEVAL_CONFIGURATION.ngram },
      fuzzy: { applied_to_search: false, ...FORENSIC_RETRIEVAL_CONFIGURATION.fuzzy },
      ranking: { applied_to_search: false, ...FORENSIC_RETRIEVAL_CONFIGURATION.ranking },
      candidate_ranking_applied: false,
    },
    entity_graph: buildArtifactGraph(graphDocuments, spec.analysis.entity_aliases),
    findings: {
      lifecycle_anomalies: projectEvidenceRows(spec.analysis.findings.lifecycle_anomalies),
      contradictions: projectEvidenceRows(spec.analysis.findings.contradictions),
      negative_space: projectEvidenceRows(spec.analysis.findings.negative_space),
      copied_forward_claims: projectEvidenceRows(spec.analysis.findings.copied_forward_claims),
    },
    next_searches: spec.analysis.next_searches.map((row) => ({
      ...row,
      statement: sanitizedStatement(row.statement),
    })),
    recommendations: spec.analysis.recommendations.map((row) => ({
      ...row,
      statement: sanitizedStatement(row.statement),
    })),
  };
  const reportLines = [
    '# Forensic Reconstruction',
    '',
    `Observation: ${spec.observation_timestamp}`,
    '',
    '## Harness coverage',
    '',
    '| family | passes | failed sources | saturation |',
    '|---|---:|---:|---|',
    ...queryJournal.families.map((family) =>
      `| ${family.family} | ${family.passes.length} | ${family.passes.reduce((sum, pass) => sum + pass.metrics.failed_sources, 0)} | ${family.saturation.saturated ? 'observed' : `unproven (${family.saturation.reason})`} |`),
    '',
    '## Conclusions',
    '',
    ...state.conclusions.map((conclusion) =>
      `- ${conclusion.id} [${conclusion.confidence}]: ${conclusion.statement.text}`),
    '',
    '## Chronology',
    '',
    ...narrative.events.map((event) =>
      `- ${event.at} ${event.id}: ${event.summary.text}`),
    '',
    '## Findings',
    '',
    ...Object.entries(analysis.findings).flatMap(([kind, rows]) => [
      `### ${kind.replaceAll('_', ' ')}`,
      '',
      ...rows.map((row) => `- ${row.id}: ${row.statement.text}`),
      '',
    ]),
    '## Unknowns',
    '',
    ...state.unknowns.map((unknown) => `- ${unknown.id}: ${unknown.statement.text}`),
    '',
    '## Next searches',
    '',
    ...analysis.next_searches.map((row) => `- ${row.id}: ${row.statement.text}`),
    '',
    '## Recommendations',
    '',
    ...analysis.recommendations.map((row) => `- ${row.id}: ${row.statement.text}`),
    '',
    '## Reproduction',
    '',
    'The public projection intentionally omits private source locations and query text.',
    'Recreate the hash-bound search receipts from the private source manifest, build into a new directory, then verify the closed manifest:',
    '',
    '```text',
    'npm run forensic:reconstruct -- build --spec <private-spec.json> --output <new-directory> --forbidden-terms <private-forbidden-terms.json>',
    'npm run forensic:reconstruct -- verify --package <new-directory> --expected-manifest-sha256 <manifest-sha256> --forbidden-terms <private-forbidden-terms.json>',
    '```',
  ];
  const payloads = {
    'analysis.json': json(analysis),
    'source-inventory.json': json(sourceInventory),
    'query-journal.json': json(queryJournal),
    'evidence.json': json(evidence),
    'narrative.json': json(narrative),
    'state.json': json(state),
    'report.md': `${reportLines.join('\n')}\n`,
  };
  for (const [name, content] of Object.entries(payloads)) {
    assertPublicContent(content, name, forbiddenTerms);
  }
  return payloads;
}

export function writeForensicPackage(
  value: unknown,
  outputDirectory: string,
  options: ForensicPackageWriteOptions = {},
): void {
  const spec = parseForensicPackageSpec(value);
  const forbiddenTerms = normalizeForbiddenTerms(options.forbiddenTerms);
  const parent = path.dirname(outputDirectory);
  const payloads = packagePayloads(spec, forbiddenTerms);
  let created = false;
  try {
    mkdirSync(outputDirectory, { mode: 0o700 });
    created = true;
    for (const name of PACKAGE_DATA_FILES) {
      const descriptor = openSync(path.join(outputDirectory, name), 'wx', 0o600);
      try {
        writeFileSync(descriptor, payloads[name]);
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
    }
    const manifest = {
      schema_version: 'forensic.package-manifest.v1',
      files: [...PACKAGE_DATA_FILES].sort().map((name) => ({
        path: name,
        bytes: Buffer.byteLength(payloads[name]),
        sha256: sha256(payloads[name]),
      })),
    };
    const manifestDescriptor = openSync(path.join(outputDirectory, 'manifest.json'), 'wx', 0o600);
    try {
      writeFileSync(manifestDescriptor, json(manifest));
      fsyncSync(manifestDescriptor);
    } finally {
      closeSync(manifestDescriptor);
    }
    const directoryDescriptor = openSync(outputDirectory, 'r');
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
    const parentDescriptor = openSync(parent, 'r');
    try {
      fsyncSync(parentDescriptor);
    } finally {
      closeSync(parentDescriptor);
    }
  } catch (error) {
    if (!created && (error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`output directory already exists: ${outputDirectory}`);
    }
    if (created && existsSync(outputDirectory)) rmSync(outputDirectory, { recursive: true, force: true });
    throw error;
  }
}

export function verifyForensicPackage(
  outputDirectory: string,
  expectedManifestSha256: string,
  options: ForensicPackageWriteOptions = {},
): {
  readonly valid: boolean;
  readonly findings: readonly string[];
} {
  const findings: string[] = [];
  const forbiddenTerms = normalizeForbiddenTerms(options.forbiddenTerms);
  const link = lstatSync(outputDirectory);
  if (link.isSymbolicLink() || !link.isDirectory()) {
    return { valid: false, findings: ['package-not-regular-directory'] };
  }
  const actualFiles = readdirSync(outputDirectory).sort();
  for (const name of actualFiles) {
    if (!PACKAGE_FILES.includes(name)) findings.push(`unexpected-file:${name}`);
  }
  for (const name of PACKAGE_FILES) {
    if (!actualFiles.includes(name)) findings.push(`missing-file:${name}`);
  }
  if (!actualFiles.includes('manifest.json')) return { valid: false, findings };
  let manifest: Record<string, unknown>;
  try {
    const manifestContent = readFileSync(path.join(outputDirectory, 'manifest.json'));
    try {
      assertPublicContent(manifestContent.toString('utf8'), 'manifest.json', forbiddenTerms);
    } catch {
      findings.push('redaction-violation:manifest.json');
    }
    requireSha256(expectedManifestSha256, 'expectedManifestSha256');
    if (sha256(manifestContent) !== expectedManifestSha256) findings.push('manifest-hash-mismatch');
    manifest = asRecord(JSON.parse(manifestContent.toString('utf8')), 'manifest');
    exactKeys(manifest, ['schema_version', 'files'], 'manifest');
    if (manifest.schema_version !== 'forensic.package-manifest.v1') throw new Error('manifest schema mismatch');
  } catch {
    findings.push('manifest-invalid');
    return { valid: false, findings: [...new Set(findings)].sort() };
  }
  const rows = requireArray(manifest.files, 'manifest.files');
  const seen = new Set<string>();
  for (const [index, value] of rows.entries()) {
    const row = asRecord(value, `manifest.files[${index}]`);
    exactKeys(row, ['path', 'bytes', 'sha256'], `manifest.files[${index}]`);
    const name = requireString(row.path, `manifest.files[${index}].path`);
    if (!PACKAGE_DATA_FILES.includes(name as typeof PACKAGE_DATA_FILES[number])) {
      findings.push(`manifest-path-invalid:${name}`);
      continue;
    }
    if (seen.has(name)) findings.push(`manifest-path-duplicate:${name}`);
    seen.add(name);
    const file = path.join(outputDirectory, name);
    if (!existsSync(file)) continue;
    const fileLink = lstatSync(file);
    if (fileLink.isSymbolicLink() || !fileLink.isFile()) {
      findings.push(`file-not-regular:${name}`);
      continue;
    }
    const content = readFileSync(file);
    try {
      assertPublicContent(content.toString('utf8'), name, forbiddenTerms);
    } catch {
      findings.push(`redaction-violation:${name}`);
    }
    if (content.length !== requireInteger(row.bytes, `manifest.files[${index}].bytes`)) {
      findings.push(`size-mismatch:${name}`);
    }
    if (sha256(content) !== requireSha256(row.sha256, `manifest.files[${index}].sha256`)) {
      findings.push(`hash-mismatch:${name}`);
    }
  }
  for (const name of PACKAGE_DATA_FILES) {
    if (!seen.has(name)) findings.push(`manifest-entry-missing:${name}`);
  }
  return { valid: findings.length === 0, findings: [...new Set(findings)].sort() };
}
