// src/core/substrate/beads.ts
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { withImmediateTransaction, withTransaction } from '../db-tx.ts';
import { nowUnixSec } from './time.ts';
import { writeBeadEvent } from './events.ts';
import type { BeadKind, BeadStatus, BeadRow, BeadEventRow, ActivityFeedRow } from './types.ts';

export interface CreateBeadArgs {
  kind: BeadKind; title: string; ownerJid: string;
  body?: string | null; chatJid?: string | null;
  sourceMessagePk?: number | null;
  dueAt?: number | null; priority?: number;
  confidence?: number | null; proposalReason?: string | null; reviewByAt?: number | null;
  parentBeadId?: number | null;
  status?: BeadStatus; metadata?: Record<string, unknown>;
  actor: string;
}

export interface CreateInlineProposalArgs extends CreateBeadArgs {
  sourceMessagePk: number;
  normalizedTarget: string;
  status: 'proposed';
  proposalReason: `inline imperative: ${string}`;
  actor: 'inline';
}

export interface CreateInlineProposalResult {
  bead: BeadRow;
  created: boolean;
}

export class InlineProposalCollisionError extends Error {
  readonly code = 'INLINE_PROPOSAL_COLLISION';

  constructor() {
    super('inline proposal source collides with a different stable identity');
    this.name = 'InlineProposalCollisionError';
  }
}

export class InlineProposalInvariantError extends Error {
  readonly code = 'INLINE_PROPOSAL_INVARIANT';

  constructor() {
    super('inline proposal arguments violate the runtime contract');
    this.name = 'InlineProposalInvariantError';
  }
}

export const TERMINAL: readonly BeadStatus[] = ['completed', 'cancelled', 'failed'];
const PROTECTED = new Set(['id', 'kind', 'owner_jid', 'status', 'created_at']);

// Per spec §8.5: hard cap 64KB of UTF-8 bytes on bead.body (not UTF-16 code
// units). Emoji/CJK content would otherwise admit up to 4× more bytes to the
// DB than the cap implies. We measure via Buffer.byteLength, then — if the
// body exceeds the cap — slice conservatively by code units, re-measure, and
// shrink until the UTF-8 encoding fits. The truncation marker is appended so
// downstream consumers see the body is lossy.
const BODY_HARD_CAP_BYTES = 64 * 1024;
const TRUNCATE_MARKER = '...[truncated]';
const TRUNCATE_MARKER_BYTES = Buffer.byteLength(TRUNCATE_MARKER, 'utf8');

export function assertMutableBeadFields(fields: Record<string, unknown>): void {
  for (const k of Object.keys(fields)) {
    if (PROTECTED.has(k)) throw new Error(`cannot change protected field via updateBead: ${k}`);
  }
}

function clampBody(body: string | null | undefined): string | null {
  if (body == null) return null;
  if (Buffer.byteLength(body, 'utf8') <= BODY_HARD_CAP_BYTES) return body;
  // Conservative initial slice: assume worst case 4 bytes per code unit, then
  // iteratively trim until the UTF-8 encoding plus marker fits. Loop is bounded
  // by the starting length; in practice converges in O(1) iterations.
  const targetBytes = BODY_HARD_CAP_BYTES - TRUNCATE_MARKER_BYTES;
  let slice = body.slice(0, Math.floor(targetBytes / 4));
  while (Buffer.byteLength(slice, 'utf8') < targetBytes && slice.length < body.length) {
    const next = body.slice(0, slice.length + 1);
    if (Buffer.byteLength(next, 'utf8') > targetBytes) break;
    slice = next;
  }
  return slice + TRUNCATE_MARKER;
}

