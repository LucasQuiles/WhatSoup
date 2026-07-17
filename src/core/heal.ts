// src/core/heal.ts
// Circuit breaker state machine and heal report management.

import { randomUUID } from 'node:crypto';
import { createChildLogger } from '../logger.ts';
import { emitAlertChecked } from '../lib/emit-alert.ts';
import type { Database } from './database.ts';
import type { Messenger } from './types.ts';
import type { DurabilityEngine } from './durability.ts';
import { sendTracked } from './durability.ts';
import { normalizeErrorClass, type HealCompletePayload } from './heal-protocol.ts';
import { config } from '../config.ts';
import { toPersonalJid } from './jid-constants.ts';

const log = createChildLogger('heal');

const MAX_ATTEMPTS = 2;
const RESOLUTION_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
export const GLOBAL_VALVE_LIMIT = 5;
const GLOBAL_VALVE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const ACTIVE_REPORT_STATES = ['attempt_1', 'cooldown', 'attempt_2', 'escalated', 'queued'] as const;
export const HEAL_ACTIVE_STALE_MS = RESOLUTION_WINDOW_MS;

// A missing Q control peer is persistent CONFIG STATE, not a per-report event:
// config.controlPeers is built once at module load (src/config.ts) and nothing
// mutates it mid-process (the fleet PATCH route rewrites config.json for the
// NEXT boot), so once the peer is absent it stays absent for the process
// lifetime. Without a latch every heal report on an unconfigured fleet fires
// its own heal_delivery_unavailable critical, forever. Alert once per process
// and count the suppressed occurrences; GET /health surfaces both under
// control_peer (see startHealthServer).
let deliveryUnavailableAlerted = false;
let suppressedDeliveryUnavailableAlerts = 0;

export interface ControlPeerWiring {
  configured: boolean;
  suppressedUnavailableAlerts: number;
}

/** Q control-peer wiring state for GET /health's control_peer block. */
export function getControlPeerWiring(): ControlPeerWiring {
  return {
    configured: config.controlPeers.has('q'),
    suppressedUnavailableAlerts: suppressedDeliveryUnavailableAlerts,
  };
}

/** Reset the per-process delivery-unavailable latch (for tests). */
export function resetDeliveryUnavailableLatch(): void {
  deliveryUnavailableAlerted = false;
  suppressedDeliveryUnavailableAlerts = 0;
}

