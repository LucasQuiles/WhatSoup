import type { LineInstance } from '../types';
import { statusNeedsAttention } from './status-severity';

export function computeKpis(lines: LineInstance[]): {
  connected: number;
  needAttention: number;
  unread: number;
  agentSessions: number;
  totalSent: number;
  totalReceived: number;
  totalMedia: number;
  /**
   * Count of instances whose health BODY was excluded from the body-derived
   * KPIs (unread / agentSessions) because they are `stale`. Surfaced so the
   * gate is explicit — a consumer can tell the fleet totals are computed over
   * fewer instances rather than silently under-counting.
   */
  staleExcluded: number;
} {
  let connected = 0;
  let needAttention = 0;
  let unread = 0;
  let agentSessions = 0;
  let totalSent = 0;
  let totalReceived = 0;
  let totalMedia = 0;
  let staleExcluded = 0;

  for (const line of lines) {
    // Status-derived KPIs stay visible through an outage (#1762 rem-1: the
    // poller degrades confidence rather than hiding status). Count them for
    // every instance, stale or not.
    if (line.status === 'online') connected++;
    if (statusNeedsAttention(line.status) || line.error) {
      needAttention++;
    }

    // Freshness gate (#1762 remediation 2): when `stale`, `health` is carried
    // forward from an older successful poll (enrichInstance, src/fleet/routes/
    // lines.ts). Summing the carried-forward health BODY across stale instances
    // inflates live fleet totals, so exclude the body-derived counts. Link /
    // status / DB-derived fields are NOT hidden — only the body counts are gated.
    if (line.stale) {
      staleExcluded++;
    } else {
      const rt = line.health?.runtime;
      if (rt?.passive) unread += rt.passive.unreadCount;
      if (rt?.agent) agentSessions += rt.agent.activeSessions;
    }

    // messageStats is DB-derived (fleet-side SQLite aggregation), not the
    // carried-forward health body, so it persists correctly through an outage.
    if (line.messageStats) {
      totalSent += line.messageStats.sent;
      totalReceived += line.messageStats.received;
      totalMedia += line.messageStats.images + line.messageStats.audio + line.messageStats.documents;
    }
  }

  return { connected, needAttention, unread, agentSessions, totalSent, totalReceived, totalMedia, staleExcluded };
}
