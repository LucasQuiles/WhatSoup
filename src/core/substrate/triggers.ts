// src/core/substrate/triggers.ts
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { z } from 'zod';
import { nowUnixSec, clampTtl } from './time.ts';
import { writeBeadEvent } from './events.ts';
import type { TriggerKind, TriggerRow, OnTerminal } from './types.ts';
import { nextCronRun } from '../cron.ts';

/**
 * Guard for `poll.sqlite` specs. `query_only` blocks writes but not cross-database
 * reads or runtime knob flips, so reject statements that could exfiltrate beyond
 * the intended query: ATTACH/DETACH (pull in other DB files), PRAGMA, and
 * multi-statement bodies. Defense-in-depth for admin-gated specs (#1096).
 */
export function isSafeSqliteSql(sql: string): boolean {
  // Strip one optional trailing semicolon; any remaining ';' implies 2+ statements.
  const trimmed = sql.trim().replace(/;\s*$/, '');
  if (trimmed.includes(';')) return false;
  if (/\b(attach|detach|pragma)\b/i.test(trimmed)) return false;
  return true;
}

const CronSpec    = z.object({ expr: z.string().min(1), tz: z.string().optional() });
const AtTimeSpec  = z.object({ fire_at: z.number().int().positive() });
const EmailSpec   = z.object({
  source: z.enum(['gmail','m365']),
  sender: z.string().optional(),
  subject_regex: z.string().optional(),
  label: z.string().optional(),
  body_regex: z.string().optional(),
});
const UrlSpec     = z.object({
  url: z.string().url(),
  selector: z.string().optional(),
  hash_mode: z.enum(['text','selector','headers']),
});
const FileSpec    = z.object({
  path: z.string().min(1),
  watch: z.enum(['exists','mtime','content_hash']),
});
const SqliteSpec  = z.object({
  sql: z.string().min(1).refine(isSafeSqliteSql, {
    message: 'sql must be a single statement with no ATTACH/DETACH/PRAGMA',
  }),
  // Prefer an array for positional `?` binds (reliable order). A legacy object
  // is still accepted for back-compat, but is unsafe for 2+ integer-like keys.
  binds: z.union([z.array(z.unknown()), z.record(z.unknown())]).optional(),
  fire_when: z.enum(['rows_returned','rowcount_changed']),
});
const PineconeSpec = z.object({
  index: z.string().min(1),
  namespace: z.string(),
  query: z.string().min(1),
  top_k: z.number().int().positive().optional(),
  threshold: z.number().min(0).max(1).optional(),
});
// poll.shell is REMOVED FROM CREATION (dropped from the create_watch enum) but
// RETAINED INTERNALLY here for legacy fail-closed handling: a row persisted
// before removal still validates so the poller can reject it cleanly
// (errorKind 'shell_watch_removed') rather than crashing on an unknown kind.
const ShellSpec   = z.object({
  argv: z.array(z.string()).min(1),
  cwd: z.string().optional(),
  fire_when: z.enum(['exit_zero','stdout_nonempty','stdout_regex']),
  regex: z.string().optional(),
});
const MessageSpec = z.object({
  match: z.enum(['sender_jid','regex','mention']),
  value: z.string().min(1),
  chat_jid: z.string().optional(),
});

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
  return schema.parse(spec);
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
    const { expr } = spec as { expr: string; tz?: string };
    return nextCronRun(expr, now);
  }
  if (kind === 'schedule.at_time') {
    return (spec as { fire_at: number }).fire_at;
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

export function prepareTrigger(args: CreateTriggerArgs): PreparedTrigger {
  const validated = validateTriggerSpec(args.kind, args.spec);
  const now = nowUnixSec();
  const terminalAt = args.kind.startsWith('poll.')
    ? clampTtl(now, args.requestedTerminalAt ?? null, args.maxTtlHours ?? 24)
    : (args.requestedTerminalAt ?? null);
  const nextFireAt = args.nextFireAt ?? computeNextFireAt(args.kind, validated, now, args.intervalSeconds ?? null);

  return { validated, now, terminalAt, nextFireAt };
}

export function createTrigger(db: DatabaseSync, args: CreateTriggerArgs): TriggerRow {
  const { validated, now, terminalAt, nextFireAt } = prepareTrigger(args);
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

export function pauseTrigger(db: DatabaseSync, id: number, args: { actor: string }): void {
  const t = db.prepare(`SELECT bead_id FROM bead_triggers WHERE id = ?`).get(id) as { bead_id: number } | undefined;
  if (!t) throw new Error(`trigger ${id} not found`);
  const now = nowUnixSec();
  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE bead_triggers SET status='paused', next_fire_at=NULL, updated_at=? WHERE id=?`).run(now, id);
    writeBeadEvent(db, { beadId: t.bead_id, eventType: 'trigger_paused', actor: args.actor, payload: { trigger_id: id }, at: now });
    db.exec('COMMIT');
  } catch (err) { try { db.exec('ROLLBACK'); } catch { /* best effort */ } throw err; }
}

export function extendTrigger(db: DatabaseSync, id: number, args: { until: number; maxTtlHours: number; actor: string }): void {
  const now = nowUnixSec();
  if (args.until <= now) throw new Error(`extendTrigger: until must be in the future`);
  const t = db.prepare(`SELECT bead_id FROM bead_triggers WHERE id = ?`).get(id) as { bead_id: number } | undefined;
  if (!t) throw new Error(`trigger ${id} not found`);
  const clamped = clampTtl(now, args.until, args.maxTtlHours);
  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE bead_triggers SET terminal_at=?, updated_at=? WHERE id=?`).run(clamped, now, id);
    writeBeadEvent(db, { beadId: t.bead_id, eventType: 'trigger_extended', actor: args.actor, payload: { trigger_id: id, terminal_at: clamped }, at: now });
    db.exec('COMMIT');
  } catch (err) { try { db.exec('ROLLBACK'); } catch { /* best effort */ } throw err; }
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
