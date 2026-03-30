import type { Database } from '../../core/database.ts';
import { getResponseCount } from './rate-limits-db.ts';
import { config } from '../../config.ts';

/**
 * Check whether `senderJid` is within their hourly rate limit.
 *
 * Returns `{ allowed: true, remaining: N }` when under the limit, or
 * `{ allowed: false, remaining: 0 }` when the limit is exhausted.
 */
export function checkRateLimit(
  db: Database,
  senderJid: string,
): { allowed: boolean; remaining: number } {
  const count = getResponseCount(db, senderJid, config.rateLimitNoticeWindowMs);
  const remaining = Math.max(0, config.rateLimitPerHour - count);
  return { allowed: count < config.rateLimitPerHour, remaining };
}
