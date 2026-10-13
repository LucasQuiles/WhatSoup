// src/core/substrate/triggers.ts
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { z } from 'zod';
import RE2 from 're2';
import { clampTtl } from './time.ts';
import { type Clock, systemClock } from '../../lib/clock.ts';
import { writeBeadEvent } from './events.ts';
import type { TriggerKind, TriggerRow, TriggerStatus, OnTerminal } from './types.ts';
import { nextCronRun } from '../cron.ts';
import { createChildLogger } from '../../logger.ts';
import { queryAll, queryOne } from '../../lib/db-query.ts';
import { TRIGGER_BUDGETS } from './trigger-budgets.ts';

export { TRIGGER_BUDGETS } from './trigger-budgets.ts';

const log = createChildLogger('substrate.triggers');

// #1757: a legit epoch-SECONDS fire_at stays under this ceiling — no real
// schedule needs to reach 75 years out. An epoch-MILLISECONDS value for any
// present-day date clears it by 3 orders of magnitude, so the two units never
// overlap near the ceiling: anything above it is unambiguously mis-unit, not
// a plausible seconds timestamp.
export const MAX_REASONABLE_FIRE_AT_SEC = 4_102_444_800; // 2100-01-01T00:00:00Z

/** A content-free admission error safe to persist as a resource disposition. */
export class TriggerBudgetError extends Error {
  readonly budget: string;

  constructor(budget: string) {
    super(`trigger resource budget exceeded: ${budget}`);
    this.name = 'TriggerBudgetError';
    this.budget = budget;
  }
}

function budgetError(budget: string): never {
  throw new TriggerBudgetError(budget);
}

export function assertTriggerTextBudget(value: string, budget: string, maxBytes: number): void {
  if (Buffer.byteLength(value, 'utf8') > maxBytes) budgetError(budget);
}

function boundedText(schema: z.ZodString, maxBytes: number, budget: string) {
  return schema.refine((value) => Buffer.byteLength(value, 'utf8') <= maxBytes, {
    message: `${budget} exceeds its UTF-8 byte budget`,
  });
}

/**
 * Bounds an untrusted JSON-shaped value before validation or persistence. The
 * canonical serialized-byte check below catches punctuation and object-key
 * overhead; this walk prevents deeply nested/over-wide inputs from turning that
 * check itself into an allocation or recursion sink.
 */
export function assertTriggerValueBudget(
  value: unknown,
  budget = 'spec',
  maxBytes: number = TRIGGER_BUDGETS.maxSpecBytes,
): void {
  const seen = new WeakSet<object>();
  let scalarBytes = 0;
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > TRIGGER_BUDGETS.maxSpecDepth) budgetError(`${budget}.depth`);
    if (candidate === null || typeof candidate === 'boolean') return;
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) budgetError(`${budget}.number`);
      return;
    }
    if (typeof candidate === 'string') {
      scalarBytes += Buffer.byteLength(candidate, 'utf8');
      if (scalarBytes > maxBytes) budgetError(`${budget}.bytes`);
      return;
    }
    if (Array.isArray(candidate)) {
      if (candidate.length > TRIGGER_BUDGETS.maxCollectionItems) budgetError(`${budget}.items`);
      for (const entry of candidate) visit(entry, depth + 1);
      return;
    }
    if (typeof candidate !== 'object' || candidate === null) budgetError(`${budget}.type`);
    if (seen.has(candidate)) budgetError(`${budget}.cycle`);
    seen.add(candidate);
    const proto = Object.getPrototypeOf(candidate);
    if (proto !== Object.prototype && proto !== null) budgetError(`${budget}.type`);
    const entries = Object.entries(candidate as Record<string, unknown>);
    if (entries.length > TRIGGER_BUDGETS.maxCollectionItems) budgetError(`${budget}.items`);
    for (const [key, entry] of entries) {
      // JSON persistence omits undefined object properties. Keep that existing
      // compatibility behavior, while arrays and SQLite binds still reject an
      // undefined element through their own schemas below.
      if (entry === undefined) continue;
      scalarBytes += Buffer.byteLength(key, 'utf8');
      if (scalarBytes > maxBytes) budgetError(`${budget}.bytes`);
      visit(entry, depth + 1);
    }
  };
  visit(value, 0);
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    budgetError(`${budget}.serializable`);
  }
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    budgetError(`${budget}.serialized_bytes`);
  }
}

function assertOptionalText(record: Record<string, unknown>, key: string, budget: string, maxBytes: number): void {
  const value = record[key];
  if (typeof value === 'string') assertTriggerTextBudget(value, budget, maxBytes);
}