export interface HealReportData {
  type: 'crash' | 'degraded' | 'service_crash';
  chatJid?: string;
  exitCode?: number;
  signal?: string | null;
  provider?: string;
  crashClass?: string;
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

export interface ReconcileStaleHealReportsOptions {
  now?: Date;
  staleMs?: number;
}

export interface ReconcileStaleHealReportsResult {
  expiredReportIds: string[];
  cutoff: string;
  staleMs: number;
}

/**
 * Build the dedup-class hint for a heal report. For 'crash' reports where
 * classifyProviderCrash could not identify a crashClass, raw stderr/recentLogs
 * content (addresses, thread-local detail, arbitrary IDs) varies per occurrence
 * even after normalizeErrorClass's regex stripping, so a repeated signal-less
 * SIGKILL produces a different class every time and single-flight dedup never
 * coalesces (see provider-crash-diagnostics.ts:classifyProviderCrash). Mirror the
 * 'degraded' path's fixed-first-line pattern (see normalizeErrorClass doc): key
 * on the structural signal/exitCode, which is stable across repeats, and push
 * the variable stderr/recentLogs detail to a second line where
 * normalizeErrorClass (which only reads split('\n')[0]) ignores it.
 */
function buildErrorClassHint(data: HealReportData): string {
  if (data.crashClass) return data.crashClass;
  if (data.type === 'crash' && (data.signal || data.exitCode !== undefined)) {
    const detail = data.stderr ?? data.recentLogs ?? '';
    return `signal_${data.signal ?? 'none'}_exit_${data.exitCode ?? 'none'}${detail ? `\n${detail}` : ''}`;
  }
  return data.stderr ?? data.recentLogs ?? 'unknown';
}

/** Shared evidence lines for the two BOT ERRORS fallback paths below (valve trip, no control peer). */
function buildHealEvidenceLines(data: HealReportData, errorClass: string): string {
  return [
    `type=${data.type}`,
    `error_class=${errorClass}`,
    data.chatJid ? `chat_jid=${data.chatJid}` : null,
    data.exitCode !== undefined ? `exit_code=${data.exitCode}` : null,
    data.signal ? `signal=${data.signal}` : null,
    data.provider ? `provider=${data.provider}` : null,
    data.crashClass ? `crash_class=${data.crashClass}` : null,
    data.stderr ? `stderr=${data.stderr}` : null,
    data.recentLogs ? `recent_logs=${data.recentLogs}` : null,
  ].filter(Boolean).join('\n');
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
  const errorClass = normalizeErrorClass(data.type, buildErrorClassHint(data));
  reconcileStaleHealReports(db);

  // Check for active report with same error class (single-flight)
  const active = getActiveReportForClass(db, errorClass);
  if (active) {
    // #1754: coalesce into the active incident instead of silently no-op'ing the
    // duplicate occurrence — attempt_count must reflect how many times this error
    // class has actually recurred.
    db.raw.prepare(`UPDATE heal_reports SET attempt_count = attempt_count + 1 WHERE report_id = ?`).run(active.report_id);
    log.debug(
      { errorClass, existingReportId: active.report_id, state: active.state, attemptCount: active.attempt_count + 1 },
      'heal report suppressed — active report exists; attempt count incremented',
    );
    return null;
  }

  // Check global valve
  const valveCount = getGlobalValveCount(db);
  if (valveCount >= GLOBAL_VALVE_LIMIT) {
    log.warn({ sendsThisHour: valveCount }, 'global heal valve triggered');
    emitAlertChecked(
      config.botName,
      'heal_repeated_failures',
      `whatsoup@${config.botName} heal valve triggered after ${valveCount} repair reports this hour`,
      buildHealEvidenceLines(data, errorClass),
    );
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
    log.info({ reportId, errorClass }, 'heal report queued — slot occupied');
    return reportId;
  }

  // Send [LOOPS_HEAL] to Q
  const qPhone = config.controlPeers.get('q');
  if (!qPhone) {
    // #1754: missing/partial control-peer config must never silently drop the
    // report — telemetry delivery is guaranteed-or-alerted. Route through the
    // same durable-outbox fallback the global valve uses above. The critical
    // latches to one per process (see deliveryUnavailableAlerted above): the
    // config state was already alerted, so later reports warn + count only.
    log.warn({ reportId }, 'no Q control peer configured — routing heal report through BOT ERRORS fallback');
    if (deliveryUnavailableAlerted) {
      suppressedDeliveryUnavailableAlerts++;
      return reportId;
    }
    deliveryUnavailableAlerted = true;
    emitAlertChecked(
      config.botName,
      'heal_delivery_unavailable',
      `whatsoup@${config.botName} heal report ${reportId} could not reach Q — no control peer configured`,
      [
        buildHealEvidenceLines(data, errorClass),
        'further occurrences are latched for this process — suppressed count at /health control_peer.suppressed_unavailable_alerts',
      ].join('\n'),
    );
    return reportId;
  }
  const qJid = toPersonalJid(qPhone);

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
    provider: data.provider,
    crashClass: data.crashClass,
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
  const { reportId, errorClass, result, diagnosis } = payload;

  log.info({ reportId, result, errorClass }, 'heal complete received');

  // Idempotent: check if already resolved
  const row = (db.raw.prepare('SELECT state FROM heal_reports WHERE report_id = ?').get(reportId) ?? undefined) as { state: string } | undefined;
  if (!row) {
    // Type 3 adoption: create the authoritative row from the completion payload
    db.raw.prepare(`
      INSERT OR IGNORE INTO heal_reports (report_id, error_class, error_type, state, attempt_count, resolved_at)
      VALUES (?, ?, 'service_crash', 'resolved', 1, datetime('now'))
    `).run(reportId, errorClass);
    log.info({ reportId, errorClass }, 'Type 3 heal report adopted');
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

  log.info({ reportId, from: row.state, to: newState }, 'heal report state transition');

  if (newState === 'escalated') {
    log.warn({ reportId, errorClass, diagnosis }, 'heal escalated to admin');
  }
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
    WHERE error_class = ? AND state IN (${activeStateSql()})
    ORDER BY created_at DESC LIMIT 1
  `).get(errorClass) ?? null) as HealReportRow | null;
}

/**
 * Expire old active rows left behind by a restart or lost control session.
 *
 * Without this reconciliation, an old 'queued' or 'escalated' row suppresses
 * the same error class forever even though runtime.activeControlReportId is
 * process-local and was cleared by the restart.
 */
export function reconcileStaleHealReports(
  db: Database,
  options: ReconcileStaleHealReportsOptions = {},
): ReconcileStaleHealReportsResult {
  const now = options.now ?? new Date();
  const staleMs = options.staleMs ?? HEAL_ACTIVE_STALE_MS;
  const cutoff = new Date(now.getTime() - staleMs).toISOString();

  const rows = db.raw.prepare(`
    SELECT report_id, error_class, state FROM heal_reports
    WHERE state IN (${activeStateSql()}) AND datetime(created_at) <= datetime(?)
    ORDER BY created_at ASC
  `).all(cutoff) as Array<Pick<HealReportRow, 'report_id' | 'error_class' | 'state'>>;

  if (rows.length === 0) {
    return { expiredReportIds: [], cutoff, staleMs };
  }

  // #1754: do NOT stamp resolved_at here. This is a timer-race safety net for
  // orphaned rows (restart/lost control session), not a resolution signal — a row
  // is only ever genuinely resolved by a positive HEAL_COMPLETE/HEAL_ESCALATE
  // signal (see handleHealComplete). Setting resolved_at here made stale-expired
  // rows indistinguishable from genuine resolutions to anything reading
  // resolved_at without also checking state.
  const update = db.raw.prepare(`
    UPDATE heal_reports
    SET state = 'stale_expired'
    WHERE report_id = ?
  `);
  for (const row of rows) update.run(row.report_id);

  log.warn({
    count: rows.length,
    reportIds: rows.map(row => row.report_id),
    states: rows.map(row => row.state),
    staleMs,
    cutoff,
  }, 'expired stale active heal reports');

  return { expiredReportIds: rows.map(row => row.report_id), cutoff, staleMs };
}

/**
 * Dequeue the oldest queued heal report and transition it to 'attempt_1'.
 * Returns the dequeued row (pre-transition state), or null if nothing queued.
 */
export function dequeueNextReport(db: Database): HealReportRow | null {
  reconcileStaleHealReports(db);

  const row = (db.raw.prepare(`
    SELECT * FROM heal_reports WHERE state = 'queued' ORDER BY created_at ASC LIMIT 1
  `).get() ?? null) as HealReportRow | null;

  if (row) {
    db.raw.prepare(`UPDATE heal_reports SET state = 'attempt_1' WHERE report_id = ?`).run(row.report_id);
    log.info({ reportId: row.report_id, errorClass: row.error_class }, 'heal report dequeued');
  }
  return row;
}

function activeStateSql(): string {
  return ACTIVE_REPORT_STATES.map(state => `'${state}'`).join(', ');
}

/**
 * Parse a persisted heal-report context column. The dequeue callers run
 * inside timers and tool-completion paths where a parse throw is fatal
 * (uncaughtException) with the report already flipped to 'attempt_1' —
 * so a corrupt cell degrades to {} instead of throwing.
 */
export function parseHealContext(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to {}
  }
  return {};
}

/**
 * Get the count of non-queued heal reports created in the past hour.
 * Used by emitHealReport for global valve logging.
 */
export function getGlobalValveCount(db: Database): number {
  const windowMinutes = -Math.floor(GLOBAL_VALVE_WINDOW_MS / 60_000);
  return (db.raw.prepare(`
    SELECT COUNT(*) as cnt FROM heal_reports
    WHERE state != 'queued' AND created_at > datetime('now', ? || ' minutes')
  `).get(`${windowMinutes}`) as { cnt: number }).cnt;
}

/**
 * Check for classified degradation signals (Type 2).
 *
 * Currently checks for persistent decryption failures: if 5+ unresolved
 * failures from the same sender arrive within 5 minutes, emit a 'degraded'
 * heal report so Q can investigate.
 *
 * Intended to be called periodically (e.g. from a health-check interval).
 * Safe to call frequently — emitHealReport handles single-flight deduplication.
 */
export function checkDegradationSignals(
  db: Database,
  messenger: Messenger,
  durability: DurabilityEngine | null,
  activeControlReportId: string | null,
): void {
  const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const failures = db.raw.prepare(`
    SELECT sender_jid, COUNT(*) as cnt
    FROM decryption_failures
    WHERE resolved = 0 AND datetime(created_at) > datetime(?)
    GROUP BY sender_jid
    HAVING cnt >= 5
  `).all(cutoff) as Array<{ sender_jid: string; cnt: number }>;

  if (failures.length === 0) return;

  // Coalesce per-sender signals into ONE degraded report per tick. The FIRST line is a
  // fixed string so normalizeErrorClass produces a STABLE error class — otherwise each
  // sender / rising count yields a distinct class and the single-flight guard never
  // engages, paging Q with near-identical reports every 60s tick (bounded only by the
  // global valve). Per-sender specifics go on following lines (not part of the class).
  const totalFailures = failures.reduce((sum, f) => sum + f.cnt, 0);
  const detail = failures.map((f) => `  ${f.cnt} from ${f.sender_jid}`).join('\n');
  emitHealReport(db, messenger, durability, {
    type: 'degraded',
    stderr: `decryption failures degraded\n${failures.length} sender(s), ${totalFailures} unresolved in last 5 minutes\n${detail}`,
  }, activeControlReportId);
}

function formatHealReport(payload: {
  type: string;
  chatJid?: string;
  exitCode?: number;
  signal?: string | null;
  provider?: string;
  crashClass?: string;
  stderr?: string;
  recentLogs?: string;
  attempt: number;
  maxAttempts: number;
}): string {
  const lines = [`Session ${payload.type} in ${payload.chatJid ?? 'unknown chat'}`];
  if (payload.exitCode !== undefined) lines.push(`Exit code: ${payload.exitCode}`);
  if (payload.signal) lines.push(`Signal: ${payload.signal}`);
  if (payload.provider) lines.push(`Provider: ${payload.provider}`);
  if (payload.crashClass) lines.push(`Crash class: ${payload.crashClass}`);
  if (payload.stderr) lines.push(`Stderr (last lines):\n  ${payload.stderr.split('\n').slice(-5).join('\n  ')}`);
  if (payload.recentLogs) lines.push(`Recent logs:\n  ${payload.recentLogs.split('\n').slice(-5).join('\n  ')}`);
  // #1754: no writer ever sets cooldown_until or dispatches a timed retry, so this
  // must not promise one — it previously always read "attempt 1 of 2 ... 5m cooldown"
  // regardless of how many times the error actually recurred (see attempt_count
  // increment in emitHealReport's single-flight suppression path for what really happens).
  lines.push(`\nRepair attempt ${payload.attempt}. Repeat occurrences of this error before resolution increment the attempt count but do not trigger a further notification or scheduled retry.`);
  return lines.join('\n');
}