export function createBead(db: DatabaseSync, args: CreateBeadArgs): BeadRow {
  const now = nowUnixSec();
  const status: BeadStatus = args.status ?? 'active';
  db.exec('BEGIN');
  try {
    const info = db.prepare(
      `INSERT INTO beads (
         kind, status, title, body, owner_jid, chat_jid, source_message_pk,
         due_at, priority, confidence, proposal_reason, review_by_at,
         parent_bead_id, created_at, updated_at, metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      args.kind, status, args.title, clampBody(args.body), args.ownerJid,
      args.chatJid ?? null, args.sourceMessagePk ?? null,
      args.dueAt ?? null, args.priority ?? 0, args.confidence ?? null,
      args.proposalReason ?? null, args.reviewByAt ?? null,
      args.parentBeadId ?? null, now, now,
      JSON.stringify(args.metadata ?? {}),
    );
    const beadId = Number(info.lastInsertRowid);
    writeBeadEvent(db, {
      beadId, eventType: 'status_change', actor: args.actor,
      payload: { from: null, to: status },
      sourceMessagePk: args.sourceMessagePk ?? null, at: now,
    });
    const row = db.prepare(`SELECT * FROM beads WHERE id = ?`).get(beadId) as unknown as BeadRow;
    db.exec('COMMIT');
    return row;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* best effort */ }
    throw err;
  }
}

const SQLITE_BUSY_PRIMARY_CODE = 5;
const SQLITE_UNIQUE_CONSTRAINT_CODE = 2067;
const INLINE_PROPOSAL_BUSY_RETRIES = 4;
const busyRetrySignal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
const INLINE_PROPOSAL_TARGET_METADATA_KEY = 'inline_proposal_normalized_target';
const INLINE_PROPOSAL_TARGET_MAX_BYTES = 8 * 1024;
const INLINE_PROPOSAL_REASONS = new Set([
  'inline imperative: remind',
  'inline imperative: schedule',
  'inline imperative: watch',
  'inline imperative: follow-up',
  'inline imperative: task',
  'inline imperative: track',
  'inline imperative: bead',
]);

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function assertInlineProposalArgs(args: unknown): void {
  if (typeof args !== 'object' || args === null) {
    throw new InlineProposalInvariantError();
  }
  const candidate = args as Record<string, unknown>;
  if (
    typeof candidate.sourceMessagePk !== 'number'
    || !Number.isSafeInteger(candidate.sourceMessagePk)
    || candidate.sourceMessagePk <= 0
  ) {
    throw new InlineProposalInvariantError();
  }
  if (candidate.status !== 'proposed') {
    throw new InlineProposalInvariantError();
  }
  if (candidate.actor !== 'inline') {
    throw new InlineProposalInvariantError();
  }
  if (
    typeof candidate.proposalReason !== 'string'
    || !INLINE_PROPOSAL_REASONS.has(candidate.proposalReason)
  ) {
    throw new InlineProposalInvariantError();
  }
  if (
    typeof candidate.normalizedTarget !== 'string'
    || candidate.normalizedTarget.trim().length === 0
    || hasUnpairedSurrogate(candidate.normalizedTarget)
    || Buffer.byteLength(candidate.normalizedTarget, 'utf8') > INLINE_PROPOSAL_TARGET_MAX_BYTES
  ) {
    throw new InlineProposalInvariantError();
  }
}

function sqliteErrcode(err: unknown): number | null {
  if (typeof err !== 'object' || err === null || !('errcode' in err)) return null;
  const errcode = (err as { errcode?: unknown }).errcode;
  return typeof errcode === 'number' ? errcode : null;
}

function isSqliteBusy(err: unknown): boolean {
  const errcode = sqliteErrcode(err);
  return errcode !== null && (errcode & 0xff) === SQLITE_BUSY_PRIMARY_CODE;
}

function isInlineProposalSourceConflict(err: unknown): boolean {
  if (sqliteErrcode(err) !== SQLITE_UNIQUE_CONSTRAINT_CODE) return false;
  return err instanceof Error
    && err.message === 'UNIQUE constraint failed: beads.source_message_pk';
}

function sameInlineProposalIdentity(bead: BeadRow, args: CreateInlineProposalArgs): boolean {
  let metadata: unknown;
  try {
    metadata = JSON.parse(bead.metadata_json);
  } catch {
    return false;
  }
  const storedTarget = typeof metadata === 'object' && metadata !== null
    ? (metadata as Record<string, unknown>)[INLINE_PROPOSAL_TARGET_METADATA_KEY]
    : undefined;
  return bead.owner_jid === args.ownerJid
    && bead.chat_jid === (args.chatJid ?? null)
    && bead.source_message_pk === args.sourceMessagePk
    && bead.proposal_reason === args.proposalReason
    && storedTarget === args.normalizedTarget;
}

function getInlineProposalBySource(
  db: DatabaseSync,
  sourceMessagePk: number,
): BeadRow | undefined {
  return db.prepare(`
    SELECT * FROM beads
    WHERE source_message_pk = ?
      AND proposal_reason LIKE 'inline imperative: %'
  `).get(sourceMessagePk) as unknown as BeadRow | undefined;
}

export function createInlineProposal(
  db: DatabaseSync,
  args: CreateInlineProposalArgs,
): CreateInlineProposalResult {
  assertInlineProposalArgs(args);
  let firstBusyError: unknown;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const { normalizedTarget, ...beadArgs } = args;
      return {
        bead: createBead(db, {
          ...beadArgs,
          metadata: {
            ...args.metadata,
            [INLINE_PROPOSAL_TARGET_METADATA_KEY]: normalizedTarget,
          },
        }),
        created: true,
      };
    } catch (err) {
      if (isInlineProposalSourceConflict(err)) {
        const existing = getInlineProposalBySource(db, args.sourceMessagePk);
        if (existing && sameInlineProposalIdentity(existing, args)) {
          return { bead: existing, created: false };
        }
        if (existing) throw new InlineProposalCollisionError();
      }
      if (isSqliteBusy(err)) {
        firstBusyError ??= err;
        if (attempt < INLINE_PROPOSAL_BUSY_RETRIES) {
          Atomics.wait(busyRetrySignal, 0, 0, 2 ** attempt);
          continue;
        }
        throw firstBusyError;
      }
      throw err;
    }
  }
}

export interface GetBeadResult { bead: BeadRow; events: BeadEventRow[]; }

export function getBead(db: DatabaseSync, id: number): GetBeadResult | null {
  const bead = db.prepare(`SELECT * FROM beads WHERE id = ?`).get(id) as unknown as BeadRow | undefined;
  if (!bead) return null;
  const events = db
    .prepare(`SELECT * FROM bead_events WHERE bead_id = ? ORDER BY created_at ASC, id ASC`)
    .all(id) as unknown as BeadEventRow[];
  return { bead, events };
}

export interface ListBeadsFilter {
  ownerJid?: string; kind?: BeadKind; status?: BeadStatus; chatJid?: string;
  dueBefore?: number; since?: number; limit?: number;
  /**
   * Surface status='proposed' beads whose review_by_at deadline has already
   * passed (#1773 — review_by_at was written by the inline-extractor sweep
   * but never read anywhere: no SELECT, scheduler, sweep, or alert consumed
   * it, so proposals accumulated silently forever, 683 on one live instance).
   * When true this OVERRIDES any explicit `status` filter with the hardcoded
   * 'proposed' predicate below — a non-proposed bead's review_by_at is no
   * longer actionable (approve_proposal/reject_proposal only accept
   * status='proposed'), so it is never overdue-relevant regardless of what
   * `status` the caller also passed.
   */
  reviewOverdue?: boolean;
}

/**
 * Shared predicate for "overdue proposal" — kept as a single source of truth
 * between listBeads' reviewOverdue filter and countOverdueProposals so the
 * backlog-alert count (rem-3) can never drift from what list_beads surfaces
 * to a caller (rem-1). Takes one bind param: the `now` cutoff.
 */
const OVERDUE_PROPOSAL_WHERE = `status = 'proposed' AND review_by_at IS NOT NULL AND review_by_at < ?`;

export function listBeads(db: DatabaseSync, f: ListBeadsFilter = {}): BeadRow[] {
  const w: string[] = [];
  const b: SQLInputValue[] = [];
  if (f.ownerJid) { w.push('owner_jid = ?'); b.push(f.ownerJid); }
  if (f.kind)     { w.push('kind = ?');      b.push(f.kind); }
  if (f.reviewOverdue) {
    w.push(OVERDUE_PROPOSAL_WHERE); b.push(nowUnixSec());
  } else if (f.status) {
    w.push('status = ?'); b.push(f.status);
  }
  if (f.chatJid)  { w.push('chat_jid = ?');  b.push(f.chatJid); }
  if (f.dueBefore != null) { w.push('due_at <= ?'); b.push(f.dueBefore); }
  if (f.since != null)     { w.push('updated_at >= ?'); b.push(f.since); }
  const sql = `SELECT * FROM beads ${w.length ? 'WHERE ' + w.join(' AND ') : ''}
               ORDER BY updated_at DESC, id DESC LIMIT ?`;
  b.push(f.limit ?? 200);
  return db.prepare(sql).all(...b) as unknown as BeadRow[];
}

/**
 * Count of status='proposed' beads whose review_by_at deadline has passed.
 * A dedicated COUNT query (not a paginated listBeads call) so the backlog
 * gauge / alert threshold check (#1773 rem-3) is accurate even when the
 * backlog exceeds listBeads' page size (683 proposals were observed on one
 * live instance — well past the 200-row default limit).
 */
export function countOverdueProposals(db: DatabaseSync, now: number = nowUnixSec()): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS c FROM beads WHERE ${OVERDUE_PROPOSAL_WHERE}`,
  ).get(now) as { c: number };
  return row.c;
}

export interface UpdateBeadArgs {
  fields: {
    title?: string; body?: string; due_at?: number; priority?: number;
    metadata?: Record<string, unknown>;
  };
  actor: string;
}

export function updateBead(db: DatabaseSync, id: number, args: UpdateBeadArgs): void {
  const current = db.prepare(`SELECT * FROM beads WHERE id = ?`).get(id) as unknown as BeadRow | undefined;
  if (!current) throw new Error(`bead ${id} not found`);
  assertMutableBeadFields(args.fields as Record<string, unknown>);
  const now = nowUnixSec();
  const sets: string[] = ['updated_at = ?'];
  const binds: SQLInputValue[] = [now];
  const changed: Record<string, { from: unknown; to: unknown }> = {};
  const f = args.fields as Record<string, unknown>;
  for (const key of ['title', 'body', 'due_at', 'priority'] as const) {
    if (key in f) {
      let next = f[key] as BeadRow[typeof key];
      if (key === 'body') next = clampBody(next as string | null) as BeadRow[typeof key];
      const prev = current[key];
      if (next !== prev) {
        sets.push(`${key} = ?`); binds.push(next);
        changed[key] = { from: prev, to: next };
      }
    }
  }
  if (args.fields.metadata) {
    // Metadata merge is SHALLOW by contract. An update that passes a nested
    // object REPLACES the existing top-level key entirely — it does not
    // recursively merge into the previous value. Callers who need to preserve
    // sibling keys of a nested object must read-modify-write: read metadata
    // via getBead, compute the fully-merged nested object locally, and write
    // back the complete top-level key. This matches spec §4.1's treatment of
    // metadata_json as an opaque bag; deep-merge semantics would couple
    // substrate to caller-specific nesting conventions and silently delay
    // schema-incompatibility discovery.
    const merged = { ...JSON.parse(current.metadata_json), ...args.fields.metadata };
    const next = JSON.stringify(merged);
    if (next !== current.metadata_json) {
      sets.push('metadata_json = ?'); binds.push(next);
      changed['metadata'] = { from: JSON.parse(current.metadata_json), to: merged };
    }
  }
  if (sets.length === 1) return;
  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE beads SET ${sets.join(', ')} WHERE id = ?`).run(...binds, id);
    writeBeadEvent(db, { beadId: id, eventType: 'field_update', actor: args.actor, payload: { changed }, at: now });
    db.exec('COMMIT');
  } catch (err) { try { db.exec('ROLLBACK'); } catch { /* best effort */ } throw err; }
}

interface TransitionArgs { actor: string; at?: number; note?: string; reason?: string; }

export interface RejectProposalBatchCandidate {
  id: number;
  expected: {
    status: 'proposed';
    createdAt: number;
    updatedAt: number;
    reviewByAt: number | null;
    sourceMessagePk: number | null;
    proposalReason: string | null;
    completedAt: null;
    cancelledAt: null;
  };
}

export interface ProposalBatchAudit {
  reasonCode: string;
  classifierVersion: string;
  manifestId: string;
}

export interface RejectProposalsBatchArgs {
  candidates: readonly RejectProposalBatchCandidate[];
  actor: string;
  at?: number;
  audit: ProposalBatchAudit;
  /** Called once, in candidate order, after built-in validation and before the first write. */
  assertExpectedRows?: (rows: readonly Readonly<BeadRow>[]) => void;
}

export interface RejectProposalsBatchResult {
  affectedCount: number;
  eventCount: number;
}

export type ProposalBatchInvariantReason =
  | 'invalid_request'
  | 'empty_candidates'
  | 'duplicate_id'
  | 'invalid_candidate'
  | 'invalid_audit';

export class ProposalBatchInvariantError extends Error {
  readonly code = 'PROPOSAL_BATCH_INVARIANT';
  readonly reason: ProposalBatchInvariantReason;

  constructor(reason: ProposalBatchInvariantReason) {
    super(`proposal batch request rejected (${reason})`);
    this.name = 'ProposalBatchInvariantError';
    this.reason = reason;
  }
}

export type ProposalBatchDriftReason =
  | 'missing'
  | 'not_proposed'
  | 'expected_state_mismatch'
  | 'update_count_mismatch'
  | 'event_identity_mismatch'
  | 'event_count_mismatch';

export class ProposalBatchDriftError extends Error {
  readonly code = 'PROPOSAL_BATCH_DRIFT';
  readonly reason: ProposalBatchDriftReason;

  constructor(reason: ProposalBatchDriftReason) {
    super(`proposal batch state drift detected (${reason})`);
    this.name = 'ProposalBatchDriftError';
    this.reason = reason;
  }
}

const BATCH_ACTOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BATCH_REASON_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const BATCH_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BATCH_MANIFEST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function isNullableSafeTimestamp(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function assertRejectProposalBatchArgs(args: unknown): asserts args is RejectProposalsBatchArgs {
  if (typeof args !== 'object' || args === null) {
    throw new ProposalBatchInvariantError('invalid_request');
  }
  const input = args as Record<string, unknown>;
  if (!Array.isArray(input.candidates)) {
    throw new ProposalBatchInvariantError('invalid_request');
  }
  if (input.candidates.length === 0) {
    throw new ProposalBatchInvariantError('empty_candidates');
  }
  if (
    typeof input.actor !== 'string'
    || !BATCH_ACTOR_PATTERN.test(input.actor)
    || (input.at !== undefined && (
      typeof input.at !== 'number' || !Number.isSafeInteger(input.at) || input.at < 0
    ))
    || (input.assertExpectedRows !== undefined && typeof input.assertExpectedRows !== 'function')
  ) {
    throw new ProposalBatchInvariantError('invalid_request');
  }
  const audit = input.audit;
  if (
    typeof audit !== 'object'
    || audit === null
    || typeof (audit as Record<string, unknown>).reasonCode !== 'string'
    || !BATCH_REASON_PATTERN.test((audit as Record<string, unknown>).reasonCode as string)
    || typeof (audit as Record<string, unknown>).classifierVersion !== 'string'
    || !BATCH_VERSION_PATTERN.test((audit as Record<string, unknown>).classifierVersion as string)
    || typeof (audit as Record<string, unknown>).manifestId !== 'string'
    || !BATCH_MANIFEST_PATTERN.test((audit as Record<string, unknown>).manifestId as string)
  ) {
    throw new ProposalBatchInvariantError('invalid_audit');
  }

  const seen = new Set<number>();
  for (const candidate of input.candidates) {
    if (typeof candidate !== 'object' || candidate === null) {
      throw new ProposalBatchInvariantError('invalid_candidate');
    }
    const value = candidate as Record<string, unknown>;
    if (typeof value.id !== 'number' || !Number.isSafeInteger(value.id) || value.id <= 0) {
      throw new ProposalBatchInvariantError('invalid_candidate');
    }
    if (seen.has(value.id)) throw new ProposalBatchInvariantError('duplicate_id');
    seen.add(value.id);
    if (typeof value.expected !== 'object' || value.expected === null) {
      throw new ProposalBatchInvariantError('invalid_candidate');
    }
    const expected = value.expected as Record<string, unknown>;
    if (
      expected.status !== 'proposed'
      || !isNullableSafeTimestamp(expected.createdAt)
      || expected.createdAt === null
      || !isNullableSafeTimestamp(expected.updatedAt)
      || expected.updatedAt === null
      || !isNullableSafeTimestamp(expected.reviewByAt)
      || !isNullableSafeTimestamp(expected.sourceMessagePk)
      || (expected.sourceMessagePk !== null && expected.sourceMessagePk <= 0)
      || !isNullableString(expected.proposalReason)
      || expected.completedAt !== null
      || expected.cancelledAt !== null
    ) {
      throw new ProposalBatchInvariantError('invalid_candidate');
    }
  }
}

function rowMatchesBatchExpectation(row: BeadRow, candidate: RejectProposalBatchCandidate): boolean {
  const expected = candidate.expected;
  return row.id === candidate.id
    && row.status === expected.status
    && row.created_at === expected.createdAt
    && row.updated_at === expected.updatedAt
    && row.review_by_at === expected.reviewByAt
    && row.source_message_pk === expected.sourceMessagePk
    && row.proposal_reason === expected.proposalReason
    && row.completed_at === expected.completedAt
    && row.cancelled_at === expected.cancelledAt;
}

interface TransitionOperationOptions {
  extra?: Record<string, unknown>;
  updateCountError?: () => Error;
}

interface TransitionWriteResult {
  eventId: number;
  payloadJson: string;
  at: number;
}

function transitionWithinTransaction(
  db: DatabaseSync,
  current: BeadRow,
  toStatus: BeadStatus,
  args: TransitionArgs,
  options: TransitionOperationOptions = {},
): TransitionWriteResult {
  const at = args.at ?? nowUnixSec();
  const sets: string[] = ['status = ?', 'updated_at = ?'];
  const binds: SQLInputValue[] = [toStatus, at];
  if (toStatus === 'completed') { sets.push('completed_at = ?'); binds.push(at); }
  if (toStatus === 'cancelled') { sets.push('cancelled_at = ?'); binds.push(at); }
  const update = db.prepare(
    `UPDATE beads SET ${sets.join(', ')} WHERE id = ? AND status = ? AND updated_at = ?`,
  ).run(...binds, current.id, current.status, current.updated_at);
  if (Number(update.changes) !== 1) {
    throw options.updateCountError?.() ?? new Error('bead transition state changed before update');
  }
  const payload = {
    from: current.status, to: toStatus,
    ...options.extra,
    ...(args.note ? { note: args.note } : {}),
    ...(args.reason ? { reason: args.reason } : {}),
  };
  const eventId = writeBeadEvent(db, {
    beadId: current.id, eventType: 'status_change', actor: args.actor,
    payload,
    at,
  });
  return { eventId, payloadJson: JSON.stringify(payload), at };
}

function transition(
  db: DatabaseSync, id: number, toStatus: BeadStatus,
  args: TransitionArgs, extra: Record<string, unknown> = {},
  allowedFrom?: BeadStatus[],
  proposalOnly = false,
): void {
  withTransaction(db, () => {
    const current = db.prepare(`SELECT * FROM beads WHERE id = ?`).get(id) as unknown as BeadRow | undefined;
    if (!current) throw new Error(`bead ${id} not found`);
    if (proposalOnly && current.status !== 'proposed') {
      throw new Error(`bead ${id} is not proposed (status=${current.status})`);
    }
    if (TERMINAL.includes(current.status)) {
      throw new Error(`bead ${id} is in terminal status ${current.status}`);
    }
    if (allowedFrom && !allowedFrom.includes(current.status)) {
      throw new Error(`cannot transition from ${current.status} to ${toStatus}`);
    }
    transitionWithinTransaction(db, current, toStatus, args, { extra });
  });
}

export function completeBead(db: DatabaseSync, id: number, args: TransitionArgs): void {
  transition(db, id, 'completed', args);
}
export function cancelBead(db: DatabaseSync, id: number, args: TransitionArgs): void {
  transition(db, id, 'cancelled', args);
}
export function approveProposal(db: DatabaseSync, id: number, args: TransitionArgs): void {
  transition(db, id, 'active', args, {}, ['proposed'], true);
}
export function rejectProposal(db: DatabaseSync, id: number, args: TransitionArgs): void {
  transition(
    db, id, 'cancelled', args,
    args.reason ? { rejection_reason: args.reason } : {},
    ['proposed'], true,
  );
}

export function rejectProposalsBatch(
  db: DatabaseSync,
  args: RejectProposalsBatchArgs,
): RejectProposalsBatchResult {
  assertRejectProposalBatchArgs(args);
  const candidates = args.candidates.map((candidate) => ({
    id: candidate.id,
    expected: { ...candidate.expected },
  }));
  const actor = args.actor;
  const at = args.at;
  const audit = { ...args.audit };
  const assertExpectedRows = args.assertExpectedRows;
  return withImmediateTransaction(db, () => {
    const batchAt = at ?? nowUnixSec();
    const selectProposal = db.prepare('SELECT * FROM beads WHERE id = ?');
    const selectEvent = db.prepare(`
      SELECT bead_id, event_type, payload_json, actor, source_message_pk, created_at
      FROM bead_events
      WHERE id = ?
    `);
    const countEvents = db.prepare('SELECT COUNT(*) AS count FROM bead_events');
    const eventCountBefore = (countEvents.get() as { count: number }).count;
    const rows = candidates.map((candidate) => {
      const row = selectProposal.get(candidate.id) as unknown as BeadRow | undefined;
      if (!row) throw new ProposalBatchDriftError('missing');
      if (row.status !== 'proposed') throw new ProposalBatchDriftError('not_proposed');
      if (!rowMatchesBatchExpectation(row, candidate)) {
        throw new ProposalBatchDriftError('expected_state_mismatch');
      }
      return row;
    });

    if (assertExpectedRows) {
      const attestationRows = Object.freeze(rows.map((row) => Object.freeze({ ...row })));
      assertExpectedRows(attestationRows);
    }

    for (const row of rows) {
      const event = transitionWithinTransaction(db, row, 'cancelled', { actor, at: batchAt }, {
        extra: {
          rejection_reason: audit.reasonCode,
          classifier_version: audit.classifierVersion,
          manifest_id: audit.manifestId,
        },
        updateCountError: () => new ProposalBatchDriftError('update_count_mismatch'),
      });
      const storedEvent = selectEvent.get(event.eventId) as {
        bead_id: number;
        event_type: string;
        payload_json: string;
        actor: string;
        source_message_pk: number | null;
        created_at: number;
      } | undefined;
      if (
        !storedEvent
        || storedEvent.bead_id !== row.id
        || storedEvent.event_type !== 'status_change'
        || storedEvent.payload_json !== event.payloadJson
        || storedEvent.actor !== actor
        || storedEvent.source_message_pk !== null
        || storedEvent.created_at !== event.at
      ) {
        throw new ProposalBatchDriftError('event_identity_mismatch');
      }
    }
    const eventCountAfter = (countEvents.get() as { count: number }).count;
    const eventCount = eventCountAfter - eventCountBefore;
    if (eventCount !== rows.length) {
      throw new ProposalBatchDriftError('event_count_mismatch');
    }
    return { affectedCount: rows.length, eventCount };
  });
}

export interface ActivityFeedFilter { ownerJid?: string; since?: number; limit?: number; }

export function activityFeed(db: DatabaseSync, f: ActivityFeedFilter = {}): ActivityFeedRow[] {
  const limit = f.limit ?? 100;
  const since = f.since ?? 0;
  const beadEvents = db.prepare(
    `SELECT be.id, be.bead_id, be.event_type, be.payload_json, be.actor,
            be.source_message_pk, be.created_at, b.owner_jid
     FROM bead_events be
     JOIN beads b ON b.id = be.bead_id
     WHERE (? = '' OR b.owner_jid = ?)
       AND be.created_at >= ?
     ORDER BY be.created_at DESC
     LIMIT ?`
  ).all(f.ownerJid ?? '', f.ownerJid ?? '', since, limit) as Array<{
    id: number; bead_id: number; event_type: string; payload_json: string;
    actor: string; source_message_pk: number | null; created_at: number; owner_jid: string;
  }>;
  // Live-view observations only: NOT superseded, NOT forgotten. Matches the
  // same NOT EXISTS guard that getProfile uses (spec §4.7), so the activity
  // feed surface stays consistent with the profile read.
  const obs = db.prepare(
    `SELECT DISTINCT o.id, o.entity_id, o.kind AS observation_kind, o.text, o.created_at,
            o.source_message_pk, b.owner_jid
     FROM entity_observations o
     LEFT JOIN bead_entity_refs r ON r.entity_id = o.entity_id
     LEFT JOIN beads b ON b.id = r.bead_id
     WHERE o.forgotten = 0
       AND NOT EXISTS (
         SELECT 1 FROM entity_observations s
         -- QR-040: scope the supersede to the SAME entity (mirror getProfile) so
         -- a cross-entity observation cannot hide this one in the activity feed.
         WHERE s.supersedes_observation_id = o.id AND s.forgotten = 0
           AND s.entity_id = o.entity_id
       )
       AND o.created_at >= ?
       AND (? = '' OR b.owner_jid = ?)
     ORDER BY o.created_at DESC
     LIMIT ?`
  ).all(since, f.ownerJid ?? '', f.ownerJid ?? '', limit) as Array<{
    id: number; entity_id: number; observation_kind: string; text: string;
    created_at: number; source_message_pk: number | null; owner_jid: string | null;
  }>;
  const rows: ActivityFeedRow[] = [
    ...beadEvents.map((r): ActivityFeedRow => ({
      source: 'bead_event', created_at: r.created_at,
      bead_id: r.bead_id, event_type: r.event_type,
      text: r.payload_json, actor: r.actor,
      source_message_pk: r.source_message_pk ?? undefined,
      owner_jid: r.owner_jid,
    })),
    ...obs.map((r): ActivityFeedRow => ({
      source: 'entity_observation', created_at: r.created_at,
      entity_id: r.entity_id, observation_kind: r.observation_kind,
      text: r.text,
      source_message_pk: r.source_message_pk ?? undefined,
      owner_jid: r.owner_jid ?? undefined,
    })),
  ];
  rows.sort((a, b) => b.created_at - a.created_at);
  return rows.slice(0, limit);
}