function assertKnownTriggerTextBudgets(kind: TriggerKind, value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
  const spec = value as Record<string, unknown>;
  switch (kind) {
    case 'schedule.cron':
      assertOptionalText(spec, 'expr', 'cron.expr', TRIGGER_BUDGETS.maxCronBytes);
      assertOptionalText(spec, 'tz', 'cron.tz', TRIGGER_BUDGETS.maxTimezoneBytes);
      return;
    case 'poll.email':
      assertOptionalText(spec, 'sender', 'email.sender', TRIGGER_BUDGETS.maxTextBytes);
      assertOptionalText(spec, 'label', 'email.label', TRIGGER_BUDGETS.maxTextBytes);
      assertOptionalText(spec, 'subject_regex', 'regex', TRIGGER_BUDGETS.maxRegexBytes);
      assertOptionalText(spec, 'body_regex', 'regex', TRIGGER_BUDGETS.maxRegexBytes);
      return;
    case 'poll.url':
      assertOptionalText(spec, 'url', 'url', TRIGGER_BUDGETS.maxUrlBytes);
      assertOptionalText(spec, 'selector', 'selector', TRIGGER_BUDGETS.maxSelectorBytes);
      return;
    case 'poll.file':
      assertOptionalText(spec, 'path', 'file.path', TRIGGER_BUDGETS.maxFilePathBytes);
      return;
    case 'poll.sqlite':
      assertOptionalText(spec, 'sql', 'sqlite.sql', TRIGGER_BUDGETS.maxSqlBytes);
      return;
    case 'poll.pinecone':
      assertOptionalText(spec, 'index', 'pinecone.index', TRIGGER_BUDGETS.maxPineconeIndexBytes);
      assertOptionalText(spec, 'namespace', 'pinecone.namespace', TRIGGER_BUDGETS.maxPineconeNamespaceBytes);
      assertOptionalText(spec, 'query', 'pinecone.query', TRIGGER_BUDGETS.maxPineconeQueryBytes);
      return;
    case 'poll.shell': {
      assertOptionalText(spec, 'cwd', 'shell.cwd', TRIGGER_BUDGETS.maxFilePathBytes);
      assertOptionalText(spec, 'regex', 'regex', TRIGGER_BUDGETS.maxRegexBytes);
      const argv = spec['argv'];
      if (Array.isArray(argv)) {
        for (const entry of argv) {
          if (typeof entry === 'string') assertTriggerTextBudget(entry, 'shell.argv', TRIGGER_BUDGETS.maxTextBytes);
        }
      }
      return;
    }
    case 'event.message':
      assertOptionalText(spec, 'value', 'message.value', TRIGGER_BUDGETS.maxTextBytes);
      assertOptionalText(spec, 'chat_jid', 'message.chat_jid', TRIGGER_BUDGETS.maxReportTargetBytes);
      return;
    case 'schedule.at_time':
      return;
  }
}

function isBoundedRe2Pattern(value: string): boolean {
  if (Buffer.byteLength(value, 'utf8') > TRIGGER_BUDGETS.maxRegexBytes) return false;
  try {
    // RE2 rejects look-around and backreferences and has no catastrophic
    // backtracking. It is the canonical engine for untrusted patterns here.
    new RE2(value);
    return true;
  } catch {
    return false;
  }
}

