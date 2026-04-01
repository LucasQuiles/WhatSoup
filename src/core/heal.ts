// src/core/heal.ts
// Circuit breaker state machine and heal report management.

import { randomUUID } from 'node:crypto';
import { createChildLogger } from '../logger.ts';
import type { Database } from './database.ts';
import type { Messenger } from './types.ts';
import type { DurabilityEngine } from './durability.ts';
import { sendTracked } from './durability.ts';
import { normalizeErrorClass, type HealCompletePayload } from './heal-protocol.ts';
import { config } from '../config.ts';

const log = createChildLogger('heal');

const MAX_ATTEMPTS = 2;
const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const RESOLUTION_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
const GLOBAL_VALVE_LIMIT = 5;
const GLOBAL_VALVE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// Suppress unused variable warnings — these constants document the design intent
// and will be used when cooldown/resolution logic is wired in.
void COOLDOWN_MS;
void RESOLUTION_WINDOW_MS;

export interface HealReportData {
  type: 'crash' | 'degraded' | 'service_crash';
  chatJid?: string;
  exitCode?: number;
  signal?: string | null;
  stderr?: string;
  recentLogs?: string;
}

interface HealReportRow {
  report_id: string;
  error_class: string;
  error_type: string;
  state: string;
  attempt_count: number;
  cooldown_until: string | null;
  context: string | null;
  created_at: string;
}

/**
 * Emit a heal report for a given error condition.
 *
 * Single-flight: if an active report already exists for the same error_class,
 * the new one is suppressed (returns null).
 *
 * If activeControlReportId is provided, the new report is queued rather than
 * sent immediately (single-flight slot is occupied).
 *
 * Returns the reportId on success, or null if suppressed by single-flight or
 * global valve.
 */
