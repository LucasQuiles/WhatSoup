import type { LineInstance } from '../types';
import { statusNeedsAttention } from './status-severity';

/**
 * Whether a line's WhatsApp TRANSPORT is up (#1881). This is transport
 * connectivity, a separate dimension from control-plane health-state: a
 * `degraded` line whose transport is genuinely connected (e.g. recent-
 * disconnect churn — src/core/health.ts marks `degraded` while
 * `whatsapp.connected === true` and `connection.state === 'connected'`) is
 * still a working transport and must count as connected.
 *
 * The predicate is the UNION of two branches:
 *   (a) health-state `online` — kept visible through an outage (#1762 rem-1),
 *       so it counts regardless of staleness. `online ⊆ connected` because the
 *       poller cannot classify a line online while its transport is down.
 *   (b) a FRESH transport-up signal (`whatsapp.connected === true` AND
 *       `connection.state === 'connected'`) on a non-stale line. A stale,
 *       carried-forward connectivity body is UNKNOWN — not connected — which
 *       mirrors how the body-derived unread/agentSessions counts are gated on
 *       `stale` (#1762 rem-2). This keeps stale/unavailable signals out of the
 *       count rather than miscounting them as connected or as disconnected.
 *
 * Shared with the Fleet "Connected" filter (SoupKitchen) so the KPI count and
 * the filtered row set stay identical.
 */
export function isLineConnected(line: LineInstance): boolean {
  if (line.status === 'online') return true;
  if (line.stale) return false;
  const wa = line.health?.whatsapp;
  return wa?.connected === true && wa.connection?.state === 'connected';
}

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
    // Transport connectivity (#1881): count a line as connected when its
    // WhatsApp transport is up, which includes a degraded-but-connected line —
    // not only `status === 'online'`. See isLineConnected for the branches and
    // the stale-gate rationale. Status-derived KPIs stay visible through an
    // outage (#1762 rem-1: the poller degrades confidence rather than hiding
    // status).
    if (isLineConnected(line)) connected++;
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