function isBoundedSelector(value: string): boolean {
  if (Buffer.byteLength(value, 'utf8') > TRIGGER_BUDGETS.maxSelectorBytes) return false;
  // css-select can traverse recursively for content-sensitive pseudos. URL
  // watches intentionally admit a compatibility-friendly structural subset:
  // tags, ids, classes, attributes, and ordinary child/sibling/descendant
  // combinators. Pseudos that inspect nested content or apply a subselector
  // are rejected instead of relying on an unbounded evaluator.
  if (/:\s*(?:has|contains|matches|not|is|where)\s*\(/i.test(value)) return false;
  let bracketDepth = 0;
  let combinators = 0;
  for (const character of value) {
    if (character === '[') bracketDepth++;
    if (character === ']') {
      bracketDepth--;
      if (bracketDepth < 0) return false;
    }
    if (character === '>' || character === '+' || character === '~' || character === ',') combinators++;
    if (combinators > TRIGGER_BUDGETS.maxSelectorCombinators) return false;
  }
  if (bracketDepth !== 0) return false;
  return !/[{};]/u.test(value);
}

function assertSqliteBindBudget(binds: unknown): void {
  if (binds === undefined) return;
  const values = Array.isArray(binds)
    ? binds
    : (typeof binds === 'object' && binds !== null && Object.getPrototypeOf(binds) === Object.prototype
      ? Object.values(binds as Record<string, unknown>)
      : budgetError('sqlite.binds.type'));
  if (values.length > TRIGGER_BUDGETS.maxSqliteBinds) budgetError('sqlite.binds.count');
  let total = 0;
  if (!Array.isArray(binds)) {
    for (const key of Object.keys(binds as Record<string, unknown>)) {
      assertTriggerTextBudget(key, 'sqlite.binds.key_bytes', TRIGGER_BUDGETS.maxSqliteBindBytes);
    }
  }
  for (const value of values) {
    if (value !== null && typeof value !== 'string' && typeof value !== 'number') budgetError('sqlite.binds.type');
    if (typeof value === 'number' && !Number.isFinite(value)) budgetError('sqlite.binds.number');
    const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
    if (bytes > TRIGGER_BUDGETS.maxSqliteBindBytes) budgetError('sqlite.binds.value_bytes');
    total += bytes;
    if (total > TRIGGER_BUDGETS.maxSqliteBindPayloadBytes) budgetError('sqlite.binds.payload_bytes');
  }
}

/**
 * `fire_at` is caller-supplied and unit-ambiguous (epoch-seconds vs.
 * epoch-milliseconds). Normalize a ms-range value down rather than reject
 * outright — rejecting would recreate the exact silent failure this closes
 * (#1757): the create call would fail with no owner-visible signal instead of
 * scheduling correctly. Only reject when NEITHER unit interpretation is
 * plausible (corrupt/garbage input).
 */
export function normalizeFireAtSeconds(fireAt: number): number {
  if (fireAt <= MAX_REASONABLE_FIRE_AT_SEC) return fireAt;
  const asSeconds = Math.round(fireAt / 1000);
  if (asSeconds <= MAX_REASONABLE_FIRE_AT_SEC) {
    log.warn(
      { fireAtRaw: fireAt, fireAtNormalized: asSeconds },
      'fire_at exceeded the epoch-seconds ceiling; normalized as epoch-milliseconds (#1757)',
    );
    return asSeconds;
  }
  throw new Error(
    `fire_at ${fireAt} is not a plausible epoch-seconds or epoch-milliseconds timestamp ` +
    `(ceiling ${MAX_REASONABLE_FIRE_AT_SEC}s / year 2100)`,
  );
}

/**
 * Guard for `poll.sqlite` specs. `query_only` blocks writes but not cross-database
 * reads, runtime knob flips, or CPU/time, so reject statements that could exfiltrate
 * beyond the intended query or freeze the synchronous DatabaseSync: ATTACH/DETACH
 * (pull in other DB files), PRAGMA, multi-statement bodies, and recursive CTEs.
 * Defense-in-depth for admin-gated specs (#1096, QR-026).
 */
export function isSafeSqliteSql(sql: string): boolean {
  if (Buffer.byteLength(sql, 'utf8') > TRIGGER_BUDGETS.maxSqlBytes) return false;
  // Strip one optional trailing semicolon; any remaining ';' implies 2+ statements.
  const trimmed = sql.trim().replace(/;\s*$/, '');
  if (!/^(?:select\b|with\b)/i.test(trimmed)) return false;
  if (trimmed.includes(';')) return false;
  if (/\b(attach|detach|pragma)\b/i.test(trimmed)) return false;
  // QR-026: a recursive CTE runs unbounded CPU under query_only (writes blocked, compute
  // is not), and node:sqlite DatabaseSync is synchronous with no statement-time interrupt.
  // The poller's MAX_SQLITE_ROWS cap only bounds row-RETURNING queries — a count/aggregate
  // over a recursive CTE (e.g. `WITH RECURSIVE r(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM r
  // WHERE x<1e12) SELECT count(*) FROM r`) returns ONE row and freezes the whole process
  // before the cap can fire. poll.sqlite monitoring specs never need recursion — reject it.
  if (/\brecursive\b/i.test(trimmed)) return false;
  return true;
}

const BoundedRegex = boundedText(z.string(), TRIGGER_BUDGETS.maxRegexBytes, 'regex').refine(isBoundedRe2Pattern, {
  message: 'regex must compile with RE2 and fit the trigger regex budget',
});
const BoundedSelector = boundedText(z.string(), TRIGGER_BUDGETS.maxSelectorBytes, 'selector').refine(isBoundedSelector, {
  message: 'selector must be a bounded structural CSS selector without nested content pseudos',
});
const CronSpec    = z.object({
  expr: boundedText(z.string().min(1), TRIGGER_BUDGETS.maxCronBytes, 'cron.expr'),
  tz: boundedText(z.string(), TRIGGER_BUDGETS.maxTimezoneBytes, 'cron.tz').optional(),
}).strict();
const AtTimeSpec  = z.object({ fire_at: z.number().int().positive() }).strict();
const EmailSpec   = z.object({
  source: z.enum(['gmail','m365']),
  sender: boundedText(z.string(), TRIGGER_BUDGETS.maxTextBytes, 'email.sender').optional(),
  subject_regex: BoundedRegex.optional(),
  label: boundedText(z.string(), TRIGGER_BUDGETS.maxTextBytes, 'email.label').optional(),
  body_regex: BoundedRegex.optional(),
}).strict();
const UrlSpec     = z.object({
  url: boundedText(z.string().url(), TRIGGER_BUDGETS.maxUrlBytes, 'url'),
  selector: BoundedSelector.optional(),
  hash_mode: z.enum(['text','selector','headers']),
}).strict();
const FileSpec    = z.object({
  path: boundedText(z.string().min(1), TRIGGER_BUDGETS.maxFilePathBytes, 'file.path'),
  watch: z.enum(['exists','mtime','content_hash']),
}).strict();
const SqliteSpec  = z.object({
  sql: boundedText(z.string().min(1), TRIGGER_BUDGETS.maxSqlBytes, 'sqlite.sql').refine(isSafeSqliteSql, {
    message: 'sql must be a single statement with no ATTACH/DETACH/PRAGMA',
  }),
  // Prefer an array for positional `?` binds (reliable order). A legacy object
  // is still accepted for back-compat, but is unsafe for 2+ integer-like keys.
  binds: z.union([
    z.array(z.union([boundedText(z.string(), TRIGGER_BUDGETS.maxSqliteBindBytes, 'sqlite.binds.value'), z.number().finite(), z.null()])).max(TRIGGER_BUDGETS.maxSqliteBinds),
    z.record(z.union([boundedText(z.string(), TRIGGER_BUDGETS.maxSqliteBindBytes, 'sqlite.binds.value'), z.number().finite(), z.null()])).refine(
      (binds) => Object.keys(binds).length <= TRIGGER_BUDGETS.maxSqliteBinds,
      { message: 'too many SQLite binds' },
    ),
  ]).optional(),
  fire_when: z.enum(['rows_returned','rowcount_changed']),
}).strict();
const PineconeSpec = z.object({
  index: boundedText(z.string().min(1), TRIGGER_BUDGETS.maxPineconeIndexBytes, 'pinecone.index'),
  namespace: boundedText(z.string(), TRIGGER_BUDGETS.maxPineconeNamespaceBytes, 'pinecone.namespace'),
  query: boundedText(z.string().min(1), TRIGGER_BUDGETS.maxPineconeQueryBytes, 'pinecone.query'),
  top_k: z.number().int().positive().max(TRIGGER_BUDGETS.maxPineconeTopK).optional(),
  threshold: z.number().min(0).max(1).optional(),
}).strict();
// poll.shell is REMOVED FROM CREATION (dropped from the create_watch enum) but
// RETAINED INTERNALLY here for legacy fail-closed handling: a row persisted
// before removal still validates so the poller can reject it cleanly
// (errorKind 'shell_watch_removed') rather than crashing on an unknown kind.
const ShellSpec   = z.object({
  argv: z.array(boundedText(z.string(), TRIGGER_BUDGETS.maxTextBytes, 'shell.argv')).min(1).max(TRIGGER_BUDGETS.maxCollectionItems),
  cwd: boundedText(z.string(), TRIGGER_BUDGETS.maxFilePathBytes, 'shell.cwd').optional(),
  fire_when: z.enum(['exit_zero','stdout_nonempty','stdout_regex']),
  regex: BoundedRegex.optional(),
}).strict();
const MessageSpec = z.object({
  match: z.enum(['sender_jid','regex','mention']),
  value: boundedText(z.string().min(1), TRIGGER_BUDGETS.maxTextBytes, 'message.value'),
  chat_jid: boundedText(z.string(), TRIGGER_BUDGETS.maxReportTargetBytes, 'message.chat_jid').optional(),
}).strict();

const SPEC_REGISTRY: Record<TriggerKind, z.ZodType> = {
  'schedule.cron':    CronSpec,
  'schedule.at_time': AtTimeSpec,
  'poll.email':       EmailSpec,
  'poll.url':         UrlSpec,
  'poll.file':        FileSpec,
  'poll.sqlite':      SqliteSpec,
  'poll.pinecone':    PineconeSpec,
  'poll.shell':       ShellSpec,
  'event.message':    MessageSpec,
};

export function validateTriggerSpec(kind: TriggerKind, spec: unknown): unknown {
  const schema = SPEC_REGISTRY[kind];
  if (!schema) throw new Error(`unknown trigger kind: ${kind}`);
  assertTriggerValueBudget(spec);
  assertKnownTriggerTextBudgets(kind, spec);
  if (kind === 'poll.sqlite' && typeof spec === 'object' && spec !== null) {
    assertSqliteBindBudget((spec as { binds?: unknown }).binds);
  }
  const validated = schema.parse(spec);
  const serialized = JSON.stringify(validated);
  if (Buffer.byteLength(serialized, 'utf8') > TRIGGER_BUDGETS.maxSpecBytes) {
    budgetError('spec.serialized_bytes');
  }
  return validated;
}

export interface CreateTriggerArgs {
  beadId: number; kind: TriggerKind; spec: unknown;
  reportChatJid: string;
  intervalSeconds?: number | null; nextFireAt?: number | null;
  requestedTerminalAt?: number | null; maxTtlHours?: number;
  onTerminal?: OnTerminal; dedupeKey?: string | null;
  actor: string;
}

interface PreparedTrigger {
  validated: unknown;
  now: number;
  terminalAt: number | null;
  nextFireAt: number | null;
}

function computeNextFireAt(
  kind: TriggerKind,
  spec: unknown,
  now: number,
  intervalSeconds: number | null,
): number | null {
  if (kind === 'schedule.cron') {
    // QR-092: honor the persisted tz (CronSpec.tz) instead of silently evaluating
    // in UTC — parity with the scheduled_messages path. Default to UTC when absent.
    const { expr, tz } = spec as { expr: string; tz?: string };
    return nextCronRun(expr, now, tz ?? 'UTC');
  }
  if (kind === 'schedule.at_time') {
    return normalizeFireAtSeconds((spec as { fire_at: number }).fire_at);
  }
  // event.message is a RESERVED SCAFFOLD: validated + persisted, but not yet
  // executed (a future ingest-path integration will own it; the design exists).
  // Return NULL so the row sits with next_fire_at = NULL — dueTriggers requires
  // `next_fire_at IS NOT NULL`, so the interval poller never selects/churns it
  // (no silent 1h not_implemented reschedule). It still TTL-expires via the
  // kind-agnostic terminal_at sweep in the poller.
  if (kind === 'event.message') return null;
  if (intervalSeconds && intervalSeconds > 0) return now + intervalSeconds;
  return now;
}

export function prepareTrigger(args: CreateTriggerArgs, clock: Clock = systemClock): PreparedTrigger {
  assertTriggerTextBudget(args.reportChatJid, 'report_target.bytes', TRIGGER_BUDGETS.maxReportTargetBytes);
  if (args.dedupeKey != null) {
    assertTriggerTextBudget(args.dedupeKey, 'dedupe_key.bytes', TRIGGER_BUDGETS.maxDedupeKeyBytes);
  }
  if (args.intervalSeconds != null && (!Number.isInteger(args.intervalSeconds) || args.intervalSeconds <= 0)) {
    budgetError('interval_seconds');
  }
  const validated = validateTriggerSpec(args.kind, args.spec);
  const now = clock.nowUnixSec();
  const terminalAt = args.kind.startsWith('poll.')
    ? clampTtl(now, args.requestedTerminalAt ?? null, args.maxTtlHours ?? 24)
    : (args.requestedTerminalAt ?? null);
  const nextFireAt = args.nextFireAt ?? computeNextFireAt(args.kind, validated, now, args.intervalSeconds ?? null);

  return { validated, now, terminalAt, nextFireAt };
}

export function createTrigger(db: DatabaseSync, args: CreateTriggerArgs, clock: Clock = systemClock): TriggerRow {
  const { validated, now, terminalAt, nextFireAt } = prepareTrigger(args, clock);
  db.exec('BEGIN');
  try {
    // QR-046: dedupe_key is an idempotency key. It is stored + indexed
    // (idx_triggers_dedupe ON (kind, dedupe_key)) and exposed on create_watch, but
    // was never queried — so re-creating a watch with the same (kind, dedupe_key)
    // inserted a DUPLICATE trigger (double fires + 2x the bounded poll cost). If a
    // LIVE (active/paused) trigger already exists for this (kind, dedupe_key), return
    // it instead of inserting. Terminal rows (expired/cancelled/failed) do NOT dedupe,
    // so a watch can be legitimately re-armed after it has ended.
    if (args.dedupeKey) {
      const existing = db.prepare(
        `SELECT * FROM bead_triggers
         WHERE kind = ? AND dedupe_key = ? AND status IN ('active','paused')
         ORDER BY id LIMIT 1`,
      ).get(args.kind, args.dedupeKey) as unknown as TriggerRow | undefined;
      if (existing) {
        db.exec('COMMIT');
        return existing;
      }
    }
    const info = db.prepare(
      `INSERT INTO bead_triggers (
         bead_id, kind, spec_json, spec_version, status, interval_seconds,
         next_fire_at, last_fire_at, terminal_at, on_terminal, report_chat_jid,
         dedupe_key, created_at, updated_at
       ) VALUES (?, ?, ?, 1, 'active', ?, ?, NULL, ?, ?, ?, ?, ?, ?)`
    ).run(
      args.beadId, args.kind, JSON.stringify(validated),
      args.intervalSeconds ?? null, nextFireAt, terminalAt,
      args.onTerminal ?? 'notify', args.reportChatJid,
      args.dedupeKey ?? null, now, now,
    );
    const triggerId = Number(info.lastInsertRowid);
    writeBeadEvent(db, {
      beadId: args.beadId, eventType: 'trigger_created', actor: args.actor,
      payload: { trigger_id: triggerId, kind: args.kind, next_fire_at: nextFireAt, terminal_at: terminalAt },
      at: now,
    });
    const row = db.prepare(`SELECT * FROM bead_triggers WHERE id = ?`).get(triggerId) as unknown as TriggerRow;
    db.exec('COMMIT');
    return row;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* best effort */ }
    throw err;
  }
}