export function emitHealReport(
  db: Database,
  messenger: Messenger,
  durability: DurabilityEngine | null,
  data: HealReportData,
  activeControlReportId?: string | null,
): string | null {
  const errorClass = normalizeErrorClass(data.type, data.stderr ?? data.recentLogs ?? 'unknown');

  // Check for active report with same error class (single-flight)
  const active = getActiveReportForClass(db, errorClass);
  if (active) {
    log.debug(
      { errorClass, existingReportId: active.report_id, state: active.state },
      'heal report suppressed — active report exists',
    );
    return null;
  }

  // Check global valve
  if (!checkGlobalValve(db)) {
    log.warn({ errorClass }, 'global valve triggered — escalating to admin');
    // TODO: send admin notification
    return null;
  }

  const reportId = randomUUID();
  const state = activeControlReportId ? 'queued' : 'attempt_1';
  const attemptCount = 1;

  db.raw.prepare(`
    INSERT INTO heal_reports (report_id, error_class, error_type, state, attempt_count, origin_chat_jid, context)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(reportId, errorClass, data.type, state, attemptCount, data.chatJid ?? null, JSON.stringify(data));

  log.info({ reportId, errorClass, type: data.type, state }, 'heal report created');

  if (state === 'queued') {
    log.info({ reportId, errorClass }, 'heal report queued — single-flight slot occupied');
    return reportId;
  }

  // Send [LOOPS_HEAL] to Q
  const qPhone = [...config.controlPeers.entries()].find(([name]) => name === 'q')?.[1];
  if (!qPhone) {
    log.warn('no Q control peer configured — cannot send heal report');
    return reportId;
  }
  const qJid = `${qPhone}@s.whatsapp.net`;

  const payload = {
    reportId,
    type: data.type,
    errorClass,
    attempt: attemptCount,
    maxAttempts: MAX_ATTEMPTS,
    timestamp: new Date().toISOString(),
    chatJid: data.chatJid,
    exitCode: data.exitCode,
    signal: data.signal,
    stderr: data.stderr,
    recentLogs: data.recentLogs,
  };

  const humanReadable = formatHealReport(payload);
  const message = `[LOOPS_HEAL] ${JSON.stringify(payload)}\n\n${humanReadable}`;

  sendTracked(messenger, qJid, message, durability ?? undefined, { replayPolicy: 'safe' })
    .catch(err => log.error({ err, reportId }, 'failed to send heal report'));

  return reportId;
}

/**
 * Handle a HEAL_COMPLETE control message from Q.
 *
 * result='fixed' → state='resolved'
 * result='escalate' → state='escalated'
 *
 * Idempotent: if already resolved, no-op. If the report_id is unknown,
 * creates an authoritative row from the completion payload (Type 3 adoption).
 */
export function handleHealComplete(db: Database, payload: HealCompletePayload): void {
  const { reportId, errorClass, result } = payload;

  // Idempotent: check if already resolved
  const row = (db.raw.prepare('SELECT state FROM heal_reports WHERE report_id = ?').get(reportId) ?? undefined) as { state: string } | undefined;
  if (!row) {
    // Type 3 adoption: create the authoritative row from the completion payload
    db.raw.prepare(`
      INSERT OR IGNORE INTO heal_reports (report_id, error_class, error_type, state, attempt_count, resolved_at)
      VALUES (?, ?, 'service_crash', 'resolved', 1, datetime('now'))
    `).run(reportId, errorClass);
    log.info({ reportId, errorClass }, 'Type 3 heal report adopted on completion');
    return;
  }

  if (row.state === 'resolved') {
    log.debug({ reportId }, 'heal report already resolved — idempotent no-op');
    return;
  }

  const newState = result === 'fixed' ? 'resolved' : 'escalated';
  db.raw.prepare(`
    UPDATE heal_reports SET state = ?, resolved_at = datetime('now') WHERE report_id = ?
  `).run(newState, reportId);

  log.info({ reportId, errorClass, from: row.state, to: newState }, 'heal report state transition');
}

/**
 * Handle a HEAL_ESCALATE control message from Q.
 * Delegates to handleHealComplete with result='escalate'.
 */
export function handleHealEscalate(db: Database, payload: HealCompletePayload): void {
  handleHealComplete(db, { ...payload, result: 'escalate' });
}

/**
 * Return the most recent active heal report for the given error class,
 * or null if none exists.
 */
export function getActiveReportForClass(db: Database, errorClass: string): HealReportRow | null {
  return (db.raw.prepare(`
    SELECT * FROM heal_reports
    WHERE error_class = ? AND state IN ('attempt_1', 'cooldown', 'attempt_2', 'escalated', 'queued')
    ORDER BY created_at DESC LIMIT 1
  `).get(errorClass) ?? null) as HealReportRow | null;
}

/**
 * Dequeue the oldest queued heal report and transition it to 'attempt_1'.
 * Returns the dequeued row (pre-transition state), or null if nothing queued.
 */
export function dequeueNextReport(db: Database): HealReportRow | null {
  const row = (db.raw.prepare(`
    SELECT * FROM heal_reports WHERE state = 'queued' ORDER BY created_at ASC LIMIT 1
  `).get() ?? null) as HealReportRow | null;

  if (row) {
    db.raw.prepare(`UPDATE heal_reports SET state = 'attempt_1' WHERE report_id = ?`).run(row.report_id);
    log.info({ reportId: row.report_id, errorClass: row.error_class }, 'heal report dequeued');
  }
  return row;
}

/**
 * Check whether the global valve allows a new heal report to be emitted.
 *
 * Returns true (allowed) if fewer than GLOBAL_VALVE_LIMIT non-queued reports
 * have been created in the past hour.
 */
export function checkGlobalValve(db: Database): boolean {
  // Use SQLite datetime arithmetic to avoid timezone format mismatches between
  // JS ISO-8601 ('T'/'Z') and SQLite datetime() (space separator, no 'Z').
  const windowMinutes = -Math.floor(GLOBAL_VALVE_WINDOW_MS / 60_000);
  const count = (db.raw.prepare(`
    SELECT COUNT(*) as cnt FROM heal_reports
    WHERE state != 'queued' AND created_at > datetime('now', ? || ' minutes')
  `).get(`${windowMinutes}`) as { cnt: number }).cnt;
  return count < GLOBAL_VALVE_LIMIT;
}

function formatHealReport(payload: {
  type: string;
  chatJid?: string;
  exitCode?: number;
  signal?: string | null;
  stderr?: string;
  recentLogs?: string;
  attempt: number;
  maxAttempts: number;
}): string {
  const lines = [`Session ${payload.type} in ${payload.chatJid ?? 'unknown chat'}`];
  if (payload.exitCode !== undefined) lines.push(`Exit code: ${payload.exitCode}`);
  if (payload.signal) lines.push(`Signal: ${payload.signal}`);
  if (payload.stderr) lines.push(`Stderr (last lines):\n  ${payload.stderr.split('\n').slice(-5).join('\n  ')}`);
  if (payload.recentLogs) lines.push(`Recent logs:\n  ${payload.recentLogs.split('\n').slice(-5).join('\n  ')}`);
  lines.push(`\nRepair attempt ${payload.attempt} of ${payload.maxAttempts}. Next attempt available after 5m cooldown if this fails.`);
  return lines.join('\n');
}
