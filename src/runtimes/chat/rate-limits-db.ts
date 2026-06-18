import type { Database } from '../../core/database.ts';

/**
 * Record that a response was sent to `senderJid` at the current time.
 * Called after each bot reply to track rate-limit state.
 */
export function recordResponse(db: Database, senderJid: string): void {
  db.raw.prepare(`
    INSERT INTO rate_limits (sender_jid, response_at)
    VALUES (@sender_jid, datetime('now'))
  `).run({ sender_jid: senderJid });
}

/**
 * Count how many responses have been sent to `senderJid` within the last
 * `windowMs` milliseconds.
 */
export function getResponseCount(db: Database, senderJid: string, windowMs: number): number {
  // SQLite datetime arithmetic: subtract windowMs as fractional seconds.
  const windowSec = windowMs / 1000;
  const row = db.raw.prepare(`
    SELECT COUNT(*) AS cnt
    FROM rate_limits
    WHERE sender_jid = @sender_jid
      AND response_at >= datetime('now', @offset)
  `).get({
    sender_jid: senderJid,
    offset: `-${windowSec} seconds`,
  }) as { cnt: number };

  return row.cnt;
}

/**
 * Delete rate_limit rows older than 2 hours. Run periodically to keep the
 * table from growing unboundedly.
 */
export function cleanupOldRateLimits(db: Database): number {
  const result = db.raw.prepare(`
    DELETE FROM rate_limits
    WHERE response_at < datetime('now', '-2 hours')
  `).run();

  return (result as { changes: number }).changes;
}

/**
 * Record that an LLM response was *attempted* for `senderJid` at the current
 * time (audit 1065). Unlike `recordResponse` (success only), this is called for
 * every LLM invocation — including ones whose send later fails — so the cost of
 * retries during an outage is observable separately from the user's response
 * rate-limit. This counter is observational and does NOT gate responses.
 */
export function recordAttempt(db: Database, senderJid: string): void {
  db.raw.prepare(`
    INSERT INTO llm_attempts (sender_jid, attempt_at)
    VALUES (@sender_jid, datetime('now'))
  `).run({ sender_jid: senderJid });
}

/**
 * Count how many LLM attempts have been recorded for `senderJid` within the last
 * `windowMs` milliseconds. Distinct from `getResponseCount` (successful sends).
 */
export function getAttemptCount(db: Database, senderJid: string, windowMs: number): number {
  const windowSec = windowMs / 1000;
  const row = db.raw.prepare(`
    SELECT COUNT(*) AS cnt
    FROM llm_attempts
    WHERE sender_jid = @sender_jid
      AND attempt_at >= datetime('now', @offset)
  `).get({
    sender_jid: senderJid,
    offset: `-${windowSec} seconds`,
  }) as { cnt: number };

  return row.cnt;
}

/**
 * Delete llm_attempts rows older than 2 hours. Run periodically alongside
 * cleanupOldRateLimits to keep the table bounded.
 */
export function cleanupOldAttempts(db: Database): number {
  const result = db.raw.prepare(`
    DELETE FROM llm_attempts
    WHERE attempt_at < datetime('now', '-2 hours')
  `).run();

  return (result as { changes: number }).changes;
}