export interface ListTriggersFilter { beadId?: number; kind?: TriggerKind; status?: TriggerRow['status']; }

export function listTriggers(db: DatabaseSync, f: ListTriggersFilter = {}): TriggerRow[] {
  const w: string[] = [];
  const b: SQLInputValue[] = [];
  if (f.beadId != null) { w.push('bead_id = ?'); b.push(f.beadId); }
  if (f.kind)           { w.push('kind = ?');    b.push(f.kind); }
  if (f.status)         { w.push('status = ?');  b.push(f.status); }
  const sql = `SELECT * FROM bead_triggers ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY id ASC`;
  return db.prepare(sql).all(...b) as unknown as TriggerRow[];
}

export function pauseTrigger(db: DatabaseSync, id: number, args: { actor: string }, clock: Clock = systemClock): void {
  const t = db.prepare(`SELECT bead_id FROM bead_triggers WHERE id = ?`).get(id) as { bead_id: number } | undefined;
  if (!t) throw new Error(`trigger ${id} not found`);
  const now = clock.nowUnixSec();
  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE bead_triggers SET status='paused', next_fire_at=NULL, updated_at=? WHERE id=?`).run(now, id);
    writeBeadEvent(db, { beadId: t.bead_id, eventType: 'trigger_paused', actor: args.actor, payload: { trigger_id: id }, at: now });
    db.exec('COMMIT');
  } catch (err) { try { db.exec('ROLLBACK'); } catch { /* best effort */ } throw err; }
}

export interface ExtendTriggerResult {
  status: TriggerStatus;
  terminal_at: number;
}

/**
 * Deadline-only (#2417, #3608): moves terminal_at and nothing else. A paused
 * trigger stays paused with next_fire_at NULL; resuming is resumeTrigger's job,
 * so an operator can push a deadline without also making the trigger due.
 */
export function extendTrigger(db: DatabaseSync, id: number, args: { until: number; maxTtlHours: number; actor: string }, clock: Clock = systemClock): ExtendTriggerResult {
  const now = clock.nowUnixSec();
  if (args.until <= now) throw new Error(`extendTrigger: until must be in the future`);
  const t = db.prepare(`SELECT bead_id, status FROM bead_triggers WHERE id = ?`).get(id) as { bead_id: number; status: TriggerStatus } | undefined;
  if (!t) throw new Error(`trigger ${id} not found`);
  const clamped = clampTtl(now, args.until, args.maxTtlHours);
  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE bead_triggers SET terminal_at=?, updated_at=? WHERE id=?`).run(clamped, now, id);
    writeBeadEvent(db, { beadId: t.bead_id, eventType: 'trigger_extended', actor: args.actor, payload: { trigger_id: id, terminal_at: clamped, was_paused: t.status === 'paused' }, at: now });
    db.exec('COMMIT');
  } catch (err) { try { db.exec('ROLLBACK'); } catch { /* best effort */ } throw err; }
  return { status: t.status, terminal_at: clamped };
}

export interface ResumeTriggerArgs {
  actor: string;
  /** Make the trigger due now instead of at its next regular occurrence. */
  fireNow?: boolean;
  /** Optional new deadline, clamped like extendTrigger. Omitted = terminal_at unchanged. */
  until?: number;
  maxTtlHours: number;
  /** Mirrors create_watch: a poll.url trigger cannot be resumed while url watches are disabled. */
  enableUrlWatch?: boolean;
}

export interface ResumeTriggerResult {
  /** false when the trigger was already active (idempotent no-op). */
  resumed: boolean;
  status: 'active';
  next_fire_at: number | null;
  terminal_at: number | null;
  /** `reason` of the latest trigger_paused event (e.g. forbidden_target); null for a manual pause. */
  paused_reason: string | null;
}

function latestPauseReason(db: DatabaseSync, beadId: number, triggerId: number): string | null {
  const row = queryOne<{ reason: string | null }>(
    db,
    `SELECT json_extract(payload_json, '$.reason') AS reason FROM bead_events
     WHERE bead_id = ? AND event_type = 'trigger_paused'
       AND json_extract(payload_json, '$.trigger_id') = ?
     ORDER BY id DESC LIMIT 1`,
    beadId, triggerId,
  );
  return typeof row?.reason === 'string' ? row.reason : null;
}

/**
 * #3608: the only way to reactivate a paused trigger. Re-validates the stored
 * spec with the creation rules, schedules the next regular occurrence (not
 * "now", so a daily job keeps its slot) unless fireNow is set, keeps
 * terminal_at unless `until` is given, and records a distinct trigger_resumed
 * event. The poller's failure counters read trigger_runs history, so a resumed
 * trigger that fails again is re-paused on its next failure.
 */
export function resumeTrigger(db: DatabaseSync, id: number, args: ResumeTriggerArgs, clock: Clock = systemClock): ResumeTriggerResult {
  const now = clock.nowUnixSec();
  const t = queryOne<TriggerRow>(db, `SELECT * FROM bead_triggers WHERE id = ?`, id);
  if (!t) throw new Error(`trigger ${id} not found`);
  if (t.status === 'active') {
    return { resumed: false, status: 'active', next_fire_at: t.next_fire_at, terminal_at: t.terminal_at, paused_reason: null };
  }
  if (t.status !== 'paused') {
    throw new Error(`resumeTrigger: trigger ${id} is ${t.status}; only a paused trigger can be resumed, recreate it instead`);
  }
  // Same target rules as creation: poll.shell was removed from creation, and
  // poll.url is gated off unless the instance enables it.
  if (t.kind === 'poll.shell') {
    throw new Error(`resumeTrigger: trigger ${id} is a poll.shell watch, which can no longer be created or resumed`);
  }
  if (t.kind === 'poll.url' && !args.enableUrlWatch) {
    throw new Error('resumeTrigger: url watch is disabled. Set advanced.enableUrlWatch: true in instance config to resume poll.url watches.');
  }
  const validated = validateTriggerSpec(t.kind, JSON.parse(t.spec_json));
  let terminalAt = t.terminal_at;
  if (args.until !== undefined) {
    if (args.until <= now) throw new Error(`resumeTrigger: until must be in the future`);
    terminalAt = clampTtl(now, args.until, args.maxTtlHours);
  }
  if (terminalAt !== null && terminalAt <= now) {
    throw new Error(`resumeTrigger: trigger ${id} deadline has passed; pass until, or call extend_trigger first`);
  }
  const nextFireAt = args.fireNow && t.kind !== 'event.message'
    ? now
    : computeNextFireAt(t.kind, validated, now, t.interval_seconds);
  const pausedReason = latestPauseReason(db, t.bead_id, id);
  db.exec('BEGIN');
  try {
    const info = db.prepare(
      `UPDATE bead_triggers SET status='active', next_fire_at=?, terminal_at=?, updated_at=?
       WHERE id=? AND status='paused'`,
    ).run(nextFireAt, terminalAt, now, id);
    // The status guard makes the write conditional on the row read above; if
    // another writer changed it in between, record nothing.
    if (info.changes === 0) throw new Error(`resumeTrigger: trigger ${id} changed while resuming; retry`);
    writeBeadEvent(db, {
      beadId: t.bead_id, eventType: 'trigger_resumed', actor: args.actor,
      payload: { trigger_id: id, next_fire_at: nextFireAt, terminal_at: terminalAt, fire_now: args.fireNow === true, paused_reason: pausedReason },
      at: now,
    });
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* by design: ROLLBACK can fail when the transaction never opened; the original error is rethrown below */ }
    throw err;
  }
  return { resumed: true, status: 'active', next_fire_at: nextFireAt, terminal_at: terminalAt, paused_reason: pausedReason };
}

/** Runtime helper for slice-3 poller. */
export function dueTriggers(db: DatabaseSync, now: number, batchSize: number): TriggerRow[] {
  return db.prepare(
    `SELECT * FROM bead_triggers
     WHERE status = 'active'
       AND next_fire_at IS NOT NULL
       AND next_fire_at <= ?
       AND (terminal_at IS NULL OR terminal_at > ?)
     ORDER BY next_fire_at ASC
     LIMIT ?`
  ).all(now, now, batchSize) as unknown as TriggerRow[];
}

/**
 * #1765 — default grace window (seconds) before an active, never-fired trigger
 * whose next_fire_at is in the past is treated as a liveness violation. 24h: a
 * healthy poller ticks every 30s, so a row this stale has missed thousands of
 * fire windows — it means the firing path is DOWN, not merely lagging.
 */
export const DEFAULT_TRIGGER_PAST_DUE_GRACE_SEC = 86_400;

/**
 * #1765 liveness gauge: count active triggers whose next_fire_at is more than
 * `graceSeconds` in the past AND that have never fired (last_fire_at IS NULL).
 * A healthy poller drains such a trigger within one tick (stamping
 * last_fire_at), so a non-zero count means the firing path failed silently —
 * nothing fired, and without this gauge nothing alerts. A dedicated COUNT
 * (mirroring countOverdueProposals) so the gauge stays accurate past any page
 * size. Note the strict `<`: a row exactly at `now - grace` is not yet past due.
 */
export function countPastDueTriggers(
  db: DatabaseSync,
  now?: number,
  graceSeconds: number = DEFAULT_TRIGGER_PAST_DUE_GRACE_SEC,
  clock: Clock = systemClock,
): number {
  const cutoff = (now === undefined ? clock.nowUnixSec() : now) - graceSeconds;
  const row = db.prepare(
    `SELECT COUNT(*) AS c FROM bead_triggers
     WHERE status = 'active'
       AND next_fire_at IS NOT NULL
       AND next_fire_at < ?
       AND last_fire_at IS NULL`,
  ).get(cutoff) as { c: number };
  return row.c;
}

/**
 * #2566 slice 4 — redacted trigger-run history row. Bounded fields ONLY:
 * no output_summary, no error_message prose, no output_json content, no
 * transport identifiers. Delivery evidence is reduced to booleans.
 */
export interface RedactedTriggerRun {
  id: number;
  triggerId: number;
  beadId: number;
  status: string;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  attempt: number;
  errorKind: string | null;
  delivered: boolean;
  notifyPending: boolean;
  throttled: boolean;
}

export interface ListTriggerRunsFilter {
  triggerId?: number;
  beadId?: number;
  limit?: number;
}

/** Newest-first redacted run history for a trigger or bead. */
export function listTriggerRunsRedacted(
  db: DatabaseSync,
  f: ListTriggerRunsFilter = {},
): RedactedTriggerRun[] {
  const w: string[] = [];
  const b: SQLInputValue[] = [];
  if (f.triggerId != null) { w.push('trigger_id = ?'); b.push(f.triggerId); }
  if (f.beadId != null)    { w.push('bead_id = ?');    b.push(f.beadId); }
  const limit = Math.min(Math.max(1, Math.floor(f.limit ?? 50)), 200);
  const rows = queryAll<{
    id: number; trigger_id: number; bead_id: number; status: string;
    started_at: number; finished_at: number | null; duration_ms: number | null;
    attempt: number; error_kind: string | null;
    delivered: number; notify_pending: number; throttled: number;
  }>(
    db,
    `SELECT id, trigger_id, bead_id, status, started_at, finished_at, duration_ms, attempt, error_kind,
            json_extract(output_json, '$.deliveredWaMessageId') IS NOT NULL AS delivered,
            COALESCE(json_extract(output_json, '$.notifyPending'), 0) AS notify_pending,
            COALESCE(json_extract(output_json, '$.throttled'), 0) AS throttled
       FROM trigger_runs
       ${w.length ? 'WHERE ' + w.join(' AND ') : ''}
       ORDER BY id DESC LIMIT ?`,
    ...b, limit,
  );
  return rows.map((r) => ({
    id: r.id, triggerId: r.trigger_id, beadId: r.bead_id, status: r.status,
    startedAt: r.started_at, finishedAt: r.finished_at, durationMs: r.duration_ms,
    attempt: r.attempt, errorKind: r.error_kind,
    delivered: r.delivered === 1,
    notifyPending: r.notify_pending === 1,
    throttled: r.throttled === 1,
  }));
}

/** Default grace before a previously-fired trigger counts as recurring-overdue. */
export const DEFAULT_RECURRING_OVERDUE_GRACE_SEC = 900;

/**
 * #2566 slice 2 — recurring-overdue gauge: count active triggers that HAVE
 * fired before (last_fire_at IS NOT NULL) but whose next_fire_at is more than
 * `graceSeconds` in the past. The #1765 gauge above covers the never-fired
 * case; together they partition "active with a stale next_fire_at" exactly.
 * Prior-failure rows count too (deliberate superset of "after prior success"):
 * a stalled firing path matters regardless of the last outcome.
 */
export function countRecurringOverdueTriggers(
  db: DatabaseSync,
  now?: number,
  graceSeconds: number = DEFAULT_RECURRING_OVERDUE_GRACE_SEC,
  clock: Clock = systemClock,
): number {
  const cutoff = (now === undefined ? clock.nowUnixSec() : now) - graceSeconds;
  const row = db.prepare(
    `SELECT COUNT(*) AS c FROM bead_triggers
     WHERE status = 'active'
       AND next_fire_at IS NOT NULL
       AND next_fire_at < ?
       AND last_fire_at IS NOT NULL`,
  ).get(cutoff) as { c: number };
  return row.c;
}
